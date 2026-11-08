import type { SQL } from "bun";
import type { ScheduledSongConfigRow, ScheduledSongExclusionRow } from "./types.ts";

export interface ScheduledSongRepository {
  /** The song the guild chose, or null for the default. */
  getSong(guildId: string): Promise<string | null>;
  setSong(guildId: string, song: string): Promise<void>;
  /** Back to the default song; false when none was chosen. */
  clearSong(guildId: string): Promise<boolean>;
  /** Excluded voice channel ids, oldest first. */
  listExcluded(guildId: string): Promise<string[]>;
  /** False when the channel was already excluded. */
  addExcluded(guildId: string, channelId: string): Promise<boolean>;
  /** False when the channel was not excluded. */
  removeExcluded(guildId: string, channelId: string): Promise<boolean>;
}

export function createScheduledSongRepository(sql: SQL): ScheduledSongRepository {
  return {
    async getSong(guildId) {
      const [row] = await sql<ScheduledSongConfigRow[]>`
        SELECT * FROM scheduled_song_config WHERE guild_id = ${guildId}
      `;
      return row?.song ?? null;
    },

    async setSong(guildId, song) {
      await sql`
        INSERT INTO scheduled_song_config (guild_id, song) VALUES (${guildId}, ${song})
        ON CONFLICT (guild_id) DO UPDATE SET song = EXCLUDED.song, updated_at = now()
      `;
    },

    async clearSong(guildId) {
      const deleted = await sql<ScheduledSongConfigRow[]>`
        DELETE FROM scheduled_song_config WHERE guild_id = ${guildId} RETURNING *
      `;
      return deleted.length > 0;
    },

    async listExcluded(guildId) {
      const rows = await sql<ScheduledSongExclusionRow[]>`
        SELECT * FROM scheduled_song_exclusion WHERE guild_id = ${guildId}
        ORDER BY created_at, channel_id
      `;
      return rows.map((row) => row.channel_id);
    },

    async addExcluded(guildId, channelId) {
      const inserted = await sql<ScheduledSongExclusionRow[]>`
        INSERT INTO scheduled_song_exclusion (guild_id, channel_id) VALUES (${guildId}, ${channelId})
        ON CONFLICT DO NOTHING RETURNING *
      `;
      return inserted.length > 0;
    },

    async removeExcluded(guildId, channelId) {
      const deleted = await sql<ScheduledSongExclusionRow[]>`
        DELETE FROM scheduled_song_exclusion
        WHERE guild_id = ${guildId} AND channel_id = ${channelId} RETURNING *
      `;
      return deleted.length > 0;
    },
  };
}
