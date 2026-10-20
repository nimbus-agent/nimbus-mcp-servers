import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SYNC_TOOL_NAME } from "@nimbus-dev/sdk/sync";
import { READWISE_TOOL_NAMES } from "../src/tools.ts";

const CONNECTOR_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(CONNECTOR_DIR, "src", "extension.ts");

/** Extra `bun build` flags; the scanner's red-proof test passes `--external` here. */
async function buildBundle(outFile: string, extraArgs: readonly string[] = []): Promise<void> {
  const proc = Bun.spawn(
    [process.execPath, "build", ENTRY, "--target", "bun", "--outfile", outFile, ...extraArgs],
    { cwd: CONNECTOR_DIR, stdout: "pipe", stderr: "pipe" },
  );
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) {
    throw new Error(`bun build failed (${code}): ${err}`);
  }
}

/**
 * Every module specifier the file loads (static import, export-from, import(), require()), read
 * by Bun's own parser. A regex would also match specifier-shaped text inside template literals,
 * which the bundled ajv code generator contains, and would miss nothing the parser sees.
 */
export function moduleSpecifiers(source: string): string[] {
  return new Bun.Transpiler({ loader: "js" }).scanImports(source).map((i) => i.path);
}

function isAllowed(specifier: string): boolean {
  return (
    specifier.startsWith("node:") ||
    specifier.startsWith("bun:") ||
    specifier === "bun" ||
    // Bun's bundler emits some Node builtins without the prefix (e.g. `process`).
    builtinModules.includes(specifier)
  );
}

/** Specifiers a standalone file may not have: anything but a node:/bun: builtin or `bun`. */
export function foreignSpecifiers(source: string): string[] {
  // The parser cannot name a target it cannot see, so a non-literal import()/require() is a failure.
  const dynamicNonLiteral = [...source.matchAll(/\b(?:import|require)\s*\(\s*[^\s"'`)]/g)].map(
    (m) => `non-literal: ${m[0]}`,
  );
  return [...moduleSpecifiers(source).filter((s) => !isAllowed(s)), ...dynamicNonLiteral];
}

describe("foreignSpecifiers", () => {
  it("flags bare, relative and absolute specifiers in every import form", () => {
    const src = [
      'import a from "zod";',
      'import { b } from "../../shared/x.ts";',
      'export * from "/abs/y.js";',
      'export { c } from "pkg";',
      'import "side-effect";',
      'const d = await import("lazy");',
      'const e = require("cjs");',
      'import ok from "node:fs"; import bun from "bun:sqlite"; import "bun";',
    ].join("\n");
    expect(foreignSpecifiers(src).sort()).toEqual(
      ["../../shared/x.ts", "/abs/y.js", "cjs", "lazy", "pkg", "side-effect", "zod"].sort(),
    );
  });

  it("flags a dynamic import or require whose target is not a literal", () => {
    expect(foreignSpecifiers("await import(name);").length).toBe(1);
    expect(foreignSpecifiers("require(name);").length).toBe(1);
  });
});

describe("readwise extension bundle", () => {
  let work: string;
  let bundled: string;
  let isolated: string;

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "readwise-bundle-"));
    bundled = join(work, "build", "server.js");
    await buildBundle(bundled);
    // Run a copy from outside the repo tree so nothing can resolve against its node_modules.
    const runDir = join(work, "run");
    mkdirSync(runDir, { recursive: true });
    isolated = join(runDir, "server.js");
    copyFileSync(bundled, isolated);
  }, 60_000);

  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it("imports nothing outside itself", () => {
    expect(foreignSpecifiers(readFileSync(bundled, "utf8"))).toEqual([]);
  });

  it("the scan goes red when a dependency is left external", async () => {
    const out = join(work, "external", "server.js");
    await buildBundle(out, ["--external", "@modelcontextprotocol/sdk"]);
    const foreign = foreignSpecifiers(readFileSync(out, "utf8"));
    expect(foreign.some((s) => s.startsWith("@modelcontextprotocol/sdk"))).toBe(true);
  }, 60_000);

  it("runs alone: tools/list is the read tools plus __nimbus_sync, which answers offline", async () => {
    // Blank, so the sync tool must answer `unauthenticated` without touching the network.
    const env: Record<string, string> = { READWISE_TOKEN: "   " };
    for (const key of ["SystemRoot", "PATH", "Path", "TEMP", "TMP", "HOME", "USERPROFILE"]) {
      const v = process.env[key];
      if (v !== undefined) {
        env[key] = v;
      }
    }
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [isolated],
      cwd: dirname(isolated),
      env,
      stderr: "ignore",
    });
    const client = new Client({ name: "bundle-test", version: "0.0.0" });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(
        [...READWISE_TOOL_NAMES, SYNC_TOOL_NAME].sort(),
      );
      const result = await client.callTool({
        name: SYNC_TOOL_NAME,
        arguments: { cursor: null, depth: "full" },
      });
      const content = result.content as readonly { type: string; text?: string }[];
      expect(content).toHaveLength(1);
      expect(content[0]?.type).toBe("text");
      expect(JSON.parse(content[0]?.text ?? "")).toEqual({ status: "unauthenticated" });
    } finally {
      await client.close().catch(() => undefined);
    }
  }, 30_000);
});
