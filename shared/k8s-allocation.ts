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
 * as `Authorization: Bearer`, and only when set (a cluster-local service is usually unauthenticated);
 * with a token set the base must be https, or http on a loopback host, so the token never travels in
 * clear text across a network.
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

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * The service base URL from `urlEnv`: trimmed, http or https only, no userinfo, no query or
 * fragment, trailing slashes stripped. A bad value names the variable and nothing else.
 */
export function allocationBaseUrl(urlEnv: string, withToken = false): string {
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
  if (withToken && parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
    throw new Error(
      `${urlEnv} must be https when a bearer token is set (the token would travel in clear text)`,
    );
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
 * The rows of an Allocation reply. `data` must be an array of sets (an empty one is a valid, empty
 * read; a missing or non-array `data` is an error, never an empty page); a set that is not an object
 * is skipped. A reply with a `code` other than 200 is an error the caller has already thrown.
 */
export function allocationRows(
  root: unknown,
  offset: number,
  limit: number,
  span: AllocationSpan,
): { items: AllocationRow[]; nextCursor: string | null; skipped: number } {
  const data = asRecord(root)?.["data"];
  if (!Array.isArray(data)) {
    throw new Error("the allocation reply has no data array");
  }
  const rows: AllocationRow[] = [];
  let skipped = 0;
  for (const set of data) {
    for (const [key, raw] of Object.entries(asRecord(set) ?? {})) {
      const row = rowOf(key, raw);
      if (row === undefined) {
        skipped += 1;
      } else {
        rows.push(row);
      }
    }
  }
  // A stable order, so that a page boundary falls on the same row when the window is read again.
  rows.sort((a, b) => compareText(a.date, b.date) || compareText(a.key, b.key));
  const end = offset + limit;
  return {
    items: rows.slice(offset, end),
    nextCursor: end < rows.length ? cursorOf(end, span) : null,
    skipped,
  };
}

/** Code-unit order: the same on every machine, unlike a locale compare. */
function compareText(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** The window of one listing as the service takes it: Unix seconds, start (UTC midnight) then end. */
interface AllocationSpan {
  readonly startSec: number;
  readonly endSec: number;
}

/**
 * `<offset>:<startSec>,<endSec>`: where a page resumes AND the window it was read in, so every page
 * of one listing reads the same window even when the clock crosses UTC midnight between two calls.
 */
const PAGE_CURSOR = /^([1-9]\d{0,6}):(\d{1,11}),(\d{1,11})$/;

function cursorOf(offset: number, span: AllocationSpan): string {
  return `${String(offset)}:${String(span.startSec)},${String(span.endSec)}`;
}

/** The resume point a cursor stands for, or undefined for the first page. */
function resumeFromCursor(
  cursor: string | null | undefined,
): { offset: number; span: AllocationSpan } | undefined {
  if (cursor === undefined || cursor === null) {
    return undefined;
  }
  const m = PAGE_CURSOR.exec(cursor);
  const [, offset, startSec, endSec] = m ?? [];
  if (offset === undefined || startSec === undefined || endSec === undefined) {
    throw new Error("cursor must be the nextCursor of a previous page");
  }
  const span = { startSec: Number(startSec), endSec: Number(endSec) };
  checkSpan(span);
  return { offset: Number(offset), span };
}

function checkSpan(span: AllocationSpan): void {
  if (span.endSec <= span.startSec) {
    throw new Error("untilMs must be after sinceMs");
  }
  if (span.endSec - span.startSec > ALLOCATION_MAX_DAYS * (DAY_MS / 1000)) {
    throw new Error(`the window may not exceed ${String(ALLOCATION_MAX_DAYS)} days`);
  }
}

const AGGREGATE =
  /^(?:cluster|node|namespace|controllerKind|controller|service|pod|container|(?:label|annotation):[A-Za-z0-9_./-]{1,253})$/;

function listSchema() {
  return z.object({
    sinceMs: z.number().int().min(0).max(MAX_EPOCH_MS).optional(),
    untilMs: z.number().int().min(0).max(MAX_EPOCH_MS).optional(),
    aggregate: z.string().regex(AGGREGATE).optional(),
    includeIdle: z.boolean().optional(),
    cursor: z.string().nullable().optional(),
    limit: z.number().int().min(1).max(ROW_LIMIT_MAX).optional(),
  });
}

/**
 * The window to ask for, in Unix seconds: the start moved back to UTC midnight so the day steps line
 * up with UTC days, the end the caller's `untilMs` (default now). The endpoints are compared BEFORE
 * the start is rounded, so a reversed pair is refused rather than widened into a query; a range
 * longer than {@link ALLOCATION_MAX_DAYS} days is an error too.
 */
export function allocationWindow(
  sinceMs: number | undefined,
  untilMs: number | undefined,
  nowMs: number,
): AllocationSpan {
  const until = untilMs ?? nowMs;
  const since = sinceMs ?? until - DEFAULT_DAYS * DAY_MS;
  if (until <= since) {
    throw new Error("untilMs must be after sinceMs");
  }
  const span = {
    startSec: (Math.floor(since / DAY_MS) * DAY_MS) / 1000,
    endSec: Math.floor(until / 1000),
  };
  checkSpan(span);
  return span;
}

/** Registers `<service>_allocation_list`. Every request is a GET. */
export function registerAllocationTools(reg: ZodToolRegistrar, api: AllocationApi): void {
  const getter = createJsonGetter({
    base: () => allocationBaseUrl(api.urlEnv, optionalEnv(api.tokenEnv, "") !== ""),
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
    `List ${api.label} cost allocations (\`GET ${api.path}\`), one row per allocation per UTC day. \`sinceMs\` / \`untilMs\` (epoch milliseconds; the start is moved back to UTC midnight; \`untilMs\` defaults to now, \`sinceMs\` to 7 days before it; at most ${String(ALLOCATION_MAX_DAYS)} days) bound the window. \`aggregate\` is one of cluster, node, namespace (default), controllerKind, controller, service, pod, container, or label:<name> / annotation:<name>. Idle cost is left out unless \`includeIdle\` is true. Rows are ordered by date then key and paged: returns \`{ items, nextCursor, skipped }\`, where \`nextCursor\` (it carries the window, so every page reads the same one) goes back as \`cursor\` for the next page (null on the last; each page asks the service again) and \`limit\` (default ${String(ROW_LIMIT_DEFAULT)}) is the page size. Each item is \`{ date, key, name, start, end, minutes, properties, cpuCost, ramCost, gpuCost, pvCost, networkCost, loadBalancerCost, sharedCost, externalCost, totalCost }\`; \`skipped\` counts allocations whose day could not be read. Costs are in the currency the cluster's pricing is configured for. The first day and the last are partial when the window does not start or end at midnight.`,
    listSchema(),
    async (p) => {
      const resume = resumeFromCursor(p.cursor);
      const span = resume?.span ?? allocationWindow(p.sinceMs, p.untilMs, now());
      const search = new URLSearchParams({
        window: `${String(span.startSec)},${String(span.endSec)}`,
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
      return jsonResult(
        allocationRows(root, resume?.offset ?? 0, p.limit ?? ROW_LIMIT_DEFAULT, span),
      );
    },
  );
}
