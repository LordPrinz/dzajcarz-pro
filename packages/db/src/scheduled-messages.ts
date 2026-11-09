import type { SQL } from "bun";
import type { ScheduledMessageOptOutRow, ScheduledMessageRow } from "./types.ts";

export type ScheduledMessageTarget =
  | { kind: "channel"; channelId: string }
  | { kind: "dm"; userId: string };

export interface ScheduledMessageRecord {
  id: number;
  guildId: string;
  /** `HH:MM`. */
  time: string;
  content: string;
  target: ScheduledMessageTarget;
  createdBy: string;
}

export interface ScheduledMessageLimits {
  perGuild: number;
  /** DM messages to one member from one guild. */
  perRecipient: number;
}

export type ScheduledMessageAddResult =
  | { status: "added"; message: ScheduledMessageRecord }
  | { status: "guild-full" }
  | { status: "recipient-full" }
  | { status: "duplicate" };

export interface ScheduledMessageRepository {
  /**
   * Stores the message unless the guild or the DM recipient is at its cap, or the same target already has a
   * message at that time. The checks and the insert hold a per-guild lock, so concurrent adds cannot overshoot.
   */
  add(
    message: Omit<ScheduledMessageRecord, "id">,
    limits: ScheduledMessageLimits,
  ): Promise<ScheduledMessageAddResult>;
  /** The guild's messages by time, then id. */
  list(guildId: string): Promise<ScheduledMessageRecord[]>;
  /** False when the guild has no message with that id. */
  remove(guildId: string, id: number): Promise<boolean>;
  /** Deletes every message of the guild; resolves how many there were. */
  removeGuild(guildId: string): Promise<number>;
  /** At most `limit` messages of every guild due at `time`, by guild and id. */
  due(time: string, limit: number): Promise<ScheduledMessageRecord[]>;
  /** `guildId` null means every server. False when it was already off. */
  optOut(userId: string, guildId: string | null): Promise<boolean>;
  /** Removes exactly that opt-out (null: only the every-server one). False when there was none. */
  optIn(userId: string, guildId: string | null): Promise<boolean>;
  /** True when the member opted out of this guild or of every server. */
  isOptedOut(userId: string, guildId: string): Promise<boolean>;
}

function toRecord(row: ScheduledMessageRow): ScheduledMessageRecord {
  return {
    id: Number(row.id),
    guildId: row.guild_id,
    time: row.time_of_day,
    content: row.content,
    target:
      row.channel_id !== null
        ? { kind: "channel", channelId: row.channel_id }
        : { kind: "dm", userId: row.user_id as string },
    createdBy: row.created_by,
  };
}

export function createScheduledMessageRepository(sql: SQL): ScheduledMessageRepository {
  return {
    async add({ guildId, time, content, target, createdBy }, limits) {
      const channelId = target.kind === "channel" ? target.channelId : null;
      const userId = target.kind === "dm" ? target.userId : null;
      return sql.begin(async (tx): Promise<ScheduledMessageAddResult> => {
        // Released at commit; adds to other guilds do not wait for it.
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`scheduled_message:${guildId}`}))`;
        const [counts] = await tx<{ guild: number; recipient: number; same: number }[]>`
          SELECT
            count(*)::int AS guild,
            (count(*) FILTER (WHERE user_id = ${userId}))::int AS recipient,
            (count(*) FILTER (
              WHERE time_of_day = ${time}
                AND channel_id IS NOT DISTINCT FROM ${channelId}
                AND user_id IS NOT DISTINCT FROM ${userId}
            ))::int AS same
          FROM scheduled_message WHERE guild_id = ${guildId}
        `;
        if ((counts?.same ?? 0) > 0) return { status: "duplicate" };
        if ((counts?.guild ?? 0) >= limits.perGuild) return { status: "guild-full" };
        if (userId !== null && (counts?.recipient ?? 0) >= limits.perRecipient) {
          return { status: "recipient-full" };
        }
        const [row] = await tx<ScheduledMessageRow[]>`
          INSERT INTO scheduled_message (guild_id, time_of_day, content, channel_id, user_id, created_by)
          VALUES (${guildId}, ${time}, ${content}, ${channelId}, ${userId}, ${createdBy})
          RETURNING *
        `;
        if (!row) throw new Error("INSERT … RETURNING returned no row");
        return { status: "added", message: toRecord(row) };
      });
    },

    async list(guildId) {
      const rows = await sql<ScheduledMessageRow[]>`
        SELECT * FROM scheduled_message WHERE guild_id = ${guildId} ORDER BY time_of_day, id
      `;
      return rows.map(toRecord);
    },

    async remove(guildId, id) {
      const deleted = await sql<ScheduledMessageRow[]>`
        DELETE FROM scheduled_message WHERE guild_id = ${guildId} AND id = ${id} RETURNING *
      `;
      return deleted.length > 0;
    },

    async removeGuild(guildId) {
      const deleted = await sql<{ id: string }[]>`
        DELETE FROM scheduled_message WHERE guild_id = ${guildId} RETURNING id
      `;
      return deleted.length;
    },

    async due(time, limit) {
      const rows = await sql<ScheduledMessageRow[]>`
        SELECT * FROM scheduled_message WHERE time_of_day = ${time} ORDER BY guild_id, id LIMIT ${limit}
      `;
      return rows.map(toRecord);
    },

    async optOut(userId, guildId) {
      const inserted = await sql<ScheduledMessageOptOutRow[]>`
        INSERT INTO scheduled_message_opt_out (user_id, guild_id) VALUES (${userId}, ${guildId})
        ON CONFLICT DO NOTHING RETURNING *
      `;
      return inserted.length > 0;
    },

    async optIn(userId, guildId) {
      const deleted = await sql<ScheduledMessageOptOutRow[]>`
        DELETE FROM scheduled_message_opt_out
        WHERE user_id = ${userId} AND guild_id IS NOT DISTINCT FROM ${guildId} RETURNING *
      `;
      return deleted.length > 0;
    },

    async isOptedOut(userId, guildId) {
      const [row] = await sql<{ opted_out: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM scheduled_message_opt_out
          WHERE user_id = ${userId} AND (guild_id = ${guildId} OR guild_id IS NULL)
        ) AS opted_out
      `;
      return row?.opted_out ?? false;
    },
  };
}
