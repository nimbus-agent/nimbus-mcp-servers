import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  type RecordedRequest,
  type StubReply,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import { DISCORD_TOOL_NAMES, registerDiscordTools } from "../src/tools.ts";

const API = "https://discord.com/api/v10";

let tools: CapturedTools;
let http: FetchStub | undefined;

function serve(reply: StubReply = "[]"): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

/** Call `name` with the bot token set; return the one request it made. */
async function request(name: string, args: Record<string, unknown>): Promise<RecordedRequest> {
  const stub = serve();
  await withEnv({ DISCORD_BOT_TOKEN: "bot-token" }, async () => {
    await tools.call(name, args);
  });
  return stub.only;
}

beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("gateway");
  tools = captureTools(registerDiscordTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
  resetConnectorModeForTests();
});

describe("discord tools", () => {
  it("registers the four read tools and the one write, in DISCORD_TOOL_NAMES order", () => {
    expect(tools.registrationOrder()).toEqual([...DISCORD_TOOL_NAMES]);
    expect(tools.names()).toEqual([
      "discord_channel_list",
      "discord_channel_messages",
      "discord_guild_list",
      "discord_message_post",
      "discord_thread_list",
    ]);
  });

  it("authenticates as a bot and identifies itself", async () => {
    const req = await request("discord_guild_list", {});
    expect(req.url).toBe(`${API}/users/@me/guilds`);
    expect(req.headers["authorization"]).toBe("Bot bot-token");
    expect(req.headers["user-agent"]).toStartWith("NimbusMCP (");
  });

  it("addresses a guild's channels and its active threads", async () => {
    expect((await request("discord_channel_list", { guildId: "g/1" })).url).toBe(
      `${API}/guilds/g%2F1/channels`,
    );
    expect((await request("discord_thread_list", { guildId: "g1" })).url).toBe(
      `${API}/guilds/g1/threads/active`,
    );
  });

  it("channel_messages asks for 50 messages once under the API base", async () => {
    expect((await request("discord_channel_messages", { channelId: "c1" })).url).toBe(
      `${API}/channels/c1/messages?limit=50`,
    );
  });

  it("channel_messages honours limit and an `after` snowflake, and drops an empty one", async () => {
    expect(
      (await request("discord_channel_messages", { channelId: "c 1", limit: 5, after: "123" })).url,
    ).toBe(`${API}/channels/c%201/messages?limit=5&after=123`);
    expect((await request("discord_channel_messages", { channelId: "c1", after: "" })).url).toBe(
      `${API}/channels/c1/messages?limit=50`,
    );
  });

  it("quotes Discord's status and body, and refuses without a bot token", async () => {
    serve({ status: 403, body: '{"message":"Missing Access"}' });
    await withEnv({ DISCORD_BOT_TOKEN: "t" }, async () => {
      await expect(tools.call("discord_channel_list", { guildId: "g1" })).rejects.toThrow(
        'Discord 403: {"message":"Missing Access"}',
      );
    });

    const stub = serve();
    await withEnv({ DISCORD_BOT_TOKEN: undefined }, async () => {
      await expect(tools.call("discord_guild_list", {})).rejects.toThrow(
        "DISCORD_BOT_TOKEN is not set",
      );
    });
    expect(stub.calls).toEqual([]);
  });
});

describe("discord_message_post", () => {
  const CHANNEL = "123456789012345678";

  async function post(args: Record<string, unknown>): Promise<RecordedRequest> {
    const stub = serve(
      '{"id":"998877665544332211","channel_id":"123456789012345678","content":"x"}',
    );
    await withEnv({ DISCORD_BOT_TOKEN: "bot-token" }, async () => {
      await tools.call("discord_message_post", args);
    });
    return stub.only;
  }

  it("POSTs JSON to the channel as the bot", async () => {
    const req = await post({ channelId: CHANNEL, content: "Deploy done" });
    expect(`${req.method} ${req.url}`).toBe(`POST ${API}/channels/${CHANNEL}/messages`);
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.headers["authorization"]).toBe("Bot bot-token");
    expect(req.headers["user-agent"]).toStartWith("NimbusMCP (");
  });

  it("allows user mentions only: allowed_mentions.parse is exactly [users]", async () => {
    // @everyone, @here and role pings are not in `parse`, so Discord renders them as plain text.
    const req = await post({ channelId: CHANNEL, content: "@everyone <@&555> <@42> hi" });
    const body = JSON.parse(req.body ?? "null") as {
      content: string;
      allowed_mentions: { parse: string[] };
    };
    expect(body).toEqual({
      content: "@everyone <@&555> <@42> hi",
      allowed_mentions: { parse: ["users"] },
    });
    expect(body.allowed_mentions.parse).toEqual(["users"]);
  });

  it("returns the new message's id and the channel", async () => {
    serve('{"id":"998877665544332211","channel_id":"123456789012345678","author":{"id":"1"}}');
    await withEnv({ DISCORD_BOT_TOKEN: "t" }, async () => {
      expect(
        await tools.callJson("discord_message_post", { channelId: CHANNEL, content: "hi" }),
      ).toEqual({ id: "998877665544332211", channelId: CHANNEL });
    });
  });

  it("throws Discord's status and body when the post is refused", async () => {
    serve({ status: 403, body: '{"message":"Missing Permissions"}' });
    await withEnv({ DISCORD_BOT_TOKEN: "t" }, async () => {
      await expect(
        tools.call("discord_message_post", { channelId: CHANNEL, content: "hi" }),
      ).rejects.toThrow('Discord 403: {"message":"Missing Permissions"}');
    });
  });

  it("refuses a bad channel id, or empty or oversized content, before any request", async () => {
    const stub = serve("{}");
    await withEnv({ DISCORD_BOT_TOKEN: "t" }, async () => {
      for (const args of [
        { channelId: "123", content: "x" },
        { channelId: "123456789012345678/../x", content: "x" },
        { channelId: "1234567890123456789012", content: "x" },
        { channelId: CHANNEL, content: "" },
        { channelId: CHANNEL, content: "x".repeat(2001) },
      ]) {
        await expect(tools.call("discord_message_post", args)).rejects.toThrow();
      }
    });
    expect(stub.calls).toEqual([]);
  });

  it("names the missing bot token and sends nothing", async () => {
    const stub = serve("{}");
    await withEnv({ DISCORD_BOT_TOKEN: undefined }, async () => {
      await expect(
        tools.call("discord_message_post", { channelId: CHANNEL, content: "hi" }),
      ).rejects.toThrow("DISCORD_BOT_TOKEN is not set");
    });
    expect(stub.calls).toEqual([]);
  });
});
