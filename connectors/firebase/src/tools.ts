import { mintGoogleAccessToken } from "@nimbus-dev/sdk";
import { z } from "zod";
import { type ConsentServer, createWriteToolRegistrar } from "../../../shared/consent-kit.ts";
import { guardedFetch } from "../../../shared/guarded-fetch.ts";
import { matchesResult } from "../../../shared/mcp-search-tool.ts";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
} from "../../../shared/mcp-tool-kit.ts";
import { filterFirebaseReleases } from "./search-filter.ts";
import { configuredAppIds, projectNumberFromAppId, serviceAccountFromEnv } from "./token.ts";

const APP_DISTRIBUTION_API = "https://firebaseappdistribution.googleapis.com";
const LABEL = "Firebase App Distribution";

// App Distribution OAuth2 tokens last ~1h; cache and refresh conservatively.
let cachedToken: { token: string; expiresAt: number } | null = null;

/**
 * Forget the cached access token. Tests only: the cache is module state shared by every test in
 * the process, and a token one test left behind lets a later tool call skip reading its
 * credential entirely.
 */
export function __resetFirebaseTokenCacheForTests(): void {
  cachedToken = null;
}

async function accessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken !== null && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.token;
  }
  const token = await mintGoogleAccessToken(serviceAccountFromEnv());
  if (token === null) {
    throw new Error("failed to mint a Firebase access token");
  }
  cachedToken = { token, expiresAt: now + 30 * 60 * 1000 };
  return token;
}

/**
 * One App Distribution request. It goes through `guardedFetch`, so the bearer token is never sent
 * to a redirect target: a GET follows only a same-origin Location, and a redirect on a POST is
 * refused (the write may or may not have been applied) with no second request.
 */
async function appDistRequest(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<unknown> {
  // The credential is read BEFORE the request, so a missing one sends nothing.
  const token = await accessToken();
  const res = await guardedFetch(LABEL, `${APP_DISTRIBUTION_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${LABEL} ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return text === "" ? {} : (JSON.parse(text) as unknown);
}

async function appDistGet(path: string): Promise<unknown> {
  return appDistRequest("GET", path);
}

function appBasePath(appId: string): string {
  const projectNumber = projectNumberFromAppId(appId);
  if (projectNumber === null) {
    throw new Error(`cannot derive a project number from app id: ${appId}`);
  }
  return `/v1/projects/${encodeURIComponent(projectNumber)}/apps/${encodeURIComponent(appId)}`;
}

function releasesPath(appId: string, pageSize: number): string {
  return `${appBasePath(appId)}/releases?pageSize=${String(pageSize)}`;
}

function releasePath(appId: string, releaseId: string): string {
  return `${appBasePath(appId)}/releases/${encodeURIComponent(releaseId)}`;
}

/** Firebase accepts at most 999 testers and groups together in one distribute call. */
const MAX_RECIPIENTS = 999;

interface DistributeArgs {
  readonly appId: string;
  readonly releaseId: string;
  readonly groupAliases?: readonly string[] | undefined;
  readonly testerEmails?: readonly string[] | undefined;
}

/** The recipients as sent: each list de-duplicated (Firebase would mail a repeated tester twice). */
function distributeRecipients(p: DistributeArgs): {
  groupAliases: string[];
  testerEmails: string[];
} {
  return {
    groupAliases: [...new Set(p.groupAliases ?? [])],
    testerEmails: [...new Set(p.testerEmails ?? [])],
  };
}

/**
 * Why a distribute call is refused before anything is read or sent, or `undefined`. Shared by
 * `refuseBefore` (standalone: before scope, consent and the pre-state read) and the handler
 * (gateway mode registers the raw handler, so it must refuse the same input itself).
 */
function distributeProblem(p: DistributeArgs): string | undefined {
  const { groupAliases, testerEmails } = distributeRecipients(p);
  if (!configuredAppIds().includes(p.appId)) {
    return `app ${p.appId} is not in FIREBASE_APP_IDS; nothing was sent`;
  }
  if (groupAliases.length + testerEmails.length === 0) {
    return "give at least one tester email or group alias; nothing was sent";
  }
  if (groupAliases.length + testerEmails.length > MAX_RECIPIENTS) {
    return `at most ${String(MAX_RECIPIENTS)} testers and groups together; nothing was sent`;
  }
  return undefined;
}

const releaseIdArg = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,128}$/, "letters, digits, '_' and '-' only");
const groupAliasArg = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,128}$/, "letters, digits, '_' and '-' only");

/** Tool names exposed by this connector — for contract/introspection tests. */
export const FIREBASE_TOOL_NAMES = [
  "firebase_list",
  "firebase_get",
  "firebase_search",
  "firebase_app_distribution_distribute",
] as const;

export function registerFirebaseTools(
  server: ConsentServer & { tool: (...args: never) => unknown },
): void {
  const reg = createZodToolRegistrar(createRegisterSimpleTool(server));
  const registerWriteTool = createWriteToolRegistrar(server, {
    connector: "firebase",
    scopeEnv: "NIMBUS_MCP_FIREBASE_WRITE_SCOPE",
    scopeKinds: ["app"],
  });

  reg(
    "firebase_list",
    "List Firebase App Distribution resources. When `appId` is omitted, returns the connector's configured app ids. When `appId` is provided, returns that app's most-recent releases via GET /v1/projects/<n>/apps/<appId>/releases (pageSize optional, default 50).",
    z.object({
      appId: z.string().min(1).optional(),
      pageSize: z.number().int().min(1).max(100).optional(),
    }),
    async (p) => {
      if (p.appId === undefined) {
        return jsonResult({ appIds: configuredAppIds() });
      }
      return jsonResult(await appDistGet(releasesPath(p.appId, p.pageSize ?? 50)));
    },
  );

  reg(
    "firebase_get",
    "Fetch a single Firebase App Distribution release via GET /v1/projects/<n>/apps/<appId>/releases/<releaseId>.",
    z.object({
      appId: z.string().min(1),
      releaseId: z.string().min(1),
    }),
    async (p) => jsonResult(await appDistGet(releasePath(p.appId, p.releaseId))),
  );

  reg(
    "firebase_search",
    "Substring search across an app's recent releases. Matches the query against each release's display version, build version, release notes, and resource name (case-insensitive). Returns a `{ matches: [...] }` envelope.",
    z.object({
      appId: z.string().min(1),
      query: z.string().min(1),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    async (p) => {
      const root = await appDistGet(releasesPath(p.appId, 100));
      const releases = (root as { releases?: unknown[] } | null)?.releases;
      return matchesResult(releases, filterFirebaseReleases, p);
    },
  );

  registerWriteTool(
    "firebase_app_distribution_distribute",
    {
      mutates: "firebase.release.distribute",
      // Invitation and release emails cannot be unsent, and new testers stay created.
      recoverable: false,
      capturePreState: async (p: { appId: string; releaseId: string }) => {
        // The API has no read of a release's current groups or testers, so the release itself is
        // the before-state.
        const r = (await appDistGet(releasePath(p.appId, p.releaseId))) as Record<string, unknown>;
        return {
          displayVersion: r["displayVersion"],
          buildVersion: r["buildVersion"],
          testState: r["testState"],
        };
      },
      scopeTargetOf: (p: { appId: string }) => ({ kind: "app", value: p.appId }),
      refuseBefore: (p: DistributeArgs) => distributeProblem(p),
    },
    "Send an existing Firebase App Distribution release to testers and groups (`POST /v1/projects/<n>/apps/<appId>/releases/<releaseId>:distribute`, body `{ testerEmails, groupAliases }`, empty arrays omitted). WARNING, vendor behaviour: an email that is not yet a tester BECOMES a new tester and is SENT an invitation email, and testers get a release email; none of that can be unsent. At least one of `testerEmails` and `groupAliases` is required, at most 999 together; a missing group makes Firebase answer INVALID_ARGUMENT and the app must be one of the connector's FIREBASE_APP_IDS. The API cannot say who already has the release, so every group and tester sent is listed in the result. The reply is `accepted`.",
    z.object({
      appId: z.string().min(1),
      releaseId: releaseIdArg,
      groupAliases: z.array(groupAliasArg).max(MAX_RECIPIENTS).optional(),
      testerEmails: z.array(z.email().max(254)).max(MAX_RECIPIENTS).optional(),
    }),
    async (p) => {
      // Validated here and in `refuseBefore`, not with `.refine` (a refined schema loses `.shape`).
      const problem = distributeProblem(p);
      if (problem !== undefined) throw new Error(problem);
      const { groupAliases, testerEmails } = distributeRecipients(p);
      const body: Record<string, string[]> = {};
      if (testerEmails.length > 0) {
        body["testerEmails"] = testerEmails;
      }
      if (groupAliases.length > 0) {
        body["groupAliases"] = groupAliases;
      }
      await appDistRequest("POST", `${releasePath(p.appId, p.releaseId)}:distribute`, body);
      return jsonResult({
        ok: true,
        status: "accepted",
        appId: p.appId,
        releaseId: p.releaseId,
        groupAliases,
        testerEmails,
      });
    },
  );
}
