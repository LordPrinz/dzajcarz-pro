import type { PanelMessages, VoiceChannels } from "@dzajcarz/module-music";
import { type Client, RESTJSONErrorCodes } from "discord.js";
import { NO_MENTIONS, toReplyPayload } from "./reply.ts";

/** Voice states come from the gateway cache (GuildVoiceStates intent), so no REST call is made. */
export function createVoiceChannels(client: Client): VoiceChannels {
  return {
    async channelOf(guildId, userId) {
      return client.guilds.cache.get(guildId)?.voiceStates.cache.get(userId)?.channelId ?? null;
    },
    async humanCount(guildId, channelId) {
      const channel = client.guilds.cache.get(guildId)?.channels.cache.get(channelId);
      if (!channel?.isVoiceBased()) return 0;
      return channel.members.filter((member) => !member.user.bot).size;
    },
  };
}

function isUnknown(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return (
    error.code === RESTJSONErrorCodes.UnknownMessage ||
    error.code === RESTJSONErrorCodes.UnknownChannel
  );
}

export function createPanelMessages(client: Client): PanelMessages {
  async function channelOf(channelId: string) {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isSendable()) throw new Error(`Cannot send to ${channelId}`);
    return channel;
  }

  return {
    async post(channelId, message) {
      const { content, embeds, components } = toReplyPayload(message);
      const channel = await channelOf(channelId);
      const sent = await channel.send({
        content,
        embeds,
        components,
        allowedMentions: NO_MENTIONS,
      });
      return sent.id;
    },

    async edit(channelId, messageId, message) {
      const { content, embeds, components } = toReplyPayload(message);
      try {
        const channel = await channelOf(channelId);
        await channel.messages.edit(messageId, {
          content: content ?? null,
          embeds,
          components,
          allowedMentions: NO_MENTIONS,
        });
        return "edited";
      } catch (error) {
        if (isUnknown(error)) return "gone";
        throw error;
      }
    },

    async delete(channelId, messageId) {
      try {
        const channel = await channelOf(channelId);
        await channel.messages.delete(messageId);
      } catch (error) {
        if (!isUnknown(error)) throw error;
      }
    },
  };
}
