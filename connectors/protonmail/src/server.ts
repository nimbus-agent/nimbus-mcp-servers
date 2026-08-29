/**
 * ProtonMail (via ProtonMail Bridge) connector entry point.
 *
 * The Bridge speaks standard IMAP/SMTP on the loopback interface, so the
 * transport itself is the shared `shared/imapflow-adapter.ts`. What is specific
 * to ProtonMail is only the configuration below: loopback defaults, STARTTLS
 * rather than implicit TLS, and a Bridge-generated self-signed certificate.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { envInt } from "../../../shared/imap-tool-kit.ts";
import { createImapFlowClient, createNodemailerMailer } from "../../../shared/imapflow-adapter.ts";
import { requireProcessEnv } from "../../../shared/mcp-tool-kit.ts";
import { registerProtonmailTools } from "./tools.ts";

// ProtonMail Bridge loopback defaults.
const DEFAULT_IMAP_HOST = "127.0.0.1";
const DEFAULT_IMAP_PORT = 1143;
const DEFAULT_SMTP_HOST = "127.0.0.1";
const DEFAULT_SMTP_PORT = 1025;

function envStr(name: string, fallback: string): string {
  const raw = process.env[name]?.trim();
  return raw === undefined || raw === "" ? fallback : raw;
}

/**
 * The Bridge listens on localhost with a self-signed certificate, so chain
 * verification is disabled and TLS is not implicit. Both are safe here and only
 * here: the connection never leaves 127.0.0.1.
 */
const BRIDGE_TLS = { secure: false, rejectUnauthorized: false } as const;

const server = new McpServer({ name: "nimbus-protonmail", version: "0.1.0" });

registerProtonmailTools(
  server,
  createImapFlowClient({
    host: envStr("PROTONMAIL_HOST", DEFAULT_IMAP_HOST),
    port: envInt("PROTONMAIL_PORT", DEFAULT_IMAP_PORT),
    user: requireProcessEnv("PROTONMAIL_USERNAME"),
    pass: requireProcessEnv("PROTONMAIL_PASSWORD"),
    ...BRIDGE_TLS,
  }),
  createNodemailerMailer({
    host: envStr("PROTONMAIL_SMTP_HOST", DEFAULT_SMTP_HOST),
    port: envInt("PROTONMAIL_SMTP_PORT", DEFAULT_SMTP_PORT),
    user: requireProcessEnv("PROTONMAIL_SMTP_USERNAME"),
    pass: requireProcessEnv("PROTONMAIL_SMTP_PASSWORD"),
    ...BRIDGE_TLS,
  }),
);

await server.connect(new StdioServerTransport());
