import type { GuildChannels } from "@dzajcarz/module-settings";
import type { Client } from "discord.js";
import { fetchOrNull } from "./errors.ts";

/** Answers from the client cache and falls back to a fetch; an unknown or foreign channel is false. */
export function createGuildChannels(client: Client): GuildChannels {
  return {
    async belongsTo(guildId, channelId) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return false;
      const channel = await fetchOrNull(guild.channels.fetch(channelId));
      return channel?.guildId === guildId;
    },
    async isThread(guildId, channelId) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return false;
      const channel = await fetchOrNull(guild.channels.fetch(channelId));
      return channel?.isThread() ?? false;
    },
  };
}

/** Reads the client cache only: the gate runs on every event and must not wait on Discord. */
export function createCategoryLookup(client: Client): (channelId: string) => string | null {
  return (channelId) => {
    const channel = client.channels.cache.get(channelId);
    return channel && "parentId" in channel ? channel.parentId : null;
  };
}
