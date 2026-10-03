import { z } from "zod";
import {
  type ConsentServer,
  createWriteToolRegistrar,
  type WriteToolConfig,
} from "../../../shared/consent-kit.ts";
import { optionalBaseUrl } from "../../../shared/env-json-api.ts";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
  mcpJsonResultIfOk,
  requireProcessEnv,
  type ZodObjectSchema,
} from "../../../shared/mcp-tool-kit.ts";
import {
  makeRestToolRegistrar,
  makeRestWriteToolRegistrar,
  type RestFetchResult,
  toRestFetchResult,
} from "../../../shared/rest-tool-kit.ts";

function apiBase(): string {
  return optionalBaseUrl("GITLAB_API_BASE_URL", "https://gitlab.com/api/v4");
}

async function glFetch(token: string, path: string, init?: RequestInit): Promise<RestFetchResult> {
  const base = apiBase();
  const relativePath = path.startsWith("/") ? path : `/${path}`;
  const url = path.startsWith("http") ? path : `${base}${relativePath}`;
  const baseHeaders: Record<string, string> = { "PRIVATE-TOKEN": token };
  const mergedHeaders =
    init?.headers === undefined
      ? baseHeaders
      : { ...baseHeaders, ...(init.headers as Record<string, string>) };
  const res = await fetch(url, {
    ...init,
    headers: mergedHeaders,
  });
  return toRestFetchResult(res);
}

/** Tool names exposed by this connector — for contract/introspection tests. */
export const GITLAB_TOOL_NAMES = [
  "gitlab_project_list",
  "gitlab_mr_list",
  "gitlab_mr_get",
  "gitlab_mr_merge",
  "gitlab_issue_list",
  "gitlab_issue_get",
  "gitlab_pipeline_list",
  "gitlab_pipeline_get",
  "gitlab_pipeline_jobs_get",
  "gitlab_job_trace",
  "gitlab_job_log_tail",
  "gitlab_pipeline_retry",
  "gitlab_pipeline_cancel",
] as const;

export function registerGitlabTools(
  server: ConsentServer & { tool: (...args: never) => unknown },
): void {
  const registerSimpleTool = createRegisterSimpleTool(server);
  const reg = createZodToolRegistrar(registerSimpleTool);

  /**
   * Every MUTATING gitlab tool goes through here. Outside the gateway this adds the
   * consent gate, the write-scope allow-list, the mutation budget and the audit record; inside
   * the gateway it is a pass-through, because executor.ts (I2) is the gate there.
   */
  const registerWriteTool = createWriteToolRegistrar(server, {
    connector: "gitlab",
    scopeEnv: "NIMBUS_MCP_GITLAB_WRITE_SCOPE",
    scopeKinds: ["repo"],
  });

  /**
   * Standard GitLab tool, read or write: `token → glFetch(buildUrl[, buildInit]) →
   * mcpJsonResultIfOk("GitLab", res)`. `buildUrl` returns the relative path (or absolute URL) and
   * `buildInit` the optional fetch init (method/body). Tools with a non-standard tail (raw text
   * trace, custom error text) stay hand-written below.
   */
  const gitlabRest = { tokenEnv: "GITLAB_PAT", serviceLabel: "GitLab", fetch: glFetch } as const;
  const registerGitlabTool = makeRestToolRegistrar({ registrar: reg, ...gitlabRest });
  const registerRestWriteTool = makeRestWriteToolRegistrar({ registerWriteTool, ...gitlabRest });

  /**
   * The write-tool equivalent of `registerGitlabTool`, routed through the write registrar.
   * `scopeTargetOf` is supplied here rather than per tool — every GitLab mutation is scoped to one
   * project — so a new write tool cannot forget it.
   */
  function registerGitlabWriteTool<T extends { projectPath: string }>(
    name: string,
    cfg: Omit<WriteToolConfig<T>, "scopeTargetOf">,
    description: string,
    schema: ZodObjectSchema<T>,
    buildUrl: (p: T) => string,
    buildInit?: (p: T) => RequestInit,
  ): void {
    registerRestWriteTool(
      name,
      { ...cfg, scopeTargetOf: (p) => ({ kind: "repo", value: p.projectPath }) },
      description,
      schema,
      buildUrl,
      buildInit,
    );
  }

  const projectPathArg = z.object({
    projectPath: z
      .string()
      .min(1)
      .describe("URL-encoded path or numeric project id, e.g. group/repo"),
  });

  /**
   * A list endpoint's URL with the query `setQuery` sets, parameters in that order. ABSOLUTE on
   * purpose: it already carries apiBase()'s `/api/v4`, and a relative path would let glFetch
   * re-prefix apiBase() → `/api/v4/api/v4/…`.
   */
  function listUrl(path: string, setQuery: (q: URLSearchParams) => void): string {
    const u = new URL(`${apiBase()}${path}`);
    setQuery(u.searchParams);
    return u.toString();
  }

  /** Paging as every list tool here sends it: `per_page` (default 30), then `page` when given. */
  function setPaging(
    q: URLSearchParams,
    paging: { readonly perPage?: number | undefined; readonly page?: number | undefined },
  ): void {
    q.set("per_page", String(paging.perPage ?? 30));
    if (paging.page !== undefined) {
      q.set("page", String(paging.page));
    }
  }

  /** Merge requests and issues take one list query: a state filter (default opened), then paging. */
  const stateListUrl =
    (collection: "merge_requests" | "issues") =>
    (parsed: {
      readonly projectPath: string;
      readonly state?: string | undefined;
      readonly perPage?: number | undefined;
      readonly page?: number | undefined;
    }): string =>
      listUrl(`/projects/${encodeURIComponent(parsed.projectPath)}/${collection}`, (q) => {
        q.set("state", parsed.state ?? "opened");
        setPaging(q, parsed);
      });

  const gitlabProjectListSchema = z.object({
    perPage: z.number().int().min(1).max(100).optional(),
    page: z.number().int().min(1).optional(),
  });

  registerGitlabTool(
    "gitlab_project_list",
    "List projects visible to the authenticated user (membership).",
    gitlabProjectListSchema,
    (parsed) =>
      listUrl("/projects", (q) => {
        q.set("membership", "true");
        q.set("order_by", "last_activity_at");
        q.set("sort", "desc");
        setPaging(q, parsed);
      }),
  );

  const gitlabMrListSchema = projectPathArg.extend({
    state: z.enum(["opened", "closed", "locked", "merged", "all"]).optional(),
    perPage: z.number().int().min(1).max(100).optional(),
    page: z.number().int().min(1).optional(),
  });

  registerGitlabTool(
    "gitlab_mr_list",
    "List merge requests for a project.",
    gitlabMrListSchema,
    stateListUrl("merge_requests"),
  );

  const gitlabMrGetSchema = projectPathArg.extend({
    mergeRequestIid: z.number().int().min(1),
  });

  registerGitlabTool(
    "gitlab_mr_get",
    "Get a single merge request by IID.",
    gitlabMrGetSchema,
    (parsed) =>
      `/projects/${encodeURIComponent(parsed.projectPath)}/merge_requests/${String(parsed.mergeRequestIid)}`,
  );

  const gitlabMrMergeSchema = projectPathArg.extend({
    mergeRequestIid: z.number().int().min(1),
    mergeCommitMessage: z.string().max(10_000).optional(),
    squash: z.boolean().optional(),
    shouldRemoveSourceBranch: z.boolean().optional(),
  });

  registerGitlabWriteTool(
    "gitlab_mr_merge",
    {
      mutates: "gitlab.mr.merge",
      recoverable: true,
    },
    "Merge a merge request.",
    gitlabMrMergeSchema,
    (parsed) =>
      `/projects/${encodeURIComponent(parsed.projectPath)}/merge_requests/${String(parsed.mergeRequestIid)}/merge`,
    (parsed) => {
      const body: Record<string, unknown> = {};
      if (parsed.mergeCommitMessage !== undefined) {
        body["merge_commit_message"] = parsed.mergeCommitMessage;
      }
      if (parsed.squash !== undefined) {
        body["squash"] = parsed.squash;
      }
      if (parsed.shouldRemoveSourceBranch !== undefined) {
        body["should_remove_source_branch"] = parsed.shouldRemoveSourceBranch;
      }
      return {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      };
    },
  );

  const gitlabIssueListSchema = projectPathArg.extend({
    state: z.enum(["opened", "closed", "all"]).optional(),
    perPage: z.number().int().min(1).max(100).optional(),
    page: z.number().int().min(1).optional(),
  });

  registerGitlabTool(
    "gitlab_issue_list",
    "List issues for a project.",
    gitlabIssueListSchema,
    stateListUrl("issues"),
  );

  const gitlabIssueGetSchema = projectPathArg.extend({
    issueIid: z.number().int().min(1),
  });

  registerGitlabTool(
    "gitlab_issue_get",
    "Get a single issue by IID.",
    gitlabIssueGetSchema,
    (parsed) =>
      `/projects/${encodeURIComponent(parsed.projectPath)}/issues/${String(parsed.issueIid)}`,
  );

  const gitlabPipelineListSchema = projectPathArg.extend({
    ref: z.string().max(500).optional(),
    status: z.string().max(64).optional(),
    perPage: z.number().int().min(1).max(100).optional(),
    page: z.number().int().min(1).optional(),
  });

  registerGitlabTool(
    "gitlab_pipeline_list",
    "List CI pipelines for a project.",
    gitlabPipelineListSchema,
    (parsed) =>
      listUrl(`/projects/${encodeURIComponent(parsed.projectPath)}/pipelines`, (q) => {
        setPaging(q, parsed);
        if (parsed.ref !== undefined) {
          q.set("ref", parsed.ref);
        }
        if (parsed.status !== undefined) {
          q.set("status", parsed.status);
        }
      }),
  );

  const gitlabPipelineGetSchema = projectPathArg.extend({
    pipelineId: z.number().int().min(1),
  });

  registerGitlabTool(
    "gitlab_pipeline_get",
    "Get a single pipeline by id.",
    gitlabPipelineGetSchema,
    (parsed) =>
      `/projects/${encodeURIComponent(parsed.projectPath)}/pipelines/${String(parsed.pipelineId)}`,
  );

  registerGitlabTool(
    "gitlab_pipeline_jobs_get",
    "List jobs for a CI pipeline (by pipeline id).",
    gitlabPipelineGetSchema,
    (parsed) =>
      `/projects/${encodeURIComponent(parsed.projectPath)}/pipelines/${String(parsed.pipelineId)}/jobs`,
  );

  const gitlabJobTraceSchema = projectPathArg.extend({
    jobId: z.number().int().min(1),
  });

  /** A CI job's whole plain-text trace; throws, quoting GitLab, on a non-ok status. */
  async function fetchJobTrace(parsed: {
    readonly projectPath: string;
    readonly jobId: number;
  }): Promise<string> {
    const token = requireProcessEnv("GITLAB_PAT");
    const enc = encodeURIComponent(parsed.projectPath);
    const url = `${apiBase()}/projects/${enc}/jobs/${String(parsed.jobId)}/trace`;
    const res = await fetch(url, { headers: { "PRIVATE-TOKEN": token } });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`GitLab ${String(res.status)}: ${text.slice(0, 300)}`);
    }
    return text;
  }

  reg(
    "gitlab_job_trace",
    "Download plain-text trace for a CI job (by job id).",
    gitlabJobTraceSchema,
    async (parsed) => jsonResult({ trace: await fetchJobTrace(parsed) }),
  );

  reg(
    "gitlab_job_log_tail",
    "Download job trace text, optionally keeping only the last N characters (tail).",
    gitlabJobTraceSchema.extend({
      maxChars: z.number().int().min(1000).max(500_000).optional(),
    }),
    async (parsed) => {
      const text = await fetchJobTrace(parsed);
      const max = parsed.maxChars ?? 64_000;
      const tail = text.length > max ? text.slice(-max) : text;
      return jsonResult({
        jobId: parsed.jobId,
        truncated: text.length > max,
        totalChars: text.length,
        trace: tail,
      });
    },
  );

  /**
   * Retry and cancel are one POST on a pipeline, differing only in its last path segment — which
   * the failure message names — so they share everything but their name, action type and text.
   */
  function registerPipelineActionTool(
    name: string,
    mutates: string,
    description: string,
    action: "retry" | "cancel",
  ): void {
    registerWriteTool(
      name,
      {
        mutates,
        recoverable: true,
        scopeTargetOf: (p) => ({ kind: "repo", value: p.projectPath }),
      },
      description,
      gitlabPipelineGetSchema,
      async (parsed) => {
        const token = requireProcessEnv("GITLAB_PAT");
        const enc = encodeURIComponent(parsed.projectPath);
        const path = `/projects/${enc}/pipelines/${String(parsed.pipelineId)}/${action}`;
        const res = await glFetch(token, path, { method: "POST" });
        if (!res.ok) {
          throw new Error(
            `GitLab pipeline ${action} ${String(res.status)}: ${res.text.slice(0, 400)}`,
          );
        }
        return mcpJsonResultIfOk("GitLab", res);
      },
    );
  }

  registerPipelineActionTool(
    "gitlab_pipeline_retry",
    "gitlab.pipeline.retry",
    "Retry failed jobs in a pipeline.",
    "retry",
  );
  registerPipelineActionTool(
    "gitlab_pipeline_cancel",
    "gitlab.pipeline.cancel",
    "Cancel a pipeline.",
    "cancel",
  );
}
