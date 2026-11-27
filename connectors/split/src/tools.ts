import { z } from "zod";
import { type ConsentServer, createWriteToolRegistrar } from "../../../shared/consent-kit.ts";
import {
  createJsonGetter,
  createJsonSender,
  DEFAULT_SNIPPET_MAX,
  envAuthHeaders,
  type JsonApiConfig,
} from "../../../shared/env-json-api.ts";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
} from "../../../shared/mcp-tool-kit.ts";
import { asRecord } from "../../../shared/search-filter.ts";
import { filterSplits } from "./search-filter.ts";

/**
 * Split's Admin API. Fixed, with no override: Split is SaaS only, so the admin key goes to this
 * host and nowhere else.
 */
const API_BASE = "https://api.split.io/internal/api/v2";

const api: JsonApiConfig = {
  base: API_BASE,
  label: "Split",
  // `Authorization: Bearer <admin API key>`, as Split's Admin API reference shows.
  headers: envAuthHeaders({ env: "SPLIT_ADMIN_API_KEY" }),
};

const splitGet = createJsonGetter(api);
const splitSend = createJsonSender(api);

/** Tool names exposed by this connector — for contract/introspection tests. */
export const SPLIT_TOOL_NAMES = [
  "split_list",
  "split_get",
  "split_search",
  "split_definition_get",
  "split_kill",
  "split_restore",
] as const;

/**
 * A workspace id, split name or environment id or name: letters, digits, `.`, `_`, `~`, `-`, at
 * most 128 characters, never `.` or `..` alone (`encodeURIComponent` leaves a dot segment as is,
 * and a URL parser collapses it out of the path).
 */
const idArg = z
  .string()
  .regex(
    /^(?!\.{1,2}$)[A-Za-z0-9._~-]{1,128}$/,
    "letters, digits, '.', '_', '~' and '-' only, 1 to 128 characters; not '.' or '..'",
  );

const splitArgs = z.object({ workspaceId: idArg, splitName: idArg });

const definitionArgs = splitArgs.extend({ environment: idArg });

type DefinitionArgs = z.infer<typeof definitionArgs>;

/** Split's own page cap for the split list. */
const PAGE_SIZE = 50;
/** Pages a search walks at most (1,000 splits); a longer workspace is reported as truncated. */
const MAX_SEARCH_PAGES = 20;
const MAX_TREATMENTS = 50;
const MAX_RULES = 20;
const MAX_MATCHERS = 20;
const MAX_BUCKETS = 50;
/** Entries shown per list inside a matcher (a whitelist can hold thousands of keys). */
const MAX_MATCHER_VALUES = 20;
/** Characters shown of one treatment's dynamic configuration (a JSON string). */
const MAX_CONFIGURATION_CHARS = 2000;

function splitPath(p: { workspaceId: string; splitName: string }): string {
  return `/splits/ws/${encodeURIComponent(p.workspaceId)}/${encodeURIComponent(p.splitName)}`;
}

function definitionPath(p: DefinitionArgs): string {
  return `${splitPath(p)}/environments/${encodeURIComponent(p.environment)}`;
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

/** Entries shown per list in a split's metadata (tags, flag sets). */
const MAX_SPLIT_LIST = 50;

/** A split's metadata with every top-level list capped; scalars and objects as given. */
function boundSplit(raw: unknown): unknown {
  const s = asRecord(raw);
  if (s === undefined) return raw;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(s)) {
    Object.assign(
      out,
      Array.isArray(value) ? capped(key, value, MAX_SPLIT_LIST) : { [key]: value },
    );
  }
  return out;
}

function boundTreatment(raw: unknown): unknown {
  const t = asRecord(raw);
  const config = t?.["configurations"];
  if (t === undefined || typeof config !== "string" || config.length <= MAX_CONFIGURATION_CHARS) {
    return raw;
  }
  return {
    ...t,
    configurations: config.slice(0, MAX_CONFIGURATION_CHARS),
    configurationsTruncated: true,
  };
}

/** A matcher with every list in it capped (`strings`, a whitelist's keys, and the like). */
function boundMatcher(raw: unknown): unknown {
  const m = asRecord(raw);
  if (m === undefined) return raw;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(m)) {
    Object.assign(
      out,
      Array.isArray(value) ? capped(key, value, MAX_MATCHER_VALUES) : { [key]: value },
    );
  }
  return out;
}

function boundRule(raw: unknown): unknown {
  const r = asRecord(raw);
  if (r === undefined) return raw;
  const condition = asRecord(r["condition"]);
  return {
    ...r,
    ...capped("buckets", arrayOf(r["buckets"]), MAX_BUCKETS),
    ...(condition === undefined
      ? {}
      : {
          condition: {
            ...condition,
            ...capped("matchers", arrayOf(condition["matchers"]).map(boundMatcher), MAX_MATCHERS),
          },
        }),
  };
}

const DEFINITION_FIELDS = [
  "name",
  "environment",
  "trafficType",
  "killed",
  "defaultTreatment",
  "baselineTreatment",
  "trafficAllocation",
  "creationTime",
  "lastUpdateTime",
  "lastTrafficReceivedAt",
] as const;

/**
 * One split in one environment, bounded: the scalar facts as given, treatments (capped, each
 * configuration cut at 2,000 characters), targeting rules (capped, each matcher's lists capped)
 * and the default rule.
 */
async function readDefinition(p: DefinitionArgs): Promise<Record<string, unknown>> {
  const raw = asRecord(await splitGet(definitionPath(p))) ?? {};
  const facts: Record<string, unknown> = {};
  for (const key of DEFINITION_FIELDS) {
    if (raw[key] !== undefined) facts[key] = raw[key];
  }
  return {
    ...facts,
    ...capped("treatments", arrayOf(raw["treatments"]).map(boundTreatment), MAX_TREATMENTS),
    ...capped("rules", arrayOf(raw["rules"]).map(boundRule), MAX_RULES),
    ...capped("defaultRule", arrayOf(raw["defaultRule"]), MAX_BUCKETS),
  };
}

/** Scope: `flag:<workspaceId>/<environment>/<splitName>`, one split in one environment. */
function flagScope(p: DefinitionArgs): { kind: string; value: string } {
  return { kind: "flag", value: `${p.workspaceId}/${p.environment}/${p.splitName}` };
}

/**
 * The result of a kill or restore. Both answer 200 with no body, so the definition is read back:
 * `confirmed` is true only when that read shows the requested `killed`. The write answered 2xx and
 * was applied, so a failed read-back is reported in `confirmError`, not thrown.
 */
async function changed(p: DefinitionArgs, killed: boolean): Promise<Record<string, unknown>> {
  let after: Record<string, unknown> | undefined;
  let confirmError: string | undefined;
  try {
    after = await readDefinition(p);
  } catch (err) {
    confirmError = (err instanceof Error ? err.message : String(err)).slice(0, DEFAULT_SNIPPET_MAX);
  }
  return {
    ok: true,
    workspaceId: p.workspaceId,
    splitName: p.splitName,
    environment: p.environment,
    confirmed: after?.["killed"] === killed,
    killed: after?.["killed"],
    ...(confirmError === undefined ? {} : { confirmError }),
  };
}

export function registerSplitTools(
  server: ConsentServer & { tool: (...args: never) => unknown },
): void {
  const reg = createZodToolRegistrar(createRegisterSimpleTool(server));
  const registerWriteTool = createWriteToolRegistrar(server, {
    connector: "split",
    scopeEnv: "NIMBUS_MCP_SPLIT_WRITE_SCOPE",
    scopeKinds: ["flag"],
  });

  reg(
    "split_list",
    "List Split workspaces (projects), a workspace's splits (feature flags), or its environments. Without `workspaceId`, returns the workspaces (`GET /workspaces`). With `workspaceId`, returns one page of split definitions (`GET /splits/ws/{workspaceId}`, `offset` default 0, `limit` default and max 50; the reply's `totalCount` says how many exist), or with `collection: \"environments\"` the workspace's environments (`GET /environments/ws/{workspaceId}`).",
    z.object({
      workspaceId: idArg.optional(),
      collection: z.enum(["splits", "environments"]).optional(),
      offset: z.number().int().min(0).max(1_000_000).optional(),
      limit: z.number().int().min(1).max(PAGE_SIZE).optional(),
    }),
    async (p) => {
      if (p.workspaceId === undefined) {
        if (p.collection === "environments") {
          throw new Error("collection 'environments' needs workspaceId; nothing was sent");
        }
        return jsonResult(await splitGet("/workspaces"));
      }
      const ws = encodeURIComponent(p.workspaceId);
      if (p.collection === "environments") {
        return jsonResult(await splitGet(`/environments/ws/${ws}`));
      }
      const search = new URLSearchParams({
        offset: String(p.offset ?? 0),
        limit: String(p.limit ?? PAGE_SIZE),
      });
      return jsonResult(await splitGet(`/splits/ws/${ws}?${search.toString()}`));
    },
  );

  reg(
    "split_get",
    "Fetch one Split split (feature flag) definition by workspace id + split name (`GET /splits/ws/{workspaceId}/{splitName}`): name, description, traffic type, tags, rollout status and creation time. Every list in it (tags, flag sets) is capped at 50, the rest counted in `*NotShown`.",
    splitArgs,
    async (p) => jsonResult(boundSplit(await splitGet(splitPath(p)))),
  );

  reg(
    "split_search",
    "Substring search across a workspace's splits (feature flags). Split has no search endpoint, so this walks the split list 50 at a time (at most 1,000 splits, `truncated: true` when the workspace holds more) and matches the query against name, description and tags (case-insensitive). Returns `{ matches, scanned }`.",
    z.object({
      workspaceId: idArg,
      query: z.string().min(1).max(200),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    async (p) => {
      const ws = encodeURIComponent(p.workspaceId);
      const rows: unknown[] = [];
      let truncated = false;
      for (let page = 0; ; page += 1) {
        if (page === MAX_SEARCH_PAGES) {
          truncated = true;
          break;
        }
        const search = new URLSearchParams({
          offset: String(page * PAGE_SIZE),
          limit: String(PAGE_SIZE),
        });
        const root = asRecord(await splitGet(`/splits/ws/${ws}?${search.toString()}`));
        const objects = arrayOf(root?.["objects"]);
        rows.push(...objects);
        const total = root?.["totalCount"];
        const exhausted = typeof total === "number" && rows.length >= total;
        if (objects.length < PAGE_SIZE || exhausted) break;
      }
      return jsonResult({
        matches: filterSplits(rows, { query: p.query, limit: p.limit }),
        scanned: rows.length,
        ...(truncated ? { truncated: true } : {}),
      });
    },
  );

  reg(
    "split_definition_get",
    "Read one split in ONE environment (`GET /splits/ws/{workspaceId}/{splitName}/environments/{environment}`, the environment by id or case-sensitive name): `killed`, `defaultTreatment`, `baselineTreatment`, `trafficAllocation`, the treatments (capped at 50, each configuration cut at 2,000 characters), the targeting `rules` (capped at 20, each matcher's lists capped at 20, the rest counted in `*NotShown`) and the `defaultRule`.",
    definitionArgs,
    async (p) => jsonResult(await readDefinition(p)),
  );

  registerWriteTool(
    "split_kill",
    {
      mutates: "split.flag.kill",
      // Undone by split_restore.
      recoverable: true,
      scopeTargetOf: flagScope,
    },
    "Kill a split in ONE environment (`PUT /splits/ws/{workspaceId}/{splitName}/environments/{environment}/kill`): every evaluation then serves the split's default treatment, whatever its rules say. Undone by `split_restore`. The result carries `confirmed`: true only when a read of the definition after the write shows it killed.",
    definitionArgs,
    async (p) => {
      await splitSend("PUT", `${definitionPath(p)}/kill`, {
        comment: "Killed by Nimbus after owner approval",
      });
      return jsonResult(await changed(p, true));
    },
  );

  registerWriteTool(
    "split_restore",
    {
      mutates: "split.flag.restore",
      // Undone by split_kill.
      recoverable: true,
      scopeTargetOf: flagScope,
    },
    "Restore a killed split in ONE environment (`PUT /splits/ws/{workspaceId}/{splitName}/environments/{environment}/restore`): its targeting rules apply again. Undone by `split_kill`. The result carries `confirmed`: true only when a read of the definition after the write shows it no longer killed.",
    definitionArgs,
    async (p) => {
      await splitSend("PUT", `${definitionPath(p)}/restore`, {
        comment: "Restored by Nimbus after owner approval",
      });
      return jsonResult(await changed(p, false));
    },
  );
}
