/**
 * iCloud Mail + Calendar MCP server — entry point.
 *
 * The real clients live in `adapters.ts` and the pure logic in
 * `apple-mail-core.ts`, `caldav-core.ts`, `calendar-tools.ts` and `tools.ts`.
 * This file is only the bootstrap: read the credentials, build the clients,
 * warm the CalDAV cache, register, connect.
 *
 * Credentials arrive as env vars injected by the lazy-mesh spawner — never
 * logged, IPC'd, or written to disk.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { requireProcessEnv } from "../../../shared/mcp-tool-kit.ts";
import {
  createAppleCalDavClient,
  createAppleDraftAppender,
  createAppleImapClient,
  createAppleSmtpMailer,
  icalTimestamp,
} from "./adapters.ts";
import { registerAppleTools } from "./tools.ts";

const email = requireProcessEnv("APPLE_ICLOUD_EMAIL");
const appPw = requireProcessEnv("APPLE_ICLOUD_APP_PASSWORD");

const calendar = createAppleCalDavClient(email, appPw);
// CalDAV principal + calendar-home discovery, so subsequent requests are
// authenticated against the resolved p##-caldav.icloud.com host.
await calendar.login();
// Warm the calendar cache at boot so a cold apple_calendar_event_create/delete
// (before any apple_calendar_list) resolves a fully-formed DAVCalendar (with its
// account binding) rather than a bare { url } that could fail auth on the
// resolved host. Best-effort: ignore discovery errors here (tools re-discover).
try {
  await calendar.listCalendars();
} catch {
  // non-fatal; listEvents/list tools will re-discover on demand
}

const server = new McpServer({ name: "nimbus-apple", version: "0.1.0" });

registerAppleTools(server, {
  client: createAppleImapClient(email, appPw),
  mailer: createAppleSmtpMailer(email, appPw),
  draftAppender: createAppleDraftAppender(email, appPw),
  calendar,
  now: () => icalTimestamp(),
});

await server.connect(new StdioServerTransport());
