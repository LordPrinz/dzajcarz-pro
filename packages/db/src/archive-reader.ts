import type { SQL } from "bun";
import type { ArchivedAuthor } from "./message-archive.ts";
import type { ArchivedMessageRow, ArchivedMessageVersionRow } from "./types.ts";

/** One stored message as the panel reads it. Attachments and embeds are stored JSON, checked by the reader. */
export interface StoredMessage {
  id: string;
  /** null: a DM. */
  guildId: string | null;
  channelId: string;
  author: ArchivedAuthor;
  content: string;
  attachments: unknown[];
  embeds: unknown[];
  replyToId: string | null;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
}

/** What a message said before one of its edits. */
export interface StoredVersion {
  content: string;
  attachments: unknown[];
  embeds: unknown[];
  /** When this version was written; null: the original message. */
  editedAt: Date | null;
  /** When the next edit replaced it. */
  replacedAt: Date;
}

/** Where a page starts: the latest messages, or next to a stored message of the same channel. */
export type PageCursor =
  | { kind: "latest" }
  | { kind: "before"; messageId: string }
  | { kind: "after"; messageId: string }
  | { kind: "around"; messageId: string };

export interface ArchivePage {
  /** Oldest first. */
  messages: StoredMessage[];
  hasOlder: boolean;
  hasNewer: boolean;
}

export interface ArchiveSearchQuery {
  /** Web-search syntax: words, "phrases", OR, -excluded. */
  text: string;
  /** A server, `"dm"` for DMs only, or undefined for everything. */
  scope?: { guildId: string } | "dm";
  channelId?: string;
  authorId?: string;
  from?: Date;
  to?: Date;
  /** Continue after this result (newest first). */
  before?: string;
  limit: number;
}

export interface ArchivedDm {
  channelId: string;
  /** The latest person (not a bot) who wrote there; null when only the bot did. */
  recipient: Omit<ArchivedAuthor, "bot"> | null;
  lastMessageId: string;
  lastMessageAt: Date;
}

export interface ArchiveReader {
  /** A page of one channel; null when the cursor's message is not stored in that channel. */
  page(channelId: string, cursor: PageCursor, limit: number): Promise<ArchivePage | null>;
  /** The server the channel's stored messages belong to (null: a DM); undefined when none is stored. */
  channelGuild(channelId: string): Promise<string | null | undefined>;
  /** Where a stored message lives; null when it is not stored. */
  messagePlace(messageId: string): Promise<{ guildId: string | null; channelId: string } | null>;
  /** The earlier versions of a message, oldest first; at most `MAX_VERSIONS`. */
  versions(messageId: string): Promise<StoredVersion[]>;
  /** Full-text search, newest first. */
  search(query: ArchiveSearchQuery): Promise<{ messages: StoredMessage[]; hasMore: boolean }>;
  /** The latest stored name of each author among `ids` who wrote anything. */
  authorNames(ids: readonly string[]): Promise<Map<string, string>>;
  /** DM conversations in the archive, most recently active first. */
  dmChannels(limit: number): Promise<ArchivedDm[]>;
}

export const MAX_VERSIONS = 100;

type MessageRow = Omit<ArchivedMessageRow, "archived_at">;

const COLUMNS = `
  m.message_id, m.guild_id, m.channel_id, m.author_id, m.author_username, m.author_display_name,
  m.author_avatar_url, m.author_bot, m.content, m.attachments, m.embeds, m.reply_to_id, m.created_at,
  m.edited_at, m.deleted_at`;

const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const toMessage = (row: MessageRow): StoredMessage => ({
  id: row.message_id,
  guildId: row.guild_id,
  channelId: row.channel_id,
  author: {
    id: row.author_id,
    username: row.author_username,
    displayName: row.author_display_name,
    avatarUrl: row.author_avatar_url,
    bot: row.author_bot,
  },
  content: row.content,
  attachments: array(row.attachments),
  embeds: array(row.embeds),
  replyToId: row.reply_to_id,
  createdAt: row.created_at,
  editedAt: row.edited_at,
  deletedAt: row.deleted_at,
});

export function createArchiveReader(sql: SQL): ArchiveReader {
  const columns = sql.unsafe(COLUMNS);

  /**
   * The cursor message's position, when it is stored in that channel. Every page query below then compares
   * plain values, with one statement per shape, so the planner uses the channel index even with a generic
   * plan (a `$1 IS NULL OR …` predicate would not).
   */
  const positionOf = async (channelId: string, messageId: string) => {
    const [row] = await sql<{ created_at: Date; message_id: string }[]>`
      SELECT created_at, message_id FROM archived_message
      WHERE message_id = ${messageId} AND channel_id = ${channelId}
    `;
    return row ?? null;
  };
  type Position = NonNullable<Awaited<ReturnType<typeof positionOf>>>;

  const latest = (channelId: string, limit: number) => sql<MessageRow[]>`
    SELECT ${columns} FROM archived_message m
    WHERE m.channel_id = ${channelId}
    ORDER BY m.created_at DESC, m.message_id DESC
    LIMIT ${limit}
  `;
  /** Older than the position (or at it too, `inclusive`), newest first. */
  const older = (channelId: string, at: Position, limit: number, inclusive = false) =>
    inclusive
      ? sql<MessageRow[]>`
          SELECT ${columns} FROM archived_message m
          WHERE m.channel_id = ${channelId}
            AND (m.created_at, m.message_id) <= (${at.created_at}::timestamptz, ${at.message_id}::text)
          ORDER BY m.created_at DESC, m.message_id DESC
          LIMIT ${limit}
        `
      : sql<MessageRow[]>`
          SELECT ${columns} FROM archived_message m
          WHERE m.channel_id = ${channelId}
            AND (m.created_at, m.message_id) < (${at.created_at}::timestamptz, ${at.message_id}::text)
          ORDER BY m.created_at DESC, m.message_id DESC
          LIMIT ${limit}
        `;
  /** Newer than the position, oldest first. */
  const newer = (channelId: string, at: Position, limit: number) => sql<MessageRow[]>`
    SELECT ${columns} FROM archived_message m
    WHERE m.channel_id = ${channelId}
      AND (m.created_at, m.message_id) > (${at.created_at}::timestamptz, ${at.message_id}::text)
    ORDER BY m.created_at, m.message_id
    LIMIT ${limit}
  `;

  return {
    async page(channelId, cursor, limit) {
      if (cursor.kind === "latest") {
        const rows = await latest(channelId, limit + 1);
        return {
          messages: rows.slice(0, limit).reverse().map(toMessage),
          hasOlder: rows.length > limit,
          hasNewer: false,
        };
      }
      const at = await positionOf(channelId, cursor.messageId);
      if (!at) return null;
      if (cursor.kind === "before") {
        const rows = await older(channelId, at, limit + 1);
        return {
          messages: rows.slice(0, limit).reverse().map(toMessage),
          hasOlder: rows.length > limit,
          hasNewer: true,
        };
      }
      if (cursor.kind === "after") {
        const rows = await newer(channelId, at, limit + 1);
        return {
          messages: rows.slice(0, limit).map(toMessage),
          hasOlder: true,
          hasNewer: rows.length > limit,
        };
      }
      // Around: the message and up to half a page before it, the rest after it.
      const half = Math.ceil(limit / 2);
      const [before, after] = await Promise.all([
        older(channelId, at, half + 1, true),
        newer(channelId, at, limit - half + 1),
      ]);
      return {
        messages: [
          ...before.slice(0, half).reverse().map(toMessage),
          ...after.slice(0, limit - half).map(toMessage),
        ],
        hasOlder: before.length > half,
        hasNewer: after.length > limit - half,
      };
    },

    async channelGuild(channelId) {
      const [row] = await sql<{ guild_id: string | null }[]>`
        SELECT guild_id FROM archived_message WHERE channel_id = ${channelId} LIMIT 1
      `;
      return row === undefined ? undefined : row.guild_id;
    },

    async messagePlace(messageId) {
      const [row] = await sql<{ guild_id: string | null; channel_id: string }[]>`
        SELECT guild_id, channel_id FROM archived_message WHERE message_id = ${messageId}
      `;
      return row ? { guildId: row.guild_id, channelId: row.channel_id } : null;
    },

    async versions(messageId) {
      const rows = await sql<ArchivedMessageVersionRow[]>`
        SELECT * FROM archived_message_version WHERE message_id = ${messageId}
        ORDER BY replaced_at, id
        LIMIT ${MAX_VERSIONS}
      `;
      return rows.map((row) => ({
        content: row.content,
        attachments: array(row.attachments),
        embeds: array(row.embeds),
        editedAt: row.edited_at,
        replacedAt: row.replaced_at,
      }));
    },

    async search(query) {
      // Only the filters that are set become predicates, so each combination gets a plan of its own.
      const where = [sql`m.search @@ websearch_to_tsquery('simple', ${query.text})`];
      if (query.scope === "dm") where.push(sql`m.guild_id IS NULL`);
      else if (query.scope) where.push(sql`m.guild_id = ${query.scope.guildId}`);
      if (query.channelId) where.push(sql`m.channel_id = ${query.channelId}`);
      if (query.authorId) where.push(sql`m.author_id = ${query.authorId}`);
      if (query.from) where.push(sql`m.created_at >= ${query.from}`);
      if (query.to) where.push(sql`m.created_at < ${query.to}`);
      if (query.before) {
        const [at] = await sql<{ created_at: Date; message_id: string }[]>`
          SELECT created_at, message_id FROM archived_message WHERE message_id = ${query.before}
        `;
        if (!at) return { messages: [], hasMore: false };
        where.push(
          sql`(m.created_at, m.message_id) < (${at.created_at}::timestamptz, ${at.message_id}::text)`,
        );
      }
      const conditions = where.reduce((all, next) => sql`${all} AND ${next}`);
      const rows = await sql<MessageRow[]>`
        SELECT ${columns} FROM archived_message m
        WHERE ${conditions}
        ORDER BY m.created_at DESC, m.message_id DESC
        LIMIT ${query.limit + 1}
      `;
      return {
        messages: rows.slice(0, query.limit).map(toMessage),
        hasMore: rows.length > query.limit,
      };
    },

    async authorNames(ids) {
      if (ids.length === 0) return new Map();
      const rows = await sql<{ author_id: string; name: string }[]>`
        SELECT DISTINCT ON (author_id)
          author_id, COALESCE(author_display_name, author_username) AS name
        FROM archived_message
        WHERE author_id = ANY(${[...ids]}::text[])
        ORDER BY author_id, created_at DESC
      `;
      return new Map(rows.map((row) => [row.author_id, row.name]));
    },

    async dmChannels(limit) {
      const rows = await sql<
        {
          channel_id: string;
          last_id: string;
          last_at: Date;
          author_id: string | null;
          author_username: string | null;
          author_display_name: string | null;
          author_avatar_url: string | null;
        }[]
      >`
        SELECT last.channel_id, last.last_id, last.last_at, r.author_id, r.author_username,
          r.author_display_name, r.author_avatar_url
        FROM (
          SELECT DISTINCT ON (channel_id)
            channel_id, message_id AS last_id, created_at AS last_at
          FROM archived_message
          WHERE guild_id IS NULL
          ORDER BY channel_id, created_at DESC, message_id DESC
        ) last
        LEFT JOIN LATERAL (
          SELECT author_id, author_username, author_display_name, author_avatar_url
          FROM archived_message
          WHERE channel_id = last.channel_id AND NOT author_bot
          ORDER BY created_at DESC
          LIMIT 1
        ) r ON true
        ORDER BY last.last_at DESC
        LIMIT ${limit}
      `;
      return rows.map((row) => ({
        channelId: row.channel_id,
        recipient:
          row.author_id === null
            ? null
            : {
                id: row.author_id,
                username: row.author_username ?? "",
                displayName: row.author_display_name,
                avatarUrl: row.author_avatar_url,
              },
        lastMessageId: row.last_id,
        lastMessageAt: row.last_at,
      }));
    },
  };
}
