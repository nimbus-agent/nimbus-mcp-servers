import { FLUX_KINDS, type FluxKindEntry, trimTrailingSlash } from "@nimbus-dev/sdk";
import { z } from "zod";
import { type ConsentServer, createWriteToolRegistrar } from "../../../shared/consent-kit.ts";
import { createJsonGetter, envAuthHeaders } from "../../../shared/env-json-api.ts";
import { fetchWithTimeout, mcpJsonResult as jsonResult } from "../../../shared/mcp-tool-kit.ts";
import {
  runReadOnlyMcpConnector,
  type ZodToolRegistrar,
} from "../../../shared/run-read-only-mcp-connector.ts";
import { filterFluxResources } from "./search-filter.ts";

const KIND_VALUES = FLUX_KINDS.map((e) => e.kind) as [string, ...string[]];

function kindEntry(kind: string): FluxKindEntry {
  const found = FLUX_KINDS.find((e) => e.kind === kind);
  if (found === undefined) {
    throw new Error(`Unknown Flux kind: ${kind}`);
  }
  return found;
}

function apiBase(): string {
  const v = process.env["FLUX_API_URL"]?.trim();
  if (v === undefined || v === "") {
    throw new Error("FLUX_API_URL is not set");
  }
  return trimTrailingSlash(v);
}

/**
 * `fetchWithTimeout`, not the global fetch: this is a self-hosted control plane,
 * and one that stops answering must fail the tool call rather than hang it.
 */
/** Shared with the mutating request below, which adds its own Content-Type. */
const authHeader = envAuthHeaders({ env: "FLUX_TOKEN" });

const agGet = createJsonGetter({
  base: apiBase,
  label: "Flux",
  headers: authHeader,
  fetch: fetchWithTimeout,
});

function itemsFrom(root: unknown): unknown[] {
  if (Array.isArray(root)) {
    return root;
  }
  const items = (root as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? items : [];
}

function listPath(entry: FluxKindEntry, namespace?: string): string {
  const prefix = `/apis/${entry.group}/${entry.version}`;
  if (namespace !== undefined && namespace !== "") {
    return `${prefix}/namespaces/${encodeURIComponent(namespace)}/${entry.plural}`;
  }
  return `${prefix}/${entry.plural}`;
}

/** Request a reconcile by annotating reconcile.fluxcd.io/requestedAt on the CR (the same mechanism
 *  `flux reconcile` uses). Returns the RFC3339 timestamp written. Reuses kindEntry/listPath so the
 *  write path shares the read path's single source of truth — no new kind strings or version drift. */
async function fluxReconcile(kind: string, namespace: string, name: string): Promise<string> {
  const entry = kindEntry(kind);
  const path = `${listPath(entry, namespace)}/${encodeURIComponent(name)}`;
  const requestedAt = new Date().toISOString();
  const res = await fetchWithTimeout(`${apiBase()}${path}`, {
    method: "PATCH",
    headers: { ...authHeader(), "Content-Type": "application/merge-patch+json" },
    body: JSON.stringify({
      metadata: { annotations: { "reconcile.fluxcd.io/requestedAt": requestedAt } },
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Flux reconcile ${path} ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return requestedAt;
}

/** The Flux CRs a reconcile can be requested on. */
const RECONCILABLE = [
  {
    tool: "flux_kustomization_reconcile",
    kind: "kustomization",
    mutates: "flux.kustomization.reconcile",
    description:
      "Request a reconcile of a Flux Kustomization by annotating reconcile.fluxcd.io/requestedAt (PATCH the CR; requires HITL flux.kustomization.reconcile, and the SA's `patch` RBAC verb on kustomizations). Async — verify via the next metadata sync.",
  },
  {
    tool: "flux_helmrelease_reconcile",
    kind: "helm_release",
    mutates: "flux.helmrelease.reconcile",
    description:
      "Request a reconcile of a Flux HelmRelease by annotating reconcile.fluxcd.io/requestedAt (PATCH the CR; requires HITL flux.helmrelease.reconcile, and the SA's `patch` RBAC verb on helmreleases). Async — verify via the next metadata sync.",
  },
] as const;

export function registerFluxTools(reg: ZodToolRegistrar, server: unknown): void {
  // Despite the read-only helper's name, this connector exposes write tools. The consent
  // kit needs the real server, which the helper now passes through as its second argument.
  const registerWriteTool = createWriteToolRegistrar(server as ConsentServer, {
    connector: "flux",
    scopeEnv: "NIMBUS_MCP_FLUX_WRITE_SCOPE",
    scopeKinds: ["namespace"],
  });

  reg(
    "flux_list",
    "List Flux Custom Resources of one `kind` (default `kustomization`). Reads the Kubernetes API: all-namespaces by default, or scoped to `namespace` when given. `limit` (default 200) caps the returned `items` client-side. Returns the raw Kubernetes List envelope.",
    z.object({
      kind: z.enum(KIND_VALUES).optional(),
      namespace: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    async (p) => {
      const entry = kindEntry(p.kind ?? "kustomization");
      const root = await agGet(listPath(entry, p.namespace));
      const items = itemsFrom(root);
      const cap = p.limit ?? 200;
      return jsonResult({ items: items.slice(0, cap) });
    },
  );

  reg(
    "flux_get",
    "Fetch one Flux Custom Resource by `kind`, `namespace`, and `name` (`/apis/<group>/<version>/namespaces/<ns>/<plural>/<name>`). Throws when no such resource exists.",
    z.object({
      kind: z.enum(KIND_VALUES),
      namespace: z.string().min(1),
      name: z.string().min(1),
    }),
    async (p) => {
      const entry = kindEntry(p.kind);
      const path = `${listPath(entry, p.namespace)}/${encodeURIComponent(p.name)}`;
      return jsonResult(await agGet(path));
    },
  );

  reg(
    "flux_search",
    "Substring search across Flux Custom Resources of one `kind` (default `kustomization`). Lists the kind across all namespaces and matches the query (case-insensitive) against resource name, namespace, and the Ready condition's reason/message. Returns a `{ matches: [...] }` envelope.",
    z.object({
      query: z.string().min(1),
      kind: z.enum(KIND_VALUES).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    async (p) => {
      const entry = kindEntry(p.kind ?? "kustomization");
      const root = await agGet(listPath(entry));
      const matches = filterFluxResources(itemsFrom(root), {
        query: p.query,
        limit: p.limit,
      });
      return jsonResult({ matches });
    },
  );

  // Both reconcile tools are the same annotation PATCH against a different CR.
  for (const { tool, kind, mutates, description } of RECONCILABLE) {
    registerWriteTool(
      tool,
      {
        mutates,
        recoverable: true,
        scopeTargetOf: (p) => ({ kind: "namespace", value: p.namespace }),
      },
      description,
      z.object({ namespace: z.string().min(1), name: z.string().min(1) }),
      async (p) =>
        jsonResult({
          status: "requested",
          name: p.name,
          requestedAt: await fluxReconcile(kind, p.namespace, p.name),
        }),
    );
  }
}

export async function startConnector(): Promise<void> {
  await runReadOnlyMcpConnector("nimbus-flux", registerFluxTools);
}

if (import.meta.main) await startConnector();
