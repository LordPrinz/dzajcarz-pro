import type { EveryoneAccess, PartyChannels, PartyPermissions } from "@dzajcarz/module-party";
import {
  type Channel,
  ChannelType,
  type Client,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
} from "discord.js";

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

    async createCategoryWithJoinChannel(guildId, categoryName, joinChannelName) {
      const guild = await guildOf(guildId);
      const category = await guild.channels.create({
        name: categoryName,
        type: ChannelType.GuildCategory,
        reason: "Party area",
      });
      try {
        const join = await guild.channels.create({
          name: joinChannelName,
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

    async areaNames(categoryId, joinChannelId) {
      const [category, join] = await Promise.all([
        client.channels.fetch(categoryId).catch(() => null),
        client.channels.fetch(joinChannelId).catch(() => null),
      ]);
      if (category?.type !== ChannelType.GuildCategory || join?.type !== ChannelType.GuildVoice) {
        return null;
      }
      return { categoryName: category.name, joinChannelName: join.name };
    },

    async renameArea(categoryId, joinChannelId, names) {
      const [category, join] = await Promise.all([
        client.channels.fetch(categoryId),
        client.channels.fetch(joinChannelId),
      ]);
      if (category?.type !== ChannelType.GuildCategory || join?.type !== ChannelType.GuildVoice) {
        throw new Error("Party area channels are missing");
      }
      // Discord limits renames per channel, so only touch names that actually changed.
      if (category.name !== names.categoryName) {
        await category.setName(names.categoryName, "Party area edited");
      }
      if (join.name !== names.joinChannelName) {
        await join.setName(names.joinChannelName, "Party area edited");
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
    async setEveryone(channelId, access, reason) {
      const channel = await voiceChannel(channelId);
      await channel.permissionOverwrites.edit(channel.guild.roles.everyone, bits(access), {
        reason,
      });
    },

    async inheritedEveryone(channelId) {
      const channel = await voiceChannel(channelId);
      const overwrite = channel.parent?.permissionOverwrites.cache.get(
        channel.guild.roles.everyone.id,
      );
      const state = (flag: bigint) =>
        overwrite?.deny.has(flag) ? false : overwrite?.allow.has(flag) ? true : null;
      return {
        connect: state(PermissionFlagsBits.Connect),
        view: state(PermissionFlagsBits.ViewChannel),
      };
    },

    async allowSelf(channelId, reason) {
      const channel = await voiceChannel(channelId);
      const me = channel.guild.members.me ?? (await channel.guild.members.fetchMe());
      await channel.permissionOverwrites.edit(
        me,
        { ViewChannel: true, Connect: true, ManageChannels: true, MoveMembers: true },
        { reason },
      );
    },

    async allowMember(channelId, userId, reason) {
      const channel = await voiceChannel(channelId);
      const member = await memberOf(channel.guildId, userId);
      await channel.permissionOverwrites.edit(
        member,
        { Connect: true, ViewChannel: true },
        { reason },
      );
    },

    async denyMember(channelId, userId, reason) {
      const channel = await voiceChannel(channelId);
      const member = await memberOf(channel.guildId, userId);
      await channel.permissionOverwrites.edit(
        member,
        { Connect: false, ViewChannel: false },
        { reason },
      );
    },

    async clearMember(channelId, userId, reason) {
      const channel = await voiceChannel(channelId);
      await channel.permissionOverwrites.delete(userId, reason);
    },

    async setLimit(channelId, limit, reason) {
      const channel = await voiceChannel(channelId);
      await channel.setUserLimit(limit, reason);
    },

    async rename(channelId, name, reason) {
      const channel = await voiceChannel(channelId);
      await channel.setName(name, reason);
    },

    async disconnect(guildId, userId, channelId, reason) {
      try {
        const member = await memberOf(guildId, userId);
        // The member may have moved on since the check; never pull them out of another channel.
        if (member.voice.channelId === channelId) await member.voice.disconnect(reason);
      } catch (error) {
        if (!hasCode(error, UNKNOWN_MEMBER)) throw error;
      }
    },

    async lookupMember(guildId, userId) {
      let member: Awaited<ReturnType<typeof memberOf>>;
      try {
        member = await memberOf(guildId, userId);
      } catch (error) {
        if (hasCode(error, UNKNOWN_MEMBER) || hasCode(error, RESTJSONErrorCodes.UnknownUser)) {
          return null;
        }
        throw error;
      }
      return {
        self: userId === client.user?.id,
        moderator: member.permissions.any([
          PermissionFlagsBits.Administrator,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.MoveMembers,
        ]),
      };
    },

    async canManage(guildId, userId, channelId) {
      const channel = await voiceChannel(channelId);
      const member = await memberOf(guildId, userId);
      return channel.permissionsFor(member).has(PermissionFlagsBits.ManageChannels);
    },
  };
}
