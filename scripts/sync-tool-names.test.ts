import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findToolNamesDrift, syncToolNames } from "./sync-tool-names.ts";

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
