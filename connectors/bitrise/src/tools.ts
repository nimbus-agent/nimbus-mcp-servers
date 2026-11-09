import { z } from "zod";
import { capText } from "../../../shared/cap-text.ts";
import { type ConsentServer, createWriteToolRegistrar } from "../../../shared/consent-kit.ts";
import {
  createJsonGetter,
  createJsonSender,
  envAuthHeaders,
  type JsonApiConfig,
} from "../../../shared/env-json-api.ts";
import { isSafeGitRef } from "../../../shared/github-rest.ts";
import { matchesResult } from "../../../shared/mcp-search-tool.ts";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
} from "../../../shared/mcp-tool-kit.ts";
import { filterBitriseBuilds } from "./search-filter.ts";

const BITRISE_API = "https://api.bitrise.io";

const api: JsonApiConfig = {
  base: BITRISE_API,
  label: "Bitrise",
  headers: envAuthHeaders({ env: "BITRISE_TOKEN", scheme: "" }),
};

const bitriseGet = createJsonGetter(api);
// A mutation's 3xx is refused (never followed), so the token is not replayed anywhere.
const bitriseSend = createJsonSender(api);

/** Tool names exposed by this connector — for contract/introspection tests. */
export const BITRISE_TOOL_NAMES = [
  "bitrise_list",
  "bitrise_get",
  "bitrise_search",
  "bitrise_build_latest",
  "bitrise_build_trigger",
] as const;

/** An app slug: never `.` or `..` (a URL parser collapses them out of the path). */
const appSlugArg = z
  .string()
  .regex(/^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/, "letters, digits, '.', '_' and '-' only");

const workflowArg = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, "letters, digits, '.', '_' and '-' only");

type Obj = Record<string, unknown>;

function asObj(v: unknown): Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {};
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * The slug of the build a trigger started. The reply's `build_slug` is deprecated beside `slug`;
 * read the root `build_slug`, then `slug`, then `results[0].build_slug`. Never `build_url`.
 */
function builtSlug(reply: Obj): string | null {
  const first = Array.isArray(reply["results"]) ? asObj(reply["results"][0]) : {};
  return str(reply["build_slug"]) ?? str(reply["slug"]) ?? str(first["build_slug"]) ?? null;
}

export function registerBitriseTools(
  server: ConsentServer & { tool: (...args: never) => unknown },
): void {
  const reg = createZodToolRegistrar(createRegisterSimpleTool(server));
  const registerWriteTool = createWriteToolRegistrar(server, {
    connector: "bitrise",
    scopeEnv: "NIMBUS_MCP_BITRISE_WRITE_SCOPE",
    scopeKinds: ["app"],
  });

  reg(
    "bitrise_list",
    "List Bitrise resources. When `appSlug` is omitted, returns the user's accessible apps via `/v0.1/me/apps`. When `appSlug` is provided, returns the app's recent builds via `/v0.1/apps/<slug>/builds` (status filter and limit optional).",
    z.object({
      appSlug: z.string().min(1).optional(),
      status: z.enum(["not-finished", "successful", "failed", "aborted"]).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    async (p) => {
      if (p.appSlug === undefined) {
        const limit = p.limit ?? 50;
        return jsonResult(await bitriseGet(`/v0.1/me/apps?limit=${String(limit)}`));
      }
      const params: string[] = [];
      params.push(`limit=${String(p.limit ?? 50)}`);
      if (p.status !== undefined) {
        const map = { "not-finished": 0, successful: 1, failed: 2, aborted: 3 } as const;
        params.push(`status=${String(map[p.status])}`);
      }
      const qs = `?${params.join("&")}`;
      return jsonResult(
        await bitriseGet(`/v0.1/apps/${encodeURIComponent(p.appSlug)}/builds${qs}`),
      );
    },
  );

  reg(
    "bitrise_get",
    "Fetch a single Bitrise resource. When `buildSlug` is provided, returns the build via `/v0.1/apps/<appSlug>/builds/<buildSlug>`. When omitted, returns the app via `/v0.1/apps/<appSlug>`.",
    z.object({
      appSlug: z.string().min(1),
      buildSlug: z.string().min(1).optional(),
    }),
    async (p) => {
      if (p.buildSlug === undefined) {
        return jsonResult(await bitriseGet(`/v0.1/apps/${encodeURIComponent(p.appSlug)}`));
      }
      const path = `/v0.1/apps/${encodeURIComponent(p.appSlug)}/builds/${encodeURIComponent(p.buildSlug)}`;
      return jsonResult(await bitriseGet(path));
    },
  );

  reg(
    "bitrise_search",
    "Substring search across a Bitrise app's recent builds. Matches the query against `branch`, `commit_message`, `triggered_workflow`, and `status_text` (case-insensitive). Returns a `{ matches: [...] }` envelope.",
    z.object({
      appSlug: z.string().min(1),
      query: z.string().min(1),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    async (p) => {
      const root = await bitriseGet(`/v0.1/apps/${encodeURIComponent(p.appSlug)}/builds?limit=50`);
      const data = (root as { data?: unknown[] } | null)?.data;
      return matchesResult(data, filterBitriseBuilds, p);
    },
  );

  reg(
    "bitrise_build_latest",
    "Read an app's most recent Bitrise build (`GET /v0.1/apps/{appSlug}/builds?limit=1`), optionally of one `branch` and/or `workflow`, projected to `{ build: { slug, status, status_text, branch, triggered_workflow, triggered_at, finished_at } | null }`. `bitrise_list` has no branch or workflow filter.",
    z.object({
      appSlug: appSlugArg,
      branch: z.string().min(1).max(255).optional(),
      workflow: workflowArg.optional(),
    }),
    async (p) => {
      const search = new URLSearchParams({ limit: "1" });
      if (p.branch !== undefined) {
        search.set("branch", p.branch);
      }
      if (p.workflow !== undefined) {
        search.set("workflow", p.workflow);
      }
      const root = asObj(
        await bitriseGet(`/v0.1/apps/${encodeURIComponent(p.appSlug)}/builds?${search.toString()}`),
      );
      const first = Array.isArray(root["data"]) ? asObj(root["data"][0]) : {};
      const slug = str(first["slug"]);
      return jsonResult({
        build:
          slug === undefined
            ? null
            : {
                slug,
                status: first["status"],
                status_text: capText(first["status_text"]),
                branch: capText(first["branch"]),
                triggered_workflow: capText(first["triggered_workflow"]),
                triggered_at: capText(first["triggered_at"]),
                finished_at: capText(first["finished_at"]),
              },
      });
    },
  );

  registerWriteTool(
    "bitrise_build_trigger",
    {
      mutates: "bitrise.build.trigger",
      // A build can be aborted in Bitrise; it deletes nothing.
      recoverable: true,
      scopeTargetOf: (p: { appSlug: string }) => ({ kind: "app", value: p.appSlug }),
    },
    'Start a Bitrise build of one workflow on one branch (`POST /v0.1/apps/{appSlug}/builds`, body `{ hook_info: { type: "bitrise" }, build_params: { branch, workflow_id } }`). The reply is `accepted` with the new build\'s slug (read from `build_slug`, else `slug`, else `results[0].build_slug`): Bitrise runs it afterwards, so poll `bitrise_get` with that slug.',
    z.object({
      appSlug: appSlugArg,
      branch: z.string().min(1).max(255),
      workflow: workflowArg,
    }),
    async (p) => {
      if (!isSafeGitRef(p.branch)) {
        throw new Error("branch is not a safe git ref; nothing was sent");
      }
      const reply = asObj(
        await bitriseSend("POST", `/v0.1/apps/${encodeURIComponent(p.appSlug)}/builds`, {
          hook_info: { type: "bitrise" },
          build_params: { branch: p.branch, workflow_id: p.workflow },
        }),
      );
      return jsonResult({
        ok: true,
        status: "accepted",
        appSlug: p.appSlug,
        branch: p.branch,
        workflow: p.workflow,
        buildSlug: builtSlug(reply),
      });
    },
  );
}
