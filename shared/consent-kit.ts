import { randomBytes, randomUUID } from "node:crypto";
import type { McpListResult, ZodObjectSchema } from "@nimbus-dev/sdk/connector-kit";
import {
  inputRequired,
  type McpInputRequired,
  type McpJsonObject,
  McpStateError,
  type McpToolContext,
  openState,
  requestDigest,
  sealState,
} from "@nimbus-dev/sdk/mcp-server";

import { type AuditOutcome, appendAuditEntry } from "./audit-chain.ts";
import { getConnectorMode } from "./connector-mode.ts";
import type { LayerServer } from "./layer-server.ts";
import { isPrepareToolId } from "./prepare-tool-ids.ts";
import { createWriteBudget, parseWriteBudget, WRITE_BUDGET_ENV } from "./write-budget.ts";
import { parseWriteScope, type ScopeTerm, scopeAllows } from "./write-scope.ts";

/** The subset of a registered tool's handle this kit needs. */
export type ToolHandle = { disable(): void };

/**
 * The structural subset of the upstream `McpServer` the kit uses in GATEWAY mode.
 *
 * Narrowed deliberately so tests can supply a fake without a transport, and so the kit's real
 * dependencies are visible in one place. In gateway mode the kit registers the raw handler and
 * asks no one: the gateway's executor is the gate there.
 */
export type GatewayConsentServer = {
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
  sendLoggingMessage(params: { level: "info" | "warning"; data: unknown }): Promise<void>;
  /** The four-argument registration every read tool goes through (`createRegisterSimpleTool`). */
  tool: (...args: never) => unknown;
};

/**
 * What a connector hands the kit: the server `createConnectorServer` built. In gateway mode that
 * is the upstream `McpServer`; in standalone mode it is the layer server
 * (`shared/layer-server.ts`), through which a write tool asks the client for consent.
 */
export type ConsentServer = GatewayConsentServer | LayerServer;

function isLayerServer(server: ConsentServer): server is LayerServer {
  return "layer" in server;
}

/**
 * What the upstream server of a GATEWAY-mode connector is constructed with:
 * `new McpServer(info, { capabilities: CONSENT_SERVER_CAPABILITIES })`. Only
 * `shared/connector-server.ts` constructs one.
 *
 * In gateway mode the kit tells the client about every record with `notifications/message`, and
 * the upstream SDK sends that only for a server that declared the MCP `logging` capability. It
 * must be declared at construction: that is the only moment the SDK installs its
 * `logging/setLevel` handler. A standalone connector declares nothing: it runs on the layer
 * server, which sends no notifications, and writes each record to stderr instead.
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

/** How long an approval prompt may stay open before its state stops opening. */
export const CONSENT_TTL_MS = 300_000;

/**
 * How many approval prompts one process keeps open at once. A stdio server has one peer, so a full
 * set is that peer's own doing. When it is full a NEW call is refused; an open prompt is never
 * dropped to make room, since that would let a flood of calls cancel a prompt a person is reading.
 */
export const MAX_PENDING_CONSENTS = 256;

/**
 * Who a sealed consent state is issued to. A stdio server has exactly one peer, the process on the
 * other end of the pipe; the name a client declares is its own claim, so it is not a principal.
 */
const CONSENT_PRINCIPAL = "stdio";

/**
 * Whether the client behind a request declared that it can show a form to a person. An EMPTY
 * `elicitation` object is how the revisions before 2025-11-25 declared form support.
 */
export function clientCanPrompt(clientCapabilities: McpJsonObject): boolean {
  const elicitation = clientCapabilities["elicitation"];
  if (typeof elicitation !== "object" || elicitation === null || Array.isArray(elicitation)) {
    return false;
  }
  return "form" in elicitation || Object.keys(elicitation).length === 0;
}

/**
 * The question put to the human, through the client.
 *
 * It carries the VERBATIM operation and resolved parameters, never a digest — a digest is a rubber
 * stamp with extra steps, and the human is the entire trust boundary here.
 */
function consentQuestion(mutates: string, params: unknown) {
  return inputRequired.elicit({
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
}

/**
 * Whether an answer is consent. `action: "accept"` alone is not — the form's own answer must also
 * be true, so a client that auto-accepts without answering the question does not clear the gate.
 */
function isConsent(answer: unknown): boolean {
  if (typeof answer !== "object" || answer === null) return false;
  const a = answer as { action?: unknown; content?: unknown };
  if (a.action !== "accept" || typeof a.content !== "object" || a.content === null) return false;
  return (a.content as Record<string, unknown>)["confirm"] === true;
}

function parseWith<T>(schema: ZodObjectSchema<T>, args: unknown): T {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    throw new Error(parsed.error.message);
  }
  return parsed.data;
}

/** Registers the raw handler on the upstream server (gateway mode). */
function registerOnGateway<T>(
  server: GatewayConsentServer,
  name: string,
  description: string,
  schema: ZodObjectSchema<T>,
  handler: (args: T) => Promise<McpListResult>,
): void {
  server.registerTool(
    name,
    { description, inputSchema: schema.shape },
    async (args: unknown): Promise<McpListResult> => handler(parseWith(schema, args)),
  );
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
  /**
   * TEST seam: where the second, non-durable channel of a record goes, in place of the client log
   * message (gateway mode) or the stderr line (standalone mode). Production passes nothing.
   */
  readonly notify?: (tool: string, outcome: AuditOutcome) => Promise<void> | void;
};

/** The non-durable channel of a record: told of every record attempted, after the durable one. */
function defaultNotify(
  server: ConsentServer,
  connector: string,
): (tool: string, outcome: AuditOutcome) => Promise<void> | void {
  if (isLayerServer(server)) {
    // The layer server sends nothing but answers, so there is no client log to write to. stderr is
    // where a stdio server may log: stdout is the protocol channel. Never the parameters.
    return (tool, outcome): void => {
      process.stderr.write(`nimbus-connector ${connector}: ${tool} ${outcome}\n`);
    };
  }
  // It reaches the client because the gateway-mode server declared the MCP `logging` capability
  // (CONSENT_SERVER_CAPABILITIES), and a client may filter it by level.
  return (tool, outcome) =>
    server.sendLoggingMessage({
      level: outcome === "executed" ? "info" : "warning",
      data: { connector, tool, outcome },
    });
}

/**
 * The scope parse and the record function, built once per registrar. Extracted (not copied) so the
 * write registrar and the prepare registrar cannot drift apart on what a scope term means or on
 * which channels a record reaches.
 */
function createConsentContext(server: ConsentServer, cfg: RegistrarConfig): ConsentContext {
  const scope = parseWriteScope(process.env[cfg.scopeEnv], cfg.scopeKinds);
  const auditLog = process.env["NIMBUS_MCP_AUDIT_LOG"];
  const notify = cfg.notify ?? defaultNotify(server, cfg.connector);

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
      // Then the second channel, told of every record attempted, one whose append failed
      // included. Best effort, and after the durable log: a client that has gone away mid-write
      // must not keep the `executed` or `failed` record of a write that ran out of the log.
      try {
        await notify(tool, outcome);
      } catch {
        // A dead pipe is where this fails; the durable record above is what counts.
      }
    }
  }

  return { scope, record };
}

/** One approval prompt that is open: issued, not yet answered, not yet expired. */
type PendingConsent = {
  readonly expiresAt: number;
  readonly tool: string;
  readonly target: { kind: string; value: string };
};

function notBuiltByFactory(connector: string): Error {
  return new Error(
    `nimbus-connector ${connector}: a standalone connector must be built with ` +
      "createConnectorServer (shared/connector-server.ts)",
  );
}

/**
 * Build a connector's write-tool registrar.
 *
 * In `"gateway"` mode the raw handler is registered: `executor.ts` (I2) is the gate there, client
 * capabilities are irrelevant, and the connector adds nothing.
 *
 * In `"standalone"` mode each write tool is registered behind the consent steps below, on the
 * layer server, and asks the human through the client with an input request. One handler serves
 * both MCP eras: a client of revision 2026-07-28 is answered `input_required` and retries the call
 * with its answer; a client that opened with `initialize` is sent the older `elicitation/create`
 * request by the layer, which then runs the handler again.
 *
 * Default-DENY listing: a write tool is in `tools/list` only for a client that declared it can
 * prompt a person, and only while write budget is left. It is always CALLABLE, so a call from a
 * client that was never listed it, or after the budget ran out, still reaches the handler and is
 * refused and RECORDED rather than answered as an unknown tool.
 */
export function createWriteToolRegistrar(
  server: ConsentServer,
  cfg: RegistrarConfig,
): WriteToolRegistrar {
  const handles: ToolHandle[] = [];
  const mode = getConnectorMode();

  const { scope, record } = createConsentContext(server, cfg);
  // Throws on a value that is not plain digits, an empty one included, as the scope parse above
  // does on a malformed term: read with `Number()`, `abc` became NaN, which `remaining <= 0` never
  // refused.
  const budget = createWriteBudget(parseWriteBudget(process.env[WRITE_BUDGET_ENV]));

  // The key every consent state of this process is sealed under. Made here and never stored: a
  // restarted connector refuses every state its predecessor issued.
  const stateKey = randomBytes(32);
  const pending = new Map<string, PendingConsent>();

  /**
   * Take one unit of budget if any is left. Spending the last unit takes every write tool out of
   * `tools/list`.
   *
   * Nothing may be awaited between the check and the decrement, which is why both are the one
   * synchronous call `budget.take()`. Calls run concurrently, and with an await between the two
   * every call in flight passed the check before any of them spent: three approved calls all
   * mutated under a budget of one.
   */
  function spendOne(): boolean {
    if (!budget.take()) return false;
    if (!budget.hasLeft()) {
      for (const h of handles) h.disable();
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

  /** Drops the prompts whose state can no longer open, each recorded as declined. */
  async function pruneExpired(now: number): Promise<void> {
    const expired: PendingConsent[] = [];
    for (const [nonce, entry] of pending) {
      if (entry.expiresAt <= now) {
        pending.delete(nonce);
        expired.push(entry);
      }
    }
    for (const entry of expired) {
      const detail = { reason: "expired unanswered", target: entry.target };
      await record(entry.tool, "declined", detail); // NOSONAR S9382: audit records are hash-chained, so they are appended one at a time, in order.
    }
  }

  if (mode === "standalone") {
    if (!isLayerServer(server)) throw notBuiltByFactory(cfg.connector);
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

    if (mode === "gateway" || !isLayerServer(server)) {
      // Gateway mode. (A standalone connector without a layer server threw above.)
      if (isLayerServer(server)) {
        throw new Error(
          `nimbus-connector ${cfg.connector}: gateway mode needs the upstream server`,
        );
      }
      registerOnGateway(server, name, description, schema, handler);
      return;
    }

    /** The scope and `refuseBefore` checks: the refusals no consent can lift. */
    async function refusalBeforeConsent(
      args: T,
      target: { kind: string; value: string },
    ): Promise<McpListResult | undefined> {
      // A refusal no consent can lift comes before everything that could involve a human.
      const early = toolCfg.refuseBefore?.(args);
      if (early !== undefined) {
        await record(name, "refused", { reason: early, target });
        return refused(early);
      }
      // SCOPE before prompting. Asking a human to approve something the operator already forbade
      // cannot change the outcome, and training people to click through prompts that do not
      // matter is how you make the prompts that do matter ineffective.
      if (!scopeAllows(scope, target.kind, target.value)) {
        await record(name, "refused", { reason: "out of scope", target });
        return refused(`out of scope: ${target.kind}:${target.value} is not in ${cfg.scopeEnv}`);
      }
      return undefined;
    }

    /** FIRST CALL: nothing has been asked yet. Ends by asking, or by a recorded refusal. */
    async function ask(
      args: T,
      digest: string,
      ctx: McpToolContext,
    ): Promise<McpListResult | McpInputRequired> {
      const target = toolCfg.scopeTargetOf(args);
      const early = await refusalBeforeConsent(args, target);
      if (early !== undefined) return early;

      // A client that cannot show a prompt is not listed this tool, but it can still name it.
      if (!clientCanPrompt(ctx.clientCapabilities)) {
        await record(name, "refused", { reason: "client cannot prompt", target });
        return refused("this client cannot ask a person to approve a write");
      }

      // BUDGET — a refusal that consent cannot lift comes before consent. Not the last word on
      // the budget, though: see `perform`.
      if (!budget.hasLeft()) return budgetExhausted(name, target, "budget exhausted");

      const now = Date.now();
      await pruneExpired(now);
      if (pending.size >= MAX_PENDING_CONSENTS) {
        await record(name, "refused", { reason: "too many approvals pending", target });
        return refused("too many approvals are pending; answer or wait for the open ones");
      }

      // The slot is taken BEFORE the record is awaited: calls run concurrently, and with an await
      // between the size check and the insert every call in flight passed the check before any of
      // them inserted, so the set could exceed its cap. If the record cannot be written the write
      // is not asked about at all, and the slot is given back.
      const nonce = randomUUID();
      pending.set(nonce, { expiresAt: now + CONSENT_TTL_MS, tool: name, target });
      try {
        await record(name, "requested", { target, params: args });
      } catch (e) {
        pending.delete(nonce);
        throw e;
      }
      return inputRequired({
        inputRequests: { confirm: consentQuestion(toolCfg.mutates, args) },
        // Bound to this tool and these exact arguments, to the pipe's one peer, and to five
        // minutes. It holds only the nonce: a state is readable by whoever carries it.
        requestState: sealState(
          stateKey,
          { n: nonce },
          {
            principal: CONSENT_PRINCIPAL,
            ttlMs: CONSENT_TTL_MS,
            requestDigest: digest,
            // The clock read above, so the state and its pending entry expire at the same
            // instant: a state can never still open after its entry has been pruned.
            now: () => now,
          },
        ),
      });
    }

    /**
     * RETRY: the call came back with an answer. Nothing about it is believed until its state has
     * opened, and a state that does not open is a protocol error that records NOTHING: a request
     * that proved nothing must not be able to write to the audit log.
     */
    function takeConsent(digest: string, ctx: McpToolContext): unknown {
      if (ctx.requestState === undefined || ctx.inputResponses === undefined) {
        throw new McpStateError("malformed");
      }
      const opened = openState(stateKey, ctx.requestState, {
        principal: CONSENT_PRINCIPAL,
        requestDigest: digest,
      });
      const nonce =
        typeof opened === "object" && opened !== null
          ? (opened as Record<string, unknown>)["n"]
          : undefined;
      // Taken in the same synchronous step as the open: of two concurrent retries of one state,
      // one finds the nonce and the other does not. A spent or pruned nonce is a state that no
      // longer names an open prompt.
      if (typeof nonce !== "string" || !pending.delete(nonce)) {
        throw new McpStateError("mismatch");
      }
      return ctx.inputResponses["confirm"];
    }

    /** After a state has opened and its nonce is taken: the answer, then the write. */
    async function perform(args: T, answer: unknown): Promise<McpListResult> {
      const target = toolCfg.scopeTargetOf(args);
      if (!isConsent(answer)) {
        await record(name, "declined", { target });
        return refused("not approved: the operation was declined, cancelled, or timed out");
      }
      await record(name, "accepted", { target });

      // The arguments are the ones that were asked about (the state's digest says so), but a
      // refusal can have become true while the prompt was open.
      const late = await refusalBeforeConsent(args, target);
      if (late !== undefined) return late;

      // SPEND — the budget checked AGAIN, and decremented in the same synchronous step: every
      // call in flight passed the first check before any of them got this far, so that check alone
      // cannot hold the cap (see `spendOne`). Spent BEFORE the mutation so a throwing one still
      // consumes budget — otherwise a failing destructive tool could be retried without limit.
      if (!spendOne()) return budgetExhausted(name, target, "budget exhausted after approval");

      // PRE-STATE — after approval, before the mutation, so an unrecoverable action leaves a
      // record of what it destroyed. Capture failure is NOT fatal: refusing here would turn a
      // transient read error into a blocked action the owner already approved.
      let preState: Record<string, unknown> = {};
      if (toolCfg.capturePreState !== undefined) {
        try {
          preState = await toolCfg.capturePreState(args);
        } catch (e) {
          preState = { captureFailed: messageOf(e) };
        }
      }

      // MUTATE.
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
    }

    const handle = server.registerTool(
      name,
      {
        description,
        inputSchema: schema.shape,
        listed: (client) => clientCanPrompt(client.clientCapabilities),
      },
      (raw: unknown, ctx: McpToolContext) => {
        const args = parseWith(schema, raw);
        // Over the arguments as JSON, which is what a client sends again on its retry.
        const digest = requestDigest(name, JSON.parse(JSON.stringify(args)) as unknown);
        const retry = ctx.requestState !== undefined || ctx.inputResponses !== undefined;
        return retry ? perform(args, takeConsent(digest, ctx)) : ask(args, digest, ctx);
      },
    );
    // Collected so budget exhaustion can take every write tool out of the list at once.
    handles.push(handle);
    // A budget that starts at zero never spends its last unit, so nothing would unlist the tool.
    if (!budget.hasLeft()) handle.disable();
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
 * In `"standalone"` mode it is registered for EVERY client (a prepare tool prompts no one, so no
 * elicitation capability is needed), behind the same write scope as the writes it serves, and
 * each in-scope run is audited as `prepared`. It spends no write budget and is never taken out of
 * the list by the budget running out: a second prompt before the apply prompt would only train
 * click-through.
 */
export function createPrepareToolRegistrar(
  server: ConsentServer,
  cfg: RegistrarConfig,
): PrepareToolRegistrar {
  const { scope, record } = createConsentContext(server, cfg);
  const mode = getConnectorMode();

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

    if (!isLayerServer(server)) {
      if (mode === "standalone") throw notBuiltByFactory(cfg.connector);
      registerOnGateway(server, name, description, schema, handler);
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
    server.registerTool(name, { description, inputSchema: schema.shape }, (raw: unknown) =>
      guarded(parseWith(schema, raw)),
    );
  };
}
