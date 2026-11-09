import type { SQL } from "bun";
import type { DzajcoChannelConfigRow } from "./types.ts";

export interface DzajcoSettings {
  chancePercent: number;
  cooldownSeconds: number;
}

export interface DzajcoRepository {
  /** Null when the channel has no override (the module then uses its defaults). */
  get(guildId: string, channelId: string): Promise<DzajcoSettings | null>;
  /** Insert or replace the channel's override. */
  set(guildId: string, channelId: string, settings: DzajcoSettings): Promise<void>;
  /** False when the channel had no override. */
  clear(guildId: string, channelId: string): Promise<boolean>;
}

export function createDzajcoRepository(sql: SQL): DzajcoRepository {
  return {
    async get(guildId, channelId) {
      const [row] = await sql<DzajcoChannelConfigRow[]>`
        SELECT * FROM dzajco_channel_config
        WHERE guild_id = ${guildId} AND channel_id = ${channelId}
      `;
      return row
        ? { chancePercent: row.chance_percent, cooldownSeconds: row.cooldown_seconds }
        : null;
    },

    async set(guildId, channelId, { chancePercent, cooldownSeconds }) {
      await sql`
        INSERT INTO dzajco_channel_config (guild_id, channel_id, chance_percent, cooldown_seconds)
        VALUES (${guildId}, ${channelId}, ${chancePercent}, ${cooldownSeconds})
        ON CONFLICT (guild_id, channel_id) DO UPDATE
          SET chance_percent = EXCLUDED.chance_percent,
              cooldown_seconds = EXCLUDED.cooldown_seconds,
              updated_at = now()
      `;
    },

    async clear(guildId, channelId) {
      const deleted = await sql<DzajcoChannelConfigRow[]>`
        DELETE FROM dzajco_channel_config
        WHERE guild_id = ${guildId} AND channel_id = ${channelId}
        RETURNING *
      `;
      return deleted.length > 0;
    },
  };
}
