import { z } from "zod";
import { capText } from "../../../shared/cap-text.ts";
import { type ConsentServer, createWriteToolRegistrar } from "../../../shared/consent-kit.ts";
import {
  createJsonGetter,
  createJsonSender,
  envAuthHeaders,
  type JsonApiConfig,
} from "../../../shared/env-json-api.ts";
import { isSafeGitRef } from "../../../shared/github-rest.ts";
import { matchesResult, searchToolInputSchema } from "../../../shared/mcp-search-tool.ts";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
} from "../../../shared/mcp-tool-kit.ts";
import { filterNetlifySites } from "./search-filter.ts";

const BASE = "https://api.netlify.com";

const api: JsonApiConfig = {
  base: BASE,
  label: "Netlify",
  headers: envAuthHeaders({ env: "NETLIFY_TOKEN" }),
};

const netlifyGet = createJsonGetter(api);
// A mutation's 3xx is refused (never followed), so the token is not replayed anywhere.
const netlifySend = createJsonSender(api);

/** Tool names exposed by this connector — for contract/introspection tests. */
export const NETLIFY_TOOL_NAMES = [
  "netlify_list",
  "netlify_get",
  "netlify_search",
  "netlify_deploy_list",
  "netlify_build_trigger",
] as const;

/** A site id (a UUID) or name: never `.` or `..` (a URL parser collapses them out of the path). */
const siteIdArg = z
  .string()
  .regex(/^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/, "letters, digits, '.', '_' and '-' only");

type Obj = Record<string, unknown>;

function asObj(v: unknown): Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {};
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

interface TriggerArgs {
  readonly siteId: string;
  readonly branch?: string | undefined;
  readonly production?: true | undefined;
  readonly clearCache?: boolean | undefined;
}

/**
 * Why a build trigger is refused before anything is sent, or `undefined`. An omitted `branch`
 * publishes the PRODUCTION site, and the owner's preview shows the input only, so that choice must
 * be written in the input: `production: true`. Shared by `refuseBefore` (standalone) and the
 * handler (gateway mode registers the raw handler).
 */
function triggerProblem(p: TriggerArgs): string | undefined {
  if (p.branch !== undefined && p.production === true) {
    return "give a branch or production: true, not both; nothing was sent";
  }
  if (p.branch === undefined && p.production !== true) {
    return "name a branch, or pass production: true to publish the production site; nothing was sent";
  }
  if (p.branch !== undefined && !isSafeGitRef(p.branch)) {
    return "branch is not a safe git ref; nothing was sent";
  }
  return undefined;
}

export function registerNetlifyTools(
  server: ConsentServer & { tool: (...args: never) => unknown },
): void {
  const reg = createZodToolRegistrar(createRegisterSimpleTool(server));
  const registerWriteTool = createWriteToolRegistrar(server, {
    connector: "netlify",
    scopeEnv: "NIMBUS_MCP_NETLIFY_WRITE_SCOPE",
    scopeKinds: ["site"],
  });

  reg(
    "netlify_list",
    "List Netlify sites (`GET /api/v1/sites`), capped at `per_page` (default 100). Returns a bare JSON array of site objects, each carrying the embedded `published_deploy` status and `build_settings`.",
    z.object({
      per_page: z.number().int().min(1).max(100).optional(),
    }),
    async (p) => {
      const search = new URLSearchParams({ per_page: String(p.per_page ?? 100), page: "1" });
      return jsonResult(await netlifyGet(`/api/v1/sites?${search.toString()}`));
    },
  );

  reg(
    "netlify_get",
    "Fetch one Netlify site by its id (`GET /api/v1/sites/{siteId}`). Returns the site object directly, including `published_deploy` (the live deploy). Throws when no match is found.",
    z.object({
      siteId: z.string().min(1),
    }),
    async (p) => {
      return jsonResult(await netlifyGet(`/api/v1/sites/${encodeURIComponent(p.siteId)}`));
    },
  );

  reg(
    "netlify_search",
    "Substring search across Netlify sites. Matches the query against id, name, url, ssl_url, the linked git repo + branch, and the published-deploy state / branch / commit ref (case-insensitive). Returns a `{ matches: [...] }` envelope.",
    searchToolInputSchema(100),
    async (p) => {
      const search = new URLSearchParams({ per_page: "100", page: "1" });
      const root = await netlifyGet(`/api/v1/sites?${search.toString()}`);
      return matchesResult(root, filterNetlifySites, p);
    },
  );

  reg(
    "netlify_deploy_list",
    "List a Netlify site's most recent deploys (`GET /api/v1/sites/{siteId}/deploys`, newest first), at most `perPage` (default 5, max 10), each projected to `{ id, state, branch, context, commit_ref, created_at, published_at, error_message }`. `context` says whether it was a production deploy.",
    z.object({
      siteId: siteIdArg,
      perPage: z.number().int().min(1).max(10).optional(),
    }),
    async (p) => {
      const search = new URLSearchParams({ per_page: String(p.perPage ?? 5), page: "1" });
      const root = await netlifyGet(
        `/api/v1/sites/${encodeURIComponent(p.siteId)}/deploys?${search.toString()}`,
      );
      const deploys = Array.isArray(root) ? root : [];
      return jsonResult(
        deploys.map((raw) => {
          const d = asObj(raw);
          return {
            id: capText(d["id"]),
            state: capText(d["state"]),
            branch: capText(d["branch"]),
            context: capText(d["context"]),
            commit_ref: capText(d["commit_ref"]),
            created_at: capText(d["created_at"]),
            published_at: capText(d["published_at"]),
            error_message: capText(d["error_message"]),
          };
        }),
      );
    },
  );

  registerWriteTool(
    "netlify_build_trigger",
    {
      mutates: "netlify.build.trigger",
      // A build adds a deploy; it does not delete one, and a production deploy is replaced by the next one.
      recoverable: true,
      scopeTargetOf: (p: { siteId: string }) => ({ kind: "site", value: p.siteId }),
      refuseBefore: (p: TriggerArgs) => triggerProblem(p),
    },
    "Start a Netlify build of a site (`POST /api/v1/sites/{siteId}/builds`, query `branch` and `clear_cache`, NO body). IMPORTANT: Netlify treats a build with no branch as a PRODUCTION deploy and publishes it when it succeeds, so you MUST either name a `branch` (a branch that is not the site's production branch makes a branch deploy) or pass `production: true` to publish the production site on purpose; neither, or both, sends nothing. `clearCache: true` discards the build cache first. The reply is `accepted` with the build id: Netlify builds it afterwards, so check `netlify_deploy_list`.",
    z.object({
      siteId: siteIdArg,
      branch: z.string().min(1).max(255).optional(),
      production: z.literal(true).optional(),
      clearCache: z.boolean().optional(),
    }),
    async (p) => {
      const problem = triggerProblem(p);
      if (problem !== undefined) throw new Error(problem);
      // Netlify documents these as QUERY parameters, so nothing goes in a body.
      const search = new URLSearchParams();
      if (p.branch !== undefined) {
        search.set("branch", p.branch);
      }
      if (p.clearCache === true) {
        search.set("clear_cache", "true");
      }
      const qs = search.toString();
      const reply = asObj(
        await netlifySend(
          "POST",
          `/api/v1/sites/${encodeURIComponent(p.siteId)}/builds${qs === "" ? "" : `?${qs}`}`,
          undefined,
        ),
      );
      return jsonResult({
        ok: true,
        status: "accepted",
        siteId: p.siteId,
        // No branch = a production deploy (documented), and only `production: true` gets here without one.
        branch: p.branch ?? null,
        production: p.branch === undefined,
        buildId: str(reply["id"]) ?? null,
        deployId: str(reply["deploy_id"]) ?? null,
      });
    },
  );
}
