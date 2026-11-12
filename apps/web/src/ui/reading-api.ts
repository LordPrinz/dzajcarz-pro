// The panel's reading endpoints (#146). The shapes mirror `@dzajcarz/web-protocol`; the page does not bundle
// zod, so they are declared here and the server is trusted to send what its schemas checked.

export interface PanelAuthor {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  bot: boolean;
}

export interface PanelAttachment {
  id: string;
  name: string;
  url: string | null;
  contentType: string | null;
  size: number;
  width: number | null;
  height: number | null;
}

export interface EmbedMedia {
  url: string;
  width: number | null;
  height: number | null;
}

export interface EmbedCard {
  title: string | null;
  description: string | null;
  url: string | null;
  color: number | null;
  authorName: string | null;
  providerName: string | null;
  footer: string | null;
  image: EmbedMedia | null;
  thumbnail: EmbedMedia | null;
  video: EmbedMedia | null;
  fields: { name: string; value: string; inline: boolean }[];
}

export interface PanelMessage {
  id: string;
  guildId: string | null;
  channelId: string;
  author: PanelAuthor;
  content: string;
  attachments: PanelAttachment[];
  embeds: EmbedCard[];
  replyToId: string | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  truncated: boolean;
}

export interface Resolved {
  users: Record<string, string>;
  roles: Record<string, { name: string; color: number | null }>;
  channels: Record<string, string>;
}

export const emptyResolved = (): Resolved => ({ users: {}, roles: {}, channels: {} });

/** Names from `next` win: they are newer. */
export const mergeResolved = (base: Resolved, next: Resolved): Resolved => ({
  users: { ...base.users, ...next.users },
  roles: { ...base.roles, ...next.roles },
  channels: { ...base.channels, ...next.channels },
});

/** Where a channel lives: a server (with the parent of a thread) or the DMs. */
export interface ChannelRef {
  id: string;
  /** null: a DM. */
  guildId: string | null;
  parentId?: string | null;
  name: string;
}

export interface MessagePage {
  source: "archive" | "live";
  messages: PanelMessage[];
  resolved: Resolved;
  hasOlder: boolean;
  hasNewer: boolean;
}

export type PageResult =
  | { ok: true; page: MessagePage }
  | {
      ok: false;
      error:
        | "unavailable"
        | "database"
        | "no_access"
        | "unknown_channel"
        | "unknown_message"
        | "not_archived"
        | "timeout"
        | "error";
    };

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export type Cursor = { before: string } | { after: string } | { around: string } | null;

/** Where a page must come from: the source of the pages already shown, so one view never mixes the two. */
export type Source = "archive" | "live";

export function messagesPath(channel: ChannelRef, cursor: Cursor, source?: Source): string {
  const params = new URLSearchParams({ guild: channel.guildId ?? "dm" });
  if (channel.parentId) params.set("parent", channel.parentId);
  if (cursor) for (const [key, value] of Object.entries(cursor)) params.set(key, value);
  if (source) params.set("source", source);
  return `/api/channels/${encodeURIComponent(channel.id)}/messages?${params}`;
}

async function errorOf(response: Response): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown };
  return typeof body.error === "string" ? body.error : "";
}

/** One page of a channel: from the archive or live, as the server decides unless `source` says. */
export async function fetchMessages(
  channel: ChannelRef,
  cursor: Cursor,
  { source, fetcher = fetch }: { source?: Source; fetcher?: Fetch } = {},
): Promise<PageResult> {
  try {
    const response = await fetcher(messagesPath(channel, cursor, source));
    if (response.ok) return { ok: true, page: (await response.json()) as MessagePage };
    const error = await errorOf(response);
    switch (error) {
      case "bot_unavailable":
      case "bot_timeout":
        return { ok: false, error: "unavailable" };
      case "database_unavailable":
        return { ok: false, error: "database" };
      case "query_timeout":
        return { ok: false, error: "timeout" };
      case "no_access":
      case "unknown_channel":
      case "unknown_message":
      case "not_archived":
        return { ok: false, error };
      default:
        return { ok: false, error: "error" };
    }
  } catch {
    return { ok: false, error: "error" };
  }
}

export interface MessageVersion {
  content: string;
  attachments: PanelAttachment[];
  embeds: EmbedCard[];
  editedAt: string | null;
  replacedAt: string;
}

/** The earlier versions of an archived message; null when they cannot be read. */
export async function fetchVersions(
  messageId: string,
  fetcher: Fetch = fetch,
): Promise<MessageVersion[] | null> {
  try {
    const response = await fetcher(`/api/messages/${encodeURIComponent(messageId)}/versions`);
    if (!response.ok) return null;
    const body = (await response.json()) as { versions?: MessageVersion[] };
    return Array.isArray(body.versions) ? body.versions : null;
  } catch {
    return null;
  }
}

export interface SearchFilters {
  q: string;
  /** A server id, `dm`, or empty for everything. */
  guild: string;
  channel: string;
  author: string;
  /** `YYYY-MM-DD` from a date input, or empty. */
  from: string;
  to: string;
}

export interface SearchPage {
  results: PanelMessage[];
  resolved: Resolved;
  nextBefore: string | null;
}

/** A local calendar day as the instant it starts; `plusDays` moves it. */
export function dayStart(day: string, plusDays = 0): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + plusDays);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function searchPath(filters: SearchFilters, before: string | null): string {
  const params = new URLSearchParams({ q: filters.q.trim() });
  if (filters.guild) params.set("guild", filters.guild);
  if (filters.channel) params.set("channel", filters.channel);
  if (filters.author) params.set("author", filters.author);
  const from = dayStart(filters.from);
  // The "to" day is included: the search ends where the next day starts.
  const to = dayStart(filters.to, 1);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (before) params.set("before", before);
  return `/api/search?${params}`;
}

export type SearchResult =
  | { ok: true; page: SearchPage }
  | { ok: false; error: "invalid" | "database" | "timeout" | "error" };

export async function searchArchive(
  filters: SearchFilters,
  before: string | null,
  fetcher: Fetch = fetch,
): Promise<SearchResult> {
  try {
    const response = await fetcher(searchPath(filters, before));
    if (response.ok) return { ok: true, page: (await response.json()) as SearchPage };
    if (response.status === 400) return { ok: false, error: "invalid" };
    if (response.status === 503) {
      const error = await errorOf(response);
      return { ok: false, error: error === "query_timeout" ? "timeout" : "database" };
    }
    return { ok: false, error: "error" };
  } catch {
    return { ok: false, error: "error" };
  }
}

export interface DmEntry {
  channelId: string;
  recipient: Omit<PanelAuthor, "bot"> | null;
  lastActivity: string | null;
}

export type DmsState =
  | { kind: "loading" }
  | { kind: "ready"; dms: DmEntry[]; botAvailable: boolean; truncated: boolean }
  | { kind: "error" };

export async function fetchDms(fetcher: Fetch = fetch): Promise<DmsState> {
  try {
    const response = await fetcher("/api/dms");
    if (!response.ok) return { kind: "error" };
    const body = (await response.json()) as { dms?: DmEntry[]; bot?: string; truncated?: boolean };
    return Array.isArray(body.dms)
      ? {
          kind: "ready",
          dms: body.dms,
          botAvailable: body.bot === "ok",
          truncated: body.truncated === true,
        }
      : { kind: "error" };
  } catch {
    return { kind: "error" };
  }
}

export const authorName = (author: Pick<PanelAuthor, "username" | "displayName">): string =>
  author.displayName ?? author.username;
