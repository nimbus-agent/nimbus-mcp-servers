import { z } from "zod";
import { createJsonGetter, envAuthHeaders, requiredEnv } from "../../../shared/env-json-api.ts";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
} from "../../../shared/mcp-tool-kit.ts";

function apiRoot(): string {
  const u = process.env["SENTRY_URL"]?.trim() || "https://sentry.io";
  return `${u.replace(/\/$/, "")}/api/0`;
}

function org(): string {
  return requiredEnv("SENTRY_ORG_SLUG");
}

const sentryGet = createJsonGetter({
  base: apiRoot,
  label: "Sentry",
  headers: envAuthHeaders({ env: "SENTRY_AUTH_TOKEN" }),
});

/** Tool names exposed by this connector — for contract/introspection tests. */
export const SENTRY_TOOL_NAMES = ["sentry_issue_list", "sentry_release_list"] as const;

export function registerSentryTools(server: { tool: (...args: never) => unknown }): void {
  const reg = createZodToolRegistrar(createRegisterSimpleTool(server));

  reg(
    "sentry_issue_list",
    "List unresolved issues for a project.",
    z.object({
      projectSlug: z.string().min(1),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    async (p) => {
      const lim = p.limit ?? 20;
      return jsonResult(
        await sentryGet(
          `/projects/${org()}/${p.projectSlug}/issues/?query=is:unresolved&limit=${String(lim)}`,
        ),
      );
    },
  );

  reg(
    "sentry_release_list",
    "List releases for a project.",
    z.object({ projectSlug: z.string().min(1) }),
    async (p) => jsonResult(await sentryGet(`/projects/${org()}/${p.projectSlug}/releases/`)),
  );
}
