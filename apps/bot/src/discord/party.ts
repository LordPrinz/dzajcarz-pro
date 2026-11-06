import type { PartyChannels } from "@dzajcarz/module-party";
import { type Channel, ChannelType, type Client, RESTJSONErrorCodes } from "discord.js";

const UNKNOWN_CHANNEL = RESTJSONErrorCodes.UnknownChannel;

function isUnknownChannel(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && error.code === UNKNOWN_CHANNEL
  );
}

export function createPartyChannels(client: Client): PartyChannels {
  /** The voice channel, or null when it was deleted. */
  async function fetchVoice(channelId: string) {
    let channel: Channel | null;
    try {
      channel = await client.channels.fetch(channelId);
    } catch (error) {
      if (isUnknownChannel(error)) return null;
      throw error;
    }
    return channel?.type === ChannelType.GuildVoice ? channel : null;
  }

  const guildOf = (guildId: string) => client.guilds.fetch(guildId);

  return {
    async createVoiceChannel(guildId, categoryId, name, ownerId) {
      const guild = await guildOf(guildId);
      const channel = await guild.channels.create({
        name,
        type: ChannelType.GuildVoice,
        parent: categoryId,
        reason: `Party channel for member ${ownerId}`,
      });
      return channel.id;
    },

    async moveMember(guildId, userId, channelId) {
      const guild = await guildOf(guildId);
      const member = await guild.members.fetch(userId);
      await member.voice.setChannel(channelId, "Party channel");
    },

    async deleteChannel(channelId) {
      try {
        const channel = await client.channels.fetch(channelId);
        if (channel && "delete" in channel) await channel.delete("Party channel cleanup");
      } catch (error) {
        if (!isUnknownChannel(error)) throw error;
      }
    },

    async members(channelId) {
      const channel = await fetchVoice(channelId);
      if (!channel) return null;
      return channel.members.filter((member) => !member.user.bot).map((member) => member.id);
    },

    async exists(channelId) {
      try {
        return (await client.channels.fetch(channelId)) !== null;
      } catch (error) {
        if (isUnknownChannel(error)) return false;
        throw error;
      }
    },

    async createCategoryWithJoinChannel(guildId, categoryName) {
      const guild = await guildOf(guildId);
      const category = await guild.channels.create({
        name: categoryName,
        type: ChannelType.GuildCategory,
        reason: "Party area",
      });
      try {
        const join = await guild.channels.create({
          name: "➕ Dołącz, by stworzyć kanał",
          type: ChannelType.GuildVoice,
          parent: category.id,
          reason: "Party area",
        });
        return { categoryId: category.id, joinChannelId: join.id };
      } catch (error) {
        await category.delete("Party area setup failed").catch(() => {});
        throw error;
      }
    },
  };
}
