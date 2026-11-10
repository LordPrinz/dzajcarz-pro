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

/** A message due now, with the date on its server's clock (the key that sends it once that day). */
export interface DueScheduledMessage extends ScheduledMessageRecord {
  /** `YYYY-MM-DD` in the server's time zone. */
  date: string;
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
  /**
   * At most `limit` messages, of every guild, whose time of day is the minute `at` falls on in that guild's
   * time zone (`guild_settings.time_zone`, else the repository's default zone).
   */
  due(at: Date, limit: number): Promise<DueScheduledMessage[]>;
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

export function createScheduledMessageRepository(
  sql: SQL,
  { defaultTimeZone }: { defaultTimeZone: string },
): ScheduledMessageRepository {
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

    async due(at, limit) {
      // Postgres turns the instant into each guild's wall clock, so one query serves every zone. A stored
      // zone Postgres does not know (its tzdata can lag the runtime's) counts as the default, so one bad row
      // cannot fail the query for every server.
      const rows = await sql<(ScheduledMessageRow & { local_date: string })[]>`
        WITH known AS MATERIALIZED (SELECT name FROM pg_timezone_names)
        SELECT m.*, to_char(local.at, 'YYYY-MM-DD') AS local_date
        FROM scheduled_message m
        LEFT JOIN guild_settings g ON g.guild_id = m.guild_id
        LEFT JOIN known k ON k.name = g.time_zone
        CROSS JOIN LATERAL (
          SELECT ${at}::timestamptz AT TIME ZONE coalesce(k.name, ${defaultTimeZone}) AS at
        ) local
        WHERE m.time_of_day = to_char(local.at, 'HH24:MI')
        ORDER BY m.guild_id, m.id
        LIMIT ${limit}
      `;
      return rows.map((row) => ({ ...toRecord(row), date: row.local_date }));
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
