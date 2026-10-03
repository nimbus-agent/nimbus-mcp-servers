import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureStandaloneTools,
  captureTools,
  type FetchStub,
  type StandaloneCapture,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import { registerTeamsTools } from "../src/tools.ts";

const TOKEN = "MICROSOFT_OAUTH_ACCESS_TOKEN";

let tools: CapturedTools;
let fetchStub: FetchStub;

beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("gateway");
  process.env[TOKEN] = "graph-token";
  fetchStub = stubFetch('{"id":"m1"}');
  tools = captureTools(registerTeamsTools);
});

afterEach(() => {
  fetchStub.restore();
  delete process.env[TOKEN];
  resetConnectorModeForTests();
});

describe("teams message posts", () => {
  // The channel post and the chat post share one request builder; these pin the request each
  // makes — the collection it posts to, and the body Graph expects — for both content types.
  it("teams_message_post POSTs an html body to the channel's messages collection", async () => {
    const out = await tools.callJson("teams_message_post", {
      teamId: "team/1",
      channelId: "19:abc@thread.tacv2",
      body: "<b>hi</b>",
      contentType: "html",
    });
    expect(out).toEqual({ id: "m1" });
    const req = fetchStub.only;
    expect(req.method).toBe("POST");
    expect(req.url).toBe(
      "https://graph.microsoft.com/v1.0/teams/team%2F1/channels/19%3Aabc%40thread.tacv2/messages",
    );
    expect(req.headers["authorization"]).toBe("Bearer graph-token");
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.body).toBe('{"body":{"contentType":"html","content":"<b>hi</b>"}}');
  });

  it("teams_message_post_chat defaults to a text body on the chat's messages collection", async () => {
    await tools.call("teams_message_post_chat", { chatId: "19:chat@unq.gbl.spaces", body: "hi" });
    const req = fetchStub.only;
    expect(req.method).toBe("POST");
    expect(req.url).toBe(
      "https://graph.microsoft.com/v1.0/chats/19%3Achat%40unq.gbl.spaces/messages",
    );
    expect(req.headers["authorization"]).toBe("Bearer graph-token");
    expect(req.body).toBe('{"body":{"contentType":"text","content":"hi"}}');
  });

  it("refuses before sending when the Graph token is missing", async () => {
    delete process.env[TOKEN];
    await expect(
      tools.call("teams_message_post_chat", { chatId: "c1", body: "hi" }),
    ).rejects.toThrow(TOKEN);
    expect(fetchStub.calls).toEqual([]);
  });
});

describe("teams_message_post_chat is a gated write (standalone mode)", () => {
  /** Register in standalone mode for a client that can (or cannot) prompt, with chat:c1 in scope. */
  async function standalone(elicitation: boolean): Promise<StandaloneCapture> {
    resetConnectorModeForTests();
    setConnectorMode("standalone");
    let captured: StandaloneCapture | undefined;
    await withEnv(
      { NIMBUS_MCP_TEAMS_WRITE_SCOPE: "chat:c1", NIMBUS_MCP_AUDIT_LOG: undefined },
      () => {
        captured = captureStandaloneTools(registerTeamsTools, { elicitation });
      },
    );
    if (captured === undefined) throw new Error("registration did not run");
    return captured;
  }

  it("is not offered at all to a client that cannot prompt a human", async () => {
    const names = (await standalone(false)).tools.names();
    expect(names).not.toContain("teams_message_post_chat");
    expect(names).toContain("teams_team_list");
  });

  it("posts to an in-scope chat only after the human approved it", async () => {
    const { tools: gated, prompts } = await standalone(true);
    await gated.call("teams_message_post_chat", { chatId: "c1", body: "hi" });
    expect(fetchStub.calls).toHaveLength(1);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("teams.message.postChat");
  });

  it("refuses an out-of-scope chat without prompting or posting", async () => {
    const { tools: gated, prompts } = await standalone(true);
    expect(await gated.callJson("teams_message_post_chat", { chatId: "c2", body: "hi" })).toEqual({
      ok: false,
      error: "out of scope: chat:c2 is not in NIMBUS_MCP_TEAMS_WRITE_SCOPE",
    });
    expect(prompts).toEqual([]);
    expect(fetchStub.calls).toEqual([]);
  });
});

describe("teams paged reads", () => {
  const GRAPH = "https://graph.microsoft.com/v1.0";

  it("start from their first page, then follow a Graph nextLink exactly as given", async () => {
    const next = `${GRAPH}/me/joinedTeams?$top=50&$skiptoken=abc`;
    await tools.call("teams_team_list", {});
    await tools.call("teams_team_list", { nextLink: next });
    await tools.call("teams_channel_list", { teamId: "t/1", top: 5 });
    expect(fetchStub.calls.map((c) => c.url)).toEqual([
      `${GRAPH}/me/joinedTeams?$top=50`,
      next,
      `${GRAPH}/teams/t%2F1/channels?$top=5`,
    ]);
  });

  it("refuse a nextLink on another origin before sending the token anywhere", async () => {
    await expect(
      tools.call("teams_team_list", { nextLink: "https://evil.example.com/v1.0/me/joinedTeams" }),
    ).rejects.toThrow(
      "resolveUrlWithBase: refusing to fetch cross-origin URL (got https://evil.example.com, expected https://graph.microsoft.com)",
    );
    expect(fetchStub.calls).toEqual([]);
  });
});

describe("teams_chat_post through the Bot Framework (gateway mode)", () => {
  const BOT_TOKEN_URL = "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token";
  const BOT = { TEAMS_BOT_APP_ID: "app-id", TEAMS_BOT_APP_PASSWORD: "app-secret" };

  /** Answer the token endpoint with `token`, and every other request with an activity id. */
  function botServer(token: string): void {
    fetchStub.restore();
    fetchStub = stubFetch((req) => (req.url === BOT_TOKEN_URL ? token : '{"id":"act-1"}'));
  }

  it("exchanges the app credentials for a token, then posts a message activity", async () => {
    botServer('{"access_token":"bot-token"}');
    await withEnv({ ...BOT, TEAMS_BOT_SERVICE_URL: undefined }, async () => {
      expect(
        await tools.callJson("teams_chat_post", { conversationId: "a:1/2", text: "deployed" }),
      ).toEqual({ id: "act-1" });
    });
    const [exchange, post] = fetchStub.calls;
    expect(`${exchange?.method} ${exchange?.url}`).toBe(`POST ${BOT_TOKEN_URL}`);
    expect(Object.fromEntries(new URLSearchParams(exchange?.body ?? ""))).toEqual({
      grant_type: "client_credentials",
      client_id: "app-id",
      client_secret: "app-secret",
      scope: "https://api.botframework.com/.default",
    });
    expect(`${post?.method} ${post?.url}`).toBe(
      "POST https://smba.trafficmanager.net/teams/v3/conversations/a%3A1%2F2/activities",
    );
    expect(post?.headers["authorization"]).toBe("Bearer bot-token");
    expect(JSON.parse(post?.body ?? "null")).toEqual({ type: "message", text: "deployed" });
  });

  it("posts to the region's service URL, adding the trailing slash it lacks", async () => {
    botServer('{"access_token":"bot-token"}');
    await withEnv({ ...BOT, TEAMS_BOT_SERVICE_URL: "https://smba.example.com/emea" }, async () => {
      await tools.call("teams_chat_post", { conversationId: "c1", text: "hi" });
    });
    expect(fetchStub.calls[1]?.url).toBe(
      "https://smba.example.com/emea/v3/conversations/c1/activities",
    );
  });

  for (const [answer, error] of [
    ['"not-an-object"', "Bot Framework token: missing access_token"],
    ['{"token_type":"Bearer"}', "Bot Framework token: missing access_token"],
    ["<html>down</html>", "Bot Framework token: non-JSON response"],
  ] as const) {
    it(`refuses to post when the token endpoint answers ${answer}`, async () => {
      botServer(answer);
      await withEnv(BOT, async () => {
        await expect(
          tools.call("teams_chat_post", { conversationId: "c1", text: "hi" }),
        ).rejects.toThrow(error);
      });
      expect(fetchStub.calls.map((c) => c.url)).toEqual([BOT_TOKEN_URL]);
    });
  }

  it("quotes a refused credential exchange", async () => {
    fetchStub.restore();
    fetchStub = stubFetch({ status: 401, body: '{"error":"invalid_client"}' });
    await withEnv(BOT, async () => {
      await expect(
        tools.call("teams_chat_post", { conversationId: "c1", text: "hi" }),
      ).rejects.toThrow('Bot Framework token: {"error":"invalid_client"}');
    });
  });
});
