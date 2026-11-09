import {
  type BotModule,
  type CommandContext,
  defineCommand,
  type Logger,
  UserError,
} from "@dzajcarz/core";
import type { KeyValueStore } from "@dzajcarz/kv";
import { parseDuration } from "./duration.ts";
import { checkHierarchy, type MemberInfo } from "./hierarchy.ts";

export { MAX_TIMEOUT_MS, parseDuration } from "./duration.ts";
export { checkHierarchy, type MemberInfo } from "./hierarchy.ts";

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
   * Deletes up to `count` of the newest messages of the channel after skipping the `skipNewest` newest.
   * Pinned messages and messages older than 14 days are left and counted in `pinned` and `tooOld`.
   */
  purge(channelId: string, count: number, skipNewest: number): Promise<PurgeResult>;
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
  logger: Logger;
}

// PermissionFlagsBits values; modules do not import discord.js at runtime.
const KICK_MEMBERS = 1n << 1n;
const BAN_MEMBERS = 1n << 2n;
const ADMINISTRATOR = 1n << 3n;
const MANAGE_MESSAGES = 1n << 13n;
const MODERATE_MEMBERS = 1n << 40n;

/** Discord's limit for an audit log reason, and the length the history keeps. */
export const MAX_REASON_LENGTH = 512;
/** Discord's limit for one message. */
const MAX_MESSAGE_LENGTH = 2000;
/** A reason in the /warnings list is cut to this many characters, so ten of them fit in one message. */
const LISTED_REASON_LENGTH = 120;
const LISTED_WARNINGS = 10;
const MAX_PURGE = 100;
/** One warning DM per member and guild in this window; the warnings themselves are always recorded. */
export const WARN_DM_WINDOW_MS = 10 * 60_000;

export const NO_REASON = "brak powodu";
export const NOT_A_MEMBER = "Tej osoby nie ma na serwerze.";
export const NO_GUILD_PERMISSION = "Nie masz uprawnień do tej komendy.";
export const BOT_LACKS_PERMISSION =
  "Nie mam uprawnień, żeby to zrobić. Sprawdź moje uprawnienia na serwerze.";
export const ADMIN_TIMEOUT = "Nie można wyciszyć administratora.";
export const REASON_TOO_LONG = `Powód może mieć najwyżej ${MAX_REASON_LENGTH} znaków.`;
export const BAD_DURATION = "Podaj czas jak 30s, 10m, 2h albo 1d (najwyżej 28d).";
export const NOT_TIMED_OUT = "Ta osoba nie jest wyciszona.";
export const NOT_RECORDED = " (nie udało się zapisać w historii)";
export const WARNINGS_SENT = "Wysłałem Ci listę w prywatnej wiadomości.";
export const WARNINGS_DM_CLOSED = "Nie mogę wysłać Ci prywatnej wiadomości. Użyj /warnings.";

const userOption = (description: string) =>
  ({ type: "user", description, required: true }) as const;
const reasonOption = {
  type: "string",
  description: `Powód (do ${MAX_REASON_LENGTH} znaków)`,
  rest: true,
} as const;

/** Length in code points, the way Postgres' char_length counts. */
const length = (text: string) => [...text].length;

/** Polish noun form for a count: 1 → one, 2–4 (not 12–14) → few, otherwise many. */
export function plural(count: number, one: string, few: string, many: string): string {
  if (count === 1) return one;
  const tens = count % 100;
  const ones = count % 10;
  if (ones >= 2 && ones <= 4 && (tens < 12 || tens > 14)) return few;
  return many;
}

function hasPermission(granted: bigint, permission: bigint): boolean {
  return (granted & ADMINISTRATOR) !== 0n || (granted & permission) === permission;
}

const WARSAW_TIME = new Intl.DateTimeFormat("pl-PL", {
  timeZone: "Europe/Warsaw",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** `dd.MM.yyyy HH:mm` in Warsaw time. */
function formatWarsaw(date: Date): string {
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    WARSAW_TIME.formatToParts(date).find((piece) => piece.type === type)?.value ?? "";
  return `${part("day")}.${part("month")}.${part("year")} ${part("hour")}:${part("minute")}`;
}

/** One line of the list: no line breaks, and a long reason cut so the list stays in one message. */
function listedReason(reason: string | null): string {
  const flat = (reason ?? NO_REASON).replace(/\s+/g, " ");
  const chars = [...flat];
  return chars.length > LISTED_REASON_LENGTH
    ? `${chars.slice(0, LISTED_REASON_LENGTH - 1).join("")}…`
    : flat;
}

/**
 * The /warnings text: a header and as many whole lines as fit into one Discord message. The header is
 * written for the lines that made it, so "N najnowszych" always matches what is shown.
 */
function warningsList(targetId: string, total: number, lines: string[]): string {
  const word = plural(total, "ostrzeżenie", "ostrzeżenia", "ostrzeżeń");
  for (let shown = lines.length; shown >= 0; shown--) {
    const header =
      shown < total
        ? `<@${targetId}> ma ${total} ${word}, ${shown} najnowszych:`
        : `<@${targetId}> ma ${total} ${word}:`;
    const text = [header, ...lines.slice(0, shown)].join("\n");
    if (length(text) <= MAX_MESSAGE_LENGTH) return text;
  }
  return `<@${targetId}> ma ${total} ${word}.`;
}

export function createModerationModule({
  guild,
  log,
  dmLimit,
  logger,
}: ModerationModuleDeps): BotModule {
  function guildOf(ctx: CommandContext): string {
    if (ctx.guildId === null) throw new UserError("Ta komenda działa tylko na serwerze.");
    return ctx.guildId;
  }

  /** The typed reason, or null when none was given. Longer than Discord's audit limit is refused. */
  function reasonOf(raw: string | undefined): string | null {
    const reason = raw?.trim() ?? "";
    if (reason === "") return null;
    if (length(reason) > MAX_REASON_LENGTH) throw new UserError(REASON_TOO_LONG);
    return reason;
  }

  /** What the guild's audit log shows: who did it and why, within Discord's 512 characters. */
  function auditReason(ctx: CommandContext, reason: string | null): string {
    return [...`${ctx.user.displayName}: ${reason ?? NO_REASON}`]
      .slice(0, MAX_REASON_LENGTH)
      .join("");
  }

  /**
   * Ban, kick and timeout are guild-wide powers, so the caller's guild-level permissions must allow them:
   * a channel overwrite that grants the bit (which Discord's own command gate accepts) is not enough.
   */
  function requireGuildPermission(actor: MemberInfo | null, permission: bigint): void {
    if (!hasPermission(actor?.permissions ?? 0n, permission)) {
      throw new UserError(NO_GUILD_PERMISSION);
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
    const guildId = guildOf(ctx);
    const [actor, bot, target] = await Promise.all([
      guild.member(guildId, ctx.user.id),
      guild.self(guildId),
      guild.member(guildId, targetId),
    ]);
    if (!actor) throw new Error(`The caller ${ctx.user.id} is not a member of ${guildId}`);
    requireGuildPermission(actor, permission);
    if (memberOnly && !target) throw new UserError(NOT_A_MEMBER);
    const refused = checkHierarchy({ actor, bot, targetId, target });
    if (refused) throw new UserError(refused);
    if (botActs && !hasPermission(bot.permissions, permission)) {
      throw new UserError(BOT_LACKS_PERMISSION);
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
    text: (guildName: string) => string,
  ): Promise<boolean> {
    try {
      const sent = await guild.sendDirect(userId, text(await guild.guildName(guildId)));
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
    correction: (guildName: string) => string,
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

  const because = (reason: string | null) => `Powód: ${reason ?? NO_REASON}`;

  const ban = defineCommand({
    name: "ban",
    description: "Banuje osobę na serwerze (także kogoś, kogo już tu nie ma)",
    permissions: BAN_MEMBERS,
    options: { user: userOption("Kogo zbanować"), reason: reasonOption },
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
        (await notify(guildId, targetId, (name) => `Ban na serwerze ${name}. ${because(reason)}`));
      await actAfterNotice(
        guildId,
        targetId,
        notified,
        () => guild.ban(guildId, targetId, auditReason(ctx, reason)),
        (name) => `Ban na serwerze ${name} nie doszedł do skutku.`,
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
      await ctx.reply(`Zbanowano <@${targetId}>. ${because(reason)}${saved ? "" : NOT_RECORDED}`);
    },
  });

  const kick = defineCommand({
    name: "kick",
    description: "Wyrzuca osobę z serwera",
    permissions: KICK_MEMBERS,
    options: { user: userOption("Kogo wyrzucić"), reason: reasonOption },
    async run(ctx) {
      const reason = reasonOf(ctx.args.reason);
      const targetId = ctx.args.user;
      const { guildId } = await prepare(ctx, targetId, KICK_MEMBERS, {
        memberOnly: true,
        botActs: true,
      });
      await ctx.defer();
      const notified = await notify(
        guildId,
        targetId,
        (name) => `Wyrzucenie z serwera ${name}. ${because(reason)}`,
      );
      await actAfterNotice(
        guildId,
        targetId,
        notified,
        () => guild.kick(guildId, targetId, auditReason(ctx, reason)),
        (name) => `Wyrzucenie z serwera ${name} nie doszło do skutku.`,
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
      await ctx.reply(`Wyrzucono <@${targetId}>. ${because(reason)}${saved ? "" : NOT_RECORDED}`);
    },
  });

  const timeout = defineCommand({
    name: "timeout",
    description: "Wycisza osobę na podany czas (najwyżej 28 dni)",
    permissions: MODERATE_MEMBERS,
    options: {
      user: userOption("Kogo wyciszyć"),
      duration: { type: "string", description: "Na ile: 30s, 10m, 2h albo 1d", required: true },
      reason: reasonOption,
    },
    async run(ctx) {
      const duration = parseDuration(ctx.args.duration);
      if (!duration) throw new UserError(BAD_DURATION);
      const reason = reasonOf(ctx.args.reason);
      const targetId = ctx.args.user;
      const { guildId, target } = await prepare(ctx, targetId, MODERATE_MEMBERS, {
        memberOnly: true,
        botActs: true,
      });
      // Discord never times out an administrator; say so instead of a generic permission error.
      if (target && (target.permissions & ADMINISTRATOR) !== 0n) {
        throw new UserError(ADMIN_TIMEOUT);
      }
      await ctx.defer();
      await guild.timeout(guildId, targetId, duration.ms, auditReason(ctx, reason));
      await notify(
        guildId,
        targetId,
        (name) => `Wyciszenie na serwerze ${name} na ${duration.label}. ${because(reason)}`,
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
      await ctx.reply(
        `Wyciszono <@${targetId}> na ${duration.label}. ${because(reason)}${saved ? "" : NOT_RECORDED}`,
      );
    },
  });

  const untimeout = defineCommand({
    name: "untimeout",
    description: "Zdejmuje wyciszenie przed czasem",
    permissions: MODERATE_MEMBERS,
    options: { user: userOption("Komu zdjąć wyciszenie"), reason: reasonOption },
    async run(ctx) {
      const reason = reasonOf(ctx.args.reason);
      const targetId = ctx.args.user;
      const { guildId, target } = await prepare(ctx, targetId, MODERATE_MEMBERS, {
        memberOnly: true,
        botActs: true,
      });
      if (!target?.timedOut) throw new UserError(NOT_TIMED_OUT);
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
      await ctx.reply(
        `Zdjęto wyciszenie z <@${targetId}>. ${because(reason)}${saved ? "" : NOT_RECORDED}`,
      );
    },
  });

  const warn = defineCommand({
    name: "warn",
    description: "Daje osobie ostrzeżenie, zapisane w historii",
    permissions: MODERATE_MEMBERS,
    options: { user: userOption("Kogo ostrzec"), reason: reasonOption },
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
        await notify(
          guildId,
          targetId,
          (name) => `Ostrzeżenie na serwerze ${name}. ${because(reason)}`,
        );
      }
      const which = count === null ? "" : ` (ostrzeżenie nr ${count})`;
      await ctx.reply(
        `Ostrzeżenie dla <@${targetId}>${which}. ${because(reason)}${saved ? "" : NOT_RECORDED}`,
      );
    },
  });

  const warnings = defineCommand({
    name: "warnings",
    description: "Pokazuje ostrzeżenia osoby",
    permissions: MODERATE_MEMBERS,
    options: { user: userOption("Czyje ostrzeżenia pokazać") },
    async run(ctx) {
      const guildId = guildOf(ctx);
      requireGuildPermission(await guild.member(guildId, ctx.user.id), MODERATE_MEMBERS);
      await ctx.defer({ ephemeral: true });
      const targetId = ctx.args.user;
      const { total, recent } = await log.warnings(guildId, targetId, LISTED_WARNINGS);
      const content =
        total === 0
          ? `<@${targetId}> nie ma ostrzeżeń.`
          : warningsList(
              targetId,
              total,
              recent.map(
                (warning) =>
                  `\`#${warning.id}\` ${formatWarsaw(warning.createdAt)} od <@${warning.moderatorId}>: ${listedReason(warning.reason)}`,
              ),
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
      await ctx.reply(sent ? WARNINGS_SENT : WARNINGS_DM_CLOSED);
    },
  });

  const purge = defineCommand({
    name: "purge",
    description: "Usuwa ostatnie wiadomości na tym kanale (do 100, młodsze niż 14 dni)",
    permissions: MANAGE_MESSAGES,
    options: {
      count: {
        type: "integer",
        description: "Ile wiadomości usunąć",
        required: true,
        minValue: 1,
        maxValue: MAX_PURGE,
      },
    },
    async run(ctx) {
      const guildId = guildOf(ctx);
      const count = ctx.args.count;
      if (!Number.isInteger(count) || count < 1 || count > MAX_PURGE) {
        throw new UserError(`Podaj liczbę od 1 do ${MAX_PURGE}.`);
      }
      await ctx.defer({ ephemeral: true });
      // The prefix command's own message is the newest one; it stays, so the reply has something to answer.
      const skipNewest = ctx.invocation === "prefix" ? 1 : 0;
      const { deleted, tooOld, pinned } = await guild.purge(ctx.channelId, count, skipNewest);
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
      const parts = [
        `Usunięto ${deleted} ${plural(deleted, "wiadomość", "wiadomości", "wiadomości")}.`,
      ];
      if (tooOld > 0) {
        parts.push(
          `Pominięto ${tooOld} ${plural(tooOld, "starszą", "starsze", "starszych")} niż 14 dni.`,
        );
      }
      if (pinned > 0) {
        parts.push(
          `Pominięto ${pinned} ${plural(pinned, "przypiętą", "przypięte", "przypiętych")}.`,
        );
      }
      await ctx.reply({
        content: `${parts.join(" ")}${saved ? "" : NOT_RECORDED}`,
        ephemeral: true,
      });
    },
  });

  return {
    name: "moderation",
    commands: [ban, kick, timeout, untimeout, warn, warnings, purge],
  };
}
