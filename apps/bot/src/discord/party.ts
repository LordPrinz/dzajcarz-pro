import type {
  EveryoneAccess,
  PartyChannels,
  PartyChat,
  PartyGuild,
  PartyInvites,
  PartyPermissions,
} from "@dzajcarz/module-party";
import {
  type Channel,
  ChannelType,
  type Client,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
} from "discord.js";
import { downloadDiscordFile } from "./download.ts";
import { hasCode } from "./errors.ts";
import { NO_MENTIONS, toReplyPayload } from "./reply.ts";

const UNKNOWN_CHANNEL = RESTJSONErrorCodes.UnknownChannel;

const isUnknownChannel = (error: unknown) => hasCode(error, UNKNOWN_CHANNEL);

const UNKNOWN_MEMBER = RESTJSONErrorCodes.UnknownMember;

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
      // REST still returns channels of an unavailable guild, but its voice states are empty until it comes back.
      if (!channel.guild.available) return undefined;
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

    async isBlocked(channelId, userId) {
      const channel = await voiceChannel(channelId);
      return (
        channel.permissionOverwrites.cache.get(userId)?.deny.has(PermissionFlagsBits.Connect) ??
        false
      );
    },

    async setLimit(channelId, limit, reason) {
      const channel = await voiceChannel(channelId);
      await channel.setUserLimit(limit, reason);
    },

    async rename(channelId, name, reason) {
      const channel = await voiceChannel(channelId);
      await channel.setName(name, reason);
    },

    async channelName(channelId) {
      return (await voiceChannel(channelId)).name;
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
        bot: member.user.bot,
      };
    },

    async canManage(guildId, userId, channelId) {
      const channel = await voiceChannel(channelId);
      const member = await memberOf(guildId, userId);
      return channel.permissionsFor(member).has(PermissionFlagsBits.ManageChannels);
    },
  };
}

export function createPartyGuild(client: Client): PartyGuild {
  return {
    async memberPermissions(guildId, userId) {
      const guild = await client.guilds.fetch(guildId);
      try {
        // The member's own guild-level bits: unlike `permissionsIn(channel)`, no overwrite is mixed in.
        return (await guild.members.fetch(userId)).permissions.bitfield;
      } catch (error) {
        if (hasCode(error, UNKNOWN_MEMBER)) return 0n;
        throw error;
      }
    },
  };
}

export function createPartyInvites(client: Client, fetchFile: typeof fetch = fetch): PartyInvites {
  return {
    async describe(channelId, inviterId) {
      const channel = await client.channels.fetch(channelId);
      if (channel?.type !== ChannelType.GuildVoice)
        throw new Error(`Not a voice channel: ${channelId}`);
      const inviter = await client.users.fetch(inviterId);
      return {
        channelName: channel.name,
        guildName: channel.guild.name,
        inviterUsername: inviter.username,
        inviterAvatarUrl: inviter.displayAvatarURL({ extension: "png", size: 128 }),
      };
    },

    downloadFile: (url, maxBytes) => downloadDiscordFile(url, maxBytes, fetchFile),

    async sendDirect(userId, message) {
      const { content, embeds, files, components } = toReplyPayload(message);
      try {
        const user = await client.users.fetch(userId);
        await user.send({ content, embeds, files, components, allowedMentions: NO_MENTIONS });
        return true;
      } catch (error) {
        if (hasCode(error, RESTJSONErrorCodes.CannotSendMessagesToThisUser)) return false;
        throw error;
      }
    },
  };
}

const UNKNOWN_MESSAGE = RESTJSONErrorCodes.UnknownMessage;
/** Discord refuses to delete some system messages (joins, pins, boosts). */
const SYSTEM_MESSAGE = RESTJSONErrorCodes.CannotExecuteActionOnSystemMessage;
/** Bulk delete rejects a batch that holds a message older than two weeks. */
const BULK_TOO_OLD = RESTJSONErrorCodes.OneOfTheMessagesProvidedWasTooOldForBulkDelete;
/** Discord returns at most this many messages per request. */
const HISTORY_PAGE = 100;
const BULK_MAX = 100;
const DISCORD_EPOCH_MS = 1_420_070_400_000;
/** Bulk delete works up to 14 days; stay a minute inside so a message does not age out in flight. */
const BULK_MAX_AGE_MS = 14 * 24 * 3_600_000 - 60_000;

function createdAt(snowflake: string): number {
  return Number(BigInt(snowflake) >> 22n) + DISCORD_EPOCH_MS;
}

export function createPartyChat(client: Client, now: () => number = Date.now): PartyChat {
  /** The text chat of a voice channel. */
  async function chatOf(channelId: string) {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) throw new Error(`Not a text chat: ${channelId}`);
    return channel;
  }

  return {
    async post(channelId, message) {
      const { content, embeds, components } = toReplyPayload(message);
      const channel = await chatOf(channelId);
      if (!("send" in channel)) throw new Error(`Cannot send to ${channelId}`);
      const sent = await channel.send({
        content,
        embeds,
        components,
        allowedMentions: NO_MENTIONS,
      });
      return sent.id;
    },

    async exists(channelId, messageId) {
      const channel = await chatOf(channelId);
      try {
        await channel.messages.fetch({ message: messageId, force: true });
        return true;
      } catch (error) {
        if (hasCode(error, UNKNOWN_MESSAGE)) return false;
        throw error;
      }
    },

    async recentMessages(channelId) {
      const channel = await chatOf(channelId);
      const messages = await channel.messages.fetch({ limit: HISTORY_PAGE });
      return [...messages.values()].map((message) => ({
        id: message.id,
        pinned: message.pinned,
        system: message.system,
      }));
    },

    async deleteMessages(channelId, messageIds) {
      const channel = await chatOf(channelId);
      // Bulk delete only takes messages under 14 days old, and only pays off for two or more.
      const cutoff = now() - BULK_MAX_AGE_MS;
      const recent = messageIds.filter((id) => createdAt(id) > cutoff);
      const single = new Set(messageIds.filter((id) => !recent.includes(id)));
      const canBulk = "bulkDelete" in channel;

      for (let start = 0; start < recent.length; start += BULK_MAX) {
        const batch = recent.slice(start, start + BULK_MAX);
        if (!canBulk || batch.length < 2) {
          for (const id of batch) single.add(id);
          continue;
        }
        try {
          await channel.bulkDelete(batch, false);
        } catch (error) {
          // Rejected as a whole (a message vanished, is a system message or aged out): nothing was
          // deleted, so one by one is safe and each delete tolerates what the batch could not.
          if (
            !hasCode(error, UNKNOWN_MESSAGE) &&
            !hasCode(error, SYSTEM_MESSAGE) &&
            !hasCode(error, BULK_TOO_OLD)
          ) {
            throw error;
          }
          for (const id of batch) single.add(id);
        }
      }

      for (const id of single) {
        try {
          await channel.messages.delete(id);
        } catch (error) {
          // Already gone, or a system message Discord does not let anyone delete: nothing left to do.
          if (!hasCode(error, UNKNOWN_MESSAGE) && !hasCode(error, SYSTEM_MESSAGE)) throw error;
        }
      }
    },
  };
}
