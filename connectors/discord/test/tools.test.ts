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
import { registerDiscordTools } from "../src/tools.ts";

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
  tools = captureTools(registerDiscordTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
});

describe("discord tools", () => {
  it("registers the four read tools", () => {
    expect(tools.names()).toEqual([
      "discord_channel_list",
      "discord_channel_messages",
      "discord_guild_list",
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
