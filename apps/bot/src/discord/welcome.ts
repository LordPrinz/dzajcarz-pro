import type { Logger } from "@dzajcarz/core";
import type { GuildLookup, TextChannels, WelcomeSender } from "@dzajcarz/module-welcome";
import { ChannelType, type Client } from "discord.js";

/**
 * Posts welcome messages. Unlike every other reply the greeting may ping, but only the new member:
 * `users: [memberId]` still blocks @everyone, roles and any other user the template could contain.
 * The channel id comes from a member's `/welcome set`, so it must belong to the guild being greeted.
 */
export function createWelcomeSender(client: Client): WelcomeSender {
  return {
    async send(guildId, channelId, text, memberId) {
      const channel = await client.channels.fetch(channelId);
      if (!channel?.isTextBased() || channel.isDMBased() || channel.guildId !== guildId) {
        throw new Error(`Channel ${channelId} is not a text channel of guild ${guildId}`);
      }
      await channel.send({ content: text, allowedMentions: { users: [memberId] } });
    },
  };
}

export function createTextChannels(client: Client): TextChannels {
  return {
    async isTextChannelOf(guildId, channelId) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return false;
      const channel = await guild.channels.fetch(channelId).catch(() => null);
      return (
        channel?.guildId === guildId &&
        (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement)
      );
    },
  };
}

export function createGuildLookup(client: Client, logger: Logger): GuildLookup {
  return {
    async describe(guildId) {
      try {
        const guild = await client.guilds.fetch(guildId);
        return { name: guild.name, memberCount: guild.memberCount };
      } catch (error) {
        logger.warn("Could not fetch the guild", { guildId, error });
        return null;
      }
    },
  };
}
