import { afterAll, afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CapturedTools, captureTools } from "../../../scripts/connector-tool-harness.ts";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import {
  formatDailyNoteFilename,
  OBSIDIAN_TOOL_NAMES,
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
