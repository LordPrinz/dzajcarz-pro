import { UserError } from "@dzajcarz/core";
import { MAX_TIMEOUT_MS, type MemberInfo, type ModerationGuild } from "@dzajcarz/module-moderation";
import {
  type Client,
  type Guild,
  type GuildMember,
  RESTJSONErrorCodes,
  SnowflakeUtil,
} from "discord.js";
import { hasCode } from "./errors.ts";
import { NO_MENTIONS } from "./reply.ts";

export const BOT_MISSING_PERMISSIONS =
  "Nie mam uprawnień, żeby to zrobić. Sprawdź moje uprawnienia i czy moja rola jest wyżej.";
export const MEMBER_GONE = "Tej osoby nie ma na serwerze.";
export const UNKNOWN_USER = "Nie ma takiego użytkownika.";
export const NOT_A_TEXT_CHANNEL = "Tu nie mogę usuwać wiadomości.";

/** Discord returns at most this many messages per request, and bulk delete takes as many. */
const MAX_FETCH = 100;
/** Bulk delete works up to 14 days; stay a minute inside so a message does not age out in flight. */
const BULK_MAX_AGE_MS = 14 * 24 * 3_600_000 - 60_000;

/**
 * Discord validates the timeout end against its own clock, so exactly 28 days from a host clock that runs
 * ahead is refused (50035). A minute less is invisible to the moderator and always accepted.
 */
const TIMEOUT_CEILING_MS = MAX_TIMEOUT_MS - 60_000;

/** The refusals a moderator can act on become UserErrors; anything else stays an error to log. */
function explain(error: unknown): never {
  if (
    hasCode(error, RESTJSONErrorCodes.MissingPermissions) ||
    hasCode(error, RESTJSONErrorCodes.MissingAccess)
  ) {
    throw new UserError(BOT_MISSING_PERMISSIONS);
  }
  if (hasCode(error, RESTJSONErrorCodes.UnknownMember)) throw new UserError(MEMBER_GONE);
  if (hasCode(error, RESTJSONErrorCodes.UnknownUser)) throw new UserError(UNKNOWN_USER);
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
        if (
          hasCode(error, RESTJSONErrorCodes.UnknownMember) ||
          hasCode(error, RESTJSONErrorCodes.UnknownUser)
        ) {
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
      if (!channel?.isTextBased() || channel.isDMBased()) throw new UserError(NOT_A_TEXT_CHANNEL);
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

    async sendDirect(userId, text) {
      try {
        const user = await client.users.fetch(userId);
        await user.send({ content: text, allowedMentions: NO_MENTIONS });
        return true;
      } catch (error) {
        if (hasCode(error, RESTJSONErrorCodes.CannotSendMessagesToThisUser)) return false;
        throw error;
      }
    },
  };
}
