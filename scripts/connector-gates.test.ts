import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectorDirs } from "./check-connector-consent.ts";
import {
  checkConnectorDeps,
  manifestPathFor,
  report as reportDeps,
} from "./check-connector-deps.ts";
import {
  checkConnectorEntrypoints,
  report as reportEntrypoints,
} from "./check-connector-entrypoints.ts";
import { runBanner, targetsFor } from "./run-sandbox-contract.ts";

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
    expect(connectorDirs(ROOT)).toHaveLength(94);
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

describe("report()", () => {
  // Extracted from the `import.meta.main` blocks so they are reachable at all: that guard is false
  // under an import, so the reporting used to be uncoverable by any in-process test — and the only
  // alternative was excluding these audit files from coverage, which is the wrong trade for the
  // files that ARE the gates.
  test("connector-deps: no violations exits 0", () => {
    expect(reportDeps([])).toBe(0);
  });

  test("connector-deps: a violation exits 1", () => {
    expect(reportDeps([{ connector: "acme", dependency: "better-sqlite3" }])).toBe(1);
  });

  test("connector-deps: the root manifest reports against package.json, not a connector path", () => {
    expect(manifestPathFor("<root>")).toBe("package.json");
    expect(manifestPathFor("acme")).toBe("connectors/acme/package.json");
  });

  test("connector-entrypoints: no violations exits 0", () => {
    expect(reportEntrypoints([])).toBe(0);
  });

  test("connector-entrypoints: a violation exits 1", () => {
    expect(reportEntrypoints([{ connector: "acme", reason: "guards without exporting" }])).toBe(1);
  });

  /** Run `fn` with the console captured; return what it printed to each stream. */
  function printed(fn: () => number): { code: number; errors: unknown[][]; logs: unknown[][] } {
    const error = spyOn(console, "error").mockImplementation(() => undefined);
    const log = spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const code = fn();
      return { code, errors: [...error.mock.calls], logs: [...log.mock.calls] };
    } finally {
      error.mockRestore();
      log.mockRestore();
    }
  }

  test("connector-deps: annotates each violation against the manifest that declares it", () => {
    expect(
      printed(() =>
        reportDeps([
          { connector: "<root>", dependency: "node-gyp-build" },
          { connector: "acme", dependency: "better-sqlite3" },
        ]),
      ),
    ).toEqual({
      code: 1,
      errors: [
        [
          '::error file=package.json::dependency "node-gyp-build" is not in ALLOWED_CONNECTOR_DEPS — connectors are bundled into the gateway binary, so a native dependency breaks it silently',
        ],
        [
          '::error file=connectors/acme/package.json::dependency "better-sqlite3" is not in ALLOWED_CONNECTOR_DEPS — connectors are bundled into the gateway binary, so a native dependency breaks it silently',
        ],
      ],
      logs: [["connector deps: 2 violation(s)"]],
    });
    expect(printed(() => reportDeps([]))).toEqual({
      code: 0,
      errors: [],
      logs: [["connector deps: ok"]],
    });
  });

  test("connector-entrypoints: annotates the offending server.ts with the reason", () => {
    expect(
      printed(() => reportEntrypoints([{ connector: "acme", reason: "guards without exporting" }])),
    ).toEqual({
      code: 1,
      errors: [["::error file=connectors/acme/src/server.ts::guards without exporting"]],
      logs: [["connector entrypoints: 1 violation(s)"]],
    });
    expect(printed(() => reportEntrypoints([]))).toEqual({
      code: 0,
      errors: [],
      logs: [["connector entrypoints: ok"]],
    });
  });
});

describe("the gates' edge cases", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function tracked(opts: Parameters<typeof fixture>[0]): ReturnType<typeof fixture> {
    const f = fixture(opts);
    roots.push(f.root);
    return f;
  }

  test("connector-deps: an unreadable manifest is an observation failure, not a violation", () => {
    const f = tracked({});
    const manifest = join(f.connectors, "acme", "package.json");
    writeFileSync(manifest, "{ not json");
    expect(() => checkConnectorDeps(f.connectors, f.root)).toThrow(
      `check-connector-deps: cannot read ${manifest}: `,
    );
  });

  test("connector-deps: checks optional and peer dependencies, exempts @types/*", () => {
    const f = tracked({});
    writeFileSync(
      join(f.connectors, "acme", "package.json"),
      JSON.stringify({
        dependencies: { "@types/nodemailer": "^8.0.0", zod: "^4.0.0" },
        optionalDependencies: { "cpu-features": "^0.0.10" },
        peerDependencies: { "better-sqlite3": "^11.0.0" },
      }),
    );
    expect(checkConnectorDeps(f.connectors, f.root)).toEqual([
      { connector: "acme", dependency: "cpu-features" },
      { connector: "acme", dependency: "better-sqlite3" },
    ]);
  });

  test("connector-deps: skips what is not a manifest or not a dependency map", () => {
    const f = tracked({});
    // A manifest that is not an object, one whose dependency field is not a map, a connector
    // directory with no manifest at all, and a stray file beside the connector directories.
    writeFileSync(join(f.connectors, "acme", "package.json"), "null");
    mkdirSync(join(f.connectors, "beta"));
    writeFileSync(
      join(f.connectors, "beta", "package.json"),
      JSON.stringify({ dependencies: "better-sqlite3" }),
    );
    mkdirSync(join(f.connectors, "gamma"));
    writeFileSync(join(f.connectors, "README.md"), "# connectors\n");
    expect(checkConnectorDeps(f.connectors, f.root)).toEqual([]);
  });

  test("connector-entrypoints: skips a stray file and a directory with no server.ts", () => {
    const f = tracked({ server: "if (import.meta.main) { run(); }\n" });
    mkdirSync(join(f.connectors, "docs-only", "src"), { recursive: true });
    writeFileSync(join(f.connectors, "docs-only", "src", "index.ts"), "export {};\n");
    writeFileSync(join(f.connectors, "notes.md"), "if (import.meta.main) {}\n");
    expect(checkConnectorEntrypoints(f.connectors).map((v) => v.connector)).toEqual(["acme"]);
  });

  test("connector-entrypoints: a guard named only in a comment is not a guard", () => {
    const f = tracked({ server: "// started with if (import.meta.main) elsewhere\nrun();\n" });
    expect(checkConnectorEntrypoints(f.connectors)).toEqual([]);
  });
});

describe("sandbox contract runner", () => {
  test("extra argv scopes the run down and wins over discovery", () => {
    expect(
      targetsFor(["connectors/a/test/sandbox.test.ts"], ["connectors/b/test/sandbox.test.ts"]),
    ).toEqual(["connectors/b/test/sandbox.test.ts"]);
  });

  test("with no extra argv every discovered file is a target", () => {
    expect(targetsFor(["connectors/a/test/sandbox.test.ts"], [])).toHaveLength(1);
  });

  // The banner is the only warning a user gets that this run touches the network for real.
  test("the banner states the count and that the requests are real", () => {
    const b = runBanner(79);
    expect(b).toContain("79");
    expect(b).toContain("real outbound");
  });
});
