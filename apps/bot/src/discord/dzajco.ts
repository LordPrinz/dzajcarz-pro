import type { Logger } from "@dzajcarz/core";
import type { DzajcoResponder } from "@dzajcarz/module-dzajco";
import type { Client } from "discord.js";
import { NO_MENTIONS } from "./reply.ts";

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
      await message.reply({ content: gifUrl, allowedMentions: NO_MENTIONS });
    },
  };
}
