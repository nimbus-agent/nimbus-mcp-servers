/**
 * k8s-allocation — the read-only Allocation API client that the `opencost` and `kubecost`
 * connectors share.
 *
 * OpenCost is the CNCF open-source core of Kubecost, and both serve the same Allocation reply:
 * `{ code, data: [ { "<key>": <allocation>, ... }, ... ] }`, where `data` holds one set per step
 * (a day here) and each set maps an aggregate key (a namespace, a controller) to one allocation.
 * What differs is small and is the {@link AllocationApi} a connector passes in: the path
 * (`/allocation` against `/model/allocation`), the query parameter that asks for idle cost
 * (`includeIdle` against `idle`), whether `step` is sent, and the environment variable names.
 *
 * Every reply shape here was written from the projects' published documentation (OpenCost's
 * swagger file and Kubecost's allocation API page), not from a live cluster: UNVERIFIED against
 * a running instance. The reader below therefore trusts nothing it is handed: a number that is not
 * finite becomes 0, a property that is not a string is dropped, a set that is not an object is
 * skipped, and a row whose day cannot be read is counted in `skipped` rather than guessed.
 *
 * The base URL is the owner's own (a cluster-local service), so it is validated before use: http
 * or https only, no credentials in the URL, no query or fragment. The optional token is sent only
 * as `Authorization: Bearer`, and only when set (a cluster-local service is usually unauthenticated).
 */

import { z } from "zod";
import { createJsonGetter, optionalEnv, requiredEnv } from "./env-json-api.ts";
import { mcpJsonResult as jsonResult } from "./mcp-tool-kit.ts";
import type { ZodToolRegistrar } from "./run-read-only-mcp-connector.ts";
import { stripTrailingSlashes } from "./strip-trailing-slashes.ts";

const DAY_MS = 86_400_000;
const MAX_EPOCH_MS = 253_402_300_799_999; // 9999-12-31T23:59:59.999Z

/** The longest window one call may ask for. A longer one is refused before any request. */
export const ALLOCATION_MAX_DAYS = 62;
const DEFAULT_DAYS = 7;
const ROW_LIMIT_DEFAULT = 5000;
const ROW_LIMIT_MAX = 20_000;

/** The properties kept on a row: the identity of what the cost belongs to, nothing else. */
const KEPT_PROPERTIES = [
  "cluster",
  "namespace",
  "controller",
  "controllerKind",
  "node",
  "pod",
  "container",
] as const;
const PROPERTY_MAX = 253;

/** The cost fields of an allocation, in the order a row carries them. */
const COST_FIELDS = [
  "cpuCost",
  "ramCost",
  "gpuCost",
  "pvCost",
  "networkCost",
  "loadBalancerCost",
  "sharedCost",
  "externalCost",
  "totalCost",
] as const;

/** What one connector says about its service. */
export interface AllocationApi {
  /** The tool name prefix and the label in an error, e.g. `opencost`. */
  readonly service: string;
  /** Display name, e.g. `OpenCost`. */
  readonly label: string;
  /** The environment variable holding the service's base URL. */
  readonly urlEnv: string;
  /** The optional environment variable holding a bearer token for an authenticating ingress. */
  readonly tokenEnv: string;
  /** The allocation path under the base URL. */
  readonly path: string;
  /** The query parameter that includes idle cost: OpenCost `includeIdle`, Kubecost `idle`. */
  readonly idleParam: string;
  /** Whether `step=1d` is sent (OpenCost's `/allocation` takes it; Kubecost's does not). */
  readonly sendStep: boolean;
  /** The injected clock: `Date.now` unless a test replaces it. */
  readonly now?: () => number;
}

/** One cost row: one allocation for one UTC day. */
export interface AllocationRow {
  readonly date: string;
  readonly key: string;
  readonly name: string;
  readonly start: string;
  readonly end: string;
  readonly minutes: number;
  readonly properties: Readonly<Record<string, string>>;
  readonly cpuCost: number;
  readonly ramCost: number;
  readonly gpuCost: number;
  readonly pvCost: number;
  readonly networkCost: number;
  readonly loadBalancerCost: number;
  readonly sharedCost: number;
  readonly externalCost: number;
  readonly totalCost: number;
}

/**
 * The service base URL from `urlEnv`: trimmed, http or https only, no userinfo, no query or
 * fragment, trailing slashes stripped. A bad value names the variable and nothing else.
 */
export function allocationBaseUrl(urlEnv: string): string {
  const raw = requiredEnv(urlEnv);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${urlEnv} must be an http or https URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${urlEnv} must be an http or https URL`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error(`${urlEnv} must not carry credentials; use the token variable instead`);
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error(`${urlEnv} must not carry a query or a fragment`);
  }
  return stripTrailingSlashes(raw);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A finite number, else 0: a reply that is not documented must not poison a sum. */
function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** `YYYY-MM-DD` of a timestamp string in UTC, or undefined when it does not parse. */
function utcDateOf(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : undefined;
}

function textOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.slice(0, PROPERTY_MAX) : "";
}

function keptProperties(raw: unknown): Record<string, string> {
  const source = asRecord(raw);
  const out: Record<string, string> = {};
  if (source === undefined) {
    return out;
  }
  for (const name of KEPT_PROPERTIES) {
    const value = source[name];
    if (typeof value === "string" && value !== "") {
      out[name] = value.slice(0, PROPERTY_MAX);
    }
  }
  return out;
}

/** One allocation as a row, or undefined when its day cannot be read from the window or start. */
function rowOf(key: string, raw: unknown): AllocationRow | undefined {
  const alloc = asRecord(raw);
  if (alloc === undefined) {
    return undefined;
  }
  const window = asRecord(alloc["window"]);
  const date = utcDateOf(window?.["start"]) ?? utcDateOf(alloc["start"]);
  if (date === undefined) {
    return undefined;
  }
  const costs = Object.fromEntries(COST_FIELDS.map((field) => [field, finite(alloc[field])]));
  return {
    date,
    key,
    name: textOrEmpty(alloc["name"]) || key,
    start: textOrEmpty(window?.["start"] ?? alloc["start"]),
    end: textOrEmpty(window?.["end"] ?? alloc["end"]),
    minutes: finite(alloc["minutes"]),
    properties: keptProperties(alloc["properties"]),
    ...costs,
  } as AllocationRow;
}

/**
 * The rows of an Allocation reply. `data` must be an array of sets; anything else yields no rows
 * (a reply with `code` other than 200, or no `data`, is an error the caller has already thrown).
 */
export function allocationRows(
  root: unknown,
  limit: number,
): { items: AllocationRow[]; skipped: number; truncated: boolean } {
  const data = asRecord(root)?.["data"];
  const items: AllocationRow[] = [];
  let skipped = 0;
  let truncated = false;
  for (const set of Array.isArray(data) ? data : []) {
    const entries = Object.entries(asRecord(set) ?? {});
    for (const [key, raw] of entries) {
      const row = rowOf(key, raw);
      if (row === undefined) {
        skipped += 1;
      } else if (items.length >= limit) {
        truncated = true;
      } else {
        items.push(row);
      }
    }
  }
  return { items, skipped, truncated };
}

const AGGREGATE =
  /^(?:cluster|node|namespace|controllerKind|controller|service|pod|container|(?:label|annotation):[A-Za-z0-9_./-]{1,253})$/;

function listSchema() {
  return z.object({
    sinceMs: z.number().int().min(0).max(MAX_EPOCH_MS).optional(),
    untilMs: z.number().int().min(0).max(MAX_EPOCH_MS).optional(),
    aggregate: z.string().regex(AGGREGATE).optional(),
    includeIdle: z.boolean().optional(),
    limit: z.number().int().min(1).max(ROW_LIMIT_MAX).optional(),
  });
}

/**
 * The window to ask for: `<start>,<end>` in Unix seconds, the start moved back to UTC midnight so
 * the day steps line up with UTC days, the end the caller's `untilMs` (default now). A range
 * longer than {@link ALLOCATION_MAX_DAYS} days, or an end before the start, is an error.
 */
export function allocationWindow(
  sinceMs: number | undefined,
  untilMs: number | undefined,
  nowMs: number,
): string {
  const until = untilMs ?? nowMs;
  const since = sinceMs ?? until - DEFAULT_DAYS * DAY_MS;
  const start = Math.floor(since / DAY_MS) * DAY_MS;
  if (until <= start) {
    throw new Error("untilMs must be after sinceMs");
  }
  if (until - start > ALLOCATION_MAX_DAYS * DAY_MS) {
    throw new Error(`the window may not exceed ${String(ALLOCATION_MAX_DAYS)} days`);
  }
  return `${String(start / 1000)},${String(Math.floor(until / 1000))}`;
}

/** Registers `<service>_allocation_list`. Every request is a GET. */
export function registerAllocationTools(reg: ZodToolRegistrar, api: AllocationApi): void {
  const getter = createJsonGetter({
    base: () => allocationBaseUrl(api.urlEnv),
    label: api.label,
    headers: () => {
      const token = optionalEnv(api.tokenEnv, "");
      return {
        Accept: "application/json",
        ...(token === "" ? {} : { Authorization: `Bearer ${token}` }),
      };
    },
  });
  const now = api.now ?? Date.now;
  reg(
    `${api.service}_allocation_list`,
    `List ${api.label} cost allocations (\`GET ${api.path}\`), one row per allocation per UTC day. \`sinceMs\` / \`untilMs\` (epoch milliseconds; the start is moved back to UTC midnight; \`untilMs\` defaults to now, \`sinceMs\` to 7 days before it; at most ${String(ALLOCATION_MAX_DAYS)} days) bound the window. \`aggregate\` is one of cluster, node, namespace (default), controllerKind, controller, service, pod, container, or label:<name> / annotation:<name>. Idle cost is left out unless \`includeIdle\` is true. Returns \`{ items, skipped, truncated }\`: each item is \`{ date, key, name, start, end, minutes, properties, cpuCost, ramCost, gpuCost, pvCost, networkCost, loadBalancerCost, sharedCost, externalCost, totalCost }\`; \`skipped\` counts allocations whose day could not be read and \`truncated\` is true when \`limit\` (default ${String(ROW_LIMIT_DEFAULT)}) cut the list. Costs are in the currency the cluster's pricing is configured for. The first day and the last are partial when the window does not start or end at midnight.`,
    listSchema(),
    async (p) => {
      const window = allocationWindow(p.sinceMs, p.untilMs, now());
      const search = new URLSearchParams({
        window,
        aggregate: p.aggregate ?? "namespace",
        accumulate: "false",
      });
      search.set(api.idleParam, String(p.includeIdle === true));
      if (api.sendStep) {
        search.set("step", "1d");
      }
      const root = await getter(`${api.path}?${search.toString()}`);
      const code = asRecord(root)?.["code"];
      if (typeof code === "number" && code !== 200) {
        throw new Error(`${api.label} ${String(code)}: the allocation query was refused`);
      }
      return jsonResult(allocationRows(root, p.limit ?? ROW_LIMIT_DEFAULT));
    },
  );
}
