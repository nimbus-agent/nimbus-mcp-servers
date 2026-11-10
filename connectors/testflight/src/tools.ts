import { signAppStoreConnectJwt } from "@nimbus-dev/sdk";
import { z } from "zod";
import { capText } from "../../../shared/cap-text.ts";
import { type ConsentServer, createWriteToolRegistrar } from "../../../shared/consent-kit.ts";
import {
  createJsonGetter,
  createJsonSender,
  type JsonApiConfig,
} from "../../../shared/env-json-api.ts";
import { matchesResult } from "../../../shared/mcp-search-tool.ts";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
} from "../../../shared/mcp-tool-kit.ts";
import { jwtParamsFromEnv } from "./jwt.ts";
import { filterTestflightBuilds } from "./search-filter.ts";

const APPSTORECONNECT_API = "https://api.appstoreconnect.apple.com";

function authHeader(): Record<string, string> {
  const token = signAppStoreConnectJwt(jwtParamsFromEnv());
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

const api: JsonApiConfig = {
  base: APPSTORECONNECT_API,
  label: "App Store Connect",
  headers: authHeader,
};

const appstoreGet = createJsonGetter(api);
// A mutation's 3xx is refused (never followed), so the token is not replayed anywhere.
const appstoreSend = createJsonSender(api);

function buildsPath(appId: string, limit: number): string {
  return `/v1/builds?filter[app]=${encodeURIComponent(appId)}&sort=-uploadedDate&limit=${String(limit)}`;
}

/** Tool names exposed by this connector — for contract/introspection tests. */
export const TESTFLIGHT_TOOL_NAMES = [
  "testflight_list",
  "testflight_get",
  "testflight_search",
  "testflight_build_groups_get",
  "testflight_beta_groups_list",
  "testflight_build_distribute",
] as const;

/** App Store Connect resource ids (UUIDs and numeric app ids); never a dot segment. */
const idArg = z
  .string()
  .regex(/^(?!\.{1,2}$)[A-Za-z0-9._-]{1,64}$/, "letters, digits, '.', '_' and '-' only");

type Obj = Record<string, unknown>;

function asObj(v: unknown): Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {};
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * The beta groups a build is in, projected to what an approver needs. `publicLinkEnabled` is kept
 * on purpose: a group with a public link is open to anyone who holds the link, whoever is in it.
 */
async function readBuildGroups(buildId: string): Promise<Obj[]> {
  return projectGroups(
    await appstoreGet(`/v1/builds/${encodeURIComponent(buildId)}/betaGroups?limit=200`),
    200,
  );
}

/** At most `cap` groups of an App Store Connect list reply, as `{id, name, isInternalGroup, publicLinkEnabled}`. */
function projectGroups(reply: unknown, cap: number): Obj[] {
  const data = Array.isArray(asObj(reply)["data"]) ? (asObj(reply)["data"] as unknown[]) : [];
  return data.slice(0, cap).map((raw) => {
    const g = asObj(raw);
    const attrs = asObj(g["attributes"]);
    return {
      id: capText(g["id"]),
      name: capText(attrs["name"]),
      isInternalGroup: attrs["isInternalGroup"],
      publicLinkEnabled: attrs["publicLinkEnabled"],
    };
  });
}

/** The ids of the beta groups an app has, from `GET /v1/apps/{appId}/betaGroups`. */
async function appGroupIds(appId: string): Promise<Set<string>> {
  const groups = projectGroups(
    await appstoreGet(`/v1/apps/${encodeURIComponent(appId)}/betaGroups?limit=200`),
    200,
  );
  return new Set(groups.map((g) => g["id"]).filter((id): id is string => typeof id === "string"));
}

/**
 * The ids, among `ids`, of beta groups that have a public link right now: one
 * `GET /v1/betaGroups/{id}` each, read at dispatch so the answer is the group's state at the moment
 * of the send, not at the time anyone was shown it.
 */
async function publicLinkGroupIds(ids: readonly string[]): Promise<string[]> {
  const open: string[] = [];
  for (const id of ids) {
    const root = asObj(await appstoreGet(`/v1/betaGroups/${encodeURIComponent(id)}`));
    if (asObj(asObj(root["data"])["attributes"])["publicLinkEnabled"] === true) open.push(id);
  }
  return open;
}

/** The app a build belongs to, from `GET /v1/builds/{id}?include=app`. */
async function appOfBuild(buildId: string): Promise<string | undefined> {
  const root = asObj(await appstoreGet(`/v1/builds/${encodeURIComponent(buildId)}?include=app`));
  const rel = asObj(asObj(asObj(root["data"])["relationships"])["app"]);
  return str(asObj(rel["data"])["id"]);
}

export function registerTestflightTools(
  server: ConsentServer & { tool: (...args: never) => unknown },
): void {
  const reg = createZodToolRegistrar(createRegisterSimpleTool(server));
  const registerWriteTool = createWriteToolRegistrar(server, {
    connector: "testflight",
    scopeEnv: "NIMBUS_MCP_TESTFLIGHT_WRITE_SCOPE",
    scopeKinds: ["app"],
  });

  reg(
    "testflight_list",
    "List TestFlight resources via the App Store Connect API. When `appId` is omitted, returns the user's accessible apps via `GET /v1/apps`. When `appId` is provided, returns that app's most-recent builds via `GET /v1/builds?filter[app]=<id>&sort=-uploadedDate` (limit optional).",
    z.object({
      appId: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    async (p) => {
      if (p.appId === undefined) {
        return jsonResult(await appstoreGet("/v1/apps"));
      }
      return jsonResult(await appstoreGet(buildsPath(p.appId, p.limit ?? 50)));
    },
  );

  reg(
    "testflight_get",
    "Fetch a single TestFlight resource. When `buildId` is provided, returns the build via `GET /v1/builds/<buildId>`. When omitted, returns the app via `GET /v1/apps/<appId>`.",
    z.object({
      appId: z.string().min(1),
      buildId: z.string().min(1).optional(),
    }),
    async (p) => {
      if (p.buildId === undefined) {
        return jsonResult(await appstoreGet(`/v1/apps/${encodeURIComponent(p.appId)}`));
      }
      return jsonResult(await appstoreGet(`/v1/builds/${encodeURIComponent(p.buildId)}`));
    },
  );

  reg(
    "testflight_search",
    "Substring search across a TestFlight app's recent builds. Matches the query against each build's `version`, `processingState`, `minOsVersion`, and `id` (case-insensitive). Returns a `{ matches: [...] }` envelope.",
    z.object({
      appId: z.string().min(1),
      query: z.string().min(1),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    async (p) => {
      const root = await appstoreGet(buildsPath(p.appId, 200));
      const data = (root as { data?: unknown[] } | null)?.data;
      return matchesResult(data, filterTestflightBuilds, p);
    },
  );

  reg(
    "testflight_build_groups_get",
    "Read the beta groups a TestFlight build is already in (`GET /v1/builds/{buildId}/betaGroups`), projected to `{ groups: [{ id, name, isInternalGroup, publicLinkEnabled }] }`. A group with `publicLinkEnabled: true` is reachable by anyone who has its public link.",
    z.object({ buildId: idArg }),
    async (p) => jsonResult({ groups: await readBuildGroups(p.buildId) }),
  );

  reg(
    "testflight_beta_groups_list",
    "List an app's TestFlight beta groups (`GET /v1/apps/{appId}/betaGroups`), at most `limit` (default 100, max 200), projected to `{ groups: [{ id, name, isInternalGroup, publicLinkEnabled }] }`. Read it BEFORE `testflight_build_distribute` to see which target groups are public: a group with `publicLinkEnabled: true` is reachable by anyone who holds its link.",
    z.object({ appId: idArg, limit: z.number().int().min(1).max(200).optional() }),
    async (p) => {
      const search = new URLSearchParams({ limit: String(p.limit ?? 100) });
      const root = await appstoreGet(
        `/v1/apps/${encodeURIComponent(p.appId)}/betaGroups?${search.toString()}`,
      );
      return jsonResult({ groups: projectGroups(root, p.limit ?? 100) });
    },
  );

  registerWriteTool(
    "testflight_build_distribute",
    {
      mutates: "testflight.build.distribute",
      // Testers who were given the build cannot be un-invited from here; the groups the build was
      // already in are recorded in the audit pre-state.
      recoverable: false,
      capturePreState: async (p: { buildId: string }) => ({
        buildId: p.buildId,
        groups: await readBuildGroups(p.buildId),
      }),
      scopeTargetOf: (p: { appId: string }) => ({ kind: "app", value: p.appId }),
    },
    'Add a TestFlight build to beta groups (`POST /v1/builds/{buildId}/relationships/betaGroups`, body `{ data: [{ type: "betaGroups", id }] }`). The build must belong to `appId`: it is read first (`GET /v1/builds/{buildId}?include=app`) and a build of another app sends nothing. Adding a build to a group makes it available to every tester in it, and a group with a public link reaches anyone holding the link (see `testflight_build_groups_get`): each target group is read (`GET /v1/betaGroups/{id}`) right before the send, and one with `publicLinkEnabled: true` is refused with `testflight_public_link_forbidden` unless `allowPublicLink` is `true` (default false). Apple may refuse (409/422) a build that is not VALID or a external group that has not passed beta review; the body is returned in the error. The reply is `accepted`.',
    z.object({
      appId: idArg,
      buildId: idArg,
      betaGroupIds: z.array(idArg).min(1).max(20),
      allowPublicLink: z.boolean().optional(),
    }),
    async (p) => {
      if (new Set(p.betaGroupIds).size !== p.betaGroupIds.length) {
        throw new Error("betaGroupIds has a duplicate; nothing was sent");
      }
      const owner = await appOfBuild(p.buildId);
      if (owner !== p.appId) {
        throw new Error(`build ${p.buildId} does not belong to app ${p.appId}; nothing was sent`);
      }
      // Every target group must be one of this app's: one GET, and nothing is sent on a mismatch.
      const known = await appGroupIds(p.appId);
      const stray = p.betaGroupIds.filter((id) => !known.has(id));
      if (stray.length > 0) {
        throw new Error(
          `beta group(s) ${stray.join(", ")} do not belong to app ${p.appId}; nothing was sent`,
        );
      }
      // A group with a public link reaches anyone who holds the link, so it is distributed to only
      // when the caller said so. Read now, at dispatch, from each group itself.
      if (p.allowPublicLink !== true) {
        const open = await publicLinkGroupIds(p.betaGroupIds);
        if (open.length > 0) {
          throw new Error(
            `testflight_public_link_forbidden: beta group(s) ${open.join(", ")} have a public link; pass allowPublicLink: true to distribute to them; nothing was sent`,
          );
        }
      }
      await appstoreSend(
        "POST",
        `/v1/builds/${encodeURIComponent(p.buildId)}/relationships/betaGroups`,
        {
          data: p.betaGroupIds.map((id) => ({ type: "betaGroups", id })),
        },
      );
      return jsonResult({
        ok: true,
        status: "accepted",
        appId: p.appId,
        buildId: p.buildId,
        betaGroupIds: p.betaGroupIds,
      });
    },
  );
}
