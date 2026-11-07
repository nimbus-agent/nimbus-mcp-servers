import { z } from "zod";
import type { ConsentServer } from "../../../shared/consent-kit.ts";
import { createWriteToolRegistrar } from "../../../shared/consent-kit.ts";
import { guardedFetch } from "../../../shared/guarded-fetch.ts";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
  requireProcessEnv,
} from "../../../shared/mcp-tool-kit.ts";
import {
  makeRestToolRegistrar,
  type RestFetchResult,
  toRestFetchResult,
} from "../../../shared/rest-tool-kit.ts";

const CCI_API = "https://circleci.com/api/v2";

function projectPathSegments(projectSlug: string): string {
  return projectSlug
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => encodeURIComponent(s))
    .join("/");
}

async function circleciFetch(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<RestFetchResult> {
  const url = path.startsWith("http") ? path : `${CCI_API}${path}`;
  // guardedFetch: the Circle-Token header must never follow a redirect to another origin, and a
  // redirect on a write is refused rather than replayed.
  const res = await guardedFetch("CircleCI", url, {
    ...init,
    headers: {
      Accept: "application/json",
      "Circle-Token": token,
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  return toRestFetchResult(res);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * The job fields a cancel preview needs, read defensively: `GET /project/{slug}/job/{n}` is not on
 * the CircleCI v2 reference page (only `GET /jobs/{job_id}`, whose fields are `name, job_number,
 * status, pipeline_id, started_at, stopped_at`), so each field is taken under both spellings when
 * one is plausible and an absent one is left out. Live check item.
 */
export function projectJob(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("CircleCI returned no job");
  }
  const r = raw as Record<string, unknown>;
  const pipeline =
    typeof r["pipeline"] === "object" && r["pipeline"] !== null
      ? (r["pipeline"] as Record<string, unknown>)
      : {};
  const out: Record<string, unknown> = {};
  const set = (k: string, v: unknown): void => {
    if (v !== undefined) out[k] = v;
  };
  set("name", str(r["name"]));
  set(
    "number",
    typeof r["number"] === "number"
      ? r["number"]
      : typeof r["job_number"] === "number"
        ? r["job_number"]
        : undefined,
  );
  set("status", str(r["status"]));
  set("startedAt", str(r["started_at"]));
  set("stoppedAt", str(r["stopped_at"]));
  set("webUrl", str(r["web_url"]));
  set("pipelineId", str(r["pipeline_id"]) ?? str(pipeline["id"]));
  if (Object.keys(out).length === 0) throw new Error("CircleCI returned no job");
  return out;
}

/** Tool names exposed by this connector — for contract/introspection tests. */
export const CIRCLECI_TOOL_NAMES = [
  "circleci_pipeline_list",
  "circleci_pipeline_get",
  "circleci_workflow_list",
  "circleci_job_list",
  "circleci_job_artifacts",
  "circleci_job_get",
  "circleci_pipeline_trigger",
  "circleci_job_cancel",
] as const;

export function registerCircleciTools(
  server: ConsentServer & { tool: (...args: never) => unknown },
): void {
  const reg = createZodToolRegistrar(createRegisterSimpleTool(server));

  /**
   * Every MUTATING circleci tool goes through here. Outside the gateway this adds the
   * consent gate, the write-scope allow-list, the mutation budget and the audit record; inside
   * the gateway it is a pass-through, because executor.ts (I2) is the gate there.
   */
  const registerWriteTool = createWriteToolRegistrar(server, {
    connector: "circleci",
    scopeEnv: "NIMBUS_MCP_CIRCLECI_WRITE_SCOPE",
    scopeKinds: ["project"],
  });

  /** Standard CircleCI read tool: token → circleciFetch(buildPath) → mcpJsonResultIfOk("CircleCI"). */
  const registerCciTool = makeRestToolRegistrar({
    registrar: reg,
    tokenEnv: "CIRCLECI_API_TOKEN",
    serviceLabel: "CircleCI",
    fetch: circleciFetch,
  });

  const projectSlugSchema = z.object({
    projectSlug: z
      .string()
      .min(3)
      .describe("CircleCI project slug, e.g. gh/org/repo or bb/workspace/repo"),
  });

  registerCciTool(
    "circleci_pipeline_list",
    "List pipelines for a CircleCI project.",
    projectSlugSchema.extend({
      pageToken: z.string().min(1).optional(),
    }),
    (parsed) => {
      const base = `/project/${projectPathSegments(parsed.projectSlug)}/pipeline`;
      const u = new URL(`${CCI_API}${base}`);
      if (parsed.pageToken !== undefined) {
        u.searchParams.set("page-token", parsed.pageToken);
      }
      // Relative to CCI_API, like every other tool here: the fetcher prefixes the base, which
      // already ends in /api/v2, so returning `u.pathname` requested /api/v2/api/v2/….
      return `${base}${u.search}`;
    },
  );

  registerCciTool(
    "circleci_pipeline_get",
    "Get a pipeline by UUID.",
    z.object({ pipelineId: z.uuid() }),
    (parsed) => `/pipeline/${encodeURIComponent(parsed.pipelineId)}`,
  );

  registerCciTool(
    "circleci_workflow_list",
    "List workflows for a pipeline.",
    z.object({ pipelineId: z.uuid() }),
    (parsed) => `/pipeline/${encodeURIComponent(parsed.pipelineId)}/workflow`,
  );

  registerCciTool(
    "circleci_job_list",
    "List jobs for a workflow.",
    z.object({ workflowId: z.uuid() }),
    (parsed) => `/workflow/${encodeURIComponent(parsed.workflowId)}/job`,
  );

  registerCciTool(
    "circleci_job_artifacts",
    "List artifact metadata for a job number under a project.",
    projectSlugSchema.extend({
      jobNumber: z.number().int().min(1),
    }),
    (parsed) =>
      `/project/${projectPathSegments(parsed.projectSlug)}/job/${String(parsed.jobNumber)}/artifacts`,
  );

  reg(
    "circleci_job_get",
    "Get one job under a project by job number: {name, number, status, startedAt, stoppedAt, webUrl, pipelineId}. The before-state of circleci_job_cancel; same arguments.",
    projectSlugSchema.extend({ jobNumber: z.number().int().min(1) }),
    async (parsed) => {
      const token = requireProcessEnv("CIRCLECI_API_TOKEN");
      const res = await circleciFetch(
        token,
        `/project/${projectPathSegments(parsed.projectSlug)}/job/${String(parsed.jobNumber)}`,
      );
      if (!res.ok) {
        throw new Error(`CircleCI ${String(res.status)}: ${res.text.slice(0, 400)}`);
      }
      return jsonResult(projectJob(res.json));
    },
  );

  registerWriteTool(
    "circleci_pipeline_trigger",
    {
      mutates: "circleci.pipeline.trigger",
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "project", value: p.projectSlug }),
    },
    "Trigger a new pipeline on a branch (or tag).",
    projectSlugSchema.extend({
      branch: z.string().min(1).optional(),
      tag: z.string().min(1).optional(),
      parameters: z.record(z.string(), z.string()).optional(),
    }),
    async (parsed) => {
      const token = requireProcessEnv("CIRCLECI_API_TOKEN");
      const path = `/project/${projectPathSegments(parsed.projectSlug)}/pipeline`;
      const body: Record<string, unknown> = {};
      if (parsed.tag !== undefined && parsed.tag !== "") {
        body["tag"] = parsed.tag;
      } else {
        body["branch"] = parsed.branch ?? "main";
      }
      if (parsed.parameters !== undefined && Object.keys(parsed.parameters).length > 0) {
        body["parameters"] = parsed.parameters;
      }
      const res = await circleciFetch(token, path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(`CircleCI trigger ${String(res.status)}: ${res.text.slice(0, 400)}`);
      }
      return jsonResult(res.json ?? { ok: true, raw: res.text });
    },
  );

  registerWriteTool(
    "circleci_job_cancel",
    {
      mutates: "circleci.job.cancel",
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "project", value: p.projectSlug }),
    },
    "Cancel a running job by project slug and job number.",
    projectSlugSchema.extend({
      jobNumber: z.number().int().min(1),
    }),
    async (parsed) => {
      const token = requireProcessEnv("CIRCLECI_API_TOKEN");
      const path = `/project/${projectPathSegments(parsed.projectSlug)}/job/${String(parsed.jobNumber)}/cancel`;
      const res = await circleciFetch(token, path, { method: "POST" });
      if (!res.ok) {
        throw new Error(`CircleCI job cancel ${String(res.status)}: ${res.text.slice(0, 400)}`);
      }
      return jsonResult(res.json ?? { ok: true });
    },
  );
}
