import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bootOverStubbedStdio } from "./connector-tool-harness.ts";
import { findToolNamesDrift, main, syncToolNames } from "./sync-tool-names.ts";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");

/**
 * A repo-shaped fixture with one connector whose `tools.ts` registers
 * `registered` and declares `declared`.
 */
function fixture(opts: {
  declared: readonly string[];
  registered: readonly string[];
  file?: "tools.ts" | "server.ts";
  guard?: boolean;
}): string {
  const root = mkdtempSync(join(tmpdir(), "toolnames-"));
  const dir = join(root, "connectors", "acme", "src");
  mkdirSync(dir, { recursive: true });
  const file = opts.file ?? "tools.ts";
  const registrations = opts.registered
    .map((n) => `  reg("${n}", "Describes ${n}.", {}, async () => ({ content: [] }));`)
    .join("\n");
  writeFileSync(
    join(dir, file),
    [
      `export const ACME_TOOL_NAMES = [`,
      ...opts.declared.map((n) => `  "${n}",`),
      `] as const;`,
      ``,
      `export function registerAcmeTools(reg: (...args: never[]) => void): void {`,
      registrations.replaceAll("reg(", "(reg as unknown as (...a: unknown[]) => void)("),
      `}`,
      opts.guard === true ? `if (import.meta.main) { /* bootstrap */ }` : ``,
      ``,
    ].join("\n"),
    "utf8",
  );
  return root;
}

describe("findToolNamesDrift", () => {
  // The trap this repo has been bitten by: a gate reporting "ok" because it
  // examined nothing looks exactly like one that passed.
  test("this repo's declarations agree with what its connectors register", async () => {
    expect(await findToolNamesDrift(ROOT)).toEqual([]);
  });

  test("reports a connector whose declaration is missing a tool", async () => {
    const root = fixture({ declared: ["acme_list"], registered: ["acme_list", "acme_get"] });
    expect(await findToolNamesDrift(root)).toEqual([
      {
        connector: "acme",
        file: join(root, "connectors", "acme", "src", "tools.ts"),
        declared: ["acme_list"],
        registered: ["acme_list", "acme_get"],
      },
    ]);
  });

  test("reports a declaration in the wrong ORDER, not just the wrong set", async () => {
    // Several connectors' own tests assert the order, so a reordered constant
    // is drift even though the set matches.
    const root = fixture({
      declared: ["acme_get", "acme_list"],
      registered: ["acme_list", "acme_get"],
    });
    expect(await findToolNamesDrift(root)).toHaveLength(1);
  });

  test("reports nothing when the declaration already matches", async () => {
    const root = fixture({ declared: ["acme_list"], registered: ["acme_list"] });
    expect(await findToolNamesDrift(root)).toEqual([]);
  });

  test("ignores a stray file beside the connector directories", async () => {
    const root = fixture({ declared: ["acme_list"], registered: ["acme_list", "acme_get"] });
    // A file, not a directory: there is no connector here to import.
    writeFileSync(join(root, "connectors", "README.md"), "# connectors\n", "utf8");
    expect((await findToolNamesDrift(root)).map((d) => d.connector)).toEqual(["acme"]);
  });

  test("skips an entry point that would start a transport on import", async () => {
    // An unguarded `server.ts` connects stdio at module scope; importing it to
    // read its tool names would open a real transport in the test process.
    const root = fixture({
      declared: ["acme_list"],
      registered: ["acme_list", "acme_get"],
      file: "server.ts",
    });
    expect(await findToolNamesDrift(root)).toEqual([]);
  });

  test("reads a guarded server.ts, which is safe to import", async () => {
    const root = fixture({
      declared: ["acme_list"],
      registered: ["acme_list", "acme_get"],
      file: "server.ts",
      guard: true,
    });
    expect(await findToolNamesDrift(root)).toHaveLength(1);
  });
});

describe("syncToolNames", () => {
  test("rewrites the stale declaration in registration order", async () => {
    const root = fixture({ declared: ["acme_list"], registered: ["acme_list", "acme_get"] });
    expect(await syncToolNames(root)).toEqual(["acme"]);
    const src = readFileSync(join(root, "connectors", "acme", "src", "tools.ts"), "utf8");
    expect(src).toContain(
      'export const ACME_TOOL_NAMES = [\n  "acme_list",\n  "acme_get",\n] as const;',
    );
    expect(await findToolNamesDrift(root)).toEqual([]);
  });

  test("leaves an already-correct declaration alone", async () => {
    const root = fixture({ declared: ["acme_list"], registered: ["acme_list"] });
    const path = join(root, "connectors", "acme", "src", "tools.ts");
    const before = readFileSync(path, "utf8");
    expect(await syncToolNames(root)).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

describe("main (the script's two modes)", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /** Run the script against a one-connector fixture; return its exit code, output and file. */
  async function run(
    argv: readonly string[],
    opts: { declared: readonly string[]; registered: readonly string[] },
  ): Promise<{ code: number; out: string[]; file: string; before: string }> {
    const root = fixture(opts);
    roots.push(root);
    const file = join(root, "connectors", "acme", "src", "tools.ts");
    const before = readFileSync(file, "utf8");
    const out: string[] = [];
    const code = await main(argv, root, (text) => {
      out.push(text);
    });
    return { code, out, file, before };
  }

  test("--check names each drifted connector, rewrites nothing, and exits 1", async () => {
    const r = await run(["bun", "sync-tool-names.ts", "--check"], {
      declared: ["acme_list"],
      registered: ["acme_list", "acme_get"],
    });
    expect(r.code).toBe(1);
    expect(r.out).toEqual([
      `::error file=${r.file}::acme declares [acme_list] but registers [acme_list, acme_get]\n`,
      "tool names: 1 out of date — run `bun run sync:tool-names`\n",
    ]);
    expect(readFileSync(r.file, "utf8")).toBe(r.before);
  });

  test("--check on declarations in step reports ok and exits 0", async () => {
    const r = await run(["--check"], { declared: ["acme_list"], registered: ["acme_list"] });
    expect(r.code).toBe(0);
    expect(r.out).toEqual(["tool names: ok\n"]);
  });

  test("without --check it rewrites the drifted declaration and names it", async () => {
    const r = await run(["bun", "sync-tool-names.ts"], {
      declared: ["acme_list"],
      registered: ["acme_list", "acme_get"],
    });
    expect(r.code).toBe(0);
    expect(r.out).toEqual(["tool names: updated acme\n"]);
    expect(readFileSync(r.file, "utf8")).toContain(
      'export const ACME_TOOL_NAMES = [\n  "acme_list",\n  "acme_get",\n] as const;',
    );
  });

  test("without --check on declarations in step says so and leaves the file alone", async () => {
    const r = await run([], { declared: ["acme_list"], registered: ["acme_list"] });
    expect(r.code).toBe(0);
    expect(r.out).toEqual(["tool names: already in sync\n"]);
    expect(readFileSync(r.file, "utf8")).toBe(r.before);
  });

  test("with no root or writer given, --check examines this repository and reports on stdout", async () => {
    // `bun run audit:tool-names` is exactly this call: the default root is the repository and the
    // default writer is process.stdout, which is swapped for an in-memory stream to read it back.
    let code: number | undefined;
    const stdio = await bootOverStubbedStdio(async () => {
      code = await main(["bun", "sync-tool-names.ts", "--check"]);
    });
    expect(code).toBe(0);
    expect(String(stdio.fromServer.read())).toBe("tool names: ok\n");
  });
});
