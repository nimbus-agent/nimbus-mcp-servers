import { z } from "zod";
import {
  fetchAtlassianBasicAuthJsonText,
  normalizeRequiredSiteBaseUrl,
  requireTrimmedEnv,
} from "../../../shared/atlassian-json-fetch.ts";
import type { ConsentServer } from "../../../shared/consent-kit.ts";
import { createWriteToolRegistrar } from "../../../shared/consent-kit.ts";
import { joinApiPath } from "../../../shared/join-api-path.ts";
import { parseCitationsJson } from "../../../shared/kb-markdown.ts";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult,
  mcpJsonResultFromTextIfOk,
} from "../../../shared/mcp-tool-kit.ts";
import { buildConfluenceKbPageBody } from "./kb-append.ts";

function wikiRoot(siteBase: string): string {
  const b = normalizeRequiredSiteBaseUrl(siteBase, "CONFLUENCE_BASE_URL is empty");
  return b.endsWith("/wiki") ? b : `${b}/wiki`;
}

function requireConfluenceConfig(): { wikiApi: string; email: string; token: string } {
  const baseRaw = requireTrimmedEnv("CONFLUENCE_BASE_URL", "CONFLUENCE_BASE_URL is not set");
  const email = requireTrimmedEnv("CONFLUENCE_EMAIL", "CONFLUENCE_EMAIL is not set");
  const token = requireTrimmedEnv("CONFLUENCE_API_TOKEN", "CONFLUENCE_API_TOKEN is not set");
  return {
    wikiApi: `${wikiRoot(baseRaw)}/rest/api`,
    email,
    token,
  };
}

async function confFetch(
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; text: string }> {
  const { wikiApi, email, token } = requireConfluenceConfig();
  const url = joinApiPath(wikiApi, path);
  return fetchAtlassianBasicAuthJsonText(url, email, token, init);
}

/** The parts of a page `confluence_page_append` reads and writes back. */
interface PageSnapshot {
  readonly type: string;
  readonly title: string;
  readonly version: number;
  readonly html: string;
}

/** Parse `GET /content/{id}?expand=body.storage,version`; throws, quoting Confluence, on a failure. */
function readPageSnapshot(res: { ok: boolean; status: number; text: string }): PageSnapshot {
  if (!res.ok) {
    throw new Error(`Confluence ${String(res.status)}: ${res.text.slice(0, 400)}`);
  }
  const page = JSON.parse(res.text) as {
    type?: string;
    title?: string;
    version?: { number?: number };
    body?: { storage?: { value?: string } };
  };
  return {
    type: page.type ?? "page",
    title: page.title ?? "",
    version: page.version?.number ?? 0,
    html: page.body?.storage?.value ?? "",
  };
}

/** Tool names exposed by this connector — for contract/introspection tests. */
export const CONFLUENCE_TOOL_NAMES = [
  "confluence_space_list",
  "confluence_page_list",
  "confluence_page_get",
  "confluence_blogpost_list",
  "confluence_blogpost_get",
  "confluence_comment_list",
  "confluence_page_create",
  "confluence_kb_append",
  "confluence_page_update",
  "confluence_comment_add",
  "confluence_page_append",
] as const;

export function registerConfluenceTools(
  server: ConsentServer & { tool: (...args: never) => unknown },
): void {
  const registerSimpleTool = createRegisterSimpleTool(server);

  const reg = createZodToolRegistrar(registerSimpleTool);

  /**
   * Every MUTATING confluence tool goes through here. Outside the gateway this adds the
   * consent gate, the write-scope allow-list, the mutation budget and the audit record; inside
   * the gateway it is a pass-through, because executor.ts (I2) is the gate there.
   */
  const registerWriteTool = createWriteToolRegistrar(server, {
    connector: "confluence",
    scopeEnv: "NIMBUS_MCP_CONFLUENCE_WRITE_SCOPE",
    scopeKinds: ["space", "page"],
  });

  const confluenceLimitStartSchema = z.object({
    limit: z.number().int().min(1).max(100).optional(),
    start: z.number().int().min(0).optional(),
  });

  reg(
    "confluence_space_list",
    "List Confluence spaces (GET /space).",
    confluenceLimitStartSchema,
    async (parsed) => {
      const qs = new URLSearchParams({
        limit: String(parsed.limit ?? 25),
        start: String(parsed.start ?? 0),
      });
      const res = await confFetch(`/space?${qs.toString()}`);
      return mcpJsonResultFromTextIfOk("Confluence", res);
    },
  );

  const confluenceSpaceContentSchema = z.object({
    spaceKey: z.string().min(1),
    limit: z.number().int().min(1).max(100).optional(),
    start: z.number().int().min(0).optional(),
  });

  reg(
    "confluence_page_list",
    "List pages in a space (GET /content, type=page).",
    confluenceSpaceContentSchema,
    async (parsed) => {
      const qs = new URLSearchParams({
        type: "page",
        spaceKey: parsed.spaceKey,
        limit: String(parsed.limit ?? 50),
        start: String(parsed.start ?? 0),
        expand: "history.lastUpdated,version",
      });
      const res = await confFetch(`/content?${qs.toString()}`);
      return mcpJsonResultFromTextIfOk("Confluence", res);
    },
  );

  const confluencePageIdSchema = z.object({ pageId: z.string().min(1) });

  reg(
    "confluence_page_get",
    "Get a Confluence page with body.storage (GET /content/{id}).",
    confluencePageIdSchema,
    async (parsed) => {
      const id = encodeURIComponent(parsed.pageId);
      const res = await confFetch(
        `/content/${id}?expand=body.storage,version,history.lastUpdated,space`,
      );
      return mcpJsonResultFromTextIfOk("Confluence", res);
    },
  );

  reg(
    "confluence_blogpost_list",
    "List blog posts in a space (GET /content, type=blogpost).",
    confluenceSpaceContentSchema,
    async (parsed) => {
      const qs = new URLSearchParams({
        type: "blogpost",
        spaceKey: parsed.spaceKey,
        limit: String(parsed.limit ?? 25),
        start: String(parsed.start ?? 0),
        expand: "history.lastUpdated,version",
      });
      const res = await confFetch(`/content?${qs.toString()}`);
      return mcpJsonResultFromTextIfOk("Confluence", res);
    },
  );

  const confluencePostIdSchema = z.object({ postId: z.string().min(1) });

  reg(
    "confluence_blogpost_get",
    "Get a blog post by id (GET /content/{id}).",
    confluencePostIdSchema,
    async (parsed) => {
      const id = encodeURIComponent(parsed.postId);
      const res = await confFetch(
        `/content/${id}?expand=body.storage,version,history.lastUpdated,space`,
      );
      return mcpJsonResultFromTextIfOk("Confluence", res);
    },
  );

  const confluenceCommentListSchema = z.object({
    pageId: z.string().min(1),
    limit: z.number().int().min(1).max(100).optional(),
    start: z.number().int().min(0).optional(),
  });

  reg(
    "confluence_comment_list",
    "List footer comments on a page (GET /content/{id}/child/comment).",
    confluenceCommentListSchema,
    async (parsed) => {
      const id = encodeURIComponent(parsed.pageId);
      const qs = new URLSearchParams({
        limit: String(parsed.limit ?? 50),
        start: String(parsed.start ?? 0),
        expand: "body.storage,version",
      });
      const res = await confFetch(`/content/${id}/child/comment?${qs.toString()}`);
      return mcpJsonResultFromTextIfOk("Confluence", res);
    },
  );

  const confluencePageCreateSchema = z.object({
    spaceKey: z.string().min(1),
    title: z.string().min(1),
    storageHtml: z.string().min(1),
    parentPageId: z.string().min(1).optional(),
  });

  registerWriteTool(
    "confluence_page_create",
    {
      mutates: "confluence.page.create",
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "space", value: p.spaceKey }),
    },
    "Create a page in a space (POST /content). Optional parentPageId.",
    confluencePageCreateSchema,
    async (parsed) => {
      const body: Record<string, unknown> = {
        type: "page",
        title: parsed.title,
        space: { key: parsed.spaceKey },
        body: {
          storage: {
            value: parsed.storageHtml,
            representation: "storage",
          },
        },
      };
      if (parsed.parentPageId !== undefined) {
        body["ancestors"] = [{ id: parsed.parentPageId }];
      }
      const res = await confFetch("/content", { method: "POST", body: JSON.stringify(body) });
      return mcpJsonResultFromTextIfOk("Confluence", res);
    },
  );

  const confluenceKbAppendSchema = z.object({
    spaceKey: z.string().min(1),
    parentPageId: z.string().min(1),
    title: z.string().min(1),
    bodyMarkdown: z.string().min(1),
    citationsJson: z.string().optional(),
  });

  registerWriteTool(
    "confluence_kb_append",
    {
      mutates: "confluence.knowledge.write",
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "space", value: p.spaceKey }),
    },
    "Create a knowledge-base page under a parent from simple markdown + citations (POST /content). " +
      "Used by Nimbus tribal-knowledge capture; the destination space/parent is supplied by the gateway from local config only.",
    confluenceKbAppendSchema,
    async (parsed) => {
      const body = buildConfluenceKbPageBody({
        spaceKey: parsed.spaceKey,
        parentPageId: parsed.parentPageId,
        title: parsed.title,
        bodyMarkdown: parsed.bodyMarkdown,
        citations: parseCitationsJson(parsed.citationsJson ?? "[]"),
      });
      const res = await confFetch("/content", { method: "POST", body: JSON.stringify(body) });
      return mcpJsonResultFromTextIfOk("Confluence", res);
    },
  );

  const confluencePageUpdateSchema = z.object({
    pageId: z.string().min(1),
    versionNumber: z.number().int().min(1),
    title: z.string().min(1),
    storageHtml: z.string().min(1),
  });

  registerWriteTool(
    "confluence_page_update",
    {
      mutates: "confluence.page.update",
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "page", value: p.pageId }),
    },
    "Update page body and bump version (PUT /content/{id}). Pass current version number and title.",
    confluencePageUpdateSchema,
    async (parsed) => {
      const id = encodeURIComponent(parsed.pageId);
      const body: Record<string, unknown> = {
        type: "page",
        title: parsed.title,
        version: { number: parsed.versionNumber + 1, message: "nimbus" },
        body: {
          storage: {
            value: parsed.storageHtml,
            representation: "storage",
          },
        },
      };
      const res = await confFetch(`/content/${id}`, { method: "PUT", body: JSON.stringify(body) });
      return mcpJsonResultFromTextIfOk("Confluence", res);
    },
  );

  const confluenceCommentAddSchema = z.object({
    pageId: z.string().min(1),
    storageHtml: z.string().min(1),
  });

  registerWriteTool(
    "confluence_comment_add",
    {
      mutates: "confluence.comment.add",
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "page", value: p.pageId }),
    },
    "Add a footer comment to a page (POST /content/{id}/child/comment).",
    confluenceCommentAddSchema,
    async (parsed) => {
      const id = encodeURIComponent(parsed.pageId);
      const body = {
        type: "comment",
        container: { id: parsed.pageId, type: "page" },
        body: {
          storage: {
            value: parsed.storageHtml,
            representation: "storage",
          },
        },
      };
      const res = await confFetch(`/content/${id}/child/comment`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      return mcpJsonResultFromTextIfOk("Confluence", res);
    },
  );

  const confluencePageAppendSchema = z.object({
    pageId: z.string().min(1),
    storageHtml: z.string().min(1).max(65_000),
  });

  registerWriteTool(
    "confluence_page_append",
    {
      mutates: "confluence.page.append",
      // Confluence keeps every version of a page, so the previous body is one click away. No
      // capturePreState on purpose: it would run once, before a retry, and describe a version that
      // may not be the one this call changes.
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "page", value: p.pageId }),
    },
    "Append storage-format HTML to the END of a Confluence page, keeping everything already on it (GET then PUT /content/{id}); if the page changes while this runs it re-reads and retries once, then fails without writing.",
    confluencePageAppendSchema,
    async (parsed) => {
      const id = encodeURIComponent(parsed.pageId);
      // The fetch helper returns `{ ok, status, text }` without throwing, so the retry lives here.
      // Each attempt re-reads the page, so it appends to the body as it is NOW.
      for (let attempt = 1; attempt <= 2; attempt++) {
        const page = readPageSnapshot(
          await confFetch(`/content/${id}?expand=body.storage,version`),
        );
        const next = page.version + 1;
        const put = await confFetch(`/content/${id}`, {
          method: "PUT",
          body: JSON.stringify({
            type: page.type,
            title: page.title,
            version: { number: next, message: "nimbus" },
            body: {
              storage: { value: page.html + parsed.storageHtml, representation: "storage" },
            },
          }),
        });
        if (put.status === 409 && attempt === 1) {
          continue;
        }
        if (put.status === 409) {
          throw new Error("Confluence: page changed concurrently; nothing appended");
        }
        if (!put.ok) {
          throw new Error(`Confluence ${String(put.status)}: ${put.text.slice(0, 400)}`);
        }
        let version = next;
        try {
          const written = JSON.parse(put.text) as { version?: { number?: number } };
          version = written.version?.number ?? next;
        } catch {
          // A non-JSON success body: the version we sent is the one that was written.
        }
        return mcpJsonResult({ ok: true, pageId: parsed.pageId, version });
      }
      throw new Error("Confluence: page changed concurrently; nothing appended");
    },
  );
}
