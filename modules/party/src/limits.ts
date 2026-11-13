import { UserError } from "@dzajcarz/core";
import { MAX_RENAMES, SPECIAL_OWNER_PER_HOUR, SPECIAL_OWNER_PER_MINUTE } from "./constants.ts";
import { t } from "./messages.ts";
import type { PartyModuleDeps, SkipReason } from "./types.ts";

const renameKey = (channelId: string) => `party-rename:${channelId}`;
const recipientKey = (guildId: string, userId: string) => `party-special-to:${guildId}:${userId}`;
const RENAME_WINDOW_MS = 600_000;
/** Owner controls per member: every one is a Discord call, so a flood is cut off here. */
const MAX_CONTROLS = 10;
const CONTROL_WINDOW_MS = 60_000;
/** Each special invite is a DM to up to ten people: per owner 1 a minute and 5 an hour, and per recipient 3 an hour. */
const SPECIAL_MINUTE_MS = 60_000;
const SPECIAL_HOUR_MS = 3_600_000;
const SPECIAL_RECIPIENT_PER_HOUR = 3;
/** A member may cause this many new channels per window; more joins are ignored (channel create/delete spam). */
const MAX_CREATIONS = 3;
const CREATION_WINDOW_MS = 60_000;

export function createLimits({ lock, logger }: PartyModuleDeps) {
  /** The value of a limit counter without counting; Redis down refuses, as the invites cannot be limited. */
  async function specialCount(key: string): Promise<number> {
    try {
      return Number(await lock.get(key)) || 0;
    } catch (error) {
      logger.warn("Party special invite limit unavailable", { key, error });
      throw new UserError((l) => t(l).specialUnavailable);
    }
  }

  /** Counts one use of a limit; Redis down refuses. */
  async function specialIncrement(key: string, windowMs: number): Promise<number> {
    try {
      return (await lock.increment(key, windowMs)).count;
    } catch (error) {
      logger.warn("Party special invite limit unavailable", { key, error });
      throw new UserError((l) => t(l).specialUnavailable);
    }
  }

  /** Counts a special invite against the owner's limits (1 a minute, 5 an hour). */
  async function takeSpecialAllowance(guildId: string, userId: string): Promise<void> {
    const minute = await specialIncrement(
      `party-special:min:${guildId}:${userId}`,
      SPECIAL_MINUTE_MS,
    );
    if (minute > SPECIAL_OWNER_PER_MINUTE) throw new UserError((l) => t(l).specialMinute);
    const hour = await specialIncrement(`party-special:hour:${guildId}:${userId}`, SPECIAL_HOUR_MS);
    if (hour > SPECIAL_OWNER_PER_HOUR)
      throw new UserError((l) => t(l).specialHour(SPECIAL_OWNER_PER_HOUR));
  }

  /** A reason to skip someone who already got 3 invites in the last hour. Only delivered invites count (see countRecipient). */
  async function recipientLimitReached(
    guildId: string,
    userId: string,
  ): Promise<SkipReason | null> {
    try {
      const sent = Number(await lock.get(recipientKey(guildId, userId))) || 0;
      return sent >= SPECIAL_RECIPIENT_PER_HOUR ? "skipRecipientLimit" : null;
    } catch (error) {
      logger.warn("Party special invite recipient limit unavailable", { guildId, userId, error });
      return "skipLimitUnchecked";
    }
  }

  /** Counts a delivered invite, so one that failed does not use up the recipient's limit. */
  async function countRecipient(guildId: string, userId: string): Promise<void> {
    await lock.increment(recipientKey(guildId, userId), SPECIAL_HOUR_MS).catch((error: unknown) => {
      logger.warn("Party special invite recipient limit unavailable", { guildId, userId, error });
    });
  }

  /** Counts a control command; fails open when Redis is down. */
  async function enforceControlCooldown(guildId: string, userId: string): Promise<void> {
    let count: number;
    try {
      ({ count } = await lock.increment(`party-ctl:${guildId}:${userId}`, CONTROL_WINDOW_MS));
    } catch (error) {
      logger.warn("Party control cooldown unavailable", { guildId, userId, error });
      return;
    }
    if (count > MAX_CONTROLS) {
      throw new UserError((l) => t(l).tooManyChanges);
    }
  }

  /** Whether the channel used up its renames; fails open when Redis is down. */
  async function renameLimitReached(channelId: string): Promise<boolean> {
    try {
      return (Number(await lock.get(renameKey(channelId))) || 0) >= MAX_RENAMES;
    } catch (error) {
      logger.warn("Party rename counter unavailable", { channelId, error });
      return false;
    }
  }

  /** Counts a rename that went through, so one Discord refused does not use up the limit. */
  async function countRename(channelId: string): Promise<void> {
    await lock.increment(renameKey(channelId), RENAME_WINDOW_MS).catch((error: unknown) => {
      logger.warn("Party rename counter unavailable", { channelId, error });
    });
  }

  /** Counts a creation; fails open when Redis is down. */
  async function overCreationLimit(guildId: string, userId: string): Promise<boolean> {
    try {
      const { count } = await lock.increment(
        `party-cooldown:${guildId}:${userId}`,
        CREATION_WINDOW_MS,
      );
      return count > MAX_CREATIONS;
    } catch (error) {
      logger.warn("Party cooldown unavailable", { guildId, userId, error });
      return false;
    }
  }

  return {
    specialCount,
    takeSpecialAllowance,
    recipientLimitReached,
    countRecipient,
    enforceControlCooldown,
    renameLimitReached,
    countRename,
    overCreationLimit,
  };
}
