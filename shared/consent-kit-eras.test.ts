/**
 * The standalone consent flow in both MCP eras, at the wire.
 *
 * `consent-kit.test.ts` drives the kit through a client that opens with `initialize`. Here a
 * client of revision 2026-07-28 is scripted message by message, because what matters in that era
 * is what the SERVER does with a retry it did not write: the sealed request state travels through
 * the client, and the protocol says to treat it as attacker-controlled.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpListResult } from "@nimbus-dev/sdk/connector-kit";
import { z } from "zod";

import { connectUpstreamClient } from "../scripts/connector-tool-harness.ts";
import { verifyAuditChain } from "./audit-chain.ts";
import { resetConnectorModeForTests, setConnectorMode } from "./connector-mode.ts";
import {
  CONSENT_TTL_MS,
  createPrepareToolRegistrar,
  createWriteToolRegistrar,
  MAX_PENDING_CONSENTS,
} from "./consent-kit.ts";
import { createLayerServer, type LayerServer } from "./layer-server.ts";

const MODERN = "2026-07-28";
const VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const CAPS_KEY = "io.modelcontextprotocol/clientCapabilities";
const CAN_PROMPT = { elicitation: { form: {} } };
const ACCEPT = { action: "accept", content: { confirm: true } };
const TOOL = "github_branch_delete";
const ARGS = { branch: "acme/api" };

type Reply = {
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

const KIT_ENV = ["NIMBUS_MCP_TEST_WRITE_SCOPE", "NIMBUS_MCP_WRITE_BUDGET", "NIMBUS_MCP_AUDIT_LOG"];
const savedEnv = new Map(KIT_ENV.map((k) => [k, process.env[k]]));
const tempDirs: string[] = [];
const realNow = Date.now;

beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("standalone");
});

afterEach(() => {
  resetConnectorModeForTests();
  Date.now = realNow;
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

function ok(): McpListResult {
  return { content: [{ type: "text" as const, text: "{}" }] };
}

type Kit = {
  readonly server: LayerServer;
  readonly log: string;
  /** How many times the mutation ran. */
  readonly ran: () => number;
  /** The audit log, as `outcome` or `outcome:reason`. */
  readonly audit: () => Promise<string[]>;
};

/** One write tool on the standalone server, with a fresh audit log. */
async function kit(
  opts: { budget?: number; handler?: () => Promise<McpListResult> } = {},
): Promise<Kit> {
  const dir = await mkdtemp(join(tmpdir(), "nimbus-consent-eras-"));
  tempDirs.push(dir);
  const log = join(dir, "audit.jsonl");
  process.env["NIMBUS_MCP_TEST_WRITE_SCOPE"] = "repo:acme/api,repo:acme/web";
  process.env["NIMBUS_MCP_WRITE_BUDGET"] = String(opts.budget ?? 10);
  process.env["NIMBUS_MCP_AUDIT_LOG"] = log;
  const server = createLayerServer({ name: "eras", version: "0" });
  const cfg = {
    connector: "github",
    scopeEnv: "NIMBUS_MCP_TEST_WRITE_SCOPE",
    scopeKinds: ["repo"],
    // The stderr line is the production default; silenced so the test output stays readable.
    notify: () => undefined,
  };
  let ran = 0;
  createWriteToolRegistrar(server, cfg)(
    TOOL,
    {
      mutates: "repo.branch.delete",
      recoverable: false,
      capturePreState: () => Promise.resolve({ sha: "abc" }),
      scopeTargetOf: (a: { branch: string }) => ({ kind: "repo", value: a.branch }),
    },
    "Delete a branch.",
    z.object({ branch: z.string() }),
    opts.handler ??
      (async () => {
        ran += 1;
        return ok();
      }),
  );
  createPrepareToolRegistrar(server, cfg)(
    "github_commit_prepare",
    { scopeTargetOf: (a: { branch: string }) => ({ kind: "repo", value: a.branch }) },
    "Prepare a commit.",
    z.object({ branch: z.string() }),
    async () => ok(),
  );
  return {
    server,
    log,
    ran: () => ran,
    audit: async () =>
      (await readFile(log, "utf8").catch(() => ""))
        .trimEnd()
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => {
          const { outcome, detail } = (
            JSON.parse(l) as { entry: { outcome: string; detail: { reason?: string } } }
          ).entry;
          return detail.reason === undefined ? outcome : `${outcome}:${detail.reason}`;
        }),
  };
}

/** A scripted 2026-07-28 client: every request carries its own version and capabilities. */
function modernClient(server: LayerServer, capabilities: Record<string, unknown> = CAN_PROMPT) {
  const sent: Reply[] = [];
  const connection = server.layer.connect((m) => sent.push(m as unknown as Reply));
  let nextId = 1;
  const request = async (method: string, params: Record<string, unknown>): Promise<Reply> => {
    const id = nextId;
    nextId += 1;
    await connection.receive({
      jsonrpc: "2.0",
      id,
      method,
      params: { ...params, _meta: { [VERSION_KEY]: MODERN, [CAPS_KEY]: capabilities } },
    });
    const reply = sent.find((m) => m.id === id);
    if (reply === undefined) throw new Error(`no answer to ${method}`);
    return reply;
  };
  return {
    sent,
    list: async (): Promise<string[]> =>
      (((await request("tools/list", {})).result?.["tools"] ?? []) as Array<{ name: string }>).map(
        (t) => t.name,
      ),
    call: (args: unknown, extra: Record<string, unknown> = {}, name = TOOL) =>
      request("tools/call", { name, arguments: args, ...extra }),
  };
}

const textOf = (reply: Reply): string =>
  JSON.stringify((reply.result?.["content"] as unknown[] | undefined) ?? reply.error ?? null);

/** The first call of a write: the server's request for consent, and the state to bring back. */
async function ask(client: ReturnType<typeof modernClient>, args: unknown = ARGS) {
  const reply = await client.call(args);
  const state = reply.result?.["requestState"];
  if (typeof state !== "string") throw new Error(`no request state: ${JSON.stringify(reply)}`);
  return { reply, state };
}

describe("a 2026-07-28 client", () => {
  test("is asked with input_required and a sealed state, and nothing has run", async () => {
    const k = await kit();
    const client = modernClient(k.server);
    const { reply, state } = await ask(client);
    expect(reply.result?.["resultType"]).toBe("input_required");
    const question = ((reply.result?.["inputRequests"] ?? {}) as Record<string, Reply>)["confirm"];
    expect(question?.method).toBe("elicitation/create");
    expect(question?.params?.["mode"]).toBe("form");
    // The prompt carries the VERBATIM operation and parameters, never a digest.
    expect(question?.params?.["message"]).toContain("repo.branch.delete");
    expect(question?.params?.["message"]).toContain("acme/api");
    // base64url body, a dot, base64url MAC. It holds a nonce and nothing about the write.
    expect(state).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    const body = Buffer.from(state.split(".")[0] ?? "", "base64url").toString("utf8");
    expect(body).not.toContain("acme/api");
    expect(k.ran()).toBe(0);
    expect(await k.audit()).toEqual(["requested"]);
    // Nothing but the answer was sent: the modern era has no server-to-client request.
    expect(client.sent).toHaveLength(1);
  });

  test("the retry with an accept runs the write once, and the log reads requested, accepted, executed", async () => {
    const k = await kit();
    const client = modernClient(k.server);
    const { state } = await ask(client);
    const done = await client.call(ARGS, {
      inputResponses: { confirm: ACCEPT },
      requestState: state,
    });
    expect(done.result?.["resultType"]).toBe("complete");
    expect(done.result?.["isError"]).toBeUndefined();
    expect(k.ran()).toBe(1);
    expect(await k.audit()).toEqual(["requested", "accepted", "executed"]);
    expect(await verifyAuditChain(k.log)).toMatchObject({ ok: true });
  });

  test.each([
    ["decline", { action: "decline" }],
    ["cancel", { action: "cancel" }],
    ["accept without the form's own yes", { action: "accept", content: { confirm: false } }],
    ["accept with no content", { action: "accept" }],
    ["an answer under another key", undefined],
  ])("%s writes nothing and is recorded as declined", async (_name, answer) => {
    const k = await kit();
    const client = modernClient(k.server);
    const { state } = await ask(client);
    const done = await client.call(ARGS, {
      inputResponses: answer === undefined ? { other: ACCEPT } : { confirm: answer },
      requestState: state,
    });
    expect(textOf(done)).toContain("not approved");
    expect(k.ran()).toBe(0);
    expect(await k.audit()).toEqual(["requested", "declined"]);
  });

  test("a state that does not open is a protocol error that writes nothing and RECORDS nothing", async () => {
    const k = await kit();
    const client = modernClient(k.server);
    const { state } = await ask(client);
    const [body = "", mac = ""] = state.split(".");
    const flipped = `${body}.${mac.startsWith("A") ? "B" : "A"}${mac.slice(1)}`;
    const forgedBody = Buffer.from(
      Buffer.from(body, "base64url").toString("utf8").replace('"stdio"', '"other"'),
    ).toString("base64url");
    const answers = { inputResponses: { confirm: ACCEPT } };
    const refusals = [
      // A changed MAC, a changed body, and something that is not a state at all.
      await client.call(ARGS, { ...answers, requestState: flipped }),
      await client.call(ARGS, { ...answers, requestState: `${forgedBody}.${mac}` }),
      await client.call(ARGS, { ...answers, requestState: "not-a-state" }),
      // The right state, presented with OTHER arguments: approval of one write is not approval of
      // another, even one that is itself in scope.
      await client.call({ branch: "acme/web" }, { ...answers, requestState: state }),
      // Half a retry: a state with no answer, and an answer with no state.
      await client.call(ARGS, { requestState: state }),
      await client.call(ARGS, answers),
    ];
    for (const refusal of refusals) {
      expect(refusal.error?.code).toBe(-32602);
      // The reason is for the server's logs, never for the client.
      expect(refusal.error?.message).toBe("Invalid request state");
    }
    expect(k.ran()).toBe(0);
    expect(await k.audit()).toEqual(["requested"]);
    // None of them used the prompt up: the honest retry still works.
    await client.call(ARGS, { ...answers, requestState: state });
    expect(k.ran()).toBe(1);
  });

  test("a consent is single use: the same state again is refused, and records nothing", async () => {
    const k = await kit();
    const client = modernClient(k.server);
    const { state } = await ask(client);
    const retry = { inputResponses: { confirm: ACCEPT }, requestState: state };
    await client.call(ARGS, retry);
    const again = await client.call(ARGS, retry);
    expect(again.error?.code).toBe(-32602);
    expect(k.ran()).toBe(1);
    expect(await k.audit()).toEqual(["requested", "accepted", "executed"]);
  });

  test("a DECLINED consent cannot be answered again with a yes", async () => {
    const k = await kit();
    const client = modernClient(k.server);
    const { state } = await ask(client);
    await client.call(ARGS, {
      inputResponses: { confirm: { action: "decline" } },
      requestState: state,
    });
    const second = await client.call(ARGS, {
      inputResponses: { confirm: ACCEPT },
      requestState: state,
    });
    expect(second.error?.code).toBe(-32602);
    expect(k.ran()).toBe(0);
  });

  test("two retries of one state in flight together run the write once", async () => {
    const k = await kit();
    const client = modernClient(k.server);
    const { state } = await ask(client);
    const retry = { inputResponses: { confirm: ACCEPT }, requestState: state };
    const [a, b] = await Promise.all([client.call(ARGS, retry), client.call(ARGS, retry)]);
    expect([a.error?.code, b.error?.code].filter((c) => c === -32602)).toHaveLength(1);
    expect(k.ran()).toBe(1);
    expect(await verifyAuditChain(k.log)).toMatchObject({ ok: true });
  });

  test("a state expires: at its lifetime it no longer opens, and the write does not run", async () => {
    const k = await kit();
    const client = modernClient(k.server);
    const issued = realNow();
    Date.now = () => issued;
    const { state } = await ask(client);
    const retry = { inputResponses: { confirm: ACCEPT }, requestState: state };
    Date.now = () => issued + CONSENT_TTL_MS;
    expect((await client.call(ARGS, retry)).error?.code).toBe(-32602);
    expect(k.ran()).toBe(0);
  });

  test("a state another process sealed does not open here", async () => {
    const first = await kit();
    const { state } = await ask(modernClient(first.server));
    // A second registrar has its own key, as a restarted connector does.
    const second = await kit();
    const refused = await modernClient(second.server).call(ARGS, {
      inputResponses: { confirm: ACCEPT },
      requestState: state,
    });
    expect(refused.error?.code).toBe(-32602);
    expect(second.ran()).toBe(0);
    expect(await second.audit()).toEqual([]);
  });

  test("a client that cannot prompt is not listed the write, and a call is refused and recorded", async () => {
    const k = await kit();
    const mute = modernClient(k.server, {});
    expect(await mute.list()).toEqual(["github_commit_prepare"]);
    expect(await modernClient(k.server).list()).toEqual([TOOL, "github_commit_prepare"]);
    const refused = await mute.call(ARGS);
    // Reached the handler: a recorded refusal, never "unknown tool" and never a prompt.
    expect(refused.error).toBeUndefined();
    expect(textOf(refused)).toContain("this client cannot ask a person to approve a write");
    expect(refused.result?.["resultType"]).toBe("complete");
    expect(k.ran()).toBe(0);
    expect(await k.audit()).toEqual(["refused:client cannot prompt"]);
    // A prepare tool prompts no one, so it is listed to this client and runs for it.
    expect(textOf(await mute.call(ARGS, {}, "github_commit_prepare"))).toContain("{}");
  });

  test("an out-of-scope write is refused before any question, with no state issued", async () => {
    const k = await kit();
    const refused = await modernClient(k.server).call({ branch: "acme/secret" });
    expect(refused.result?.["resultType"]).toBe("complete");
    expect(refused.result?.["requestState"]).toBeUndefined();
    expect(textOf(refused)).toContain("out of scope: repo:acme/secret");
    expect(await k.audit()).toEqual(["refused:out of scope"]);
  });

  test("a spent budget unlists the write; a call is refused by the handler, and the prepare stays", async () => {
    const k = await kit({ budget: 1 });
    const client = modernClient(k.server);
    const { state } = await ask(client);
    await client.call(ARGS, { inputResponses: { confirm: ACCEPT }, requestState: state });
    expect(await client.list()).toEqual(["github_commit_prepare"]);
    const refused = await client.call(ARGS);
    expect(refused.error).toBeUndefined();
    expect(textOf(refused)).toContain("write budget exhausted for this session");
    expect(await k.audit()).toEqual([
      "requested",
      "accepted",
      "executed",
      "refused:budget exhausted",
    ]);
  });

  test("two approvals under a budget of one: the second is refused AFTER approval, and says so", async () => {
    const k = await kit({ budget: 1 });
    const client = modernClient(k.server);
    const one = await ask(client);
    const two = await ask(client);
    const accept = (state: string) =>
      client.call(ARGS, { inputResponses: { confirm: ACCEPT }, requestState: state });
    await accept(two.state);
    const loser = await accept(one.state);
    expect(loser.error).toBeUndefined();
    expect(textOf(loser)).toContain("write budget exhausted for this session");
    expect(k.ran()).toBe(1);
    expect(await k.audit()).toEqual([
      "requested",
      "requested",
      "accepted",
      "executed",
      "accepted",
      "refused:budget exhausted after approval",
    ]);
  });

  test("a full set of open prompts refuses a new one, drops none, and frees itself at expiry", async () => {
    const k = await kit({ budget: 1000 });
    const client = modernClient(k.server);
    const issued = realNow();
    Date.now = () => issued;
    const first = await ask(client);
    for (let i = 1; i < MAX_PENDING_CONSENTS; i += 1) await ask(client);
    const over = await client.call(ARGS);
    expect(textOf(over)).toContain("too many approvals are pending");
    expect(over.result?.["requestState"]).toBeUndefined();
    // The oldest prompt was not dropped to make room: its answer still counts.
    await client.call(ARGS, { inputResponses: { confirm: ACCEPT }, requestState: first.state });
    expect(k.ran()).toBe(1);
    // Once the rest have expired, the next call records each as declined and asks again.
    Date.now = () => issued + CONSENT_TTL_MS;
    expect((await ask(client)).state).not.toBe(first.state);
    const audit = await k.audit();
    expect(audit.filter((a) => a === "declined:expired unanswered")).toHaveLength(
      MAX_PENDING_CONSENTS - 1,
    );
    expect(audit.filter((a) => a === "refused:too many approvals pending")).toHaveLength(1);
    expect(await verifyAuditChain(k.log)).toMatchObject({ ok: true });
  });

  test("the tool's own failure text reaches the client, and so does a failed record of a write that ran", async () => {
    const failing = await kit({ handler: () => Promise.reject(new Error("GitHub API 404")) });
    const a = modernClient(failing.server);
    const one = await ask(a);
    const failed = await a.call(ARGS, {
      inputResponses: { confirm: ACCEPT },
      requestState: one.state,
    });
    expect(failed.result?.["isError"]).toBe(true);
    expect(textOf(failed)).toContain("GitHub API 404");
    expect(await failing.audit()).toEqual(["requested", "accepted", "failed"]);

    // The write runs, then the log's directory is gone: the answer must say the write RAN.
    let dir = "";
    const ranThenLost = await kit({
      handler: async () => {
        await rm(dir, { recursive: true, force: true });
        return ok();
      },
    });
    dir = join(ranThenLost.log, "..");
    const b = modernClient(ranThenLost.server);
    const two = await ask(b);
    const lost = await b.call(ARGS, {
      inputResponses: { confirm: ACCEPT },
      requestState: two.state,
    });
    expect(lost.result?.["isError"]).toBe(true);
    expect(textOf(lost)).toContain(`${TOOL} ran, but recording that it ran failed`);
  });

  test("arguments the tool's schema rejects are a tool error naming the tool, and reach nothing", async () => {
    const k = await kit();
    const refused = await modernClient(k.server).call({ branch: 7 });
    expect(refused.result?.["isError"]).toBe(true);
    expect(textOf(refused)).toContain(`Invalid arguments for tool ${TOOL}`);
    expect(await k.audit()).toEqual([]);
  });
});

describe("a client that opens with initialize", () => {
  /** A scripted legacy client that leaves the consent prompt for the test to answer. */
  async function legacyClient(server: LayerServer, timeoutMs?: number) {
    const sent: Reply[] = [];
    const connection = server.layer.connect(
      (m) => sent.push(m as unknown as Reply),
      timeoutMs === undefined ? {} : { legacyInputTimeoutMs: timeoutMs },
    );
    await connection.receive({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: { elicitation: {} } },
    });
    const prompt = async (): Promise<Reply> => {
      for (let i = 0; i < 200; i += 1) {
        const found = sent.find((m) => m.method === "elicitation/create");
        if (found !== undefined) return found;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      throw new Error("the server never asked");
    };
    return { sent, connection, prompt };
  }

  const CALL = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: TOOL, arguments: ARGS },
  };

  test("is sent the older elicitation request, and its accept runs the write", async () => {
    const k = await kit();
    const client = await legacyClient(k.server);
    const call = client.connection.receive(CALL);
    const asked = await client.prompt();
    // The state never leaves the process in this era: the request carries the question only.
    expect(JSON.stringify(asked)).not.toContain("requestState");
    expect(asked.params?.["message"]).toContain("repo.branch.delete");
    await client.connection.receive({ jsonrpc: "2.0", id: asked.id, result: ACCEPT });
    await call;
    expect(k.ran()).toBe(1);
    expect(await k.audit()).toEqual(["requested", "accepted", "executed"]);
  });

  test("a call cancelled while its prompt is open records ONE declined and writes nothing", async () => {
    const k = await kit();
    const client = await legacyClient(k.server);
    const call = client.connection.receive(CALL);
    await client.prompt();
    await client.connection.receive({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 1 },
    });
    await call;
    expect(k.ran()).toBe(0);
    expect(await k.audit()).toEqual(["requested", "declined"]);
    expect(await verifyAuditChain(k.log)).toMatchObject({ ok: true });
    // A cancelled call is not answered.
    expect(client.sent.some((m) => m.id === 1)).toBe(false);
  });

  test("a prompt nobody answers in time records ONE declined and writes nothing", async () => {
    const k = await kit();
    const client = await legacyClient(k.server, 5);
    await client.connection.receive(CALL);
    expect(k.ran()).toBe(0);
    expect(await k.audit()).toEqual(["requested", "declined"]);
    expect(textOf(client.sent.find((m) => m.id === 1) ?? {})).toContain("not approved");
  });

  test("an answer that arrives after the timeout does not run the write", async () => {
    const k = await kit();
    const client = await legacyClient(k.server, 5);
    await client.connection.receive(CALL);
    const asked = await client.prompt();
    await client.connection.receive({ jsonrpc: "2.0", id: asked.id, result: ACCEPT });
    expect(k.ran()).toBe(0);
  });
});

describe("the upstream MCP SDK's own client, against a standalone connector", () => {
  /** Connects the upstream client with an elicitation handler that gives `answer`. */
  async function upstream(server: LayerServer, answer: Record<string, unknown>) {
    const prompts: string[] = [];
    const client = await connectUpstreamClient(server, { elicitation: {} });
    client.setRequestHandler(ElicitRequestSchema, (request) => {
      prompts.push(request.params.message);
      return answer as { action: "accept" | "decline" | "cancel" };
    });
    return { client, prompts };
  }

  test("lists the write, is prompted through its own elicitation handler, and an accept runs it", async () => {
    const k = await kit();
    const { client, prompts } = await upstream(k.server, ACCEPT);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual([TOOL, "github_commit_prepare"]);
      const result = await client.callTool({ name: TOOL, arguments: ARGS });
      expect(result.isError).toBeUndefined();
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("repo.branch.delete");
      expect(k.ran()).toBe(1);
    } finally {
      await client.close();
    }
  });

  test("a decline from its handler writes nothing", async () => {
    const k = await kit();
    const { client } = await upstream(k.server, { action: "decline" });
    try {
      const result = await client.callTool({ name: TOOL, arguments: ARGS });
      expect(JSON.stringify(result.content)).toContain("not approved");
      expect(k.ran()).toBe(0);
      expect(await k.audit()).toEqual(["requested", "declined"]);
    } finally {
      await client.close();
    }
  });

  test("a client that declared no elicitation is not listed the write", async () => {
    const k = await kit();
    const client = await connectUpstreamClient(k.server);
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
        "github_commit_prepare",
      ]);
    } finally {
      await client.close();
    }
  });
});
