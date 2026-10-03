import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  type StubReply,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import { registerGmailTools } from "../src/tools.ts";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

let tools: CapturedTools;
let http: FetchStub | undefined;

function serve(reply: StubReply = "{}"): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

/** Call `name` with the OAuth token set; return the one request it made. */
async function request(name: string, args: Record<string, unknown>) {
  const stub = serve();
  await withEnv({ GOOGLE_OAUTH_ACCESS_TOKEN: "ya29.gmail" }, async () => {
    await tools.call(name, args);
  });
  return stub.only;
}

/** The RFC 822 message a send or draft request carried, decoded from its base64url `raw`. */
function rfc822(raw: unknown): string {
  return Buffer.from(String(raw), "base64url").toString("utf-8");
}

beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("gateway");
  tools = captureTools(registerGmailTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
  resetConnectorModeForTests();
});

describe("gmail tools", () => {
  it("registers the read and write tools", () => {
    expect(tools.names()).toEqual([
      "gmail_draft_create",
      "gmail_draft_send",
      "gmail_label_list",
      "gmail_message_list",
      "gmail_message_read",
      "gmail_message_send",
      "gmail_thread_read",
    ]);
  });

  it("message_list asks for 25 ids by default, with the bearer token", async () => {
    const req = await request("gmail_message_list", {});
    expect(req.url).toBe(`${API}/messages?maxResults=25`);
    expect(req.headers["authorization"]).toBe("Bearer ya29.gmail");
  });

  it("message_list sends every filter it is given, each label id separately", async () => {
    const req = await request("gmail_message_list", {
      maxResults: 10,
      pageToken: "tok",
      q: "from:boss is:unread",
      labelIds: ["INBOX", "IMPORTANT"],
      includeSpamTrash: true,
    });
    const url = new URL(req.url);
    expect(`${url.origin}${url.pathname}`).toBe(`${API}/messages`);
    expect([...url.searchParams]).toEqual([
      ["maxResults", "10"],
      ["pageToken", "tok"],
      ["q", "from:boss is:unread"],
      ["labelIds", "INBOX"],
      ["labelIds", "IMPORTANT"],
      ["includeSpamTrash", "true"],
    ]);
  });

  it("message_list leaves out empty filters and a false includeSpamTrash", async () => {
    const req = await request("gmail_message_list", {
      pageToken: "",
      q: "",
      labelIds: [],
      includeSpamTrash: false,
    });
    expect(req.url).toBe(`${API}/messages?maxResults=25`);
  });

  it("message_read asks for metadata and its four headers by default", async () => {
    const req = await request("gmail_message_read", { messageId: "m/1" });
    expect(req.url).toBe(
      `${API}/messages/m%2F1?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date`,
    );
  });

  it("message_read asks for exactly the format requested otherwise", async () => {
    expect((await request("gmail_message_read", { messageId: "m1", format: "full" })).url).toBe(
      `${API}/messages/m1?format=full`,
    );
  });

  it("thread_read reads the thread in metadata form unless told otherwise", async () => {
    expect((await request("gmail_thread_read", { threadId: "t 1" })).url).toBe(
      `${API}/threads/t%201?format=metadata`,
    );
    expect((await request("gmail_thread_read", { threadId: "t1", format: "minimal" })).url).toBe(
      `${API}/threads/t1?format=minimal`,
    );
  });

  it("label_list lists the labels", async () => {
    expect((await request("gmail_label_list", {})).url).toBe(`${API}/labels`);
  });

  it("draft_create POSTs the message as a base64url RFC 822 draft", async () => {
    const req = await request("gmail_draft_create", {
      to: "you@example.test",
      subject: "Plan",
      body: "Hello",
      cc: "boss@example.test",
      bcc: "",
    });
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${API}/drafts`);
    expect(req.headers["content-type"]).toBe("application/json");
    const sent = JSON.parse(req.body ?? "null") as { message: { raw: string } };
    // An empty bcc is left out rather than sent as an empty header.
    expect(rfc822(sent.message.raw)).toBe(
      [
        "To: you@example.test",
        "Cc: boss@example.test",
        "Subject: Plan",
        "Content-Type: text/plain; charset=UTF-8",
        "",
        "Hello",
      ].join("\r\n"),
    );
  });

  it("message_send POSTs the raw message, a bcc included", async () => {
    const req = await request("gmail_message_send", {
      to: "you@example.test",
      subject: "Hi",
      body: "Body",
      bcc: "audit@example.test",
    });
    expect(req.url).toBe(`${API}/messages/send`);
    const sent = JSON.parse(req.body ?? "null") as { raw: string };
    expect(rfc822(sent.raw)).toBe(
      [
        "To: you@example.test",
        "Bcc: audit@example.test",
        "Subject: Hi",
        "Content-Type: text/plain; charset=UTF-8",
        "",
        "Body",
      ].join("\r\n"),
    );
  });

  it("draft_send sends an existing draft by id", async () => {
    const req = await request("gmail_draft_send", { draftId: "r-123" });
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${API}/drafts/send`);
    expect(JSON.parse(req.body ?? "null")).toEqual({ id: "r-123" });
  });

  it("quotes Gmail's status and at most 200 characters of its body on a failure", async () => {
    serve({ status: 403, body: `Insufficient Permission ${"x".repeat(300)}` });
    await withEnv({ GOOGLE_OAUTH_ACCESS_TOKEN: "t" }, async () => {
      const err = await tools.call("gmail_label_list", {}).then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(err?.message).toBe(
        `Gmail API 403: ${`Insufficient Permission ${"x".repeat(300)}`.slice(0, 200)}`,
      );
    });
  });

  it("refuses without GOOGLE_OAUTH_ACCESS_TOKEN, before any request", async () => {
    const stub = serve();
    await withEnv({ GOOGLE_OAUTH_ACCESS_TOKEN: undefined }, async () => {
      await expect(tools.call("gmail_message_list", {})).rejects.toThrow(
        "GOOGLE_OAUTH_ACCESS_TOKEN is not set",
      );
    });
    expect(stub.calls).toEqual([]);
  });
});
