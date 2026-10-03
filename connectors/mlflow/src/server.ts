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
import { filterMlflowModels } from "./search-filter.ts";

/**
 * One config for reads and the mutating requests alike. `fetchWithTimeout`, not the global
 * fetch: MLflow is a self-hosted tracking server, and one that stops answering must fail the
 * tool call rather than hang it.
 */
const api: JsonApiConfig = {
  base: () => requiredBaseUrl("MLFLOW_HOST"),
  label: "MLflow",
  headers: envAuthHeaders({ env: "MLFLOW_TOKEN" }),
  fetch: fetchWithTimeout,
};

const mlflowGet = createJsonGetter(api);
const mlflowPost = createJsonPoster(api);

const TRANSITION_PATH = "/api/2.0/mlflow/model-versions/transition-stage";

function modelsFrom(root: unknown): unknown[] {
  const models = (root as { registered_models?: unknown } | null)?.registered_models;
  return Array.isArray(models) ? models : [];
}

export function registerMlflowTools(reg: ZodToolRegistrar, server: unknown): void {
  // Despite the read-only helper's name, this connector exposes write tools. The consent
  // kit needs the real server, which the helper now passes through as its second argument.
  const registerWriteTool = createWriteToolRegistrar(server as ConsentServer, {
    connector: "mlflow",
    scopeEnv: "NIMBUS_MCP_MLFLOW_WRITE_SCOPE",
    scopeKinds: ["model"],
  });

  reg(
    "mlflow_list",
    "List MLflow registered models (`GET /api/2.0/mlflow/registered-models/search`). Returns a single page; `limit` (1..100, default 100) caps the page size. Returns the raw `{ registered_models, next_page_token }` envelope.",
    z.object({
      limit: z.number().int().min(1).max(100).optional(),
    }),
    async (p) => {
      const limit = p.limit ?? 100;
      const params = new URLSearchParams({ max_results: String(limit) });
      return jsonResult(
        await mlflowGet(`/api/2.0/mlflow/registered-models/search?${params.toString()}`),
      );
    },
  );

  reg(
    "mlflow_get",
    "Fetch one MLflow registered model by `name` (`GET /api/2.0/mlflow/registered-models/get?name={name}`). Throws when no registered model with that name exists.",
    z.object({
      name: z.string().min(1),
    }),
    async (p) => {
      const params = new URLSearchParams({ name: p.name });
      return jsonResult(
        await mlflowGet(`/api/2.0/mlflow/registered-models/get?${params.toString()}`),
      );
    },
  );

  reg(
    "mlflow_search",
    "Substring search across MLflow registered models. Matches the query (case-insensitive) against the model's `name`, `description`, and flattened `key=value` tags. Returns a `{ matches: [...] }` envelope.",
    searchToolInputSchema(100),
    async (p) => {
      const params = new URLSearchParams({ max_results: "100" });
      const root = await mlflowGet(`/api/2.0/mlflow/registered-models/search?${params.toString()}`);
      const matches = filterMlflowModels(modelsFrom(root), {
        query: p.query,
        limit: p.limit,
      });
      return jsonResult({ matches });
    },
  );

  registerWriteTool(
    "mlflow_model_promote",
    {
      mutates: "mlflow.model.promote",
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "model", value: p.name }),
    },
    "Promote a model version to Production (`POST /api/2.0/mlflow/model-versions/transition-stage`, stage=Production; requires HITL mlflow.model.promote). `archiveExisting` (default true) archives other Production versions so this becomes the single active one; pass false to keep them. Archiving is a reversible stage change.",
    z.object({
      name: z.string().min(1),
      version: z.string().min(1),
      archiveExisting: z.boolean().optional(),
    }),
    async (p) => {
      await mlflowPost(TRANSITION_PATH, {
        name: p.name,
        version: p.version,
        stage: "Production",
        archive_existing_versions: p.archiveExisting ?? true, // promote defaults to archiving the incumbent
      });
      return jsonResult({ status: "ok", name: p.name, version: p.version, stage: "Production" });
    },
  );

  registerWriteTool(
    "mlflow_model_transition_stage",
    {
      mutates: "mlflow.model.transition_stage",
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "model", value: p.name }),
    },
    "Transition a model version to a chosen stage (`POST /api/2.0/mlflow/model-versions/transition-stage`; requires HITL mlflow.model.transition_stage). `archiveExisting` default false.",
    z.object({
      name: z.string().min(1),
      version: z.string().min(1),
      stage: z.enum(["None", "Staging", "Production", "Archived"]),
      archiveExisting: z.boolean().optional(),
    }),
    async (p) => {
      await mlflowPost(TRANSITION_PATH, {
        name: p.name,
        version: p.version,
        stage: p.stage,
        archive_existing_versions: p.archiveExisting ?? false,
      });
      return jsonResult({ status: "ok", name: p.name, version: p.version, stage: p.stage });
    },
  );
}

export async function startConnector(): Promise<void> {
  await runReadOnlyMcpConnector("nimbus-mlflow", registerMlflowTools);
}

if (import.meta.main) await startConnector();
