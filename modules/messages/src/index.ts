import {
  type BotModule,
  type ComponentRow,
  type CronScheduler,
  characterCount,
  codeBlocks,
  DISCORD_LIMITS,
  defineButton,
  defineCommand,
  defineModal,
  defineSubcommand,
  fitLines,
  type GuildTimeZones,
  LOCALES,
  type Locale,
  type LocaleResolver,
  type Logger,
  MANAGE_GUILD,
  requireGuild,
  type TextChannels,
  tickMinute,
  truncate,
  UserError,
} from "@dzajcarz/core";
import type { KeyValueStore } from "@dzajcarz/kv";
import { t } from "./messages.ts";
import { parseTimeOfDay } from "./time.ts";

export type MessageTarget = { kind: "channel"; channelId: string } | { kind: "dm"; userId: string };

/** A message a server sends every day at `time`, read in the module's time zone. */
export interface ScheduledMessage {
  id: number;
  guildId: string;
  /** `HH:MM`. */
  time: string;
  content: string;
  target: MessageTarget;
  createdBy: string;
}

/** Caps checked by `add` in the same step as the insert, so two adds at once cannot both slip past them. */
export interface ScheduledMessageLimits {
  perGuild: number;
  /** DM messages to one member from one guild. */
  perRecipient: number;
}

/** Why `add` stored nothing: a cap was reached, or the same target already has a message at that time. */
export type AddResult =
  | { status: "added"; message: ScheduledMessage }
  | { status: "guild-full" }
  | { status: "recipient-full" }
  | { status: "duplicate" };

/** A message due now; `date` is today's date on its server's clock, which `claim` stores. */
export interface DueMessage extends ScheduledMessage {
  date: string;
}

/** Where scheduled messages and members' opt-outs are kept. */
export interface ScheduledMessageStore {
  add(message: Omit<ScheduledMessage, "id">, limits: ScheduledMessageLimits): Promise<AddResult>;
  /** The guild's messages by time, then id. */
  list(guildId: string): Promise<ScheduledMessage[]>;
  /** False when the guild has no message with that id. */
  remove(guildId: string, id: number): Promise<boolean>;
  /**
   * At most `limit` messages, of every guild, whose time of day has passed at `at` on a date later than the
   * one they last went out, on that guild's clock; each carries the date on that clock. A message stays due
   * until `claim`. Over the limit, every guild gets one message before any gets a second.
   */
  due(at: Date, limit: number): Promise<DueMessage[]>;
  /**
   * Takes the message for that local date before it is sent, atomically: true for exactly one caller, and
   * only while the stored date is earlier. A claimed message is not due again that day.
   */
  claim(id: number, date: string): Promise<boolean>;
  /** Undoes `claim(id, date)` after a failed send, so the next tick tries again. */
  release(id: number, date: string): Promise<void>;
  /** `guildId` null means every server. False when it was already off. */
  optOut(userId: string, guildId: string | null): Promise<boolean>;
  /** Removes exactly that opt-out (a null guild clears only the every-server one). False when there was none. */
  optIn(userId: string, guildId: string | null): Promise<boolean>;
  /** True when the member opted out of this guild or of every server. */
  isOptedOut(userId: string, guildId: string): Promise<boolean>;
}

/** Delivers scheduled messages; channel and member ids come from members, so the adapter checks them. */
export interface ScheduledMessageSender {
  /**
   * Posts with no mentions at all; throws when the channel is not a text channel of the guild. "gone" when
   * Discord no longer knows the channel; any other failure throws.
   */
  toChannel(guildId: string, channelId: string, content: string): Promise<"sent" | "gone">;
  /**
   * DMs a member of the guild, allowing a ping of that member only; `components` go under the message.
   * False when the member does not accept DMs from the bot.
   */
  toMember(
    guildId: string,
    userId: string,
    content: string,
    components: readonly ComponentRow[],
  ): Promise<boolean>;
  memberStatus(guildId: string, userId: string): Promise<"member" | "bot" | "absent">;
  /** Null when the bot does not know the guild. */
  guildName(guildId: string): Promise<string | null>;
}

/** Asks Discord about a channel id typed by a member. */
export interface MessageChannels extends TextChannels {
  /** Whether the bot may see the channel and send messages in it. */
  botCanPostIn(guildId: string, channelId: string): Promise<boolean>;
}

export interface MessagesModuleDeps {
  store: ScheduledMessageStore;
  sender: ScheduledMessageSender;
  channels: MessageChannels;
  cron: CronScheduler;
  /** Counts a message's failed sends per local day, which are lost on a restart (see DESIGN.md, Scheduled messages). */
  failures: Pick<KeyValueStore, "increment">;
  /** False until the Discord client has loaded its servers; before that `botInGuild` knows nothing. */
  clientReady: () => boolean;
  botInGuild: (guildId: string) => boolean;
  /** The module toggle for a channel. */
  moduleEnabled: (guildId: string, channelId: string, module: string) => Promise<boolean>;
  /** The module toggle for the guild as a whole (DMs belong to no channel). */
  guildModuleEnabled: (guildId: string, module: string) => Promise<boolean>;
  now: () => Date;
  /** The zone each server reads its times of day in (`/timezone`). */
  timeZones: GuildTimeZones;
  logger: Logger;
  /** The language of a member's DMs (the delivered message's footer and button). */
  locales: LocaleResolver;
}

const MODULE_NAME = "messages";

export const MAX_MESSAGES_PER_GUILD = 25;
export const MAX_DMS_PER_RECIPIENT = 3;
/** A tick reads no more rows than this; hitting it is logged. */
export const MAX_DUE_PER_TICK = 500;
/** Messages sent at once in a tick, so a busy minute does not hit Discord with hundreds of requests together. */
const SEND_BATCH = 5;
export const MAX_CONTENT_LENGTH = 1900;
const DISCORD_MESSAGE_LIMIT = DISCORD_LIMITS.content;
/** Discord's limit on a server name; the DM footer must fit even after a rename. */
const MAX_GUILD_NAME = 100;
const PREVIEW_LENGTH = 40;
/** A bit over a day, so the count outlives the local date it is kept for. */
const FAILURE_TTL_MS = 26 * 3_600_000;
/** Failed deliveries in one local day after which the message is given up for that day. */
export const MAX_ATTEMPTS_PER_DAY = 5;
const SNOWFLAKE = /^\d{17,20}$/;
const CHANNEL_MENTION = /^<#(\d{17,20})>$/;
const USER_MENTION = /^<@!?(\d{17,20})>$/;
const USER_PLACEHOLDER = "{user}";

/**
 * The server name as plain text: the server's owner picks it, so markdown and mention characters are dropped
 * before it goes into the bot's own footer or reply.
 */
function plainGuildName(name: string): string {
  return name
    .replace(/[\\`*_~|<>@#[\]():]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** What a member gets in a DM: `{user}` becomes a ping of them, and a footer says which server sent it. */
function renderDirectMessage(
  content: string,
  userId: string,
  guildName: string,
  locale: Locale,
): string {
  return content.replaceAll(USER_PLACEHOLDER, `<@${userId}>`) + t(locale).dmFooter(guildName);
}

/**
 * How far over Discord's limit a DM could end up, with the longest server name and the longest footer of any
 * language (the recipient's language is not known here); 0 when it fits.
 */
function directMessageOverflow(content: string, userId: string): number {
  const longest = Math.max(
    ...LOCALES.map((locale) =>
      characterCount(renderDirectMessage(content, userId, "x".repeat(MAX_GUILD_NAME), locale)),
    ),
  );
  return Math.max(0, longest - DISCORD_MESSAGE_LIMIT);
}

/**
 * One line of the text, cut to `PREVIEW_LENGTH` characters, as inline code so markdown and mentions in it
 * show as typed. Any backtick would end the span, even one followed by a zero-width space, so backticks
 * become a look-alike (U+02CB).
 */
function preview(content: string): string {
  const line = content.replace(/\s+/g, " ").trim().replaceAll("`", "\u02cb");
  return `\`${truncate(line, PREVIEW_LENGTH)}\``;
}

/** Splits `items` into runs of `size`, in order. */
function batches<T>(items: readonly T[], size: number): T[][] {
  const runs: T[][] = [];
  for (let start = 0; start < items.length; start += size)
    runs.push(items.slice(start, start + size));
  return runs;
}

const targetLabel = (target: MessageTarget) =>
  target.kind === "channel" ? `<#${target.channelId}>` : `DM <@${target.userId}>`;

/** `<#id>` → channel, `<@id>` / `<@!id>` → member; anything else is not a target. */
function parseTarget(input: string): MessageTarget | null {
  const channel = CHANNEL_MENTION.exec(input.trim());
  if (channel?.[1]) return { kind: "channel", channelId: channel[1] };
  const user = USER_MENTION.exec(input.trim());
  if (user?.[1]) return { kind: "dm", userId: user[1] };
  return null;
}

interface Draft {
  time: string | undefined;
  channelId: string | undefined;
  userId: string | undefined;
  text: string;
}

export function createMessagesModule({
  store,
  sender,
  channels,
  cron,
  failures,
  clientReady,
  botInGuild,
  moduleEnabled,
  guildModuleEnabled,
  now,
  timeZones,
  logger,
  locales,
}: MessagesModuleDeps): BotModule {
  /** Shared by the form and the prefix form, so both refuse the same input with the same words. */
  async function addMessage(
    guildId: string,
    createdBy: string,
    draft: Draft,
    locale: Locale,
  ): Promise<string> {
    const time = parseTimeOfDay(draft.time ?? "");
    if (time === null) throw new UserError((l) => t(l).badTime);
    if ((draft.channelId === undefined) === (draft.userId === undefined)) {
      throw new UserError((l) => t(l).oneTarget);
    }
    const content = draft.text.trim();
    const length = characterCount(content);
    if (length < 1 || length > MAX_CONTENT_LENGTH)
      throw new UserError((l) => t(l).badLength(MAX_CONTENT_LENGTH));
    if (draft.userId !== undefined) {
      const overflow = directMessageOverflow(content, draft.userId);
      if (overflow > 0) {
        throw new UserError((l) => t(l).directOverflow(DISCORD_MESSAGE_LIMIT, overflow));
      }
    }
    let target: MessageTarget;
    if (draft.channelId !== undefined) {
      const channelId = draft.channelId;
      if (!(await channels.isTextChannelOf(guildId, channelId))) {
        throw new UserError((l) => t(l).badChannel);
      }
      if (!(await channels.botCanPostIn(guildId, channelId))) {
        throw new UserError((l) => t(l).cannotPost(channelId));
      }
      target = { kind: "channel", channelId };
    } else {
      const userId = draft.userId as string;
      if ((await sender.memberStatus(guildId, userId)) !== "member") {
        throw new UserError((l) => t(l).notAMember);
      }
      target = { kind: "dm", userId };
    }
    const result = await store.add(
      { guildId, time, content, target, createdBy },
      { perGuild: MAX_MESSAGES_PER_GUILD, perRecipient: MAX_DMS_PER_RECIPIENT },
    );
    if (result.status === "guild-full")
      throw new UserError((l) => t(l).limitReached(MAX_MESSAGES_PER_GUILD));
    if (result.status === "recipient-full")
      throw new UserError((l) => t(l).recipientFull(MAX_DMS_PER_RECIPIENT));
    if (result.status === "duplicate") throw new UserError((l) => t(l).duplicate);
    const saved = result.message;
    const when = `${saved.time} (${await timeZones.of(guildId)})`;
    // Whether the recipient opted out stays private to them, so the reply does not say.
    if (target.kind === "dm") {
      return t(locale).scheduledDm(saved.id, when, target.userId);
    }
    const note = content.includes(USER_PLACEHOLDER) ? t(locale).userInChannel : "";
    return t(locale).scheduledChannel(saved.id, when, target.channelId, note);
  }

  const addForm = defineModal({
    module: MODULE_NAME,
    name: "add",
    title: t.all("formTitle"),
    permissions: MANAGE_GUILD,
    fields: {
      time: {
        type: "short",
        label: t.all("formTimeLabel"),
        description: t.all("formTimeDescription"),
        placeholder: "19:00",
        maxLength: 5,
      },
      channel: {
        type: "channel",
        label: t.all("formChannelLabel"),
        description: t.all("formChannelDescription"),
        channelTypes: ["text", "announcement"],
        required: false,
      },
      user: {
        type: "user",
        label: t.all("formUserLabel"),
        description: t.all("formUserDescription"),
        required: false,
      },
      text: {
        type: "paragraph",
        label: t.all("formTextLabel"),
        description: t.all("formTextDescription"),
        placeholder: t.all("formTextPlaceholder"),
        maxLength: MAX_CONTENT_LENGTH,
        // Optional so an empty answer gets the same wording as the prefix form.
        required: false,
      },
    },
    run: async (ctx) => {
      const text = ctx.values.text ?? "";
      try {
        const content = await addMessage(
          requireGuild(ctx.guildId),
          ctx.user.id,
          {
            time: ctx.values.time,
            channelId: ctx.values.channel,
            userId: ctx.values.user,
            text,
          },
          ctx.locale,
        );
        await ctx.reply({ content, ephemeral: true });
      } catch (error) {
        if (!(error instanceof UserError) || text.trim() === "") throw error;
        // The form is gone with everything typed in it: hand the text back so it can be pasted again.
        await ctx.reply({ content: error.messageIn(ctx.locale), ephemeral: true });
        for (const block of codeBlocks(text)) await ctx.reply({ content: block, ephemeral: true });
      }
    },
  });

  const optOutButton = defineButton({
    module: MODULE_NAME,
    name: "optout",
    // The button sits under a DM, where there is no guild.
    guildOnly: false,
    run: async (ctx) => {
      // The guild id rides in the custom_id, which the client sends back: trust its shape only.
      const guildId = ctx.state;
      if (!SNOWFLAKE.test(guildId)) throw new UserError((l) => t(l).staleButton);
      await store.optOut(ctx.user.id, guildId);
      const raw = await sender.guildName(guildId);
      const name = raw === null ? "" : plainGuildName(raw);
      await ctx.reply({
        content: t(ctx.locale).optedOutOfServer(name),
        ephemeral: true,
      });
    },
  });

  /** One attempt. Returns for every outcome that retrying would not change; throws when Discord failed. */
  async function send(message: DueMessage): Promise<void> {
    const { guildId, target } = message;
    if (!botInGuild(guildId)) return;
    const enabled =
      target.kind === "channel"
        ? await moduleEnabled(guildId, target.channelId, MODULE_NAME)
        : await guildModuleEnabled(guildId, MODULE_NAME);
    if (!enabled) return;

    if (target.kind === "channel") {
      const result = await sender.toChannel(guildId, target.channelId, message.content);
      if (result === "gone") {
        // It would fail the same way every day; a missing permission may be fixed, so only this deletes.
        await store.remove(guildId, message.id);
        logger.info("Scheduled message deleted: its channel no longer exists", {
          id: message.id,
          guildId,
        });
      }
      return;
    }
    if ((await sender.memberStatus(guildId, target.userId)) !== "member") return;
    if (await store.isOptedOut(target.userId, guildId)) return;
    const guildName = plainGuildName((await sender.guildName(guildId)) ?? "") || guildId;
    const locale = await locales.user(target.userId);
    const delivered = await sender.toMember(
      guildId,
      target.userId,
      renderDirectMessage(message.content, target.userId, guildName, locale),
      [
        [
          {
            type: "button",
            customId: optOutButton.customId(target.userId, guildId),
            label: t(locale).optOutLabel,
            style: "secondary",
            emoji: "🔕",
          },
        ],
      ],
    );
    if (!delivered) {
      logger.info("Scheduled DM not delivered: the member does not accept DMs", {
        id: message.id,
        guildId,
      });
    }
  }

  /** Failed sends of this message on its local date; a counter that cannot be reached counts as a first failure. */
  async function countFailure(message: DueMessage): Promise<number> {
    try {
      const key = `messages:failed:${message.id}:${message.date}`;
      return (await failures.increment(key, FAILURE_TTL_MS)).count;
    } catch (error) {
      logger.warn("Scheduled message failure counter unavailable", { id: message.id, error });
      return 1;
    }
  }

  /**
   * Claims the day's date first, so a slow or overlapping tick, or a second instance, cannot send the same
   * message again, and a failed write after the send cannot cause a resend. A Discord failure gives the claim
   * back, so the next minute's tick tries again, up to `MAX_ATTEMPTS_PER_DAY` times; any other outcome (sent,
   * a deleted channel, a member who is gone, DMs closed, the module off) keeps it.
   */
  async function deliver(message: DueMessage): Promise<void> {
    if (!(await store.claim(message.id, message.date))) return;
    try {
      await send(message);
    } catch (error) {
      const attempts = await countFailure(message);
      if (attempts < MAX_ATTEMPTS_PER_DAY) {
        await store.release(message.id, message.date);
        logger.warn("Scheduled message not sent; it is tried again next minute", {
          id: message.id,
          guildId: message.guildId,
          attempts,
          error,
        });
        return;
      }
      logger.error("Scheduled message given up for today after repeated failures", {
        id: message.id,
        guildId: message.guildId,
        attempts,
        error,
      });
    }
  }

  /**
   * Sends what is due: everything whose time has passed today and has not gone out, so a minute missed while
   * the bot was down is caught up the same day, and a time the March clock change skips goes out after it.
   */
  async function tick(): Promise<void> {
    // Before the client has its servers, every guild looks left; claiming then would drop the day's messages.
    if (!clientReady()) return;
    try {
      const rounded = tickMinute(now());
      const due = await store.due(rounded, MAX_DUE_PER_TICK);
      if (due.length >= MAX_DUE_PER_TICK) {
        logger.warn("Too many scheduled messages due at once; the rest wait for the next minute", {
          at: rounded.toISOString(),
          limit: MAX_DUE_PER_TICK,
        });
      }
      for (const batch of batches(due, SEND_BATCH)) {
        const results = await Promise.allSettled(batch.map((message) => deliver(message)));
        results.forEach((result, index) => {
          if (result.status === "rejected") {
            logger.warn("Scheduled message not sent", {
              id: batch[index]?.id,
              guildId: batch[index]?.guildId,
              error: result.reason,
            });
          }
        });
      }
    } catch (error) {
      logger.error("Scheduled messages tick failed", { error });
    }
  }

  // Every minute of UTC is every minute of every zone; the store matches each server's own clock.
  const stop = cron.every("* * * * *", "UTC", tick);

  const messages = defineCommand({
    name: "messages",
    description: t.all("messagesDescription"),
    permissions: MANAGE_GUILD,
    subcommands: {
      add: defineSubcommand({
        description: t.all("addDescription"),
        options: {
          time: {
            type: "string",
            description: t.all("addTimeOption"),
            required: true,
            prefixOnly: true,
          },
          target: {
            type: "string",
            description: t.all("addTargetOption"),
            required: true,
            prefixOnly: true,
          },
          text: {
            type: "string",
            description: t.all("addTextOption"),
            required: true,
            rest: true,
            prefixOnly: true,
          },
        },
        run: async (ctx) => {
          const guildId = requireGuild(ctx.guildId);
          if (ctx.canShowModal) {
            await ctx.showModal(addForm.build(ctx.user.id));
            return;
          }
          const target = parseTarget(ctx.args.target ?? "");
          if (target === null) throw new UserError((l) => t(l).oneTarget);
          const content = await addMessage(
            guildId,
            ctx.user.id,
            {
              time: ctx.args.time,
              channelId: target.kind === "channel" ? target.channelId : undefined,
              userId: target.kind === "dm" ? target.userId : undefined,
              text: ctx.args.text ?? "",
            },
            ctx.locale,
          );
          await ctx.reply({ content, ephemeral: true });
        },
      }),
      list: defineSubcommand({
        description: t.all("listDescription"),
        run: async (ctx) => {
          const guildId = requireGuild(ctx.guildId);
          const rows = await store.list(guildId);
          const content =
            rows.length === 0
              ? t(ctx.locale).emptyList
              : fitLines(
                  [
                    t(ctx.locale).listHeader(await timeZones.of(guildId)),
                    ...rows.map(
                      (row) =>
                        `#${row.id} ${row.time} → ${targetLabel(row.target)}: ${preview(row.content)}`,
                    ),
                  ],
                  undefined,
                  ctx.locale,
                );
          await ctx.reply({ content, ephemeral: true });
        },
      }),
      remove: defineSubcommand({
        description: t.all("removeDescription"),
        options: {
          id: {
            type: "integer",
            description: t.all("removeIdOption"),
            required: true,
            minValue: 1,
          },
        },
        run: async (ctx) => {
          const { id } = ctx.args;
          if (!(await store.remove(requireGuild(ctx.guildId), id))) {
            throw new UserError((l) => t(l).noSuchMessage(id));
          }
          await ctx.reply({ content: t(ctx.locale).removed(id), ephemeral: true });
        },
      }),
    },
  });

  const dm = defineCommand({
    name: "dm",
    description: t.all("dmDescription"),
    contexts: { places: ["guild", "bot-dm"], installs: ["guild"] },
    subcommands: {
      off: defineSubcommand({
        description: t.all("dmOffDescription"),
        run: async (ctx) => {
          await store.optOut(ctx.user.id, ctx.guildId);
          await ctx.reply({
            content: ctx.guildId === null ? t(ctx.locale).dmOffEverywhere : t(ctx.locale).dmOffHere,
            ephemeral: true,
          });
        },
      }),
      on: defineSubcommand({
        description: t.all("dmOnDescription"),
        run: async (ctx) => {
          const { guildId } = ctx;
          const removed = await store.optIn(ctx.user.id, guildId);
          if (guildId === null) {
            await ctx.reply({
              content: removed ? t(ctx.locale).dmOnEverywhere : t(ctx.locale).dmOnEverywhereNone,
              ephemeral: true,
            });
            return;
          }
          // After removing this guild's row, only the every-server opt-out can still block messages.
          if (await store.isOptedOut(ctx.user.id, guildId)) {
            await ctx.reply({
              content: removed ? t(ctx.locale).stillOptedOutAfterOn : t(ctx.locale).stillOptedOut,
              ephemeral: true,
            });
            return;
          }
          await ctx.reply({
            content: removed ? t(ctx.locale).dmOnHere : t(ctx.locale).dmOnNotOff,
            ephemeral: true,
          });
        },
      }),
    },
  });

  return {
    name: MODULE_NAME,
    commands: [messages, dm],
    modals: [addForm],
    components: [optOutButton],
    dispose: stop,
  };
}
