import {
  type BotModule,
  defineCommand,
  defineEvent,
  defineSubcommand,
  type Logger,
  MANAGE_GUILD,
  requireGuild,
  type TextChannels,
  UserError,
} from "@dzajcarz/core";
import type { KeyValueStore } from "@dzajcarz/kv";
import { createWhatMatcher } from "./match.ts";
import { DZAJCO_WORDS } from "./words.ts";

/** The gif the old bot answered with. */
export const DZAJCO_GIF = "https://tenor.com/view/jajco-gif-23924347";

export const DEFAULT_CHANCE_PERCENT = 3;
export const DEFAULT_COOLDOWN_SECONDS = 60;
export const MAX_COOLDOWN_SECONDS = 86400;

export interface DzajcoSettings {
  chancePercent: number;
  cooldownSeconds: number;
}

/** Per-channel overrides; a channel without one uses the defaults. */
export interface DzajcoSettingsStore {
  /** Null means "no override": the defaults apply. */
  get(guildId: string, channelId: string): Promise<DzajcoSettings | null>;
  set(guildId: string, channelId: string, settings: DzajcoSettings): Promise<void>;
  /** False when the channel had no override. */
  clear(guildId: string, channelId: string): Promise<boolean>;
}

export interface DzajcoResponder {
  /** Reacts with an egg to the message and replies with the gif link, without mentions. */
  respond(channelId: string, messageId: string): Promise<void>;
}

export type { TextChannels } from "@dzajcarz/core";

export interface DzajcoModuleDeps {
  settings: DzajcoSettingsStore;
  responder: DzajcoResponder;
  kv: Pick<KeyValueStore, "get" | "set" | "setIfAbsent" | "del">;
  channels: TextChannels;
  /** Returns a number in [0, 1), like `Math.random`. */
  random: () => number;
  prefixFor: (guildId: string | null) => Promise<string>;
  logger: Logger;
}

/** What the handler reads from a discord.js `Message`; a plain object in tests. */
export interface DzajcoMessage {
  id: string;
  channelId: string;
  guildId: string | null;
  content: string;
  author: { bot: boolean };
  webhookId: string | null;
  client?: { user?: { id: string } | null };
}

const SETTINGS_CACHE_TTL_MS = 10 * 60 * 1000;

const cooldownKey = (channelId: string) => `dzajco:cooldown:${channelId}`;
const settingsKey = (channelId: string) => `dzajco:settings:${channelId}`;

function isSettings(value: unknown): value is DzajcoSettings {
  if (typeof value !== "object" || value === null) return false;
  const { chancePercent, cooldownSeconds } = value as Record<string, unknown>;
  return typeof chancePercent === "number" && typeof cooldownSeconds === "number";
}

export function createDzajcoModule({
  settings,
  responder,
  kv,
  channels,
  random,
  prefixFor,
  logger,
}: DzajcoModuleDeps): BotModule {
  const matchesWhat = createWhatMatcher(DZAJCO_WORDS);
  const defaults: DzajcoSettings = {
    chancePercent: DEFAULT_CHANCE_PERCENT,
    cooldownSeconds: DEFAULT_COOLDOWN_SECONDS,
  };

  /** The channel's settings through a short-lived cache ("none" is cached too); a broken entry is reloaded. */
  async function cachedSettings(guildId: string, channelId: string): Promise<DzajcoSettings> {
    const cached = await kv.get(settingsKey(channelId));
    if (cached !== null) {
      try {
        const parsed: unknown = JSON.parse(cached);
        if (parsed === null) return defaults;
        if (isSettings(parsed)) return parsed;
      } catch {
        // Falls through to the database.
      }
    }
    const stored = await settings.get(guildId, channelId);
    await kv.set(settingsKey(channelId), JSON.stringify(stored), SETTINGS_CACHE_TTL_MS);
    return stored ?? defaults;
  }

  /** Called after every write, so a new chance or cooldown applies at once. */
  async function invalidate(channelId: string): Promise<void> {
    try {
      await kv.del(settingsKey(channelId));
      await kv.del(cooldownKey(channelId));
    } catch (error) {
      logger.warn("Dżajco cache could not be cleared", { channelId, error });
    }
  }

  async function handle(message: DzajcoMessage): Promise<void> {
    const { guildId, channelId, content } = message;
    if (guildId === null || message.author.bot || message.webhookId !== null) return;
    if (content.trim().length === 0) return;
    try {
      if (!matchesWhat(content)) return;
      if (content.startsWith(await prefixFor(guildId))) return;
      const botId = message.client?.user?.id;
      if (botId && (content.startsWith(`<@${botId}>`) || content.startsWith(`<@!${botId}>`)))
        return;
      if ((await kv.get(cooldownKey(channelId))) !== null) return;
      const { chancePercent, cooldownSeconds } = await cachedSettings(guildId, channelId);
      if (random() * 100 >= chancePercent) return;
      if (cooldownSeconds > 0) {
        const taken = await kv.setIfAbsent(cooldownKey(channelId), "1", cooldownSeconds * 1000);
        if (!taken) return;
      }
      await responder.respond(channelId, message.id);
    } catch (error) {
      // Redis errors land here too; skipping the gif keeps an outage from bypassing the cooldown.
      logger.warn("Dżajco did not answer", { guildId, channelId, error });
    }
  }

  const answer = defineEvent({
    name: "dzajco-what",
    event: "messageCreate",
    run: handle,
  });

  /** The explicit channel must belong to this guild; without one the current channel is used. */
  async function targetChannel(guildId: string, explicit: string | undefined, current: string) {
    if (explicit === undefined) return current;
    if (!(await channels.isTextChannelOf(guildId, explicit))) {
      throw new UserError("Wybierz kanał tekstowy z tego serwera.");
    }
    return explicit;
  }

  const describe = ({ chancePercent, cooldownSeconds }: DzajcoSettings) =>
    `szansa ${chancePercent}%, przerwa ${cooldownSeconds} s`;

  const channelOption = {
    type: "channel",
    description: "Kanał (domyślnie ten, w którym piszesz)",
  } as const;

  const dzajco = defineCommand({
    name: "dzajco",
    description: "Ustawienia odpowiedzi Dżajco na „co?” w kanałach",
    permissions: MANAGE_GUILD,
    subcommands: {
      show: defineSubcommand({
        description: "Pokazuje ustawienia Dżajco kanału",
        options: { channel: channelOption },
        run: async (ctx) => {
          const guildId = requireGuild(ctx.guildId);
          const channelId = await targetChannel(guildId, ctx.args.channel, ctx.channelId);
          const stored = await settings.get(guildId, channelId);
          await ctx.reply({
            content: `Dżajco na <#${channelId}>: ${describe(stored ?? defaults)}${stored ? "" : " (domyślne)"}.`,
            ephemeral: true,
          });
        },
      }),
      set: defineSubcommand({
        description: "Zmienia szansę i przerwę Dżajco w kanale",
        options: {
          channel: channelOption,
          chance: {
            type: "integer",
            description: "Szansa na odpowiedź w procentach (0 wyłącza Dżajco)",
            minValue: 0,
            maxValue: 100,
          },
          cooldown: {
            type: "integer",
            description: "Przerwa między odpowiedziami w sekundach",
            minValue: 0,
            maxValue: MAX_COOLDOWN_SECONDS,
          },
        },
        run: async (ctx) => {
          const guildId = requireGuild(ctx.guildId);
          const { chance, cooldown } = ctx.args;
          if (chance === undefined && cooldown === undefined) {
            throw new UserError("Podaj szansę albo przerwę.");
          }
          const channelId = await targetChannel(guildId, ctx.args.channel, ctx.channelId);
          const current = (await settings.get(guildId, channelId)) ?? defaults;
          const next: DzajcoSettings = {
            chancePercent: chance ?? current.chancePercent,
            cooldownSeconds: cooldown ?? current.cooldownSeconds,
          };
          await settings.set(guildId, channelId, next);
          await invalidate(channelId);
          await ctx.reply({
            content: `Dżajco na <#${channelId}>: ${describe(next)}.`,
            ephemeral: true,
          });
        },
      }),
      reset: defineSubcommand({
        description: "Przywraca domyślne ustawienia Dżajco w kanale",
        options: { channel: channelOption },
        run: async (ctx) => {
          const guildId = requireGuild(ctx.guildId);
          const channelId = await targetChannel(guildId, ctx.args.channel, ctx.channelId);
          const removed = await settings.clear(guildId, channelId);
          await invalidate(channelId);
          await ctx.reply({
            content: removed
              ? `Przywrócono domyślne ustawienia Dżajco na <#${channelId}>.`
              : `Ustawienia Dżajco na <#${channelId}> były już domyślne.`,
            ephemeral: true,
          });
        },
      }),
    },
  });

  return { name: "dzajco", commands: [dzajco], events: [answer] };
}
