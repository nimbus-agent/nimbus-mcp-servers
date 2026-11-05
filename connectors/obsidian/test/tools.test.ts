import { afterAll, afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CapturedTools,
  captureStandaloneTools,
  captureTools,
} from "../../../scripts/connector-tool-harness.ts";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import {
  DAILY_NOTE_TAIL_BYTES,
  formatDailyNoteFilename,
  OBSIDIAN_TOOL_NAMES,
  type PositionedRead,
  readUtf8Tail,
  registerObsidianTools,
  resolveDailyNoteRelativePath,
} from "../src/tools.ts";

/** Every temp dir this file made, removed once it is done. */
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * A real vault on disk.
 *
 * This connector reads the filesystem and nothing else, so there is no reason
 * to stand a fake in front of it: a temp directory exercises the same code the
 * operator's machine will.
 */
function vault(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "obsidian-"));
  tempDirs.push(root);
  mkdirSync(join(root, ".obsidian"), { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, ...rel.split("/"));
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body, "utf8");
  }
  return root;
}

const NOTE_A = `---
tags: [project, alpha]
---
# Alpha Note

Some words about distributed systems.
`;

const NOTE_B = `# Beta Note

Nothing to see about gardening here.
`;

let roots: string[] = [];
let tools: CapturedTools;

function configure(...vaultRoots: string[]): CapturedTools {
  roots = vaultRoots;
  process.env["OBSIDIAN_VAULT_PATHS_JSON"] = JSON.stringify(vaultRoots);
  return captureTools(registerObsidianTools);
}

beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("gateway");
  const root = vault({
    "alpha.md": NOTE_A,
    "nested/beta.md": NOTE_B,
    "notes.txt": "not a markdown note",
  });
  tools = configure(root);
});

afterEach(() => {
  delete process.env["OBSIDIAN_VAULT_PATHS_JSON"];
  resetConnectorModeForTests();
});

describe("registerObsidianTools", () => {
  it("registers exactly the tools it declares", () => {
    expect(tools.names().sort()).toEqual([...OBSIDIAN_TOOL_NAMES].sort());
  });

  it("refuses to register at all without OBSIDIAN_VAULT_PATHS_JSON", () => {
    // Vault discovery happens at REGISTRATION, so a tool can never be
    // registered against a path the operator never granted.
    delete process.env["OBSIDIAN_VAULT_PATHS_JSON"];
    expect(() => captureTools(registerObsidianTools)).toThrow(
      "OBSIDIAN_VAULT_PATHS_JSON is not set",
    );
  });

  it("rejects a vault list that is not a JSON array of strings", () => {
    process.env["OBSIDIAN_VAULT_PATHS_JSON"] = "{not json";
    expect(() => captureTools(registerObsidianTools)).toThrow("is not valid JSON");

    process.env["OBSIDIAN_VAULT_PATHS_JSON"] = '{"vault":"/x"}';
    expect(() => captureTools(registerObsidianTools)).toThrow("must be a JSON array of strings");

    process.env["OBSIDIAN_VAULT_PATHS_JSON"] = "[1, 2]";
    expect(() => captureTools(registerObsidianTools)).toThrow("must be a JSON array of strings");
  });
});

describe("obsidian_list", () => {
  it("lists every markdown note, at any depth, and nothing else", async () => {
    const out = (await tools.callJson("obsidian_list", {})) as { path: string }[];
    // The connector reports POSIX-style relative paths on every platform, so a
    // note id means the same thing wherever the vault is read.
    expect(out.map((n) => n.path).sort()).toEqual(["alpha.md", "nested/beta.md"]);
  });

  it("reports the H1 as the title", async () => {
    const out = (await tools.callJson("obsidian_list", {})) as { path: string; title: string }[];
    expect(out.find((n) => n.path === "alpha.md")?.title).toBe("Alpha Note");
  });

  it("filters by frontmatter tag", async () => {
    const tagged = (await tools.callJson("obsidian_list", { tag: "alpha" })) as { path: string }[];
    expect(tagged.map((n) => n.path)).toEqual(["alpha.md"]);

    const none = (await tools.callJson("obsidian_list", { tag: "absent" })) as unknown[];
    expect(none).toEqual([]);
  });

  it("honours the limit", async () => {
    expect((await tools.callJson("obsidian_list", { limit: 1 })) as unknown[]).toHaveLength(1);
  });

  it("lists across several configured vaults, and narrows to one on request", async () => {
    const second = vault({ "gamma.md": "# Gamma\n" });
    const multi = configure(roots[0] ?? "", second);
    const all = (await multi.callJson("obsidian_list", {})) as { path: string }[];
    expect(all.map((n) => n.path)).toContain("gamma.md");

    const only = (await multi.callJson("obsidian_list", { vault: second })) as { path: string }[];
    expect(only.map((n) => n.path)).toEqual(["gamma.md"]);
  });
});

describe("obsidian_get", () => {
  it("reads a note by (vault, path) and strips the frontmatter from the body", async () => {
    const note = (await tools.callJson("obsidian_get", {
      vault: roots[0],
      path: "alpha.md",
    })) as { title: string; body: string };
    expect(note.title).toBe("Alpha Note");
    expect(note.body).toContain("distributed systems");
    expect(note.body).not.toContain("tags:");
  });

  it("round-trips the id that obsidian_list reports", async () => {
    const listed = (await tools.callJson("obsidian_list", {})) as { id: string; path: string }[];
    const id = listed.find((n) => n.path === "alpha.md")?.id ?? "";
    expect(id).toMatch(/^obsidian:[0-9a-f]{12}#alpha\.md$/);
    const note = (await tools.callJson("obsidian_get", { id })) as { title: string };
    expect(note.title).toBe("Alpha Note");
  });

  it("requires either an id or both vault and path", async () => {
    await expect(tools.call("obsidian_get", {})).rejects.toThrow(
      "requires either `id` or both `vault` and `path`",
    );
    await expect(tools.call("obsidian_get", { vault: roots[0] })).rejects.toThrow(
      "requires either `id` or both `vault` and `path`",
    );
  });

  it("rejects a malformed id rather than guessing", async () => {
    await expect(tools.call("obsidian_get", { id: "not-an-obsidian-id" })).rejects.toThrow(
      "Invalid obsidian id",
    );
  });

  it("reports an unknown vault by name", async () => {
    await expect(
      tools.call("obsidian_get", { id: "obsidian:000000000000#alpha.md" }),
    ).rejects.toThrow("Vault not found");
    await expect(
      tools.call("obsidian_get", { vault: "/nowhere", path: "alpha.md" }),
    ).rejects.toThrow("Vault not found");
  });

  it("refuses a path that escapes the vault", async () => {
    // The guard that matters here: a note path is operator-supplied, and
    // `../../etc/passwd` must not be readable through a note-reading tool.
    await expect(
      tools.call("obsidian_get", { vault: roots[0], path: "../../../etc/passwd" }),
    ).rejects.toThrow();
  });
});

describe("obsidian_search", () => {
  it("matches the body, case-insensitively, and returns a snippet", async () => {
    const hits = (await tools.callJson("obsidian_search", { query: "DISTRIBUTED" })) as {
      path: string;
      snippet: string;
    }[];
    expect(hits.map((h) => h.path)).toEqual(["alpha.md"]);
    expect(hits[0]?.snippet).toContain("distributed systems");
  });

  it("matches the title too", async () => {
    const hits = (await tools.callJson("obsidian_search", { query: "beta note" })) as unknown[];
    expect(hits).toHaveLength(1);
  });

  it("returns nothing when there is no match", async () => {
    expect((await tools.callJson("obsidian_search", { query: "zzzz" })) as unknown[]).toEqual([]);
  });

  it("honours the limit across vaults", async () => {
    const hits = (await tools.callJson("obsidian_search", {
      query: "note",
      limit: 1,
    })) as unknown[];
    expect(hits).toHaveLength(1);
  });

  it("returns nothing for an unknown vault rather than searching them all", async () => {
    const hits = (await tools.callJson("obsidian_search", {
      query: "note",
      vault: "/nowhere",
    })) as unknown[];
    expect(hits).toEqual([]);
  });
});

describe("obsidian_append_to_daily_note", () => {
  async function vaultId(): Promise<string> {
    const listed = (await tools.callJson("obsidian_list", {})) as { vault_id: string }[];
    return listed[0]?.vault_id ?? "";
  }

  it("creates the daily note when it does not exist", async () => {
    const id = await vaultId();
    await tools.call("obsidian_append_to_daily_note", {
      vault_id: id,
      content: "first line",
      date_iso: "2026-03-04",
    });
    expect(readFileSync(join(roots[0] ?? "", "2026-03-04.md"), "utf8")).toContain("first line");
  });

  it("appends rather than overwriting, separating with a newline", async () => {
    const id = await vaultId();
    for (const content of ["first", "second"]) {
      await tools.call("obsidian_append_to_daily_note", {
        vault_id: id,
        content,
        date_iso: "2026-03-05",
      });
    }
    const body = readFileSync(join(roots[0] ?? "", "2026-03-05.md"), "utf8");
    expect(body).toContain("first");
    expect(body).toContain("second");
    expect(body.indexOf("first")).toBeLessThan(body.indexOf("second"));
  });

  it("honours the vault's daily-notes folder and format", async () => {
    const root = vault({ "seed.md": "# Seed\n" });
    writeFileSync(
      join(root, ".obsidian", "daily-notes.json"),
      JSON.stringify({ folder: "Journal/", format: "YYYY-MM-DD-HHmm" }),
      "utf8",
    );
    const configured = configure(root);
    const listed = (await configured.callJson("obsidian_list", {})) as { vault_id: string }[];
    await configured.call("obsidian_append_to_daily_note", {
      vault_id: listed[0]?.vault_id ?? "",
      content: "entry",
      date_iso: "2026-03-06",
    });
    expect(readFileSync(join(root, "Journal", "2026-03-06-0000.md"), "utf8")).toContain("entry");
  });

  it("rejects an unknown vault id", async () => {
    await expect(
      tools.call("obsidian_append_to_daily_note", { vault_id: "nope", content: "x" }),
    ).rejects.toThrow("Unknown vault_id");
  });
});

describe("formatDailyNoteFilename", () => {
  const date = new Date("2026-03-04T05:06:07Z");

  it("expands every supported token, in UTC", () => {
    expect(formatDailyNoteFilename("YYYY-MM-DD", date)).toBe("2026-03-04");
    expect(formatDailyNoteFilename("YY/MM/DD HH:mm", date)).toBe("26/03/04 05:06");
  });

  it("zero-pads single-digit components", () => {
    expect(formatDailyNoteFilename("MM-DD", new Date("2026-01-02T00:00:00Z"))).toBe("01-02");
  });

  it("leaves unrecognised text alone", () => {
    expect(formatDailyNoteFilename("daily-YYYY", date)).toBe("daily-2026");
  });
});

describe("resolveDailyNoteRelativePath", () => {
  const date = new Date("2026-03-04T00:00:00Z");

  it("defaults to YYYY-MM-DD.md at the vault root", () => {
    expect(resolveDailyNoteRelativePath(vault({}), date)).toBe("2026-03-04.md");
  });

  it("reads folder and format from .obsidian/daily-notes.json", () => {
    const root = vault({});
    writeFileSync(
      join(root, ".obsidian", "daily-notes.json"),
      JSON.stringify({ folder: "Journal", format: "YYYY_MM_DD" }),
      "utf8",
    );
    expect(resolveDailyNoteRelativePath(root, date)).toBe("Journal/2026_03_04.md");
  });

  it("strips a trailing slash from the configured folder", () => {
    const root = vault({});
    writeFileSync(
      join(root, ".obsidian", "daily-notes.json"),
      JSON.stringify({ folder: "Journal///" }),
      "utf8",
    );
    expect(resolveDailyNoteRelativePath(root, date)).toBe("Journal/2026-03-04.md");
  });

  it("falls back to the defaults for a malformed or partial config", () => {
    const bad = vault({});
    writeFileSync(join(bad, ".obsidian", "daily-notes.json"), "{not json", "utf8");
    expect(resolveDailyNoteRelativePath(bad, date)).toBe("2026-03-04.md");

    const empty = vault({});
    writeFileSync(
      join(empty, ".obsidian", "daily-notes.json"),
      JSON.stringify({ format: "" }),
      "utf8",
    );
    expect(resolveDailyNoteRelativePath(empty, date)).toBe("2026-03-04.md");

    const notObject = vault({});
    writeFileSync(join(notObject, ".obsidian", "daily-notes.json"), "[1,2]", "utf8");
    expect(resolveDailyNoteRelativePath(notObject, date)).toBe("2026-03-04.md");
  });

  it("falls back to the defaults for a config that is JSON but no object at all", () => {
    for (const text of ['"Journal"', "null", "42"]) {
      const root = vault({});
      writeFileSync(join(root, ".obsidian", "daily-notes.json"), text, "utf8");
      expect({ text, path: resolveDailyNoteRelativePath(root, date) }).toEqual({
        text,
        path: "2026-03-04.md",
      });
    }
  });
});

describe("formatDailyNoteFilename, two-digit components", () => {
  it("keeps month, day, hour and minute of ten or more as they are", () => {
    expect(formatDailyNoteFilename("MM-DD HH:mm", new Date("2026-11-23T14:35:00Z"))).toBe(
      "11-23 14:35",
    );
  });
});

describe("obsidian vault discovery and walking, at the edges", () => {
  it("titles a note without an H1 by its file name", async () => {
    const configured = configure(vault({ "plain notes.md": "no heading here\n" }));
    const out = (await configured.callJson("obsidian_list", {})) as { title: string }[];
    expect(out.map((n) => n.title)).toEqual(["plain notes"]);
  });

  it("reports an empty snippet for a note that matched on its title alone", async () => {
    const configured = configure(vault({ "Quarterly Review.md": "numbers only\n" }));
    const hits = (await configured.callJson("obsidian_search", { query: "quarterly" })) as {
      title: string;
      snippet: string;
    }[];
    expect(hits).toEqual([expect.objectContaining({ title: "Quarterly Review", snippet: "" })]);
  });

  it("keeps a nested vault's notes out of the vault that contains it", async () => {
    const outer = vault({ "outer.md": "# Outer\n", "team/inner.md": "# Inner\n" });
    mkdirSync(join(outer, "team", ".obsidian"));
    const configured = configure(outer);
    const out = (await configured.callJson("obsidian_list", {})) as {
      vault_name: string;
      path: string;
    }[];
    // Discovery finds both vaults; each note is listed once, under the vault that owns it.
    expect(out.map((n) => `${n.vault_name}:${n.path}`).sort()).toEqual([
      `${outer.split(/[\\/]/).at(-1)}:outer.md`,
      "team:inner.md",
    ]);
  });

  it("ignores a configured path that is a file rather than a directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "obsidian-file-"));
    tempDirs.push(dir);
    const file = join(dir, "not-a-vault.md");
    writeFileSync(file, "# Not a vault\n", "utf8");
    const configured = configure(file, vault({ "real.md": "# Real\n" }));
    const out = (await configured.callJson("obsidian_list", {})) as { path: string }[];
    expect(out.map((n) => n.path)).toEqual(["real.md"]);
  });

  it("lists nothing from a vault that is gone, or turned into a file, after discovery", async () => {
    const gone = vault({ "a.md": "# A\n" });
    const replaced = vault({ "b.md": "# B\n" });
    const configured = configure(gone, replaced);
    rmSync(gone, { recursive: true, force: true });
    rmSync(replaced, { recursive: true, force: true });
    writeFileSync(replaced, "now a file", "utf8");
    expect((await configured.callJson("obsidian_list", {})) as unknown[]).toEqual([]);
  });

  /**
   * A link in `dir` whose target is gone. A junction rather than a plain symlink, so making one
   * needs no privilege on Windows; everywhere else the type is ignored and it is an ordinary
   * directory symlink.
   */
  function danglingLink(dir: string, name: string): void {
    const target = mkdtempSync(join(tmpdir(), "obsidian-gone-"));
    symlinkSync(target, join(dir, name), "junction");
    rmSync(target, { recursive: true, force: true });
  }

  it("skips a dangling link beside a vault while discovering vaults", async () => {
    const root = mkdtempSync(join(tmpdir(), "obsidian-root-"));
    tempDirs.push(root);
    mkdirSync(join(root, "team", ".obsidian"), { recursive: true });
    writeFileSync(join(root, "team", "plan.md"), "# Plan\n", "utf8");
    danglingLink(root, "broken");
    const out = (await configure(root).callJson("obsidian_list", {})) as {
      vault_name: string;
      path: string;
    }[];
    expect(out.map((n) => `${n.vault_name}:${n.path}`)).toEqual(["team:plan.md"]);
  });

  it("skips a dangling link inside a vault while listing its notes", async () => {
    const root = vault({ "kept.md": "# Kept\n" });
    danglingLink(root, "broken");
    const out = (await configure(root).callJson("obsidian_list", {})) as { path: string }[];
    expect(out.map((n) => n.path)).toEqual(["kept.md"]);
  });
});

describe("obsidian_append_to_daily_note, more shapes", () => {
  async function onlyVaultId(configured: CapturedTools): Promise<string> {
    const listed = (await configured.callJson("obsidian_list", {})) as { vault_id: string }[];
    return listed[0]?.vault_id ?? "";
  }

  it("adds no blank line when the daily note already ends with a newline", async () => {
    const root = vault({ "seed.md": "# Seed\n", "2026-03-07.md": "line one\n" });
    const configured = configure(root);
    await configured.call("obsidian_append_to_daily_note", {
      vault_id: await onlyVaultId(configured),
      content: "line two",
      date_iso: "2026-03-07",
    });
    expect(readFileSync(join(root, "2026-03-07.md"), "utf8")).toBe("line one\nline two");
  });

  it("writes to today's note, in UTC, when no date is given", async () => {
    const root = vault({ "seed.md": "# Seed\n" });
    const configured = configure(root);
    const id = await onlyVaultId(configured);
    setSystemTime(new Date("2026-11-23T23:30:00Z"));
    try {
      await configured.call("obsidian_append_to_daily_note", { vault_id: id, content: "late" });
    } finally {
      setSystemTime();
    }
    expect(readFileSync(join(root, "2026-11-23.md"), "utf8")).toBe("late");
  });
});

/** A vault with `daily-notes.json` set to `config`, configured as the only vault. */
async function dailyVault(
  config: Record<string, string> | undefined,
  files: Record<string, string> = {},
): Promise<{ root: string; configured: CapturedTools; id: string }> {
  const root = vault({ "seed.md": "# Seed\n", ...files });
  if (config !== undefined) {
    writeFileSync(join(root, ".obsidian", "daily-notes.json"), JSON.stringify(config), "utf8");
  }
  const configured = configure(root);
  const listed = (await configured.callJson("obsidian_list", {})) as { vault_id: string }[];
  return { root, configured, id: listed[0]?.vault_id ?? "" };
}

/** A fresh directory outside every vault. */
function outsideDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "obsidian-outside-"));
  tempDirs.push(dir);
  return dir;
}

interface DailyNoteReply {
  vault_id: string;
  vault_name: string;
  path: string;
  exists: boolean;
  size_bytes: number;
  tail: string;
}

describe("obsidian_daily_note_get", () => {
  it("is a READ: offered to a standalone client that cannot prompt, and runs with no prompt", async () => {
    resetConnectorModeForTests();
    setConnectorMode("standalone");
    const root = vault({ "2026-03-04.md": "standalone read" });
    process.env["OBSIDIAN_VAULT_PATHS_JSON"] = JSON.stringify([root]);
    const { tools: offered, prompts } = captureStandaloneTools(registerObsidianTools, {
      elicitation: false,
    });
    // The consent kit withholds every write from a client that cannot prompt; a read stays.
    expect(offered.names()).toContain("obsidian_daily_note_get");
    expect(offered.names()).not.toContain("obsidian_append_to_daily_note");
    const listed = (await offered.callJson("obsidian_list", {})) as { vault_id: string }[];
    const out = (await offered.callJson("obsidian_daily_note_get", {
      vault_id: listed[0]?.vault_id ?? "",
      date_iso: "2026-03-04",
    })) as DailyNoteReply;
    expect(out.tail).toBe("standalone read");
    expect(prompts).toEqual([]);
  });

  it("returns the whole of a small existing note, with its size", async () => {
    const { configured, id, root } = await dailyVault(undefined, {
      "2026-03-04.md": "line one\nline two\n",
    });
    const out = (await configured.callJson("obsidian_daily_note_get", {
      vault_id: id,
      date_iso: "2026-03-04",
    })) as DailyNoteReply;
    expect(out).toEqual({
      vault_id: id,
      vault_name: root.split(/[\\/]/).at(-1) ?? "",
      path: "2026-03-04.md",
      exists: true,
      size_bytes: 18,
      tail: "line one\nline two\n",
    });
  });

  it("reports a missing note as exists: false, size_bytes: 0 and an empty tail, creating nothing", async () => {
    const { configured, id, root } = await dailyVault({ folder: "Journal" });
    const out = (await configured.callJson("obsidian_daily_note_get", {
      vault_id: id,
      date_iso: "2026-03-05",
    })) as DailyNoteReply;
    expect(out).toMatchObject({
      path: "Journal/2026-03-05.md",
      exists: false,
      size_bytes: 0,
      tail: "",
    });
    expect(existsSync(join(root, "Journal"))).toBe(false);
  });

  it("names the note the vault's daily-notes folder and format name, as the append does", async () => {
    const { configured, id, root } = await dailyVault({
      folder: "Journal/",
      format: "YYYY-MM-DD-HHmm",
    });
    await configured.call("obsidian_append_to_daily_note", {
      vault_id: id,
      content: "appended entry",
      date_iso: "2026-03-06",
    });
    const out = (await configured.callJson("obsidian_daily_note_get", {
      vault_id: id,
      date_iso: "2026-03-06",
    })) as DailyNoteReply;
    expect(out).toMatchObject({
      path: "Journal/2026-03-06-0000.md",
      exists: true,
      tail: "appended entry",
    });
    expect(readFileSync(join(root, "Journal", "2026-03-06-0000.md"), "utf8")).toBe(
      "appended entry",
    );
  });

  it("reads today's note, in UTC, when no date is given", async () => {
    const { configured, id } = await dailyVault(undefined, { "2026-11-23.md": "today" });
    setSystemTime(new Date("2026-11-23T23:30:00Z"));
    try {
      const out = (await configured.callJson("obsidian_daily_note_get", {
        vault_id: id,
      })) as DailyNoteReply;
      expect(out).toMatchObject({ path: "2026-11-23.md", tail: "today" });
    } finally {
      setSystemTime();
    }
  });

  it("rejects an unknown vault id", async () => {
    await expect(
      tools.call("obsidian_daily_note_get", { vault_id: "nope", date_iso: "2026-03-04" }),
    ).rejects.toThrow("Unknown vault_id");
  });

  it("rejects a date that is not YYYY-MM-DD", async () => {
    await expect(
      tools.call("obsidian_daily_note_get", { vault_id: "x", date_iso: "2026-3-4" }),
    ).rejects.toThrow();
  });

  it("rejects a daily-note path that is a folder, not a file", async () => {
    const { configured, id, root } = await dailyVault(undefined);
    mkdirSync(join(root, "2026-03-08.md"));
    await expect(
      configured.call("obsidian_daily_note_get", { vault_id: id, date_iso: "2026-03-08" }),
    ).rejects.toThrow("Daily note is not a file: 2026-03-08.md");
  });

  it("returns only the last 16 KiB of a long note, starting on a character boundary", async () => {
    // 20 000 bytes of "a", then 3-byte characters: the 16 KiB window starts inside one of them.
    const body = `${"a".repeat(20_000)}${"€".repeat(6000)}END`;
    const { configured, id } = await dailyVault(undefined, { "2026-03-09.md": body });
    const out = (await configured.callJson("obsidian_daily_note_get", {
      vault_id: id,
      date_iso: "2026-03-09",
    })) as DailyNoteReply;
    expect(out.size_bytes).toBe(Buffer.byteLength(body, "utf8"));
    expect(out.tail.startsWith("€")).toBe(true);
    expect(out.tail.endsWith("€END")).toBe(true);
    expect(out.tail).not.toContain("�");
    const tailBytes = Buffer.byteLength(out.tail, "utf8");
    expect(tailBytes).toBeLessThanOrEqual(DAILY_NOTE_TAIL_BYTES);
    expect(tailBytes).toBeGreaterThan(DAILY_NOTE_TAIL_BYTES - 3);
    expect(body.endsWith(out.tail)).toBe(true);
  });
});

describe("readUtf8Tail", () => {
  it("reads at most the window from a 20 MB note, never the whole file", () => {
    const file = join(outsideDir(), "big.md");
    const size = 20 * 1024 * 1024;
    const buf = Buffer.alloc(size, 0x61);
    buf.write("THE END", size - 7, "utf8");
    writeFileSync(file, buf);

    const reads: { length: number; position: number }[] = [];
    const counting: PositionedRead = (fd, buffer, offset, length, position) => {
      reads.push({ length, position });
      return readSync(fd, buffer, offset, length, position);
    };
    const out = readUtf8Tail(file, DAILY_NOTE_TAIL_BYTES, counting);
    expect(out.size).toBe(size);
    expect(out.tail.length).toBe(DAILY_NOTE_TAIL_BYTES);
    expect(out.tail.endsWith("THE END")).toBe(true);
    expect(reads.reduce((n, r) => n + r.length, 0)).toBe(DAILY_NOTE_TAIL_BYTES);
    expect(reads.every((r) => r.position >= size - DAILY_NOTE_TAIL_BYTES)).toBe(true);
  });

  it("returns a file shorter than the window whole, and an empty file as empty", () => {
    const dir = outsideDir();
    writeFileSync(join(dir, "short.md"), "short", "utf8");
    writeFileSync(join(dir, "empty.md"), "", "utf8");
    expect(readUtf8Tail(join(dir, "short.md"), 16)).toEqual({ size: 5, tail: "short" });
    expect(readUtf8Tail(join(dir, "empty.md"), 16)).toEqual({ size: 0, tail: "" });
  });

  it("drops only the continuation bytes of the one character the window cut", () => {
    const file = join(outsideDir(), "cut.md");
    // "€" is three bytes. A 4-byte window over "x€€" starts inside the first "€": keep the second.
    writeFileSync(file, "x€€", "utf8");
    expect(readUtf8Tail(file, 4)).toEqual({ size: 7, tail: "€" });
    // A window that starts exactly on a character keeps it.
    expect(readUtf8Tail(file, 6)).toEqual({ size: 7, tail: "€€" });
  });

  it("stops at a short read rather than looping", () => {
    const file = join(outsideDir(), "short-read.md");
    writeFileSync(file, "abcdef", "utf8");
    const out = readUtf8Tail(file, 16, () => 0);
    expect(out).toEqual({ size: 6, tail: "" });
  });
});

/**
 * A directory link at `link` to `target`. A junction, so making one needs no privilege on
 * Windows; on macOS and Linux the type is ignored and it is an ordinary directory symlink. So
 * every directory-link test below runs on all three systems.
 */
function dirLink(target: string, link: string): void {
  symlinkSync(target, link, "junction");
}

/**
 * Whether this process may create a FILE symlink. Windows refuses one without Developer Mode or
 * the SeCreateSymbolicLink privilege (EPERM), and a junction cannot point at a file, so the one
 * test that needs a file link is skipped exactly when the OS refuses to make one.
 */
const canLinkFiles: boolean = (() => {
  const dir = mkdtempSync(join(tmpdir(), "obsidian-probe-"));
  tempDirs.push(dir);
  writeFileSync(join(dir, "t"), "", "utf8");
  try {
    symlinkSync(join(dir, "t"), join(dir, "l"), "file");
    return true;
  } catch {
    return false;
  }
})();

describe("daily notes: realpath containment", () => {
  it("refuses an append whose daily-notes folder is a link out of the vault, writing nothing there", async () => {
    const outside = outsideDir();
    const { root, configured, id } = await dailyVault({ folder: "Journal" });
    dirLink(outside, join(root, "Journal"));
    await expect(
      configured.call("obsidian_append_to_daily_note", {
        vault_id: id,
        content: "escaped",
        date_iso: "2026-04-01",
      }),
    ).rejects.toThrow("Path escapes vault: Journal/2026-04-01.md");
    expect(readdirSync(outside)).toEqual([]);
  });

  it("refuses an append whose folder passes THROUGH a link out of the vault, creating nothing", async () => {
    const outside = outsideDir();
    const { root, configured, id } = await dailyVault({ folder: "Linked/deeper/Journal" });
    dirLink(outside, join(root, "Linked"));
    await expect(
      configured.call("obsidian_append_to_daily_note", {
        vault_id: id,
        content: "escaped",
        date_iso: "2026-04-02",
      }),
    ).rejects.toThrow("Path escapes vault");
    // The check runs before mkdir, so not even the folders were created outside.
    expect(readdirSync(outside)).toEqual([]);
  });

  it("refuses the read of a daily note reached through a link out of the vault", async () => {
    const outside = outsideDir();
    writeFileSync(join(outside, "2026-04-03.md"), "secret outside the vault", "utf8");
    const { root, configured, id } = await dailyVault({ folder: "Journal" });
    dirLink(outside, join(root, "Journal"));
    await expect(
      configured.call("obsidian_daily_note_get", { vault_id: id, date_iso: "2026-04-03" }),
    ).rejects.toThrow("Path escapes vault: Journal/2026-04-03.md");
  });

  it("refuses a daily-notes folder that climbs out with ..", async () => {
    const { configured, id } = await dailyVault({ folder: "../outside" });
    await expect(
      configured.call("obsidian_append_to_daily_note", {
        vault_id: id,
        content: "escaped",
        date_iso: "2026-04-04",
      }),
    ).rejects.toThrow("Path escapes vault");
    await expect(
      configured.call("obsidian_daily_note_get", { vault_id: id, date_iso: "2026-04-04" }),
    ).rejects.toThrow("Path escapes vault");
  });

  it("refuses a daily-notes folder that is a dangling link", async () => {
    const { root, configured, id } = await dailyVault({ folder: "Journal" });
    const gone = outsideDir();
    dirLink(gone, join(root, "Journal"));
    rmSync(gone, { recursive: true, force: true });
    await expect(
      configured.call("obsidian_append_to_daily_note", {
        vault_id: id,
        content: "x",
        date_iso: "2026-04-05",
      }),
    ).rejects.toThrow("Path escapes vault");
  });

  it("allows a link that stays inside the vault, for the append and the read", async () => {
    const { root, configured, id } = await dailyVault({ folder: "Journal" });
    mkdirSync(join(root, "real", "journal"), { recursive: true });
    dirLink(join(root, "real", "journal"), join(root, "Journal"));
    await configured.call("obsidian_append_to_daily_note", {
      vault_id: id,
      content: "kept inside",
      date_iso: "2026-04-06",
    });
    expect(readFileSync(join(root, "real", "journal", "2026-04-06.md"), "utf8")).toBe(
      "kept inside",
    );
    const out = (await configured.callJson("obsidian_daily_note_get", {
      vault_id: id,
      date_iso: "2026-04-06",
    })) as DailyNoteReply;
    expect(out).toMatchObject({ exists: true, tail: "kept inside" });
  });

  it.skipIf(!canLinkFiles)(
    "refuses a daily note that is itself a file link out of the vault",
    async () => {
      const target = join(outsideDir(), "target.md");
      writeFileSync(target, "outside", "utf8");
      const { root, configured, id } = await dailyVault(undefined);
      symlinkSync(target, join(root, "2026-04-07.md"), "file");
      await expect(
        configured.call("obsidian_append_to_daily_note", {
          vault_id: id,
          content: "escaped",
          date_iso: "2026-04-07",
        }),
      ).rejects.toThrow("Path escapes vault: 2026-04-07.md");
      await expect(
        configured.call("obsidian_daily_note_get", { vault_id: id, date_iso: "2026-04-07" }),
      ).rejects.toThrow("Path escapes vault: 2026-04-07.md");
      expect(readFileSync(target, "utf8")).toBe("outside");
    },
  );
});
