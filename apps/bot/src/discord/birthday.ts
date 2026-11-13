import type { BirthdayMembers, BirthdaySender } from "@dzajcarz/module-birthday";
import { type Client, RESTJSONErrorCodes } from "discord.js";
import { fetchOrNull, hasCode } from "./errors.ts";
import { NO_MENTIONS } from "./reply.ts";

/** Answers that will not change on a later try: the channel is gone, or the bot may not see or write there. */
const CHANNEL_GONE_CODES = [
  RESTJSONErrorCodes.UnknownChannel,
  RESTJSONErrorCodes.MissingAccess,
  RESTJSONErrorCodes.MissingPermissions,
];

/**
 * Sends birthday wishes. A server's post is the third place, after the welcome greeting and scheduled DMs,
 * that overrides NO_MENTIONS: it may ping the member whose birthday it is, and nobody else. The channel id
 * comes from an admin's `/birthday channel`, so it must belong to the guild the wish is for.
 */
export function createBirthdaySender(client: Client): BirthdaySender {
  return {
    async toChannel(guildId, channelId, text, memberId) {
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel?.isTextBased() || channel.isDMBased() || channel.guildId !== guildId) {
          return "gone";
        }
        await channel.send({ content: text, allowedMentions: { users: [memberId] } });
        return "sent";
      } catch (error) {
        if (hasCode(error, ...CHANNEL_GONE_CODES)) return "gone";
        throw error;
      }
    },

    async toUser(userId, text) {
      try {
        const user = await client.users.fetch(userId);
        await user.send({ content: text, allowedMentions: NO_MENTIONS });
        return "sent";
      } catch (error) {
        if (
          hasCode(
            error,
            RESTJSONErrorCodes.CannotSendMessagesToThisUser,
            RESTJSONErrorCodes.UnknownUser,
          )
        ) {
          return "closed";
        }
        throw error;
      }
    },
  };
}

export function createBirthdayMembers(client: Client): BirthdayMembers {
  return {
    async displayName(guildId, userId) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return null;
      try {
        const member = await fetchOrNull(guild.members.fetch(userId));
        return member && !member.user.bot ? member.displayName : null;
      } catch (error) {
        // A deleted account is never a member again.
        if (hasCode(error, RESTJSONErrorCodes.UnknownUser)) return null;
        throw error;
      }
    },

    async guildName(guildId) {
      return client.guilds.cache.get(guildId)?.name ?? null;
    },
  };
}
