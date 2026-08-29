/**
 * IMAP/SMTP connector entry point.
 *
 * Everything below the config is in `shared/imapflow-adapter.ts`: the imapflow
 * client and nodemailer mailer used to be written out in full here and in
 * protonmail's entry point, which made them the most duplicated pair in the repo
 * and left both files unreachable from a test. This file is now only the
 * env → config mapping the adapter cannot know.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { envInt } from "../../../shared/imap-tool-kit.ts";
import { createImapFlowClient, createNodemailerMailer } from "../../../shared/imapflow-adapter.ts";
import { requireProcessEnv } from "../../../shared/mcp-tool-kit.ts";
import { registerImapTools } from "./tools.ts";

const DEFAULT_IMAP_PORT = 993;
const DEFAULT_SMTP_PORT = 465;
/** The port on which SMTP uses implicit TLS; anything else is STARTTLS. */
const SMTPS_PORT = 465;

const smtpPort = envInt("IMAP_SMTP_PORT", DEFAULT_SMTP_PORT);

const server = new McpServer({ name: "nimbus-imap", version: "0.1.0" });

registerImapTools(
  server,
  createImapFlowClient({
    host: requireProcessEnv("IMAP_HOST"),
    port: envInt("IMAP_PORT", DEFAULT_IMAP_PORT),
    user: requireProcessEnv("IMAP_USERNAME"),
    pass: requireProcessEnv("IMAP_PASSWORD"),
    secure: true,
  }),
  createNodemailerMailer({
    host: requireProcessEnv("IMAP_SMTP_HOST"),
    port: smtpPort,
    user: requireProcessEnv("IMAP_SMTP_USERNAME"),
    pass: requireProcessEnv("IMAP_SMTP_PASSWORD"),
    secure: smtpPort === SMTPS_PORT,
  }),
);

await server.connect(new StdioServerTransport());
