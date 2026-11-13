import type { Logger } from "@dzajcarz/core";
import type {
  ArchiveReader,
  ArchiveSettingsRepository,
  PageCursor,
  StoredMessage,
} from "@dzajcarz/db";
import {
  type BotClient,
  type CommandResponse,
  discordAvatarUrl,
  emptyResolved,
  MAX_NAME_LENGTH,
  MAX_PAGE_MESSAGES,
  MAX_RESOLVED_NAME_LENGTH,
  mentionIds,
  mentionTexts,
  type PanelMessage,
  panelAttachments,
  panelEmbeds,
  type Resolved,
  Snowflake,
  toPanelMessage,
} from "@dzajcarz/web-protocol";
import { z } from "zod";
import type { AuditedResult } from "./audit.ts";
import { idParam, invalidId, readQuery } from "./http/params.ts";

export interface ReadingRouteDeps {
  bot: Pick<BotClient, "request">;
  /** The archive, read straight from Postgres so it reads while the bot is down. */
  archive: ArchiveReader;
  archiveSettings: Pick<ArchiveSettingsRepository, "findGuild" | "dmEnabled">;
  /** Whether the bot sent a heartbeat lately; names are not asked of a bot that is gone. */
  botOnline: () => boolean;
  logger: Logger;
  failure: (result: Extract<AuditedResult<unknown>, { ok: false }>) => Response;
}

/** Messages per page, from the archive and live alike. */
export const PAGE_SIZE = MAX_PAGE_MESSAGES;
/** Search results per page. */
export const SEARCH_PAGE_SIZE = 25;
/** Archived DM conversations listed next to the ones the bot knows. */
export const MAX_ARCHIVED_DMS = 100;
export const MAX_SEARCH_LENGTH = 200;

const GuildOrDm = z.union([Snowflake, z.literal("dm")]);

const MessagesQuery = z
  .object({
    /** The channel's server, or `dm`. */
    guild: GuildOrDm,
    /** A thread's parent channel: an excluded parent excludes its threads. */
    parent: Snowflake.optional(),
    before: Snowflake.optional(),
    after: Snowflake.optional(),
    around: Snowflake.optional(),
    /** Keep paging from where the shown pages came from, even if the settings changed meanwhile. */
    source: z.enum(["archive", "live"]).optional(),
  })
  .strict()
  .refine(
    (q) => [q.before, q.after, q.around].filter((value) => value !== undefined).length <= 1,
    "use at most one of before, after and around",
  );

/**
 * Whether web-search text has a word to look for. A query of only `-excluded` words would match nearly every
 * message and scan the whole archive, and one of only punctuation matches nothing.
 */
export function hasPositiveTerm(text: string): boolean {
  return (text.match(/-?"[^"]*"?|\S+/g) ?? []).some(
    (token) =>
      !token.startsWith("-") && token.toLowerCase() !== "or" && /[\p{L}\p{N}]/u.test(token),
  );
}

const SearchQuery = z
  .object({
    q: z
      .string()
      .trim()
      .min(1)
      .max(MAX_SEARCH_LENGTH)
      .refine(hasPositiveTerm, "the search needs at least one word that is not excluded"),
    guild: GuildOrDm.optional(),
    channel: Snowflake.optional(),
    author: Snowflake.optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    before: Snowflake.optional(),
  })
  .strict();

const databaseUnavailable = () => Response.json({ error: "database_unavailable" }, { status: 503 });

/** Postgres's code for a statement cut off by `statement_timeout` (migration 0017). */
const QUERY_CANCELED = "57014";

/** The answer for a failed archive read: a query that ran too long is told apart from a database that is down. */
function databaseFailure(error: unknown): Response {
  const code = (error as { errno?: unknown } | null)?.errno;
  return code === QUERY_CANCELED
    ? Response.json({ error: "query_timeout" }, { status: 503 })
    : databaseUnavailable();
}

const notArchived = () => Response.json({ error: "not_archived" }, { status: 409 });

/** Discord ids carry their creation time. */
const snowflakeTime = (id: string): number => Number((BigInt(id) >> 22n) + 1420070400000n);

/** Whether the archive holds this channel now, per the settings in Postgres. */
async function isArchived(
  settings: ReadingRouteDeps["archiveSettings"],
  guild: string,
  channelId: string,
  parentId: string | undefined,
): Promise<boolean> {
  if (guild === "dm") return settings.dmEnabled();
  const found = await settings.findGuild(guild);
  if (!found?.enabled) return false;
  const excluded = new Set(found.excludedChannelIds);
  return !excluded.has(channelId) && (parentId === undefined || !excluded.has(parentId));
}

/**
 * The reading endpoints (#146). They change nothing, so they are not audited. An archived channel reads from
 * Postgres; any other one is read live from Discord through the bot and stored nowhere.
 */
export function readingRoutes({
  bot,
  archive,
  archiveSettings,
  botOnline,
  logger,
  failure,
}: ReadingRouteDeps) {
  /**
   * Names for the ids the messages mention: from the bot when it answers (current names, roles, channels),
   * else from the archive's author snapshots. Never fails: an id without a name renders as unknown.
   */
  async function resolveNames(guildId: string | null, messages: PanelMessage[]): Promise<Resolved> {
    const ids = mentionIds(messages.flatMap(mentionTexts));
    const wanted = ids.users.length + ids.roles.length + ids.channels.length;
    const fromBot =
      wanted > 0 && botOnline() ? await bot.request("names.resolve", { guildId, ...ids }) : null;
    const resolved = fromBot?.ok ? fromBot.data : emptyResolved();
    const missing = ids.users.filter((id) => resolved.users[id] === undefined);
    if (missing.length > 0) {
      try {
        for (const [id, name] of await archive.authorNames(missing)) {
          resolved.users[id] = name.slice(0, MAX_RESOLVED_NAME_LENGTH);
        }
      } catch (error) {
        logger.warn("Could not read author names from the archive", { error });
      }
    }
    return resolved;
  }

  /** Roles and channels belong to a server, so each message is resolved against its own (a search spans many). */
  async function resolveByGuild(messages: PanelMessage[]): Promise<Resolved> {
    const byGuild = Map.groupBy(messages, (message) => message.guildId);
    const merged = emptyResolved();
    for (const part of await Promise.all(
      [...byGuild].map(([guildId, group]) => resolveNames(guildId, group)),
    )) {
      Object.assign(merged.users, part.users);
      Object.assign(merged.roles, part.roles);
      Object.assign(merged.channels, part.channels);
    }
    return merged;
  }

  const fromArchive = async (
    channelId: string,
    guild: string,
    cursor: PageCursor,
  ): Promise<Response> => {
    let page: Awaited<ReturnType<ArchiveReader["page"]>>;
    try {
      page = await archive.page(channelId, cursor, PAGE_SIZE);
    } catch (error) {
      logger.error("Could not read the archive", { error });
      return databaseFailure(error);
    }
    if (page === null) return Response.json({ error: "unknown_message" }, { status: 404 });
    const messages = page.messages.map(toPanelMessage);
    return Response.json({
      source: "archive",
      messages,
      resolved: await resolveNames(guild === "dm" ? null : guild, messages),
      hasOlder: page.hasOlder,
      hasNewer: page.hasNewer,
    });
  };

  const fromDiscord = async (channelId: string, before: string | undefined) => {
    const result = await bot.request("channel.messages", {
      channelId,
      limit: PAGE_SIZE,
      ...(before ? { before } : {}),
    });
    if (!result.ok) return failure(result);
    switch (result.data.status) {
      case "unknown_channel":
        return Response.json({ error: "unknown_channel" }, { status: 404 });
      case "no_access":
        return Response.json({ error: "no_access" }, { status: 403 });
      case "ok":
        return Response.json({
          source: "live",
          messages: result.data.messages,
          resolved: result.data.resolved,
          hasOlder: result.data.hasMore,
          hasNewer: false,
        });
    }
  };

  /**
   * Every archive read of a channel checks the settings first, with the server taken from the stored
   * messages rather than from the request. A thread's parent still comes from the request (the archive does not
   * store it); a wrong one can only hide or show a thread of an archived server.
   */
  const messages = async (request: Request) => {
    const channelId = idParam(request, "channelId");
    if (!channelId) return invalidId();
    const query = readQuery(request, MessagesQuery);
    if (!query.ok) return query.response;
    const { parent, before, after, around, source } = query.data;
    let guild: string;
    let archived: boolean;
    try {
      const stored = await archive.channelGuild(channelId);
      guild = stored === undefined ? query.data.guild : (stored ?? "dm");
      archived = await isArchived(archiveSettings, guild, channelId, parent);
    } catch (error) {
      logger.error("Could not read the archive settings", { error });
      return databaseFailure(error);
    }
    // Paging forward and jumping to a message (a search result) exist only in the archive.
    if (after || around) {
      if (!archived) return notArchived();
      return fromArchive(
        channelId,
        guild,
        after ? { kind: "after", messageId: after } : { kind: "around", messageId: around ?? "" },
      );
    }
    if (source === "live" || (source === undefined && !archived)) {
      return fromDiscord(channelId, before);
    }
    if (!archived) return notArchived();
    return fromArchive(
      channelId,
      guild,
      before ? { kind: "before", messageId: before } : { kind: "latest" },
    );
  };

  const versions = async (request: Request) => {
    const messageId = idParam(request, "messageId");
    if (!messageId) return invalidId();
    try {
      const place = await archive.messagePlace(messageId);
      if (!place) return Response.json({ error: "unknown_message" }, { status: 404 });
      if (!(await isArchived(archiveSettings, place.guildId ?? "dm", place.channelId, undefined))) {
        return notArchived();
      }
      const stored = await archive.versions(messageId);
      return Response.json({
        versions: stored.map((version) => ({
          content: version.content,
          attachments: panelAttachments(version.attachments),
          embeds: panelEmbeds(version.embeds),
          editedAt: version.editedAt?.toISOString() ?? null,
          replacedAt: version.replacedAt.toISOString(),
        })),
      });
    } catch (error) {
      logger.error("Could not read message versions", { error });
      return databaseFailure(error);
    }
  };

  /**
   * Search covers everything stored, also channels whose archive has been switched off since: their messages
   * stay in Postgres (ADR 9). Opening such a result is refused with `not_archived`.
   */
  const search = async (request: Request) => {
    const query = readQuery(request, SearchQuery);
    if (!query.ok) return query.response;
    const { q, guild, channel, author, from, to, before } = query.data;
    let found: { messages: StoredMessage[]; hasMore: boolean };
    try {
      found = await archive.search({
        text: q,
        scope: guild === undefined ? undefined : guild === "dm" ? "dm" : { guildId: guild },
        channelId: channel,
        authorId: author,
        from: from ? new Date(from) : undefined,
        to: to ? new Date(to) : undefined,
        before,
        limit: SEARCH_PAGE_SIZE,
      });
    } catch (error) {
      logger.error("Could not search the archive", { error });
      return databaseFailure(error);
    }
    const results = found.messages.map(toPanelMessage);
    const last = results.at(-1);
    return Response.json({
      results,
      resolved: await resolveByGuild(results),
      nextBefore: found.hasMore && last ? last.id : null,
    });
  };

  const dms = async () => {
    const [stored, live] = await Promise.all([
      archive.dmChannels(MAX_ARCHIVED_DMS).catch((error: unknown) => {
        logger.error("Could not read archived DMs", { error });
        return null;
      }),
      bot.request("dms.list", {}),
    ]);
    if (stored === null && !live.ok) return databaseUnavailable();
    type Entry = {
      channelId: string;
      recipient: CommandResponse<"dms.list">["channels"][number]["recipient"];
      lastActivity: number | null;
    };
    const byChannel = new Map<string, Entry>();
    for (const dm of stored ?? []) {
      byChannel.set(dm.channelId, {
        channelId: dm.channelId,
        recipient: dm.recipient && {
          id: dm.recipient.id,
          username: dm.recipient.username.slice(0, MAX_NAME_LENGTH),
          displayName: dm.recipient.displayName?.slice(0, MAX_NAME_LENGTH) ?? null,
          avatarUrl: discordAvatarUrl(dm.recipient.avatarUrl),
        },
        lastActivity: dm.lastMessageAt.getTime(),
      });
    }
    for (const dm of live.ok ? live.data.channels : []) {
      const known = byChannel.get(dm.channelId);
      const lastActivity = dm.lastMessageId ? snowflakeTime(dm.lastMessageId) : null;
      byChannel.set(dm.channelId, {
        channelId: dm.channelId,
        // The bot's copy is current; the archive's is the name at the last stored message.
        recipient: dm.recipient ?? known?.recipient ?? null,
        lastActivity: Math.max(lastActivity ?? 0, known?.lastActivity ?? 0) || null,
      });
    }
    const list = [...byChannel.values()].sort(
      (a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0),
    );
    return Response.json({
      dms: list.map((dm) => ({
        ...dm,
        lastActivity: dm.lastActivity === null ? null : new Date(dm.lastActivity).toISOString(),
      })),
      bot: live.ok ? "ok" : "unavailable",
      truncated: live.ok && live.data.truncated,
    });
  };

  return {
    "/api/dms": { GET: dms },
    "/api/channels/:channelId/messages": { GET: messages },
    "/api/messages/:messageId/versions": { GET: versions },
    "/api/search": { GET: search },
  };
}
