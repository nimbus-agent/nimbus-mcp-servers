import { z } from "zod";
import { createJsonGetter } from "../../../shared/env-json-api.ts";
import { matchesResult, searchToolInputSchema } from "../../../shared/mcp-search-tool.ts";
import {
  encodeBasicAuthHeader,
  mcpJsonResult as jsonResult,
} from "../../../shared/mcp-tool-kit.ts";
import type { ZodToolRegistrar } from "../../../shared/run-read-only-mcp-connector.ts";
import { filterGreenhouseJobs } from "./search-filter.ts";

const BASE = "https://harvest.greenhouse.io";

function apiKey(): string {
  const t = process.env["GREENHOUSE_API_KEY"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("GREENHOUSE_API_KEY is not set");
  }
  return t;
}

function authHeader(): Record<string, string> {
  return { Authorization: encodeBasicAuthHeader(apiKey(), ""), Accept: "application/json" };
}

const greenhouseGet = createJsonGetter({
  base: BASE,
  label: "Greenhouse",
  headers: authHeader,
});

/** Tool names exposed by this connector — for contract/introspection tests. */
export const GREENHOUSE_TOOL_NAMES = [
  "greenhouse_list",
  "greenhouse_get",
  "greenhouse_search",
] as const;

export function registerGreenhouseTools(reg: ZodToolRegistrar): void {
  reg(
    "greenhouse_list",
    "List the company's Greenhouse Harvest job openings (`GET /v1/jobs?per_page=100`). Returns a bare JSON array of job objects (NOT an envelope), each carrying the name, status, requisition id, departments, and offices.",
    z.object({
      per_page: z.number().int().min(1).max(100).optional(),
    }),
    async (p) => {
      const search = new URLSearchParams({ per_page: String(p.per_page ?? 100), page: "1" });
      return jsonResult(await greenhouseGet(`/v1/jobs?${search.toString()}`));
    },
  );

  reg(
    "greenhouse_get",
    "Fetch one Greenhouse job by its id (`GET /v1/jobs/{id}`). Returns the job object directly. Throws when no match is found.",
    z.object({
      id: z.string().min(1),
    }),
    async (p) => {
      return jsonResult(await greenhouseGet(`/v1/jobs/${encodeURIComponent(p.id)}`));
    },
  );

  reg(
    "greenhouse_search",
    "Substring search across the company's Greenhouse job openings (first page only). Matches the query against the job name, status, requisition id, the department names, and the office names + locations (case-insensitive). Returns a `{ matches: [...] }` envelope.",
    searchToolInputSchema(100),
    async (p) => {
      const search = new URLSearchParams({ per_page: "100", page: "1" });
      const root = await greenhouseGet(`/v1/jobs?${search.toString()}`);
      return matchesResult(root, filterGreenhouseJobs, p);
    },
  );
}
