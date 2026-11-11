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

/** A message due now, with today's date on its server's clock (what `claim` stores). */
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
   * At most `limit` messages, of every guild, whose time of day has passed at `at` on a date later than the
   * one they last went out, on the guild's own clock (`guild_settings.time_zone`, else the repository's
   * default zone). When there are more than `limit`, every guild gets one message before any gets a second,
   * and the guilds are picked in random order.
   */
  due(at: Date, limit: number): Promise<DueScheduledMessage[]>;
  /**
   * Takes the message for that local date before it is sent, atomically: true for exactly one caller, and
   * only while the stored date is earlier. A claimed message is not due again that day.
   */
  claim(id: number, date: string): Promise<boolean>;
  /** Undoes `claim(id, date)` after a failed send, so the message is due again. */
  release(id: number, date: string): Promise<void>;
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
        // A time that has already passed today starts with today's date, so adding "19:00" at 20:00 waits
        // for tomorrow instead of sending at once.
        const [row] = await tx<ScheduledMessageRow[]>`
          INSERT INTO scheduled_message
            (guild_id, time_of_day, content, channel_id, user_id, created_by, last_sent_date)
          SELECT ${guildId}, ${time}, ${content}, ${channelId}, ${userId}, ${createdBy},
            CASE WHEN to_char(local.at, 'HH24:MI') >= ${time} THEN local.at::date END
          FROM (
            SELECT now() AT TIME ZONE coalesce(
              (SELECT time_zone FROM guild_settings WHERE guild_id = ${guildId}), ${defaultTimeZone}
            ) AS at
          ) local
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
      // Postgres turns the instant into each guild's wall clock, so one query serves every zone. Zones are
      // checked when /timezone writes them. `turn` numbers a guild's due messages, so a backlog bigger than
      // the limit is cut by rounds instead of serving the same guilds first every minute.
      const rows = await sql<(ScheduledMessageRow & { local_date: string })[]>`
        SELECT * FROM (
          SELECT * FROM (
            SELECT m.*, to_char(local.at, 'YYYY-MM-DD') AS local_date,
              row_number() OVER (PARTITION BY m.guild_id ORDER BY m.id) AS turn
            FROM scheduled_message m
            LEFT JOIN guild_settings g ON g.guild_id = m.guild_id
            CROSS JOIN LATERAL (
              SELECT ${at}::timestamptz AT TIME ZONE coalesce(g.time_zone, ${defaultTimeZone}) AS at
            ) local
            WHERE to_char(local.at, 'HH24:MI') >= m.time_of_day
              AND (m.last_sent_date IS NULL OR local.at::date > m.last_sent_date)
          ) candidates
          ORDER BY turn, random()
          LIMIT ${limit}
        ) picked
        ORDER BY guild_id, id
      `;
      return rows.map((row) => ({ ...toRecord(row), date: row.local_date }));
    },

    async claim(id, date) {
      const claimed = await sql`
        UPDATE scheduled_message SET last_sent_date = ${date}::date
        WHERE id = ${id} AND (last_sent_date IS NULL OR last_sent_date < ${date}::date)
        RETURNING id
      `;
      return claimed.length > 0;
    },

    async release(id, date) {
      // Any earlier date makes the message due again; the one it had before the claim was earlier too.
      await sql`
        UPDATE scheduled_message SET last_sent_date = ${date}::date - 1
        WHERE id = ${id} AND last_sent_date = ${date}::date
      `;
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
