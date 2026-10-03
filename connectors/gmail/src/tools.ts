import { z } from "zod";
import { type ConsentServer, createWriteToolRegistrar } from "../../../shared/consent-kit.ts";
import {
  emailToolSchemas,
  mailSendConsent,
  type OutgoingMail,
  outgoingMail,
} from "../../../shared/imap-tool-kit.ts";
import { createRegisterSimpleTool, createZodToolRegistrar } from "../../../shared/mcp-tool-kit.ts";
import {
  makeRestFetcher,
  makeRestToolRegistrar,
  makeRestWriteToolRegistrar,
} from "../../../shared/rest-tool-kit.ts";

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

function gmailFetch(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  return makeRestFetcher({ apiBase: GMAIL_BASE, token })(path, init);
}

function buildRfc822Message(params: OutgoingMail): string {
  const lines: string[] = [
    `To: ${params.to}`,
    ...(params.cc !== undefined && params.cc !== "" ? [`Cc: ${params.cc}`] : []),
    ...(params.bcc !== undefined && params.bcc !== "" ? [`Bcc: ${params.bcc}`] : []),
    `Subject: ${params.subject}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    params.body,
  ];
  return lines.join("\r\n");
}

function toRawBase64Url(rfc822: string): string {
  return Buffer.from(rfc822, "utf-8").toString("base64url");
}

/** The base64url RFC 822 message Gmail's `raw` fields take, for validated send arguments. */
function rawMessage(args: Parameters<typeof outgoingMail>[0]): string {
  return toRawBase64Url(buildRfc822Message(outgoingMail(args)));
}

/** A POST carrying `body` as JSON. */
function jsonPost(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export function registerGmailTools(
  server: ConsentServer & { tool: (...args: never) => unknown },
): void {
  const reg = createZodToolRegistrar(createRegisterSimpleTool(server));

  /**
   * Every MUTATING gmail tool goes through here. Outside the gateway this adds the
   * consent gate, the write-scope allow-list, the mutation budget and the audit record; inside
   * the gateway it is a pass-through, because executor.ts (I2) is the gate there.
   */
  const registerWriteTool = createWriteToolRegistrar(server, {
    connector: "gmail",
    scopeEnv: "NIMBUS_MCP_GMAIL_WRITE_SCOPE",
    scopeKinds: ["recipient", "draft"],
  });

  /**
   * Standard Gmail tool, read or write: token → gmailFetch(buildPath[, buildInit]) →
   * mcpJsonResultIfOk("Gmail API", …, 200).
   */
  const gmailRest = {
    tokenEnv: "GOOGLE_OAUTH_ACCESS_TOKEN",
    serviceLabel: "Gmail API",
    fetch: gmailFetch,
    snippetMax: 200,
  } as const;

  const registerGmailTool = makeRestToolRegistrar({ registrar: reg, ...gmailRest });
  /** The write-tool equivalent of `registerGmailTool`, routed through the write registrar. */
  const registerGmailWriteTool = makeRestWriteToolRegistrar({ registerWriteTool, ...gmailRest });

  const gmailMessageListArgs = z.object({
    maxResults: z.number().int().min(1).max(100).optional(),
    pageToken: z.string().optional(),
    q: z.string().max(500).optional(),
    labelIds: z.array(z.string()).optional(),
    includeSpamTrash: z.boolean().optional(),
  });

  registerGmailTool(
    "gmail_message_list",
    "List Gmail message ids (metadata). Optional Gmail search query `q` (same syntax as Gmail UI).",
    gmailMessageListArgs,
    (data) => {
      const u = new URL(`${GMAIL_BASE}/messages`);
      u.searchParams.set("maxResults", String(data.maxResults ?? 25));
      if (data.pageToken !== undefined && data.pageToken !== "") {
        u.searchParams.set("pageToken", data.pageToken);
      }
      if (data.q !== undefined && data.q !== "") {
        u.searchParams.set("q", data.q);
      }
      if (data.labelIds !== undefined) {
        for (const lid of data.labelIds) {
          u.searchParams.append("labelIds", lid);
        }
      }
      if (data.includeSpamTrash === true) {
        u.searchParams.set("includeSpamTrash", "true");
      }
      return u.toString();
    },
  );

  const gmailMessageReadArgs = z.object({
    messageId: z.string().min(1),
    format: z.enum(["minimal", "full", "metadata", "raw"]).optional(),
  });

  registerGmailTool(
    "gmail_message_read",
    "Read a single Gmail message (format minimal | metadata | full | raw).",
    gmailMessageReadArgs,
    (data) => {
      const fmt = data.format ?? "metadata";
      const u = new URL(`${GMAIL_BASE}/messages/${encodeURIComponent(data.messageId)}`);
      u.searchParams.set("format", fmt);
      if (fmt === "metadata") {
        u.searchParams.append("metadataHeaders", "Subject");
        u.searchParams.append("metadataHeaders", "From");
        u.searchParams.append("metadataHeaders", "To");
        u.searchParams.append("metadataHeaders", "Date");
      }
      return u.toString();
    },
  );

  const gmailThreadReadArgs = z.object({
    threadId: z.string().min(1),
    format: z.enum(["minimal", "full", "metadata"]).optional(),
  });

  registerGmailTool(
    "gmail_thread_read",
    "Read a Gmail thread and its messages.",
    gmailThreadReadArgs,
    (data) => {
      const fmt = data.format ?? "metadata";
      const u = new URL(`${GMAIL_BASE}/threads/${encodeURIComponent(data.threadId)}`);
      u.searchParams.set("format", fmt);
      return u.toString();
    },
  );

  const gmailLabelListArgs = z.object({});

  registerGmailTool(
    "gmail_label_list",
    "List all Gmail labels.",
    gmailLabelListArgs,
    () => `${GMAIL_BASE}/labels`,
  );

  registerGmailWriteTool(
    "gmail_draft_create",
    {
      mutates: "gmail.draft.create",
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "recipient", value: p.to }),
    },
    "Create a Gmail draft. Requires Gateway HITL email.draft.create.",
    emailToolSchemas.sendArgs,
    () => `${GMAIL_BASE}/drafts`,
    (data) => jsonPost({ message: { raw: rawMessage(data) } }),
  );

  const gmailDraftSendArgs = z.object({
    draftId: z.string().min(1),
  });

  registerGmailWriteTool(
    "gmail_draft_send",
    {
      mutates: "gmail.draft.send",
      recoverable: false,
      capturePreState: (p) => Promise.resolve({ draftId: p.draftId }),
      scopeTargetOf: (p) => ({ kind: "draft", value: p.draftId }),
    },
    "Send an existing Gmail draft by id. Requires Gateway HITL email.draft.send.",
    gmailDraftSendArgs,
    () => `${GMAIL_BASE}/drafts/send`,
    (data) => jsonPost({ id: data.draftId }),
  );

  registerGmailWriteTool(
    "gmail_message_send",
    mailSendConsent("gmail.message.send"),
    "Send a new Gmail message (not a draft). Requires Gateway HITL email.send.",
    emailToolSchemas.sendArgs,
    () => `${GMAIL_BASE}/messages/send`,
    (data) => jsonPost({ raw: rawMessage(data) }),
  );
}
