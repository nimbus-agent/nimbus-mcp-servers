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
