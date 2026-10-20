/**
 * The reserved `__nimbus_sync` tool (sync contract v1, `@nimbus-dev/sdk/sync`). Registered by the
 * extension entry (`extension.ts`) ONLY: the standalone and gateway-bundled `server.ts` never
 * offers it. A read tool — it only GETs Readwise — and it takes no URL: the host is fixed in
 * `readwise-base.ts`, and the cursor only ever selects a stream and a page number.
 */
import { SYNC_TOOL_NAME, type SyncRequest } from "@nimbus-dev/sdk/sync";
import { z } from "zod";
import type { McpListResult } from "../../../shared/mcp-tool-kit.ts";
import type { ZodToolRegistrar } from "../../../shared/run-read-only-mcp-connector.ts";
import { type ReadwiseFetch, readwiseSyncPage } from "./sync.ts";

const SYNC_REQUEST = z.object({
  cursor: z.string().nullable(),
  depth: z.enum(["metadata_only", "summary", "full"]),
  historyFloorMs: z.number().optional(),
});

/**
 * The parsed arguments as the SDK's `SyncRequest`. Typed both ways on purpose: `depth` must stay the
 * SDK's `SyncDepth`, and an absent `historyFloorMs` stays absent rather than `undefined`.
 */
function toSyncRequest(args: z.infer<typeof SYNC_REQUEST>): SyncRequest {
  return {
    cursor: args.cursor,
    depth: args.depth,
    ...(args.historyFloorMs === undefined ? {} : { historyFloorMs: args.historyFloorMs }),
  };
}

export interface ReadwiseSyncToolOptions {
  /** Defaults to the global `fetch`; tests serve Readwise through it. */
  readonly fetch?: ReadwiseFetch;
}

export function registerReadwiseSyncTool(
  reg: ZodToolRegistrar,
  options: ReadwiseSyncToolOptions = {},
): void {
  reg(
    SYNC_TOOL_NAME,
    "Nimbus gateway sync (contract v1): one page of the user's Readwise highlights, then books, per call. Reserved for the gateway.",
    SYNC_REQUEST,
    async (args): Promise<McpListResult> => {
      const request = toSyncRequest(args);
      // `depth` and `historyFloorMs` are accepted and ignored: the gateway applies depth itself,
      // and Readwise's walk was never bounded by a history floor.
      const response = await readwiseSyncPage(request.cursor, {
        // Read per call, as the read tools do, so a token set after start-up is used.
        token: process.env["READWISE_TOKEN"],
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
      return { content: [{ type: "text", text: JSON.stringify(response) }] };
    },
  );
}
