import { UserError } from "@dzajcarz/core";
import { MAX_TIMEOUT_MS, type MemberInfo, type ModerationGuild } from "@dzajcarz/module-moderation";
import {
  type Client,
  type Guild,
  type GuildMember,
  RESTJSONErrorCodes,
  SnowflakeUtil,
} from "discord.js";
import { t } from "../messages.ts";
import { sendDirectMessage } from "./direct.ts";
import { hasCode } from "./errors.ts";
import { BULK_MAX_AGE_MS } from "./limits.ts";

/** Discord returns at most this many messages per request, and bulk delete takes as many. */
const MAX_FETCH = 100;

/**
 * Discord validates the timeout end against its own clock, so exactly 28 days from a host clock that runs
 * ahead is refused (50035). A minute less is invisible to the moderator and always accepted.
 */
const TIMEOUT_CEILING_MS = MAX_TIMEOUT_MS - 60_000;

/** The refusals a moderator can act on become UserErrors; anything else stays an error to log. */
function explain(error: unknown): never {
  if (hasCode(error, RESTJSONErrorCodes.MissingPermissions, RESTJSONErrorCodes.MissingAccess)) {
    throw new UserError((l) => t(l).botMissingPermissions);
  }
  if (hasCode(error, RESTJSONErrorCodes.UnknownMember)) {
    throw new UserError((l) => t(l).memberGone);
  }
  if (hasCode(error, RESTJSONErrorCodes.UnknownUser)) throw new UserError((l) => t(l).unknownUser);
  throw error;
}

function memberInfo(guild: Guild, member: GuildMember): MemberInfo {
  return {
    id: member.id,
    isOwner: member.id === guild.ownerId,
    topRole: member.roles.highest.position,
    permissions: member.permissions.bitfield,
    timedOut: member.isCommunicationDisabled(),
  };
}

/** Newest first, by id: a snowflake grows with time. */
function newestFirst(a: { id: string }, b: { id: string }): number {
  const left = BigInt(a.id);
  const right = BigInt(b.id);
  return left === right ? 0 : left > right ? -1 : 1;
}

export function createModerationGuild(
  client: Client,
  now: () => number = Date.now,
): ModerationGuild {
  const guildOf = (guildId: string) => client.guilds.fetch(guildId);

  async function memberOf(guildId: string, userId: string): Promise<GuildMember> {
    const guild = await guildOf(guildId);
    return guild.members.fetch(userId).catch(explain);
  }

  return {
    async member(guildId, userId) {
      const guild = await guildOf(guildId);
      try {
        return memberInfo(guild, await guild.members.fetch(userId));
      } catch (error) {
        if (hasCode(error, RESTJSONErrorCodes.UnknownMember, RESTJSONErrorCodes.UnknownUser)) {
          return null;
        }
        throw error;
      }
    },

    async self(guildId) {
      const guild = await guildOf(guildId);
      return memberInfo(guild, guild.members.me ?? (await guild.members.fetchMe()));
    },

    async guildName(guildId) {
      return (await guildOf(guildId)).name;
    },

    async ban(guildId, userId, auditReason) {
      const guild = await guildOf(guildId);
      await guild.bans.create(userId, { reason: auditReason }).catch(explain);
    },

    async kick(guildId, userId, auditReason) {
      const member = await memberOf(guildId, userId);
      await member.kick(auditReason).catch(explain);
    },

    async timeout(guildId, userId, durationMs, auditReason) {
      const member = await memberOf(guildId, userId);
      await member.timeout(Math.min(durationMs, TIMEOUT_CEILING_MS), auditReason).catch(explain);
    },

    async untimeout(guildId, userId, auditReason) {
      const member = await memberOf(guildId, userId);
      await member.timeout(null, auditReason).catch(explain);
    },

    async purge(channelId, count, beforeMessageId) {
      const channel = await client.channels.fetch(channelId);
      if (!channel?.isTextBased() || channel.isDMBased())
        throw new UserError((l) => t(l).notATextChannel);
      const firstPage = await channel.messages
        .fetch({
          limit: Math.min(MAX_FETCH, count),
          ...(beforeMessageId ? { before: beforeMessageId } : {}),
        })
        .catch(explain);
      const picked = [...firstPage.values()].sort(newestFirst).slice(0, count);
      // Pinned messages stay; one that is also old counts as pinned.
      const unpinned = picked.filter((message) => !message.pinned);
      const pinned = picked.length - unpinned.length;
      const cutoff = now() - BULK_MAX_AGE_MS;
      const recent = unpinned.filter((message) => SnowflakeUtil.timestampFrom(message.id) > cutoff);
      const tooOld = unpinned.length - recent.length;
      if (recent.length === 0) return { deleted: 0, tooOld, pinned };
      // bulkDelete handles a single message too; `true` makes Discord's own 14 day filter a second guard.
      const deleted = await channel
        .bulkDelete(
          recent.map((message) => message.id),
          true,
        )
        .catch(explain);
      return { deleted: deleted.size, tooOld, pinned };
    },

    sendDirect: (userId, text) => sendDirectMessage(client, userId, { content: text }),
  };
}
