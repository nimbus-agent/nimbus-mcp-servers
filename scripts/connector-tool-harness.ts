/**
 * connector-tool-harness — the small amount of scaffolding a connector's
 * `tools.ts` test needs, in one place.
 *
 * Every connector registers its tools through a `register<Name>Tools(reg)`
 * function, and every test of one has to do the same three things: capture what
 * that function registered, answer `fetch` without a network, and set an
 * environment variable for the length of one assertion. Written per connector
 * that is ~40 lines of identical `beforeEach` in each of ~90 test files — the
 * exact duplication this repo already pays for elsewhere.
 *
 * It lives in `scripts/` rather than `shared/` on purpose: `scripts/` is repo
 * tooling and is NOT in package.json's `files`, so a harness here cannot be
 * published to consumers, while anything under `shared/` would be.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ClientCapabilities, JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { type AuditEntry, verifyAuditChain } from "../shared/audit-chain.ts";
import type { McpListResult } from "../shared/mcp-tool-kit.ts";
import type { ZodToolRegistrar } from "../shared/run-read-only-mcp-connector.ts";

/**
 * The one ordering used whenever tool names are sorted.
 *
 * Exported rather than inlined because `names()` is compared against a caller's
 * own sorted `*_TOOL_NAMES` in several tests, and two different comparators on
 * the two sides of an equality assertion is precisely the ordering bug a bare
 * `.sort()` invites.
 */
export function byToolName(a: string, b: string): number {
  return a.localeCompare(b);
}

/** One registration, as the connector made it. */
export interface CapturedTool {
  readonly name: string;
  readonly description: string;
  readonly schema: unknown;
  readonly handler: (args: unknown) => Promise<McpListResult>;
}

/** The tools a `register…Tools` call registered, in registration order. */
export class CapturedTools {
  private readonly tools = new Map<string, CapturedTool>();

  add(tool: CapturedTool): void {
    this.tools.set(tool.name, tool);
  }

  /** Registered tool names, sorted — the stable form for an equality assertion. */
  names(): string[] {
    return [...this.tools.keys()].sort(byToolName);
  }

  /**
   * Registered tool names in REGISTRATION order.
   *
   * Distinct from {@link names} on purpose: a `*_TOOL_NAMES` export is written
   * in the order the tools are registered, and several connectors' tests assert
   * that order. Generating the constant from the sorted list rewrote every one
   * of them.
   */
  registrationOrder(): string[] {
    return [...this.tools.keys()];
  }

  /** One captured tool. Throws by name so a typo fails loudly rather than as `undefined`. */
  get(name: string): CapturedTool {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      throw new Error(`tool "${name}" was not registered (have: ${this.names().join(", ")})`);
    }
    return tool;
  }

  /**
   * Invoke a tool the way the MCP server would: validate `args` against the
   * tool's own schema, then hand the PARSED value to the handler.
   *
   * The validation is not incidental. `createZodToolRegistrar` parses before it
   * calls, so a harness that skipped it would let a test pass arguments the
   * real server rejects — and, worse, would make an assertion that a tool
   * REFUSES bad input silently succeed. Athena's `cliArg` guard against argv
   * flag smuggling is exactly such a rule, and it lives only in the schema.
   */
  async call(name: string, args: unknown = {}): Promise<McpListResult> {
    const tool = this.get(name);
    const schema = tool.schema as
      | { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: Error } }
      | undefined;
    if (typeof schema?.safeParse !== "function") {
      return tool.handler(args);
    }
    const parsed = schema.safeParse(args);
    if (!parsed.success) {
      throw new Error(parsed.error?.message ?? `invalid arguments for "${name}"`);
    }
    return tool.handler(parsed.data);
  }

  /** Invoke a tool and parse the single JSON text block it returned. */
  async callJson(name: string, args: unknown = {}): Promise<unknown> {
    const result = await this.call(name, args);
    const first = result.content[0];
    if (first?.type !== "text") {
      throw new Error(`tool "${name}" returned no text content`);
    }
    return JSON.parse(first.text) as unknown;
  }
}

/**
 * Every shape a connector's `register…Tools` takes.
 *
 * The third member is not redundant: a connector with consent-gated writes
 * declares `(server)` alone and builds its read registrar from it, which is
 * indistinguishable by arity from a read-only connector's `(reg)`. Both are
 * accepted here, and {@link captureTools} decides at runtime which it is.
 */
export type ConnectorRegistrar =
  | ((reg: ZodToolRegistrar) => void)
  | ((reg: ZodToolRegistrar, server: never) => void)
  | ((server: never) => void);

/** Did this failure come from handing the registrar where a server was wanted? */
function isWrongArgumentShape(err: unknown): boolean {
  return err instanceof Error && err.message.includes("expected MCP server with .tool");
}

/** The recording pair a capture attempt drives a connector's registrar with. */
interface Recorders {
  readonly reg: ZodToolRegistrar;
  readonly server: never;
}

/** How the stand-in client answers a consent prompt. */
export interface ConsentAnswer {
  readonly action: "accept" | "decline" | "cancel";
  readonly content?: Record<string, unknown>;
}

/** Approval, with the form's own `confirm` answer the consent kit also requires. */
export const APPROVE: ConsentAnswer = { action: "accept", content: { confirm: true } };

/**
 * The client half of the server object the consent kit talks to: what the client advertised at
 * `initialize`, the hook the kit chains to learn when that happened, and the consent prompt.
 */
interface ClientSurface {
  getClientCapabilities(): { elicitation?: unknown } | undefined;
  oninitialized?: (() => void) | undefined;
  elicitInput?: (params: { message: string }) => Promise<ConsentAnswer>;
}

/**
 * The client a capture stands in with when the caller supplies none. In gateway mode the consent
 * kit never reads the capability surface, so it exists to complete the shape, not because it is
 * exercised. A new one per capture: a standalone-mode kit chains its handshake hook onto the client
 * it is given, and a shared default would carry one capture's hook into the next.
 */
function silentClient(): ClientSurface {
  return { getClientCapabilities: (): undefined => undefined };
}

function makeRecorders(captured: CapturedTools, client: ClientSurface = silentClient()): Recorders {
  const handle = { disable: (): undefined => undefined };
  const reg = ((
    name: string,
    description: string,
    schema: unknown,
    handler: (args: unknown) => Promise<McpListResult>,
  ): void => {
    captured.add({ name, description, schema, handler });
  }) as unknown as ZodToolRegistrar;

  const server = {
    server: client,
    // `createRegisterSimpleTool` binds `.tool` and passes a raw Zod SHAPE where
    // the Zod registrar passes a built schema. Rebuilding the object here means
    // a caller sees one schema type whichever path a tool was registered by.
    tool: (
      name: string,
      description: string,
      shape: Record<string, unknown>,
      handler: (args: unknown) => Promise<McpListResult>,
    ) => {
      captured.add({ name, description, schema: z.object(shape as z.ZodRawShape), handler });
      return handle;
    },
    registerTool: (
      name: string,
      config: { description?: string; inputSchema?: unknown },
      handler: (args: unknown) => Promise<McpListResult>,
    ) => {
      captured.add({
        name,
        description: config.description ?? "",
        schema: z.object((config.inputSchema ?? {}) as z.ZodRawShape),
        handler,
      });
      return handle;
    },
    sendToolListChanged: (): undefined => undefined,
    sendLoggingMessage: (): Promise<void> => Promise.resolve(),
  } as unknown as never;

  return { reg, server };
}

/**
 * Run a connector's `register…Tools` function against recording stand-ins and
 * return everything it registered.
 *
 * Connectors take one of two first arguments — the Zod registrar (`reg`) for
 * the read-only ones, or the MCP server for the ones that also register
 * consent-gated writes — and a one-parameter signature does not say which. The
 * two are not interchangeable and cannot be merged into a single probe: the
 * registrar must be callable and `createRegisterSimpleTool` requires
 * `typeof server === "object"`, so one value cannot be both.
 *
 * So both orders are tried, registrar first. A wrong guess registers nothing or
 * throws, and the right one is kept; if neither works the original failure is
 * rethrown rather than reported as an empty surface, because a connector that
 * silently registers no tools is exactly the bug this is here to catch.
 *
 * Three registration paths are recorded — `reg(...)`, `server.tool(...)` and
 * `server.registerTool(...)` — into one container, so a mutating connector's
 * read AND write tools land in the same captured surface.
 */
export function captureTools(register: ConnectorRegistrar): CapturedTools {
  return captureWith(register, (captured) => ({
    recorders: makeRecorders(captured),
    settle: (): undefined => undefined,
  }));
}

/**
 * {@link captureTools}' probe, over recorders the caller builds. `settle` runs once the
 * registrar has returned and before anything is counted — the handshake, for a standalone capture,
 * since the consent kit registers write tools only then.
 */
function captureWith(
  register: ConnectorRegistrar,
  attempt: (captured: CapturedTools) => { recorders: Recorders; settle: () => void },
): CapturedTools {
  const failures: unknown[] = [];
  for (const serverFirst of [false, true]) {
    const captured = new CapturedTools();
    const { recorders, settle } = attempt(captured);
    try {
      // The union has three members and only a runtime probe can say which one
      // this connector is, so the call is made through one widened signature.
      const call = register as (a: unknown, b: unknown) => void;
      if (serverFirst) {
        call(recorders.server, recorders.server);
      } else {
        call(recorders.reg, recorders.server);
      }
      settle();
      if (captured.names().length > 0) {
        return captured;
      }
    } catch (err) {
      failures.push(err);
    }
  }
  // Report the connector's OWN failure, not the probe's. A wrong guess about
  // the argument order fails inside the SDK with a fixed message, and throwing
  // that would mask the real reason — a connector whose registration reads
  // configuration would report "expected MCP server with .tool" instead of
  // naming the variable it actually needs.
  const real = failures.find((e) => !isWrongArgumentShape(e));
  if (real !== undefined) {
    throw real;
  }
  if (failures.length > 0) {
    throw failures[0];
  }
  throw new Error("register…Tools registered no tools");
}

/** What {@link captureStandaloneTools} saw. */
export interface StandaloneCapture {
  /** Every tool registered once the handshake ran: the reads, plus the writes if they were offered. */
  readonly tools: CapturedTools;
  /** The message of every consent prompt the connector raised, in order. */
  readonly prompts: string[];
}

/**
 * {@link captureTools} in STANDALONE mode, where the connector's own consent kit is the gate.
 *
 * The kit queues write tools until the client's `initialize`, because only then are its
 * capabilities knowable, and registers them only for a client that can prompt a human. This
 * stand-in client completes that handshake as soon as registration returns, advertising
 * elicitation when `elicitation` is true, and answers every consent prompt with `answer`
 * (approval when omitted).
 *
 * The caller locks the mode first (`setConnectorMode("standalone")`) and sets the connector's
 * `NIMBUS_MCP_<SERVICE>_WRITE_SCOPE`, which the kit reads when its registrar is built.
 */
export function captureStandaloneTools(
  register: ConnectorRegistrar,
  opts: { readonly elicitation: boolean; readonly answer?: ConsentAnswer },
): StandaloneCapture {
  const prompts: string[] = [];
  const tools = captureWith(register, (captured) => {
    let initialized = false;
    const client: ClientSurface = {
      getClientCapabilities: () => {
        if (!initialized) return undefined;
        return opts.elicitation ? { elicitation: {} } : {};
      },
      oninitialized: undefined,
      elicitInput: (params) => {
        prompts.push(params.message);
        return Promise.resolve(opts.answer ?? APPROVE);
      },
    };
    return {
      recorders: makeRecorders(captured, client),
      settle: () => {
        initialized = true;
        client.oninitialized?.();
      },
    };
  });
  return { tools, prompts };
}

/** One request the stub saw. */
export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

/** What the stub should reply with. A bare string is a 200 with that body. */
export type StubReply = string | { readonly status?: number; readonly body?: string };

export interface FetchStub {
  /** Requests seen so far, in order. */
  readonly calls: RecordedRequest[];
  /** The single request seen. Throws unless there was exactly one. */
  readonly only: RecordedRequest;
  /** Put `globalThis.fetch` back. Call from `afterEach`. */
  restore(): void;
}

/** The three forms `fetch` accepts as its first argument. */
type FetchInput = Request | string | URL;

/**
 * The URL of a fetch argument, whichever of the three forms it takes.
 *
 * `String(input)` covers a string and a URL but stringifies a `Request` to
 * `[object Object]`, so a connector calling `fetch(new Request(url))` would
 * have every URL assertion in the tree silently compare against that.
 */
function requestUrl(input: FetchInput): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function headerRecord(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = init?.headers;
  if (raw === undefined) {
    return out;
  }
  if (Array.isArray(raw)) {
    for (const [k, v] of raw) {
      if (k !== undefined && v !== undefined) {
        out[k.toLowerCase()] = v;
      }
    }
    return out;
  }
  if (raw instanceof Headers) {
    raw.forEach((v, k) => {
      out[k.toLowerCase()] = v;
    });
    return out;
  }
  for (const [k, v] of Object.entries(raw)) {
    out[k.toLowerCase()] = String(v);
  }
  return out;
}

/**
 * Replace `globalThis.fetch` with a recording stub.
 *
 * `reply` is either a fixed reply for every request, or a function of the
 * request — enough for the tools that make two calls and need different bodies
 * back. Returning `undefined` from the function fails the test loudly rather
 * than silently answering 200, so an unexpected URL is never mistaken for a
 * passing assertion.
 */
export function stubFetch(
  reply: StubReply | ((req: RecordedRequest) => StubReply | undefined),
): FetchStub {
  const original = globalThis.fetch;
  const calls: RecordedRequest[] = [];
  /** Record one request and build its reply. Throws on a request `reply` does not answer. */
  const answer = (input: FetchInput, init?: RequestInit): Response => {
    const req: RecordedRequest = {
      url: requestUrl(input),
      method: init?.method ?? "GET",
      headers: headerRecord(init),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(req);
    const chosen = typeof reply === "function" ? reply(req) : reply;
    if (chosen === undefined) {
      throw new Error(`unexpected request: ${req.method} ${req.url}`);
    }
    const spec = typeof chosen === "string" ? { body: chosen } : chosen;
    return new Response(spec.body ?? "{}", { status: spec.status ?? 200 });
  };
  const stub = async (input: FetchInput, init?: RequestInit) => answer(input, init); // NOSONAR S7503: real fetch rejects and never throws, so the stub is async only to turn answer's throws (an unexpected request, a throwing reply, a bad status) into that same rejection.
  globalThis.fetch = stub as typeof globalThis.fetch;

  return {
    calls,
    get only(): RecordedRequest {
      if (calls.length !== 1) {
        throw new Error(`expected exactly 1 request, saw ${String(calls.length)}`);
      }
      const first = calls[0];
      if (first === undefined) {
        throw new Error("expected exactly 1 request, saw none");
      }
      return first;
    },
    restore(): void {
      globalThis.fetch = original;
    },
  };
}

/** One CLI invocation the spawn stub saw. */
export interface RecordedSpawn {
  readonly command: readonly string[];
  readonly env: Record<string, string | undefined>;
}

export interface SpawnStub {
  readonly calls: RecordedSpawn[];
  restore(): void;
}

/**
 * Replace `Bun.spawn` with a recording stub that answers every invocation with
 * `stdout` and `exitCode`.
 *
 * The CLI-backed connectors (aws, gcloud, kubectl, terraform, bq, obsidian's
 * vault walk aside) reach the outside world through `shared/nimbus-spawn.ts`,
 * which resolves the implementation at CALL time precisely so this stub works.
 * Without it a contract test that calls their tools runs the real binaries: an
 * observed two seconds per connector, and a genuine subprocess on the machine
 * running the suite.
 *
 * `onSpawn` runs with the command at the moment of the spawn, which is when a
 * real CLI reads its input files and writes its output files, so a test can
 * check or play that side of the exchange while the connector waits on it.
 */
export function stubSpawn(
  reply: {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    onSpawn?: (command: readonly string[]) => void;
  } = {},
): SpawnStub {
  const original = Bun.spawn;
  const calls: RecordedSpawn[] = [];
  const fake = (
    command: readonly string[],
    options?: { env?: Record<string, string | undefined> },
  ): unknown => {
    calls.push({ command: [...command], env: options?.env ?? {} });
    reply.onSpawn?.(command);
    return {
      exited: Promise.resolve(reply.exitCode ?? 0),
      stdout: new Blob([reply.stdout ?? "{}"]),
      stderr: new Blob([reply.stderr ?? ""]),
    };
  };
  (Bun as { spawn: unknown }).spawn = fake;
  return {
    calls,
    restore(): void {
      (Bun as { spawn: unknown }).spawn = original;
    },
  };
}

/** The test's two ends of a server booted by {@link bootOverStubbedStdio}. */
export interface StubbedStdio {
  /** What the server reads as its stdin: a client writes its requests here. */
  readonly toServer: PassThrough;
  /** What the server writes as its stdout: its responses arrive here. */
  readonly fromServer: PassThrough;
}

/**
 * Run a connector's bootstrap with `process.stdin` and `process.stdout` replaced by in-memory
 * streams, and hand back the two ends.
 *
 * Every entry point connects the SDK's real `StdioServerTransport`, which takes the process's
 * stdin and stdout when it is CONSTRUCTED and keeps them. Swapping the pair for exactly the length
 * of the boot gives a test the server's two ends without a subprocess — and a subprocess is no
 * substitute, because bun's coverage does not follow a child process: that is how 85 of the 94
 * entry points went unexecuted by the whole suite. Nothing else is stubbed. The server, its
 * transport and the JSON-RPC framing between them are the production ones.
 *
 * The real streams are put back in `finally`, so a bootstrap that throws leaves them in place.
 */
export async function bootOverStubbedStdio(boot: () => Promise<void>): Promise<StubbedStdio> {
  const stdio: StubbedStdio = { toServer: new PassThrough(), fromServer: new PassThrough() };
  const proc = process as unknown as { stdin: unknown; stdout: unknown };
  const real = { stdin: proc.stdin, stdout: proc.stdout };
  proc.stdin = stdio.toServer;
  proc.stdout = stdio.fromServer;
  try {
    await boot();
  } finally {
    proc.stdin = real.stdin;
    proc.stdout = real.stdout;
  }
  return stdio;
}

/**
 * The client half of {@link bootOverStubbedStdio}: newline-delimited JSON-RPC over the two
 * streams, framed by the SDK's own `ReadBuffer` and `serializeMessage` — the framing its stdio
 * transports use on both sides.
 */
class StubbedStdioClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private readonly buffer = new ReadBuffer();
  private readonly onData = (chunk: Buffer): void => {
    this.buffer.append(chunk);
    let message = this.buffer.readMessage();
    while (message !== null) {
      this.onmessage?.(message);
      message = this.buffer.readMessage();
    }
  };

  constructor(private readonly stdio: StubbedStdio) {}

  start(): Promise<void> {
    this.stdio.fromServer.on("data", this.onData);
    return Promise.resolve();
  }

  send(message: JSONRPCMessage): Promise<void> {
    this.stdio.toServer.write(serializeMessage(message));
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.stdio.fromServer.off("data", this.onData);
    this.onclose?.();
    return Promise.resolve();
  }
}

/**
 * An MCP client connected to a server booted by {@link bootOverStubbedStdio}, advertising
 * `capabilities`. Connecting runs the real `initialize` handshake, so a bootstrap that never
 * connected its transport fails right here — its `initialize` is never answered — rather than
 * passing later as an empty tool surface.
 */
export async function connectOverStubbedStdio(
  stdio: StubbedStdio,
  capabilities: ClientCapabilities = {},
): Promise<Client> {
  const client = new Client(
    { name: "nimbus-connector-harness", version: "0.0.0" },
    { capabilities },
  );
  await client.connect(new StubbedStdioClientTransport(stdio));
  return client;
}

/**
 * Set environment variables for the duration of `fn`, restoring exactly what was
 * there before — including restoring "absent" as absent rather than as `""`,
 * which is what a naive save/restore gets wrong and which matters here because
 * every connector treats empty and unset identically. Resolves to what `fn`
 * returned.
 */
export async function withEnv<T>(
  env: Record<string, string | undefined>,
  fn: () => Promise<T> | T,
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    saved.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

/**
 * The entries of a `NIMBUS_MCP_AUDIT_LOG` file the consent kit wrote, in order — how a standalone
 * test sees what a write recorded (its target, and the pre-state an unrecoverable write captured).
 * The chain's own integrity is `verifyAuditChain`'s job, not this one's.
 */
function auditEntries(auditLog: string): AuditEntry[] {
  return readFileSync(auditLog, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => (JSON.parse(line) as { entry: AuditEntry }).entry);
}

/** What {@link approvedStandaloneWrite} saw. */
export interface ApprovedWrite {
  /** The tool's JSON answer. */
  readonly answer: unknown;
  /** Every audit entry the call recorded, in order. */
  readonly audit: AuditEntry[];
  /** Whether the audit log the call wrote verifies as an intact chain. */
  readonly chain: Awaited<ReturnType<typeof verifyAuditChain>>;
}

/**
 * Make ONE write the way an operator would see it run standalone: registered for a client that can
 * prompt, under `scopeEnv`, approved, with a fresh audit log that is read back, verified and
 * deleted. The caller locks standalone mode first and stubs whatever the write reaches.
 */
export async function approvedStandaloneWrite(
  register: ConnectorRegistrar,
  scopeEnv: Readonly<Record<string, string>>,
  tool: string,
  args: Record<string, unknown>,
): Promise<ApprovedWrite> {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-audit-"));
  const auditLog = join(dir, "audit.jsonl");
  try {
    let answer: unknown;
    await withEnv(
      { ...scopeEnv, NIMBUS_MCP_AUDIT_LOG: auditLog, NIMBUS_MCP_WRITE_BUDGET: undefined },
      async () => {
        answer = await captureStandaloneTools(register, { elicitation: true }).tools.callJson(
          tool,
          args,
        );
      },
    );
    return { answer, audit: auditEntries(auditLog), chain: await verifyAuditChain(auditLog) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
