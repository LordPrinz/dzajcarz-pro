import type { SQL } from "bun";
import type { ModerationActionRow } from "./types.ts";

export interface NewModerationAction {
  guildId: string;
  action: ModerationActionRow["action"];
  moderatorId: string;
  targetId: string | null;
  channelId: string | null;
  reason: string | null;
  durationMs: number | null;
  messageCount: number | null;
}

export interface StoredWarning {
  id: number;
  moderatorId: string;
  reason: string | null;
  createdAt: Date;
}

export interface ModerationRepository {
  record(entry: NewModerationAction): Promise<{ id: number }>;
  /** The user's warning count in the guild and the newest `limit` warnings, newest first. */
  warnings(
    guildId: string,
    userId: string,
    limit: number,
  ): Promise<{ total: number; recent: StoredWarning[] }>;
}

export function createModerationRepository(sql: SQL): ModerationRepository {
  return {
    async record(entry) {
      const [row] = await sql<Pick<ModerationActionRow, "id">[]>`
        INSERT INTO moderation_action
          (guild_id, action, moderator_id, target_id, channel_id, reason, duration_ms, message_count)
        VALUES (${entry.guildId}, ${entry.action}, ${entry.moderatorId}, ${entry.targetId},
          ${entry.channelId}, ${entry.reason}, ${entry.durationMs}, ${entry.messageCount})
        RETURNING id
      `;
      if (!row) throw new Error("INSERT INTO moderation_action returned no row");
      return { id: Number(row.id) };
    },

    async warnings(guildId, userId, limit) {
      const [counted] = await sql<{ total: string }[]>`
        SELECT count(*) AS total FROM moderation_action
        WHERE guild_id = ${guildId} AND target_id = ${userId} AND action = 'warn'
      `;
      const rows =
        limit > 0
          ? await sql<ModerationActionRow[]>`
              SELECT * FROM moderation_action
              WHERE guild_id = ${guildId} AND target_id = ${userId} AND action = 'warn'
              ORDER BY created_at DESC, id DESC
              LIMIT ${limit}
            `
          : [];
      return {
        total: Number(counted?.total ?? 0),
        recent: rows.map((row) => ({
          id: Number(row.id),
          moderatorId: row.moderator_id,
          reason: row.reason,
          createdAt: row.created_at,
        })),
      };
    },
  };
}
