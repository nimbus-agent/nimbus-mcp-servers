import { z } from "zod";
import { createJsonGetter, envAuthHeaders } from "../../../shared/env-json-api.ts";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
} from "../../../shared/mcp-tool-kit.ts";

const nrGet = createJsonGetter({
  base: "https://api.newrelic.com",
  label: "New Relic",
  headers: envAuthHeaders({ env: "NEW_RELIC_API_KEY", scheme: "", header: "X-Api-Key" }),
});

/** Tool names exposed by this connector — for contract/introspection tests. */
export const NEWRELIC_TOOL_NAMES = [
  "newrelic_application_list",
  "newrelic_alert_violations",
] as const;

export function registerNewrelicTools(server: { tool: (...args: never) => unknown }): void {
  const reg = createZodToolRegistrar(createRegisterSimpleTool(server));

  reg("newrelic_application_list", "List APM applications.", z.object({}), async () =>
    jsonResult(await nrGet("/v2/applications.json")),
  );

  reg(
    "newrelic_alert_violations",
    "List recent alert violations.",
    z.object({ only_open: z.boolean().optional() }),
    async (p) => {
      const only = p.only_open === true ? "true" : "false";
      return jsonResult(await nrGet(`/v2/alerts_violations.json?only_open=${only}`));
    },
  );
}
