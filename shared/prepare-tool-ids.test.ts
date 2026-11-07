import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { isPrepareToolId, PREPARE_TOOL_IDS } from "./prepare-tool-ids.ts";

const ROOT = resolve(import.meta.dir, "..");

/**
 * A copy of the gateway's list of read verbs (the gateway keeps it in the file that holds its own
 * `PREPARE_TOOL_IDS` mirror, `connectors/connector-writes/prepare-tools.ts`). The gateway treats a
 * tool whose last `_` segment is one of these as a plain read, so a prepare tool named that way
 * would be refused there. Pinned here so the mistake fails in the repo that makes it.
 */
const GATEWAY_READ_VERBS = [
  "list",
  "get",
  "query",
  "search",
  "read",
  "fetch",
  "download",
  "describe",
  "history",
  "export",
  "view",
  "show",
  "info",
  "metadata",
];

/** Every non-test source file of every connector, with its comments left in (calls are matched). */
function connectorSources(): { file: string; src: string }[] {
  const out: { file: string; src: string }[] = [];
  const base = join(ROOT, "connectors");
  for (const name of readdirSync(base, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const srcDir = join(base, name.name, "src");
    let files: string[];
    try {
      files = readdirSync(srcDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    } catch {
      continue;
    }
    for (const f of files) {
      out.push({ file: `${name.name}/src/${f}`, src: readFileSync(join(srcDir, f), "utf8") });
    }
  }
  return out;
}

/** The callee of every call that takes `id` as its first argument, per file. */
function calleesOf(id: string): { file: string; callee: string }[] {
  const call = new RegExp(String.raw`([A-Za-z_$][\w$]*)\(\s*"${id}"`, "g");
  const found: { file: string; callee: string }[] = [];
  for (const { file, src } of connectorSources()) {
    for (const m of src.matchAll(call)) found.push({ file, callee: m[1] ?? "" });
  }
  return found;
}

describe("PREPARE_TOOL_IDS", () => {
  test("is the two commit tools, and nothing is listed twice", () => {
    expect([...PREPARE_TOOL_IDS]).toEqual(["github_commit_prepare", "gitlab_commit_prepare"]);
    expect(new Set(PREPARE_TOOL_IDS).size).toBe(PREPARE_TOOL_IDS.length);
  });

  test("isPrepareToolId accepts exactly the listed ids", () => {
    expect(isPrepareToolId("github_commit_prepare")).toBe(true);
    expect(isPrepareToolId("github_files_get")).toBe(false);
    expect(isPrepareToolId("")).toBe(false);
  });

  for (const id of PREPARE_TOOL_IDS) {
    test(`${id} is registered exactly once, through registerPrepareTool and nothing else`, () => {
      const calls = calleesOf(id);
      expect(calls.map((c) => c.callee)).toEqual(["registerPrepareTool"]);
      // The connector that registers it is the one named by the id's prefix.
      expect(calls[0]?.file.startsWith(`${id.split("_")[0] ?? "?"}/`)).toBe(true);
    });

    test(`${id} does not end in a verb the gateway reads as a plain read`, () => {
      const last = id.split("_").at(-1) ?? "";
      expect(GATEWAY_READ_VERBS).not.toContain(last);
    });
  }

  test("no prepare id is also registered by a write registrar call (so it is no write id)", () => {
    for (const id of PREPARE_TOOL_IDS) {
      const asWrite = calleesOf(id).filter((c) => /WriteTool$/.test(c.callee));
      expect(asWrite).toEqual([]);
    }
  });
});
