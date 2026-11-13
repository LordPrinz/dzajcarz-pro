import type { Logger } from "@dzajcarz/core";
import type { DzajcoChannels, DzajcoResponder } from "@dzajcarz/module-dzajco";
import type { Client } from "discord.js";
import { fetchOrNull } from "./errors.ts";
import { NO_MENTIONS } from "./reply.ts";

/** Any channel of the guild members write in: text, announcement, threads and voice or stage chats. */
export function createDzajcoChannels(client: Client): DzajcoChannels {
  return {
    parentOf(channelId) {
      const channel = client.channels.cache.get(channelId);
      return channel?.isThread() ? channel.parentId : null;
    },
    async isChatOf(guildId, channelId) {
      const channel = await fetchOrNull(client.channels.fetch(channelId));
      if (!channel?.isTextBased() || channel.isDMBased()) return false;
      return channel.guildId === guildId;
    },
  };
}

/** Reacts with an egg and replies with the gif. A missing Add Reactions permission only costs the egg. */
export function createDzajcoResponder(
  client: Client,
  logger: Logger,
  gifUrl: string,
): DzajcoResponder {
  return {
    async respond(channelId, messageId) {
      const channel = await client.channels.fetch(channelId);
      if (!channel?.isTextBased()) {
        throw new Error(`Channel ${channelId} is not text-based`);
      }
      const message = await channel.messages.fetch(messageId);
      try {
        await message.react("🥚");
      } catch (error) {
        logger.warn("Dżajco could not react", { channelId, messageId, error });
      }
      // The message may be deleted by now; the gif then goes out as a plain message.
      await message.reply({
        content: gifUrl,
        allowedMentions: NO_MENTIONS,
        failIfNotExists: false,
      });
    },
  };
}
