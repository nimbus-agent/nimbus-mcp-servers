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
import { filterCodemagicBuilds } from "./search-filter.ts";

const CODEMAGIC_API = "https://api.codemagic.io";

const api: JsonApiConfig = {
  base: CODEMAGIC_API,
  label: "Codemagic",
  headers: envAuthHeaders({ env: "CODEMAGIC_TOKEN", scheme: "", header: "x-auth-token" }),
};

const codemagicGet = createJsonGetter(api);
// A mutation's 3xx is refused (never followed), so the token is not replayed anywhere.
const codemagicSend = createJsonSender(api);

/** Tool names exposed by this connector — for contract/introspection tests. */
export const CODEMAGIC_TOOL_NAMES = [
  "codemagic_list",
  "codemagic_get",
  "codemagic_search",
  "codemagic_build_latest",
  "codemagic_build_trigger",
] as const;

/** Codemagic app and workflow ids: letters, digits, `.`, `_`, `-`; never a dot segment. */
const idArg = z
  .string()
  .regex(/^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/, "letters, digits, '.', '_' and '-' only");

type Obj = Record<string, unknown>;

function asObj(v: unknown): Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {};
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * A build reduced to a fixed field set. Everything else Codemagic returns (artefacts, config,
 * commit and workflow settings) is dropped, and so is any unknown field. The field names are
 * Codemagic's and are not verified against a live account.
 */
function projectBuild(b: Obj): Obj {
  const scalar = (v: unknown): string | number | undefined =>
    typeof v === "number" ? v : capText(v);
  return {
    id: capText(b["_id"]) ?? capText(b["id"]),
    status: capText(b["status"]),
    branch: capText(b["branch"]),
    workflowId: capText(b["workflowId"]),
    index: scalar(b["index"]),
    createdAt: scalar(b["createdAt"]),
    startedAt: scalar(b["startedAt"]),
    finishedAt: scalar(b["finishedAt"]),
  };
}

export function registerCodemagicTools(
  server: ConsentServer & { tool: (...args: never) => unknown },
): void {
  const reg = createZodToolRegistrar(createRegisterSimpleTool(server));
  const registerWriteTool = createWriteToolRegistrar(server, {
    connector: "codemagic",
    scopeEnv: "NIMBUS_MCP_CODEMAGIC_WRITE_SCOPE",
    scopeKinds: ["app"],
  });

  reg(
    "codemagic_list",
    "List Codemagic resources. When `appId` is omitted, returns the user's accessible apps via `/apps`. When `appId` is provided, returns the app's recent builds via `/builds?appId=<id>` (limit optional).",
    z.object({
      appId: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    async (p) => {
      if (p.appId === undefined) {
        return jsonResult(await codemagicGet("/apps"));
      }
      const limit = p.limit ?? 50;
      return jsonResult(
        await codemagicGet(`/builds?appId=${encodeURIComponent(p.appId)}&limit=${String(limit)}`),
      );
    },
  );

  reg(
    "codemagic_get",
    "Fetch a single Codemagic resource. When `buildId` is provided, returns the build via `/builds/<buildId>`. When omitted, returns the app via `/apps` filtered to `appId`.",
    z.object({
      appId: z.string().min(1),
      buildId: z.string().min(1).optional(),
    }),
    async (p) => {
      if (p.buildId === undefined) {
        return jsonResult(await codemagicGet("/apps"));
      }
      return jsonResult(await codemagicGet(`/builds/${encodeURIComponent(p.buildId)}`));
    },
  );

  reg(
    "codemagic_search",
    "Substring search across a Codemagic app's recent builds. Matches the query against `branch`, `message`, `workflowId`, and `status` (case-insensitive). Returns a `{ matches: [...] }` envelope.",
    z.object({
      appId: z.string().min(1),
      query: z.string().min(1),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    async (p) => {
      const root = await codemagicGet(`/builds?appId=${encodeURIComponent(p.appId)}&limit=50`);
      const builds = (root as { builds?: unknown[] } | null)?.builds;
      return matchesResult(builds, filterCodemagicBuilds, p);
    },
  );

  reg(
    "codemagic_build_latest",
    "Read an app's most recent Codemagic build, optionally of one `workflowId` and/or `branch`: the app's last 50 builds (`GET /builds?appId=<id>&limit=50`) filtered here, newest first. Returns `{ build: { id, status, branch, workflowId, index, createdAt, startedAt, finishedAt } | null, scanned }`; every other field is dropped. The field names are Codemagic's own and unverified.",
    z.object({
      appId: idArg,
      workflowId: idArg.optional(),
      branch: z.string().min(1).max(255).optional(),
    }),
    async (p) => {
      const root = asObj(
        await codemagicGet(`/builds?appId=${encodeURIComponent(p.appId)}&limit=50`),
      );
      const builds = Array.isArray(root["builds"]) ? root["builds"] : [];
      const match = builds.find((raw) => {
        const b = asObj(raw);
        return (
          (p.workflowId === undefined || b["workflowId"] === p.workflowId) &&
          (p.branch === undefined || b["branch"] === p.branch)
        );
      });
      return jsonResult({
        build: match === undefined ? null : projectBuild(asObj(match)),
        scanned: builds.length,
      });
    },
  );

  registerWriteTool(
    "codemagic_build_trigger",
    {
      mutates: "codemagic.build.trigger",
      // A build can be cancelled in Codemagic; it deletes nothing.
      recoverable: true,
      scopeTargetOf: (p: { appId: string }) => ({ kind: "app", value: p.appId }),
    },
    "Start a Codemagic build of one workflow on one branch (`POST /builds`, body `{ appId, workflowId, branch }`). Triggers and branch settings in codemagic.yaml are not applied to an API build. The reply is `accepted` with the build id: Codemagic runs it afterwards, so poll `codemagic_get` with that id.",
    z.object({
      appId: idArg,
      workflowId: idArg,
      branch: z.string().min(1).max(255),
    }),
    async (p) => {
      if (!isSafeGitRef(p.branch)) {
        throw new Error("branch is not a safe git ref; nothing was sent");
      }
      const reply = asObj(
        await codemagicSend("POST", "/builds", {
          appId: p.appId,
          workflowId: p.workflowId,
          branch: p.branch,
        }),
      );
      return jsonResult({
        ok: true,
        status: "accepted",
        appId: p.appId,
        workflowId: p.workflowId,
        branch: p.branch,
        buildId: str(reply["buildId"]) ?? null,
      });
    },
  );
}
