import {
  DEFAULT_LOCALE,
  fromDiscordLocale,
  isLocale,
  type Locale,
  type LocaleResolver,
  type Logger,
} from "@dzajcarz/core";
import type { GuildSettingsRepository, UserSettingsRepository } from "@dzajcarz/db";
import type { KeyValueStore } from "@dzajcarz/kv";
import type { LanguageSettings } from "@dzajcarz/module-settings";
import { createGuildSettingCache } from "./guild-setting-cache.ts";

/** Where a member used the bot, as far as the language goes. */
export interface LocalePlace {
  /** null outside servers, and for a server the bot is not a member of (user install). */
  guildId: string | null;
  userId: string;
  /** The member's Discord client language (`interaction.locale`); unknown for a prefix message. */
  clientLocale?: string | null;
}

export interface Locales extends LocaleResolver {
  /**
   * The language to answer in: the server's on a server; elsewhere the member's own choice, then their
   * client's language when the bot speaks it, then the default.
   */
  of(place: LocalePlace): Promise<Locale>;
  /** `/language` reads and writes through this; a write refreshes the cache. */
  settings: LanguageSettings;
  /** Puts what Postgres now holds into the cache, e.g. after the server's data was deleted. */
  forget(guildId: string): Promise<void>;
}

/** What the user cache holds for a member without a choice; the guild cache uses the default instead. */
const NO_CHOICE = "";

/**
 * Every command resolves a language, so both the server's and the member's are cached in Redis like the
 * prefix. A stored value the bot does not know (a later downgrade) counts as no choice.
 */
export function createLocales({
  guildSettings,
  userSettings,
  cache,
  logger,
}: {
  guildSettings: Pick<GuildSettingsRepository, "find" | "setLocale">;
  userSettings: Pick<UserSettingsRepository, "find" | "setLocale">;
  cache: KeyValueStore;
  logger: Logger;
}): Locales {
  const guilds = createGuildSettingCache({
    name: "locale",
    load: async (guildId) => (await guildSettings.find(guildId))?.locale ?? null,
    fallback: DEFAULT_LOCALE,
    cache,
    logger,
  });
  const users = createGuildSettingCache({
    name: "locale",
    scope: "user",
    load: async (userId) => (await userSettings.find(userId))?.locale ?? null,
    fallback: NO_CHOICE,
    cache,
    logger,
  });
  const known = (value: string | null | undefined): Locale | null =>
    isLocale(value) ? value : null;

  const guild = async (guildId: string) => known(await guilds.resolve(guildId)) ?? DEFAULT_LOCALE;
  const user = async (userId: string) => known(await users.resolve(userId));

  return {
    guild,
    user: async (userId) => (await user(userId)) ?? DEFAULT_LOCALE,
    async of({ guildId, userId, clientLocale }) {
      if (guildId !== null) return guild(guildId);
      return (await user(userId)) ?? fromDiscordLocale(clientLocale) ?? DEFAULT_LOCALE;
    },
    forget: guilds.forget,
    settings: {
      guild: async (guildId) => known((await guildSettings.find(guildId))?.locale),
      async setGuild(guildId, locale) {
        await guildSettings.setLocale(guildId, locale);
        await guilds.forget(guildId);
      },
      user: async (userId) => known((await userSettings.find(userId))?.locale),
      async setUser(userId, locale) {
        await userSettings.setLocale(userId, locale);
        await users.forget(userId);
      },
    },
  };
}
