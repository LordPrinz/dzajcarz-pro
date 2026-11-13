import type { MessageChannels, ScheduledMessageSender } from "@dzajcarz/module-messages";
import { type Client, PermissionFlagsBits, RESTJSONErrorCodes } from "discord.js";
import { toComponentRows } from "./components.ts";
import { fetchOrNull, hasCode } from "./errors.ts";
import { NO_MENTIONS } from "./reply.ts";
import { createTextChannels } from "./welcome.ts";

/** The channel checks of `/messages add`: a text channel of the guild, and one the bot may post in. */
export function createMessageChannels(client: Client): MessageChannels {
  return {
    ...createTextChannels(client),
    async botCanPostIn(guildId, channelId) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return false;
      const channel = await fetchOrNull(guild.channels.fetch(channelId));
      const me = guild.members.me ?? (await fetchOrNull(guild.members.fetchMe()));
      if (!channel || !me) return false;
      return (
        channel
          .permissionsFor(me)
          ?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]) ?? false
      );
    },
  };
}

/**
 * Sends scheduled messages. A channel post never pings anyone. A DM is the second place, after the welcome
 * greeting, that overrides NO_MENTIONS: it may ping its recipient (`{user}`), and nobody else.
 */
export function createScheduledMessageSender(client: Client): ScheduledMessageSender {
  return {
    async toChannel(guildId, channelId, content) {
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel?.isTextBased() || channel.isDMBased() || channel.guildId !== guildId) {
          throw new Error(`Channel ${channelId} is not a text channel of guild ${guildId}`);
        }
        await channel.send({ content, allowedMentions: NO_MENTIONS });
        return "sent";
      } catch (error) {
        if (hasCode(error, RESTJSONErrorCodes.UnknownChannel)) return "gone";
        throw error;
      }
    },

    async toMember(guildId, userId, content, components) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) throw new Error(`The bot is not in guild ${guildId}`);
      const member = await guild.members.fetch(userId);
      try {
        await member.send({
          content,
          components: toComponentRows(components),
          allowedMentions: { users: [userId] },
        });
        return true;
      } catch (error) {
        if (hasCode(error, RESTJSONErrorCodes.CannotSendMessagesToThisUser)) return false;
        throw error;
      }
    },

    async memberStatus(guildId, userId) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return "absent";
      try {
        const member = await guild.members.fetch(userId);
        return member.user.bot ? "bot" : "member";
      } catch (error) {
        if (hasCode(error, RESTJSONErrorCodes.UnknownMember, RESTJSONErrorCodes.UnknownUser)) {
          return "absent";
        }
        throw error;
      }
    },

    async guildName(guildId) {
      return client.guilds.cache.get(guildId)?.name ?? null;
    },
  };
}
