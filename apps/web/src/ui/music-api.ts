// The panel's music endpoints (#148). Like write-api.ts, the shapes mirror `@dzajcarz/web-protocol` without
// bundling zod; music-api.contract.test.ts keeps them in step.

export const MAX_MUSIC_VOLUME = 150;
export const MUSIC_QUEUE_PAGE = 20;
export const MAX_MUSIC_QUERY_LENGTH = 200;

export type LoopMode = "off" | "track" | "queue";
export type MusicFilter = "off" | "bassboost" | "nightcore" | "vaporwave" | "8d";

export const LOOP_LABELS: Record<LoopMode, string> = {
  off: "wyłączona",
  track: "utwór",
  queue: "kolejka",
};
export const FILTER_LABELS: Record<MusicFilter, string> = {
  off: "brak",
  bassboost: "bassboost",
  nightcore: "nightcore",
  vaporwave: "vaporwave",
  "8d": "8D",
};

export interface MusicTrackInfo {
  key: string;
  title: string;
  author: string;
  durationMs: number;
  uri: string | null;
  requesterId: string;
  byBot: boolean;
  isStream: boolean;
  isSeekable: boolean;
}

export interface MusicPlayerInfo {
  voiceChannelId: string;
  current: MusicTrackInfo | null;
  positionMs: number;
  paused: boolean;
  loop: LoopMode;
  volume: number;
  filter: MusicFilter;
  queue: { offset: number; total: number; totalDurationMs: number; tracks: MusicTrackInfo[] };
}

export interface MusicSnapshot {
  guildId: string;
  available: boolean;
  at: string;
  player: MusicPlayerInfo | null;
}

export interface VoiceChannelInfo {
  id: string;
  name: string;
  parentId: string | null;
  listeners: number;
  joinable: boolean;
}

export interface MusicSearch {
  searchId: string;
  kind: "tracks" | "playlist";
  name: string | null;
  total: number;
  tracks: MusicTrackInfo[];
}

export type MusicControl =
  | { action: "pause" }
  | { action: "resume" }
  | { action: "skip"; key: string }
  | { action: "seek"; key: string; positionMs: number }
  | { action: "loop"; mode: LoopMode }
  | { action: "volume"; percent: number }
  | { action: "filter"; filter: MusicFilter }
  | { action: "disconnect" };

/** Why an action did not happen; each has a Polish text in `MUSIC_ERRORS`. */
export type MusicError =
  | "bot_unavailable"
  | "audit_unavailable"
  | "invalid"
  | "error"
  | "unavailable"
  | "no_player"
  | "nothing_playing"
  | "unknown_channel"
  | "no_connect"
  | "queue_changed"
  | "track_changed"
  | "not_seekable"
  | "past_end"
  | "queue_full"
  | "search_expired"
  | "unsupported_link"
  | "not_found"
  | "load_failed"
  | "other_channel"
  | "search_busy"
  | "too_few_tracks"
  | "empty_queue";

export const MUSIC_ERRORS: Record<MusicError, string> = {
  bot_unavailable: "Bot niedostępny, nic nie zrobiono",
  audit_unavailable: "Dziennik zmian niedostępny, nic nie zrobiono",
  invalid: "Panel odrzucił to żądanie",
  error: "Coś poszło nie tak, spróbuj jeszcze raz",
  unavailable: "Odtwarzacz muzyki jest niedostępny (Lavalink nie działa)",
  no_player: "Bot nie jest na kanale głosowym tego serwera",
  nothing_playing: "Nic teraz nie gra",
  unknown_channel: "Bot nie widzi tego kanału głosowego",
  no_connect:
    "Bot nie może wejść na ten kanał, mówić na nim albo pisać na jego czacie (uprawnienia lub limit osób)",
  queue_changed: "Kolejka zmieniła się w międzyczasie, spróbuj jeszcze raz",
  track_changed: "Utwór zmienił się w międzyczasie, spróbuj jeszcze raz",
  not_seekable: "Tego utworu nie da się przewijać",
  past_end: "Utwór jest krótszy",
  queue_full: "Kolejka jest pełna (500 utworów)",
  search_expired: "Wyniki wyszukiwania wygasły, wyszukaj jeszcze raz",
  unsupported_link: "Obsługuję tylko linki z YouTube, Bandcamp, Twitch i Vimeo",
  not_found: "Nic nie znaleziono",
  load_failed: "Nie udało się wczytać tego utworu",
  other_channel: "Bot gra już na innym kanale tego serwera; najpierw przenieś go tutaj",
  search_busy: "Poprzednie wyszukiwania jeszcze trwają, spróbuj za chwilę",
  too_few_tracks: "W kolejce jest za mało utworów, żeby je pomieszać",
  empty_queue: "Kolejka jest pusta",
};

export type MusicResult<T> = { ok: true; data: T } | { ok: false; error: MusicError };

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const isMusicError = (value: unknown): value is MusicError =>
  typeof value === "string" && Object.hasOwn(MUSIC_ERRORS, value);

async function call<T>(
  method: string,
  path: string,
  body: unknown,
  fetcher: Fetch,
): Promise<MusicResult<T>> {
  try {
    const response = await fetcher(path, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    if (response.ok) return { ok: true, data: (await response.json()) as T };
    const answer = (await response.json().catch(() => ({}))) as {
      error?: string;
      reason?: string;
    };
    if (response.status === 422 && isMusicError(answer.reason)) {
      return { ok: false, error: answer.reason };
    }
    if (response.status === 503) {
      return {
        ok: false,
        error: answer.error === "audit_unavailable" ? "audit_unavailable" : "bot_unavailable",
      };
    }
    if (response.status === 400) return { ok: false, error: "invalid" };
    return { ok: false, error: "error" };
  } catch {
    return { ok: false, error: "error" };
  }
}

const base = (guildId: string) => `/api/music/${encodeURIComponent(guildId)}`;

export const fetchMusicState = (guildId: string, offset = 0, fetcher: Fetch = fetch) =>
  call<MusicSnapshot>("GET", `${base(guildId)}/state?offset=${offset}`, undefined, fetcher);

export const fetchVoiceChannels = (guildId: string, fetcher: Fetch = fetch) =>
  call<{ channels: VoiceChannelInfo[]; truncated: boolean }>(
    "GET",
    `${base(guildId)}/voice-channels`,
    undefined,
    fetcher,
  );

export const searchMusic = (guildId: string, query: string, fetcher: Fetch = fetch) =>
  call<MusicSearch>(
    "GET",
    `${base(guildId)}/search?q=${encodeURIComponent(query)}`,
    undefined,
    fetcher,
  );

type Done = { status: "ok" };

export const joinVoice = (guildId: string, channelId: string, fetcher: Fetch = fetch) =>
  call<Done>("POST", `${base(guildId)}/join`, { channelId }, fetcher);

export const enqueueTracks = (
  guildId: string,
  body: { searchId: string; picks: number[]; channelId?: string },
  fetcher: Fetch = fetch,
) =>
  call<{ status: "ok"; added: number; skipped: number }>(
    "POST",
    `${base(guildId)}/queue`,
    body,
    fetcher,
  );

export const removeTrack = (guildId: string, index: number, key: string, fetcher: Fetch = fetch) =>
  call<Done>("POST", `${base(guildId)}/queue/remove`, { index, key }, fetcher);

export const moveTrack = (
  guildId: string,
  from: number,
  to: number,
  key: string,
  fetcher: Fetch = fetch,
) => call<Done>("POST", `${base(guildId)}/queue/move`, { from, to, key }, fetcher);

export const shuffleQueue = (guildId: string, fetcher: Fetch = fetch) =>
  call<Done>("POST", `${base(guildId)}/queue/shuffle`, {}, fetcher);

export const clearQueue = (guildId: string, fetcher: Fetch = fetch) =>
  call<Done>("DELETE", `${base(guildId)}/queue`, undefined, fetcher);

export const sendControl = (guildId: string, control: MusicControl, fetcher: Fetch = fetch) =>
  call<Done>("POST", `${base(guildId)}/control`, control, fetcher);

/**
 * Where the track is now: the bot's position moved on by the time since this page received it (`receivedAt`,
 * the browser's clock, so a clock that differs from the bot's does not matter), unless paused.
 */
export function positionAt(player: MusicPlayerInfo, receivedAt: number, now: number): number {
  const position = player.positionMs + (player.paused ? 0 : Math.max(0, now - receivedAt));
  const current = player.current;
  return current && !current.isStream ? Math.min(position, current.durationMs) : position;
}

/** 3:05, 1:02:03. */
export function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** A live music event from the socket, or null for anything else. */
export type MusicEvent =
  | { event: "music.state"; payload: MusicSnapshot }
  | { event: "music.status"; payload: { available: boolean } };

export function parseMusicEvent(data: unknown): MusicEvent | null {
  const value = data as { event?: unknown; payload?: unknown } | null;
  if (typeof value?.payload !== "object" || value.payload === null) return null;
  if (
    value.event === "music.state" &&
    typeof (value.payload as MusicSnapshot).guildId === "string"
  ) {
    return value as MusicEvent;
  }
  if (
    value.event === "music.status" &&
    typeof (value.payload as { available?: unknown }).available === "boolean"
  ) {
    return value as MusicEvent;
  }
  return null;
}
