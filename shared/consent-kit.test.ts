import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { McpListResult } from "@nimbus-dev/sdk/connector-kit";
import { z } from "zod";

import { verifyAuditChain } from "./audit-chain.ts";
import { resetConnectorModeForTests, setConnectorMode } from "./connector-mode.ts";
import {
  type ConsentServer,
  createPrepareToolRegistrar,
  createWriteToolRegistrar,
  type GatewayConsentServer,
  type WriteToolRegistrar,
} from "./consent-kit.ts";
import { createLayerServer, type LayerServer } from "./layer-server.ts";
import { DEFAULT_WRITE_BUDGET, WRITE_BUDGET_ENV } from "./write-budget.ts";

type Registered = { name: string };

/**
 * The upstream-shaped server a GATEWAY-mode connector registers on. The kit asks it nothing about
 * the client: in gateway mode the gateway's executor is the gate.
 */
function gatewayServer(): GatewayConsentServer & { registered: Registered[] } {
  const registered: Registered[] = [];
  return {
    registered,
    registerTool: (name: string) => {
      registered.push({ name });
      return { disable: () => undefined };
    },
    tool: () => undefined,
    sendLoggingMessage: () => Promise.resolve(),
  };
}

const schema = z.object({ branch: z.string() });

/**
 * The registrar reads these at construction, and the helpers below set them per case. Restore
 * them after every case: bun runs many test files in ONE process, and an audit-log path left
 * behind here would collect the audit entries of every later file's standalone writes.
 */
const KIT_ENV = ["NIMBUS_MCP_TEST_WRITE_SCOPE", "NIMBUS_MCP_WRITE_BUDGET", "NIMBUS_MCP_AUDIT_LOG"];
const savedKitEnv = new Map(KIT_ENV.map((k) => [k, process.env[k]]));
const tempDirs: string[] = [];

afterEach(() => {
  for (const [key, value] of savedKitEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempAuditPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nimbus-consent-"));
  tempDirs.push(dir);
  return join(dir, "audit.jsonl");
}

function ok(): McpListResult {
  return { content: [{ type: "text" as const, text: "{}" }] };
}

function cfgFor() {
  return {
    mutates: "repo.branch.delete",
    recoverable: false,
    capturePreState: () => Promise.resolve({ sha: "abc" }),
    scopeTargetOf: (a: { branch: string }) => ({ kind: "repo", value: a.branch }),
  };
}

describe("write tool registration", () => {
  beforeEach(() => {
    resetConnectorModeForTests();
  });
  afterEach(() => {
    resetConnectorModeForTests();
  });

  test("gateway mode registers the write tool — executor.ts is the gate there", () => {
    setConnectorMode("gateway");
    const srv = gatewayServer();
    const reg = createWriteToolRegistrar(srv, {
      connector: "github",
      scopeEnv: "X",
      scopeKinds: ["repo"],
    });
    reg("github_branch_delete", cfgFor(), "desc", schema, async () => ok());
    // The gateway does not consult client capabilities at all.
    expect(srv.registered.map((r) => r.name)).toEqual(["github_branch_delete"]);
  });

  test("standalone lists the tool only to a client that can prompt a person", () => {
    setConnectorMode("standalone");
    const srv = createLayerServer({ name: "t", version: "0" });
    const reg = createWriteToolRegistrar(srv, {
      connector: "github",
      scopeEnv: "X",
      scopeKinds: ["repo"],
    });
    reg("github_branch_delete", cfgFor(), "desc", schema, async () => ok());
    const listedTo = (clientCapabilities: Record<string, unknown>): string[] =>
      srv.toolsFor("list", { clientCapabilities }).map((t) => t.name);
    // Default-DENY: a client that declared no elicitation is not shown a tool it must not use.
    expect(listedTo({})).toEqual([]);
    expect(listedTo({ elicitation: { url: {} } })).toEqual([]);
    expect(listedTo({ elicitation: "yes" })).toEqual([]);
    // An empty object is how the revisions before 2025-11-25 declared form support.
    expect(listedTo({ elicitation: {} })).toEqual(["github_branch_delete"]);
    expect(listedTo({ elicitation: { form: {} } })).toEqual(["github_branch_delete"]);
    // Listing is not what makes it callable: the handler is always reachable, so a call from a
    // client that was never listed it is refused and RECORDED, not answered as an unknown tool.
    expect(srv.toolsFor("call", { clientCapabilities: {} }).map((t) => t.name)).toEqual([
      "github_branch_delete",
    ]);
  });

  test("a standalone connector that was not built by createConnectorServer does not start", () => {
    setConnectorMode("standalone");
    const cfg = { connector: "github", scopeEnv: "X", scopeKinds: ["repo"] };
    expect(() => createWriteToolRegistrar(gatewayServer(), cfg)).toThrow(
      "must be built with createConnectorServer",
    );
    const prepare = createPrepareToolRegistrar(gatewayServer(), cfg);
    expect(() =>
      prepare(
        "github_commit_prepare",
        { scopeTargetOf: () => ({ kind: "repo", value: "x" }) },
        "d",
        schema,
        async () => ok(),
      ),
    ).toThrow("must be built with createConnectorServer");
  });

  test("a gateway connector handed the standalone server does not register a write on it", () => {
    setConnectorMode("gateway");
    const reg = createWriteToolRegistrar(createLayerServer({ name: "t", version: "0" }), {
      connector: "github",
      scopeEnv: "X",
      scopeKinds: ["repo"],
    });
    expect(() => reg("github_branch_delete", cfgFor(), "desc", schema, async () => ok())).toThrow(
      "gateway mode needs the upstream server",
    );
  });

  test("a config with recoverable:false and NO capturePreState is rejected at registration", () => {
    setConnectorMode("gateway");
    const srv = gatewayServer();
    const reg = createWriteToolRegistrar(srv, {
      connector: "github",
      scopeEnv: "X",
      scopeKinds: ["repo"],
    });
    expect(() =>
      reg(
        "github_branch_delete",
        {
          mutates: "repo.branch.delete",
          recoverable: false,
          // capturePreState deliberately absent — that is what this case asserts.
          scopeTargetOf: (a: { branch: string }) => ({ kind: "repo", value: a.branch }),
        },
        "desc",
        schema,
        async () => ok(),
      ),
    ).toThrow(/capturePreState is required when recoverable is false/);
  });
});

type Elicit = (p: { message: string }) => Promise<{
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}>;

type Handler = (args: unknown) => Promise<McpListResult>;

/**
 * The real standalone server, plus a client for it. `captured` and `handlers` CALL a tool the way
 * a client does: `tools/call` on a real connection of the MCP layer, opened with `initialize`
 * (the legacy era), with the `elicitation/create` request a write's consent raises answered by
 * `elicit`. So every case below runs the whole flow: the prompt, the sealed state, the nonce.
 *
 * A call REJECTS with the server's own text when the tool failed or the request was refused as a
 * protocol error, which is what the cases assert on.
 */
type FakeServer = LayerServer & {
  /** Calls the tool registered last. */
  captured: Handler | undefined;
  /** Calls a registered tool by name. */
  handlers: Map<string, Handler>;
  /** How many consent prompts the client was sent. */
  prompts: { count: number };
  /** The tools this client is listed now. */
  listed: () => string[];
  onUnregister?: () => void;
  /** Kept so the cases read as before: on this server nothing waits for a handshake. */
  handshake: () => void;
  /** Where `registerAndGet` and `kit` send the second channel of a record (the `notify` seam). */
  sendLoggingMessage: (p: { level: string; data: unknown }) => Promise<void>;
};

type Wire = {
  id?: unknown;
  method?: string;
  params?: { message?: string };
  result?: McpListResult & { isError?: boolean };
  error?: { code: number; message: string };
};

function serverWith(
  elicit: Elicit,
  capabilities: Record<string, unknown> = { elicitation: {} },
): FakeServer {
  const real = createLayerServer({ name: "consent-kit-test", version: "0" });
  const waiting = new Map<number, (answer: Wire) => void>();
  let nextId = 1;
  const connection = real.layer.connect((message) => {
    const wire = message as unknown as Wire;
    if (wire.method !== undefined) {
      // The server asking the client: a consent prompt.
      srv.prompts.count += 1;
      elicit({ message: wire.params?.message ?? "" }).then(
        (result) => void connection.receive({ jsonrpc: "2.0", id: wire.id, result }),
        (e: unknown) =>
          void connection.receive({
            jsonrpc: "2.0",
            id: wire.id,
            error: { code: -32000, message: e instanceof Error ? e.message : String(e) },
          }),
      );
      return;
    }
    if (typeof wire.id !== "number") return;
    waiting.get(wire.id)?.(wire);
    waiting.delete(wire.id);
  });
  const request = (method: string, params: Record<string, unknown>): Promise<Wire> => {
    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      waiting.set(id, resolve);
      connection.receive({ jsonrpc: "2.0", id, method, params }).catch(reject);
    });
  };
  let opened: Promise<unknown> | undefined;
  const callTool = async (name: string, args: unknown): Promise<McpListResult> => {
    opened ??= request("initialize", { protocolVersion: "2025-11-25", capabilities });
    await opened;
    const answered = await request("tools/call", { name, arguments: args });
    if (answered.error !== undefined) {
      throw new Error(`MCP error ${String(answered.error.code)}: ${answered.error.message}`);
    }
    if (answered.result === undefined) throw new Error("the call was not answered");
    if (answered.result.isError === true) {
      const first = answered.result.content[0];
      throw new Error(first?.type === "text" ? first.text : "the tool failed");
    }
    return answered.result;
  };
  const srv: FakeServer = {
    ...real,
    captured: undefined,
    handlers: new Map(),
    prompts: { count: 0 },
    listed: () => real.toolsFor("list", { clientCapabilities: capabilities }).map((t) => t.name),
    registerTool: (name, config, cb) => {
      const handle = real.registerTool(name, config, cb);
      const call: Handler = (args) => callTool(name, args);
      srv.captured = call;
      srv.handlers.set(name, call);
      return {
        disable: () => {
          handle.disable();
          srv.onUnregister?.();
        },
      };
    },
    handshake: () => undefined,
    sendLoggingMessage: () => Promise.resolve(),
  };
  return srv;
}

/** The registrar config every standalone case uses, with records sent on to `srv`. */
function kitConfig(srv: FakeServer) {
  return {
    connector: "github",
    scopeEnv: "NIMBUS_MCP_TEST_WRITE_SCOPE",
    scopeKinds: ["repo"],
    notify: (tool: string, outcome: string) =>
      srv.sendLoggingMessage({
        level: outcome === "executed" ? "info" : "warning",
        data: { connector: "github", tool, outcome },
      }),
  };
}

/** Register one write tool and hand back the WRAPPED handler the client would call. */
function registerAndGet(
  srv: FakeServer,
  handler: () => Promise<McpListResult>,
  opts: {
    scope?: string | undefined;
    budget?: number;
    auditLog?: string;
    refuseBefore?: (a: { branch: string }) => string | undefined;
  } = {},
): (args: { branch: string }) => Promise<McpListResult> {
  // `"scope" in opts` distinguishes an OMITTED scope (default to a permissive one, so consent
  // cases are not accidentally testing the scope gate) from an explicitly `undefined` one, which
  // is how the empty-scope case asks for a genuinely unset allow-list.
  const scope = "scope" in opts ? opts.scope : "repo:acme/api";
  process.env["NIMBUS_MCP_TEST_WRITE_SCOPE"] = scope ?? "";
  process.env["NIMBUS_MCP_WRITE_BUDGET"] = String(opts.budget ?? 10);
  if (opts.auditLog !== undefined) process.env["NIMBUS_MCP_AUDIT_LOG"] = opts.auditLog;
  else delete process.env["NIMBUS_MCP_AUDIT_LOG"];

  const reg = createWriteToolRegistrar(srv, kitConfig(srv));
  reg(
    "github_branch_delete",
    {
      mutates: "repo.branch.delete",
      recoverable: false,
      capturePreState: () => Promise.resolve({ sha: "abc" }),
      scopeTargetOf: (a: { branch: string }) => ({ kind: "repo", value: a.branch }),
      ...(opts.refuseBefore === undefined ? {} : { refuseBefore: opts.refuseBefore }),
    },
    "Delete a branch.",
    z.object({ branch: z.string() }),
    handler,
  );
  const cb = srv.captured;
  if (cb === undefined) throw new Error("tool was not registered");
  return (args) => cb(args);
}

describe("elicitation consent", () => {
  beforeEach(() => {
    resetConnectorModeForTests();
    setConnectorMode("standalone");
  });
  afterEach(() => {
    resetConnectorModeForTests();
  });

  test("accept with confirm:true runs the handler exactly once", async () => {
    let calls = 0;
    const srv = serverWith(() => Promise.resolve({ action: "accept", content: { confirm: true } }));
    const call = registerAndGet(srv, async () => {
      calls += 1;
      return ok();
    });
    await call({ branch: "acme/api" });
    expect(calls).toBe(1);
  });

  for (const action of ["decline", "cancel"] as const) {
    test(`${action} mutates NOTHING`, async () => {
      let calls = 0;
      const srv = serverWith(() => Promise.resolve({ action }));
      const call = registerAndGet(srv, async () => {
        calls += 1;
        return ok();
      });
      const res = await call({ branch: "acme/api" });
      expect(calls).toBe(0);
      expect(JSON.stringify(res)).toMatch(/not approved/i);
    });
  }

  test("accept with confirm:false is a REFUSAL — the action field alone is not consent", async () => {
    let calls = 0;
    const srv = serverWith(() =>
      Promise.resolve({ action: "accept", content: { confirm: false } }),
    );
    const call = registerAndGet(srv, async () => {
      calls += 1;
      return ok();
    });
    await call({ branch: "acme/api" });
    expect(calls).toBe(0);
  });

  test("a client that answers the prompt with an ERROR mutates nothing — fail-closed", async () => {
    let calls = 0;
    const srv = serverWith(() => Promise.reject(new Error("timed out")));
    const call = registerAndGet(srv, async () => {
      calls += 1;
      return ok();
    });
    const res = await call({ branch: "acme/api" });
    expect(calls).toBe(0);
    expect(JSON.stringify(res)).toMatch(/not approved/i);
  });

  test("the prompt carries the VERBATIM params, never a digest", async () => {
    let seen = "";
    const srv = serverWith((p) => {
      seen = p.message;
      return Promise.resolve({ action: "decline" });
    });
    const call = registerAndGet(srv, async () => ok());
    await call({ branch: "acme/api" });
    expect(seen).toContain("repo.branch.delete");
    expect(seen).toContain("acme/api");
  });
});

describe("client-independent controls", () => {
  beforeEach(() => {
    resetConnectorModeForTests();
    setConnectorMode("standalone");
  });
  afterEach(() => {
    resetConnectorModeForTests();
  });

  test("an out-of-scope target refuses BEFORE prompting — no human is asked to allow it", async () => {
    let prompted = 0;
    const srv = serverWith(() => {
      prompted += 1;
      return Promise.resolve({ action: "accept", content: { confirm: true } });
    });
    const call = registerAndGet(srv, async () => ok(), { scope: "repo:acme/api" });
    const res = await call({ branch: "acme/other" });
    expect(prompted).toBe(0);
    expect(JSON.stringify(res)).toMatch(/out of scope/i);
  });

  test("refuseBefore refuses BEFORE scope, budget and prompt, and is audited as refused", async () => {
    const dir = await mkdtemp(join(tmpdir(), "consent-refuse-before-"));
    const log = join(dir, "audit.jsonl");
    let prompted = 0;
    let ran = 0;
    const srv = serverWith(() => {
      prompted += 1;
      return Promise.resolve({ action: "accept", content: { confirm: true } });
    });
    // Out of scope AND budget 1: the refusal still names refuseBefore's reason, so it ran first.
    const call = registerAndGet(
      srv,
      async () => {
        ran += 1;
        return ok();
      },
      {
        scope: "repo:elsewhere",
        budget: 1,
        auditLog: log,
        refuseBefore: (a) => (a.branch === "bad" ? "bad is refused" : undefined),
      },
    );
    expect(JSON.stringify(await call({ branch: "bad" }))).toContain("bad is refused");
    expect(prompted).toBe(0);
    expect(ran).toBe(0);
    const entries = (await readFile(log, "utf8"))
      .trimEnd()
      .split("\n")
      .map(
        (l) => (JSON.parse(l) as { entry: { outcome: string; detail: { reason?: string } } }).entry,
      );
    expect(entries.map((e) => [e.outcome, e.detail.reason])).toEqual([
      ["refused", "bad is refused"],
    ]);
    await rm(dir, { recursive: true, force: true });
  });

  test("refuseBefore returning undefined leaves the normal path untouched", async () => {
    let prompted = 0;
    const srv = serverWith(() => {
      prompted += 1;
      return Promise.resolve({ action: "accept", content: { confirm: true } });
    });
    let ran = 0;
    const call = registerAndGet(
      srv,
      async () => {
        ran += 1;
        return ok();
      },
      { refuseBefore: () => undefined },
    );
    await call({ branch: "acme/api" });
    expect([prompted, ran]).toEqual([1, 1]);
  });

  test("an EMPTY scope refuses every mutation — unset is not unrestricted", async () => {
    const srv = serverWith(() => Promise.resolve({ action: "accept", content: { confirm: true } }));
    const call = registerAndGet(srv, async () => ok(), { scope: undefined });
    expect(JSON.stringify(await call({ branch: "acme/api" }))).toMatch(/out of scope/i);
  });

  test("budget exhaustion takes the tool out of the list AND still refuses a call that arrives", async () => {
    let unregistered = 0;
    const srv = serverWith(() => Promise.resolve({ action: "accept", content: { confirm: true } }));
    srv.onUnregister = () => {
      unregistered += 1;
    };
    const call = registerAndGet(srv, async () => ok(), { scope: "repo:acme/api", budget: 1 });
    await call({ branch: "acme/api" });
    expect(unregistered).toBe(1);
    expect(srv.listed()).toEqual([]);
    // A client that still holds the old list reaches the handler, which refuses.
    expect(JSON.stringify(await call({ branch: "acme/api" }))).toMatch(/budget/i);
  });

  test("a spent budget refuses BEFORE prompting — no human is asked to approve the impossible", async () => {
    // The re-check after consent would keep the count right on its own; this check, before
    // consent, is what keeps a human from being asked to approve a write that cannot happen.
    let prompted = 0;
    const srv = serverWith(() => {
      prompted += 1;
      return Promise.resolve({ action: "accept", content: { confirm: true } });
    });
    const call = registerAndGet(srv, async () => ok(), { scope: "repo:acme/api", budget: 1 });
    await call({ branch: "acme/api" });
    expect(JSON.stringify(await call({ branch: "acme/api" }))).toMatch(/budget exhausted/i);
    expect(prompted).toBe(1);
  });

  test("approved calls in flight together cannot overrun the budget", async () => {
    // The server runs each request's handler as it arrives, so a client that sends several tool
    // calls without waiting has them all past the pre-consent budget check before any of them has
    // spent from it. Measured through the real argocd entry point before the fix: under a budget
    // of 1, three such approved syncs all reached the network.
    let executed = 0;
    const outcomes: string[] = [];
    const srv = serverWith(() => Promise.resolve({ action: "accept", content: { confirm: true } }));
    srv.sendLoggingMessage = (p) => {
      outcomes.push((p.data as { outcome: string }).outcome);
      return Promise.resolve();
    };
    const call = registerAndGet(
      srv,
      async () => {
        executed += 1;
        return ok();
      },
      { scope: "repo:acme/api", budget: 1 },
    );

    const answers = await Promise.all([1, 2, 3].map(() => call({ branch: "acme/api" })));

    expect(executed).toBe(1);
    expect(
      answers.filter((a) => JSON.stringify(a).includes("write budget exhausted")),
    ).toHaveLength(2);
    // All three were put to the human and approved: the budget, not the human, stopped two.
    expect(outcomes.filter((o) => o === "accepted")).toHaveLength(3);
    expect(outcomes.filter((o) => o === "refused")).toHaveLength(2);
    expect(outcomes.filter((o) => o === "executed")).toHaveLength(1);
  });

  test("a write approved after the budget ran out is refused, and the log says it was approved", async () => {
    // Two writes are put to the human together under a budget of one. The second is approved first
    // and spends the budget; the first is approved after that and must not run. Its audit entry
    // has to say the budget stopped it AFTER a human said yes, which `budget exhausted` alone
    // would not: that reason is also what a refusal before any prompt records.
    let prompts = 0;
    const approvals: Array<() => void> = [];
    let onPrompt = (): void => undefined;
    const nextPrompt = (): Promise<void> =>
      new Promise((resolve) => {
        onPrompt = () => resolve();
      });
    const approve = (i: number): void => {
      const go = approvals[i];
      if (go === undefined) throw new Error(`prompt ${String(i)} is not open`);
      go();
    };
    const srv = serverWith(() => {
      prompts += 1;
      // Only the first two writes may be put to the human, which is asserted below. A third
      // prompt is answered at once, so that failure is reported instead of waiting forever.
      if (prompts > 2) return Promise.resolve({ action: "accept", content: { confirm: true } });
      return new Promise((resolve) => {
        approvals.push(() => resolve({ action: "accept", content: { confirm: true } }));
        onPrompt();
      });
    });
    let executed = 0;
    const log = await tempAuditPath();
    const call = registerAndGet(
      srv,
      async () => {
        executed += 1;
        return ok();
      },
      { scope: "repo:acme/api", budget: 1, auditLog: log },
    );

    // Each race ends when the call's prompt opens, or when the call ends without one, so a call
    // that never prompts fails the length check below instead of stalling the test.
    let open = nextPrompt();
    const first = call({ branch: "acme/api" });
    await Promise.race([open, first]);
    open = nextPrompt();
    const second = call({ branch: "acme/api" });
    await Promise.race([open, second]);
    expect(approvals).toHaveLength(2);

    approve(1);
    expect(JSON.stringify(await second)).not.toContain("budget exhausted");
    approve(0);
    expect(JSON.stringify(await first)).toContain("write budget exhausted for this session");
    // With the budget spent, a third write is refused before anyone is asked.
    expect(JSON.stringify(await call({ branch: "acme/api" }))).toContain("write budget exhausted");

    expect(prompts).toBe(2);
    expect(executed).toBe(1);
    type Line = { entry: { outcome: string; detail: { reason?: string } } };
    const entries = (await readFile(log, "utf8"))
      .trimEnd()
      .split("\n")
      .map((l) => (JSON.parse(l) as Line).entry);
    expect(entries.map((e) => [e.outcome, e.detail.reason])).toEqual([
      ["requested", undefined],
      ["requested", undefined],
      ["accepted", undefined],
      ["executed", undefined],
      ["accepted", undefined],
      ["refused", "budget exhausted after approval"],
      ["refused", "budget exhausted"],
    ]);
    expect(await verifyAuditChain(log)).toMatchObject({ ok: true });
  });

  test("approved calls in flight together leave one intact chain in the audit log", async () => {
    // The calls' records interleave — every call is approved before any executes — and each one
    // links to the record actually written before it. They used to read the same tail and link to
    // the same predecessor, so the chain broke at the second record.
    const calls = 5;
    const log = await tempAuditPath();
    const srv = serverWith(() => Promise.resolve({ action: "accept", content: { confirm: true } }));
    const call = registerAndGet(srv, async () => ok(), { scope: "repo:acme/api", auditLog: log });

    await Promise.all(Array.from({ length: calls }, () => call({ branch: "acme/api" })));

    expect(await verifyAuditChain(log)).toEqual({ ok: true, count: calls * 3 });
    const outcomes = (await readFile(log, "utf8"))
      .trimEnd()
      .split("\n")
      .map((l) => (JSON.parse(l) as { entry: { outcome: string } }).entry.outcome);
    for (const outcome of ["requested", "accepted", "executed"]) {
      expect(outcomes.filter((o) => o === outcome)).toHaveLength(calls);
    }
  });

  test("capturePreState runs before the mutation and reaches the audit log", async () => {
    const srv = serverWith(() => Promise.resolve({ action: "accept", content: { confirm: true } }));
    const log = await tempAuditPath();
    const call = registerAndGet(srv, async () => ok(), {
      scope: "repo:acme/api",
      auditLog: log,
    });
    await call({ branch: "acme/api" });
    const text = await readFile(log, "utf8");
    expect(text).toContain('"preState"');
    expect(text).toContain("abc");
    expect(await verifyAuditChain(log)).toMatchObject({ ok: true });
  });

  test("a refusal is audited too — the log records what was NOT allowed", async () => {
    const srv = serverWith(() => Promise.resolve({ action: "decline" }));
    const log = await tempAuditPath();
    const call = registerAndGet(srv, async () => ok(), {
      scope: "repo:acme/api",
      auditLog: log,
    });
    await call({ branch: "acme/api" });
    expect(await readFile(log, "utf8")).toContain('"declined"');
  });
});

describe("empty-scope startup warning", () => {
  beforeEach(() => {
    resetConnectorModeForTests();
    setConnectorMode("standalone");
  });
  afterEach(() => {
    resetConnectorModeForTests();
  });

  test("warns on STDERR when the scope env is unset — stdout is the JSON-RPC channel", () => {
    const written: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string) => {
      written.push(String(chunk));
      return true;
    };
    try {
      process.env["NIMBUS_MCP_TEST_WRITE_SCOPE"] = "";
      createWriteToolRegistrar(
        serverWith(() => Promise.resolve({ action: "decline" })),
        {
          connector: "github",
          scopeEnv: "NIMBUS_MCP_TEST_WRITE_SCOPE",
          scopeKinds: ["repo"],
        },
      );
    } finally {
      process.stderr.write = realWrite;
    }
    expect(written.join("")).toMatch(/is unset or empty, so every write tool will refuse/);
  });

  test("does NOT warn when a scope is configured", () => {
    const written: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string) => {
      written.push(String(chunk));
      return true;
    };
    try {
      process.env["NIMBUS_MCP_TEST_WRITE_SCOPE"] = "repo:acme/api";
      createWriteToolRegistrar(
        serverWith(() => Promise.resolve({ action: "decline" })),
        {
          connector: "github",
          scopeEnv: "NIMBUS_MCP_TEST_WRITE_SCOPE",
          scopeKinds: ["repo"],
        },
      );
    } finally {
      process.stderr.write = realWrite;
    }
    expect(written.join("")).toBe("");
  });
});

describe("pre-state capture failure", () => {
  beforeEach(() => {
    resetConnectorModeForTests();
    setConnectorMode("standalone");
  });
  afterEach(() => {
    resetConnectorModeForTests();
  });

  test("a THROWING capturePreState does not block an approved mutation", async () => {
    // Refusing here would turn a transient read error into a blocked action the owner had already
    // approved. The behaviour shipped in Part 1; nothing proved it until now.
    let mutated = 0;
    const srv = serverWith(() => Promise.resolve({ action: "accept", content: { confirm: true } }));
    const log = await tempAuditPath();
    // BEFORE the registrar is constructed: it reads scope and audit-log env once, at startup, so
    // the model can never influence them mid-session. Setting them afterwards is a no-op.
    process.env["NIMBUS_MCP_TEST_WRITE_SCOPE"] = "repo:acme/api";
    process.env["NIMBUS_MCP_AUDIT_LOG"] = log;
    const reg = createWriteToolRegistrar(srv, {
      connector: "github",
      scopeEnv: "NIMBUS_MCP_TEST_WRITE_SCOPE",
      scopeKinds: ["repo"],
    });
    reg(
      "github_branch_delete",
      {
        mutates: "github.branch.delete",
        recoverable: false,
        capturePreState: () => Promise.reject(new Error("ref lookup failed")),
        scopeTargetOf: (a: { branch: string }) => ({ kind: "repo", value: a.branch }),
      },
      "Delete a branch.",
      z.object({ branch: z.string() }),
      async () => {
        mutated += 1;
        return ok();
      },
    );
    srv.handshake();
    const cb = srv.captured;
    if (cb === undefined) throw new Error("tool was not registered");
    await cb({ branch: "acme/api" });

    expect(mutated).toBe(1);
    const text = await readFile(log, "utf8");
    // The failure is RECORDED, so the audit trail says the pre-state is missing rather than
    // silently implying none was needed.
    expect(text).toContain("captureFailed");
    expect(text).toContain("ref lookup failed");
    expect(text).toContain('"executed"');
  });
});

describe("standalone outcomes at the edges", () => {
  beforeEach(() => {
    resetConnectorModeForTests();
    setConnectorMode("standalone");
  });
  afterEach(() => {
    resetConnectorModeForTests();
  });

  /** The audit entries a log holds, in order. */
  async function entries(log: string): Promise<{ outcome: string; detail: unknown }[]> {
    return (await readFile(log, "utf8"))
      .trimEnd()
      .split("\n")
      .map((l) => (JSON.parse(l) as { entry: { outcome: string; detail: unknown } }).entry);
  }

  /** Register one approved write whose pre-state capture and handler are given. */
  function registered(
    log: string,
    capture: () => Promise<Record<string, unknown>>,
    handler: () => Promise<McpListResult>,
  ): (args: unknown) => Promise<McpListResult> {
    const srv = serverWith(() => Promise.resolve({ action: "accept", content: { confirm: true } }));
    process.env["NIMBUS_MCP_TEST_WRITE_SCOPE"] = "repo:acme/api";
    process.env["NIMBUS_MCP_AUDIT_LOG"] = log;
    const reg = createWriteToolRegistrar(srv, {
      connector: "github",
      scopeEnv: "NIMBUS_MCP_TEST_WRITE_SCOPE",
      scopeKinds: ["repo"],
    });
    reg(
      "github_branch_delete",
      {
        mutates: "github.branch.delete",
        recoverable: false,
        capturePreState: capture,
        scopeTargetOf: (a: { branch: string }) => ({ kind: "repo", value: a.branch }),
      },
      "Delete a branch.",
      z.object({ branch: z.string() }),
      handler,
    );
    srv.handshake();
    const cb = srv.captured;
    if (cb === undefined) throw new Error("tool was not registered");
    return cb;
  }

  test("a pre-state capture that rejects with a non-Error still records why", async () => {
    const log = await tempAuditPath();
    const call = registered(
      log,
      () => Promise.reject("ref service unavailable"),
      () => Promise.resolve(ok()),
    );
    await call({ branch: "acme/api" });
    const executed = (await entries(log)).find((e) => e.outcome === "executed");
    expect(executed?.detail).toEqual({
      target: { kind: "repo", value: "acme/api" },
      preState: { captureFailed: "ref service unavailable" },
    });
  });

  test("a mutation that throws a non-Error is audited as failed and still rejects", async () => {
    const log = await tempAuditPath();
    const call = registered(
      log,
      () => Promise.resolve({ sha: "abc" }),
      () => Promise.reject("remote said no"),
    );
    // The tool's own text reaches the client, whatever kind of value was thrown.
    await expect(call({ branch: "acme/api" })).rejects.toThrow("remote said no");
    const all = await entries(log);
    expect(all.map((e) => e.outcome)).toEqual(["requested", "accepted", "failed"]);
    expect(all[2]?.detail).toEqual({
      target: { kind: "repo", value: "acme/api" },
      preState: { sha: "abc" },
      error: "remote said no",
    });
  });

  test("a write whose audit entry cannot be written is never put to the human, and never runs", async () => {
    // The durable log is the operator's record of every write. If its first entry cannot land —
    // here the log's directory does not exist — the write must not go ahead unrecorded.
    let prompted = 0;
    let mutated = 0;
    const srv = serverWith(() => {
      prompted += 1;
      return Promise.resolve({ action: "accept", content: { confirm: true } });
    });
    const call = registerAndGet(
      srv,
      async () => {
        mutated += 1;
        return ok();
      },
      { auditLog: join(dirname(await tempAuditPath()), "missing", "audit.jsonl") },
    );
    await expect(call({ branch: "acme/api" })).rejects.toThrow(/ENOENT/);
    expect(prompted).toBe(0);
    expect(mutated).toBe(0);
  });

  test("each record is in the durable log before the client is told of it", async () => {
    // The second channel of a record (a client log message in gateway mode, a stderr line in
    // standalone mode) can fail, and can be the last thing the process does. So the durable append
    // comes first, and the second channel never precedes the line it reports.
    const log = await tempAuditPath();
    const seen: { outcome: string; lastLogged: string | undefined }[] = [];
    const srv = serverWith(() => Promise.resolve({ action: "accept", content: { confirm: true } }));
    srv.sendLoggingMessage = async (p) => {
      const lines = (await readFile(log, "utf8").catch(() => "")).trimEnd().split("\n");
      const last = lines.at(-1);
      seen.push({
        outcome: (p.data as { outcome: string }).outcome,
        lastLogged:
          last === undefined || last === ""
            ? undefined
            : (JSON.parse(last) as { entry: { outcome: string } }).entry.outcome,
      });
    };
    const call = registerAndGet(srv, async () => ok(), { auditLog: log });
    await call({ branch: "acme/api" });
    expect(seen).toEqual(
      ["requested", "accepted", "executed"].map((o) => ({ outcome: o, lastLogged: o })),
    );
  });

  test("a client that has gone away cannot keep a write's records out of the durable log", async () => {
    // Every send rejects, as one does once the transport is closed. The write still runs, and its
    // records all land: the client channel is best effort, the durable log is not.
    const log = await tempAuditPath();
    let mutated = 0;
    const srv = serverWith(() => Promise.resolve({ action: "accept", content: { confirm: true } }));
    srv.sendLoggingMessage = () => Promise.reject(new Error("Not connected"));
    const call = registerAndGet(
      srv,
      async () => {
        mutated += 1;
        return ok();
      },
      { auditLog: log },
    );
    await call({ branch: "acme/api" });
    expect(mutated).toBe(1);
    const outcomes = (await readFile(log, "utf8"))
      .trimEnd()
      .split("\n")
      .map((l) => (JSON.parse(l) as { entry: { outcome: string } }).entry.outcome);
    expect(outcomes).toEqual(["requested", "accepted", "executed"]);
  });

  test("a write that ran is not recorded as failed when recording that it ran fails", async () => {
    // Recording `executed` shared the mutation's `catch`, so a failure to append it was recorded
    // as the mutation failing — of a write that had in fact run. Here the mutation itself leaves
    // the log with a last line nothing can be linked after, so that one append fails.
    const log = await tempAuditPath();
    const outcomes: string[] = [];
    let mutated = 0;
    const srv = serverWith(() => Promise.resolve({ action: "accept", content: { confirm: true } }));
    srv.sendLoggingMessage = (p) => {
      outcomes.push((p.data as { outcome: string }).outcome);
      return Promise.resolve();
    };
    const call = registerAndGet(
      srv,
      async () => {
        mutated += 1;
        await appendFile(log, "torn\n");
        return ok();
      },
      { auditLog: log },
    );
    await expect(call({ branch: "acme/api" })).rejects.toThrow(
      "github_branch_delete ran, but recording that it ran failed: ",
    );
    expect(mutated).toBe(1);
    // The logging channel is told of every record attempted, after the durable log has had its
    // turn, the one whose append failed included: `executed`, and never `failed`.
    expect(outcomes).toEqual(["requested", "accepted", "executed"]);
    // Nothing was appended after the line the mutation left: in particular, no `failed`.
    const lines = (await readFile(log, "utf8")).trimEnd().split("\n");
    expect(lines.at(-1)).toBe("torn");
    expect(
      lines
        .slice(0, -1)
        .map((l) => (JSON.parse(l) as { entry: { outcome: string } }).entry.outcome),
    ).toEqual(["requested", "accepted"]);
  });

  test("a write that fails, and whose failure cannot be recorded, still reports its own error", async () => {
    // A tool that threw may have changed something before it did. When recording `failed` failed
    // as well, its error replaced the tool's, and the caller saw only that the audit log could not
    // be written — which reads as a write that never started, and so as one safe to try again.
    // Here the tool leaves the log with a last line nothing can be linked after, then throws.
    const log = await tempAuditPath();
    const outcomes: string[] = [];
    const srv = serverWith(() => Promise.resolve({ action: "accept", content: { confirm: true } }));
    srv.sendLoggingMessage = (p) => {
      outcomes.push((p.data as { outcome: string }).outcome);
      return Promise.resolve();
    };
    const toolError = new Error("the branch was deleted, but the follow-up comment failed");
    const call = registerAndGet(
      srv,
      async () => {
        await appendFile(log, "torn\n");
        throw toolError;
      },
      { auditLog: log },
    );
    let thrown: unknown;
    await call({ branch: "acme/api" }).catch((e: unknown) => {
      thrown = e;
    });
    expect(thrown).toBeInstanceOf(Error);
    const { message } = thrown as Error;
    expect(message).toStartWith(
      "github_branch_delete failed: the branch was deleted, but the follow-up comment failed. " +
        "Recording that failure also failed: ",
    );
    expect(message).toContain("is not a chained entry");
    // The failure was attempted, and nothing landed after the line the tool left.
    expect(outcomes).toEqual(["requested", "accepted", "failed"]);
    expect((await readFile(log, "utf8")).trimEnd().split("\n").at(-1)).toBe("torn");
  });
});

describe("NIMBUS_MCP_WRITE_BUDGET at the registrar", () => {
  beforeEach(() => {
    resetConnectorModeForTests();
    setConnectorMode("standalone");
  });
  afterEach(() => {
    resetConnectorModeForTests();
  });

  /** Approved writes attempted in every case: more than the default, so an uncapped run shows. */
  const ATTEMPTS = 25;

  type BudgetRun =
    | { readonly startup: "ok"; readonly executed: number }
    | { readonly startup: "refused"; readonly executed: 0; readonly error: string };

  /**
   * Start a standalone registrar with the budget variable set to `raw` (removed when undefined),
   * make `ATTEMPTS` approved calls to one write tool, one after another, and count the ones that
   * reached the mutation. A registrar that refuses to start has allowed none.
   */
  async function runUnderBudget(raw: string | undefined): Promise<BudgetRun> {
    if (raw === undefined) delete process.env[WRITE_BUDGET_ENV];
    else process.env[WRITE_BUDGET_ENV] = raw;
    process.env["NIMBUS_MCP_TEST_WRITE_SCOPE"] = "repo:acme/api";
    delete process.env["NIMBUS_MCP_AUDIT_LOG"];

    const srv = serverWith(() => Promise.resolve({ action: "accept", content: { confirm: true } }));
    let reg: WriteToolRegistrar;
    try {
      reg = createWriteToolRegistrar(srv, {
        connector: "github",
        scopeEnv: "NIMBUS_MCP_TEST_WRITE_SCOPE",
        scopeKinds: ["repo"],
      });
    } catch (e) {
      return { startup: "refused", executed: 0, error: e instanceof Error ? e.message : String(e) };
    }
    let executed = 0;
    reg("github_branch_delete", cfgFor(), "Delete a branch.", schema, async () => {
      executed += 1;
      return ok();
    });
    srv.handshake();
    const cb = srv.captured;
    if (cb === undefined) throw new Error("tool was not registered");
    for (let i = 0; i < ATTEMPTS; i += 1) {
      await cb({ branch: "acme/api" });
    }
    return { startup: "ok", executed };
  }

  test("unset allows exactly the default", async () => {
    expect(await runUnderBudget(undefined)).toEqual({
      startup: "ok",
      executed: DEFAULT_WRITE_BUDGET,
    });
  });

  test("an empty or whitespace-only value refuses to start — never the default", async () => {
    // Read with `Number()`, a blank budget allowed no writes at all. Read as unset, it would allow
    // the default ten; the registrar must refuse it instead, so it still allows none.
    for (const raw of ["", "  "]) {
      expect(await runUnderBudget(raw)).toEqual({
        startup: "refused",
        executed: 0,
        error: expect.stringContaining(WRITE_BUDGET_ENV),
      });
    }
  });

  test.each([
    ["0", 0],
    ["3", 3],
    [" 3 ", 3],
    ["25", 25],
  ])("%p allows %d", async (raw, n) => {
    expect(await runUnderBudget(raw)).toEqual({ startup: "ok", executed: n });
  });

  // `abc`, `ten` and `Infinity` are the values measured allowing all 25 of 25 approved argocd
  // syncs when the budget was read with `Number()`; the rest ran under a cap nobody wrote. The two
  // digits from other scripts are ones `Number()` reads as NaN, should the parser ever let one by.
  test.each([
    "abc",
    "ten",
    "Infinity",
    "NaN",
    "-1",
    "1.5",
    "1e3",
    "0x10",
    "9007199254740992",
    "1e309",
    String.fromCodePoint(0x0665),
    String.fromCodePoint(0xff15),
  ])(
    "%p cannot allow more writes than the default: the registrar refuses to start",
    async (raw) => {
      const run = await runUnderBudget(raw);
      // The property itself, independent of how it is delivered...
      expect(run.executed).toBeLessThanOrEqual(DEFAULT_WRITE_BUDGET);
      // ...and the delivery: the connector stops at startup with an error naming the variable.
      expect(run).toEqual({
        startup: "refused",
        executed: 0,
        error: expect.stringContaining(WRITE_BUDGET_ENV),
      });
    },
  );
});

describe("prepare tool registrar", () => {
  beforeEach(() => {
    resetConnectorModeForTests();
  });
  afterEach(() => {
    resetConnectorModeForTests();
  });

  /** The upstream-shaped server of a gateway-mode connector, keeping each handler by name. */
  function gatewayMulti(): GatewayConsentServer & {
    handlers: Map<string, Handler>;
    prompts: { count: number };
  } {
    const handlers = new Map<string, Handler>();
    return {
      handlers,
      prompts: { count: 0 },
      registerTool: (name: string, _config: unknown, cb: Handler) => {
        handlers.set(name, cb);
        return { disable: () => handlers.delete(name) };
      },
      tool: () => undefined,
      sendLoggingMessage: () => Promise.resolve(),
    };
  }

  /** The standalone server, for a client that approves every prompt. */
  function multiServer(): FakeServer {
    return serverWith(() => Promise.resolve({ action: "accept", content: { confirm: true } }));
  }

  const prepCfg = {
    scopeTargetOf: (a: { branch: string }) => ({ kind: "repo", value: a.branch }),
  };

  function kit(
    srv: ConsentServer,
    scope: string | undefined,
    opts: { budget?: string; auditLog?: string } = {},
  ) {
    if (scope === undefined) delete process.env["NIMBUS_MCP_TEST_WRITE_SCOPE"];
    else process.env["NIMBUS_MCP_TEST_WRITE_SCOPE"] = scope;
    if (opts.budget === undefined) delete process.env["NIMBUS_MCP_WRITE_BUDGET"];
    else process.env["NIMBUS_MCP_WRITE_BUDGET"] = opts.budget;
    if (opts.auditLog === undefined) delete process.env["NIMBUS_MCP_AUDIT_LOG"];
    else process.env["NIMBUS_MCP_AUDIT_LOG"] = opts.auditLog;
    const cfg = {
      connector: "github",
      scopeEnv: "NIMBUS_MCP_TEST_WRITE_SCOPE",
      scopeKinds: ["repo"],
    };
    return {
      registerPrepareTool: createPrepareToolRegistrar(srv, cfg),
      registerWriteTool: createWriteToolRegistrar(srv, cfg),
    };
  }

  test("a name that is not in PREPARE_TOOL_IDS throws at registration", () => {
    setConnectorMode("gateway");
    const srv = gatewayMulti();
    const { registerPrepareTool } = kit(srv, undefined);
    expect(() =>
      registerPrepareTool("github_files_get", prepCfg, "d", schema, async () => ok()),
    ).toThrow(/not a listed prepare tool/);
    expect(srv.handlers.size).toBe(0);
  });

  test("gateway mode registers the raw handler and records nothing", async () => {
    setConnectorMode("gateway");
    const log = await tempAuditPath();
    const srv = gatewayMulti();
    const { registerPrepareTool } = kit(srv, undefined, { auditLog: log });
    registerPrepareTool("github_commit_prepare", prepCfg, "d", schema, async () => ok());
    const cb = srv.handlers.get("github_commit_prepare");
    expect(cb).toBeDefined();
    await cb?.({ branch: "acme/api" });
    expect(await readFile(log, "utf8").catch(() => "")).toBe("");
    expect(srv.prompts.count).toBe(0);
  });

  test("standalone with an empty scope refuses before the handler, names the target and audits it", async () => {
    setConnectorMode("standalone");
    const log = await tempAuditPath();
    const srv = multiServer();
    const { registerPrepareTool } = kit(srv, undefined, { auditLog: log });
    let calls = 0;
    registerPrepareTool("github_commit_prepare", prepCfg, "d", schema, async () => {
      calls += 1;
      return ok();
    });
    // Registered for EVERY client: no handshake, no elicitation capability needed.
    const cb = srv.handlers.get("github_commit_prepare");
    if (cb === undefined) throw new Error("not registered");
    const res = await cb({ branch: "acme/api" });
    expect(calls).toBe(0);
    expect(JSON.stringify(res)).toContain("out of scope: repo:acme/api");
    const lines = (await readFile(log, "utf8")).trim().split("\n");
    expect(
      lines.map((l) => (JSON.parse(l) as { entry: { outcome: string } }).entry.outcome),
    ).toEqual(["refused"]);
  });

  test("standalone in scope runs the handler, records prepared and never prompts", async () => {
    setConnectorMode("standalone");
    const log = await tempAuditPath();
    const srv = multiServer();
    const { registerPrepareTool } = kit(srv, "repo:acme/api", { auditLog: log });
    let calls = 0;
    registerPrepareTool("github_commit_prepare", prepCfg, "d", schema, async () => {
      calls += 1;
      return ok();
    });
    const cb = srv.handlers.get("github_commit_prepare");
    if (cb === undefined) throw new Error("not registered");
    await cb({ branch: "acme/api" });
    expect(calls).toBe(1);
    expect(srv.prompts.count).toBe(0);
    const entries = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((l) => (JSON.parse(l) as { entry: { outcome: string; tool: string } }).entry);
    expect(entries.map((e) => `${e.tool}:${e.outcome}`)).toEqual([
      "github_commit_prepare:prepared",
    ]);
    expect((await verifyAuditChain(log)).ok).toBe(true);
  });

  test("a prepare handler that throws is audited as failed and the error is rethrown", async () => {
    setConnectorMode("standalone");
    const log = await tempAuditPath();
    const srv = multiServer();
    const { registerPrepareTool } = kit(srv, "repo:acme/api", { auditLog: log });
    registerPrepareTool("github_commit_prepare", prepCfg, "d", schema, async () => {
      throw new Error("GitHub 500: boom");
    });
    const cb = srv.handlers.get("github_commit_prepare");
    if (cb === undefined) throw new Error("not registered");
    await expect(cb({ branch: "acme/api" })).rejects.toThrow("GitHub 500: boom");
    const entries = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map(
        (l) =>
          (JSON.parse(l) as { entry: { outcome: string; detail: Record<string, unknown> } }).entry,
      );
    expect(entries.map((e) => e.outcome)).toEqual(["failed"]);
    expect(entries[0]?.detail["error"]).toBe("GitHub 500: boom");
    expect(entries[0]?.detail["target"]).toEqual({ kind: "repo", value: "acme/api" });
    expect((await verifyAuditChain(log)).ok).toBe(true);
  });

  test("a prepare that throws, whose failure cannot be recorded, still leads with its own error", async () => {
    setConnectorMode("standalone");
    const dir = await mkdtemp(join(tmpdir(), "nimbus-consent-"));
    tempDirs.push(dir);
    const srv = multiServer();
    // A log path whose parent is a regular file cannot be appended to.
    const blocker = join(dir, "blocker");
    await appendFile(blocker, "x");
    const { registerPrepareTool } = kit(srv, "repo:acme/api", {
      auditLog: join(blocker, "audit.jsonl"),
    });
    registerPrepareTool("github_commit_prepare", prepCfg, "d", schema, async () => {
      throw new Error("GitHub 500: boom");
    });
    const cb = srv.handlers.get("github_commit_prepare");
    if (cb === undefined) throw new Error("not registered");
    await expect(cb({ branch: "acme/api" })).rejects.toThrow(
      /github_commit_prepare failed: GitHub 500: boom/,
    );
  });

  test("prepares spend no write budget: budget 1, two prepares and one write all succeed", async () => {
    setConnectorMode("standalone");
    const srv = multiServer();
    const { registerPrepareTool, registerWriteTool } = kit(srv, "repo:acme/api", {
      budget: "1",
    });
    let prepared = 0;
    let wrote = 0;
    registerPrepareTool("github_commit_prepare", prepCfg, "d", schema, async () => {
      prepared += 1;
      return ok();
    });
    registerWriteTool("github_branch_delete", cfgFor(), "d", schema, async () => {
      wrote += 1;
      return ok();
    });
    srv.handshake();
    const prepare = srv.handlers.get("github_commit_prepare");
    const write = srv.handlers.get("github_branch_delete");
    if (prepare === undefined || write === undefined) throw new Error("not registered");
    await prepare({ branch: "acme/api" });
    await prepare({ branch: "acme/api" });
    await write({ branch: "acme/api" });
    expect(prepared).toBe(2);
    expect(wrote).toBe(1);
    // The write spent the only unit and the write tool left the listing; the prepare tool stays.
    expect(srv.listed()).toEqual(["github_commit_prepare"]);
    // And it stays callable: a third prepare runs.
    await prepare({ branch: "acme/api" });
    expect(prepared).toBe(3);
  });
});
