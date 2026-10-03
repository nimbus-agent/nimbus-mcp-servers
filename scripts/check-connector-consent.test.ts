import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type ConsentViolation,
  checkConnectorConsent,
  connectorDirs,
  report,
} from "./check-connector-consent.ts";

/** A one-connector fixture tree whose sources use `eol` as their line ending. */
function fixture(eol: "\n" | "\r\n", opts: { registers: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), "consent-"));
  mkdirSync(join(root, "connectors", "acme", "src"), { recursive: true });
  const body = [
    'import { createWriteToolRegistrar } from "../../../shared/consent-kit.ts";',
    "export function registerTools(server: unknown): void {",
    "  const registerWriteTool = createWriteToolRegistrar(server, {});",
    "  registerSharedTools({",
    "    server,",
    ...(opts.registers ? ["    registerWriteTool,"] : []),
    "  });",
    "}",
  ].join(eol);
  writeFileSync(join(root, "connectors", "acme", "src", "server.ts"), body);
  writeFileSync(
    join(root, "connectors", "acme", "nimbus.extension.json"),
    JSON.stringify({ id: "com.nimbus.acme", hitlRequired: ["write"] }),
  );
  return root;
}

describe("checkConnectorConsent", () => {
  test("identifies connectors by src/server.ts, not by a name blocklist", () => {
    const root = fixture("\n", { registers: true });
    mkdirSync(join(root, "connectors", "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(root, "connectors", "node_modules", "left-pad", "package.json"), "{}");
    expect(connectorDirs(root)).toEqual(["acme"]);
  });

  test("a connector registering through the kit is clean with LF sources", () => {
    expect(checkConnectorConsent(fixture("\n", { registers: true }))).toEqual([]);
  });

  // Red-proof: with `trimStart()` in registersWriteTool this case reported a
  // `mutation-declared` violation, because the exact-match line carried a trailing \r.
  test("the same connector is clean with CRLF sources", () => {
    expect(checkConnectorConsent(fixture("\r\n", { registers: true }))).toEqual([]);
  });

  test("a connector declaring write without registering one is still reported", () => {
    const found = checkConnectorConsent(fixture("\r\n", { registers: false }));
    expect(found.map((v) => v.rule)).toEqual(["mutation-declared"]);
  });
});

describe("checkConnectorConsent — rules over a whole tree", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /** A fresh tree holding exactly `files` (repo-relative path → contents). */
  function tree(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "consent-tree-"));
    roots.push(root);
    for (const [rel, body] of Object.entries(files)) {
      const abs = join(root, ...rel.split("/"));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body);
    }
    return root;
  }

  const READ_ONLY_SERVER = 'export const NAME = "acme";\n';
  const READ_ONLY_MANIFEST = JSON.stringify({ id: "com.nimbus.acme", hitlRequired: ["read"] });

  test("a tree without a connectors/ directory has no connectors and no findings", () => {
    const root = tree({ "shared/kit.ts": "export const x = 1;\n" });
    expect(connectorDirs(root)).toEqual([]);
    expect(checkConnectorConsent(root)).toEqual([]);
  });

  test("setConnectorMode named outside its sanctioned file is a violation, wherever it is", () => {
    const root = tree({
      "connectors/acme/src/server.ts": READ_ONLY_SERVER,
      "connectors/acme/src/regate.ts": 'setConnectorMode("gateway");\n',
      "connectors/acme/nimbus.extension.json": READ_ONLY_MANIFEST,
      "standalone/src/boot.ts": 'setConnectorMode("standalone");\n',
      // The sanctioned definition site, a test, and a comment are all exempt.
      "shared/connector-mode.ts": "export function setConnectorMode(m: string): void {}\n",
      "shared/connector-mode.test.ts": 'setConnectorMode("gateway");\n',
      "connectors/acme/src/notes.ts": '// never call setConnectorMode("gateway") here\n',
    });
    const found = checkConnectorConsent(root);
    expect(found.map((v) => [v.rule, v.file])).toEqual([
      ["mode-setter-confined", "connectors/acme/src/regate.ts"],
      ["mode-setter-confined", "standalone/src/boot.ts"],
    ]);
    expect(found[0]?.reason).toContain("the mode must come from the entrypoint");
  });

  test("files under node_modules and dist are never read", () => {
    const root = tree({
      "connectors/acme/src/server.ts": READ_ONLY_SERVER,
      "connectors/acme/nimbus.extension.json": READ_ONLY_MANIFEST,
      "connectors/acme/node_modules/dep/index.ts": 'setConnectorMode("gateway");\n',
      "connectors/acme/dist/server.ts": 'setConnectorMode("gateway");\n',
    });
    expect(checkConnectorConsent(root)).toEqual([]);
  });

  test("an unreadable manifest fails SAFE: the connector is treated as declaring a write", () => {
    const root = tree({
      "connectors/acme/src/server.ts": READ_ONLY_SERVER,
      "connectors/acme/nimbus.extension.json": "{ this is not json",
      "connectors/beta/src/server.ts": READ_ONLY_SERVER,
      // No manifest at all is unreadable too.
    });
    expect(checkConnectorConsent(root).map((v) => [v.rule, v.file])).toEqual([
      ["mutation-declared", "connectors/acme/nimbus.extension.json"],
      ["mutation-declared", "connectors/beta/nimbus.extension.json"],
    ]);
  });

  test("a manifest that declares no write or delete needs no consent-kit registration", () => {
    const root = tree({
      "connectors/acme/src/server.ts": READ_ONLY_SERVER,
      "connectors/acme/nimbus.extension.json": READ_ONLY_MANIFEST,
      "connectors/beta/src/server.ts": READ_ONLY_SERVER,
      "connectors/beta/nimbus.extension.json": "null",
      "connectors/gamma/src/server.ts": READ_ONLY_SERVER,
      "connectors/gamma/nimbus.extension.json": JSON.stringify({ hitlRequired: "write" }),
    });
    expect(checkConnectorConsent(root)).toEqual([]);
  });

  test("a delete declaration counts as mutating", () => {
    const root = tree({
      "connectors/acme/src/server.ts": READ_ONLY_SERVER,
      "connectors/acme/nimbus.extension.json": JSON.stringify({ hitlRequired: ["delete"] }),
    });
    expect(checkConnectorConsent(root).map((v) => v.rule)).toEqual(["mutation-declared"]);
  });

  test("a scanned base that is a file rather than a directory contributes nothing", () => {
    // `shared` exists but is a plain file: there is nothing under it to walk, and its own
    // content is not a source file of the tree.
    const root = tree({
      "connectors/acme/src/server.ts": READ_ONLY_SERVER,
      "connectors/acme/nimbus.extension.json": READ_ONLY_MANIFEST,
      shared: 'setConnectorMode("gateway");\n',
    });
    expect(checkConnectorConsent(root)).toEqual([]);
  });
});

describe("report", () => {
  const MODE: ConsentViolation = {
    rule: "mode-setter-confined",
    file: "connectors/acme/src/regate.ts",
    reason: "names setConnectorMode outside its sanctioned callers",
  };
  const MUTATION: ConsentViolation = {
    rule: "mutation-declared",
    file: "connectors/beta/nimbus.extension.json",
    reason: "declares write or delete in hitlRequired but no file in the connector registers one",
  };

  /** Run `report` with the console captured; return its exit code and what it printed. */
  function captured(
    violations: readonly ConsentViolation[],
    mutationBlocking?: boolean,
  ): { code: number; errors: unknown[][]; logs: unknown[][] } {
    const error = spyOn(console, "error").mockImplementation(() => undefined);
    const log = spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const code =
        mutationBlocking === undefined ? report(violations) : report(violations, mutationBlocking);
      return { code, errors: [...error.mock.calls], logs: [...log.mock.calls] };
    } finally {
      error.mockRestore();
      log.mockRestore();
    }
  }

  test("a clean tree exits 0 with an ok verdict and no annotations", () => {
    expect(captured([])).toEqual({
      code: 0,
      errors: [],
      logs: [["connector consent: ok (0 advisory)"]],
    });
  });

  test("every finding is an ::error annotation, and any one of them fails the gate", () => {
    expect(captured([MODE, MUTATION])).toEqual({
      code: 1,
      errors: [
        [`::error file=${MODE.file}::${MODE.reason}`],
        [`::error file=${MUTATION.file}::${MUTATION.reason}`],
      ],
      logs: [["connector consent: 2 violation(s)"]],
    });
  });

  test("an advisory mutation rule warns about its findings without failing the gate", () => {
    expect(captured([MUTATION], false)).toEqual({
      code: 0,
      errors: [[`::warning file=${MUTATION.file}::${MUTATION.reason}`]],
      logs: [["connector consent: ok (1 advisory)"]],
    });
  });

  test("an advisory mutation rule never softens a mode-setter finding", () => {
    expect(captured([MODE, MUTATION], false)).toEqual({
      code: 1,
      errors: [
        [`::error file=${MODE.file}::${MODE.reason}`],
        [`::warning file=${MUTATION.file}::${MUTATION.reason}`],
      ],
      logs: [["connector consent: 1 violation(s)"]],
    });
  });
});
