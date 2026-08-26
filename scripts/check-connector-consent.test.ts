import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkConnectorConsent, connectorDirs } from "./check-connector-consent.ts";

/** A one-connector fixture tree whose sources use `eol` as their line ending. */
function fixture(eol: "\n" | "\r\n", opts: { registers: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), "consent-"));
  mkdirSync(join(root, "acme", "src"), { recursive: true });
  const body = [
    'import { createWriteToolRegistrar } from "../../shared/consent-kit.ts";',
    "export function registerTools(server: unknown): void {",
    "  const registerWriteTool = createWriteToolRegistrar(server, {});",
    "  registerSharedTools({",
    "    server,",
    ...(opts.registers ? ["    registerWriteTool,"] : []),
    "  });",
    "}",
  ].join(eol);
  writeFileSync(join(root, "acme", "src", "server.ts"), body);
  writeFileSync(
    join(root, "acme", "nimbus.extension.json"),
    JSON.stringify({ id: "com.nimbus.acme", hitlRequired: ["write"] }),
  );
  return root;
}

describe("checkConnectorConsent", () => {
  test("identifies connectors by src/server.ts, not by a name blocklist", () => {
    const root = fixture("\n", { registers: true });
    mkdirSync(join(root, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(root, "node_modules", "left-pad", "package.json"), "{}");
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
