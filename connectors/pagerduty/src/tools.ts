import { z } from "zod";
import type { ConsentServer } from "../../../shared/consent-kit.ts";
import { createWriteToolRegistrar } from "../../../shared/consent-kit.ts";
import { guardedFetch } from "../../../shared/guarded-fetch.ts";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
  requireProcessEnv,
} from "../../../shared/mcp-tool-kit.ts";
import {
  makeRestToolRegistrar,
  type RestFetchResult,
  toRestFetchResult,
} from "../../../shared/rest-tool-kit.ts";

const API = "https://api.pagerduty.com";

async function pdFetch(token: string, path: string, init?: RequestInit): Promise<RestFetchResult> {
  const rel = path.startsWith("/") ? path : `/${path}`;
  const url = path.startsWith("http") ? path : `${API}${rel}`;
  // guardedFetch: a write answered with a redirect is refused, and a GET follows only same-origin.
  const res = await guardedFetch("PagerDuty", url, {
    ...init,
    headers: {
      Accept: "application/vnd.pagerduty+json;version=2",
      Authorization: `Token token=${token}`,
      "Content-Type": "application/json",
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  return toRestFetchResult(res);
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The `From` header PagerDuty requires on an incident update: "The email address of a valid user
 * associated with the account making the request". Writes only. Throws before any request.
 * The gateway injects it from the Vault key `pagerduty.from_email`.
 */
function requirePdFromEmail(): string {
  const email = requireProcessEnv("PAGERDUTY_FROM_EMAIL");
  if (!EMAIL_SHAPE.test(email)) {
    throw new Error("PAGERDUTY_FROM_EMAIL is not an email address");
  }
  return email;
}

/** Incident ids are short alphanumerics; anything else never reaches a URL. */
const incidentIdSchema = z.string().regex(/^[A-Za-z0-9]{1,64}$/);

/**
 * `PUT /incidents/{id}` with `{incident:{type:"incident_reference", status}}` and a required
 * `From` header: the only update endpoint
 * https://docs.pagerduty.com/developer/api/reference/rest/incidents/update-incident documents
 * (retrieved 2026-11-06). There is no `/acknowledge` or `/resolve` sub-endpoint.
 */
async function pdIncidentPut(
  actionLabel: string,
  change: { readonly status: "acknowledged" | "resolved" } | { readonly escalation_level: number },
  incidentId: string,
) {
  const from = requirePdFromEmail();
  const token = requireProcessEnv("PAGERDUTY_API_TOKEN");
  const res = await pdFetch(token, `/incidents/${encodeURIComponent(incidentId)}`, {
    method: "PUT",
    headers: { From: from },
    body: JSON.stringify({ incident: { type: "incident_reference", ...change } }),
  });
  if (!res.ok) {
    throw new Error(`PagerDuty ${actionLabel} ${String(res.status)}: ${res.text.slice(0, 400)}`);
  }
  return jsonResult(res.json ?? { ok: true });
}

/** The incident as it stands: status, assignments, escalation level. Audited before a write. */
async function readIncidentPreState(incidentId: string): Promise<Record<string, unknown>> {
  requirePdFromEmail();
  const token = requireProcessEnv("PAGERDUTY_API_TOKEN");
  const res = await pdFetch(token, `/incidents/${encodeURIComponent(incidentId)}`);
  if (!res.ok) {
    throw new Error(`PagerDuty pre-state ${String(res.status)}: ${res.text.slice(0, 400)}`);
  }
  const inc = (res.json as { incident?: Record<string, unknown> } | null)?.incident ?? {};
  return {
    id: incidentId,
    status: inc["status"],
    assignments: inc["assignments"],
    escalation_level: inc["escalation_level"] ?? null,
    escalation_policy: inc["escalation_policy"],
  };
}

/** Tool names exposed by this connector — for contract/introspection tests. */
export const PAGERDUTY_TOOL_NAMES = [
  "pd_incident_list",
  "pd_incident_get",
  "pd_incident_acknowledge",
  "pd_incident_resolve",
  "pd_incident_escalate",
] as const;

export function registerPagerdutyTools(
  server: ConsentServer & { tool: (...args: never) => unknown },
): void {
  const reg = createZodToolRegistrar(createRegisterSimpleTool(server));

  /**
   * Every MUTATING pagerduty tool goes through here. Outside the gateway this adds the
   * consent gate, the write-scope allow-list, the mutation budget and the audit record; inside
   * the gateway it is a pass-through, because executor.ts (I2) is the gate there.
   */
  const registerWriteTool = createWriteToolRegistrar(server, {
    connector: "pagerduty",
    scopeEnv: "NIMBUS_MCP_PAGERDUTY_WRITE_SCOPE",
    scopeKinds: ["incident"],
  });

  /** Standard PagerDuty read tool: token → pdFetch(buildPath) → mcpJsonResultIfOk("PagerDuty"). */
  const registerPdTool = makeRestToolRegistrar({
    registrar: reg,
    tokenEnv: "PAGERDUTY_API_TOKEN",
    serviceLabel: "PagerDuty",
    fetch: pdFetch,
  });

  registerPdTool(
    "pd_incident_list",
    "List PagerDuty incidents (open and recently resolved).",
    z.object({
      statuses: z.array(z.enum(["triggered", "acknowledged", "resolved"])).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    (parsed) => {
      const u = new URL(`${API}/incidents`);
      u.searchParams.set("limit", String(parsed.limit ?? 25));
      const st = parsed.statuses ?? ["triggered", "acknowledged"];
      for (const s of st) {
        u.searchParams.append("statuses[]", s);
      }
      return `${u.pathname}${u.search}`;
    },
  );

  registerPdTool(
    "pd_incident_get",
    "Get a single incident by id.",
    z.object({ incidentId: z.string().min(1) }),
    (parsed) => `/incidents/${encodeURIComponent(parsed.incidentId)}`,
  );

  // Literal tool ids and `mutates` strings, so a static scan reads them. None can be undone
  // through these tools (there is no unacknowledge, reopen or de-escalate), so each records the
  // incident's prior state in the audit.
  const incidentArgs = z.object({ incidentId: incidentIdSchema });
  const incidentScope = (p: { incidentId: string }) => ({
    kind: "incident",
    value: p.incidentId,
  });

  registerWriteTool(
    "pd_incident_acknowledge",
    {
      mutates: "pagerduty.incident.acknowledge",
      recoverable: false,
      capturePreState: (p) => readIncidentPreState(p.incidentId),
      scopeTargetOf: incidentScope,
    },
    "Acknowledge an incident (`PUT /incidents/{id}` with status acknowledged). Needs PAGERDUTY_FROM_EMAIL, the email of a valid PagerDuty user.",
    incidentArgs,
    async (p) => pdIncidentPut("acknowledge", { status: "acknowledged" }, p.incidentId),
  );

  registerWriteTool(
    "pd_incident_resolve",
    {
      mutates: "pagerduty.incident.resolve",
      recoverable: false,
      capturePreState: (p) => readIncidentPreState(p.incidentId),
      scopeTargetOf: incidentScope,
    },
    "Resolve an incident (`PUT /incidents/{id}` with status resolved); it cannot be reopened through these tools. Needs PAGERDUTY_FROM_EMAIL, the email of a valid PagerDuty user.",
    incidentArgs,
    async (p) => pdIncidentPut("resolve", { status: "resolved" }, p.incidentId),
  );

  registerWriteTool(
    "pd_incident_escalate",
    {
      mutates: "pagerduty.incident.escalate",
      recoverable: false,
      capturePreState: (p) => readIncidentPreState(p.incidentId),
      scopeTargetOf: incidentScope,
    },
    // `escalation_level` ("Escalate the incident to this level in the escalation policy.", an
    // integer) is a property of the `incident` body of PUT /incidents/{id} in PagerDuty's OpenAPI
    // schema (github.com/PagerDuty/api-schema, reference/REST/openapiv3.json, retrieved 2026-11-06).
    "Escalate an incident to the given level of its escalation policy (`PUT /incidents/{id}` with `escalation_level`); it cannot be de-escalated through these tools. Needs PAGERDUTY_FROM_EMAIL, the email of a valid PagerDuty user.",
    incidentArgs.extend({ escalationLevel: z.number().int().min(1).max(20) }),
    async (p) => pdIncidentPut("escalate", { escalation_level: p.escalationLevel }, p.incidentId),
  );
}
