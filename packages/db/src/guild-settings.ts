import type { SQL } from "bun";
import type { GuildSettingsRow } from "./types.ts";

export interface GuildSettingsRepository {
  find(guildId: string): Promise<GuildSettingsRow | null>;
  /** Sets the guild's prefix; null goes back to the bot default. */
  setPrefix(guildId: string, prefix: string | null): Promise<GuildSettingsRow>;
  /** Sets the guild's IANA time zone; null goes back to the bot default. */
  setTimeZone(guildId: string, timeZone: string | null): Promise<GuildSettingsRow>;
  /** Whether Postgres knows the zone; its tzdata can differ from the runtime's ICU. */
  isKnownTimeZone(timeZone: string): Promise<boolean>;
  /** Sets the guild's language (`pl`, `en`, `de`); null goes back to the bot default. */
  setLocale(guildId: string, locale: string | null): Promise<GuildSettingsRow>;
}

export function createGuildSettingsRepository(sql: SQL): GuildSettingsRepository {
  return {
    async find(guildId) {
      const [row] = await sql<GuildSettingsRow[]>`
        SELECT * FROM guild_settings WHERE guild_id = ${guildId}
      `;
      return row ?? null;
    },

    async setPrefix(guildId, prefix) {
      const [row] = await sql<GuildSettingsRow[]>`
        INSERT INTO guild_settings (guild_id, prefix) VALUES (${guildId}, ${prefix})
        ON CONFLICT (guild_id) DO UPDATE SET prefix = EXCLUDED.prefix, updated_at = now()
        RETURNING *
      `;
      if (!row) throw new Error("Upsert into guild_settings returned no row");
      return row;
    },

    async isKnownTimeZone(timeZone) {
      const [row] = await sql<{ known: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = ${timeZone}) AS known
      `;
      return row?.known === true;
    },

    async setTimeZone(guildId, timeZone) {
      const [row] = await sql<GuildSettingsRow[]>`
        INSERT INTO guild_settings (guild_id, time_zone) VALUES (${guildId}, ${timeZone})
        ON CONFLICT (guild_id) DO UPDATE SET time_zone = EXCLUDED.time_zone, updated_at = now()
        RETURNING *
      `;
      if (!row) throw new Error("Upsert into guild_settings returned no row");
      return row;
    },

    async setLocale(guildId, locale) {
      const [row] = await sql<GuildSettingsRow[]>`
        INSERT INTO guild_settings (guild_id, locale) VALUES (${guildId}, ${locale})
        ON CONFLICT (guild_id) DO UPDATE SET locale = EXCLUDED.locale, updated_at = now()
        RETURNING *
      `;
      if (!row) throw new Error("Upsert into guild_settings returned no row");
      return row;
    },
  };
}
