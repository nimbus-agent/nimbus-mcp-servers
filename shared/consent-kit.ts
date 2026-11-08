import type { McpListResult, ZodObjectSchema } from "@nimbus-dev/sdk/connector-kit";

import { type AuditOutcome, appendAuditEntry } from "./audit-chain.ts";
import { getConnectorMode } from "./connector-mode.ts";
import { isPrepareToolId } from "./prepare-tool-ids.ts";
import { createWriteBudget, parseWriteBudget, WRITE_BUDGET_ENV } from "./write-budget.ts";
import { parseWriteScope, type ScopeTerm, scopeAllows } from "./write-scope.ts";

/** The subset of the SDK's `RegisteredTool` this kit needs. */
export type ToolHandle = { disable(): void };

/**
 * The structural subset of `McpServer` the consent kit uses.
 *
 * Narrowed deliberately so tests can supply a fake without a transport, and so the kit's real
 * dependencies are visible in one place.
 */
export type ConsentServer = {
  readonly server: {
    getClientCapabilities(): { elicitation?: unknown } | undefined;
    /** Fired after the client's `initialize` — the FIRST moment capabilities are knowable. */
    oninitialized?: (() => void) | undefined;
    /**
     * `requestedSchema` is typed to the restricted JSON-Schema subset the MCP spec allows, not
     * `Record<string, unknown>`. The loose form does not satisfy the real `McpServer.elicitInput`,
     * which is only discoverable by passing a real server — a hand-written fake accepts anything.
     */
    elicitInput(
      params: {
        mode: "form";
        message: string;
        requestedSchema: {
          type: "object";
          properties: Record<
            string,
            { type: "boolean"; title?: string; description?: string; default?: boolean }
          >;
          required?: string[];
        };
      },
      options?: { timeout?: number },
    ): Promise<{
      action: "accept" | "decline" | "cancel";
      content?: Record<string, unknown> | undefined;
    }>;
  };
  /**
   * `inputSchema` is `unknown` on purpose. The real signature wants the SDK's
   * `ZodRawShapeCompat | AnySchema`, and the connector kit's `ZodObjectSchema["shape"]` is
   * `Record<string, unknown>` — neither is assignable to the other, so a concrete type here makes
   * a real `McpServer` fail to satisfy this interface. The value is passed straight through and
   * never inspected by this kit.
   */
  registerTool(
    name: string,
    config: { description?: string; inputSchema?: unknown },
    cb: (args: unknown) => Promise<McpListResult>,
  ): ToolHandle;
  sendToolListChanged(): void;
  sendLoggingMessage(params: { level: "info" | "warning"; data: unknown }): Promise<void>;
};

/**
 * What a connector with write tools constructs its `McpServer` with:
 * `new McpServer(info, { capabilities: CONSENT_SERVER_CAPABILITIES })`.
 *
 * The kit tells the client about every gated outcome with `notifications/message`, and the SDK
 * sends that only for a server that declared the MCP `logging` capability. No connector did, so
 * each notification was dropped without a word. It must be declared at construction: that is the
 * only moment the SDK installs its `logging/setLevel` handler, and a server that declared the
 * capability later would refuse a client setting the level. `scripts/connector-boot.test.ts`
 * fails a connector whose manifest declares a write and whose booted server does not declare it.
 */
export const CONSENT_SERVER_CAPABILITIES = { logging: {} };

export type WriteToolConfig<T> = {
  /** Action type this tool performs, e.g. "repo.branch.delete". Machine-readable, not prose. */
  readonly mutates: string;
  /** False when the mutation cannot be undone — which is when pre-state capture is mandatory. */
  readonly recoverable: boolean;
  /** Required when `recoverable` is false. Runs BEFORE the mutation; result is audited verbatim. */
  readonly capturePreState?: (args: T) => Promise<Record<string, unknown>>;
  /** The scope target this invocation would touch, checked against the allow-list. */
  readonly scopeTargetOf: (args: T) => { kind: string; value: string };
  /**
   * A refusal no consent can lift (an input the tool will reject, a tool that is refused outright),
   * as its message, or `undefined` to proceed. Standalone only, and checked FIRST, before scope,
   * budget and prompt: asking a human to approve a call that is certain to fail trains them to
   * click through. It does NOT replace the handler's own check: in gateway mode the raw handler is
   * registered and this is never called, so the handler must refuse the same input itself.
   */
  readonly refuseBefore?: (args: T) => string | undefined;
};

export type WriteToolRegistrar = <T>(
  name: string,
  cfg: WriteToolConfig<T>,
  description: string,
  schema: ZodObjectSchema<T>,
  handler: (args: T) => Promise<McpListResult>,
) => void;

function refused(why: string): McpListResult {
  return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: why }) }] };
}

/** The message of whatever was thrown, which need not be an `Error`. */
function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Ask the human, through the client, and report whether they said yes.
 *
 * The prompt carries the VERBATIM operation and resolved parameters, never a digest — a digest is
 * a rubber stamp with extra steps, and the human is the entire trust boundary here.
 */
async function consented(
  server: ConsentServer,
  mutates: string,
  params: unknown,
): Promise<boolean> {
  let res: { action: string; content?: Record<string, unknown> | undefined };
  try {
    res = await server.server.elicitInput({
      mode: "form",
      message:
        `Nimbus is about to perform ${mutates} with:\n` +
        `${JSON.stringify(params, null, 2)}\n\nApprove?`,
      requestedSchema: {
        type: "object",
        properties: {
          confirm: { type: "boolean", title: "Approve this action", description: mutates },
        },
        required: ["confirm"],
      },
    });
  } catch {
    // Timeout, transport failure, or a client that rejects the request: fail CLOSED.
    return false;
  }
  // `action: "accept"` alone is not consent — the form's own answer must also be true, so a client
  // that auto-accepts without answering the question does not clear the gate.
  return res.action === "accept" && res.content?.["confirm"] === true;
}

function registerOn<T>(
  server: ConsentServer,
  name: string,
  description: string,
  schema: ZodObjectSchema<T>,
  handler: (args: T) => Promise<McpListResult>,
  handles: ToolHandle[],
): void {
  const handle = server.registerTool(
    name,
    { description, inputSchema: schema.shape },
    async (args: unknown): Promise<McpListResult> => {
      const parsed = schema.safeParse(args);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }
      return handler(parsed.data);
    },
  );
  // Collected so budget exhaustion can disable every write tool at once.
  handles.push(handle);
}

/** What both registrars share: the parsed write scope and the audit/log record. */
type ConsentContext = {
  readonly scope: readonly ScopeTerm[];
  readonly record: (
    tool: string,
    outcome: AuditOutcome,
    detail: Record<string, unknown>,
  ) => Promise<void>;
};

type RegistrarConfig = {
  readonly connector: string;
  readonly scopeEnv: string;
  /**
   * Scope kinds this connector accepts. Declared once per connector rather than per tool: the
   * allow-list is parsed at registrar construction, before any tool has registered, so a
   * per-tool declaration would arrive too late to validate the env value.
   */
  readonly scopeKinds: readonly string[];
};

/**
 * The scope parse and the record function, built once per registrar. Extracted (not copied) so the
 * write registrar and the prepare registrar cannot drift apart on what a scope term means or on
 * which channels a record reaches.
 */
function createConsentContext(server: ConsentServer, cfg: RegistrarConfig): ConsentContext {
  const scope = parseWriteScope(process.env[cfg.scopeEnv], cfg.scopeKinds);
  const auditLog = process.env["NIMBUS_MCP_AUDIT_LOG"];

  async function record(
    tool: string,
    outcome: AuditOutcome,
    detail: Record<string, unknown>,
  ): Promise<void> {
    try {
      // Durable channel first: only when the operator configured a path. An append that fails
      // rejects, and every record before the mutation is awaited, so a write whose entry did not
      // land never runs.
      if (auditLog !== undefined && auditLog !== "") {
        await appendAuditEntry(auditLog, {
          ts: new Date().toISOString(),
          connector: cfg.connector,
          tool,
          outcome,
          detail,
        });
      }
    } finally {
      // Then the client-visible channel, told of every record attempted, one whose append failed
      // included. It reaches the client because the connector declared the MCP `logging`
      // capability (CONSENT_SERVER_CAPABILITIES), and a client may filter it by level. Best
      // effort, and after the durable log: a client that has gone away mid-write must not keep the
      // `executed` or `failed` record of a write that ran out of the log, and since the capability
      // made this channel live, a dead pipe is where a send now fails.
      await server
        .sendLoggingMessage({
          level: outcome === "executed" ? "info" : "warning",
          data: { connector: cfg.connector, tool, outcome },
        })
        .catch(() => undefined);
    }
  }

  return { scope, record };
}

/**
 * Build a connector's write-tool registrar.
 *
 * In `"gateway"` mode the raw handler is registered immediately: `executor.ts` (I2) is the gate
 * there, client capabilities are irrelevant, and the connector adds nothing.
 *
 * In `"standalone"` mode registration is QUEUED and flushed on `oninitialized`, because client
 * capabilities are not knowable at module scope — verified against the real SDK, where
 * `getClientCapabilities()` returns `undefined` before `initialize`. Deciding at registration time
 * would register nothing, for every client, forever.
 */
export function createWriteToolRegistrar(
  server: ConsentServer,
  cfg: RegistrarConfig,
): WriteToolRegistrar {
  const handles: ToolHandle[] = [];
  const pending: Array<() => void> = [];
  let flushed = false;

  const { scope, record } = createConsentContext(server, cfg);
  // Throws on a value that is not plain digits, an empty one included, as the scope parse above
  // does on a malformed term: read with `Number()`, `abc` became NaN, which `remaining <= 0` never
  // refused.
  const budget = createWriteBudget(parseWriteBudget(process.env[WRITE_BUDGET_ENV]));

  /**
   * Take one unit of budget if any is left. Spending the last unit disables every write tool and
   * tells the client.
   *
   * Nothing may be awaited between the check and the decrement, which is why both are the one
   * synchronous call `budget.take()`. Calls run concurrently (the SDK starts each request's
   * handler as it arrives), and with an await between the two every call in flight passed the
   * check before any of them spent: three approved calls all mutated under a budget of one.
   */
  function spendOne(): boolean {
    if (!budget.take()) return false;
    if (!budget.hasLeft()) {
      for (const h of handles) h.disable();
      server.sendToolListChanged();
    }
    return true;
  }

  /**
   * The refusal for a spent budget, worded the same for the client at both places it is checked.
   * The audit reason tells them apart: `budget exhausted after approval` follows an `accepted`
   * entry, because the budget ran out while that write's prompt was open.
   */
  async function budgetExhausted(
    tool: string,
    target: { kind: string; value: string },
    reason: "budget exhausted" | "budget exhausted after approval",
  ): Promise<McpListResult> {
    await record(tool, "refused", { reason, target });
    return refused("write budget exhausted for this session");
  }

  /**
   * Decide the write surface, once, at the first moment client capabilities are knowable.
   *
   * Default-DENY: if the client cannot prompt a human, the queued tools are dropped and never
   * appear in `tools/list` at all. Refusing at call time instead would still advertise a tool the
   * model must not use.
   */
  function flushWriteTools(): void {
    if (flushed) return;
    flushed = true;
    const caps = server.server.getClientCapabilities();
    if (caps?.elicitation === undefined) {
      pending.length = 0;
      return;
    }
    for (const register of pending) register();
    pending.length = 0;
    // The tool list changed after `initialize`, so the client must be told to re-read it.
    if (handles.length > 0) server.sendToolListChanged();
  }

  if (getConnectorMode() === "standalone") {
    // An empty scope denies every mutation, which is the correct default but looks identical to a
    // broken connector from the outside. Say so on stderr — safe for a stdio server, whose
    // PROTOCOL channel is stdout; writing this to stdout would corrupt the JSON-RPC stream.
    if (scope.length === 0) {
      process.stderr.write(
        `nimbus-connector ${cfg.connector}: ${cfg.scopeEnv} is unset or empty, so every write tool ` +
          `will refuse. Set it to a comma-separated list of ${cfg.scopeKinds.join("|")}:value ` +
          "terms to enable writes.\n",
      );
    }
    // Chain rather than overwrite: another module may already own this hook, and clobbering it
    // would silently disable whatever it did.
    const prev = server.server.oninitialized;
    server.server.oninitialized = (): void => {
      prev?.();
      flushWriteTools();
    };
  }

  return <T>(
    name: string,
    toolCfg: WriteToolConfig<T>,
    description: string,
    schema: ZodObjectSchema<T>,
    handler: (args: T) => Promise<McpListResult>,
  ): void => {
    // Checked at REGISTRATION, not on first call: a missing capture on a destructive tool is a
    // programming error, and it must surface at boot rather than on the one call that needed it.
    if (!toolCfg.recoverable && toolCfg.capturePreState === undefined) {
      throw new Error(
        `${name}: capturePreState is required when recoverable is false — an unrecoverable ` +
          "mutation must record enough pre-state to be undone",
      );
    }

    if (getConnectorMode() === "gateway") {
      registerOn(server, name, description, schema, handler, handles);
      return;
    }

    const guarded = async (args: T): Promise<McpListResult> => {
      const target = toolCfg.scopeTargetOf(args);

      // 0. A refusal no consent can lift comes before everything that could involve a human.
      const early = toolCfg.refuseBefore?.(args);
      if (early !== undefined) {
        await record(name, "refused", { reason: early, target });
        return refused(early);
      }

      // 1. SCOPE FIRST — before prompting. Asking a human to approve something the operator
      //    already forbade cannot change the outcome, and training people to click through
      //    prompts that do not matter is how you make the prompts that do matter ineffective.
      if (!scopeAllows(scope, target.kind, target.value)) {
        await record(name, "refused", { reason: "out of scope", target });
        return refused(`out of scope: ${target.kind}:${target.value} is not in ${cfg.scopeEnv}`);
      }

      // 2. BUDGET — same reasoning: a refusal that consent cannot lift comes before consent. Not
      //    the last word on the budget, though: see step 4.
      if (!budget.hasLeft()) return budgetExhausted(name, target, "budget exhausted");

      // 3. CONSENT.
      await record(name, "requested", { target, params: args });
      if (!(await consented(server, toolCfg.mutates, args))) {
        await record(name, "declined", { target });
        return refused("not approved: the operation was declined, cancelled, or timed out");
      }
      await record(name, "accepted", { target });

      // 4. SPEND — the budget checked AGAIN, and decremented in the same synchronous step: every
      //    call in flight passed step 2 before any of them got this far, so step 2 alone cannot
      //    hold the cap (see `spendOne`). Spent BEFORE the mutation so a throwing one still
      //    consumes budget — otherwise a failing destructive tool could be retried without limit.
      if (!spendOne()) return budgetExhausted(name, target, "budget exhausted after approval");

      // 5. PRE-STATE — after approval, before the mutation, so an unrecoverable action leaves a
      //    record of what it destroyed. Capture failure is NOT fatal: refusing here would turn a
      //    transient read error into a blocked action the owner already approved.
      let preState: Record<string, unknown> = {};
      if (toolCfg.capturePreState !== undefined) {
        try {
          preState = await toolCfg.capturePreState(args);
        } catch (e) {
          preState = { captureFailed: messageOf(e) };
        }
      }

      // 6. MUTATE.
      let result: McpListResult;
      try {
        result = await handler(args);
      } catch (e) {
        // A tool that threw may still have changed something first. If recording the failure fails
        // too, the tool's own error still leads what the call reports: an audit error alone reads
        // as a write that never started, and so as one that is safe to try again.
        try {
          await record(name, "failed", { target, preState, error: messageOf(e) });
        } catch (error_) {
          throw new Error(
            `${name} failed: ${messageOf(e)}. Recording that failure also failed: ${messageOf(error_)}`,
            { cause: e },
          );
        }
        throw e;
      }
      // Outside the `try`: the mutation has happened, so a failure to RECORD it must not be
      // recorded as the mutation failing, which it was when both shared one `catch`. The call still
      // rejects, saying the write ran, so it is not taken for one that is safe to try again.
      try {
        await record(name, "executed", { target, preState });
      } catch (e) {
        throw new Error(`${name} ran, but recording that it ran failed: ${messageOf(e)}`, {
          cause: e,
        });
      }
      return result;
    };

    pending.push(() => {
      registerOn(server, name, description, schema, guarded, handles);
    });
  };
}

/** What a prepare tool declares: only the scope target, since it mutates nothing. */
export type PrepareToolConfig<T> = {
  /** The scope target this invocation reads on behalf of, checked against the allow-list. */
  readonly scopeTargetOf: (args: T) => { kind: string; value: string };
};

export type PrepareToolRegistrar = <T>(
  name: string,
  cfg: PrepareToolConfig<T>,
  description: string,
  schema: ZodObjectSchema<T>,
  handler: (args: T) => Promise<McpListResult>,
) => void;

/**
 * Build a connector's prepare-tool registrar.
 *
 * A prepare tool reads the state a write is bound to (the head a commit is prepared against) and is
 * called by the gateway BEFORE the write's approval prompt. It is not a write: it is registered
 * under its own registrar so the gateway's manifest scan, which follows the write registrar's data
 * flow, does not list it as one. And it is not an ordinary read either: a tool is accepted only when
 * its name is in {@link PREPARE_TOOL_IDS} (shared/prepare-tool-ids.ts), so the class is one literal
 * list and not a naming convention.
 *
 * In `"gateway"` mode the raw handler is registered: the executor's prepare step is the gate there.
 * In `"standalone"` mode it is registered at once for EVERY client (a prepare tool prompts no one,
 * so no elicitation capability is needed), behind the same write scope as the writes it serves, and
 * each in-scope run is audited as `prepared`. It spends no write budget and is never disabled by
 * the budget running out: a second prompt before the apply prompt would only train click-through.
 */
export function createPrepareToolRegistrar(
  server: ConsentServer,
  cfg: RegistrarConfig,
): PrepareToolRegistrar {
  const { scope, record } = createConsentContext(server, cfg);
  // Prepare tools are not budget-gated, so nothing ever disables them; the handles are not kept.
  const handles: ToolHandle[] = [];

  return <T>(
    name: string,
    toolCfg: PrepareToolConfig<T>,
    description: string,
    schema: ZodObjectSchema<T>,
    handler: (args: T) => Promise<McpListResult>,
  ): void => {
    if (!isPrepareToolId(name)) {
      throw new Error(
        `${name}: not a listed prepare tool — add the id to PREPARE_TOOL_IDS in ` +
          "shared/prepare-tool-ids.ts, or register it as a read or a write",
      );
    }

    if (getConnectorMode() === "gateway") {
      registerOn(server, name, description, schema, handler, handles);
      return;
    }

    const guarded = async (args: T): Promise<McpListResult> => {
      const target = toolCfg.scopeTargetOf(args);
      if (!scopeAllows(scope, target.kind, target.value)) {
        await record(name, "refused", { reason: "out of scope", target });
        return refused(`out of scope: ${target.kind}:${target.value} is not in ${cfg.scopeEnv}`);
      }
      let result: McpListResult;
      try {
        result = await handler(args);
      } catch (e) {
        // As a write does: record the failure, and if recording it fails too, the tool's own error
        // still leads, since an audit error alone would read as a prepare that never started.
        try {
          await record(name, "failed", { target, error: messageOf(e) });
        } catch (error_) {
          throw new Error(
            `${name} failed: ${messageOf(e)}. Recording that failure also failed: ${messageOf(error_)}`,
            { cause: e },
          );
        }
        throw e;
      }
      await record(name, "prepared", { target });
      return result;
    };
    registerOn(server, name, description, schema, guarded, handles);
  };
}
