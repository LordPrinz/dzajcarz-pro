import {
  type BotModule,
  type CommandContext,
  characterCount,
  common,
  DISCORD_LIMITS,
  defineCommand,
  formatDateTime,
  type GuildTimeZones,
  hasPermissions,
  isAdministrator,
  type Locale,
  type LocaleResolver,
  type Localized,
  type Logger,
  requireGuild,
  truncate,
  UserError,
} from "@dzajcarz/core";
import type { KeyValueStore } from "@dzajcarz/kv";
import { parseDuration } from "./duration.ts";
import { checkHierarchy, type MemberInfo } from "./hierarchy.ts";
import { MAX_PURGE, MAX_REASON_LENGTH } from "./limits.ts";
import { t } from "./messages.ts";

export { MAX_TIMEOUT_MS, parseDuration } from "./duration.ts";
export { checkHierarchy, type MemberInfo } from "./hierarchy.ts";
export { MAX_REASON_LENGTH } from "./limits.ts";

/** The Discord side of moderation, as the module needs it. */
export interface ModerationGuild {
  /** null when the user is not a member of the guild. */
  member(guildId: string, userId: string): Promise<MemberInfo | null>;
  /** The bot's own member in the guild. */
  self(guildId: string): Promise<MemberInfo>;
  guildName(guildId: string): Promise<string>;
  /** Works for a user who is not a member, by id. */
  ban(guildId: string, userId: string, auditReason: string): Promise<void>;
  kick(guildId: string, userId: string, auditReason: string): Promise<void>;
  /** Replaces a running timeout. */
  timeout(guildId: string, userId: string, durationMs: number, auditReason: string): Promise<void>;
  untimeout(guildId: string, userId: string, auditReason: string): Promise<void>;
  /**
   * Deletes up to `count` of the newest messages of the channel, only those older than `beforeMessageId`
   * when given (a prefix call passes its own message, which stays).
   * Pinned messages and messages older than 14 days are left and counted in `pinned` and `tooOld`.
   */
  purge(channelId: string, count: number, beforeMessageId: string | null): Promise<PurgeResult>;
  /** A direct message that pings nobody; false when the user does not accept DMs from the bot. */
  sendDirect(userId: string, text: string): Promise<boolean>;
}

export interface PurgeResult {
  deleted: number;
  tooOld: number;
  pinned: number;
}

export type ModerationActionKind = "ban" | "kick" | "timeout" | "untimeout" | "warn" | "purge";

export interface ModerationEntry {
  guildId: string;
  action: ModerationActionKind;
  moderatorId: string;
  /** null only for purge. */
  targetId: string | null;
  /** Purge only. */
  channelId: string | null;
  reason: string | null;
  /** Timeout only. */
  durationMs: number | null;
  /** Purge only: how many messages were deleted. */
  messageCount: number | null;
}

export interface WarningRecord {
  id: number;
  moderatorId: string;
  reason: string | null;
  createdAt: Date;
}

/** History of moderation actions (Postgres). */
export interface ModerationLog {
  record(entry: ModerationEntry): Promise<{ id: number }>;
  /** How many warnings the user has in the guild, and the newest `limit` of them, newest first. */
  warnings(
    guildId: string,
    userId: string,
    limit: number,
  ): Promise<{ total: number; recent: WarningRecord[] }>;
}

export interface ModerationModuleDeps {
  guild: ModerationGuild;
  log: ModerationLog;
  /** Remembers recent warning DMs, so a burst of /warn does not flood one member's inbox. */
  dmLimit: Pick<KeyValueStore, "setIfAbsent">;
  /** Dates in /warnings are shown on the server's clock. */
  timeZones: GuildTimeZones;
  /** The member's own language for the DMs the bot sends them. */
  locales: LocaleResolver;
  logger: Logger;
}

// PermissionFlagsBits values; modules do not import discord.js at runtime.
const KICK_MEMBERS = 1n << 1n;
const BAN_MEMBERS = 1n << 2n;
const MANAGE_MESSAGES = 1n << 13n;
const MODERATE_MEMBERS = 1n << 40n;

/** A reason in the /warnings list is cut to this many characters, so ten of them fit in one message. */
const LISTED_REASON_LENGTH = 120;
const LISTED_WARNINGS = 10;
/** One warning DM per member and guild in this window; the warnings themselves are always recorded. */
export const WARN_DM_WINDOW_MS = 10 * 60_000;

const userOption = (description: Localized) =>
  ({ type: "user", description, required: true }) as const;
const reasonOption = {
  type: "string",
  description: t.all("reasonOption"),
  rest: true,
} as const;

/** One line of the list: no line breaks, and a long reason cut so the list stays in one message. */
function listedReason(reason: string | null, locale: Locale): string {
  const flat = (reason ?? t(locale).noReason).replace(/\s+/g, " ");
  return truncate(flat, LISTED_REASON_LENGTH);
}

/**
 * The /warnings text: a header and as many whole lines as fit into one Discord message. The header is
 * written for the lines that made it, so "N most recent" always matches what is shown.
 */
function warningsList(targetId: string, total: number, lines: string[], locale: Locale): string {
  const text = t(locale);
  for (let shown = lines.length; shown >= 0; shown--) {
    const header =
      shown < total
        ? text.warningsHeaderCut(targetId, total, shown)
        : text.warningsHeader(targetId, total);
    const list = [header, ...lines.slice(0, shown)].join("\n");
    if (characterCount(list) <= DISCORD_LIMITS.content) return list;
  }
  return text.warningsHeaderOnly(targetId, total);
}

export function createModerationModule({
  guild,
  log,
  dmLimit,
  timeZones,
  locales,
  logger,
}: ModerationModuleDeps): BotModule {
  /** The typed reason, or null when none was given. Longer than Discord's audit limit is refused. */
  function reasonOf(raw: string | undefined): string | null {
    const reason = raw?.trim() ?? "";
    if (reason === "") return null;
    if (characterCount(reason) > MAX_REASON_LENGTH) throw new UserError((l) => t(l).reasonTooLong);
    return reason;
  }

  /** What the guild's audit log shows: who did it and why, within Discord's 512 characters. */
  function auditReason(ctx: CommandContext, reason: string | null): string {
    return [...`${ctx.user.displayName}: ${reason ?? t(ctx.locale).noReason}`]
      .slice(0, MAX_REASON_LENGTH)
      .join("");
  }

  /**
   * Ban, kick and timeout are guild-wide powers, so the caller's guild-level permissions must allow them:
   * a channel overwrite that grants the bit (which Discord's own command gate accepts) is not enough.
   */
  function requireGuildPermission(actor: MemberInfo | null, permission: bigint): void {
    if (!hasPermissions(actor?.permissions ?? 0n, permission)) {
      throw new UserError((l) => common(l).noPermission);
    }
  }

  /**
   * The checks every action on a member shares, run before `defer()` so a refusal stays ephemeral. When the
   * bot itself acts (`botActs`), it must hold the permission too, or a ban would DM the member and then fail.
   */
  async function prepare(
    ctx: CommandContext,
    targetId: string,
    permission: bigint,
    { memberOnly, botActs }: { memberOnly: boolean; botActs: boolean },
  ): Promise<{ guildId: string; target: MemberInfo | null }> {
    const guildId = requireGuild(ctx.guildId);
    const [actor, bot, target] = await Promise.all([
      guild.member(guildId, ctx.user.id),
      guild.self(guildId),
      guild.member(guildId, targetId),
    ]);
    if (!actor) throw new Error(`The caller ${ctx.user.id} is not a member of ${guildId}`);
    requireGuildPermission(actor, permission);
    if (memberOnly && !target) throw new UserError((l) => t(l).notAMember);
    const refused = checkHierarchy({ actor, bot, targetId, target, botActs });
    if (refused) throw new UserError(refused);
    if (botActs && !hasPermissions(bot.permissions, permission)) {
      throw new UserError((l) => t(l).botLacksPermission);
    }
    return { guildId, target };
  }

  /** Stores the action; a failure is logged and reported as false, because the action already happened. */
  async function save(entry: ModerationEntry): Promise<boolean> {
    try {
      await log.record(entry);
      return true;
    } catch (error) {
      logger.error("Could not record a moderation action", {
        action: entry.action,
        guildId: entry.guildId,
        targetId: entry.targetId,
        error,
      });
      return false;
    }
  }

  /**
   * Tells the member what happened. Best effort: a closed DM or a failure never stops the action.
   * True when the message went out.
   */
  async function notify(
    guildId: string,
    userId: string,
    text: (guildName: string, texts: ReturnType<typeof t>) => string,
  ): Promise<boolean> {
    try {
      const [name, locale] = await Promise.all([guild.guildName(guildId), locales.user(userId)]);
      const sent = await guild.sendDirect(userId, text(name, t(locale)));
      if (!sent) logger.info("The member does not accept direct messages", { guildId, userId });
      return sent;
    } catch (error) {
      logger.warn("Could not notify the member", { guildId, userId, error });
      return false;
    }
  }

  /**
   * Runs a ban or kick whose DM went out first. If Discord refuses it after all, the member gets a short
   * correction, so they are not left believing they were removed.
   */
  async function actAfterNotice(
    guildId: string,
    userId: string,
    notified: boolean,
    act: () => Promise<void>,
    correction: (guildName: string, texts: ReturnType<typeof t>) => string,
  ): Promise<void> {
    try {
      await act();
    } catch (error) {
      if (notified) await notify(guildId, userId, correction);
      throw error;
    }
  }

  /** Whether this warning may DM the member: at most one per guild and member every 10 minutes. */
  async function warnDmAllowed(guildId: string, userId: string): Promise<boolean> {
    try {
      return await dmLimit.setIfAbsent(
        `moderation:warn-dm:${guildId}:${userId}`,
        "1",
        WARN_DM_WINDOW_MS,
      );
    } catch (error) {
      logger.warn("Could not check the warning DM limit; sending the DM", {
        guildId,
        userId,
        error,
      });
      return true;
    }
  }

  const because = (texts: ReturnType<typeof t>, reason: string | null) =>
    texts.because(reason ?? texts.noReason);

  const ban = defineCommand({
    name: "ban",
    description: t.all("banDescription"),
    permissions: BAN_MEMBERS,
    options: { user: userOption(t.all("banUser")), reason: reasonOption },
    async run(ctx) {
      const reason = reasonOf(ctx.args.reason);
      const targetId = ctx.args.user;
      const { guildId, target } = await prepare(ctx, targetId, BAN_MEMBERS, {
        memberOnly: false,
        botActs: true,
      });
      await ctx.defer();
      // After the ban the bot shares no server with them any more, so the message goes first.
      const notified =
        target !== null &&
        (await notify(guildId, targetId, (name, text) => text.banDm(name, because(text, reason))));
      await actAfterNotice(
        guildId,
        targetId,
        notified,
        () => guild.ban(guildId, targetId, auditReason(ctx, reason)),
        (name, text) => text.banFailedDm(name),
      );
      const saved = await save({
        guildId,
        action: "ban",
        moderatorId: ctx.user.id,
        targetId,
        channelId: null,
        reason,
        durationMs: null,
        messageCount: null,
      });
      const text = t(ctx.locale);
      await ctx.reply(
        `${text.banned(targetId, because(text, reason))}${saved ? "" : text.notRecorded}`,
      );
    },
  });

  const kick = defineCommand({
    name: "kick",
    description: t.all("kickDescription"),
    permissions: KICK_MEMBERS,
    options: { user: userOption(t.all("kickUser")), reason: reasonOption },
    async run(ctx) {
      const reason = reasonOf(ctx.args.reason);
      const targetId = ctx.args.user;
      const { guildId } = await prepare(ctx, targetId, KICK_MEMBERS, {
        memberOnly: true,
        botActs: true,
      });
      await ctx.defer();
      const notified = await notify(guildId, targetId, (name, text) =>
        text.kickDm(name, because(text, reason)),
      );
      await actAfterNotice(
        guildId,
        targetId,
        notified,
        () => guild.kick(guildId, targetId, auditReason(ctx, reason)),
        (name, text) => text.kickFailedDm(name),
      );
      const saved = await save({
        guildId,
        action: "kick",
        moderatorId: ctx.user.id,
        targetId,
        channelId: null,
        reason,
        durationMs: null,
        messageCount: null,
      });
      const text = t(ctx.locale);
      await ctx.reply(
        `${text.kicked(targetId, because(text, reason))}${saved ? "" : text.notRecorded}`,
      );
    },
  });

  const timeout = defineCommand({
    name: "timeout",
    description: t.all("timeoutDescription"),
    permissions: MODERATE_MEMBERS,
    options: {
      user: userOption(t.all("timeoutUser")),
      duration: { type: "string", description: t.all("timeoutDuration"), required: true },
      reason: reasonOption,
    },
    async run(ctx) {
      const duration = parseDuration(ctx.args.duration);
      if (!duration) throw new UserError((l) => t(l).badDuration);
      const reason = reasonOf(ctx.args.reason);
      const targetId = ctx.args.user;
      const { guildId, target } = await prepare(ctx, targetId, MODERATE_MEMBERS, {
        memberOnly: true,
        botActs: true,
      });
      // Discord never times out an administrator; say so instead of a generic permission error.
      if (target && isAdministrator(target.permissions)) {
        throw new UserError((l) => t(l).adminTimeout);
      }
      await ctx.defer();
      await guild.timeout(guildId, targetId, duration.ms, auditReason(ctx, reason));
      await notify(guildId, targetId, (name, text) =>
        text.timeoutDm(name, duration.label, because(text, reason)),
      );
      const saved = await save({
        guildId,
        action: "timeout",
        moderatorId: ctx.user.id,
        targetId,
        channelId: null,
        reason,
        durationMs: duration.ms,
        messageCount: null,
      });
      const text = t(ctx.locale);
      await ctx.reply(
        `${text.timedOut(targetId, duration.label, because(text, reason))}${saved ? "" : text.notRecorded}`,
      );
    },
  });

  const untimeout = defineCommand({
    name: "untimeout",
    description: t.all("untimeoutDescription"),
    permissions: MODERATE_MEMBERS,
    options: { user: userOption(t.all("untimeoutUser")), reason: reasonOption },
    async run(ctx) {
      const reason = reasonOf(ctx.args.reason);
      const targetId = ctx.args.user;
      const { guildId, target } = await prepare(ctx, targetId, MODERATE_MEMBERS, {
        memberOnly: true,
        botActs: true,
      });
      if (!target?.timedOut) throw new UserError((l) => t(l).notTimedOut);
      await ctx.defer();
      await guild.untimeout(guildId, targetId, auditReason(ctx, reason));
      const saved = await save({
        guildId,
        action: "untimeout",
        moderatorId: ctx.user.id,
        targetId,
        channelId: null,
        reason,
        durationMs: null,
        messageCount: null,
      });
      const text = t(ctx.locale);
      await ctx.reply(
        `${text.untimedOut(targetId, because(text, reason))}${saved ? "" : text.notRecorded}`,
      );
    },
  });

  const warn = defineCommand({
    name: "warn",
    description: t.all("warnDescription"),
    permissions: MODERATE_MEMBERS,
    options: { user: userOption(t.all("warnUser")), reason: reasonOption },
    async run(ctx) {
      const reason = reasonOf(ctx.args.reason);
      const targetId = ctx.args.user;
      const { guildId } = await prepare(ctx, targetId, MODERATE_MEMBERS, {
        memberOnly: true,
        botActs: false,
      });
      await ctx.defer();
      const saved = await save({
        guildId,
        action: "warn",
        moderatorId: ctx.user.id,
        targetId,
        channelId: null,
        reason,
        durationMs: null,
        messageCount: null,
      });
      let count: number | null = null;
      if (saved) {
        try {
          count = (await log.warnings(guildId, targetId, 0)).total;
        } catch (error) {
          logger.error("Could not count the warnings", { guildId, targetId, error });
        }
      }
      if (await warnDmAllowed(guildId, targetId)) {
        await notify(guildId, targetId, (name, text) => text.warnDm(name, because(text, reason)));
      }
      const text = t(ctx.locale);
      await ctx.reply(
        `${text.warned(targetId, count, because(text, reason))}${saved ? "" : text.notRecorded}`,
      );
    },
  });

  const warnings = defineCommand({
    name: "warnings",
    description: t.all("warningsDescription"),
    permissions: MODERATE_MEMBERS,
    options: { user: userOption(t.all("warningsUser")) },
    async run(ctx) {
      const guildId = requireGuild(ctx.guildId);
      requireGuildPermission(await guild.member(guildId, ctx.user.id), MODERATE_MEMBERS);
      await ctx.defer({ ephemeral: true });
      const targetId = ctx.args.user;
      const [{ total, recent }, zone] = await Promise.all([
        log.warnings(guildId, targetId, LISTED_WARNINGS),
        timeZones.of(guildId),
      ]);
      const text = t(ctx.locale);
      const content =
        total === 0
          ? text.noWarnings(targetId)
          : warningsList(
              targetId,
              total,
              recent.map((warning) =>
                text.warningLine(
                  warning.id,
                  formatDateTime(warning.createdAt, zone),
                  warning.moderatorId,
                  listedReason(warning.reason, ctx.locale),
                ),
              ),
              ctx.locale,
            );
      if (ctx.invocation === "slash") {
        await ctx.reply({ content, ephemeral: true });
        return;
      }
      // A prefix reply is public, so the list goes to the moderator privately.
      let sent = false;
      try {
        sent = await guild.sendDirect(ctx.user.id, content);
      } catch (error) {
        logger.warn("Could not send the warnings list", { guildId, userId: ctx.user.id, error });
      }
      await ctx.reply(sent ? text.warningsSent : text.warningsDmClosed);
    },
  });

  const purge = defineCommand({
    name: "purge",
    description: t.all("purgeDescription"),
    permissions: MANAGE_MESSAGES,
    options: {
      count: {
        type: "integer",
        description: t.all("purgeCount"),
        required: true,
        minValue: 1,
        maxValue: MAX_PURGE,
      },
    },
    async run(ctx) {
      const guildId = requireGuild(ctx.guildId);
      const count = ctx.args.count;
      if (!Number.isInteger(count) || count < 1 || count > MAX_PURGE) {
        throw new UserError((l) => t(l).badPurgeCount(MAX_PURGE));
      }
      await ctx.defer({ ephemeral: true });
      // The prefix command's own message stays, so the reply has something to answer; messages that arrived
      // after it are not touched either.
      const { deleted, tooOld, pinned } = await guild.purge(
        ctx.channelId,
        count,
        ctx.messageId ?? null,
      );
      const saved =
        deleted === 0 ||
        (await save({
          guildId,
          action: "purge",
          moderatorId: ctx.user.id,
          targetId: null,
          channelId: ctx.channelId,
          reason: null,
          durationMs: null,
          messageCount: deleted,
        }));
      const text = t(ctx.locale);
      const parts = [text.purged(deleted)];
      if (tooOld > 0) parts.push(text.skippedOld(tooOld));
      if (pinned > 0) parts.push(text.skippedPinned(pinned));
      await ctx.reply({
        content: `${parts.join(" ")}${saved ? "" : text.notRecorded}`,
        ephemeral: true,
      });
    },
  });

  return {
    name: "moderation",
    commands: [ban, kick, timeout, untimeout, warn, warnings, purge],
  };
}
