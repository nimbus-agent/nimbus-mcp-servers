import { z } from "zod";
import { type ConsentServer, createWriteToolRegistrar } from "../../../shared/consent-kit.ts";
import {
  createJsonGetter,
  createJsonPoster,
  envAuthHeaders,
  type JsonApiConfig,
  requiredBaseUrl,
} from "../../../shared/env-json-api.ts";
import { searchToolInputSchema } from "../../../shared/mcp-search-tool.ts";
import { fetchWithTimeout, mcpJsonResult as jsonResult } from "../../../shared/mcp-tool-kit.ts";
import {
  runReadOnlyMcpConnector,
  type ZodToolRegistrar,
} from "../../../shared/run-read-only-mcp-connector.ts";
import { filterArgocdApplications } from "./search-filter.ts";

function apiBase(): string {
  return `${requiredBaseUrl("ARGOCD_URL")}/api/v1`;
}

/**
 * One config for reads and the mutating requests alike. `fetchWithTimeout`, not the global
 * fetch: this is a self-hosted control plane, and one that stops answering must fail the tool
 * call rather than hang it.
 */
const api: JsonApiConfig = {
  base: apiBase,
  label: "ArgoCD",
  headers: envAuthHeaders({ env: "ARGOCD_TOKEN" }),
  fetch: fetchWithTimeout,
};

const agGet = createJsonGetter(api);
const agPost = createJsonPoster(api);

function applicationsFrom(root: unknown): unknown[] {
  if (Array.isArray(root)) {
    return root;
  }
  const items = (root as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? items : [];
}

export function registerArgocdTools(reg: ZodToolRegistrar, server: unknown): void {
  // Despite the read-only helper's name, this connector exposes write tools. The consent
  // kit needs the real server, which the helper now passes through as its second argument.
  const registerWriteTool = createWriteToolRegistrar(server as ConsentServer, {
    connector: "argocd",
    scopeEnv: "NIMBUS_MCP_APP_WRITE_SCOPE",
    scopeKinds: ["app"],
  });

  reg(
    "argocd_list",
    "List ArgoCD applications. Optionally filter by `project` (passes `?projects=<project>` to the API). ArgoCD returns the full list in one response; `limit` (default 200) caps the returned `items` client-side.",
    z.object({
      project: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    async (p) => {
      const search = new URLSearchParams();
      if (p.project !== undefined && p.project !== "") {
        search.set("projects", p.project);
      }
      const qs = search.toString();
      const queryPart = qs === "" ? "" : `?${qs}`;
      const root = await agGet(`/applications${queryPart}`);
      const apps = applicationsFrom(root);
      const cap = p.limit ?? 200;
      return jsonResult({ items: apps.slice(0, cap) });
    },
  );

  reg(
    "argocd_get",
    "Fetch one ArgoCD application by name (`/applications/{name}`). Throws when no application with that name exists.",
    z.object({
      name: z.string().min(1),
    }),
    async (p) => {
      return jsonResult(await agGet(`/applications/${encodeURIComponent(p.name)}`));
    },
  );

  reg(
    "argocd_search",
    "Substring search across ArgoCD applications. Matches the query (case-insensitive) against application name, project, source repo URL, sync status, and health status. Returns a `{ matches: [...] }` envelope.",
    searchToolInputSchema(200),
    async (p) => {
      const root = await agGet("/applications");
      const matches = filterArgocdApplications(applicationsFrom(root), {
        query: p.query,
        limit: p.limit,
      });
      return jsonResult({ matches });
    },
  );

  registerWriteTool(
    "argocd_app_sync",
    {
      mutates: "argocd.app.sync",
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "app", value: p.name }),
    },
    "Trigger a sync for an ArgoCD application (`POST /api/v1/applications/{name}/sync`, requires HITL argocd.app.sync). Async — the sync is requested; verify via the next metadata sync (sync_status/health_status). Recommend /schedule to re-check.",
    z.object({
      name: z.string().min(1),
      prune: z.boolean().optional(),
      revision: z.string().optional(),
    }),
    async (p) => {
      await agPost(`/applications/${encodeURIComponent(p.name)}/sync`, {
        ...(p.prune === undefined ? {} : { prune: p.prune }),
        ...(p.revision === undefined ? {} : { revision: p.revision }),
      });
      return jsonResult({ status: "requested", name: p.name });
    },
  );

  registerWriteTool(
    "argocd_app_rollback",
    {
      mutates: "argocd.app.rollback",
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "app", value: p.name }),
    },
    "Roll back an ArgoCD application to a prior deployment history id (`POST /api/v1/applications/{name}/rollback`, requires HITL argocd.app.rollback). Async — verify via the next metadata sync.",
    z.object({ name: z.string().min(1), id: z.number().int().nonnegative() }),
    async (p) => {
      await agPost(`/applications/${encodeURIComponent(p.name)}/rollback`, { id: p.id });
      return jsonResult({ status: "requested", name: p.name });
    },
  );
}

export async function startConnector(): Promise<void> {
  await runReadOnlyMcpConnector("nimbus-argocd", registerArgocdTools);
}

if (import.meta.main) await startConnector();
