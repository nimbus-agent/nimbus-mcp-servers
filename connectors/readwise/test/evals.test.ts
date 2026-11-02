/**
 * Every case in `evals/*.eval.json` is run against the real Readwise server, in process, and its
 * reply is compared with the case's expectation. The suite's expected values were recorded once;
 * this keeps them from drifting unseen when the shared error text, the MCP SDK's error formatting
 * or the sync reply changes.
 *
 * The server is built by `buildReadOnlyMcpConnector` with the same two registrations
 * `src/extension.ts` makes. That file is not imported: it boots a stdio transport at module scope.
 * The client is joined to it over an in-memory transport, so the reply is what the MCP SDK sends.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withEnv } from "../../../scripts/connector-tool-harness.ts";
import { buildReadOnlyMcpConnector } from "../../../shared/run-read-only-mcp-connector.ts";
import { registerReadwiseSyncTool } from "../src/sync-tool.ts";
import { registerReadwiseTools } from "../src/tools.ts";

interface EvalCase {
  readonly name: string;
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly expect: {
    readonly rubric: "exact" | "json-match";
    readonly value: unknown;
    readonly error?: boolean;
  };
}

const EVALS_DIR = join(import.meta.dir, "..", "evals");

function loadCases(): { file: string; cases: EvalCase[] }[] {
  return readdirSync(EVALS_DIR)
    .filter((f) => f.endsWith(".eval.json"))
    .sort()
    .map((file) => {
      const doc = JSON.parse(readFileSync(join(EVALS_DIR, file), "utf8")) as {
        cases: EvalCase[];
      };
      return { file, cases: doc.cases };
    });
}

describe("readwise evals match the server's replies", () => {
  let client: Client;
  let server: McpServer;

  beforeAll(async () => {
    server = buildReadOnlyMcpConnector("nimbus-readwise", (reg) => {
      registerReadwiseTools(reg);
      registerReadwiseSyncTool(reg);
    }) as McpServer;
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "evals-test", version: "0.0.0" });
    await Promise.all([server.connect(a), client.connect(b)]);
  });

  afterAll(async () => {
    await client.close();
    await server.close();
  });

  const files = loadCases();

  it("finds at least one suite with cases", () => {
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(f.cases.length).toBeGreaterThan(0);
    }
  });

  for (const { file, cases } of files) {
    for (const c of cases) {
      it(`${file}: ${c.name}`, async () => {
        const result = await withEnv({ READWISE_TOKEN: undefined }, () =>
          client.callTool({ name: c.tool, arguments: c.input }),
        );
        const content = result["content"] as { type: string; text: string }[];
        expect(content).toHaveLength(1);
        expect(content[0]?.type).toBe("text");
        const text = content[0]?.text ?? "";
        expect(result["isError"] === true).toBe(c.expect.error === true);
        if (c.expect.rubric === "exact") {
          expect(text).toBe(c.expect.value as string);
        } else {
          expect(JSON.parse(text)).toEqual(c.expect.value);
        }
      });
    }
  }
});
