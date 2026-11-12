export interface Guild {
  id: string;
  name: string;
  iconUrl: string | null;
  memberCount: number;
}

/** What the server list shows: the page renders one of these and nothing else. */
export type GuildsState =
  | { kind: "loading" }
  | { kind: "ready"; guilds: Guild[] }
  | { kind: "unavailable" }
  | { kind: "error" };

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** `/api/guilds`: 200 is the list, 503 means the bot did not answer (absent or too slow), the rest is an error. */
export async function fetchGuilds(fetcher: Fetch = fetch): Promise<GuildsState> {
  try {
    const response = await fetcher("/api/guilds");
    if (response.status === 503) return { kind: "unavailable" };
    if (!response.ok) return { kind: "error" };
    const body = (await response.json()) as { guilds?: Guild[] };
    return Array.isArray(body.guilds) ? { kind: "ready", guilds: body.guilds } : { kind: "error" };
  } catch {
    return { kind: "error" };
  }
}

/** `/api/status`: whether the bot has sent a heartbeat lately. Null when the panel itself cannot be asked. */
export async function fetchBotOnline(fetcher: Fetch = fetch): Promise<boolean | null> {
  try {
    const response = await fetcher("/api/status");
    if (!response.ok) return null;
    const body = (await response.json()) as { bot?: string };
    return body.bot === "online";
  } catch {
    return null;
  }
}

export interface GuildArchiveSettings {
  guildId: string;
  enabled: boolean;
  excludedChannelIds: string[];
}

export interface ArchiveSettings {
  dm: { enabled: boolean };
  guilds: GuildArchiveSettings[];
}

export interface ChannelSummary {
  id: string;
  name: string;
  kind: "text" | "announcement" | "voice" | "stage" | "forum" | "media" | "thread";
  parentId: string | null;
}

export type ChannelsState =
  | { kind: "loading" }
  | { kind: "ready"; channels: ChannelSummary[]; truncated: boolean }
  | { kind: "unavailable" }
  | { kind: "error" };

export type BackfillResult =
  | { status: "ok"; fetched: number; stored: number; oldestId: string | null; done: boolean }
  | { status: "not_archived" | "unknown_channel" | "no_access" };

/** A change made through the panel: what the bot answered, or why it did not happen. */
export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: "unavailable" | "audit_unavailable" | "error" };

/** `/api/archive/settings`, read from the database; null when it cannot be read. */
export async function fetchArchiveSettings(
  fetcher: Fetch = fetch,
): Promise<ArchiveSettings | null> {
  try {
    const response = await fetcher("/api/archive/settings");
    if (!response.ok) return null;
    const body = (await response.json()) as Partial<ArchiveSettings>;
    return body.dm && Array.isArray(body.guilds) ? { dm: body.dm, guilds: body.guilds } : null;
  } catch {
    return null;
  }
}

/** The channels of one server, from the bot. */
export async function fetchChannels(
  guildId: string,
  fetcher: Fetch = fetch,
): Promise<ChannelsState> {
  try {
    const response = await fetcher(`/api/guilds/${encodeURIComponent(guildId)}/channels`);
    if (response.status === 503) return { kind: "unavailable" };
    if (!response.ok) return { kind: "error" };
    const body = (await response.json()) as { channels?: ChannelSummary[]; truncated?: boolean };
    return Array.isArray(body.channels)
      ? { kind: "ready", channels: body.channels, truncated: body.truncated === true }
      : { kind: "error" };
  } catch {
    return { kind: "error" };
  }
}

async function send<T>(
  method: string,
  path: string,
  body: unknown,
  fetcher: Fetch,
): Promise<ActionResult<T>> {
  try {
    const response = await fetcher(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.ok) return { ok: true, data: (await response.json()) as T };
    if (response.status === 503) {
      const answer = (await response.json().catch(() => ({}))) as { error?: string };
      return {
        ok: false,
        error: answer.error === "audit_unavailable" ? "audit_unavailable" : "unavailable",
      };
    }
    return { ok: false, error: "error" };
  } catch {
    return { ok: false, error: "error" };
  }
}

export const saveGuildArchive = (
  guildId: string,
  settings: Omit<GuildArchiveSettings, "guildId">,
  fetcher: Fetch = fetch,
) =>
  send<GuildArchiveSettings>(
    "PUT",
    `/api/archive/guilds/${encodeURIComponent(guildId)}`,
    settings,
    fetcher,
  );

export const saveDmArchive = (enabled: boolean, fetcher: Fetch = fetch) =>
  send<{ enabled: boolean }>("PUT", "/api/archive/dm", { enabled }, fetcher);

/** "Wczytaj starsze": one bounded run; call again to go further back. */
export const backfillChannel = (channelId: string, fetcher: Fetch = fetch) =>
  send<BackfillResult>(
    "POST",
    `/api/archive/channels/${encodeURIComponent(channelId)}/backfill`,
    {},
    fetcher,
  );
