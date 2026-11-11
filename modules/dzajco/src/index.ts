import {
  type BotModule,
  checkAccess,
  defineCommand,
  defineEvent,
  defineSubcommand,
  type Logger,
  MANAGE_GUILD,
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
/**
 * Anyone can set Dżajco in their DM with the bot, and each answer costs two requests against the bot's
 * shared rate limit, so a DM never goes below this.
 */
export const MIN_DM_COOLDOWN_SECONDS = 10;

export interface DzajcoSettings {
  chancePercent: number;
  cooldownSeconds: number;
}

/** Per-channel overrides; a channel without one uses the defaults. `guildId` null is a DM with the bot. */
export interface DzajcoSettingsStore {
  /** Null means "no override": the defaults apply. */
  get(guildId: string | null, channelId: string): Promise<DzajcoSettings | null>;
  set(guildId: string | null, channelId: string, settings: DzajcoSettings): Promise<void>;
  /** False when the channel had no override. */
  clear(guildId: string | null, channelId: string): Promise<boolean>;
}

/** Asks Discord about channels, so a channel id typed by a member is never trusted on its own. */
export interface DzajcoChannels {
  /** The parent channel of a thread, or null for any other channel (or one the bot has not cached). */
  parentOf(channelId: string): string | null;
  /**
   * Whether members can chat in the channel and it belongs to this guild: text and announcement channels,
   * threads, and the text chat of voice and stage channels.
   */
  isChatOf(guildId: string, channelId: string): Promise<boolean>;
}

export interface DzajcoResponder {
  /** Reacts with an egg to the message and replies with the gif link, without mentions. */
  respond(channelId: string, messageId: string): Promise<void>;
}

export interface DzajcoModuleDeps {
  settings: DzajcoSettingsStore;
  responder: DzajcoResponder;
  kv: Pick<KeyValueStore, "get" | "set" | "setIfAbsent" | "del">;
  channels: DzajcoChannels;
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

  /** The channel's own override through a short-lived cache ("none" is cached too); a broken entry is reloaded. */
  async function cachedOverride(
    guildId: string | null,
    channelId: string,
  ): Promise<DzajcoSettings | null> {
    const cached = await kv.get(settingsKey(channelId));
    if (cached !== null) {
      try {
        const parsed: unknown = JSON.parse(cached);
        if (parsed === null) return null;
        if (isSettings(parsed)) return parsed;
      } catch {
        // Falls through to the database.
      }
    }
    const stored = await settings.get(guildId, channelId);
    const value = JSON.stringify(stored);
    // An empty slot is only filled, so a change written while this read was in flight is not undone (see
    // refresh); a broken entry is overwritten.
    if (cached === null) await kv.setIfAbsent(settingsKey(channelId), value, SETTINGS_CACHE_TTL_MS);
    else await kv.set(settingsKey(channelId), value, SETTINGS_CACHE_TTL_MS);
    return stored;
  }

  /** A thread without an override of its own follows its parent channel, like module toggles do. */
  async function effectiveSettings(
    guildId: string | null,
    channelId: string,
  ): Promise<DzajcoSettings> {
    const own = await cachedOverride(guildId, channelId);
    if (own) return own;
    const parentId = channels.parentOf(channelId);
    const inherited = parentId ? await cachedOverride(guildId, parentId) : null;
    return inherited ?? defaults;
  }

  /** Called after every write: caches what the database now holds and ends the running cooldown. */
  async function refresh(guildId: string | null, channelId: string): Promise<void> {
    try {
      const stored = await settings.get(guildId, channelId);
      await kv.set(settingsKey(channelId), JSON.stringify(stored), SETTINGS_CACHE_TTL_MS);
      await kv.del(cooldownKey(channelId));
    } catch (error) {
      logger.warn("Dżajco cache could not be refreshed; dropping it", { channelId, error });
      await kv.del(settingsKey(channelId)).catch(() => {});
      await kv.del(cooldownKey(channelId)).catch(() => {});
    }
  }

  async function handle(message: DzajcoMessage): Promise<void> {
    const { guildId, channelId, content } = message;
    // A DM with the bot counts too (guildId null); it reads the default prefix and its own settings.
    if (message.author.bot || message.webhookId !== null) return;
    if (content.trim().length === 0) return;
    try {
      if (!matchesWhat(content)) return;
      // The command parser ignores case, so `Co?` with the prefix `co` is a command call, not a question.
      const prefix = (await prefixFor(guildId)).toLowerCase();
      if (content.toLowerCase().startsWith(prefix)) return;
      const botId = message.client?.user?.id;
      if (botId && (content.startsWith(`<@${botId}>`) || content.startsWith(`<@!${botId}>`)))
        return;
      if ((await kv.get(cooldownKey(channelId))) !== null) return;
      const { chancePercent, cooldownSeconds } = await effectiveSettings(guildId, channelId);
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

  /**
   * Where a subcommand acts: the explicit channel, which must be a chat of this server, or the current one.
   * In a DM only the conversation itself can be set, and nobody needs Manage Server for it.
   */
  async function targetOf(ctx: {
    guildId: string | null;
    channelId: string;
    memberPermissions: bigint | null;
    args: { channel?: string };
  }): Promise<{ guildId: string | null; channelId: string }> {
    const { guildId, channelId } = ctx;
    if (guildId === null) {
      if (ctx.args.channel !== undefined && ctx.args.channel !== channelId) {
        throw new UserError("W prywatnej wiadomości ustawiasz tylko tę rozmowę.");
      }
      return { guildId, channelId };
    }
    // The command also runs in DMs, so Discord cannot hide it from members; the server check is ours.
    const denied = checkAccess({ permissions: MANAGE_GUILD }, ctx);
    if (denied) throw new UserError(denied);
    const explicit = ctx.args.channel;
    if (explicit === undefined) return { guildId, channelId };
    if (!(await channels.isChatOf(guildId, explicit))) {
      throw new UserError(
        "Wybierz kanał z tego serwera, na którym da się pisać (także wątek albo czat kanału głosowego).",
      );
    }
    return { guildId, channelId: explicit };
  }

  const where = (guildId: string | null, channelId: string) =>
    guildId === null ? "w tej rozmowie" : `na <#${channelId}>`;

  const describe = ({ chancePercent, cooldownSeconds }: DzajcoSettings) =>
    `szansa ${chancePercent}%, przerwa ${cooldownSeconds} s`;

  const channelOption = {
    type: "channel",
    description: "Kanał, wątek albo czat głosowy (domyślnie ten, w którym piszesz)",
  } as const;

  const dzajco = defineCommand({
    name: "dzajco",
    description: "Ustawienia odpowiedzi Dżajco na „co?” w kanałach i w prywatnej rozmowie z botem",
    // Bot DMs need only the guild install; a user install would also offer the command in servers without
    // the bot, where its settings would be stored for nothing and never cleaned up.
    contexts: { places: ["guild", "bot-dm"], installs: ["guild"] },
    subcommands: {
      show: defineSubcommand({
        description: "Pokazuje ustawienia Dżajco kanału",
        options: { channel: channelOption },
        run: async (ctx) => {
          const { guildId, channelId } = await targetOf(ctx);
          const own = await settings.get(guildId, channelId);
          const parentId = own ? null : channels.parentOf(channelId);
          const inherited = parentId ? await settings.get(guildId, parentId) : null;
          const source = own
            ? ""
            : inherited
              ? ` (z kanału nadrzędnego <#${parentId}>)`
              : " (domyślne)";
          await ctx.reply({
            content: `Dżajco ${where(guildId, channelId)}: ${describe(own ?? inherited ?? defaults)}${source}.`,
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
            description:
              "Przerwa między odpowiedziami w sekundach (w prywatnej rozmowie co najmniej 10)",
            minValue: 0,
            maxValue: MAX_COOLDOWN_SECONDS,
          },
        },
        run: async (ctx) => {
          const { chance, cooldown } = ctx.args;
          const { guildId, channelId } = await targetOf(ctx);
          if (chance === undefined && cooldown === undefined) {
            throw new UserError("Podaj szansę albo przerwę.");
          }
          const current = (await settings.get(guildId, channelId)) ?? defaults;
          const floor = guildId === null ? MIN_DM_COOLDOWN_SECONDS : 0;
          const next: DzajcoSettings = {
            chancePercent: chance ?? current.chancePercent,
            cooldownSeconds: Math.max(floor, cooldown ?? current.cooldownSeconds),
          };
          await settings.set(guildId, channelId, next);
          await refresh(guildId, channelId);
          await ctx.reply({
            content: `Dżajco ${where(guildId, channelId)}: ${describe(next)}.`,
            ephemeral: true,
          });
        },
      }),
      reset: defineSubcommand({
        description: "Przywraca domyślne ustawienia Dżajco w kanale",
        options: { channel: channelOption },
        run: async (ctx) => {
          const { guildId, channelId } = await targetOf(ctx);
          const removed = await settings.clear(guildId, channelId);
          await refresh(guildId, channelId);
          await ctx.reply({
            content: removed
              ? `Przywrócono domyślne ustawienia Dżajco ${where(guildId, channelId)}.`
              : `Ustawienia Dżajco ${where(guildId, channelId)} były już domyślne.`,
            ephemeral: true,
          });
        },
      }),
    },
  });

  return { name: "dzajco", commands: [dzajco], events: [answer] };
}
