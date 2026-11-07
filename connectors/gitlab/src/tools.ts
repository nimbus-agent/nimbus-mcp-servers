import { z } from "zod";
import {
  assertCombinedSize,
  assertCommitFiles,
  COMMIT_MAX_COMBINED_BYTES,
  COMMIT_MAX_FILES,
  commitFilePathSchema,
  commitFilesSchema,
  fullShaSchema,
  notOverwritable,
} from "../../../shared/commit-files.ts";
import {
  type ConsentServer,
  createPrepareToolRegistrar,
  createWriteToolRegistrar,
  type WriteToolConfig,
} from "../../../shared/consent-kit.ts";
import { optionalBaseUrl } from "../../../shared/env-json-api.ts";
import { isSafeGitRef } from "../../../shared/github-rest.ts";
import { guardedFetch } from "../../../shared/guarded-fetch.ts";
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
import {
  branchHead,
  type GitlabFileRead,
  type GitlabGet,
  readGitlabFilesAt,
  refCommit,
} from "./gitlab-files.ts";

/**
 * A project reference that reaches a URL path: a numeric id, or `/`-separated segments of
 * `[A-Za-z0-9._-]`, none of them `.` or `..` (a URL parser collapses those out of the path).
 */
function isSafeProjectPath(p: string): boolean {
  return p.split("/").every((seg) => /^[A-Za-z0-9._-]+$/.test(seg) && seg !== "." && seg !== "..");
}

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
  // guardedFetch: the PRIVATE-TOKEN header must never follow a redirect to another origin.
  const res = await guardedFetch(
    "GitLab",
    url,
    { ...init, headers: mergedHeaders },
    { requireSecureBase: false },
  );
  return toRestFetchResult(res);
}

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

/** `<origin>/api/graphql` for the configured REST base, with or without its `/api/v4` suffix. */
function graphqlUrl(): string {
  return `${apiBase().replace(/\/api\/v4$/, "")}/api/graphql`;
}

/** APPEND is the whole point: REPLACE would drop the assignees already on the issue. */
const SET_ASSIGNEES_APPEND =
  "mutation($projectPath: ID!, $iid: String!, $assigneeUsernames: [String!]!) {" +
  " issueSetAssignees(input: { projectPath: $projectPath, iid: $iid," +
  " assigneeUsernames: $assigneeUsernames, operationMode: APPEND }) { errors } }";

/** The first GraphQL failure in a response (transport-level or the mutation's own), if any. */
function graphqlFailure(json: unknown): string | undefined {
  const body = json as {
    errors?: readonly { message?: string }[];
    data?: { issueSetAssignees?: { errors?: readonly string[] } | null } | null;
  } | null;
  if (body?.errors !== undefined && body.errors.length > 0) {
    return body.errors.map((e) => e.message ?? "unknown error").join("; ");
  }
  const inner = body?.data?.issueSetAssignees;
  if (inner === undefined || inner === null) {
    return "no issueSetAssignees result";
  }
  return inner.errors !== undefined && inner.errors.length > 0
    ? inner.errors.join("; ")
    : undefined;
}

/** A CI job's whole plain-text trace; throws, quoting GitLab, on a non-ok status. */
async function fetchJobTrace(parsed: {
  readonly projectPath: string;
  readonly jobId: number;
}): Promise<string> {
  const token = requireProcessEnv("GITLAB_PAT");
  const enc = encodeURIComponent(parsed.projectPath);
  const url = `${apiBase()}/projects/${enc}/jobs/${String(parsed.jobId)}/trace`;
  const res = await guardedFetch(
    "GitLab",
    url,
    { headers: { "PRIVATE-TOKEN": token } },
    { requireSecureBase: false },
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GitLab ${String(res.status)}: ${text.slice(0, 300)}`);
  }
  return text;
}

/** Tool names exposed by this connector — for contract/introspection tests. */
export const GITLAB_TOOL_NAMES = [
  "gitlab_project_list",
  "gitlab_mr_list",
  "gitlab_mr_get",
  "gitlab_mr_merge",
  "gitlab_issue_list",
  "gitlab_issue_get",
  "gitlab_issue_create",
  "gitlab_issue_note_create",
  "gitlab_mr_note_create",
  "gitlab_issue_labels_add",
  "gitlab_issue_assignees_add",
  "gitlab_issue_state_set",
  "gitlab_branch_create",
  "gitlab_mr_create",
  "gitlab_mr_update",
  "gitlab_pipeline_list",
  "gitlab_pipeline_get",
  "gitlab_pipeline_jobs_get",
  "gitlab_job_trace",
  "gitlab_job_log_tail",
  "gitlab_pipeline_retry",
  "gitlab_pipeline_cancel",
  "gitlab_files_get",
  "gitlab_commit_prepare",
  "gitlab_commit_create",
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
   * Prepare tools (shared/prepare-tool-ids.ts) read the state a write is bound to, for the gateway to
   * call BEFORE the write's approval prompt; they are neither reads nor writes to the kit.
   */
  const registerPrepareTool = createPrepareToolRegistrar(server, {
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
      .refine(isSafeProjectPath, "not a valid project path or numeric id")
      .describe("URL-encoded path or numeric project id, e.g. group/repo"),
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

  const FULL_SHA = /^[0-9a-f]{40}$/i;

  const gitlabMrMergeSchema = projectPathArg.extend({
    mergeRequestIid: z.number().int().min(1),
    mergeCommitMessage: z.string().max(10_000).optional(),
    squash: z.boolean().optional(),
    shouldRemoveSourceBranch: z.boolean().optional(),
    sha: z.string().regex(FULL_SHA, "a full 40-hex commit sha").optional(),
  });

  registerGitlabWriteTool(
    "gitlab_mr_merge",
    {
      mutates: "gitlab.mr.merge",
      recoverable: true,
    },
    "Merge a merge request. If `sha` (40 hex) is given it is sent as the API's `sha` parameter, and GitLab fails the merge when the source branch head is no longer that commit (https://docs.gitlab.com/api/merge_requests/#merge-a-merge-request).",
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
      if (parsed.sha !== undefined) {
        body["sha"] = parsed.sha;
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

  /** One label: GitLab joins a label list with commas, so a comma inside one would split it in two. */
  const labelSchema = z
    .string()
    .min(1)
    .max(255)
    .refine((l) => !l.includes(","), "a label cannot contain a comma");
  const assigneeIdSchema = z.number().int().min(1);
  const noteBodySchema = z.string().min(1).max(65_000);
  const issuePath = (p: { projectPath: string; issueIid: number }): string =>
    `/projects/${encodeURIComponent(p.projectPath)}/issues/${String(p.issueIid)}`;
  const jsonBody = (method: "POST" | "PUT", body: unknown): RequestInit => ({
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  registerGitlabWriteTool(
    "gitlab_issue_create",
    { mutates: "gitlab.issue.create", recoverable: true },
    "Create a new issue in a project, optionally with labels and assignees.",
    projectPathArg.extend({
      title: z.string().min(1).max(255),
      description: z.string().max(65_000).optional(),
      labels: z.array(labelSchema).max(50).optional(),
      assigneeIds: z.array(assigneeIdSchema).max(20).optional(),
    }),
    (parsed) => `/projects/${encodeURIComponent(parsed.projectPath)}/issues`,
    (parsed) =>
      jsonBody("POST", {
        title: parsed.title,
        description: parsed.description,
        labels: parsed.labels?.join(","),
        assignee_ids: parsed.assigneeIds,
      }),
  );

  registerGitlabWriteTool(
    "gitlab_issue_note_create",
    { mutates: "gitlab.issue.note.create", recoverable: true },
    "Add a comment (note) to an issue; it posts as the authenticated user and changes nothing else.",
    gitlabIssueGetSchema.extend({ body: noteBodySchema }),
    (parsed) => `${issuePath(parsed)}/notes`,
    (parsed) => jsonBody("POST", { body: parsed.body }),
  );

  registerGitlabWriteTool(
    "gitlab_mr_note_create",
    { mutates: "gitlab.mr.note.create", recoverable: true },
    "Add a comment (note) to a merge request; it posts as the authenticated user and changes nothing else.",
    gitlabMrGetSchema.extend({ body: noteBodySchema }),
    (parsed) =>
      `/projects/${encodeURIComponent(parsed.projectPath)}/merge_requests/${String(parsed.mergeRequestIid)}/notes`,
    (parsed) => jsonBody("POST", { body: parsed.body }),
  );

  registerGitlabWriteTool(
    "gitlab_issue_labels_add",
    { mutates: "gitlab.issue.labels.add", recoverable: true },
    "Add labels to an issue; it only adds, and cannot remove or replace any existing label.",
    gitlabIssueGetSchema.extend({ labels: z.array(labelSchema).min(1).max(50) }),
    issuePath,
    (parsed) => jsonBody("PUT", { add_labels: parsed.labels.join(",") }),
  );

  // REST "Update an issue" can only REPLACE assignees (`assignee_ids`), so the add goes through
  // GraphQL's issueSetAssignees in APPEND mode: one atomic server-side add that removes nobody.
  registerWriteTool(
    "gitlab_issue_assignees_add",
    {
      mutates: "gitlab.issue.assignees.add",
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "repo", value: p.projectPath }),
    },
    "Add assignees (usernames) to an issue; it only adds, and cannot remove any existing assignee.",
    gitlabIssueGetSchema.extend({
      assigneeUsernames: z.array(z.string().min(1).max(255)).min(1).max(20),
    }),
    async (parsed) => {
      const token = requireProcessEnv("GITLAB_PAT");
      // GitLab documents `Authorization: Bearer` for /api/graphql (PRIVATE-TOKEN is the REST
      // header), so this one request bypasses glFetch. Never the private_token query parameter:
      // a token in a URL is logged.
      const res = await toRestFetchResult(
        await guardedFetch(
          "GitLab",
          graphqlUrl(),
          {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              query: SET_ASSIGNEES_APPEND,
              variables: {
                projectPath: parsed.projectPath,
                iid: String(parsed.issueIid),
                assigneeUsernames: parsed.assigneeUsernames,
              },
            }),
          },
          { requireSecureBase: false },
        ),
      );
      if (!res.ok) {
        throw new Error(`GitLab ${String(res.status)}: ${res.text.slice(0, 300)}`);
      }
      const failure = graphqlFailure(res.json);
      if (failure !== undefined) {
        throw new Error(`GitLab GraphQL: ${failure}`);
      }
      return jsonResult({ ok: true, assignees: parsed.assigneeUsernames });
    },
  );

  registerGitlabWriteTool(
    "gitlab_issue_state_set",
    { mutates: "gitlab.issue.state.set", recoverable: true },
    "Close or reopen an issue (stateEvent close or reopen); it changes only the state and can be reversed.",
    gitlabIssueGetSchema.extend({ stateEvent: z.enum(["close", "reopen"]) }),
    issuePath,
    (parsed) => jsonBody("PUT", { state_event: parsed.stateEvent }),
  );

  /**
   * A branch or ref name placed in a URL and sent to GitLab: the same rule as GitHub's
   * (`isSafeGitRef`, ASCII only, so no format, control or surrogate character can pass).
   */
  const gitlabRefSchema = z
    .string()
    .min(1)
    .max(255)
    .refine(isSafeGitRef, "not a valid branch or ref name");

  /**
   * A branch name that goes in a JSON body: GitLab's own rules apply, but a format (invisible or
   * bidi), control or lone-surrogate character is refused, so an approval prompt shows what is sent.
   */
  const branchNameSchema = z
    .string()
    .min(1)
    .max(255)
    .refine(
      (v) => !/[\p{Cf}\p{Cc}\p{Cs}]/u.test(v),
      "branch name has an invisible or control character",
    );

  registerWriteTool(
    "gitlab_branch_create",
    // A new branch is undone by deleting it, so nothing needs capturing first.
    {
      mutates: "gitlab.branch.create",
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "repo", value: p.projectPath }),
    },
    "Create a branch from a branch, tag or commit (fromRef). If expectedSha (40 hex) is given, fromRef is first resolved to a commit: when that commit is not expectedSha nothing is created, otherwise the branch is created from exactly that commit.",
    projectPathArg.extend({
      branch: gitlabRefSchema,
      fromRef: gitlabRefSchema,
      expectedSha: z.string().regex(FULL_SHA).optional(),
    }),
    async (parsed) => {
      const token = requireProcessEnv("GITLAB_PAT");
      const project = encodeURIComponent(parsed.projectPath);
      let ref = parsed.fromRef;
      if (parsed.expectedSha !== undefined) {
        // https://docs.gitlab.com/api/commits/#get-a-single-commit — `sha` is a hash or a branch or
        // tag name; the response's `id` is the full commit hash.
        const commit = await glFetch(
          token,
          `/projects/${project}/repository/commits/${encodeURIComponent(parsed.fromRef)}`,
        );
        const id = (commit.json as { id?: unknown } | null)?.id;
        if (!commit.ok || typeof id !== "string" || !FULL_SHA.test(id)) {
          throw new Error(`GitLab ${String(commit.status)}: ${commit.text.slice(0, 300)}`);
        }
        if (id.toLowerCase() !== parsed.expectedSha.toLowerCase()) {
          throw new Error(`fromRef resolves to ${id}, not the approved ${parsed.expectedSha}`);
        }
        ref = id.toLowerCase();
      }
      const res = await glFetch(
        token,
        listUrl(`/projects/${project}/repository/branches`, (q) => {
          q.set("branch", parsed.branch);
          q.set("ref", ref);
        }),
        { method: "POST" },
      );
      return mcpJsonResultIfOk("GitLab", res);
    },
  );

  registerGitlabWriteTool(
    "gitlab_mr_create",
    { mutates: "gitlab.mr.create", recoverable: true },
    "Open a merge request from sourceBranch into targetBranch. Title and description are sent exactly as given.",
    projectPathArg.extend({
      sourceBranch: branchNameSchema,
      targetBranch: branchNameSchema,
      title: z.string().min(1).max(255),
      description: z.string().max(65_000).optional(),
    }),
    (parsed) => `/projects/${encodeURIComponent(parsed.projectPath)}/merge_requests`,
    (parsed) =>
      jsonBody("POST", {
        source_branch: parsed.sourceBranch,
        target_branch: parsed.targetBranch,
        title: parsed.title,
        ...(parsed.description === undefined ? {} : { description: parsed.description }),
      }),
  );

  // A plain object, not a `.refine()`d one: the registrar passes `.shape` as the MCP inputSchema and a
  // refined object has none. The at-least-one check is the handler's.
  const mrPath = (p: { projectPath: string; mergeRequestIid: number }): string =>
    `/projects/${encodeURIComponent(p.projectPath)}/merge_requests/${String(p.mergeRequestIid)}`;

  registerGitlabWriteTool(
    "gitlab_mr_update",
    {
      mutates: "gitlab.mr.update",
      // An edit overwrites text; its inverse needs the old text, so capture it first.
      recoverable: false,
      capturePreState: async (parsed) => {
        const token = requireProcessEnv("GITLAB_PAT");
        const res = await glFetch(token, mrPath(parsed));
        const mr = res.json as {
          title?: unknown;
          description?: unknown;
          target_branch?: unknown;
        } | null;
        if (!res.ok || mr === null) return { resolved: false, status: res.status };
        return { title: mr.title, description: mr.description, target_branch: mr.target_branch };
      },
    },
    "Edit a merge request's title, description or target branch (at least one). It never closes, reopens or merges it.",
    gitlabMrGetSchema.extend({
      title: z.string().min(1).max(255).optional(),
      description: z.string().max(65_000).optional(),
      targetBranch: branchNameSchema.optional(),
    }),
    mrPath,
    (parsed) => {
      if (
        parsed.title === undefined &&
        parsed.description === undefined &&
        parsed.targetBranch === undefined
      ) {
        throw new Error("gitlab_mr_update needs at least one of title, description, targetBranch");
      }
      return jsonBody("PUT", {
        ...(parsed.title === undefined ? {} : { title: parsed.title }),
        ...(parsed.description === undefined ? {} : { description: parsed.description }),
        ...(parsed.targetBranch === undefined ? {} : { target_branch: parsed.targetBranch }),
      });
    },
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

  // -------------------------------------------------------------------------------------------
  // Multi-file commit: gitlab_files_get (read), gitlab_commit_prepare (prepare), gitlab_commit_create
  // -------------------------------------------------------------------------------------------

  /** Bound GETs: the token is read at call time, before the first request. */
  const gitlabGet = (): GitlabGet => {
    const token = requireProcessEnv("GITLAB_PAT");
    return (path) => glFetch(token, path);
  };

  const READ_LIMIT = COMMIT_MAX_COMBINED_BYTES;

  /** What a read tool reports for one file; `content` only for text. */
  function fileView(f: GitlabFileRead): Record<string, unknown> {
    if (!f.exists) return { path: f.path, exists: false };
    const base = {
      path: f.path,
      exists: true,
      lastCommitId: f.lastCommitId,
      executable: f.executable,
      size: f.size,
    };
    return f.kind === "text" ? { ...base, content: f.content } : { ...base, withheld: f.kind };
  }

  reg(
    "gitlab_files_get",
    "Read up to 50 files at a branch, tag or commit: {ref, headSha, files:[{path, exists, lastCommitId, executable, size, content}]}. A binary or over-192-KiB file is reported with `withheld` instead of content.",
    projectPathArg.extend({
      ref: gitlabRefSchema,
      paths: z.array(commitFilePathSchema).min(1).max(50),
    }),
    async (parsed) => {
      const get = gitlabGet();
      const project = encodeURIComponent(parsed.projectPath);
      const sha = await refCommit(get, project, parsed.ref);
      const files = await readGitlabFilesAt(get, project, sha, parsed.paths, READ_LIMIT);
      return jsonResult({ ref: parsed.ref, headSha: sha, files: files.map(fileView) });
    },
  );

  const gitlabCommitInputSchema = projectPathArg.extend({
    branch: gitlabRefSchema,
    files: commitFilesSchema,
  });

  const repoScopeOf = (p: { projectPath: string }): { kind: string; value: string } => ({
    kind: "repo",
    value: p.projectPath,
  });

  registerPrepareTool(
    "gitlab_commit_prepare",
    { scopeTargetOf: repoScopeOf },
    `Read the state a gitlab_commit_create is bound to: the branch head and, for each file, whether it exists, its last_commit_id, whether it is executable and its current content. Refuses (no truncation) a commit that touches more than ${String(COMMIT_MAX_FILES)} files or whose old and new content together exceed 192 KiB, and any existing file that is not a text file. Takes the commit's own projectPath, branch and files.`,
    gitlabCommitInputSchema,
    async (parsed) => {
      assertCommitFiles(parsed.files);
      const get = gitlabGet();
      const project = encodeURIComponent(parsed.projectPath);
      const head = await branchHead(get, project, parsed.branch);
      const read = await readGitlabFilesAt(
        get,
        project,
        head,
        parsed.files.map((f) => f.path),
        READ_LIMIT,
      );
      let oldBytes = 0;
      const files = read.map((f) => {
        if (!f.exists) return { path: f.path, exists: false };
        if (f.kind !== "text") throw notOverwritable(f.path);
        oldBytes += f.size;
        return {
          path: f.path,
          exists: true,
          lastCommitId: f.lastCommitId,
          executable: f.executable,
          oldContent: f.content,
        };
      });
      assertCombinedSize(oldBytes, parsed.files);
      return jsonResult({ headSha: head, files });
    },
  );

  registerWriteTool(
    "gitlab_commit_create",
    {
      mutates: "gitlab.commit.create",
      // A commit moves a branch; the inverse needs the head and each file's last commit, captured first.
      recoverable: false,
      capturePreState: async (parsed) => {
        const get = gitlabGet();
        const project = encodeURIComponent(parsed.projectPath);
        const head = await branchHead(get, project, parsed.branch);
        const read = await readGitlabFilesAt(
          get,
          project,
          head,
          parsed.files.map((f) => f.path),
          READ_LIMIT,
        );
        return {
          branch: parsed.branch,
          headSha: head,
          files: read.map((f) => ({
            path: f.path,
            lastCommitId: f.exists ? f.lastCommitId : null,
          })),
        };
      },
      scopeTargetOf: repoScopeOf,
    },
    "Commit one or more whole text files to a branch as ONE commit, but only if the branch head is still expectedHeadSha (the head the owner approved). GitLab has no head-conditional commit: each update carries the file's last_commit_id read at that head, so a change to one of THESE files is refused, while a change to other files between the check and the commit is not detected, and the result reports movedHead when the new commit's parent is not the approved head. Never forced.",
    gitlabCommitInputSchema.extend({
      message: z.string().min(1).max(5000),
      expectedHeadSha: fullShaSchema,
    }),
    async (parsed) => {
      assertCommitFiles(parsed.files);
      const get = gitlabGet();
      const token = requireProcessEnv("GITLAB_PAT");
      const project = encodeURIComponent(parsed.projectPath);
      const expected = parsed.expectedHeadSha.toLowerCase();
      // 1. The head AGAIN: the approval was for this commit, not for whatever the branch became.
      const head = await branchHead(get, project, parsed.branch);
      if (head !== expected) {
        throw new Error(`branch head is ${head}, not the approved ${expected}`);
      }
      // 2. Each existing file AT that head: its last_commit_id goes on the update action.
      const read = await readGitlabFilesAt(
        get,
        project,
        head,
        parsed.files.map((f) => f.path),
        READ_LIMIT,
      );
      let oldBytes = 0;
      const actions = parsed.files.map((f, i) => {
        const existing = read[i];
        if (existing === undefined || !existing.exists) {
          return { action: "create", file_path: f.path, content: f.content, encoding: "text" };
        }
        if (existing.kind !== "text") throw notOverwritable(f.path);
        oldBytes += existing.size;
        return {
          action: "update",
          file_path: f.path,
          content: f.content,
          encoding: "text",
          last_commit_id: existing.lastCommitId,
        };
      });
      assertCombinedSize(oldBytes, parsed.files);
      // 3. One commit, no force, no start_branch.
      const res = await glFetch(
        token,
        `/projects/${project}/repository/commits`,
        jsonBody("POST", { branch: parsed.branch, commit_message: parsed.message, actions }),
      );
      if (!res.ok) {
        throw new Error(`GitLab ${String(res.status)}: ${res.text.slice(0, 300)}`);
      }
      const made = (res.json ?? {}) as { id?: unknown; parent_ids?: unknown; web_url?: unknown };
      // The head can move between step 1 and this POST (the API has no head-conditional commit):
      // say so when the new commit's parent is not the head that was approved.
      const movedHead = !(
        Array.isArray(made.parent_ids) && made.parent_ids.map(String).includes(expected)
      );
      return jsonResult({
        ok: true,
        commitId: made.id,
        branch: parsed.branch,
        parent: expected,
        webUrl: made.web_url,
        movedHead,
      });
    },
  );
}
