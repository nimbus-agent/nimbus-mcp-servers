import { z } from "zod";
import type { ConsentServer } from "../../../shared/consent-kit.ts";
import { createWriteToolRegistrar } from "../../../shared/consent-kit.ts";
import { resolveUrlWithBase } from "../../../shared/fetch-bearer-json.ts";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  encodeBasicAuthHeader,
  type McpListResult,
  mcpJsonResultIfOk,
  requireProcessEnv,
} from "../../../shared/mcp-tool-kit.ts";
import { type RestFetchResult, toRestFetchResult } from "../../../shared/rest-tool-kit.ts";

const BB_API = "https://api.bitbucket.org/2.0";

function basicAuthHeader(): string {
  const user = requireProcessEnv("BITBUCKET_USERNAME");
  const pass = requireProcessEnv("BITBUCKET_APP_PASSWORD");
  return encodeBasicAuthHeader(user, pass);
}

function splitRepoFull(full: string): { workspace: string; repoSlug: string } {
  const i = full.indexOf("/");
  if (i <= 0 || i === full.length - 1) {
    throw new Error("repoFull must be workspace/repo_slug");
  }
  return { workspace: full.slice(0, i), repoSlug: full.slice(i + 1) };
}

/** `/repositories/<workspace>/<repo_slug>` for a `workspace/repo_slug` full name, both encoded. */
function repoPath(repoFull: string): string {
  const { workspace, repoSlug } = splitRepoFull(repoFull);
  return `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}`;
}

/**
 * One credentialed Bitbucket request. `path` is relative to {@link BB_API}, or an absolute URL —
 * the `next` link of an earlier page, which a paged tool takes back as its `page` ARGUMENT, so the
 * model chooses it. `resolveUrlWithBase` refuses an absolute URL on any other origin before
 * anything is sent: fetched as given, it would hand that host the username and app password.
 */
async function bbFetch(path: string, init?: RequestInit): Promise<RestFetchResult> {
  const url = resolveUrlWithBase(BB_API, path);
  const baseHeaders: Record<string, string> = {
    Authorization: basicAuthHeader(),
    Accept: "application/json",
  };
  const extra = init?.headers as Record<string, string> | undefined;
  const headers = extra === undefined ? baseHeaders : { ...baseHeaders, ...extra };
  const res = await fetch(url, {
    ...init,
    headers,
  });
  return toRestFetchResult(res);
}

/** A Bitbucket request answered as the tool result; Bitbucket's status and body on failure. */
async function bbResult(path: string, init?: RequestInit): Promise<McpListResult> {
  const res = await bbFetch(path, init);
  return mcpJsonResultIfOk("Bitbucket", res);
}

/**
 * One page of a paged list: the `next` URL from an earlier response when the caller passes one
 * back, otherwise the first page — which `firstPage` builds only in that case.
 */
async function bbPage(page: string | undefined, firstPage: () => string): Promise<McpListResult> {
  return bbResult(page?.startsWith("http") ? page : firstPage());
}

/** Tool names exposed by this connector — for contract/introspection tests. */
export const BITBUCKET_TOOL_NAMES = [
  "bitbucket_repo_list",
  "bitbucket_pr_list",
  "bitbucket_pr_get",
  "bitbucket_pr_merge",
  "bitbucket_pipeline_list",
  "bitbucket_pipeline_get",
  "bitbucket_issue_list",
] as const;

export function registerBitbucketTools(
  server: ConsentServer & { tool: (...args: never) => unknown },
): void {
  const registerSimpleTool = createRegisterSimpleTool(server);
  const reg = createZodToolRegistrar(registerSimpleTool);

  /**
   * Every MUTATING bitbucket tool goes through here. Outside the gateway this adds the
   * consent gate, the write-scope allow-list, the mutation budget and the audit record; inside
   * the gateway it is a pass-through, because executor.ts (I2) is the gate there.
   */
  const registerWriteTool = createWriteToolRegistrar(server, {
    connector: "bitbucket",
    scopeEnv: "NIMBUS_MCP_BITBUCKET_WRITE_SCOPE",
    scopeKinds: ["repo"],
  });

  const repoFullArg = z.object({
    repoFull: z
      .string()
      .min(3)
      .describe("Repository full name: workspace/repo_slug (e.g. myteam/my-service)"),
  });

  const bitbucketRepoListSchema = z.object({
    pagelen: z.number().int().min(1).max(100).optional(),
    page: z
      .string()
      .max(2000)
      .optional()
      .describe("Opaque page URL or token from a prior next link"),
  });

  reg(
    "bitbucket_repo_list",
    "List repositories where the authenticated user is a member.",
    bitbucketRepoListSchema,
    async (parsed) =>
      bbPage(parsed.page, () => {
        const qs = new URLSearchParams();
        qs.set("role", "member");
        qs.set("pagelen", String(parsed.pagelen ?? 30));
        return `/repositories?${qs.toString()}`;
      }),
  );

  const bitbucketPrListSchema = repoFullArg.extend({
    state: z.enum(["OPEN", "MERGED", "DECLINED", "SUPERSEDED"]).optional(),
    pagelen: z.number().int().min(1).max(100).optional(),
    page: z.string().max(2000).optional().describe("Opaque next URL from a prior response"),
  });

  reg(
    "bitbucket_pr_list",
    "List pull requests for a repository.",
    bitbucketPrListSchema,
    async (parsed) =>
      bbPage(parsed.page, () => {
        const base = `${repoPath(parsed.repoFull)}/pullrequests`;
        const qs = new URLSearchParams();
        qs.set("pagelen", String(parsed.pagelen ?? 30));
        qs.set("sort", "-updated_on");
        if (parsed.state !== undefined) {
          qs.set("q", `state="${parsed.state}"`);
        }
        return `${base}?${qs.toString()}`;
      }),
  );

  const bitbucketPrGetSchema = repoFullArg.extend({
    pullRequestId: z.number().int().min(1),
  });

  reg(
    "bitbucket_pr_get",
    "Get a single pull request by numeric id.",
    bitbucketPrGetSchema,
    async (parsed) =>
      bbResult(`${repoPath(parsed.repoFull)}/pullrequests/${String(parsed.pullRequestId)}`),
  );

  const bitbucketPrMergeSchema = repoFullArg.extend({
    pullRequestId: z.number().int().min(1),
    mergeStrategy: z.enum(["merge_commit", "squash", "fast_forward"]).optional(),
    message: z.string().max(32_768).optional(),
  });

  registerWriteTool(
    "bitbucket_pr_merge",
    {
      mutates: "bitbucket.pr.merge",
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "repo", value: p.repoFull }),
    },
    "Merge a pull request.",
    bitbucketPrMergeSchema,
    async (parsed) => {
      const path = `${repoPath(parsed.repoFull)}/pullrequests/${String(parsed.pullRequestId)}/merge`;
      const body: Record<string, unknown> = { type: "pullrequest" };
      if (parsed.mergeStrategy !== undefined) {
        body["merge_strategy"] = parsed.mergeStrategy;
      }
      if (parsed.message !== undefined) {
        body["message"] = parsed.message;
      }
      return bbResult(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
  );

  const bitbucketRepoPagedSchema = repoFullArg.extend({
    pagelen: z.number().int().min(1).max(100).optional(),
    page: z.string().max(2000).optional(),
  });

  reg(
    "bitbucket_pipeline_list",
    "List Pipelines runs for a repository.",
    bitbucketRepoPagedSchema,
    async (parsed) =>
      bbPage(parsed.page, () => {
        const base = `${repoPath(parsed.repoFull)}/pipelines/`;
        const qs = new URLSearchParams();
        qs.set("pagelen", String(parsed.pagelen ?? 30));
        return `${base}?${qs.toString()}`;
      }),
  );

  const bitbucketPipelineGetSchema = repoFullArg.extend({
    pipelineUuid: z.string().min(8).max(128),
  });

  reg(
    "bitbucket_pipeline_get",
    "Get a single pipeline run by UUID.",
    bitbucketPipelineGetSchema,
    async (parsed) => {
      const base = repoPath(parsed.repoFull);
      const encUuid = encodeURIComponent(parsed.pipelineUuid);
      return bbResult(`${base}/pipelines/${encUuid}`);
    },
  );

  reg(
    "bitbucket_issue_list",
    "List issues for a repository (issue tracker must be enabled).",
    bitbucketRepoPagedSchema,
    async (parsed) =>
      bbPage(parsed.page, () => {
        const base = `${repoPath(parsed.repoFull)}/issues`;
        const qs = new URLSearchParams();
        qs.set("pagelen", String(parsed.pagelen ?? 30));
        return `${base}?${qs.toString()}`;
      }),
  );
}
