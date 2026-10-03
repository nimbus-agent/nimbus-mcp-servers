import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureStandaloneTools,
  captureTools,
  type FetchStub,
  type RecordedRequest,
  type StubReply,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import { registerSlackTools, SLACK_TOOL_NAMES } from "../src/tools.ts";

const API = "https://slack.com/api";
const TOKENS = {
  SLACK_USER_ACCESS_TOKEN: "xoxp-user",
  SLACK_BOT_TOKEN: "xoxb-bot",
  SLACK_APP_TOKEN: "xapp-app",
};

let tools: CapturedTools;
let http: FetchStub | undefined;

function serve(reply: StubReply | ((req: RecordedRequest) => StubReply | undefined)): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

function body(req: RecordedRequest | undefined): unknown {
  return JSON.parse(req?.body ?? "null") as unknown;
}

/** Call `name` with every Slack token set, answering `{ ok: true }`; return the one request. */
async function request(name: string, args: Record<string, unknown>): Promise<RecordedRequest> {
  const stub = serve('{"ok":true}');
  await withEnv(TOKENS, async () => {
    await tools.call(name, args);
  });
  return stub.only;
}

beforeEach(() => {
  resetConnectorModeForTests();
});

afterEach(() => {
  http?.restore();
  http = undefined;
  resetConnectorModeForTests();
});

describe("slack tools (gateway mode)", () => {
  beforeEach(() => {
    setConnectorMode("gateway");
    tools = captureTools(registerSlackTools);
  });

  it("registers exactly SLACK_TOOL_NAMES, in order", () => {
    expect(tools.registrationOrder()).toEqual([...SLACK_TOOL_NAMES]);
  });

  it("channel_list POSTs JSON to conversations.list with the user token and defaults", async () => {
    const req = await request("slack_channel_list", {});
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${API}/conversations.list`);
    expect(req.headers["authorization"]).toBe("Bearer xoxp-user");
    expect(req.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(body(req)).toEqual({
      types: "public_channel,private_channel,mpim,im",
      limit: 200,
      exclude_archived: true,
    });
    expect(
      body(await request("slack_channel_list", { types: "im", limit: 5, cursor: "c" })),
    ).toEqual({ types: "im", limit: 5, exclude_archived: true, cursor: "c" });
  });

  it("channel_history and dm_history read conversations.history with every option", async () => {
    for (const name of ["slack_channel_history", "slack_dm_history"]) {
      const plain = await request(name, { channel: "C1" });
      expect(plain.url).toBe(`${API}/conversations.history`);
      expect(body(plain)).toEqual({ channel: "C1", limit: 50 });
      expect(
        body(
          await request(name, {
            channel: "C1",
            limit: 10,
            cursor: "next",
            oldest: "1700000000.000100",
            inclusive: false,
          }),
        ),
      ).toEqual({
        channel: "C1",
        limit: 10,
        cursor: "next",
        oldest: "1700000000.000100",
        inclusive: false,
      });
    }
  });

  it("thread_replies reads conversations.replies for the parent ts", async () => {
    const req = await request("slack_thread_replies", { channel: "C1", ts: "1.2", cursor: "n" });
    expect(req.url).toBe(`${API}/conversations.replies`);
    expect(body(req)).toEqual({ channel: "C1", ts: "1.2", limit: 50, cursor: "n" });
  });

  it("dm_list lists only im and mpim conversations", async () => {
    const req = await request("slack_dm_list", { limit: 20 });
    expect(req.url).toBe(`${API}/conversations.list`);
    expect(body(req)).toEqual({ types: "im,mpim", limit: 20, exclude_archived: true });
  });

  it("user_list pages users.list and user_get reads users.info", async () => {
    const list = await request("slack_user_list", { cursor: "u2" });
    expect(list.url).toBe(`${API}/users.list`);
    expect(body(list)).toEqual({ limit: 100, cursor: "u2" });

    const one = await request("slack_user_get", { user: "U1" });
    expect(one.url).toBe(`${API}/users.info`);
    expect(body(one)).toEqual({ user: "U1" });
  });

  it("search sends the query with paging, and sort options only when given", async () => {
    const plain = await request("slack_search", { query: "deploy" });
    expect(plain.url).toBe(`${API}/search.messages`);
    expect(body(plain)).toEqual({ query: "deploy", count: 20, page: 1 });
    expect(
      body(
        await request("slack_search", {
          query: "deploy",
          count: 5,
          page: 2,
          sort: "timestamp",
          sort_dir: "asc",
        }),
      ),
    ).toEqual({ query: "deploy", count: 5, page: 2, sort: "timestamp", sort_dir: "asc" });
  });

  it("message_post posts to the channel, threaded only when a thread ts is given", async () => {
    const req = await request("slack_message_post", { channel: "C1", text: "hi", thread_ts: "" });
    expect(req.url).toBe(`${API}/chat.postMessage`);
    expect(body(req)).toEqual({ channel: "C1", text: "hi" });
    expect(
      body(await request("slack_message_post", { channel: "C1", text: "hi", thread_ts: "1.2" })),
    ).toEqual({ channel: "C1", text: "hi", thread_ts: "1.2" });
  });

  it("message_post_dm opens the DM, then posts into the channel it returned", async () => {
    const stub = serve((req) =>
      req.url.endsWith("/conversations.open")
        ? '{"ok":true,"channel":{"id":"D42"}}'
        : '{"ok":true,"ts":"9.9"}',
    );
    let out: unknown;
    await withEnv(TOKENS, async () => {
      out = await tools.callJson("slack_message_post_dm", { user_ids: "U1,U2", text: "psst" });
    });
    expect(stub.calls.map((c) => c.url)).toEqual([
      `${API}/conversations.open`,
      `${API}/chat.postMessage`,
    ]);
    expect(body(stub.calls[0])).toEqual({ users: "U1,U2", return_im: true });
    expect(body(stub.calls[1])).toEqual({ channel: "D42", text: "psst" });
    expect(out).toEqual({
      open: { ok: true, channel: { id: "D42" } },
      post: { ok: true, ts: "9.9" },
    });
  });

  it("message_post_dm stops at a failed open, and at an open with no channel id", async () => {
    for (const [reply, message] of [
      ['{"ok":false,"error":"user_not_found"}', 'Slack conversations.open: {"ok":false'],
      ['{"ok":true,"channel":{}}', "Slack conversations.open: missing channel id"],
      ['{"ok":true,"channel":"D1"}', "Slack conversations.open: missing channel id"],
    ] as const) {
      const stub = serve(reply);
      await withEnv(TOKENS, async () => {
        await expect(
          tools.call("slack_message_post_dm", { user_ids: "U1", text: "x" }),
        ).rejects.toThrow(message);
      });
      // Nothing was posted.
      expect(stub.calls.map((c) => c.url)).toEqual([`${API}/conversations.open`]);
    }
  });

  it("message_post_dm reports a refused post", async () => {
    serve((req) =>
      req.url.endsWith("/conversations.open")
        ? '{"ok":true,"channel":{"id":"D42"}}'
        : '{"ok":false,"error":"is_archived"}',
    );
    await withEnv(TOKENS, async () => {
      await expect(
        tools.call("slack_message_post_dm", { user_ids: "U1", text: "x" }),
      ).rejects.toThrow('Slack chat.postMessage (dm): {"ok":false,"error":"is_archived"}');
    });
  });

  it("the ChatOps tools use the bot and app tokens, not the user token", async () => {
    const info = await request("slack_user_info", { user: "U1" });
    expect(info.url).toBe(`${API}/users.info`);
    expect(info.headers["authorization"]).toBe("Bearer xoxb-bot");

    const post = await request("slack_chat_post", { channel: "C1", text: "deployed" });
    expect(post.url).toBe(`${API}/chat.postMessage`);
    expect(post.headers["authorization"]).toBe("Bearer xoxb-bot");
    expect(body(post)).toEqual({ channel: "C1", text: "deployed" });

    const socket = await request("slack_socket_open", {});
    expect(socket.url).toBe(`${API}/apps.connections.open`);
    expect(socket.headers["authorization"]).toBe("Bearer xapp-app");
    expect(body(socket)).toEqual({});
  });

  it("an ok:false answer, a non-JSON answer and an HTTP error all throw with the body", async () => {
    for (const [reply, message] of [
      ['{"ok":false,"error":"channel_not_found"}', 'Slack conversations.history: {"ok":false'],
      ["<html>rate limited</html>", "Slack conversations.history: <html>rate limited</html>"],
      // JSON that is not an object has no `ok: true` to find, so it is a failure too — `null`
      // included, which must be reported like the rest rather than throw while being read.
      ['["ok",true]', 'Slack conversations.history: ["ok",true]'],
      ["null", "Slack conversations.history: null"],
      [{ status: 500, body: '{"ok":true}' }, 'Slack conversations.history: {"ok":true}'],
    ] as const) {
      serve(reply);
      await withEnv(TOKENS, async () => {
        await expect(tools.call("slack_channel_history", { channel: "C1" })).rejects.toThrow(
          message,
        );
      });
    }
  });

  it("each token is required by the tools that use it, before any request", async () => {
    const stub = serve('{"ok":true}');
    for (const [name, args, env] of [
      ["slack_channel_list", {}, "SLACK_USER_ACCESS_TOKEN"],
      ["slack_chat_post", { channel: "C", text: "t" }, "SLACK_BOT_TOKEN"],
      ["slack_socket_open", {}, "SLACK_APP_TOKEN"],
    ] as const) {
      await withEnv({ ...TOKENS, [env]: undefined }, async () => {
        await expect(tools.call(name, args)).rejects.toThrow(`${env} is not set`);
      });
    }
    expect(stub.calls).toEqual([]);
  });
});

describe("slack_message_post_dm is a gated write (standalone mode)", () => {
  beforeEach(() => {
    setConnectorMode("standalone");
  });

  /** Register for a client that can (or cannot) prompt, with only user:U1 in scope. */
  async function standalone(
    elicitation: boolean,
    answer?: { action: "accept" | "decline" },
  ): Promise<{ tools: CapturedTools; prompts: string[] }> {
    let captured: { tools: CapturedTools; prompts: string[] } | undefined;
    await withEnv(
      { NIMBUS_MCP_SLACK_WRITE_SCOPE: "user:U1", NIMBUS_MCP_AUDIT_LOG: undefined },
      () => {
        captured = captureStandaloneTools(registerSlackTools, {
          elicitation,
          ...(answer === undefined ? {} : { answer }),
        });
      },
    );
    if (captured === undefined) throw new Error("registration did not run");
    return captured;
  }

  it("is not offered at all to a client that cannot prompt a human", async () => {
    const { tools: offered } = await standalone(false);
    expect(offered.names()).not.toContain("slack_message_post_dm");
    expect(offered.names()).not.toContain("slack_message_post");
    expect(offered.names()).toContain("slack_channel_list");
  });

  it("sends to an in-scope recipient only after the human approved the exact action", async () => {
    const { tools: gated, prompts } = await standalone(true);
    const stub = serve((req) =>
      req.url.endsWith("/conversations.open") ? '{"ok":true,"channel":{"id":"D1"}}' : '{"ok":true}',
    );
    await withEnv(TOKENS, async () => {
      await gated.call("slack_message_post_dm", { user_ids: "U1", text: "hello" });
    });
    expect(stub.calls).toHaveLength(2);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("slack.message.post");
    expect(prompts[0]).toContain('"text": "hello"');
  });

  it("refuses an out-of-scope recipient without prompting or sending", async () => {
    const { tools: gated, prompts } = await standalone(true);
    const stub = serve('{"ok":true}');
    await withEnv(TOKENS, async () => {
      expect(await gated.callJson("slack_message_post_dm", { user_ids: "U9", text: "x" })).toEqual({
        ok: false,
        error: "out of scope: user:U9 is not in NIMBUS_MCP_SLACK_WRITE_SCOPE",
      });
    });
    expect(prompts).toEqual([]);
    expect(stub.calls).toEqual([]);
  });

  it("sends nothing when the human declines", async () => {
    const { tools: gated } = await standalone(true, { action: "decline" });
    const stub = serve('{"ok":true}');
    await withEnv(TOKENS, async () => {
      expect(await gated.callJson("slack_message_post_dm", { user_ids: "U1", text: "x" })).toEqual({
        ok: false,
        error: "not approved: the operation was declined, cancelled, or timed out",
      });
    });
    expect(stub.calls).toEqual([]);
  });
});
