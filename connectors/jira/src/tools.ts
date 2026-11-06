import { z } from "zod";
import {
  fetchAtlassianBasicAuthJsonText,
  normalizeRequiredSiteBaseUrl,
  requireTrimmedEnv,
} from "../../../shared/atlassian-json-fetch.ts";
import type { ConsentServer } from "../../../shared/consent-kit.ts";
import { createWriteToolRegistrar } from "../../../shared/consent-kit.ts";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
  mcpJsonResultFromTextIfOk,
} from "../../../shared/mcp-tool-kit.ts";

function requireJiraConfig(): { baseUrl: string; email: string; token: string } {
  const baseRaw = requireTrimmedEnv("JIRA_BASE_URL", "JIRA_BASE_URL is not set");
  const email = requireTrimmedEnv("JIRA_EMAIL", "JIRA_EMAIL is not set");
  const token = requireTrimmedEnv("JIRA_API_TOKEN", "JIRA_API_TOKEN is not set");
  return {
    baseUrl: normalizeRequiredSiteBaseUrl(baseRaw, "JIRA_BASE_URL is empty"),
    email,
    token,
  };
}

async function jiraFetch(
  baseUrl: string,
  email: string,
  token: string,
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; text: string }> {
  const relativePath = path.startsWith("/") ? path : `/${path}`;
  const url = `${baseUrl}${relativePath}`;
  return fetchAtlassianBasicAuthJsonText(url, email, token, init);
}

function plainToAdf(text: string): Record<string, unknown> {
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  };
}

type JiraConfig = { baseUrl: string; email: string; token: string };
type HttpText = { ok: boolean; status: number; text: string };

/** Atlassian's API gateway for JSM Operations. The host is fixed: it is never taken from an argument. */
const OPS_API_ROOT = "https://api.atlassian.com/jsm/ops/api";

/** A cloud id is a UUID. It enters a URL path, so anything else is refused, not encoded. */
const CLOUD_ID_PATTERN = /^[0-9a-f-]{36}$/i;

/** Discovered cloud ids, per site, for the life of the process. */
const discoveredCloudIds = new Map<string, string>();

/** Test seam: forget discovered cloud ids. */
export function resetJiraCloudIdCacheForTests(): void {
  discoveredCloudIds.clear();
}

function assertCloudId(value: unknown, source: string): string {
  if (typeof value !== "string" || !CLOUD_ID_PATTERN.test(value)) {
    throw new Error(
      `${source} did not give a valid Jira cloud id; set JIRA_CLOUD_ID to the site's cloud id`,
    );
  }
  return value;
}

/** A request is never allowed to follow a redirect: the credential goes only where it was aimed. */
function refuseRedirect(what: string, res: HttpText): HttpText {
  if (res.status >= 300 && res.status < 400) {
    throw new Error(
      `${what} answered ${String(res.status)} with a redirect; refused (for a write, it may or may not have been applied)`,
    );
  }
  return res;
}

function isAtlassianCloudHost(baseUrl: string): boolean {
  try {
    // https only: over plain http an on-path attacker could answer tenant_info with another tenant's id.
    const u = new URL(baseUrl);
    return u.protocol === "https:" && u.hostname.toLowerCase().endsWith(".atlassian.net");
  } catch {
    return false;
  }
}

/**
 * The site's cloud id: `JIRA_CLOUD_ID` when set, else `GET {site}/_edge/tenant_info` once per
 * process per site, only for an `*.atlassian.net` base (Atlassian's documented lookup, sent with the same Basic header as every other Jira call,
 * so the credential goes only to the host it already goes to). Fails closed: no id, no ops call.
 */
async function resolveCloudId(cfg: JiraConfig): Promise<string> {
  const configured = process.env["JIRA_CLOUD_ID"]?.trim();
  if (configured !== undefined && configured !== "") {
    return assertCloudId(configured, "JIRA_CLOUD_ID");
  }
  const cached = discoveredCloudIds.get(cfg.baseUrl);
  if (cached !== undefined) return cached;
  // tenant_info is an Atlassian Cloud endpoint. A Data Center or proxied site has none, so no
  // request is made to guess: the owner names the cloud id.
  if (!isAtlassianCloudHost(cfg.baseUrl)) {
    throw new Error(
      "JIRA_CLOUD_ID is required: JIRA_BASE_URL is not an *.atlassian.net site, so the cloud id cannot be discovered",
    );
  }
  const res = refuseRedirect(
    "Jira tenant_info",
    await jiraFetch(cfg.baseUrl, cfg.email, cfg.token, "/_edge/tenant_info", {
      redirect: "manual",
    }),
  );
  if (!res.ok) {
    throw new Error(
      `Jira tenant_info ${String(res.status)}: could not discover the cloud id; set JIRA_CLOUD_ID`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.text);
  } catch {
    throw new Error("Jira tenant_info was not JSON; set JIRA_CLOUD_ID to the site's cloud id");
  }
  const id = assertCloudId((parsed as { cloudId?: unknown } | null)?.cloudId, "Jira tenant_info");
  discoveredCloudIds.set(cfg.baseUrl, id);
  return id;
}

/** One JSM Operations request: `https://api.atlassian.com/jsm/ops/api/{cloudId}/v1{path}`. */
async function opsFetch(cfg: JiraConfig, path: string, init?: RequestInit): Promise<HttpText> {
  const cloudId = await resolveCloudId(cfg);
  const res = await fetchAtlassianBasicAuthJsonText(
    `${OPS_API_ROOT}/${cloudId}/v1${path}`,
    cfg.email,
    cfg.token,
    { ...init, redirect: "manual" },
  );
  return refuseRedirect("Jira Operations", res);
}

/** Ids that reach a path: the documented alert id, and request ids, are plain tokens. */
const opsIdPattern = /^[A-Za-z0-9_-]{1,128}$/;

const alertIdSchema = z.object({
  alertId: z
    .string()
    .regex(opsIdPattern, "the alert id (not a tinyId or alias): letters, digits, '_' and '-'"),
});

/** What the audit record needs to understand an alert before it was acknowledged or closed. */
async function alertPreState(parsed: { alertId: string }): Promise<Record<string, unknown>> {
  const res = await opsFetch(requireJiraConfig(), `/alerts/${encodeURIComponent(parsed.alertId)}`);
  if (!res.ok) {
    throw new Error(`Jira Operations ${String(res.status)}: ${res.text.slice(0, 200)}`);
  }
  const alert = JSON.parse(res.text) as Record<string, unknown>;
  return {
    status: alert["status"],
    acknowledged: alert["acknowledged"],
    message: alert["message"],
    priority: alert["priority"],
  };
}

/** The 202 body of an async alert action, without claiming the action has happened. */
function acceptedResult(res: HttpText): ReturnType<typeof jsonResult> {
  if (!res.ok) {
    throw new Error(`Jira Operations ${String(res.status)}: ${res.text.slice(0, 400)}`);
  }
  // A 2xx means Atlassian accepted the request; a body that is not JSON must not turn that into
  // an error the owner would read as "nothing happened" and retry.
  let body: { requestId?: unknown; took?: unknown } = {};
  if (res.text !== "") {
    try {
      const parsed: unknown = JSON.parse(res.text);
      if (parsed !== null && typeof parsed === "object") body = parsed;
    } catch {
      body = {};
    }
  }
  return jsonResult({
    status: "accepted",
    requestId: typeof body.requestId === "string" ? body.requestId : null,
    took: body.took,
  });
}

/** Tool names exposed by this connector — for contract/introspection tests. */
export const JIRA_TOOL_NAMES = [
  "jira_issue_list",
  "jira_issue_get",
  "jira_issue_create",
  "jira_issue_update",
  "jira_comment_add",
  "jira_issue_transitions_list",
  "jira_issue_transition",
  "jira_board_list",
  "jira_sprint_list",
  "jira_epic_list",
  "jira_ops_alert_get",
  "jira_ops_alert_list",
  "jira_ops_alert_request_status",
  "jira_ops_alert_acknowledge",
  "jira_ops_alert_close",
] as const;

export function registerJiraTools(
  server: ConsentServer & { tool: (...args: never) => unknown },
): void {
  const registerSimpleTool = createRegisterSimpleTool(server);

  const reg = createZodToolRegistrar(registerSimpleTool);

  /**
   * Every MUTATING jira tool goes through here. Outside the gateway this adds the
   * consent gate, the write-scope allow-list, the mutation budget and the audit record; inside
   * the gateway it is a pass-through, because executor.ts (I2) is the gate there.
   */
  const registerWriteTool = createWriteToolRegistrar(server, {
    connector: "jira",
    scopeEnv: "NIMBUS_MCP_JIRA_WRITE_SCOPE",
    scopeKinds: ["project", "issue", "alert"],
  });

  const jiraIssueListSchema = z.object({
    jql: z.string().min(1).optional(),
    startAt: z.number().int().min(0).optional(),
    maxResults: z.number().int().min(1).max(100).optional(),
  });

  reg(
    "jira_issue_list",
    "Search Jira issues with JQL (Jira Cloud REST POST /rest/api/3/search).",
    jiraIssueListSchema,
    async (parsed) => {
      const { baseUrl, email, token } = requireJiraConfig();
      const jql = parsed.jql ?? "order by updated DESC";
      const body = JSON.stringify({
        jql,
        startAt: parsed.startAt ?? 0,
        maxResults: parsed.maxResults ?? 50,
        fields: [
          "summary",
          "description",
          "updated",
          "status",
          "issuetype",
          "priority",
          "assignee",
        ],
      });
      const res = await jiraFetch(baseUrl, email, token, "/rest/api/3/search", {
        method: "POST",
        body,
      });
      return mcpJsonResultFromTextIfOk("Jira", res, {
        jsonParseErrorMessage: "Jira: invalid JSON from search",
      });
    },
  );

  const jiraIssueKeySchema = z.object({ issueKey: z.string().min(1) });

  reg(
    "jira_issue_get",
    "Get a Jira issue by key or id (GET /rest/api/3/issue/{issueIdOrKey}).",
    jiraIssueKeySchema,
    async (parsed) => {
      const { baseUrl, email, token } = requireJiraConfig();
      const key = encodeURIComponent(parsed.issueKey);
      const res = await jiraFetch(
        baseUrl,
        email,
        token,
        `/rest/api/3/issue/${key}?fields=summary,description,updated,status,issuetype,priority,assignee,comment`,
      );
      return mcpJsonResultFromTextIfOk("Jira", res, {
        jsonParseErrorMessage: "Jira: invalid JSON from issue get",
      });
    },
  );

  const jiraIssueCreateSchema = z.object({
    projectKey: z.string().min(1),
    summary: z.string().min(1),
    description: z.string().optional(),
    issueTypeName: z.string().min(1).optional(),
  });

  registerWriteTool(
    "jira_issue_create",
    {
      mutates: "jira.issue.create",
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "project", value: p.projectKey }),
    },
    "Create a Jira issue (POST /rest/api/3/issue). Requires project key and summary.",
    jiraIssueCreateSchema,
    async (parsed) => {
      const { baseUrl, email, token } = requireJiraConfig();
      const fields: Record<string, unknown> = {
        project: { key: parsed.projectKey },
        summary: parsed.summary,
        issuetype: { name: parsed.issueTypeName ?? "Task" },
      };
      if (parsed.description !== undefined && parsed.description !== "") {
        fields["description"] = plainToAdf(parsed.description);
      }
      const body = JSON.stringify({ fields });
      const res = await jiraFetch(baseUrl, email, token, "/rest/api/3/issue", {
        method: "POST",
        body,
      });
      return mcpJsonResultFromTextIfOk("Jira", res, {
        jsonParseErrorMessage: "Jira: invalid JSON from issue create",
      });
    },
  );

  const jiraIssueUpdateSchema = z.object({
    issueKey: z.string().min(1),
    summary: z.string().min(1).optional(),
    description: z.string().optional(),
  });

  registerWriteTool(
    "jira_issue_update",
    {
      mutates: "jira.issue.update",
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "issue", value: p.issueKey }),
    },
    "Update summary and/or description on a Jira issue (PUT /rest/api/3/issue/{key}).",
    jiraIssueUpdateSchema,
    async (parsed) => {
      if (parsed.summary === undefined && parsed.description === undefined) {
        throw new Error("Provide summary and/or description to update");
      }
      const { baseUrl, email, token } = requireJiraConfig();
      const fields: Record<string, unknown> = {};
      if (parsed.summary !== undefined) {
        fields["summary"] = parsed.summary;
      }
      if (parsed.description !== undefined) {
        fields["description"] = plainToAdf(parsed.description);
      }
      const key = encodeURIComponent(parsed.issueKey);
      const body = JSON.stringify({ fields });
      const res = await jiraFetch(baseUrl, email, token, `/rest/api/3/issue/${key}`, {
        method: "PUT",
        body,
      });
      if (!res.ok) {
        throw new Error(`Jira ${String(res.status)}: ${res.text.slice(0, 400)}`);
      }
      return jsonResult({ ok: true, issueKey: parsed.issueKey });
    },
  );

  const jiraCommentAddSchema = z.object({
    issueKey: z.string().min(1),
    body: z.string().min(1),
  });

  registerWriteTool(
    "jira_comment_add",
    {
      mutates: "jira.comment.add",
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "issue", value: p.issueKey }),
    },
    "Add a comment to a Jira issue (POST /rest/api/3/issue/{key}/comment).",
    jiraCommentAddSchema,
    async (parsed) => {
      const { baseUrl, email, token } = requireJiraConfig();
      const key = encodeURIComponent(parsed.issueKey);
      const payload = JSON.stringify({ body: plainToAdf(parsed.body) });
      const res = await jiraFetch(baseUrl, email, token, `/rest/api/3/issue/${key}/comment`, {
        method: "POST",
        body: payload,
      });
      return mcpJsonResultFromTextIfOk("Jira", res, {
        jsonParseErrorMessage: "Jira: invalid JSON from comment add",
      });
    },
  );

  reg(
    "jira_issue_transitions_list",
    "List the workflow transitions available to a Jira issue right now, with their ids and required fields (GET /rest/api/3/issue/{key}/transitions); read this before jira_issue_transition.",
    jiraIssueKeySchema,
    async (parsed) => {
      const { baseUrl, email, token } = requireJiraConfig();
      const key = encodeURIComponent(parsed.issueKey);
      const res = await jiraFetch(
        baseUrl,
        email,
        token,
        `/rest/api/3/issue/${key}/transitions?expand=transitions.fields`,
      );
      return mcpJsonResultFromTextIfOk("Jira", res, {
        jsonParseErrorMessage: "Jira: invalid JSON from transitions list",
      });
    },
  );

  const jiraIssueTransitionSchema = jiraIssueKeySchema.extend({
    transitionId: z
      .string()
      .regex(/^\d{1,20}$/, "transitionId is the numeric id from jira_issue_transitions_list"),
  });

  registerWriteTool(
    "jira_issue_transition",
    {
      mutates: "jira.issue.transition",
      // Workflows are often one-way (Done cannot always be left), so the status the issue is in
      // BEFORE the move is captured: it is the one thing the audit record needs to reverse it.
      recoverable: false,
      capturePreState: async (parsed) => {
        const { baseUrl, email, token } = requireJiraConfig();
        const key = encodeURIComponent(parsed.issueKey);
        const res = await jiraFetch(
          baseUrl,
          email,
          token,
          `/rest/api/3/issue/${key}?fields=status`,
        );
        if (!res.ok) {
          throw new Error(`Jira ${String(res.status)}: ${res.text.slice(0, 200)}`);
        }
        const json = JSON.parse(res.text) as {
          fields?: { status?: { name?: string; id?: string } };
        };
        return { status: json.fields?.status?.name ?? json.fields?.status?.id };
      },
      scopeTargetOf: (p) => ({ kind: "issue", value: p.issueKey }),
    },
    "Move a Jira issue through its workflow with a transition id from jira_issue_transitions_list (POST /rest/api/3/issue/{key}/transitions); workflows can be one-way, so this may not be reversible.",
    jiraIssueTransitionSchema,
    async (parsed) => {
      const { baseUrl, email, token } = requireJiraConfig();
      const key = encodeURIComponent(parsed.issueKey);
      const res = await jiraFetch(baseUrl, email, token, `/rest/api/3/issue/${key}/transitions`, {
        method: "POST",
        body: JSON.stringify({ transition: { id: parsed.transitionId } }),
      });
      if (!res.ok) {
        throw new Error(`Jira ${String(res.status)}: ${res.text.slice(0, 400)}`);
      }
      return jsonResult({
        ok: true,
        issueKey: parsed.issueKey,
        transitionId: parsed.transitionId,
      });
    },
  );

  const jiraBoardListSchema = z.object({
    startAt: z.number().int().min(0).optional(),
    maxResults: z.number().int().min(1).max(50).optional(),
  });

  reg(
    "jira_board_list",
    "List Jira boards (GET /rest/agile/1.0/board).",
    jiraBoardListSchema,
    async (parsed) => {
      const { baseUrl, email, token } = requireJiraConfig();
      const start = parsed.startAt ?? 0;
      const max = parsed.maxResults ?? 50;
      const res = await jiraFetch(
        baseUrl,
        email,
        token,
        `/rest/agile/1.0/board?startAt=${String(start)}&maxResults=${String(max)}`,
      );
      return mcpJsonResultFromTextIfOk("Jira", res, {
        jsonParseErrorMessage: "Jira: invalid JSON from board list",
      });
    },
  );

  const jiraSprintListSchema = z.object({
    boardId: z.number().int().min(1),
    startAt: z.number().int().min(0).optional(),
    maxResults: z.number().int().min(1).max(50).optional(),
  });

  reg(
    "jira_sprint_list",
    "List sprints for a board (GET /rest/agile/1.0/board/{boardId}/sprint).",
    jiraSprintListSchema,
    async (parsed) => {
      const { baseUrl, email, token } = requireJiraConfig();
      const start = parsed.startAt ?? 0;
      const max = parsed.maxResults ?? 50;
      const bid = String(parsed.boardId);
      const res = await jiraFetch(
        baseUrl,
        email,
        token,
        `/rest/agile/1.0/board/${bid}/sprint?startAt=${String(start)}&maxResults=${String(max)}`,
      );
      return mcpJsonResultFromTextIfOk("Jira", res, {
        jsonParseErrorMessage: "Jira: invalid JSON from sprint list",
      });
    },
  );

  const jiraEpicListSchema = z.object({
    projectKey: z.string().min(1),
    maxResults: z.number().int().min(1).max(100).optional(),
  });

  reg(
    "jira_epic_list",
    "List epics in a project via JQL search.",
    jiraEpicListSchema,
    async (parsed) => {
      const { baseUrl, email, token } = requireJiraConfig();
      const pk = parsed.projectKey;
      const jql = `project = ${pk} AND issuetype = Epic ORDER BY updated DESC`;
      const body = JSON.stringify({
        jql,
        startAt: 0,
        maxResults: parsed.maxResults ?? 50,
        fields: ["summary", "updated", "status"],
      });
      const res = await jiraFetch(baseUrl, email, token, "/rest/api/3/search", {
        method: "POST",
        body,
      });
      return mcpJsonResultFromTextIfOk("Jira", res, {
        jsonParseErrorMessage: "Jira: invalid JSON from epic search",
      });
    },
  );

  reg(
    "jira_ops_alert_get",
    "Get a Jira Service Management Operations alert by its id (GET /alerts/{id} on the JSM Operations API): status, acknowledged, message, priority, responders. Takes the alert id, not a tinyId or alias.",
    alertIdSchema,
    async (parsed) => {
      const res = await opsFetch(
        requireJiraConfig(),
        `/alerts/${encodeURIComponent(parsed.alertId)}`,
      );
      return mcpJsonResultFromTextIfOk("Jira Operations", res, {
        jsonParseErrorMessage: "Jira Operations: invalid JSON from alert get",
      });
    },
  );

  reg(
    "jira_ops_alert_list",
    "List Jira Service Management Operations alerts (GET /alerts). `query` is the Operations search query; `size` 1-100 (default 25); offset plus size must stay under 20000.",
    z.object({
      query: z.string().min(1).max(1000).optional(),
      size: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
      sort: z.enum(["createdAt", "updatedAt"]).optional(),
      order: z.enum(["asc", "desc"]).optional(),
      from: z.string().min(1).max(64).optional(),
      to: z.string().min(1).max(64).optional(),
    }),
    async (parsed) => {
      const size = parsed.size ?? 25;
      const offset = parsed.offset ?? 0;
      if (offset + size >= 20_000) {
        throw new Error("offset plus size must be lower than 20000");
      }
      const search = new URLSearchParams({ size: String(size), offset: String(offset) });
      for (const key of ["query", "sort", "order", "from", "to"] as const) {
        const value = parsed[key];
        if (value !== undefined) search.set(key, value);
      }
      const res = await opsFetch(requireJiraConfig(), `/alerts?${search.toString()}`);
      return mcpJsonResultFromTextIfOk("Jira Operations", res, {
        jsonParseErrorMessage: "Jira Operations: invalid JSON from alert list",
      });
    },
  );

  reg(
    "jira_ops_alert_request_status",
    "Check an asynchronous alert action (GET /alerts/requests/{id}) with the requestId that jira_ops_alert_acknowledge or jira_ops_alert_close returned: whether it was processed and succeeded.",
    z.object({ requestId: z.string().regex(opsIdPattern, "letters, digits, '_' and '-' only") }),
    async (parsed) => {
      const res = await opsFetch(
        requireJiraConfig(),
        `/alerts/requests/${encodeURIComponent(parsed.requestId)}`,
      );
      return mcpJsonResultFromTextIfOk("Jira Operations", res, {
        jsonParseErrorMessage: "Jira Operations: invalid JSON from request status",
      });
    },
  );

  registerWriteTool(
    "jira_ops_alert_acknowledge",
    {
      mutates: "jira.ops.alert.acknowledge",
      // No unacknowledge tool is built, so the alert's state before is captured instead.
      recoverable: false,
      capturePreState: alertPreState,
      scopeTargetOf: (p) => ({ kind: "alert", value: p.alertId }),
    },
    "Acknowledge a Jira Service Management Operations alert (POST /alerts/{id}/acknowledge; the API takes no body). The action is asynchronous: this returns {status: accepted, requestId}, not completion; check it with jira_ops_alert_request_status. Takes the alert id, not a tinyId or alias.",
    alertIdSchema,
    async (parsed) => {
      const res = await opsFetch(
        requireJiraConfig(),
        `/alerts/${encodeURIComponent(parsed.alertId)}/acknowledge`,
        { method: "POST" },
      );
      return acceptedResult(res);
    },
  );

  registerWriteTool(
    "jira_ops_alert_close",
    {
      mutates: "jira.ops.alert.close",
      // The Operations API has no reopen, so the alert's state before is captured.
      recoverable: false,
      capturePreState: alertPreState,
      scopeTargetOf: (p) => ({ kind: "alert", value: p.alertId }),
    },
    "Close a Jira Service Management Operations alert (POST /alerts/{id}/close; the API takes no body). It cannot be reopened through this API. The action is asynchronous: this returns {status: accepted, requestId}, not completion. To resolve an incident use jira_issue_transition; incidents are Jira issues.",
    alertIdSchema,
    async (parsed) => {
      const res = await opsFetch(
        requireJiraConfig(),
        `/alerts/${encodeURIComponent(parsed.alertId)}/close`,
        { method: "POST" },
      );
      return acceptedResult(res);
    },
  );
}
