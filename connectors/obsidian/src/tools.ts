import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { ConsentServer } from "../../../shared/consent-kit.ts";
import { createWriteToolRegistrar } from "../../../shared/consent-kit.ts";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
  type McpListResult,
  requireProcessEnv,
} from "../../../shared/mcp-tool-kit.ts";

const VAULT_MARKER = ".obsidian";
const DEFAULT_IGNORED_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "target",
  ".next",
  "out",
  "vendor",
  ".cache",
]);

function vaultIdFromAbsolutePath(absolutePath: string): string {
  return createHash("sha256").update(absolutePath).digest("hex").slice(0, 12);
}

function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && (s.charAt(end - 1) === "/" || s.charAt(end - 1) === "\\")) end--;
  return s.slice(0, end);
}

function assertWithinVault(vaultRoot: string, relPath: string): string {
  const resolvedRoot = resolve(vaultRoot);
  const candidate = resolve(resolvedRoot, relPath);
  if (candidate !== resolvedRoot && !candidate.startsWith(resolvedRoot + sep)) {
    throw new Error(`Path escapes vault: ${relPath}`);
  }
  return candidate;
}

/** Whether anything, a dangling link included, sits at `p`. */
function pathEntryExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Refuse `abs` (a path `assertWithinVault` already accepted) when the place it really names is
 * outside the vault: a folder or note that is, or passes through, a symlink or junction out of the
 * vault. `assertWithinVault` compares strings, so it cannot see a link.
 *
 * The note, and the folders above it, may not exist yet (the append creates them), so the check
 * resolves the deepest part of the path that does exist; whatever is created below it is created
 * inside it. A dangling link cannot be resolved and is refused. The check and the later open are
 * two system calls, so a link swapped in between them is not seen here: the gateway's sandbox,
 * which grants only the vaults, is the boundary (stated bound).
 */
export function assertRealpathWithinVault(vaultRoot: string, abs: string, relPath: string): void {
  const realRoot = realpathSync(resolve(vaultRoot));
  const prefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  let probe = abs;
  while (!pathEntryExists(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  let real: string;
  try {
    real = realpathSync(probe);
  } catch {
    throw new Error(`Path escapes vault: ${relPath}`);
  }
  if (real !== realRoot && !real.startsWith(prefix)) {
    throw new Error(`Path escapes vault: ${relPath}`);
  }
}

/** How much of the end of a daily note `obsidian_daily_note_get` returns. */
export const DAILY_NOTE_TAIL_BYTES = 16 * 1024;

/** The positioned-read signature of `readSync`, injectable so a test can count what is read. */
export type PositionedRead = (
  fd: number,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number,
) => number;

/**
 * The size of the file at `abs` and its last `maxBytes` bytes, decoded as UTF-8.
 *
 * Positioned reads of at most `maxBytes` in all, never the whole file. When the window starts
 * inside the file, the UTF-8 continuation bytes it begins with (the rest of a character the window
 * cut) are dropped, so the tail starts on a character boundary.
 */
export function readUtf8Tail(
  abs: string,
  maxBytes: number,
  read: PositionedRead = readSync,
): { size: number; tail: string } {
  const fd = openSync(abs, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buf = Buffer.alloc(length);
    let got = 0;
    while (got < length) {
      const n = read(fd, buf, got, length - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    let skip = 0;
    if (start > 0) {
      while (skip < 3 && skip < got && ((buf[skip] ?? 0) & 0xc0) === 0x80) skip++;
    }
    return { size, tail: buf.subarray(skip, got).toString("utf8") };
  } finally {
    closeSync(fd);
  }
}

function loadVaultPaths(): readonly string[] {
  const raw = requireProcessEnv("OBSIDIAN_VAULT_PATHS_JSON");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("OBSIDIAN_VAULT_PATHS_JSON is not valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.some((p) => typeof p !== "string")) {
    throw new Error("OBSIDIAN_VAULT_PATHS_JSON must be a JSON array of strings");
  }
  return parsed as string[];
}

type VaultEntry = { id: string; root: string; name: string };

function discoverVaults(roots: readonly string[]): readonly VaultEntry[] {
  const out: VaultEntry[] = [];
  for (const r of roots) {
    walkForVaults(r, out);
  }
  return out;
}

function walkForVaults(dir: string, out: VaultEntry[]): void {
  let entries: readonly string[];
  try {
    if (!statSync(dir).isDirectory()) return;
    entries = readdirSync(dir);
  } catch {
    return;
  }
  if (entries.includes(VAULT_MARKER)) {
    out.push({
      id: vaultIdFromAbsolutePath(dir),
      root: dir,
      name: basename(stripTrailingSlashes(dir)),
    });
  }
  for (const e of entries) {
    if (e === VAULT_MARKER || DEFAULT_IGNORED_DIR_NAMES.has(e)) continue;
    const sub = join(dir, e);
    let isDir = false;
    try {
      const st = statSync(sub);
      isDir = st.isDirectory() && !st.isSymbolicLink();
    } catch {
      continue;
    }
    if (isDir) walkForVaults(sub, out);
  }
}

function listNotesInVault(vaultRoot: string): readonly string[] {
  const out: string[] = [];
  walkNotes(vaultRoot, vaultRoot, out);
  return out;
}

function walkNotes(currentDir: string, vaultRoot: string, out: string[]): void {
  let entries: readonly string[];
  try {
    if (!statSync(currentDir).isDirectory()) return;
    entries = readdirSync(currentDir);
  } catch {
    return;
  }
  if (currentDir !== vaultRoot && entries.includes(VAULT_MARKER)) return;
  for (const e of entries) {
    if (e === VAULT_MARKER || DEFAULT_IGNORED_DIR_NAMES.has(e)) continue;
    const full = join(currentDir, e);
    let isFile = false;
    let isDir = false;
    try {
      const st = statSync(full);
      if (st.isSymbolicLink()) continue;
      isFile = st.isFile();
      isDir = st.isDirectory();
    } catch {
      continue;
    }
    if (isFile && full.toLowerCase().endsWith(".md")) {
      out.push(relative(vaultRoot, full).replaceAll("\\", "/"));
    } else if (isDir) {
      walkNotes(full, vaultRoot, out);
    }
  }
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const H1_RE = /^#\s+(\S.*)$/m;

function readNote(
  vaultRoot: string,
  relPath: string,
): { title: string; body: string; raw: string } {
  const abs = assertWithinVault(vaultRoot, relPath);
  const raw = readFileSync(abs, "utf8");
  const m = FRONTMATTER_RE.exec(raw);
  const body = m === null ? raw : raw.slice(m[0].length);
  const h1 = H1_RE.exec(body);
  const title =
    h1?.[1]?.trim() !== undefined && h1[1].trim() !== ""
      ? h1[1].trim()
      : basename(relPath).replace(/\.md$/i, "");
  return { title, body, raw };
}

function noteIdFor(vaultId: string, relPath: string): string {
  return `obsidian:${vaultId}#${relPath}`;
}

function findVaultByIdOrPathPrefix(
  vaults: readonly VaultEntry[],
  needle: string,
): VaultEntry | undefined {
  return vaults.find((v) => v.id === needle || v.root === needle);
}

/**
 * Adapt a synchronous tool body — every obsidian tool works the vault with synchronous file I/O —
 * to the registrars' Promise-returning handler contract.
 *
 * Async with nothing to await, ON PURPOSE: a body that throws (a malformed id, an unknown vault, an
 * unreadable note) must REJECT, as every other tool call does. `Promise.resolve(body(parsed))`
 * would throw at the call site instead.
 */
function syncToolHandler<T>(
  body: (parsed: T) => McpListResult,
): (parsed: T) => Promise<McpListResult> {
  return async (parsed) => body(parsed); // NOSONAR S7503: the async is the adapter — it turns a synchronous body's throw into the rejection the handler contract promises.
}

/** Tool names exposed by this connector — for contract/introspection tests. */
export const OBSIDIAN_TOOL_NAMES = [
  "obsidian_list",
  "obsidian_get",
  "obsidian_search",
  "obsidian_append_to_daily_note",
  "obsidian_daily_note_get",
] as const;

/** The date tokens an Obsidian daily-note filename format may contain. */
const SUPPORTED_TOKENS = ["YYYY", "YY", "MM", "DD", "HH", "mm"] as const;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Expand an Obsidian daily-note filename format against a date, in UTC.
 *
 * Module scope, not nested in the registrar: it closes over nothing, and a
 * helper reachable only from inside a registration is a helper no test can
 * reach either.
 */
export function formatDailyNoteFilename(format: string, date: Date): string {
  const r: Record<string, string> = {
    YYYY: String(date.getUTCFullYear()),
    YY: String(date.getUTCFullYear() % 100).padStart(2, "0"),
    MM: pad2(date.getUTCMonth() + 1),
    DD: pad2(date.getUTCDate()),
    HH: pad2(date.getUTCHours()),
    mm: pad2(date.getUTCMinutes()),
  };
  let out = format;
  for (const tok of SUPPORTED_TOKENS) out = out.replaceAll(tok, r[tok] ?? "");
  return out;
}

/**
 * The vault-relative path of the daily note for `date`, honouring the vault's
 * own `.obsidian/daily-notes.json` when it has one. An absent or malformed
 * config falls back to a bare `YYYY-MM-DD.md` at the vault root.
 */
export function resolveDailyNoteRelativePath(vaultRoot: string, date: Date): string {
  const cfgPath = join(vaultRoot, ".obsidian", "daily-notes.json");
  let folder = "";
  let format = "YYYY-MM-DD";
  try {
    const parsed = JSON.parse(readFileSync(cfgPath, "utf8")) as unknown;
    if (parsed !== null && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj["folder"] === "string") folder = obj["folder"];
      if (typeof obj["format"] === "string" && obj["format"] !== "") {
        format = obj["format"];
      }
    }
  } catch {
    // fall through to defaults
  }
  const filename = `${formatDailyNoteFilename(format, date)}.md`;
  return folder === "" ? filename : `${stripTrailingSlashes(folder)}/${filename}`;
}

export function registerObsidianTools(
  server: ConsentServer & { tool: (...args: never) => unknown },
): void {
  const registerSimpleTool = createRegisterSimpleTool(server);

  const reg = createZodToolRegistrar(registerSimpleTool);

  /**
   * Every MUTATING obsidian tool goes through here. Outside the gateway this adds the
   * consent gate, the write-scope allow-list, the mutation budget and the audit record; inside
   * the gateway it is a pass-through, because executor.ts (I2) is the gate there.
   */
  const registerWriteTool = createWriteToolRegistrar(server, {
    connector: "obsidian",
    scopeEnv: "NIMBUS_MCP_OBSIDIAN_WRITE_SCOPE",
    scopeKinds: ["vault"],
  });

  const VAULTS = discoverVaults(loadVaultPaths());

  const obsidianListSchema = z.object({
    vault: z.string().min(1).optional(),
    tag: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  });

  reg(
    "obsidian_list",
    "List Obsidian notes (optionally filtered by vault id, vault path, or frontmatter tag).",
    obsidianListSchema,
    syncToolHandler((parsed) => {
      const limit = parsed.limit ?? 200;
      const filterVault =
        parsed.vault === undefined ? undefined : findVaultByIdOrPathPrefix(VAULTS, parsed.vault);
      const targetVaults = filterVault === undefined ? VAULTS : [filterVault];
      const out: Array<{
        id: string;
        vault_id: string;
        vault_name: string;
        path: string;
        title: string;
      }> = [];
      for (const v of targetVaults) {
        for (const rel of listNotesInVault(v.root)) {
          if (out.length >= limit) break;
          const { title, raw } = readNote(v.root, rel);
          if (parsed.tag !== undefined) {
            const fm = FRONTMATTER_RE.exec(raw);
            if (!fm?.[1]?.includes(parsed.tag)) continue;
          }
          out.push({
            id: noteIdFor(v.id, rel),
            vault_id: v.id,
            vault_name: v.name,
            path: rel,
            title,
          });
        }
      }
      return jsonResult(out);
    }),
  );

  const obsidianGetSchema = z.object({
    id: z.string().min(1).optional(),
    vault: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
  });

  reg(
    "obsidian_get",
    "Read a single Obsidian note by id, or by (vault, path) pair.",
    obsidianGetSchema,
    syncToolHandler((parsed) => {
      let v: VaultEntry | undefined;
      let rel = "";
      if (parsed.id !== undefined) {
        const m = /^obsidian:([0-9a-f]{12})#(.+)$/.exec(parsed.id);
        if (m === null) {
          throw new Error(`Invalid obsidian id: ${parsed.id}`);
        }
        v = VAULTS.find((x) => x.id === m[1]);
        rel = m[2] ?? "";
      } else if (parsed.vault !== undefined && parsed.path !== undefined) {
        v = findVaultByIdOrPathPrefix(VAULTS, parsed.vault);
        rel = parsed.path;
      } else {
        throw new Error("obsidian_get requires either `id` or both `vault` and `path`");
      }
      if (v === undefined) {
        throw new Error("Vault not found in OBSIDIAN_VAULT_PATHS_JSON discovery");
      }
      const note = readNote(v.root, rel);
      return jsonResult({
        id: noteIdFor(v.id, rel),
        vault_id: v.id,
        vault_name: v.name,
        path: rel,
        title: note.title,
        body: note.body,
      });
    }),
  );

  const obsidianSearchSchema = z.object({
    query: z.string().min(1),
    vault: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  });

  reg(
    "obsidian_search",
    "Substring-match against note title and body across all configured vaults.",
    obsidianSearchSchema,
    syncToolHandler((parsed) => {
      const limit = parsed.limit ?? 50;
      const needle = parsed.query.toLowerCase();
      const targets =
        parsed.vault === undefined
          ? VAULTS
          : [findVaultByIdOrPathPrefix(VAULTS, parsed.vault)].filter(
              (v): v is VaultEntry => v !== undefined,
            );
      const out: Array<{
        id: string;
        vault_id: string;
        path: string;
        title: string;
        snippet: string;
      }> = [];
      outer: for (const v of targets) {
        for (const rel of listNotesInVault(v.root)) {
          if (out.length >= limit) break outer;
          const note = readNote(v.root, rel);
          const titleHit = note.title.toLowerCase().includes(needle);
          const bodyHitIdx = note.body.toLowerCase().indexOf(needle);
          if (!titleHit && bodyHitIdx < 0) continue;
          const start = Math.max(0, bodyHitIdx - 60);
          const snippet = bodyHitIdx >= 0 ? note.body.slice(start, start + 240) : "";
          out.push({
            id: noteIdFor(v.id, rel),
            vault_id: v.id,
            path: rel,
            title: note.title,
            snippet,
          });
        }
      }
      return jsonResult(out);
    }),
  );

  /**
   * The vault and the daily note a daily-note tool names: ONE resolution, shared by the append and
   * the read, so the read shows exactly the note the append would write. String containment
   * (`assertWithinVault`) and then realpath containment (`assertRealpathWithinVault`).
   */
  function resolveDailyNote(parsed: { vault_id: string; date_iso?: string | undefined }): {
    v: VaultEntry;
    rel: string;
    abs: string;
  } {
    const v = findVaultByIdOrPathPrefix(VAULTS, parsed.vault_id);
    if (v === undefined) {
      throw new Error("Unknown vault_id");
    }
    const date =
      parsed.date_iso === undefined ? new Date() : new Date(`${parsed.date_iso}T00:00:00Z`);
    const rel = resolveDailyNoteRelativePath(v.root, date);
    const abs = assertWithinVault(v.root, rel);
    assertRealpathWithinVault(v.root, abs, rel);
    return { v, rel, abs };
  }

  const appendDailyNoteSchema = z.object({
    vault_id: z.string().min(1),
    content: z.string().min(1),
    date_iso: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  });

  registerWriteTool(
    "obsidian_append_to_daily_note",
    {
      mutates: "obsidian.note.append",
      // Append-only by construction — it never overwrites — so the note is recoverable by editing.
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "vault", value: p.vault_id }),
    },
    "Append text to today's Obsidian daily note. Creates the file if it does not exist. Always appends — never overwrites. Adds a leading newline when the existing file does not end in one. Requires HITL `obsidian.note.append`.",
    appendDailyNoteSchema,
    syncToolHandler((parsed) => {
      const { v, rel, abs } = resolveDailyNote(parsed);
      mkdirSync(dirname(abs), { recursive: true });
      // Again, now the folders exist: what was created must still be inside the vault.
      assertRealpathWithinVault(v.root, abs, rel);

      const fd = openSync(abs, "a+");
      let bytes = 0;
      try {
        let prefix = "";
        const size = fstatSync(fd).size;
        if (size > 0) {
          const tail = Buffer.alloc(1);
          readSync(fd, tail, 0, 1, size - 1);
          if (tail[0] !== 0x0a) {
            prefix = "\n";
          }
        }
        const final = `${prefix}${parsed.content}`;
        const buf = Buffer.from(final, "utf8");
        writeSync(fd, buf);
        bytes = buf.length;
      } finally {
        try {
          closeSync(fd);
        } catch {
          // ignore close errors
        }
      }

      return jsonResult({
        appended: true,
        vault_id: v.id,
        vault_name: v.name,
        path: rel,
        bytes,
      });
    }),
  );

  const dailyNoteGetSchema = z.object({
    vault_id: z.string().min(1),
    date_iso: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  });

  reg(
    "obsidian_daily_note_get",
    `Read the end of the Obsidian daily note that obsidian_append_to_daily_note would write for the same vault_id and date_iso (today in UTC when omitted). Returns { vault_id, vault_name, path, exists, size_bytes, tail }: tail is at most the last ${String(DAILY_NOTE_TAIL_BYTES)} bytes, starting on a character boundary; a missing note is exists: false, size_bytes: 0, tail "". Read-only.`,
    dailyNoteGetSchema,
    syncToolHandler((parsed) => {
      const { v, rel, abs } = resolveDailyNote(parsed);
      let exists = false;
      let size = 0;
      let tail = "";
      if (pathEntryExists(abs)) {
        if (!statSync(abs).isFile()) {
          throw new Error(`Daily note is not a file: ${rel}`);
        }
        exists = true;
        ({ size, tail } = readUtf8Tail(abs, DAILY_NOTE_TAIL_BYTES));
      }
      return jsonResult({
        vault_id: v.id,
        vault_name: v.name,
        path: rel,
        exists,
        size_bytes: size,
        tail,
      });
    }),
  );
}
