import type { SQL } from "bun";
import type { BirthdayConfigRow, BirthdayRow } from "./types.ts";

export interface Birthday {
  month: number;
  day: number;
}

export interface BirthdayConfig {
  channelId: string;
  template: string;
}

/** Where wishes are recorded: a server's id, or `dm` for the direct message. */
export type WishTarget = string;

export interface BirthdayRepository {
  get(userId: string): Promise<Birthday | null>;
  /** Insert or replace the member's birthday. */
  set(userId: string, birthday: Birthday): Promise<void>;
  /** False when the member had no birthday saved. */
  remove(userId: string): Promise<boolean>;
  /** Members born on one of `days` of `month` who have no wish for `target` in `year` yet. */
  unwished(
    target: WishTarget,
    year: number,
    month: number,
    days: readonly number[],
  ): Promise<string[]>;
  /** Takes the wish before it is sent: true for exactly one caller per member, target and year. */
  claimWish(userId: string, target: WishTarget, year: number): Promise<boolean>;
  /** Undoes `claimWish` after a send that may work on a later try. */
  releaseWish(userId: string, target: WishTarget, year: number): Promise<void>;
  getConfig(guildId: string): Promise<BirthdayConfig | null>;
  /** Insert or replace the guild's config. */
  setConfig(guildId: string, config: BirthdayConfig): Promise<void>;
  /** False when the guild had no config. */
  deleteConfig(guildId: string): Promise<boolean>;
  /** Every guild's config. */
  configs(): Promise<(BirthdayConfig & { guildId: string })[]>;
}

export function createBirthdayRepository(sql: SQL): BirthdayRepository {
  return {
    async get(userId) {
      const [row] = await sql<BirthdayRow[]>`SELECT * FROM birthday WHERE user_id = ${userId}`;
      return row ? { month: row.month, day: row.day } : null;
    },

    async set(userId, { month, day }) {
      await sql`
        INSERT INTO birthday (user_id, month, day)
        VALUES (${userId}, ${month}, ${day})
        ON CONFLICT (user_id) DO UPDATE
          SET month = EXCLUDED.month, day = EXCLUDED.day, updated_at = now()
      `;
    },

    async remove(userId) {
      const deleted = await sql`DELETE FROM birthday WHERE user_id = ${userId} RETURNING 1`;
      return deleted.length > 0;
    },

    async unwished(target, year, month, days) {
      const rows = await sql<{ user_id: string }[]>`
        SELECT b.user_id FROM birthday b
        WHERE b.month = ${month} AND b.day = ANY(${[...days]}::int2[])
          AND NOT EXISTS (
            SELECT 1 FROM birthday_wish w
            WHERE w.user_id = b.user_id AND w.target = ${target} AND w.year = ${year}
          )
        ORDER BY b.user_id
      `;
      return rows.map((row) => row.user_id);
    },

    async claimWish(userId, target, year) {
      const inserted = await sql`
        INSERT INTO birthday_wish (user_id, target, year)
        VALUES (${userId}, ${target}, ${year})
        ON CONFLICT DO NOTHING
        RETURNING 1
      `;
      return inserted.length > 0;
    },

    async releaseWish(userId, target, year) {
      await sql`
        DELETE FROM birthday_wish
        WHERE user_id = ${userId} AND target = ${target} AND year = ${year}
      `;
    },

    async getConfig(guildId) {
      const [row] = await sql<BirthdayConfigRow[]>`
        SELECT * FROM birthday_config WHERE guild_id = ${guildId}
      `;
      return row ? { channelId: row.channel_id, template: row.template } : null;
    },

    async setConfig(guildId, { channelId, template }) {
      await sql`
        INSERT INTO birthday_config (guild_id, channel_id, template)
        VALUES (${guildId}, ${channelId}, ${template})
        ON CONFLICT (guild_id) DO UPDATE
          SET channel_id = EXCLUDED.channel_id, template = EXCLUDED.template, updated_at = now()
      `;
    },

    async deleteConfig(guildId) {
      const deleted =
        await sql`DELETE FROM birthday_config WHERE guild_id = ${guildId} RETURNING 1`;
      return deleted.length > 0;
    },

    async configs() {
      const rows = await sql<BirthdayConfigRow[]>`SELECT * FROM birthday_config ORDER BY guild_id`;
      return rows.map((row) => ({
        guildId: row.guild_id,
        channelId: row.channel_id,
        template: row.template,
      }));
    },
  };
}
