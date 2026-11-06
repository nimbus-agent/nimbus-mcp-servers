import { z } from "zod";
import {
  type ConsentServer,
  createWriteToolRegistrar,
  type WriteToolConfig,
} from "../../../shared/consent-kit.ts";
import {
  ghFetch,
  ghQueryPath,
  ghRepoPath,
  isSafeGitRef,
  resolveCommitSha,
  setGhPaging,
} from "../../../shared/github-rest.ts";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
  requireProcessEnv,
  type ZodObjectSchema,
} from "../../../shared/mcp-tool-kit.ts";
import {
  makeRestToolRegistrar,
  makeRestWriteToolRegistrar,
} from "../../../shared/rest-tool-kit.ts";

/** Tool names exposed by this connector — for contract/introspection tests. */
export const GITHUB_TOOL_NAMES = [
  "github_repo_list",
  "github_repo_get",
  "github_pr_list",
  "github_pr_get",
  "github_pr_merge",
  "github_pr_close",
  "github_issue_list",
  "github_issue_get",
  "github_issue_create",
  "github_issue_comment_create",
  "github_issue_labels_add",
  "github_issue_assignees_add",
  "github_issue_state_set",
  "github_ci_runs",
  "github_ci_run_get",
  "github_branch_delete",
  "github_ref_get",
  "github_branch_create",
  "github_pr_create",
  "github_pr_update",
  "github_tag_create",
  "github_commit_push",
] as const;

export function registerGithubTools(
  server: ConsentServer & { tool: (...args: never) => unknown },
): void {
  const registerSimpleTool = createRegisterSimpleTool(server);
  const reg = createZodToolRegistrar(registerSimpleTool);

  /**
   * Every MUTATING GitHub tool goes through here. Outside the gateway this adds the consent gate,
   * the write-scope allow-list, the mutation budget and the audit record; inside the gateway it is a
   * pass-through, because executor.ts (I2) is the gate there.
   */
  const registerWriteTool = createWriteToolRegistrar(server, {
    connector: "github",
    scopeEnv: "NIMBUS_MCP_GITHUB_WRITE_SCOPE",
    scopeKinds: ["repo"],
  });

  /** Standard GitHub tool, read or write: token → ghFetch(buildPath[, buildInit]) → mcpJsonResultIfOk("GitHub"). */
  const githubRest = { tokenEnv: "GITHUB_PAT", serviceLabel: "GitHub", fetch: ghFetch } as const;
  const registerGithubTool = makeRestToolRegistrar({ registrar: reg, ...githubRest });
  const registerRestWriteTool = makeRestWriteToolRegistrar({ registerWriteTool, ...githubRest });

  const repoScope = (p: { owner: string; repo: string }): { kind: string; value: string } => ({
    kind: "repo",
    value: `${p.owner}/${p.repo}`,
  });

  /**
   * The write-tool equivalent of `registerGithubTool`, routed through the write registrar.
   * `scopeTargetOf` is supplied here rather than per tool — every GitHub mutation is scoped to one
   * `owner/repo`, and deriving it centrally means a new write tool cannot forget it.
   */
  function registerGithubWriteTool<T extends { owner: string; repo: string }>(
    name: string,
    cfg: Omit<WriteToolConfig<T>, "scopeTargetOf">,
    description: string,
    schema: ZodObjectSchema<T>,
    buildPath: (parsed: T) => string,
    buildInit?: (parsed: T) => RequestInit,
  ): void {
    registerRestWriteTool(
      name,
      { ...cfg, scopeTargetOf: repoScope },
      description,
      schema,
      buildPath,
      buildInit,
    );
  }

  const jsonInit = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const repoSlugArgs = z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
  });

  const githubRepoListSchema = z.object({
    perPage: z.number().int().min(1).max(100).optional(),
    page: z.number().int().min(1).optional(),
  });

  registerGithubTool(
    "github_repo_list",
    "List repositories for the authenticated user (affiliation: owner, collaborator, organization_member).",
    githubRepoListSchema,
    (parsed) =>
      ghQueryPath("/user/repos", (q) => {
        setGhPaging(q, parsed);
        q.set("sort", "updated");
        q.set("affiliation", "owner,collaborator,organization_member");
      }),
  );

  registerGithubTool(
    "github_repo_get",
    "Get repository metadata (owner/repo).",
    repoSlugArgs,
    (parsed) => ghRepoPath(parsed.owner, parsed.repo),
  );

  /** Pulls and issues take one list query: a state filter, paging, newest activity first. */
  const githubStateListSchema = repoSlugArgs.extend({
    state: z.enum(["open", "closed", "all"]).optional(),
    perPage: z.number().int().min(1).max(100).optional(),
    page: z.number().int().min(1).optional(),
  });
  const stateListPath =
    (collection: "pulls" | "issues") =>
    (parsed: z.infer<typeof githubStateListSchema>): string =>
      ghQueryPath(`${ghRepoPath(parsed.owner, parsed.repo)}/${collection}`, (q) => {
        q.set("state", parsed.state ?? "open");
        setGhPaging(q, parsed);
        q.set("sort", "updated");
        q.set("direction", "desc");
      });

  registerGithubTool(
    "github_pr_list",
    "List pull requests for a repository.",
    githubStateListSchema,
    stateListPath("pulls"),
  );

  const githubPrNumberSchema = repoSlugArgs.extend({
    pullNumber: z.number().int().min(1),
  });

  registerGithubTool(
    "github_pr_get",
    "Get a single pull request by number.",
    githubPrNumberSchema,
    (parsed) => `${ghRepoPath(parsed.owner, parsed.repo)}/pulls/${String(parsed.pullNumber)}`,
  );

  const githubPrMergeSchema = repoSlugArgs.extend({
    pullNumber: z.number().int().min(1),
    mergeMethod: z.enum(["merge", "squash", "rebase"]).optional(),
    commitTitle: z.string().max(500).optional(),
  });

  registerGithubWriteTool(
    "github_pr_merge",
    { mutates: "github.pr.merge", recoverable: true },
    "Merge a pull request.",
    githubPrMergeSchema,
    (parsed) => `${ghRepoPath(parsed.owner, parsed.repo)}/pulls/${String(parsed.pullNumber)}/merge`,
    (parsed) => {
      const body: Record<string, string> = {};
      if (parsed.mergeMethod !== undefined) {
        body["merge_method"] = parsed.mergeMethod;
      }
      if (parsed.commitTitle !== undefined && parsed.commitTitle !== "") {
        body["commit_title"] = parsed.commitTitle;
      }
      return jsonInit("PUT", body);
    },
  );

  registerGithubWriteTool(
    "github_pr_close",
    { mutates: "github.pr.close", recoverable: true },
    "Close a pull request without merging.",
    githubPrNumberSchema,
    (parsed) => `${ghRepoPath(parsed.owner, parsed.repo)}/pulls/${String(parsed.pullNumber)}`,
    () => jsonInit("PATCH", { state: "closed" }),
  );

  registerGithubTool(
    "github_issue_list",
    "List issues for a repository.",
    githubStateListSchema,
    stateListPath("issues"),
  );

  const githubIssueGetSchema = repoSlugArgs.extend({
    issueNumber: z.number().int().min(1),
  });

  registerGithubTool(
    "github_issue_get",
    "Get a single issue by number.",
    githubIssueGetSchema,
    (parsed) => `${ghRepoPath(parsed.owner, parsed.repo)}/issues/${String(parsed.issueNumber)}`,
  );

  const githubIssueCreateSchema = repoSlugArgs.extend({
    title: z.string().min(1).max(500),
    body: z.string().max(65_000).optional(),
  });

  registerGithubWriteTool(
    "github_issue_create",
    { mutates: "github.issue.create", recoverable: true },
    "Create a new issue in a repository.",
    githubIssueCreateSchema,
    (parsed) => `${ghRepoPath(parsed.owner, parsed.repo)}/issues`,
    (parsed) => jsonInit("POST", { title: parsed.title, body: parsed.body }),
  );

  const githubIssueNumberSchema = repoSlugArgs.extend({
    issueNumber: z.number().int().min(1),
  });
  const issuePath = (parsed: z.infer<typeof githubIssueNumberSchema>): string =>
    `${ghRepoPath(parsed.owner, parsed.repo)}/issues/${String(parsed.issueNumber)}`;

  registerGithubWriteTool(
    "github_issue_comment_create",
    { mutates: "github.issue.comment.create", recoverable: true },
    "Add a comment to an issue or a pull request's conversation (pull requests are issues to GitHub); it posts as the authenticated user and changes nothing else.",
    githubIssueNumberSchema.extend({ body: z.string().min(1).max(65_000) }),
    (parsed) => `${issuePath(parsed)}/comments`,
    (parsed) => jsonInit("POST", { body: parsed.body }),
  );

  registerGithubWriteTool(
    "github_issue_labels_add",
    { mutates: "github.issue.labels.add", recoverable: true },
    "Add labels to an issue or pull request; a label that does not exist yet is created in the repository. It only adds, and cannot remove or replace any existing label.",
    githubIssueNumberSchema.extend({
      labels: z.array(z.string().min(1).max(50)).min(1).max(100),
    }),
    (parsed) => `${issuePath(parsed)}/labels`,
    (parsed) => jsonInit("POST", { labels: parsed.labels }),
  );

  registerGithubWriteTool(
    "github_issue_assignees_add",
    { mutates: "github.issue.assignees.add", recoverable: true },
    "Add assignees to an issue or pull request; it only adds, and cannot remove any existing assignee.",
    githubIssueNumberSchema.extend({
      assignees: z.array(z.string().min(1).max(39)).min(1).max(10),
    }),
    (parsed) => `${issuePath(parsed)}/assignees`,
    (parsed) => jsonInit("POST", { assignees: parsed.assignees }),
  );

  registerGithubWriteTool(
    "github_issue_state_set",
    { mutates: "github.issue.state.set", recoverable: true },
    "Open or close an issue (state open or closed); given a pull request number it closes or reopens that pull request. It changes only the state and can be reversed by setting it back.",
    githubIssueNumberSchema.extend({ state: z.enum(["open", "closed"]) }),
    issuePath,
    (parsed) => jsonInit("PATCH", { state: parsed.state }),
  );

  const githubCiRunsSchema = repoSlugArgs.extend({
    perPage: z.number().int().min(1).max(100).optional(),
    page: z.number().int().min(1).optional(),
  });

  registerGithubTool(
    "github_ci_runs",
    "List GitHub Actions workflow runs for a repository.",
    githubCiRunsSchema,
    (parsed) =>
      ghQueryPath(`${ghRepoPath(parsed.owner, parsed.repo)}/actions/runs`, (q) => {
        setGhPaging(q, parsed);
      }),
  );

  const githubCiRunGetSchema = repoSlugArgs.extend({
    runId: z.number().int().min(1),
  });

  registerGithubTool(
    "github_ci_run_get",
    "Get a single workflow run including jobs URL reference.",
    githubCiRunGetSchema,
    (parsed) => `${ghRepoPath(parsed.owner, parsed.repo)}/actions/runs/${String(parsed.runId)}`,
  );

  const githubBranchDeleteSchema = repoSlugArgs.extend({
    branch: z.string().min(1).max(255),
  });

  registerWriteTool(
    "github_branch_delete",
    {
      mutates: "github.branch.delete",
      // The only GitHub mutation here that cannot be undone from its own result, so the ref's SHA is
      // captured BEFORE the delete. With it the branch can be recreated; without it the commit is
      // only reachable by reflog on someone's clone.
      recoverable: false,
      capturePreState: async (parsed) => {
        const token = requireProcessEnv("GITHUB_PAT");
        const ref = `heads/${parsed.branch}`;
        const res = await ghFetch(
          token,
          `${ghRepoPath(parsed.owner, parsed.repo)}/git/ref/${encodeURIComponent(ref)}`,
        );
        return { ref, resolved: res.ok, sha: res.json };
      },
      scopeTargetOf: (parsed) => ({ kind: "repo", value: `${parsed.owner}/${parsed.repo}` }),
    },
    "Delete a branch by ref name.",
    githubBranchDeleteSchema,
    async (parsed) => {
      const token = requireProcessEnv("GITHUB_PAT");
      const ref = `heads/${parsed.branch}`;
      const path = `${ghRepoPath(parsed.owner, parsed.repo)}/git/refs/${encodeURIComponent(ref)}`;
      const res = await ghFetch(token, path, { method: "DELETE" });
      if (!res.ok && res.status !== 204) {
        throw new Error(`GitHub ${String(res.status)}: ${res.text.slice(0, 300)}`);
      }
      return jsonResult({ ok: true, deleted: ref });
    },
  );

  /** A ref the model names reaches a URL path, so every one passes `isSafeGitRef` at the schema. */
  const gitRefSchema = z.string().min(1).max(255).refine(isSafeGitRef, "not a safe git ref name");

  const githubRefGetSchema = repoSlugArgs.extend({ ref: gitRefSchema });

  reg(
    "github_ref_get",
    "Resolve a branch, tag or commit to its commit SHA (a bare name is tried as a branch, then a tag; an annotated tag resolves to its commit). Returns {ref, kind: branch|tag|sha, sha}.",
    githubRefGetSchema,
    async (parsed) => {
      const token = requireProcessEnv("GITHUB_PAT");
      const { sha, kind } = await resolveCommitSha(token, parsed.owner, parsed.repo, parsed.ref);
      return jsonResult({ ref: parsed.ref, kind, sha });
    },
  );

  const githubBranchCreateSchema = repoSlugArgs.extend({
    branch: gitRefSchema,
    fromRef: gitRefSchema,
    expectedSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/i)
      .optional(),
  });

  registerWriteTool(
    "github_branch_create",
    // A new ref is undone by github_branch_delete, so there is nothing to capture first.
    { mutates: "github.branch.create", recoverable: true, scopeTargetOf: repoScope },
    "Create a branch from a branch, tag or commit (fromRef). If expectedSha is given and fromRef now resolves to a different commit, nothing is created.",
    githubBranchCreateSchema,
    async (parsed) => {
      const token = requireProcessEnv("GITHUB_PAT");
      const { sha } = await resolveCommitSha(token, parsed.owner, parsed.repo, parsed.fromRef);
      if (parsed.expectedSha !== undefined && parsed.expectedSha.toLowerCase() !== sha) {
        throw new Error(`fromRef resolves to ${sha}, not the approved ${parsed.expectedSha}`);
      }
      const ref = `refs/heads/${parsed.branch}`;
      const res = await ghFetch(
        token,
        `${ghRepoPath(parsed.owner, parsed.repo)}/git/refs`,
        jsonInit("POST", { ref, sha }),
      );
      if (!res.ok) {
        throw new Error(`GitHub ${String(res.status)}: ${res.text.slice(0, 300)}`);
      }
      return jsonResult({ ok: true, ref, sha, fromRef: parsed.fromRef });
    },
  );

  const githubPrCreateSchema = repoSlugArgs.extend({
    head: z.string().min(1).max(255),
    base: z.string().min(1).max(255),
    title: z.string().min(1).max(256),
    body: z.string().max(65_000).optional(),
    draft: z.boolean().optional(),
  });

  registerGithubWriteTool(
    "github_pr_create",
    { mutates: "github.pr.create", recoverable: true },
    "Open a pull request from head (a branch, or user:branch for a fork) into base. Title and body are sent exactly as given.",
    githubPrCreateSchema,
    (parsed) => `${ghRepoPath(parsed.owner, parsed.repo)}/pulls`,
    (parsed) =>
      jsonInit("POST", {
        head: parsed.head,
        base: parsed.base,
        title: parsed.title,
        ...(parsed.body === undefined ? {} : { body: parsed.body }),
        ...(parsed.draft === undefined ? {} : { draft: parsed.draft }),
      }),
  );

  // A plain object, not a `.refine()`d one: the registrar passes `.shape` as the MCP inputSchema and a
  // refined object has none. The at-least-one check is the handler's.
  const githubPrUpdateSchema = githubPrNumberSchema.extend({
    title: z.string().min(1).max(256).optional(),
    body: z.string().max(65_000).optional(),
    base: z.string().min(1).max(255).optional(),
  });
  const prPath = (parsed: { owner: string; repo: string; pullNumber: number }): string =>
    `${ghRepoPath(parsed.owner, parsed.repo)}/pulls/${String(parsed.pullNumber)}`;

  registerGithubWriteTool(
    "github_pr_update",
    {
      mutates: "github.pr.update",
      // An edit overwrites text; its inverse needs the old text, so capture it first.
      recoverable: false,
      capturePreState: async (parsed) => {
        const token = requireProcessEnv("GITHUB_PAT");
        const res = await ghFetch(token, prPath(parsed));
        const pr = res.json as { title?: unknown; body?: unknown; base?: { ref?: unknown } } | null;
        if (!res.ok || pr === null) return { resolved: false, status: res.status };
        return { title: pr.title, body: pr.body, base: pr.base?.ref };
      },
    },
    "Edit a pull request's title, body or base branch (at least one). It never opens, closes or merges it.",
    githubPrUpdateSchema,
    prPath,
    (parsed) => {
      if (parsed.title === undefined && parsed.body === undefined && parsed.base === undefined) {
        throw new Error("github_pr_update needs at least one of title, body, base");
      }
      return jsonInit("PATCH", {
        ...(parsed.title === undefined ? {} : { title: parsed.title }),
        ...(parsed.body === undefined ? {} : { body: parsed.body }),
        ...(parsed.base === undefined ? {} : { base: parsed.base }),
      });
    },
  );

  const githubTagCreateSchema = repoSlugArgs.extend({
    tag: z.string().min(1).max(255),
    sha: z.string().min(7).max(40),
  });

  registerGithubWriteTool(
    "github_tag_create",
    { mutates: "github.tag.create", recoverable: true },
    "Create a lightweight tag pointing at a commit SHA.",
    githubTagCreateSchema,
    (parsed) => `${ghRepoPath(parsed.owner, parsed.repo)}/git/refs`,
    (parsed) => jsonInit("POST", { ref: `refs/tags/${parsed.tag}`, sha: parsed.sha }),
  );

  const githubCommitPushSchema = repoSlugArgs.extend({
    branch: z.string().min(1).optional(),
  });

  reg(
    "github_commit_push",
    "Push commits is not available via this tool — use local git with your own remote credentials (requires HITL repo.commit.push if ever implemented).",
    githubCommitPushSchema,
    () =>
      Promise.resolve(
        jsonResult({
          code: "NOT_IMPLEMENTED",
          message:
            "Pushing commits requires local git and is not executed by this MCP server. Clone the repo and push with git.",
        }),
      ),
  );
}
