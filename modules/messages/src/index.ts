import {
  type BotModule,
  type ComponentRow,
  type CronScheduler,
  defineButton,
  defineCommand,
  defineEvent,
  defineModal,
  defineSubcommand,
  type Logger,
  UserError,
} from "@dzajcarz/core";
import type { KeyValueStore } from "@dzajcarz/kv";
import { type LocalMinute, parseTimeOfDay, warsawMinute } from "./time.ts";

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

/** Where scheduled messages and members' opt-outs are kept. */
export interface ScheduledMessageStore {
  add(message: Omit<ScheduledMessage, "id">, limits: ScheduledMessageLimits): Promise<AddResult>;
  /** The guild's messages by time, then id. */
  list(guildId: string): Promise<ScheduledMessage[]>;
  /** False when the guild has no message with that id. */
  remove(guildId: string, id: number): Promise<boolean>;
  /** Deletes every message of the guild; resolves how many there were. */
  removeGuild(guildId: string): Promise<number>;
  /** At most `limit` messages of every guild due at `time` (`HH:MM`). */
  due(time: string, limit: number): Promise<ScheduledMessage[]>;
  /** `guildId` null means every server. False when it was already off. */
  optOut(userId: string, guildId: string | null): Promise<boolean>;
  /** Removes exactly that opt-out (a null guild clears only the every-server one). False when there was none. */
  optIn(userId: string, guildId: string | null): Promise<boolean>;
  /** True when the member opted out of this guild or of every server. */
  isOptedOut(userId: string, guildId: string): Promise<boolean>;
}

/** Delivers scheduled messages; channel and member ids come from members, so the adapter checks them. */
export interface ScheduledMessageSender {
  /** Posts with no mentions at all; throws when the channel is not a text channel of the guild. */
  toChannel(guildId: string, channelId: string, content: string): Promise<void>;
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
export interface MessageChannels {
  /** Whether the channel is a text or announcement channel of this guild. */
  isTextChannelOf(guildId: string, channelId: string): Promise<boolean>;
  /** Whether the bot may see the channel and send messages in it. */
  botCanPostIn(guildId: string, channelId: string): Promise<boolean>;
}

export interface MessagesModuleDeps {
  store: ScheduledMessageStore;
  sender: ScheduledMessageSender;
  channels: MessageChannels;
  cron: CronScheduler;
  /** Claims a message's minute before it is sent, so it goes out once (see DESIGN.md, Scheduled messages). */
  lock: Pick<KeyValueStore, "setIfAbsent">;
  botInGuild: (guildId: string) => boolean;
  /** The module toggle for a channel. */
  moduleEnabled: (guildId: string, channelId: string, module: string) => Promise<boolean>;
  /** The module toggle for the guild as a whole (DMs belong to no channel). */
  guildModuleEnabled: (guildId: string, module: string) => Promise<boolean>;
  now: () => Date;
  /** IANA zone the times of day are read in. */
  timeZone: string;
  logger: Logger;
}

const MODULE_NAME = "messages";
/** PermissionFlagsBits.ManageGuild; modules do not import discord.js at runtime. */
const MANAGE_GUILD = 1n << 5n;

export const MAX_MESSAGES_PER_GUILD = 25;
export const MAX_DMS_PER_RECIPIENT = 3;
/** A tick reads no more rows than this; hitting it is logged. */
export const MAX_DUE_PER_TICK = 500;
/** Messages sent at once in a tick, so a busy minute does not hit Discord with hundreds of requests together. */
const SEND_BATCH = 5;
export const MAX_CONTENT_LENGTH = 1900;
const DISCORD_MESSAGE_LIMIT = 2000;
/** Discord's limit on a server name; the DM footer must fit even after a rename. */
const MAX_GUILD_NAME = 100;
const PREVIEW_LENGTH = 40;
/** Longer than the repeated hour in October, so its second 02:xx finds the lock still held. */
const LOCK_TTL_MS = 2 * 3_600_000;
const SNOWFLAKE = /^\d{17,20}$/;
const CHANNEL_MENTION = /^<#(\d{17,20})>$/;
const USER_MENTION = /^<@!?(\d{17,20})>$/;
const USER_PLACEHOLDER = "{user}";

const BAD_TIME = "Podaj godzinę jako HH:MM, np. 19:00.";
const ONE_TARGET = "Wybierz kanał albo osobę (jedno z dwóch).";
const BAD_CHANNEL = "Wybierz kanał tekstowy z tego serwera.";
const NOT_A_MEMBER = "Wiadomości prywatne mogę wysyłać tylko członkom tego serwera (nie botom).";
const BAD_LENGTH = `Treść musi mieć od 1 do ${MAX_CONTENT_LENGTH} znaków.`;
const LIMIT_REACHED = `Ten serwer ma już ${MAX_MESSAGES_PER_GUILD} zaplanowanych wiadomości. Usuń którąś przez \`messages remove\`.`;
const RECIPIENT_FULL = `Ta osoba ma już ${MAX_DMS_PER_RECIPIENT} zaplanowane wiadomości prywatne z tego serwera. Usuń którąś przez \`messages remove\`.`;
const DUPLICATE = "Na ten kanał albo do tej osoby jest już zaplanowana wiadomość o tej godzinie.";
const CANNOT_POST = (channelId: string) =>
  `Nie mogę pisać na <#${channelId}>. Daj mi tam uprawnienia „Wyświetlanie kanałów” i „Wysyłanie wiadomości”.`;
const USER_IN_CHANNEL =
  " `{user}` działa tylko w wiadomościach prywatnych, na kanale zostanie wpisane dosłownie.";
const EMPTY_LIST = "Brak zaplanowanych wiadomości. Dodaj przez `messages add`.";

const characters = (text: string): number => [...text].length;

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

const dmFooter = (guildName: string) => `\n-# Zaplanowana wiadomość z serwera ${guildName}.`;

/** What a member gets in a DM: `{user}` becomes a ping of them, and a footer says which server sent it. */
function renderDirectMessage(content: string, userId: string, guildName: string): string {
  return content.replaceAll(USER_PLACEHOLDER, `<@${userId}>`) + dmFooter(guildName);
}

/** How far over Discord's limit a DM could end up, with the longest server name; 0 when it fits. */
function directMessageOverflow(content: string, userId: string): number {
  const worstCase = renderDirectMessage(content, userId, "x".repeat(MAX_GUILD_NAME));
  return Math.max(0, characters(worstCase) - DISCORD_MESSAGE_LIMIT);
}

/** Discord caps a message at 2000 characters; the fences and a margin leave room for the text. */
const CHUNK_SIZE = 1900;

/** The text as ephemeral-sized code blocks; a run of backticks gets a zero-width space so it cannot close one. */
function codeBlocks(text: string): string[] {
  const safe = text.replaceAll("`", "`\u200b");
  const chars = [...safe];
  const blocks: string[] = [];
  for (let start = 0; start < chars.length; start += CHUNK_SIZE) {
    blocks.push(`\`\`\`\n${chars.slice(start, start + CHUNK_SIZE).join("")}\n\`\`\``);
  }
  return blocks;
}

/**
 * One line of the text, cut to `PREVIEW_LENGTH` characters, as inline code so markdown and mentions in it
 * show as typed. Any backtick would end the span, even one followed by a zero-width space, so backticks
 * become a look-alike (U+02CB).
 */
function preview(content: string): string {
  const line = content.replace(/\s+/g, " ").trim().replaceAll("`", "\u02cb");
  const chars = [...line];
  const cut = chars.length > PREVIEW_LENGTH ? `${chars.slice(0, PREVIEW_LENGTH).join("")}…` : line;
  return `\`${cut}\``;
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

/** Room kept at the end of a cut list for "… i jeszcze N". */
const MORE_RESERVE = 20;

/** The lines that fit one message; the rest is counted in a last line. */
export function fitLines(lines: readonly string[], limit = DISCORD_MESSAGE_LIMIT): string {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const next = used + (kept.length > 0 ? 1 : 0) + characters(line);
    if (next > limit - MORE_RESERVE) break;
    kept.push(line);
    used = next;
  }
  const hidden = lines.length - kept.length;
  return hidden > 0 ? `${kept.join("\n")}\n… i jeszcze ${hidden}` : kept.join("\n");
}

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
  lock,
  botInGuild,
  moduleEnabled,
  guildModuleEnabled,
  now,
  timeZone,
  logger,
}: MessagesModuleDeps): BotModule {
  const guildOf = (guildId: string | null): string => {
    if (guildId === null) throw new UserError("Ta komenda działa tylko na serwerze.");
    return guildId;
  };

  /** Shared by the form and the prefix form, so both refuse the same input with the same words. */
  async function addMessage(guildId: string, createdBy: string, draft: Draft): Promise<string> {
    const time = parseTimeOfDay(draft.time ?? "");
    if (time === null) throw new UserError(BAD_TIME);
    if ((draft.channelId === undefined) === (draft.userId === undefined)) {
      throw new UserError(ONE_TARGET);
    }
    const content = draft.text.trim();
    const length = characters(content);
    if (length < 1 || length > MAX_CONTENT_LENGTH) throw new UserError(BAD_LENGTH);
    if (draft.userId !== undefined) {
      const overflow = directMessageOverflow(content, draft.userId);
      if (overflow > 0) {
        throw new UserError(
          `Po wstawieniu oznaczeń {user} i stopki z nazwą serwera wiadomość prywatna przekroczy ${DISCORD_MESSAGE_LIMIT} znaków. Skróć ją o ${overflow}.`,
        );
      }
    }
    let target: MessageTarget;
    if (draft.channelId !== undefined) {
      if (!(await channels.isTextChannelOf(guildId, draft.channelId))) {
        throw new UserError(BAD_CHANNEL);
      }
      if (!(await channels.botCanPostIn(guildId, draft.channelId))) {
        throw new UserError(CANNOT_POST(draft.channelId));
      }
      target = { kind: "channel", channelId: draft.channelId };
    } else {
      const userId = draft.userId as string;
      if ((await sender.memberStatus(guildId, userId)) !== "member") {
        throw new UserError(NOT_A_MEMBER);
      }
      target = { kind: "dm", userId };
    }
    const result = await store.add(
      { guildId, time, content, target, createdBy },
      { perGuild: MAX_MESSAGES_PER_GUILD, perRecipient: MAX_DMS_PER_RECIPIENT },
    );
    if (result.status === "guild-full") throw new UserError(LIMIT_REACHED);
    if (result.status === "recipient-full") throw new UserError(RECIPIENT_FULL);
    if (result.status === "duplicate") throw new UserError(DUPLICATE);
    const saved = result.message;
    // Whether the recipient opted out stays private to them, so the reply does not say.
    if (target.kind === "dm") {
      return `Zaplanowano wiadomość #${saved.id} na ${saved.time} → DM do <@${target.userId}>.`;
    }
    const note = content.includes(USER_PLACEHOLDER) ? USER_IN_CHANNEL : "";
    return `Zaplanowano wiadomość #${saved.id} na ${saved.time} → <#${target.channelId}>.${note}`;
  }

  const addForm = defineModal({
    module: MODULE_NAME,
    name: "add",
    title: "Zaplanowana wiadomość",
    permissions: MANAGE_GUILD,
    fields: {
      time: {
        type: "short",
        label: "Godzina (czas polski)",
        description: "HH:MM, wiadomość wychodzi codziennie o tej porze.",
        placeholder: "19:00",
        maxLength: 5,
      },
      channel: {
        type: "channel",
        label: "Kanał",
        description: "Wybierz kanał albo osobę poniżej.",
        channelTypes: ["text", "announcement"],
        required: false,
      },
      user: {
        type: "user",
        label: "Osoba (wiadomość prywatna)",
        description: "Członek serwera, który dostanie DM.",
        required: false,
      },
      text: {
        type: "paragraph",
        label: "Treść",
        description: "{user} wstawia oznaczenie odbiorcy (tylko w DM).",
        placeholder: "Bonżur!",
        maxLength: MAX_CONTENT_LENGTH,
        // Optional so an empty answer gets the same wording as the prefix form.
        required: false,
      },
    },
    run: async (ctx) => {
      const text = ctx.values.text ?? "";
      try {
        const content = await addMessage(guildOf(ctx.guildId), ctx.user.id, {
          time: ctx.values.time,
          channelId: ctx.values.channel,
          userId: ctx.values.user,
          text,
        });
        await ctx.reply({ content, ephemeral: true });
      } catch (error) {
        if (!(error instanceof UserError) || text.trim() === "") throw error;
        // The form is gone with everything typed in it: hand the text back so it can be pasted again.
        await ctx.reply({ content: error.message, ephemeral: true });
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
      if (!SNOWFLAKE.test(guildId)) throw new UserError("Ten przycisk jest nieaktualny.");
      await store.optOut(ctx.user.id, guildId);
      const raw = await sender.guildName(guildId);
      const name = raw === null ? "" : plainGuildName(raw);
      await ctx.reply({
        content: `Nie dostaniesz już zaplanowanych wiadomości z ${name !== "" ? `serwera ${name}` : "tego serwera"}. Włączysz je z powrotem przez \`/dm on\` na tym serwerze.`,
        ephemeral: true,
      });
    },
  });

  async function deliver(message: ScheduledMessage, minute: LocalMinute): Promise<void> {
    const { guildId, target } = message;
    if (!botInGuild(guildId)) return;
    const enabled =
      target.kind === "channel"
        ? await moduleEnabled(guildId, target.channelId, MODULE_NAME)
        : await guildModuleEnabled(guildId, MODULE_NAME);
    if (!enabled) return;
    const key = `messages:sent:${message.id}:${minute.date}T${minute.time}`;
    if (!(await lock.setIfAbsent(key, "1", LOCK_TTL_MS))) return;

    if (target.kind === "channel") {
      await sender.toChannel(guildId, target.channelId, message.content);
      return;
    }
    if ((await sender.memberStatus(guildId, target.userId)) !== "member") return;
    if (await store.isOptedOut(target.userId, guildId)) return;
    const guildName = plainGuildName((await sender.guildName(guildId)) ?? "") || guildId;
    const delivered = await sender.toMember(
      guildId,
      target.userId,
      renderDirectMessage(message.content, target.userId, guildName),
      [
        [
          {
            type: "button",
            customId: optOutButton.customId(target.userId, guildId),
            label: "Nie wysyłaj mi więcej",
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

  /**
   * Sends what is due this minute. A minute missed while the bot was down is not caught up, and a time the
   * March clock change skips does not fire that day.
   */
  async function tick(): Promise<void> {
    try {
      // A job that fires a few milliseconds early still belongs to the minute it was meant for.
      const rounded = new Date(Math.round(now().getTime() / 60_000) * 60_000);
      const minute = warsawMinute(rounded, timeZone);
      const due = await store.due(minute.time, MAX_DUE_PER_TICK);
      if (due.length >= MAX_DUE_PER_TICK) {
        logger.warn("Too many scheduled messages in one minute; the rest are skipped", {
          time: minute.time,
          limit: MAX_DUE_PER_TICK,
        });
      }
      for (const batch of batches(due, SEND_BATCH)) {
        const results = await Promise.allSettled(batch.map((message) => deliver(message, minute)));
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

  const stop = cron.every("* * * * *", timeZone, tick);

  const messages = defineCommand({
    name: "messages",
    description: "Zaplanowane wiadomości na serwerze",
    permissions: MANAGE_GUILD,
    subcommands: {
      add: defineSubcommand({
        description: "Planuje codzienną wiadomość na kanał albo w DM do członka serwera",
        options: {
          time: {
            type: "string",
            description: "Godzina HH:MM (czas polski)",
            required: true,
            prefixOnly: true,
          },
          target: {
            type: "string",
            description: "#kanał albo @osoba",
            required: true,
            prefixOnly: true,
          },
          text: {
            type: "string",
            description: "Treść ({user} oznacza odbiorcę DM)",
            required: true,
            rest: true,
            prefixOnly: true,
          },
        },
        run: async (ctx) => {
          const guildId = guildOf(ctx.guildId);
          if (ctx.canShowModal) {
            await ctx.showModal(addForm.build(ctx.user.id));
            return;
          }
          const target = parseTarget(ctx.args.target ?? "");
          if (target === null) throw new UserError(ONE_TARGET);
          const content = await addMessage(guildId, ctx.user.id, {
            time: ctx.args.time,
            channelId: target.kind === "channel" ? target.channelId : undefined,
            userId: target.kind === "dm" ? target.userId : undefined,
            text: ctx.args.text ?? "",
          });
          await ctx.reply({ content, ephemeral: true });
        },
      }),
      list: defineSubcommand({
        description: "Pokazuje zaplanowane wiadomości serwera",
        run: async (ctx) => {
          const rows = await store.list(guildOf(ctx.guildId));
          const content =
            rows.length === 0
              ? EMPTY_LIST
              : fitLines(
                  rows.map(
                    (row) =>
                      `#${row.id} ${row.time} → ${targetLabel(row.target)}: ${preview(row.content)}`,
                  ),
                );
          await ctx.reply({ content, ephemeral: true });
        },
      }),
      remove: defineSubcommand({
        description: "Usuwa zaplanowaną wiadomość",
        options: {
          id: {
            type: "integer",
            description: "Numer z `messages list`",
            required: true,
            minValue: 1,
          },
        },
        run: async (ctx) => {
          const { id } = ctx.args;
          if (!(await store.remove(guildOf(ctx.guildId), id))) {
            throw new UserError(`Nie ma wiadomości #${id} na tym serwerze.`);
          }
          await ctx.reply({ content: `Usunięto wiadomość #${id}.`, ephemeral: true });
        },
      }),
    },
  });

  const dm = defineCommand({
    name: "dm",
    description: "Zaplanowane wiadomości prywatne od bota",
    contexts: { places: ["guild", "bot-dm"], installs: ["guild"] },
    subcommands: {
      off: defineSubcommand({
        description: "Wyłącza je z tego serwera (w DM z botem: ze wszystkich)",
        run: async (ctx) => {
          await store.optOut(ctx.user.id, ctx.guildId);
          await ctx.reply({
            content:
              ctx.guildId === null
                ? "Nie dostaniesz już zaplanowanych wiadomości z żadnego serwera."
                : "Nie dostaniesz już zaplanowanych wiadomości z tego serwera.",
            ephemeral: true,
          });
        },
      }),
      on: defineSubcommand({
        description: "Włącza je dla tego serwera (w DM z botem: zdejmuje wyłączenie wszystkich)",
        run: async (ctx) => {
          const { guildId } = ctx;
          const removed = await store.optIn(ctx.user.id, guildId);
          if (guildId === null) {
            await ctx.reply({
              content: removed
                ? "Włączone ponownie dla wszystkich serwerów, poza tymi wyłączonymi osobno."
                : "Nie masz wyłączenia dla wszystkich serwerów. Wyłączenie jednego serwera zdejmiesz przez `/dm on` na tym serwerze.",
              ephemeral: true,
            });
            return;
          }
          // After removing this guild's row, only the every-server opt-out can still block messages.
          if (await store.isOptedOut(ctx.user.id, guildId)) {
            await ctx.reply({
              content: `${removed ? "Włączono dla tego serwera, ale n" : "N"}adal masz wyłączone wiadomości ze wszystkich serwerów, więc stąd też nic nie przyjdzie. Wpisz \`/dm on\` w prywatnej wiadomości do bota, żeby to zmienić.`,
              ephemeral: true,
            });
            return;
          }
          await ctx.reply({
            content: removed
              ? "Znowu dostaniesz zaplanowane wiadomości z tego serwera."
              : "Nie były wyłączone.",
            ephemeral: true,
          });
        },
      }),
    },
  });

  // A server the bot left would only make every row fail daily, and its text should not outlive the bot there.
  const forgetGuild = defineEvent({
    name: "messages-forget-guild",
    event: "guildDelete",
    // The toggles do not matter here: a server the bot left keeps nothing.
    alwaysRun: true,
    run: async (guild: { id: string }) => {
      try {
        const removed = await store.removeGuild(guild.id);
        if (removed > 0) {
          logger.info("Removed the scheduled messages of a server the bot left", {
            guildId: guild.id,
            removed,
          });
        }
      } catch (error) {
        logger.warn("Could not remove the scheduled messages of a server the bot left", {
          guildId: guild.id,
          error,
        });
      }
    },
  });

  return {
    name: MODULE_NAME,
    commands: [messages, dm],
    events: [forgetGuild],
    modals: [addForm],
    components: [optOutButton],
    dispose: stop,
  };
}
