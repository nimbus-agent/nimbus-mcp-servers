import { z } from "zod";
import { type ConsentServer, createWriteToolRegistrar } from "../../../shared/consent-kit.ts";
import {
  createJsonGetter,
  createJsonSender,
  envAuthHeaders,
  type JsonApiConfig,
  optionalEnv,
} from "../../../shared/env-json-api.ts";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
} from "../../../shared/mcp-tool-kit.ts";
import { filterFlagsmithFeatures } from "./search-filter.ts";

const DEFAULT_API_BASE = "https://api.flagsmith.com";

/**
 * `Authorization: Token <FLAGSMITH_TOKEN>` for reads and writes alike. Flagsmith's swagger lists
 * this scheme ("tokenAuth", prefix "Token") on the `__future__` operations too, beside the
 * organisation "Master API Key" scheme; the docs page for those operations shows `Api-Key`, which
 * is that second scheme. One factory, so a switch is one line.
 */
const flagsmithHeaders = envAuthHeaders({ env: "FLAGSMITH_TOKEN", scheme: "Token" });

const apiV1: JsonApiConfig = {
  // `optionalEnv`, not `optionalBaseUrl`: a trailing slash on the override is left as given.
  base: () => `${optionalEnv("FLAGSMITH_API_BASE", DEFAULT_API_BASE)}/api/v1`,
  label: "Flagsmith",
  headers: flagsmithHeaders,
};

/**
 * The environment-level feature-state endpoints. EXPERIMENTAL ("may change without notice",
 * https://docs.flagsmith.com/managing-flags/updating-flags). Why not the v1 route: Flagsmith's own
 * repository calls `/api/v1/environments/{key}/featurestates/` "deprecated" (PR 8732, "the legacy
 * feature state APIs"), the docs site documents only the `__future__` pair, and the v1 write needs
 * a feature-state id looked up first. `__future__` takes the feature id directly. Isolated here so
 * a change of path is one edit.
 */
const apiFuture: JsonApiConfig = {
  ...apiV1,
  base: () => `${optionalEnv("FLAGSMITH_API_BASE", DEFAULT_API_BASE)}/api/__future__`,
};

const fsGet = createJsonGetter(apiV1);
const fsFutureGet = createJsonGetter(apiFuture);
const fsFutureSend = createJsonSender(apiFuture);

function featuresFromPage(root: unknown): unknown[] {
  if (Array.isArray(root)) {
    return root;
  }
  const results = (root as { results?: unknown } | null)?.results;
  return Array.isArray(results) ? results : [];
}

/** Tool names exposed by this connector — for contract/introspection tests. */
export const FLAGSMITH_TOOL_NAMES = [
  "flagsmith_list",
  "flagsmith_get",
  "flagsmith_search",
  "flagsmith_feature_state_get",
  "flagsmith_feature_state_set",
] as const;

/** Segment overrides returned by a state read; the rest are counted, not shown (size bound). */
const MAX_SEGMENT_OVERRIDES = 50;

const featureStateArgs = z.object({
  environmentKey: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "letters, digits, '_' and '-' only"),
  featureId: z.number().int().min(1),
});

type FeatureStateArgs = z.infer<typeof featureStateArgs>;

function statePath(p: FeatureStateArgs): string {
  return `/environments/${encodeURIComponent(p.environmentKey)}/features/${String(p.featureId)}/`;
}

/** `{ environment_default, segment_overrides }` with the overrides capped and the cap disclosed. */
async function readFeatureState(p: FeatureStateArgs): Promise<Record<string, unknown>> {
  const raw = (await fsFutureGet(statePath(p))) as {
    environment_default?: unknown;
    segment_overrides?: unknown;
  } | null;
  const overrides = Array.isArray(raw?.segment_overrides) ? raw.segment_overrides : [];
  return {
    environment_default: raw?.environment_default,
    segment_overrides: overrides.slice(0, MAX_SEGMENT_OVERRIDES),
    ...(overrides.length > MAX_SEGMENT_OVERRIDES
      ? { segmentOverridesNotShown: overrides.length - MAX_SEGMENT_OVERRIDES }
      : {}),
  };
}

const valueSchema = z.object({
  type: z.enum(["string", "integer", "boolean"]),
  value: z.string().max(20_000),
});

/** The typed value must parse as its type; checked in the handler, before any request. */
function assertValueMatchesType(v: z.infer<typeof valueSchema>): void {
  if (v.type === "integer" && !/^-?\d+$/.test(v.value)) {
    throw new Error(`value ${JSON.stringify(v.value)} is not an integer; nothing was sent`);
  }
  if (v.type === "boolean" && v.value !== "true" && v.value !== "false") {
    throw new Error(`value ${JSON.stringify(v.value)} is not true or false; nothing was sent`);
  }
}

export function registerFlagsmithTools(
  server: ConsentServer & { tool: (...args: never) => unknown },
): void {
  const reg = createZodToolRegistrar(createRegisterSimpleTool(server));
  const registerWriteTool = createWriteToolRegistrar(server, {
    connector: "flagsmith",
    scopeEnv: "NIMBUS_MCP_FLAGSMITH_WRITE_SCOPE",
    scopeKinds: ["flag"],
  });

  reg(
    "flagsmith_list",
    "List Flagsmith projects, or feature flags for a project. Without `projectId`, returns the account's projects (`/projects/`). With `projectId`, returns that project's feature flags (`/projects/{projectId}/features/`), capped at `limit` (default 100).",
    z.object({
      projectId: z.number().int().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    async (p) => {
      if (p.projectId === undefined) {
        return jsonResult(await fsGet("/projects/"));
      }
      const search = new URLSearchParams({ page_size: String(p.limit ?? 100) });
      return jsonResult(
        await fsGet(
          `/projects/${encodeURIComponent(String(p.projectId))}/features/?${search.toString()}`,
        ),
      );
    },
  );

  reg(
    "flagsmith_get",
    "Fetch one Flagsmith feature flag by project id + feature name. Flagsmith has no GET-by-name endpoint, so this searches the project's features and narrows to the exact-name match. Throws when no match is found.",
    z.object({
      projectId: z.number().int(),
      featureName: z.string().min(1),
    }),
    async (p) => {
      const search = new URLSearchParams({ page_size: "100", search: p.featureName });
      const root = await fsGet(
        `/projects/${encodeURIComponent(String(p.projectId))}/features/?${search.toString()}`,
      );
      const match = featuresFromPage(root).find(
        (f) =>
          f !== null && typeof f === "object" && (f as { name?: unknown }).name === p.featureName,
      );
      if (match === undefined) {
        throw new Error(`Flagsmith feature not found: ${p.featureName}`);
      }
      return jsonResult(match);
    },
  );

  reg(
    "flagsmith_search",
    "Substring search across a project's feature flags. Matches the query against flag name, description, and tags (case-insensitive). Returns a `{ matches: [...] }` envelope.",
    z.object({
      projectId: z.number().int(),
      query: z.string().min(1),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    async (p) => {
      const search = new URLSearchParams({ page_size: "500" });
      const root = await fsGet(
        `/projects/${encodeURIComponent(String(p.projectId))}/features/?${search.toString()}`,
      );
      const matches = filterFlagsmithFeatures(featuresFromPage(root), {
        query: p.query,
        limit: p.limit,
      });
      return jsonResult({ matches });
    },
  );

  reg(
    "flagsmith_feature_state_get",
    "Read one feature's state in ONE environment (`GET /api/__future__/environments/{environmentKey}/features/{featureId}/`, an EXPERIMENTAL Flagsmith endpoint): `environment_default` (enabled, typed value, variants) and `segment_overrides` (capped at 50, the remainder counted in `segmentOverridesNotShown`). Identity overrides are not covered.",
    featureStateArgs,
    async (p) => jsonResult(await readFeatureState(p)),
  );

  registerWriteTool(
    "flagsmith_feature_state_set",
    {
      mutates: "flagsmith.feature.state.set",
      // The previous state is recorded in the audit pre-state; this tool does not restore it.
      recoverable: false,
      capturePreState: readFeatureState,
      scopeTargetOf: (p) => ({ kind: "flag", value: `${p.environmentKey}/${String(p.featureId)}` }),
    },
    "Enable or disable a feature in ONE environment, optionally setting its typed value (`PATCH /api/__future__/environments/{environmentKey}/features/{featureId}/`, an EXPERIMENTAL Flagsmith endpoint that may change without notice). Omitting `value` is intended to leave the value alone (PATCH merge semantics are unverified against a live server); segment and identity overrides are untouched. Flagsmith refuses it while change requests are enabled for the environment, with its own message. The result carries `confirmed`: true only when the reply shows the requested `enabled`; false means the server accepted the write but its reply does not show the new state.",
    featureStateArgs.extend({ enabled: z.boolean(), value: valueSchema.optional() }),
    async (p) => {
      // Validated here, not with `.refine`: a refined schema loses `.shape` (the registrar needs it).
      if (p.value !== undefined) assertValueMatchesType(p.value);
      const response = (await fsFutureSend("PATCH", statePath(p), {
        environment_default: {
          enabled: p.enabled,
          ...(p.value === undefined ? {} : { value: p.value }),
        },
      })) as { environment_default?: { enabled?: unknown } } | null;
      return jsonResult({
        ok: true,
        environmentKey: p.environmentKey,
        featureId: p.featureId,
        // true only when the reply shows the state that was asked for; false means the server
        // accepted the write but its reply does not show the new state.
        confirmed: response?.environment_default?.enabled === p.enabled,
        enabled: response?.environment_default?.enabled,
      });
    },
  );
}
