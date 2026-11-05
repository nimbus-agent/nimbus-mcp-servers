import { z } from "zod";
import { type ConsentServer, createWriteToolRegistrar } from "../../../shared/consent-kit.ts";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult,
  requireProcessEnv,
} from "../../../shared/mcp-tool-kit.ts";
import {
  makeRestToolRegistrar,
  type RestFetchResult,
  toRestFetchResult,
} from "../../../shared/rest-tool-kit.ts";

const DISCORD_API = "https://discord.com/api/v10";

async function discordFetch(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<RestFetchResult> {
  const url = path.startsWith("http") ? path : `${DISCORD_API}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bot ${token}`,
      "User-Agent": "NimbusMCP (https://github.com/nimbus-dev/nimbus)",
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  return toRestFetchResult(res);
}

/** Tool names exposed by this connector — for contract/introspection tests. */
export const DISCORD_TOOL_NAMES = [
  "discord_guild_list",
  "discord_channel_list",
  "discord_channel_messages",
  "discord_thread_list",
  "discord_message_post",
] as const;

export function registerDiscordTools(
  server: ConsentServer & { tool: (...args: never) => unknown },
): void {
  const registerSimpleTool = createRegisterSimpleTool(server);
  const reg = createZodToolRegistrar(registerSimpleTool);

  /**
   * Every MUTATING discord tool goes through here. Outside the gateway this adds the consent gate,
   * the write-scope allow-list (`channel:<id>`), the mutation budget and the audit record; inside
   * the gateway it is a pass-through, because executor.ts (I2) is the gate there.
   */
  const registerWriteTool = createWriteToolRegistrar(server, {
    connector: "discord",
    scopeEnv: "NIMBUS_MCP_DISCORD_WRITE_SCOPE",
    scopeKinds: ["channel"],
  });

  /** Standard Discord read tool: token → discordFetch(buildPath) → mcpJsonResultIfOk("Discord"). */
  const registerDiscordTool = makeRestToolRegistrar({
    registrar: reg,
    tokenEnv: "DISCORD_BOT_TOKEN",
    serviceLabel: "Discord",
    fetch: discordFetch,
  });

  registerDiscordTool(
    "discord_guild_list",
    "List guilds the bot is a member of.",
    z.object({}),
    () => "/users/@me/guilds",
  );

  registerDiscordTool(
    "discord_channel_list",
    "List channels in a guild (id, type, name).",
    z.object({ guildId: z.string().min(1) }),
    (parsed) => `/guilds/${encodeURIComponent(parsed.guildId)}/channels`,
  );

  registerDiscordTool(
    "discord_channel_messages",
    "List recent messages in a channel (newest first). Optional `after` snowflake for incremental fetch.",
    z.object({
      channelId: z.string().min(1),
      limit: z.number().int().min(1).max(100).optional(),
      after: z.string().optional(),
    }),
    (parsed) => {
      const lim = parsed.limit ?? 50;
      const path = `/channels/${encodeURIComponent(parsed.channelId)}/messages`;
      const u = new URL(`${DISCORD_API}${path}`);
      u.searchParams.set("limit", String(lim));
      if (parsed.after !== undefined && parsed.after !== "") {
        u.searchParams.set("after", parsed.after);
      }
      // Relative to DISCORD_API, like every other tool here: the fetcher prefixes the base, which
      // already ends in /api/v10, so returning `u.pathname` requested /api/v10/api/v10/….
      return `${path}${u.search}`;
    },
  );

  registerDiscordTool(
    "discord_thread_list",
    "List active threads in a guild (includes public threads the bot can see).",
    z.object({ guildId: z.string().min(1) }),
    (parsed) => `/guilds/${encodeURIComponent(parsed.guildId)}/threads/active`,
  );

  registerWriteTool(
    "discord_message_post",
    {
      mutates: "discord.message.post",
      // A posted message is visible to the channel at once and cannot be unsent from here, but the
      // post is the whole effect and its id is returned, so it is not an unrecoverable data loss.
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "channel", value: p.channelId }),
    },
    "Post a message to a Discord channel AS THE BOT (not as the user). Only user mentions are active: @everyone, @here and role mentions are sent as plain text.",
    z.object({
      channelId: z.string().regex(/^\d{17,20}$/, "channelId is a Discord snowflake (17-20 digits)"),
      content: z.string().min(1).max(2000),
    }),
    async (parsed) => {
      const token = requireProcessEnv("DISCORD_BOT_TOKEN");
      const res = await discordFetch(token, `/channels/${parsed.channelId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: parsed.content,
          // Owner ruling: user mentions only. Without an explicit `parse` Discord resolves every
          // mention in the text, so a model-written "@everyone" would ping the whole guild.
          allowed_mentions: { parse: ["users"] },
        }),
      });
      if (!res.ok) {
        throw new Error(`Discord ${String(res.status)}: ${res.text.slice(0, 300)}`);
      }
      const created = res.json as { id?: unknown } | null;
      return mcpJsonResult({ id: created?.id, channelId: parsed.channelId });
    },
  );
}
