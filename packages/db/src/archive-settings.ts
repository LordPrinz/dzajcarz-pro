import type { SQL } from "bun";
import type { ArchiveSettingsRow } from "./types.ts";

/** What the archive does in one server. A server without a row is not archived. */
export interface GuildArchiveSettings {
  guildId: string;
  enabled: boolean;
  excludedChannelIds: string[];
}

export interface ArchiveSettingsRepository {
  /** The server's settings, or null when it never had any (archive off). */
  findGuild(guildId: string): Promise<GuildArchiveSettings | null>;
  /** Every server with a row, for the panel's settings view. */
  listGuilds(): Promise<GuildArchiveSettings[]>;
  setGuild(settings: GuildArchiveSettings): Promise<GuildArchiveSettings>;
  /** Whether DMs with the bot are archived; off until switched on. */
  dmEnabled(): Promise<boolean>;
  setDm(enabled: boolean): Promise<boolean>;
}

const toSettings = (row: ArchiveSettingsRow): GuildArchiveSettings => ({
  guildId: row.guild_id,
  enabled: row.enabled,
  excludedChannelIds: row.excluded_channel_ids,
});

export function createArchiveSettingsRepository(sql: SQL): ArchiveSettingsRepository {
  return {
    async findGuild(guildId) {
      const [row] = await sql<ArchiveSettingsRow[]>`
        SELECT * FROM archive_settings WHERE guild_id = ${guildId}
      `;
      return row ? toSettings(row) : null;
    },

    async listGuilds() {
      const rows = await sql<ArchiveSettingsRow[]>`
        SELECT * FROM archive_settings ORDER BY guild_id
      `;
      return rows.map(toSettings);
    },

    async setGuild({ guildId, enabled, excludedChannelIds }) {
      const excluded = [...new Set(excludedChannelIds)].sort();
      const [row] = await sql<ArchiveSettingsRow[]>`
        INSERT INTO archive_settings (guild_id, enabled, excluded_channel_ids)
        VALUES (${guildId}, ${enabled}, ${excluded}::text[])
        ON CONFLICT (guild_id) DO UPDATE SET
          enabled = EXCLUDED.enabled,
          excluded_channel_ids = EXCLUDED.excluded_channel_ids,
          updated_at = now()
        RETURNING *
      `;
      if (!row) throw new Error("Upsert into archive_settings returned no row");
      return toSettings(row);
    },

    async dmEnabled() {
      const [row] = await sql<{ enabled: boolean }[]>`SELECT enabled FROM archive_dm_settings`;
      return row?.enabled === true;
    },

    async setDm(enabled) {
      const [row] = await sql<{ enabled: boolean }[]>`
        INSERT INTO archive_dm_settings (id, enabled) VALUES (true, ${enabled})
        ON CONFLICT (id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()
        RETURNING enabled
      `;
      if (!row) throw new Error("Upsert into archive_dm_settings returned no row");
      return row.enabled;
    },
  };
}
