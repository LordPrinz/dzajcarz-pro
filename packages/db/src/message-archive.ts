import type { SQL } from "bun";

/** A file on a message, stored as a link and its metadata; the file itself stays on Discord's CDN. */
export interface ArchivedAttachment {
  id: string;
  name: string;
  url: string;
  contentType: string | null;
  size: number;
  width: number | null;
  height: number | null;
}

export interface ArchivedAuthor {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  bot: boolean;
}

/** One message as the archive stores it. */
export interface ArchivedMessageInput {
  id: string;
  /** null: a DM. */
  guildId: string | null;
  channelId: string;
  author: ArchivedAuthor;
  content: string;
  attachments: ArchivedAttachment[];
  /** Discord's embed JSON, as sent. */
  embeds: unknown[];
  replyToId: string | null;
  createdAt: Date;
  editedAt: Date | null;
}

export interface MessageArchiveRepository {
  /** Stores the messages that are not stored yet; returns how many were new. Never changes a stored row. */
  insertMissing(messages: readonly ArchivedMessageInput[]): Promise<number>;
  /**
   * Stores the message as it is now. When its content or attachments changed, the stored version moves to
   * the version history first; a change of embeds alone (a link preview arriving) updates it in place.
   * Returns whether a version was kept. Two edits of one message racing each other may both keep the same
   * previous version; Discord sends edits of one message in order, so that stays theoretical.
   */
  recordEdit(message: ArchivedMessageInput): Promise<boolean>;
  /** Sets `deleted_at` on the stored messages among `ids` that have none; returns how many. */
  markDeleted(ids: readonly string[], at: Date): Promise<number>;
  /** The oldest stored message of the channel, where "load older" continues from. */
  oldestInChannel(channelId: string): Promise<string | null>;
}

/** Postgres text cannot hold U+0000 and jsonb rejects `\u0000`; one such message would fail its whole batch. */
export const withoutNul = (text: string): string => text.replaceAll("\u0000", "");

/** JSON with U+0000 removed from every string value. */
export const jsonWithoutNul = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "string" ? withoutNul(item) : item,
  );

export function createMessageArchiveRepository(sql: SQL): MessageArchiveRepository {
  return {
    async insertMissing(messages) {
      if (messages.length === 0) return 0;
      // One statement for the whole page: no round trip per message.
      const rows = messages.map((m) => ({
        message_id: m.id,
        guild_id: m.guildId,
        channel_id: m.channelId,
        author_id: m.author.id,
        author_username: m.author.username,
        author_display_name: m.author.displayName,
        author_avatar_url: m.author.avatarUrl,
        author_bot: m.author.bot,
        content: m.content,
        attachments: m.attachments,
        embeds: m.embeds,
        reply_to_id: m.replyToId,
        created_at: m.createdAt.toISOString(),
        edited_at: m.editedAt?.toISOString() ?? null,
      }));
      const inserted = await sql`
        INSERT INTO archived_message (
          message_id, guild_id, channel_id, author_id, author_username, author_display_name,
          author_avatar_url, author_bot, content, attachments, embeds, reply_to_id, created_at, edited_at
        )
        SELECT * FROM jsonb_to_recordset(${jsonWithoutNul(rows)}::text::jsonb) AS m(
          message_id text, guild_id text, channel_id text, author_id text, author_username text,
          author_display_name text, author_avatar_url text, author_bot boolean, content text,
          attachments jsonb, embeds jsonb, reply_to_id text, created_at timestamptz,
          edited_at timestamptz
        )
        ON CONFLICT (message_id) DO NOTHING
        RETURNING 1
      `;
      return inserted.length;
    },

    async recordEdit(m) {
      const content = withoutNul(m.content);
      const attachments = jsonWithoutNul(m.attachments);
      const embeds = jsonWithoutNul(m.embeds);
      const [row] = await sql<{ versioned: boolean }[]>`
        WITH previous AS (
          SELECT content, attachments, embeds, edited_at FROM archived_message
          WHERE message_id = ${m.id}
        ), version AS (
          INSERT INTO archived_message_version (message_id, content, attachments, embeds, edited_at)
          SELECT ${m.id}, content, attachments, embeds, edited_at FROM previous
          WHERE (content, attachments) IS DISTINCT FROM (${content}, ${attachments}::text::jsonb)
          RETURNING 1
        )
        INSERT INTO archived_message (
          message_id, guild_id, channel_id, author_id, author_username, author_display_name,
          author_avatar_url, author_bot, content, attachments, embeds, reply_to_id, created_at, edited_at
        ) VALUES (
          ${m.id}, ${m.guildId}, ${m.channelId}, ${m.author.id}, ${m.author.username},
          ${m.author.displayName}, ${m.author.avatarUrl}, ${m.author.bot}, ${content},
          ${attachments}::text::jsonb, ${embeds}::text::jsonb, ${m.replyToId}, ${m.createdAt},
          ${m.editedAt}
        )
        ON CONFLICT (message_id) DO UPDATE SET
          content = EXCLUDED.content,
          attachments = EXCLUDED.attachments,
          embeds = EXCLUDED.embeds,
          edited_at = COALESCE(EXCLUDED.edited_at, archived_message.edited_at)
        RETURNING EXISTS (SELECT FROM version) AS versioned
      `;
      return row?.versioned === true;
    },

    async markDeleted(ids, at) {
      if (ids.length === 0) return 0;
      const rows = await sql`
        UPDATE archived_message SET deleted_at = ${at}
        WHERE message_id = ANY(${[...ids]}::text[]) AND deleted_at IS NULL
        RETURNING 1
      `;
      return rows.length;
    },

    async oldestInChannel(channelId) {
      const [row] = await sql<{ message_id: string }[]>`
        SELECT message_id FROM archived_message WHERE channel_id = ${channelId}
        ORDER BY created_at, message_id
        LIMIT 1
      `;
      return row?.message_id ?? null;
    },
  };
}
