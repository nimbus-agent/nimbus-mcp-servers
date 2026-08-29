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

import { z } from "zod";
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

  /** Invoke a tool's handler. */
  async call(name: string, args: unknown = {}): Promise<McpListResult> {
    return this.get(name).handler(args);
  }

  /** Invoke a tool and parse the single JSON text block it returned. */
  async callJson(name: string, args: unknown = {}): Promise<unknown> {
    const result = await this.call(name, args);
    const first = result.content[0];
    if (first === undefined || first.type !== "text") {
      throw new Error(`tool "${name}" returned no text content`);
    }
    return JSON.parse(first.text) as unknown;
  }
}

/** The recording pair a capture attempt drives a connector's registrar with. */
interface Recorders {
  readonly reg: ZodToolRegistrar;
  readonly server: never;
}

function makeRecorders(captured: CapturedTools): Recorders {
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
    // In gateway mode the consent kit never reads the capability surface; this
    // exists so the shape is complete, not because it is exercised.
    server: { getClientCapabilities: (): undefined => undefined },
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
export function captureTools(
  register: ((reg: ZodToolRegistrar) => void) | ((reg: ZodToolRegistrar, server: never) => void),
): CapturedTools {
  let firstFailure: unknown;
  for (const serverFirst of [false, true]) {
    const captured = new CapturedTools();
    const { reg, server } = makeRecorders(captured);
    try {
      if (serverFirst) {
        (register as (a: never, b: never) => void)(server, server);
      } else {
        register(reg, server);
      }
      if (captured.names().length > 0) {
        return captured;
      }
    } catch (err) {
      firstFailure ??= err;
    }
  }
  if (firstFailure !== undefined) {
    throw firstFailure;
  }
  throw new Error("register…Tools registered no tools");
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
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const req: RecordedRequest = {
      url: typeof input === "string" ? input : String(input),
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
  }) as typeof globalThis.fetch;

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
 */
export function stubSpawn(
  reply: { stdout?: string; stderr?: string; exitCode?: number } = {},
): SpawnStub {
  const original = Bun.spawn;
  const calls: RecordedSpawn[] = [];
  const fake = (
    command: readonly string[],
    options?: { env?: Record<string, string | undefined> },
  ): unknown => {
    calls.push({ command: [...command], env: options?.env ?? {} });
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

/**
 * Set environment variables for the duration of `fn`, restoring exactly what was
 * there before — including restoring "absent" as absent rather than as `""`,
 * which is what a naive save/restore gets wrong and which matters here because
 * every connector treats empty and unset identically.
 */
export async function withEnv(
  env: Record<string, string | undefined>,
  fn: () => Promise<void> | void,
): Promise<void> {
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
    await fn();
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
