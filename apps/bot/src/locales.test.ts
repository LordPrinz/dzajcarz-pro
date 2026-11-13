import { describe, expect, test } from "bun:test";
import { silentLogger } from "@dzajcarz/core";
import { renderCatalog } from "@dzajcarz/core/testing";
import type { GuildSettingsRow, UserSettingsRow } from "@dzajcarz/db";
import { createMemoryStore } from "@dzajcarz/kv";
import { createLocales } from "./locales.ts";
import { t } from "./messages.ts";

const GUILD = "100000000000000001";
const USER = "200000000000000002";

function setup() {
  const guilds = new Map<string, string | null>();
  const users = new Map<string, string | null>();
  let lookups = 0;
  const stamp = { created_at: new Date(), updated_at: new Date() };
  const guildRow = (guildId: string): GuildSettingsRow => ({
    guild_id: guildId,
    prefix: null,
    time_zone: null,
    locale: guilds.get(guildId) ?? null,
    ...stamp,
  });
  const userRow = (userId: string): UserSettingsRow => ({
    user_id: userId,
    locale: users.get(userId) ?? null,
    ...stamp,
  });
  const locales = createLocales({
    guildSettings: {
      find: async (guildId) => {
        lookups++;
        return guilds.has(guildId) ? guildRow(guildId) : null;
      },
      setLocale: async (guildId, locale) => {
        guilds.set(guildId, locale);
        return guildRow(guildId);
      },
    },
    userSettings: {
      find: async (userId) => {
        lookups++;
        return users.has(userId) ? userRow(userId) : null;
      },
      setLocale: async (userId, locale) => {
        users.set(userId, locale);
        return userRow(userId);
      },
    },
    cache: createMemoryStore(),
    logger: silentLogger,
  });
  return { locales, guilds, users, lookups: () => lookups };
}

describe("languages", () => {
  test("a server without a choice speaks Polish, whatever the member's own language", async () => {
    const { locales } = setup();
    await locales.settings.setUser(USER, "de");
    expect(await locales.of({ guildId: GUILD, userId: USER, clientLocale: "en-US" })).toBe("pl");
    expect(await locales.guild(GUILD)).toBe("pl");
  });

  test("a server's choice applies at once despite the cache, and reset brings Polish back", async () => {
    const { locales } = setup();
    await locales.guild(GUILD);
    await locales.settings.setGuild(GUILD, "en");
    expect(await locales.of({ guildId: GUILD, userId: USER })).toBe("en");
    expect(await locales.settings.guild(GUILD)).toBe("en");
    await locales.settings.setGuild(GUILD, null);
    expect(await locales.guild(GUILD)).toBe("pl");
    expect(await locales.settings.guild(GUILD)).toBeNull();
  });

  test("outside a server: the member's choice, then their client's language, then Polish", async () => {
    const { locales } = setup();
    const dm = (clientLocale?: string) => locales.of({ guildId: null, userId: USER, clientLocale });
    expect(await dm("en-GB")).toBe("en");
    expect(await dm("fr")).toBe("pl");
    expect(await dm()).toBe("pl");
    await locales.settings.setUser(USER, "de");
    expect(await dm("en-GB")).toBe("de");
    expect(await locales.user(USER)).toBe("de");
    await locales.settings.setUser(USER, null);
    expect(await dm("en-US")).toBe("en");
    expect(await locales.user(USER)).toBe("pl");
  });

  test("lookups are cached per server and per member", async () => {
    const { locales, lookups } = setup();
    for (let i = 0; i < 3; i++) {
      await locales.of({ guildId: GUILD, userId: USER });
      await locales.of({ guildId: null, userId: USER });
    }
    expect(lookups()).toBe(2);
  });

  test("a stored language the bot no longer speaks counts as no choice", async () => {
    const { locales, guilds, users } = setup();
    guilds.set(GUILD, "fr");
    users.set(USER, "fr");
    expect(await locales.guild(GUILD)).toBe("pl");
    expect(await locales.of({ guildId: null, userId: USER, clientLocale: "de" })).toBe("de");
    expect(await locales.settings.guild(GUILD)).toBeNull();
  });

  test("forget reloads the server's language after its data was deleted", async () => {
    const { locales, guilds } = setup();
    await locales.settings.setGuild(GUILD, "de");
    guilds.delete(GUILD);
    await locales.forget(GUILD);
    expect(await locales.guild(GUILD)).toBe("pl");
  });
});

test("every text of the bot's own catalog renders in every language", () => {
  for (const texts of Object.values(renderCatalog(t))) {
    for (const text of Object.values(texts)) expect(text.trim()).not.toBe("");
  }
});
