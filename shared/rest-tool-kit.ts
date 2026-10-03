/**
 * rest-tool-kit — the REST tool plumbing for token-auth connectors.
 *
 * `makeRestFetcher` and `makeRestToolRegistrar` originated here and were upstreamed
 * to the SDK in 1.11.0. The SDK is now their single owner; this module re-exports
 * them so the ~99 connectors keep their existing relative imports. Named
 * re-exports, deliberately not `export *` — see the note in `mcp-tool-kit.ts`.
 *
 * The two helpers defined BELOW are this repository's own and stay here:
 * {@link makeRestWriteToolRegistrar} registers through the consent kit, which the
 * SDK does not have, and {@link toRestFetchResult} is the tail of the connector
 * fetches whose credential is not a Bearer token, which the SDK's fetch cannot send.
 */

import {
  type HttpJsonBodyResponse,
  mcpJsonResultIfOk,
  type RestFetchResult,
  requireProcessEnv,
  type ZodObjectSchema,
} from "@nimbus-dev/sdk/connector-kit";
import type { WriteToolConfig, WriteToolRegistrar } from "./consent-kit.ts";

export type {
  RestFetcherConfig,
  RestFetchResult,
  RestToolRegistrar,
} from "@nimbus-dev/sdk/connector-kit";
export { makeRestFetcher, makeRestToolRegistrar } from "@nimbus-dev/sdk/connector-kit";

/** The per-connector registrar {@link makeRestWriteToolRegistrar} builds. */
export type RestWriteToolRegistrar = <T>(
  name: string,
  cfg: WriteToolConfig<T>,
  description: string,
  schema: ZodObjectSchema<T>,
  buildPath: (args: T) => string,
  buildInit?: (args: T) => RequestInit,
) => void;

/**
 * The write twin of `makeRestToolRegistrar`: the same standard tool body —
 * `token = requireProcessEnv(<env>)`, `res = await <fetch>(token, buildPath(args)
 * [, buildInit(args)])`, `return mcpJsonResultIfOk(<label>, res, <snippetMax>)` —
 * registered through the connector's consent-kit write registrar instead of its
 * read-only one, so every mutation it registers is gated.
 *
 * The connector passes its OWN `registerWriteTool` in rather than this kit building
 * one: the standalone launcher decides whether a connector's mutations are gated by
 * reading that connector's own `server.ts`/`tools.ts`, and a registrar constructed in
 * here would be invisible to it.
 */
export function makeRestWriteToolRegistrar(cfg: {
  readonly registerWriteTool: WriteToolRegistrar;
  readonly tokenEnv: string;
  readonly serviceLabel: string;
  readonly fetch: (
    token: string,
    pathOrUrl: string,
    init?: RequestInit,
  ) => Promise<HttpJsonBodyResponse>;
  /** Body-snippet length for the `<label> <status>: <snippet>` error (mcpJsonResultIfOk default 300). */
  readonly snippetMax?: number;
}): RestWriteToolRegistrar {
  return (name, toolCfg, description, schema, buildPath, buildInit) => {
    cfg.registerWriteTool(name, toolCfg, description, schema, async (args) => {
      const token = requireProcessEnv(cfg.tokenEnv);
      const res = await cfg.fetch(token, buildPath(args), buildInit?.(args));
      return mcpJsonResultIfOk(cfg.serviceLabel, res, cfg.snippetMax);
    });
  };
}

/**
 * Read a response into the {@link RestFetchResult} shape a REST tool's fetch
 * returns. `json` is the parsed body, or `null` when the body is not JSON (an empty
 * 204, an HTML error page): what that means is the tool's decision, not this one's.
 */
export async function toRestFetchResult(res: Response): Promise<RestFetchResult> {
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json, text };
}
