import { createHash, timingSafeEqual } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";

/**
 * What happened to one gated action.
 *
 * `declined` is a human saying no, so it always means a person was asked. `refused` is a
 * server-side denial and does not say on its own whether anyone was asked; its `reason` does.
 * `out of scope` and `budget exhausted` are decided before any prompt. `budget exhausted after
 * approval` follows an `accepted` entry: writes in flight together spent the last of the budget
 * while this one's prompt was open, so a human approved a write that then did not run. A client
 * that cannot prompt is never offered a write tool at all, so it leaves no entry.
 */
export type AuditOutcome =
  | "requested"
  | "accepted"
  | "declined"
  | "refused"
  | "executed"
  | "failed";

export type AuditEntry = {
  readonly ts: string;
  readonly connector: string;
  readonly tool: string;
  readonly outcome: AuditOutcome;
  /** Free-form per-outcome detail: resolved params, refusal reason, captured pre-state. */
  readonly detail: Record<string, unknown>;
};

type ChainedLine = {
  readonly seq: number;
  readonly prev: string;
  readonly hash: string;
  readonly entry: AuditEntry;
};

/** First link's predecessor. A fixed, all-zero digest, mirroring the gateway's audit chain. */
export const GENESIS_HASH = "0".repeat(64);

/**
 * Key order for `canonicalJson`. Plain code-unit comparison, NOT `localeCompare`: the order has to
 * be the same on every machine and locale, or a chain written on one host fails to verify on
 * another.
 */
function compareKeys(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Canonical JSON with sorted keys.
 *
 * Two structurally identical entries must hash identically regardless of insertion order —
 * otherwise re-serialising during verification could break a chain that was never tampered with.
 *
 * For the same reason a key whose value is `undefined` is left out, as `JSON.stringify` leaves it
 * out of the line that is actually written. Hashing it as `null` instead hashed something the log
 * never contained, so verification — which can only re-hash what it reads back — reported the
 * entry as tampered on its very first read. `kubernetes`' pod delete recorded exactly such a
 * pre-state whenever the namespace was left to its default.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const rec = value as Record<string, unknown>;
  const body = Object.keys(rec)
    .filter((k) => rec[k] !== undefined)
    .sort(compareKeys)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`)
    .join(",");
  return `{${body}}`;
}

/**
 * Hash over the predecessor plus the entry's canonical JSON.
 *
 * SHA-256 via `node:crypto`, deliberately NOT the gateway's BLAKE3: `@noble/hashes` is not in
 * `ALLOWED_CONNECTOR_DEPS`, and the standalone artifact must run under Node. Same construction,
 * different primitive.
 */
function linkHash(prev: string, entry: AuditEntry): string {
  return createHash("sha256").update(prev).update(canonicalJson(entry)).digest("hex");
}

/** Constant-time digest comparison (I10). A length mismatch is a mismatch, checked first. */
function hashEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

async function readLines(path: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const trimmed = text.trimEnd();
  return trimmed === "" ? [] : trimmed.split("\n");
}

/** Append one entry, linked to the current tail. */
export async function appendAuditEntry(path: string, entry: AuditEntry): Promise<void> {
  const lines = await readLines(path);
  const last = lines.at(-1);
  const prev = last === undefined ? GENESIS_HASH : (JSON.parse(last) as ChainedLine).hash;
  const line: ChainedLine = {
    seq: lines.length + 1,
    prev,
    hash: linkHash(prev, entry),
    entry,
  };
  await appendFile(path, `${JSON.stringify(line)}\n`, "utf8");
}

/**
 * Walk the chain.
 *
 * Returns the 1-based line where the links first stop agreeing, which covers both a tampered entry
 * and a deleted one — a deletion breaks the successor's `prev` link.
 */
export async function verifyAuditChain(
  path: string,
): Promise<{ ok: true; count: number } | { ok: false; brokenAtLine: number }> {
  const lines = await readLines(path);
  let prev = GENESIS_HASH;
  for (const [i, raw] of lines.entries()) {
    let line: ChainedLine;
    try {
      line = JSON.parse(raw) as ChainedLine;
    } catch {
      return { ok: false, brokenAtLine: i + 1 };
    }
    if (!hashEquals(line.prev, prev) || !hashEquals(line.hash, linkHash(prev, line.entry))) {
      return { ok: false, brokenAtLine: i + 1 };
    }
    prev = line.hash;
  }
  return { ok: true, count: lines.length };
}
