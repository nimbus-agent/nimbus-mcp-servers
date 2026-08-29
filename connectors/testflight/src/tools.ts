import { signAppStoreConnectJwt } from "@nimbus-dev/sdk";
import { z } from "zod";
import { createJsonGetter } from "../../../shared/env-json-api.ts";
import { matchesResult } from "../../../shared/mcp-search-tool.ts";
import { mcpJsonResult as jsonResult } from "../../../shared/mcp-tool-kit.ts";
import type { ZodToolRegistrar } from "../../../shared/run-read-only-mcp-connector.ts";
import { jwtParamsFromEnv } from "./jwt.ts";
import { filterTestflightBuilds } from "./search-filter.ts";

const APPSTORECONNECT_API = "https://api.appstoreconnect.apple.com";

function authHeader(): Record<string, string> {
  const token = signAppStoreConnectJwt(jwtParamsFromEnv());
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

const appstoreGet = createJsonGetter({
  base: APPSTORECONNECT_API,
  label: "App Store Connect",
  headers: authHeader,
});

function buildsPath(appId: string, limit: number): string {
  return `/v1/builds?filter[app]=${encodeURIComponent(appId)}&sort=-uploadedDate&limit=${String(limit)}`;
}

/** Tool names exposed by this connector — for contract/introspection tests. */
export const TESTFLIGHT_TOOL_NAMES = [
  "testflight_list",
  "testflight_get",
  "testflight_search",
] as const;

export function registerTestflightTools(reg: ZodToolRegistrar): void {
  reg(
    "testflight_list",
    "List TestFlight resources via the App Store Connect API. When `appId` is omitted, returns the user's accessible apps via `GET /v1/apps`. When `appId` is provided, returns that app's most-recent builds via `GET /v1/builds?filter[app]=<id>&sort=-uploadedDate` (limit optional).",
    z.object({
      appId: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    async (p) => {
      if (p.appId === undefined) {
        return jsonResult(await appstoreGet("/v1/apps"));
      }
      return jsonResult(await appstoreGet(buildsPath(p.appId, p.limit ?? 50)));
    },
  );

  reg(
    "testflight_get",
    "Fetch a single TestFlight resource. When `buildId` is provided, returns the build via `GET /v1/builds/<buildId>`. When omitted, returns the app via `GET /v1/apps/<appId>`.",
    z.object({
      appId: z.string().min(1),
      buildId: z.string().min(1).optional(),
    }),
    async (p) => {
      if (p.buildId === undefined) {
        return jsonResult(await appstoreGet(`/v1/apps/${encodeURIComponent(p.appId)}`));
      }
      return jsonResult(await appstoreGet(`/v1/builds/${encodeURIComponent(p.buildId)}`));
    },
  );

  reg(
    "testflight_search",
    "Substring search across a TestFlight app's recent builds. Matches the query against each build's `version`, `processingState`, `minOsVersion`, and `id` (case-insensitive). Returns a `{ matches: [...] }` envelope.",
    z.object({
      appId: z.string().min(1),
      query: z.string().min(1),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    async (p) => {
      const root = await appstoreGet(buildsPath(p.appId, 200));
      const data = (root as { data?: unknown[] } | null)?.data;
      return matchesResult(data, filterTestflightBuilds, p);
    },
  );
}
