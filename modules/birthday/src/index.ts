import {
  type BotModule,
  type CronScheduler,
  characterCount,
  codeBlocks,
  DISCORD_LIMITS,
  defineCommand,
  defineModal,
  defineSubcommand,
  escapeMarkdown,
  fillTemplate,
  type GuildTimeZones,
  type LocaleResolver,
  type Logger,
  MANAGE_GUILD,
  requireGuild,
  type TextChannels,
  tickMinute,
  UserError,
} from "@dzajcarz/core";
import { celebratedDays, isValidBirthday, type LocalTime, localTime } from "./calendar.ts";
import { t } from "./messages.ts";

export type { TextChannels } from "@dzajcarz/core";
export { celebratedDays, isLeapYear, isValidBirthday, localTime } from "./calendar.ts";

export interface Birthday {
  month: number;
  day: number;
}

export interface BirthdayConfig {
  channelId: string;
  template: string;
}

/** Birthdays, each server's wish config, and which wishes went out. */
export interface BirthdayStore {
  get(userId: string): Promise<Birthday | null>;
  set(userId: string, birthday: Birthday): Promise<void>;
  /** False when the member had no birthday saved. */
  remove(userId: string): Promise<boolean>;
  /** Members born on one of `days` of `month` with no wish for `target` (a guild id or `dm`) in `year`. */
  unwished(target: string, year: number, month: number, days: readonly number[]): Promise<string[]>;
  /** Takes the wish before it is sent, atomically: true for exactly one caller per member, target and year. */
  claimWish(userId: string, target: string, year: number): Promise<boolean>;
  /** Undoes `claimWish` after a send that may work on a later try. */
  releaseWish(userId: string, target: string, year: number): Promise<void>;
  getConfig(guildId: string): Promise<BirthdayConfig | null>;
  setConfig(guildId: string, config: BirthdayConfig): Promise<void>;
  /** False when the guild had no config. */
  deleteConfig(guildId: string): Promise<boolean>;
  configs(): Promise<(BirthdayConfig & { guildId: string })[]>;
}

/**
 * Delivers the wishes. Each answer that retrying would not change is returned; any other failure (a rate
 * limit, Discord being down) throws, so the wish is tried again on a later run.
 */
export interface BirthdaySender {
  /**
   * Posts in a text channel of the guild, allowing a ping of `memberId` only. "gone" when the channel is
   * missing, not a text channel of the guild, or the bot may not write there.
   */
  toChannel(
    guildId: string,
    channelId: string,
    text: string,
    memberId: string,
  ): Promise<"sent" | "gone">;
  /** DMs the user, allowing a ping of them only. "closed" when they do not accept DMs from the bot. */
  toUser(userId: string, text: string): Promise<"sent" | "closed">;
}

/** Who is on a server, for the wishes posted there. */
export interface BirthdayMembers {
  /** The member's name on the server; null when they are not a member, or a bot. */
  displayName(guildId: string, userId: string): Promise<string | null>;
  /** Null when the bot does not know the guild. */
  guildName(guildId: string): Promise<string | null>;
}

export interface BirthdayModuleDeps {
  store: BirthdayStore;
  sender: BirthdaySender;
  members: BirthdayMembers;
  channels: TextChannels;
  cron: CronScheduler;
  /** Each server's zone (`/timezone`); `of(null)` is the default zone, used for the DMs. */
  timeZones: GuildTimeZones;
  /** The language of each member's DM. */
  locales: LocaleResolver;
  /** The module toggle for a channel: a server's wishes are gated on the channel they are posted to. */
  moduleEnabled: (guildId: string, channelId: string, module: string) => Promise<boolean>;
  now: () => Date;
  logger: Logger;
}

const MODULE_NAME = "birthday";
const DM_TARGET = "dm";
/** Local hour from which the day's wishes go out. */
export const WISH_HOUR = 9;
/** Every quarter of an hour of UTC is a quarter of every zone, including those offset by 30 or 45 minutes. */
const TICK_CRON = "*/15 * * * *";
export const MAX_MESSAGE_LENGTH = DISCORD_LIMITS.content;

export interface BirthdayValues {
  /** Rendered as a mention. */
  userId: string;
  username: string;
  serverName: string;
}

/** Fills `{user}`, `{username}` and `{server}`; member and server names are markdown-escaped. */
export function renderBirthday(template: string, values: BirthdayValues): string {
  return fillTemplate(template, {
    user: `<@${values.userId}>`,
    username: escapeMarkdown(values.username),
    server: escapeMarkdown(values.serverName),
  });
}

export function createBirthdayModule({
  store,
  sender,
  members,
  channels,
  cron,
  timeZones,
  locales,
  moduleEnabled,
  now,
  logger,
}: BirthdayModuleDeps): BotModule {
  /** Shared by the prefix form and the modal, so both refuse the same input. */
  async function saveConfig(guildId: string, channelId: string, message: string) {
    const template = message.trim();
    if (template.length === 0) throw new UserError((l) => t(l).emptyTemplate);
    if (characterCount(template) > MAX_MESSAGE_LENGTH) {
      throw new UserError((l) => t(l).tooLong(MAX_MESSAGE_LENGTH));
    }
    if (!(await channels.isTextChannelOf(guildId, channelId))) {
      throw new UserError((l) => t(l).badChannel);
    }
    await store.setConfig(guildId, { channelId, template });
  }

  const channelForm = defineModal({
    module: MODULE_NAME,
    name: "channel",
    title: t.all("formTitle"),
    permissions: MANAGE_GUILD,
    fields: {
      channel: {
        type: "channel",
        label: t.all("formChannel"),
        description: t.all("formChannelHint"),
        channelTypes: ["text", "announcement"],
      },
      message: {
        type: "paragraph",
        label: t.all("formMessage"),
        description: t.all("formMessageHint"),
        // Optional so an empty answer gets the same wording as the prefix form.
        required: false,
        placeholder: t.all("formMessagePlaceholder"),
      },
    },
    run: async (ctx) => {
      const message = ctx.values.message ?? "";
      if (characterCount(message.trim()) > MAX_MESSAGE_LENGTH) {
        // The form is gone with everything typed in it: hand the text back so it can be pasted again.
        await ctx.reply({ content: t(ctx.locale).tooLong(MAX_MESSAGE_LENGTH), ephemeral: true });
        for (const chunk of codeBlocks(message))
          await ctx.reply({ content: chunk, ephemeral: true });
        return;
      }
      await saveConfig(requireGuild(ctx.guildId), ctx.values.channel, message);
      await ctx.reply({
        content: t(ctx.locale).channelSaved(ctx.values.channel),
        ephemeral: true,
      });
    },
  });

  const birthday = defineCommand({
    name: "birthday",
    aliases: ["urodziny", "geburtstag", "bday"],
    description: t.all("description"),
    // Guild install only: a user install would offer it on servers without the bot.
    contexts: { places: ["guild", "bot-dm"], installs: ["guild"] },
    subcommands: {
      set: defineSubcommand({
        description: t.all("setDescription"),
        options: {
          day: {
            type: "integer",
            description: t.all("dayOption"),
            required: true,
            minValue: 1,
            maxValue: 31,
          },
          month: {
            type: "integer",
            description: t.all("monthOption"),
            required: true,
            minValue: 1,
            maxValue: 12,
          },
        },
        run: async (ctx) => {
          const { day, month } = ctx.args;
          if (!isValidBirthday(day, month)) throw new UserError((l) => t(l).badDate);
          await store.set(ctx.user.id, { month, day });
          const text = t(ctx.locale);
          await ctx.reply({ content: text.saved(text.date(day, month)), ephemeral: true });
        },
      }),
      remove: defineSubcommand({
        description: t.all("removeDescription"),
        run: async (ctx) => {
          const removed = await store.remove(ctx.user.id);
          const text = t(ctx.locale);
          await ctx.reply({ content: removed ? text.removed : text.notSaved, ephemeral: true });
        },
      }),
      show: defineSubcommand({
        description: t.all("showDescription"),
        options: {
          user: { type: "user", description: t.all("userOption"), required: false },
        },
        run: async (ctx) => {
          const userId = ctx.args.user ?? ctx.user.id;
          const self = userId === ctx.user.id;
          const saved = await store.get(userId);
          const text = t(ctx.locale);
          let content: string;
          if (saved === null) content = self ? text.noneSelf : text.noneOther(userId);
          else {
            const date = text.date(saved.day, saved.month);
            content = self ? text.showSelf(date) : text.showOther(userId, date);
          }
          await ctx.reply({ content, ephemeral: true });
        },
      }),
      channel: defineSubcommand({
        description: t.all("channelDescription"),
        permissions: MANAGE_GUILD,
        options: {
          channel: {
            type: "channel",
            description: t.all("channelOption"),
            required: true,
            prefixOnly: true,
          },
          message: {
            type: "string",
            description: t.all("messageOption"),
            required: true,
            rest: true,
            prefixOnly: true,
          },
        },
        run: async (ctx) => {
          const guildId = requireGuild(ctx.guildId);
          if (ctx.canShowModal) {
            // showModal has to be the first answer, so only what is needed to prefill is looked up.
            const current = await store.getConfig(guildId);
            // A channel that was deleted or turned into a voice channel would only be refused on submit.
            const channel =
              current && (await channels.isTextChannelOf(guildId, current.channelId))
                ? current.channelId
                : undefined;
            await ctx.showModal(
              channelForm.build(
                ctx.user.id,
                undefined,
                current ? { channel, message: current.template } : undefined,
              ),
            );
            return;
          }
          const { channel, message } = ctx.args;
          if (channel === undefined || message === undefined) {
            throw new UserError((l) => t(l).channelUsage);
          }
          await saveConfig(guildId, channel, message);
          await ctx.reply({ content: t(ctx.locale).channelSaved(channel), ephemeral: true });
        },
      }),
      test: defineSubcommand({
        description: t.all("testDescription"),
        permissions: MANAGE_GUILD,
        run: async (ctx) => {
          const guildId = requireGuild(ctx.guildId);
          // Looking up the server and posting can take longer than the 3 s a slash command may stay silent.
          await ctx.defer({ ephemeral: true });
          const config = await store.getConfig(guildId);
          if (!config) throw new UserError((l) => t(l).notConfigured);
          const serverName = await members.guildName(guildId);
          if (serverName === null) throw new UserError((l) => t(l).noGuild);
          const text = renderBirthday(config.template, {
            userId: ctx.user.id,
            username: ctx.user.displayName,
            serverName,
          });
          const sendFailed = new UserError((l) => t(l).sendFailed(config.channelId));
          let result: "sent" | "gone";
          try {
            result = await sender.toChannel(guildId, config.channelId, text, ctx.user.id);
          } catch (error) {
            logger.warn("Birthday test could not be sent", { guildId, error });
            throw sendFailed;
          }
          if (result === "gone") throw sendFailed;
          await ctx.reply({ content: t(ctx.locale).testSent, ephemeral: true });
        },
      }),
      disable: defineSubcommand({
        description: t.all("disableDescription"),
        permissions: MANAGE_GUILD,
        run: async (ctx) => {
          const removed = await store.deleteConfig(requireGuild(ctx.guildId));
          const text = t(ctx.locale);
          await ctx.reply({ content: removed ? text.disabled : text.wasNotSet, ephemeral: true });
        },
      }),
    },
  });

  /**
   * Claims the wish, then sends it. A failure retrying may fix gives the claim back, so a later run tries
   * again the same day; a permanent one (channel gone, DMs closed) keeps it, so it is not tried every run.
   */
  async function deliver(
    userId: string,
    target: string,
    year: number,
    send: () => Promise<"sent" | "gone" | "closed">,
  ): Promise<void> {
    if (!(await store.claimWish(userId, target, year))) return;
    try {
      const result = await send();
      if (result !== "sent") {
        logger.info("Birthday wish not delivered and not retried", { userId, target, result });
      }
    } catch (error) {
      await store.releaseWish(userId, target, year);
      logger.warn("Birthday wish not sent; it is tried again later", { userId, target, error });
    }
  }

  async function wishByDm(at: Date): Promise<void> {
    const local = localTime(at, await timeZones.of(null));
    if (local.hour < WISH_HOUR) return;
    const due = await store.unwished(DM_TARGET, local.year, local.month, celebratedDays(local));
    for (const userId of due) {
      await deliver(userId, DM_TARGET, local.year, async () =>
        sender.toUser(userId, t(await locales.user(userId)).dmWish),
      );
    }
  }

  async function wishInGuild(
    { guildId, channelId, template }: BirthdayConfig & { guildId: string },
    local: LocalTime,
  ): Promise<void> {
    const due = await store.unwished(guildId, local.year, local.month, celebratedDays(local));
    if (due.length === 0) return;
    // Not claimed while the module is off, so switching it back on the same day still sends the wish.
    if (!(await moduleEnabled(guildId, channelId, MODULE_NAME))) return;
    // Null too while the client is still loading its servers; nothing is claimed then.
    const serverName = await members.guildName(guildId);
    if (serverName === null) return;
    for (const userId of due) {
      try {
        const username = await members.displayName(guildId, userId);
        if (username === null) continue;
        const text = renderBirthday(template, { userId, username, serverName });
        await deliver(userId, guildId, local.year, () =>
          sender.toChannel(guildId, channelId, text, userId),
        );
      } catch (error) {
        logger.warn("Birthday wish skipped", { guildId, userId, error });
      }
    }
  }

  /**
   * Sends every wish due: from 9:00 on the birthday, on the server's clock (the default zone's for the DM).
   * A run every quarter of an hour catches 9:00 in every zone and, after downtime, catches up the same day.
   */
  async function tick(): Promise<void> {
    const at = tickMinute(now());
    try {
      await wishByDm(at);
    } catch (error) {
      logger.error("Birthday DMs failed", { error });
    }
    let configs: (BirthdayConfig & { guildId: string })[];
    try {
      configs = await store.configs();
    } catch (error) {
      logger.error("Birthday configs could not be read", { error });
      return;
    }
    for (const config of configs) {
      try {
        const local = localTime(at, await timeZones.of(config.guildId));
        if (local.hour >= WISH_HOUR) await wishInGuild(config, local);
      } catch (error) {
        logger.warn("Birthday wishes failed for a server", { guildId: config.guildId, error });
      }
    }
  }

  const stop = cron.every(TICK_CRON, "UTC", tick);

  return {
    name: MODULE_NAME,
    commands: [birthday],
    modals: [channelForm],
    dispose: stop,
  };
}
