import type { GuildChannels } from "@dzajcarz/module-settings";
import type { Client } from "discord.js";

/** Answers from the client cache and falls back to a fetch; an unknown or foreign channel is false. */
export function createGuildChannels(client: Client): GuildChannels {
  return {
    async belongsTo(guildId, channelId) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return false;
      const channel = await guild.channels.fetch(channelId).catch(() => null);
      return channel?.guildId === guildId;
    },
  };
}
