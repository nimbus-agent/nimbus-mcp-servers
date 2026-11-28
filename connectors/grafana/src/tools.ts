import { z } from "zod";
import { envAuthHeaders, requiredEnv } from "../../../shared/env-json-api.ts";
import { guardedFetch } from "../../../shared/guarded-fetch.ts";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
} from "../../../shared/mcp-tool-kit.ts";

/** Only ONE trailing slash is dropped here — not `requiredBaseUrl`'s strip-them-all. */
function baseUrl(): string {
  return requiredEnv("GRAFANA_URL").replace(/\/$/, "");
}

const authHeaders = envAuthHeaders({ env: "GRAFANA_API_TOKEN" });

async function grafanaGet(path: string): Promise<unknown> {
  const pathPart = path.startsWith("/") ? path : `/${path}`;
  // The shared redirect policy and timeout: a plain fetch followed any Location, re-sending the
  // bearer token to whatever host it named. Plain http stays allowed for a local Grafana, as the
  // shared JSON getter allows it.
  const res = await guardedFetch(
    "Grafana",
    `${baseUrl()}${pathPart}`,
    { headers: authHeaders() },
    { requireSecureBase: false },
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Grafana ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

/** Tool names exposed by this connector — for contract/introspection tests. */
export const GRAFANA_TOOL_NAMES = ["grafana_alert_list", "grafana_dashboard_list"] as const;

export function registerGrafanaTools(server: { tool: (...args: never) => unknown }): void {
  const reg = createZodToolRegistrar(createRegisterSimpleTool(server));

  reg("grafana_alert_list", "List alert rules (Ruler API).", z.object({}), async () =>
    jsonResult(await grafanaGet("/api/ruler/grafana/api/v1/rules")),
  );

  reg(
    "grafana_dashboard_list",
    "Search dashboards.",
    z.object({ query: z.string().optional() }),
    async (p) => {
      const q = p.query ?? "";
      return jsonResult(
        await grafanaGet(`/api/search?type=dash-db&query=${encodeURIComponent(q)}`),
      );
    },
  );
}
