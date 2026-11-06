import {
  type EveryoneAccess,
  type PartyChannels,
  type PartyPermissions,
  RenameRateLimited,
} from "@dzajcarz/module-party";
import { type Channel, ChannelType, type Client, RESTJSONErrorCodes } from "discord.js";

const UNKNOWN_CHANNEL = RESTJSONErrorCodes.UnknownChannel;

function isUnknownChannel(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && error.code === UNKNOWN_CHANNEL
  );
}

const UNKNOWN_MEMBER = RESTJSONErrorCodes.UnknownMember;

function hasCode(error: unknown, code: number): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/** Channel edits (PATCH /channels/:id) are rejected instead of queued, so a spent rename limit does not stall the command for minutes. */
export function rejectChannelEditsOnRateLimit(rateLimit: { method: string; route: string }) {
  return rateLimit.method.toUpperCase() === "PATCH" && rateLimit.route === "/channels/:id";
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

    async voiceChannelOf(guildId, userId) {
      const guild = await guildOf(guildId);
      return guild.voiceStates.cache.get(userId)?.channelId ?? null;
    },
  };
}

export function createPartyPermissions(client: Client): PartyPermissions {
  async function voiceChannel(channelId: string) {
    const channel = await client.channels.fetch(channelId);
    if (channel?.type !== ChannelType.GuildVoice)
      throw new Error(`Not a voice channel: ${channelId}`);
    return channel;
  }

  const bits = (access: EveryoneAccess) => ({
    ...(access.connect !== undefined && { Connect: access.connect }),
    ...(access.view !== undefined && { ViewChannel: access.view }),
  });

  async function memberOf(guildId: string, userId: string) {
    const guild = await client.guilds.fetch(guildId);
    return guild.members.fetch(userId);
  }

  return {
    async setEveryone(channelId, access) {
      const channel = await voiceChannel(channelId);
      await channel.permissionOverwrites.edit(channel.guild.roles.everyone, bits(access), {
        reason: "Party channel controls",
      });
    },

    async allowMember(channelId, userId) {
      const channel = await voiceChannel(channelId);
      const member = await memberOf(channel.guildId, userId);
      await channel.permissionOverwrites.edit(
        member,
        { Connect: true, ViewChannel: true },
        { reason: "Party channel controls" },
      );
    },

    async denyMember(channelId, userId) {
      const channel = await voiceChannel(channelId);
      const member = await memberOf(channel.guildId, userId);
      await channel.permissionOverwrites.edit(
        member,
        { Connect: false, ViewChannel: false },
        { reason: "Party channel controls" },
      );
    },

    async clearMember(channelId, userId) {
      const channel = await voiceChannel(channelId);
      await channel.permissionOverwrites.delete(userId, "Party channel controls");
    },

    async setLimit(channelId, limit) {
      const channel = await voiceChannel(channelId);
      await channel.setUserLimit(limit, "Party channel controls");
    },

    async rename(channelId, name) {
      const channel = await voiceChannel(channelId);
      try {
        await channel.setName(name, "Party channel controls");
      } catch (error) {
        if (error instanceof Error && error.name === "RateLimitError")
          throw new RenameRateLimited();
        throw error;
      }
    },

    async disconnect(guildId, userId) {
      try {
        const member = await memberOf(guildId, userId);
        await member.voice.disconnect("Blocked from the party channel");
      } catch (error) {
        if (!hasCode(error, UNKNOWN_MEMBER)) throw error;
      }
    },

    async lookupMember(guildId, userId) {
      try {
        await memberOf(guildId, userId);
      } catch (error) {
        if (hasCode(error, UNKNOWN_MEMBER) || hasCode(error, RESTJSONErrorCodes.UnknownUser)) {
          return null;
        }
        throw error;
      }
      return { self: userId === client.user?.id };
    },
  };
}
