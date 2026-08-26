import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectorDirs } from "./check-connector-consent.ts";
import { checkConnectorDeps } from "./check-connector-deps.ts";
import { checkConnectorEntrypoints } from "./check-connector-entrypoints.ts";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");

/** A repo-shaped fixture: <root>/package.json plus <root>/connectors/<id>/… */
function fixture(opts: {
  rootDeps?: Record<string, string>;
  connectorDeps?: Record<string, string>;
  server?: string;
}): { root: string; connectors: string } {
  const root = mkdtempSync(join(tmpdir(), "gates-"));
  const connectors = join(root, "connectors");
  mkdirSync(join(connectors, "acme", "src"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "root", dependencies: opts.rootDeps ?? {} }),
  );
  writeFileSync(
    join(connectors, "acme", "package.json"),
    JSON.stringify({ name: "acme", private: true, dependencies: opts.connectorDeps ?? {} }),
  );
  writeFileSync(join(connectors, "acme", "src", "server.ts"), opts.server ?? "export {};\n");
  return { root, connectors };
}

describe("check-connector-deps", () => {
  // A gate that reports "ok" because it scanned nothing looks identical to one that passed.
  test("actually sees this repo's 94 connectors", () => {
    expect(connectorDirs(ROOT).length).toBe(94);
    expect(checkConnectorDeps()).toEqual([]);
  });

  test("flags a disallowed dependency in a connector manifest", () => {
    const f = fixture({ connectorDeps: { "better-sqlite3": "^11.0.0" } });
    expect(checkConnectorDeps(f.connectors, f.root)).toEqual([
      { connector: "acme", dependency: "better-sqlite3" },
    ]);
  });

  // The root manifest is the graph a consumer actually resolves, since the connectors ship as one
  // package. Checking only per-connector files would leave the real graph unguarded.
  test("flags a disallowed dependency in the ROOT manifest", () => {
    const f = fixture({ rootDeps: { "node-gyp-build": "^4.0.0" } });
    expect(checkConnectorDeps(f.connectors, f.root)).toEqual([
      { connector: "<root>", dependency: "node-gyp-build" },
    ]);
  });

  test("allows the declared pure-JavaScript set", () => {
    const f = fixture({ rootDeps: { zod: "^4.0.0" }, connectorDeps: { imapflow: "^1.0.0" } });
    expect(checkConnectorDeps(f.connectors, f.root)).toEqual([]);
  });
});

describe("check-connector-entrypoints", () => {
  test("actually sees this repo's connectors and passes", () => {
    expect(checkConnectorEntrypoints()).toEqual([]);
  });

  test("flags a server that guards on import.meta.main without exporting startConnector", () => {
    const f = fixture({ server: "if (import.meta.main) { run(); }\n" });
    const found = checkConnectorEntrypoints(f.connectors);
    expect(found.map((v) => v.connector)).toEqual(["acme"]);
  });

  test("accepts the guard when startConnector is exported", () => {
    const f = fixture({
      server: "export async function startConnector() {}\nif (import.meta.main) { run(); }\n",
    });
    expect(checkConnectorEntrypoints(f.connectors)).toEqual([]);
  });
});
