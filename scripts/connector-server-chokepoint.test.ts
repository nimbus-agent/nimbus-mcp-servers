/**
 * `shared/connector-server.ts` is the only shipped file that builds a connector's MCP server.
 *
 * Which server a connector runs on is decided there, by who started the process: the upstream MCP
 * SDK's server for the Nimbus gateway, the layer server standalone. A connector that constructed
 * its own would skip that decision: standalone, it would serve neither a client of MCP revision
 * 2026-07-28 nor the consent flow the kit runs on the layer server.
 *
 * So no other shipped file may import the upstream SDK's SERVER modules at all (a type import
 * included: nothing outside the chokepoint needs one), and none may construct the layer server
 * directly. The upstream CLIENT modules are not servers and are not covered: five connectors use
 * them to talk to another MCP server.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const CHOKEPOINT = "shared/connector-server.ts";
const LAYER = "shared/layer-server.ts";
const SHIPPED_DIRS = ["connectors", "shared", "standalone"];

const transpiler = new Bun.Transpiler({ loader: "ts" });

function shippedSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "test" || name === "evals") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      shippedSources(path, out);
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) {
      out.push(relative(ROOT, path).replaceAll("\\", "/"));
    }
  }
  return out;
}

const files = SHIPPED_DIRS.flatMap((dir) => shippedSources(join(ROOT, dir)));

/**
 * A shipped file's source, with a `#!` line blanked: the transpiler refuses one, and the package
 * bin starts with one.
 */
function sourceOf(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8").replace(/^#!.*$/m, "");
}

/** The module specifiers a file imports, in any form, as Bun's own parser reads them. */
function importsOf(rel: string): string[] {
  return transpiler.scanImports(sourceOf(rel)).map((i) => i.path);
}

/** Whether a specifier is one of the upstream SDK's server modules. */
function isUpstreamServer(specifier: string): boolean {
  return /^@modelcontextprotocol\/sdk\/server(\/|$)/.test(specifier);
}

describe("one place builds a connector's server", () => {
  test("the scan sees the tree, and sees the chokepoint doing what it forbids elsewhere", () => {
    expect(files.length).toBeGreaterThan(300);
    expect(files).toContain(CHOKEPOINT);
    expect(files).toContain(LAYER);
    expect(files).toContain("connectors/github/src/server.ts");
    // If the scan could not see an upstream server import, every check below would pass vacuously.
    expect(importsOf(CHOKEPOINT).filter(isUpstreamServer).sort()).toEqual([
      "@modelcontextprotocol/sdk/server/mcp.js",
      "@modelcontextprotocol/sdk/server/stdio.js",
    ]);
    expect(importsOf(CHOKEPOINT)).toContain("./layer-server.ts");
  });

  test("no other shipped file imports an upstream server module", () => {
    const offenders = files
      .filter((rel) => rel !== CHOKEPOINT)
      .filter((rel) => importsOf(rel).some(isUpstreamServer));
    expect(offenders).toEqual([]);
  });

  test("no other shipped file constructs the layer server or an upstream server", () => {
    const offenders = files
      .filter((rel) => rel !== CHOKEPOINT && rel !== LAYER)
      .filter((rel) => {
        // Transpiled first, so a comment or a type never counts.
        const code = transpiler.transformSync(sourceOf(rel));
        return /\bcreateLayerServer\s*\(|\bnew\s+McpServer\s*\(|\bnew\s+StdioServerTransport\s*\(/.test(
          code,
        );
      });
    expect(offenders).toEqual([]);
  });

  test("every connector entry point builds its server through the chokepoint or the shared helper", () => {
    const entries = files.filter((rel) => /^connectors\/[^/]+\/src\/server\.ts$/.test(rel));
    expect(entries.length).toBeGreaterThan(90);
    const neither = entries.filter((rel) => {
      const code = transpiler.transformSync(sourceOf(rel));
      return !/\bcreateConnectorServer\s*\(|\brunReadOnlyMcpConnector\s*\(/.test(code);
    });
    expect(neither).toEqual([]);
  });
});
