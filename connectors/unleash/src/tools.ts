import { z } from "zod";
import { type ConsentServer, createWriteToolRegistrar } from "../../../shared/consent-kit.ts";
import {
  createJsonGetter,
  createJsonSender,
  DEFAULT_SNIPPET_MAX,
  envAuthHeaders,
  type JsonApiConfig,
  requiredEnv,
} from "../../../shared/env-json-api.ts";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  fetchWithTimeout,
  mcpJsonResult as jsonResult,
} from "../../../shared/mcp-tool-kit.ts";
import { asRecord } from "../../../shared/search-filter.ts";
import { stripTrailingSlashes } from "../../../shared/strip-trailing-slashes.ts";

const URL_ENV = "UNLEASH_API_URL";

/** Plain http is accepted only for these: a local Unleash, where the token never leaves the host. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The Unleash instance root from `UNLEASH_API_URL`, read per call. Required, with no default:
 * Unleash is usually self-hosted. It must be an absolute https URL, or plain http to a loopback
 * host, and carry no credentials, query or fragment. A sub-path install
 * (`https://host/unleash`) is kept, and a trailing `/api`, which Unleash's own SDK docs put on
 * their URL, is accepted and not doubled. The value itself is never quoted back.
 */
export function unleashInstanceRoot(): string {
  const raw = requiredEnv(URL_ENV);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      `${URL_ENV} must be an https URL (plain http only for localhost, 127.0.0.1 or [::1])`,
    );
  }
  const loopbackHttp = parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname);
  if (parsed.protocol !== "https:" && !loopbackHttp) {
    throw new Error(
      `${URL_ENV} must be an https URL (plain http only for localhost, 127.0.0.1 or [::1]); the token would travel in clear text`,
    );
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error(`${URL_ENV} must not carry credentials; use UNLEASH_API_TOKEN instead`);
  }
  if (parsed.search !== "" || parsed.hash !== "" || raw.includes("?") || raw.includes("#")) {
    throw new Error(`${URL_ENV} must not carry a query or a fragment`);
  }
  const path = stripTrailingSlashes(parsed.pathname).replace(/\/api$/, "");
  return `${parsed.origin}${path}`;
}

/**
 * `Authorization: <token>`, the bare token with no scheme, which is what Unleash's Admin API
 * examples send (an admin token or a personal access token alike).
 */
const unleashHeaders = envAuthHeaders({ env: "UNLEASH_API_TOKEN", scheme: "" });

const api: JsonApiConfig = {
  base: () => `${unleashInstanceRoot()}/api/admin`,
  label: "Unleash",
  headers: unleashHeaders,
  // A self-hosted server that stops answering fails the call instead of hanging it.
  fetch: fetchWithTimeout,
};

const unGet = createJsonGetter(api);
const unSend = createJsonSender(api);

/** Tool names exposed by this connector — for contract/introspection tests. */
export const UNLEASH_TOOL_NAMES = [
  "unleash_list",
  "unleash_get",
  "unleash_search",
  "unleash_feature_state_get",
  "unleash_feature_toggle",
] as const;

/**
 * A project id, feature name or environment name: Unleash's URL-friendly set (letters, digits,
 * `.`, `_`, `~`, `-`), at most 100 characters, never `.` or `..` alone (`encodeURIComponent`
 * leaves a dot segment as is, and a URL parser collapses it out of the path).
 */
const nameArg = z
  .string()
  .regex(
    /^(?!\.{1,2}$)[A-Za-z0-9._~-]{1,100}$/,
    "letters, digits, '.', '_', '~' and '-' only, 1 to 100 characters; not '.' or '..'",
  );

const featureArgs = z.object({ projectId: nameArg, featureName: nameArg });

const featureEnvArgs = featureArgs.extend({ environment: nameArg });

type FeatureEnvArgs = z.infer<typeof featureEnvArgs>;

const DEFAULT_LIST_LIMIT = 100;
const DEFAULT_SEARCH_LIMIT = 50;
/** Strategies and variants a state read returns; the rest are counted, not shown. */
const MAX_STRATEGIES = 50;
const MAX_VARIANTS = 50;
/** Values shown per strategy constraint (a userId IN list can hold thousands). */
const MAX_CONSTRAINT_VALUES = 20;

function featurePath(p: { projectId: string; featureName: string }): string {
  return `/projects/${encodeURIComponent(p.projectId)}/features/${encodeURIComponent(p.featureName)}`;
}

function environmentPath(p: FeatureEnvArgs): string {
  return `${featurePath(p)}/environments/${encodeURIComponent(p.environment)}`;
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** `items` capped at `max`, with `<key>NotShown` disclosing what was cut. */
function capped(key: string, items: unknown[], max: number): Record<string, unknown> {
  return {
    [key]: items.slice(0, max),
    ...(items.length > max ? { [`${key}NotShown`]: items.length - max } : {}),
  };
}

function boundConstraint(raw: unknown): unknown {
  const c = asRecord(raw);
  if (c === undefined || !Array.isArray(c["values"])) return raw;
  return { ...c, ...capped("values", c["values"], MAX_CONSTRAINT_VALUES) };
}

function boundStrategy(raw: unknown): unknown {
  const s = asRecord(raw);
  if (s === undefined || !Array.isArray(s["constraints"])) return raw;
  return { ...s, constraints: s["constraints"].map(boundConstraint) };
}

/** Environments a feature read returns; the rest are counted, not shown. */
const MAX_ENVIRONMENTS = 50;

/** One entry of a feature's `environments`: its strategies and variants capped where present. */
function boundEnvironment(raw: unknown): unknown {
  const e = asRecord(raw);
  if (e === undefined) return raw;
  const strategies = e["strategies"];
  const variants = e["variants"];
  return {
    ...e,
    ...(Array.isArray(strategies)
      ? capped("strategies", strategies.map(boundStrategy), MAX_STRATEGIES)
      : {}),
    ...(Array.isArray(variants) ? capped("variants", variants, MAX_VARIANTS) : {}),
  };
}

/** One feature with every environment bounded as {@link boundEnvironment} does. */
async function readFeature(p: { projectId: string; featureName: string }): Promise<unknown> {
  const raw = await unGet(featurePath(p));
  const feature = asRecord(raw);
  if (feature === undefined || !Array.isArray(feature["environments"])) return raw;
  return {
    ...feature,
    ...capped("environments", feature["environments"].map(boundEnvironment), MAX_ENVIRONMENTS),
  };
}

/**
 * One feature in one environment: on or off, its activation strategies (capped, and each
 * constraint's value list capped) and its variants. Metrics counters are left out.
 */
async function readFeatureState(p: FeatureEnvArgs): Promise<Record<string, unknown>> {
  const raw = asRecord(await unGet(environmentPath(p))) ?? {};
  return {
    featureName: raw["featureName"] ?? p.featureName,
    environment: raw["environment"] ?? raw["name"] ?? p.environment,
    enabled: raw["enabled"],
    ...capped("strategies", arrayOf(raw["strategies"]).map(boundStrategy), MAX_STRATEGIES),
    ...capped("variants", arrayOf(raw["variants"]), MAX_VARIANTS),
    ...(raw["lastSeenAt"] === undefined ? {} : { lastSeenAt: raw["lastSeenAt"] }),
  };
}

/** Scope: `flag:<projectId>/<environment>/<featureName>`, one feature in one environment. */
function flagScope(p: FeatureEnvArgs): { kind: string; value: string } {
  return { kind: "flag", value: `${p.projectId}/${p.environment}/${p.featureName}` };
}

export function registerUnleashTools(
  server: ConsentServer & { tool: (...args: never) => unknown },
): void {
  const reg = createZodToolRegistrar(createRegisterSimpleTool(server));
  const registerWriteTool = createWriteToolRegistrar(server, {
    connector: "unleash",
    scopeEnv: "NIMBUS_MCP_UNLEASH_WRITE_SCOPE",
    scopeKinds: ["flag"],
  });

  reg(
    "unleash_list",
    "List Unleash projects, or the feature flags of one project. Without `projectId`, returns the instance's projects (`GET /api/admin/projects`). With `projectId`, returns that project's feature flag definitions (`GET /api/admin/projects/{projectId}/features`), capped at `limit` (default 100), with `total` and `notShown` counting the rest.",
    z.object({
      projectId: nameArg.optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    async (p) => {
      if (p.projectId === undefined) {
        return jsonResult(await unGet("/projects"));
      }
      const root = asRecord(await unGet(`/projects/${encodeURIComponent(p.projectId)}/features`));
      const features = arrayOf(root?.["features"]);
      const limit = p.limit ?? DEFAULT_LIST_LIMIT;
      return jsonResult({
        projectId: p.projectId,
        features: features.slice(0, limit),
        total: features.length,
        ...(features.length > limit ? { notShown: features.length - limit } : {}),
      });
    },
  );

  reg(
    "unleash_get",
    "Fetch one Unleash feature flag by project id + feature name (`GET /api/admin/projects/{projectId}/features/{featureName}`): its definition and each environment with its enabled state, strategies and variants. Bounded like `unleash_feature_state_get`: at most 50 environments, 50 strategies and 50 variants each, 20 values per strategy constraint, the rest counted in `*NotShown`.",
    featureArgs,
    async (p) => jsonResult(await readFeature(p)),
  );

  reg(
    "unleash_search",
    "Search Unleash feature flags by name or tag across every project, or in one project when `projectId` is given (`GET /api/admin/search/features`, which recent Unleash versions provide). Returns `{ matches, total }`, at most `limit` matches (default 50).",
    z.object({
      query: z.string().min(1).max(200),
      projectId: nameArg.optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    async (p) => {
      const search = new URLSearchParams({
        query: p.query,
        limit: String(p.limit ?? DEFAULT_SEARCH_LIMIT),
        offset: "0",
      });
      if (p.projectId !== undefined) search.set("project", `IS:${p.projectId}`);
      const root = asRecord(await unGet(`/search/features?${search.toString()}`));
      return jsonResult({
        matches: arrayOf(root?.["features"]),
        ...(root?.["total"] === undefined ? {} : { total: root["total"] }),
      });
    },
  );

  reg(
    "unleash_feature_state_get",
    "Read one Unleash feature in ONE environment (`GET /api/admin/projects/{projectId}/features/{featureName}/environments/{environment}`): `enabled`, the activation `strategies` (capped at 50, each constraint's values capped at 20, the rest counted in `*NotShown`) and `variants` (capped at 50).",
    featureEnvArgs,
    async (p) => jsonResult(await readFeatureState(p)),
  );

  registerWriteTool(
    "unleash_feature_toggle",
    {
      mutates: "unleash.feature.toggle",
      // Not fully undone by toggling back: enabling an environment with no active strategy makes
      // Unleash add a default strategy, which turning it off leaves in place. So the environment's
      // previous state, strategies included, is recorded in the audit pre-state first; this tool
      // does not restore the strategies.
      recoverable: false,
      capturePreState: readFeatureState,
      scopeTargetOf: flagScope,
    },
    "Turn an Unleash feature on or off in ONE environment (`POST /api/admin/projects/{projectId}/features/{featureName}/environments/{environment}/on` or `/off`). When this enables an environment that has no active strategy (none, or only disabled ones), Unleash itself adds a default strategy, a 100% rollout that serves everyone unless the project sets another default, and toggling off does not remove it: toggling back restores the on/off state, not the strategies. Existing strategies and variants are otherwise left as they are. The environment's previous state is recorded before the write. Unleash refuses it while change requests are enabled for the environment, with its own message. The result carries `confirmed`: true only when a read of the environment after the write shows the requested state.",
    featureEnvArgs.extend({ enabled: z.boolean() }),
    async (p) => {
      await unSend("POST", `${environmentPath(p)}/${p.enabled ? "on" : "off"}`, undefined);
      // The write answered 2xx, so it was applied: a failed read-back is reported, not thrown,
      // since a throw would read as a failed write.
      let after: Record<string, unknown> | undefined;
      let confirmError: string | undefined;
      try {
        after = await readFeatureState(p);
      } catch (err) {
        confirmError = (err instanceof Error ? err.message : String(err)).slice(
          0,
          DEFAULT_SNIPPET_MAX,
        );
      }
      return jsonResult({
        ok: true,
        projectId: p.projectId,
        featureName: p.featureName,
        environment: p.environment,
        confirmed: after?.["enabled"] === p.enabled,
        enabled: after?.["enabled"],
        ...(confirmError === undefined ? {} : { confirmError }),
      });
    },
  );
}
