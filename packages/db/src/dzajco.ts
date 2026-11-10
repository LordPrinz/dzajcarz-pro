import type { SQL } from "bun";
import type { DzajcoChannelConfigRow } from "./types.ts";

export interface DzajcoSettings {
  chancePercent: number;
  cooldownSeconds: number;
}

/** `guildId` null is a DM with the bot. A row only matches the guild it was stored for. */
export interface DzajcoRepository {
  /** Null when the channel has no override (the module then uses its defaults). */
  get(guildId: string | null, channelId: string): Promise<DzajcoSettings | null>;
  /** Insert or replace the channel's override. */
  set(guildId: string | null, channelId: string, settings: DzajcoSettings): Promise<void>;
  /** False when the channel had no override. */
  clear(guildId: string | null, channelId: string): Promise<boolean>;
}

export function createDzajcoRepository(sql: SQL): DzajcoRepository {
  return {
    async get(guildId, channelId) {
      const [row] = await sql<DzajcoChannelConfigRow[]>`
        SELECT * FROM dzajco_channel_config
        WHERE channel_id = ${channelId} AND guild_id IS NOT DISTINCT FROM ${guildId}
      `;
      return row
        ? { chancePercent: row.chance_percent, cooldownSeconds: row.cooldown_seconds }
        : null;
    },

    async set(guildId, channelId, { chancePercent, cooldownSeconds }) {
      await sql`
        INSERT INTO dzajco_channel_config (guild_id, channel_id, chance_percent, cooldown_seconds)
        VALUES (${guildId}, ${channelId}, ${chancePercent}, ${cooldownSeconds})
        ON CONFLICT (channel_id) DO UPDATE
          SET guild_id = EXCLUDED.guild_id,
              chance_percent = EXCLUDED.chance_percent,
              cooldown_seconds = EXCLUDED.cooldown_seconds,
              updated_at = now()
      `;
    },

    async clear(guildId, channelId) {
      const deleted = await sql<DzajcoChannelConfigRow[]>`
        DELETE FROM dzajco_channel_config
        WHERE channel_id = ${channelId} AND guild_id IS NOT DISTINCT FROM ${guildId}
        RETURNING *
      `;
      return deleted.length > 0;
    },
  };
}
