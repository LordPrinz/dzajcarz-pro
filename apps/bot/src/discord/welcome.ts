import type { GuildLookup, WelcomeSender } from "@dzajcarz/module-welcome";
import type { Client } from "discord.js";

/**
 * Posts welcome messages. Unlike every other reply the greeting may ping, but only the new member:
 * `users: [memberId]` still blocks @everyone, roles and any other user the template could contain.
 */
export function createWelcomeSender(client: Client): WelcomeSender {
  return {
    async send(channelId, text, memberId) {
      const channel = await client.channels.fetch(channelId);
      if (!channel?.isTextBased() || channel.isDMBased()) {
        throw new Error(`Channel ${channelId} is missing or not a guild text channel`);
      }
      await channel.send({ content: text, allowedMentions: { users: [memberId] } });
    },
  };
}

export function createGuildLookup(client: Client): GuildLookup {
  return {
    async describe(guildId) {
      const guild = await client.guilds.fetch(guildId).catch(() => null);
      return guild ? { name: guild.name, memberCount: guild.memberCount } : null;
    },
  };
}
