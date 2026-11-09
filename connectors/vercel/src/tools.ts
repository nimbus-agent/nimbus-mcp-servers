import { z } from "zod";
import { type ConsentServer, createWriteToolRegistrar } from "../../../shared/consent-kit.ts";
import {
  createJsonGetter,
  createJsonSender,
  envAuthHeaders,
  type JsonApiConfig,
} from "../../../shared/env-json-api.ts";
import { matchesResult, searchToolInputSchema } from "../../../shared/mcp-search-tool.ts";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
} from "../../../shared/mcp-tool-kit.ts";
import { filterVercelDeployments } from "./search-filter.ts";

const BASE = "https://api.vercel.com";

function teamId(): string | undefined {
  const v = process.env["VERCEL_TEAM_ID"]?.trim();
  return v === undefined || v === "" ? undefined : v;
}

function withTeam(path: string): string {
  const team = teamId();
  if (team === undefined) {
    return path;
  }
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}teamId=${encodeURIComponent(team)}`;
}

const api: JsonApiConfig = {
  base: BASE,
  label: "Vercel",
  headers: envAuthHeaders({ env: "VERCEL_TOKEN" }),
};

const getJson = createJsonGetter(api);
// A mutation's 3xx is refused (never followed), so the token is not replayed anywhere.
const sendJson = createJsonSender(api);

/** Every request is scoped to `VERCEL_TEAM_ID` when one is configured. */
async function vercelGet(path: string): Promise<unknown> {
  return getJson(withTeam(path));
}

/** Tool names exposed by this connector — for contract/introspection tests. */
export const VERCEL_TOOL_NAMES = [
  "vercel_list",
  "vercel_get",
  "vercel_search",
  "vercel_project_production_get",
  "vercel_deployment_redeploy",
  "vercel_deployment_promote",
] as const;

/** Deployment and project ids: never `.` or `..` (a URL parser collapses them out of the path). */
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

/** The facts of one deployment a redeploy needs and an approver wants to see. */
async function readDeployment(deploymentId: string): Promise<Obj & { name: string | undefined }> {
  const d = asObj(await vercelGet(`/v13/deployments/${encodeURIComponent(deploymentId)}`));
  return {
    id: str(d["id"]) ?? str(d["uid"]) ?? deploymentId,
    name: str(d["name"]),
    target: d["target"] ?? null,
    readyState: str(d["readyState"]) ?? str(d["state"]),
  };
}

/** `{projectId, name, production}`: the deployment a promote makes stop being current. */
async function readProductionState(projectId: string): Promise<Obj> {
  const project = asObj(await vercelGet(`/v9/projects/${encodeURIComponent(projectId)}`));
  const prod = asObj(asObj(project["targets"])["production"]);
  const id = str(prod["id"]) ?? str(prod["uid"]);
  return {
    projectId: str(project["id"]) ?? projectId,
    name: str(project["name"]),
    production:
      id === undefined
        ? null
        : {
            id,
            url: str(prod["url"]),
            readyState: str(prod["readyState"]) ?? str(prod["state"]),
            createdAt: prod["createdAt"],
          },
  };
}

export function registerVercelTools(
  server: ConsentServer & { tool: (...args: never) => unknown },
): void {
  const reg = createZodToolRegistrar(createRegisterSimpleTool(server));
  const registerWriteTool = createWriteToolRegistrar(server, {
    connector: "vercel",
    scopeEnv: "NIMBUS_MCP_VERCEL_WRITE_SCOPE",
    scopeKinds: ["project", "deployment"],
  });

  reg(
    "vercel_list",
    "List recent Vercel deployments (`GET /v6/deployments`), most-recent-first, capped at `limit` (default 100). Returns the `{ deployments, pagination }` envelope.",
    z.object({
      limit: z.number().int().min(1).max(100).optional(),
    }),
    async (p) => {
      const search = new URLSearchParams({ limit: String(p.limit ?? 100) });
      return jsonResult(await vercelGet(`/v6/deployments?${search.toString()}`));
    },
  );

  reg(
    "vercel_get",
    "Fetch one Vercel deployment by its id or *.vercel.app URL (`GET /v13/deployments/{idOrUrl}`). Returns the deployment object directly. Throws when no match is found.",
    z.object({
      idOrUrl: z.string().min(1),
    }),
    async (p) => {
      return jsonResult(await vercelGet(`/v13/deployments/${encodeURIComponent(p.idOrUrl)}`));
    },
  );

  reg(
    "vercel_search",
    "Substring search across recent Vercel deployments. Matches the query against uid, project name, state, target, the *.vercel.app host, and the git commit message (case-insensitive). Returns a `{ matches: [...] }` envelope.",
    searchToolInputSchema(100),
    async (p) => {
      const search = new URLSearchParams({ limit: "100" });
      const root = await vercelGet(`/v6/deployments?${search.toString()}`);
      const deployments = (root as { deployments?: unknown[] } | null)?.deployments;
      return matchesResult(deployments, filterVercelDeployments, p);
    },
  );

  reg(
    "vercel_project_production_get",
    "Read which deployment is the CURRENT production deployment of a Vercel project (`GET /v9/projects/{projectId}`, `targets.production`), projected to `{ projectId, name, production: { id, url, readyState, createdAt } | null }`. `production` is null when the project has none. This is what `vercel_deployment_promote` replaces.",
    z.object({ projectId: idArg }),
    async (p) => jsonResult(await readProductionState(p.projectId)),
  );

  registerWriteTool(
    "vercel_deployment_redeploy",
    {
      mutates: "vercel.deployment.redeploy",
      // A production redeploy can supersede the deployment that is live, and nothing here puts it
      // back. The source deployment is recorded in the audit pre-state.
      recoverable: false,
      capturePreState: async (p: { deploymentId: string }) => {
        const { id, target, readyState } = await readDeployment(p.deploymentId);
        return { id, target, readyState };
      },
      scopeTargetOf: (p: { deploymentId: string }) => ({
        kind: "deployment",
        value: p.deploymentId,
      }),
    },
    "Redeploy an existing Vercel deployment as a NEW build (`POST /v13/deployments?forceNew=1`, body `{ name, deploymentId, target, withLatestCommit? }`). `target` is required and always sent: `production` replaces the live site once the new build is ready, `preview` does not (omitting it would make a preview). The project `name` is read from the source deployment first, and an unknown deployment sends nothing. The reply is `accepted` with the NEW deployment's id: Vercel builds it afterwards, so poll `vercel_get` until `readyState` is READY. Not undone by this tool.",
    z.object({
      deploymentId: idArg,
      target: z.enum(["production", "preview"]),
      withLatestCommit: z.boolean().optional(),
    }),
    async (p) => {
      const source = await readDeployment(p.deploymentId);
      if (source.name === undefined) {
        throw new Error(
          `Vercel deployment ${p.deploymentId} has no project name; nothing was sent`,
        );
      }
      const body: Obj = { name: source.name, deploymentId: p.deploymentId, target: p.target };
      if (p.withLatestCommit !== undefined) {
        body["withLatestCommit"] = p.withLatestCommit;
      }
      const reply = asObj(await sendJson("POST", withTeam("/v13/deployments?forceNew=1"), body));
      return jsonResult({
        ok: true,
        status: "accepted",
        deploymentId: str(reply["id"]) ?? str(reply["uid"]),
        url: str(reply["url"]),
        readyState: str(reply["readyState"]) ?? str(reply["state"]),
      });
    },
  );

  registerWriteTool(
    "vercel_deployment_promote",
    {
      mutates: "vercel.deployment.promote",
      // The previous production deployment is recorded; promoting it back is a second promote.
      recoverable: false,
      capturePreState: (p: { projectId: string }) => readProductionState(p.projectId),
      scopeTargetOf: (p: { projectId: string }) => ({ kind: "project", value: p.projectId }),
    },
    "Promote an existing Vercel deployment to production WITHOUT rebuilding it (`POST /v10/projects/{projectId}/promote/{deploymentId}`, no body). The deployment that is production now stops being current: read it first with `vercel_project_production_get`. The reply is `accepted`; Vercel applies the promotion afterwards.",
    z.object({ projectId: idArg, deploymentId: idArg }),
    async (p) => {
      await sendJson(
        "POST",
        withTeam(
          `/v10/projects/${encodeURIComponent(p.projectId)}/promote/${encodeURIComponent(p.deploymentId)}`,
        ),
        undefined,
      );
      return jsonResult({
        ok: true,
        status: "accepted",
        projectId: p.projectId,
        deploymentId: p.deploymentId,
      });
    },
  );
}
