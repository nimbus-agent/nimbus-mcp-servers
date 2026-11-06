import { z } from "zod";
import { type ConsentServer, createWriteToolRegistrar } from "../../../shared/consent-kit.ts";
import {
  createJsonGetter,
  createJsonSender,
  envAuthHeaders,
  type JsonApiConfig,
  optionalEnv,
} from "../../../shared/env-json-api.ts";
import { matchesResult } from "../../../shared/mcp-search-tool.ts";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
} from "../../../shared/mcp-tool-kit.ts";
import { echoedOn, projectFlagState, rolloutEchoed, rolloutWeightsOf } from "./flag-state.ts";
import { filterLaunchDarklyFlags } from "./search-filter.ts";

const DEFAULT_BASE = "https://app.launchdarkly.com";

const api: JsonApiConfig = {
  // `optionalEnv`, not `optionalBaseUrl`: a trailing slash on the override is left as given.
  base: () => `${optionalEnv("LAUNCHDARKLY_BASE_URL", DEFAULT_BASE)}/api/v2`,
  label: "LaunchDarkly",
  headers: envAuthHeaders({ env: "LAUNCHDARKLY_TOKEN", scheme: "" }),
};

const ldGet = createJsonGetter(api);
const ldSend = createJsonSender(api);

/**
 * A semantic patch needs `domain-model=launchdarkly.semanticpatch` appended to Content-Type, else
 * LaunchDarkly treats the body as a JSON patch and answers 400
 * (https://launchdarkly.com/docs/guides/api/rest-api, "append `domain-model=launchdarkly.semanticpatch`
 * to your `Content-Type` header").
 */
const SEMANTIC_PATCH_HEADERS = {
  "Content-Type": "application/json; domain-model=launchdarkly.semanticpatch",
} as const;

/** Written into the flag's change history, so the audit trail says who made the change. */
const CHANGE_COMMENT = "Changed by Nimbus after owner approval";

/** Tool names exposed by this connector — for contract/introspection tests. */
export const LAUNCHDARKLY_TOOL_NAMES = [
  "launchdarkly_list",
  "launchdarkly_get",
  "launchdarkly_search",
  "launchdarkly_flag_state_get",
  "launchdarkly_flag_toggle",
  "launchdarkly_flag_rollout_set",
] as const;

/**
 * LaunchDarkly project, environment and flag keys: letters, digits, `.`, `_`, `-`, but never `.` or
 * `..` alone: `encodeURIComponent("..")` is `..`, and a URL parser collapses it out of the path.
 */
const keyArg = z
  .string()
  .regex(
    /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/,
    "letters, digits, '.', '_' and '-' only; not '.' or '..'",
  );

/** The read tools keep accepting any key (it is percent-encoded), but never a dot segment. */
const readKeyArg = z
  .string()
  .min(1)
  .regex(/^(?!\.{1,2}$)/, "not '.' or '..'");

const flagArgs = z.object({
  projectKey: keyArg,
  environmentKey: keyArg,
  flagKey: keyArg,
});

type FlagArgs = z.infer<typeof flagArgs>;

function flagPath(p: { projectKey: string; flagKey: string }): string {
  return `/flags/${encodeURIComponent(p.projectKey)}/${encodeURIComponent(p.flagKey)}`;
}

/** One environment's slice of a flag, so the read stays small however many environments exist. */
async function readFlagState(p: FlagArgs): Promise<Record<string, unknown>> {
  const search = new URLSearchParams({ env: p.environmentKey });
  const raw = await ldGet(`${flagPath(p)}?${search.toString()}`);
  return projectFlagState(raw, p);
}

/**
 * The result of a flag change: the facts, not LaunchDarkly's whole flag document. `confirmed` is
 * true only when the reply SHOWS the requested state; false means the server accepted the write
 * but its reply does not show the new state.
 */
function changed(
  p: FlagArgs,
  response: unknown,
  confirmed: (response: unknown) => boolean,
): Record<string, unknown> {
  const flag = (response ?? {}) as { environments?: Record<string, { on?: unknown }> };
  return {
    ok: true,
    confirmed: confirmed(response),
    projectKey: p.projectKey,
    environmentKey: p.environmentKey,
    flagKey: p.flagKey,
    on: flag.environments?.[p.environmentKey]?.on,
  };
}

/** Scope: `flag:<projectKey>/<environmentKey>/<flagKey>`. */
function flagScope(p: FlagArgs): { kind: string; value: string } {
  return { kind: "flag", value: `${p.projectKey}/${p.environmentKey}/${p.flagKey}` };
}

export function registerLaunchdarklyTools(
  server: ConsentServer & { tool: (...args: never) => unknown },
): void {
  const reg = createZodToolRegistrar(createRegisterSimpleTool(server));
  const registerWriteTool = createWriteToolRegistrar(server, {
    connector: "launchdarkly",
    scopeEnv: "NIMBUS_MCP_LAUNCHDARKLY_WRITE_SCOPE",
    scopeKinds: ["flag"],
  });

  reg(
    "launchdarkly_list",
    "List LaunchDarkly projects, or feature flags for a project. Without `projectKey`, returns the account's projects (`/projects`). With `projectKey`, returns that project's flags (`/flags/{projectKey}`), capped at `limit` (default 100).",
    z.object({
      projectKey: readKeyArg.optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    async (p) => {
      if (p.projectKey === undefined) {
        return jsonResult(await ldGet("/projects"));
      }
      const search = new URLSearchParams({ summary: "true", limit: String(p.limit ?? 100) });
      return jsonResult(
        await ldGet(`/flags/${encodeURIComponent(p.projectKey)}?${search.toString()}`),
      );
    },
  );

  reg(
    "launchdarkly_get",
    "Fetch one LaunchDarkly feature flag by project key + flag key. Throws when no match is found.",
    z.object({
      projectKey: readKeyArg,
      flagKey: readKeyArg,
    }),
    async (p) => {
      return jsonResult(
        await ldGet(`/flags/${encodeURIComponent(p.projectKey)}/${encodeURIComponent(p.flagKey)}`),
      );
    },
  );

  reg(
    "launchdarkly_search",
    "Substring search across a project's feature flags. Matches the query against flag key, name, description, and tags (case-insensitive). Returns a `{ matches: [...] }` envelope.",
    z.object({
      projectKey: readKeyArg,
      query: z.string().min(1),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    async (p) => {
      const search = new URLSearchParams({ summary: "true", limit: "500" });
      const root = await ldGet(`/flags/${encodeURIComponent(p.projectKey)}?${search.toString()}`);
      const flags = (root as { items?: unknown[] } | null)?.items;
      return matchesResult(flags, filterLaunchDarklyFlags, p);
    },
  );

  reg(
    "launchdarkly_flag_state_get",
    "Read one feature flag's state in ONE environment (`GET /flags/{projectKey}/{flagKey}?env={environmentKey}`): on/off, off variation, fallthrough (a single variation or a percentage rollout, with variation ids and weights in percent), the variation list and the environment's version. Smaller than `launchdarkly_get`, which returns every environment. Variation references are read as indices into `variations` (LaunchDarkly's schema is ambiguous for `offVariation`); the raw number is returned beside the resolved id.",
    flagArgs,
    async (p) => jsonResult(await readFlagState(p)),
  );

  registerWriteTool(
    "launchdarkly_flag_toggle",
    {
      mutates: "launchdarkly.flag.toggle",
      recoverable: true,
      scopeTargetOf: flagScope,
    },
    "Turn a feature flag on or off in ONE environment (`PATCH /flags/{projectKey}/{flagKey}`, semantic patch turnFlagOn / turnFlagOff). Reversible by toggling back. An environment that requires approvals answers 405 and nothing changes.",
    flagArgs.extend({ on: z.boolean() }),
    async (p) => {
      const response = await ldSend(
        "PATCH",
        flagPath(p),
        {
          environmentKey: p.environmentKey,
          comment: CHANGE_COMMENT,
          instructions: [{ kind: p.on ? "turnFlagOn" : "turnFlagOff" }],
        },
        SEMANTIC_PATCH_HEADERS,
      );
      return jsonResult(changed(p, response, (r) => echoedOn(r, p.environmentKey) === p.on));
    },
  );

  registerWriteTool(
    "launchdarkly_flag_rollout_set",
    {
      mutates: "launchdarkly.flag.rollout.set",
      // The previous fallthrough (variation or weights, bucketBy, context kind) is recorded in the
      // audit pre-state. This tool does not restore it, so the write is not marked recoverable.
      recoverable: false,
      capturePreState: readFlagState,
      scopeTargetOf: flagScope,
    },
    "Set a feature flag's fallthrough to a percentage rollout in ONE environment (`PATCH /flags/{projectKey}/{flagKey}`, semantic patch updateFallthroughVariationOrRollout). `weights` maps variation ids (from `launchdarkly_flag_state_get`) to percent; they must sum to exactly 100 with at most 3 decimals, else nothing is sent. The previous fallthrough is recorded in the audit pre-state; this tool does not restore it, and a rollout's bucketBy / context kind are not set by it.",
    flagArgs.extend({
      weights: z
        .array(
          z.object({
            variationId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
            percent: z.number().min(0).max(100),
          }),
        )
        .min(1)
        .max(20),
    }),
    async (p) => {
      // Validated here, not with `.refine` on the schema: a refined schema loses `.shape`, which
      // the registrar passes to the MCP SDK as the tool's input schema.
      const rolloutWeights = rolloutWeightsOf(p.weights);
      const response = await ldSend(
        "PATCH",
        flagPath(p),
        {
          environmentKey: p.environmentKey,
          comment: CHANGE_COMMENT,
          instructions: [{ kind: "updateFallthroughVariationOrRollout", rolloutWeights }],
        },
        SEMANTIC_PATCH_HEADERS,
      );
      return jsonResult(
        changed(p, response, (r) => rolloutEchoed(r, p.environmentKey, rolloutWeights)),
      );
    },
  );
}
