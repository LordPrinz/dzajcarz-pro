import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type { Guild } from "./api.ts";
import {
  clearQueue,
  enqueueTracks,
  FILTER_LABELS,
  fetchMusicState,
  fetchVoiceChannels,
  formatTime,
  joinVoice,
  LOOP_LABELS,
  type LoopMode,
  MAX_MUSIC_QUERY_LENGTH,
  MAX_MUSIC_VOLUME,
  MUSIC_ERRORS,
  MUSIC_QUEUE_PAGE,
  type MusicEvent,
  type MusicFilter,
  type MusicResult,
  type MusicSearch,
  type MusicSnapshot,
  type MusicTrackInfo,
  moveTrack,
  positionAt,
  removeTrack,
  searchMusic,
  sendControl,
  shuffleQueue,
  type VoiceChannelInfo,
} from "./music-api.ts";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** A slider's value goes to the bot once it has stopped moving for this long. */
const SLIDER_COMMIT_MS = 400;

export interface MusicViewProps {
  guilds: Guild[];
  botOnline: boolean;
  /** Puts the socket on one server's music topic (null: none). */
  watch: (guildId: string | null) => void;
  subscribe: (listener: (event: MusicEvent) => void) => () => void;
  /** Times the socket opened again; the view reloads the player on each. */
  reconnects: number;
  fetcher?: Fetch;
  now?: () => number;
}

function TrackLine({ track }: { track: MusicTrackInfo }) {
  const length = track.isStream ? "na żywo" : formatTime(track.durationMs);
  return (
    <span className="music-track">
      {track.uri ? (
        <a href={track.uri} target="_blank" rel="noopener noreferrer nofollow">
          {track.title}
        </a>
      ) : (
        track.title
      )}
      <span className="muted">
        {" "}
        · {track.author} · {length}
      </span>
    </span>
  );
}

/** Sends `value` once it has not changed for `SLIDER_COMMIT_MS`; `onCommit` is skipped while it is null. */
function useCommitted<T>(value: T | null, onCommit: (value: T) => void) {
  const commit = useRef(onCommit);
  commit.current = onCommit;
  useEffect(() => {
    if (value === null) return;
    const timer = setTimeout(() => commit.current(value), SLIDER_COMMIT_MS);
    return () => clearTimeout(timer);
  }, [value]);
}

/** The music player of one server (#148): the same player `/music` drives on Discord. */
export function MusicView({
  guilds,
  botOnline,
  watch,
  subscribe,
  reconnects,
  fetcher = fetch,
  now = Date.now,
}: MusicViewProps) {
  const [guildId, setGuildId] = useState(guilds[0]?.id ?? "");
  /** The player shown, and when this page got it (the position moves on from then). */
  const [view, setView] = useState<{ snapshot: MusicSnapshot; receivedAt: number } | null>(null);
  /** The bot's time of the newest snapshot shown; an older one arriving later is dropped. */
  const newest = useRef(Number.NEGATIVE_INFINITY);
  const [available, setAvailable] = useState(true);
  const [channels, setChannels] = useState<VoiceChannelInfo[] | null>(null);
  const [channelId, setChannelId] = useState("");
  const [offset, setOffset] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MusicSearch | null>(null);
  /** The key is the track that was dragged: a commit after the track changed must not seek the new one. */
  const [seekDraft, setSeekDraft] = useState<{ key: string; positionMs: number } | null>(null);
  const [volumeDraft, setVolumeDraft] = useState<number | null>(null);
  const [, setTick] = useState(0);
  // Read through refs, so a parent passing new functions on every render does not reload the player.
  const clock = useRef(now);
  clock.current = now;
  const follow = useRef(watch);
  follow.current = watch;
  const shown = useRef({ guildId, offset });
  shown.current = { guildId, offset };

  useEffect(() => {
    if (!guildId && guilds[0]) setGuildId(guilds[0].id);
  }, [guilds, guildId]);

  /** Shows a snapshot unless a newer one is shown already (a reply racing an event). */
  const show = useCallback((next: MusicSnapshot) => {
    if (next.guildId !== shown.current.guildId) return;
    const at = Date.parse(next.at);
    if (at < newest.current) return;
    newest.current = at;
    setView({ snapshot: next, receivedAt: clock.current() });
    setAvailable(next.available);
  }, []);

  const load = useCallback(
    async (guild: string, from: number) => {
      const result = await fetchMusicState(guild, from, fetcher);
      if (shown.current.guildId !== guild) return;
      if (result.ok) show(result.data);
      else setNotice(MUSIC_ERRORS[result.error]);
    },
    [fetcher, show],
  );

  // A new server: everything is read again.
  useEffect(() => {
    if (!guildId) return;
    follow.current(guildId);
    setView(null);
    newest.current = Number.NEGATIVE_INFINITY;
    setResults(null);
    setOffset(0);
    setNotice(null);
    setChannels(null);
    void load(guildId, 0);
    void fetchVoiceChannels(guildId, fetcher).then((result) => {
      if (shown.current.guildId === guildId) setChannels(result.ok ? result.data.channels : []);
    });
    return () => follow.current(null);
  }, [guildId, load, fetcher]);

  // A socket that came back may have missed events: the player is read again, the rest stays as it is.
  const seenReconnects = useRef(reconnects);
  useEffect(() => {
    if (reconnects === seenReconnects.current) return;
    seenReconnects.current = reconnects;
    if (guildId) void load(guildId, shown.current.offset);
  }, [reconnects, guildId, load]);

  useEffect(
    () =>
      subscribe((event) => {
        if (event.event === "music.status") {
          setAvailable(event.payload.available);
          return;
        }
        if (event.payload.guildId !== shown.current.guildId) return;
        // Events carry the first page of the queue; another page is read again.
        if (shown.current.offset === 0) show(event.payload);
        else void load(event.payload.guildId, shown.current.offset);
      }),
    [subscribe, load, show],
  );

  const player = view?.snapshot.player ?? null;
  const playing = Boolean(player?.current && !player.paused);
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [playing]);

  const playerChannel = player?.voiceChannelId ?? null;
  useEffect(() => {
    if (playerChannel) setChannelId(playerChannel);
  }, [playerChannel]);
  useEffect(() => {
    if (!channelId && channels) {
      const first = channels.find((channel) => channel.joinable);
      if (first) setChannelId(first.id);
    }
  }, [channels, channelId]);

  const disabled = !botOnline || !available || busy || !guildId;

  async function run<T>(action: () => Promise<MusicResult<T>>, after?: (data: T) => void) {
    setBusy(true);
    setNotice(null);
    const result = await action();
    setBusy(false);
    if (!result.ok) {
      setNotice(MUSIC_ERRORS[result.error]);
      return;
    }
    after?.(result.data);
    // The event brings the change too; this covers a socket that is down.
    void load(guildId, shown.current.offset);
  }

  const control = (value: Parameters<typeof sendControl>[1]) =>
    run(() => sendControl(guildId, value, fetcher));

  useCommitted(seekDraft, ({ key, positionMs }) => {
    setSeekDraft(null);
    void control({ action: "seek", key, positionMs });
  });
  useCommitted(volumeDraft, (percent) => {
    setVolumeDraft(null);
    void control({ action: "volume", percent });
  });

  const search = (event: FormEvent) => {
    event.preventDefault();
    const text = query.trim();
    if (!text) return;
    void run(() => searchMusic(guildId, text, fetcher), setResults);
  };

  const add = (picks: number[]) => {
    if (!results) return;
    void run(
      () =>
        enqueueTracks(
          guildId,
          { searchId: results.searchId, picks, ...(player ? {} : { channelId }) },
          fetcher,
        ),
      (added) => {
        if (added.skipped > 0) setNotice(`Dodano ${added.added}, kolejka jest pełna`);
      },
    );
  };

  const changePage = (next: number) => {
    setOffset(next);
    void load(guildId, next);
  };

  const current = player?.current ?? null;
  // Without a player the bot needs a voice channel to join.
  const noChannel = !player && channelId === "";
  const seeking = seekDraft && seekDraft.key === current?.key ? seekDraft.positionMs : null;
  const position = player && view ? positionAt(player, view.receivedAt, now()) : 0;
  const selected = channels?.find((channel) => channel.id === channelId);
  const queue = player?.queue;

  return (
    <section className="music" aria-label="Muzyka">
      <h2>Muzyka</h2>
      {!botOnline ? (
        <p className="notice notice-warn" role="status">
          Bot offline: sterowanie muzyką jest wyłączone.
        </p>
      ) : !available ? (
        <p className="notice notice-warn" role="status">
          Odtwarzacz muzyki jest niedostępny (Lavalink nie działa). Sterowanie jest wyłączone.
        </p>
      ) : null}
      {notice ? (
        <p className="notice notice-warn" role="alert">
          {notice}
        </p>
      ) : null}

      <div className="music-pickers">
        <label>
          Serwer{" "}
          <select value={guildId} onChange={(event) => setGuildId(event.target.value)}>
            {guilds.map((guild) => (
              <option key={guild.id} value={guild.id}>
                {guild.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Kanał głosowy{" "}
          <select
            value={channelId}
            onChange={(event) => setChannelId(event.target.value)}
            disabled={!channels || channels.length === 0}
          >
            {channels?.length === 0 ? <option value="">Brak kanałów</option> : null}
            {channels?.map((channel) => (
              <option key={channel.id} value={channel.id} disabled={!channel.joinable}>
                {channel.name} ({channel.listeners})
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={disabled || !selected?.joinable || channelId === playerChannel}
          onClick={() => void run(() => joinVoice(guildId, channelId, fetcher))}
        >
          {player ? "Przenieś tutaj" : "Dołącz"}
        </button>
      </div>

      <div className="music-now">
        {current ? (
          <>
            <p className="music-title">
              <TrackLine track={current} />
              {current.byBot ? <span className="music-badge">utwór bota</span> : null}
            </p>
            <div className="music-progress">
              <input
                type="range"
                aria-label="Pozycja"
                min={0}
                max={current.isStream ? 0 : current.durationMs}
                step={1000}
                value={seeking ?? position}
                disabled={disabled || current.isStream || !current.isSeekable}
                onChange={(event) =>
                  setSeekDraft({ key: current.key, positionMs: Number(event.target.value) })
                }
              />
              <span className="muted">
                {formatTime(seeking ?? position)} /{" "}
                {current.isStream ? "na żywo" : formatTime(current.durationMs)}
              </span>
            </div>
          </>
        ) : (
          <p className="muted">
            {player ? "Nic teraz nie gra." : "Bot nie jest na kanale głosowym tego serwera."}
          </p>
        )}
        {player ? (
          <div className="music-controls">
            <button
              type="button"
              disabled={disabled || !current}
              onClick={() => void control({ action: player.paused ? "resume" : "pause" })}
            >
              {player.paused ? "Wznów" : "Pauza"}
            </button>
            <button
              type="button"
              disabled={disabled || !current}
              onClick={() => current && void control({ action: "skip", key: current.key })}
            >
              Dalej
            </button>
            <button
              type="button"
              disabled={!botOnline || busy}
              onClick={() => void control({ action: "disconnect" })}
            >
              Rozłącz
            </button>
            <label>
              Pętla{" "}
              <select
                value={player.loop}
                disabled={disabled}
                onChange={(event) =>
                  void control({ action: "loop", mode: event.target.value as LoopMode })
                }
              >
                {Object.entries(LOOP_LABELS).map(([mode, label]) => (
                  <option key={mode} value={mode}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Filtr{" "}
              <select
                value={player.filter}
                disabled={disabled}
                onChange={(event) =>
                  void control({ action: "filter", filter: event.target.value as MusicFilter })
                }
              >
                {Object.entries(FILTER_LABELS).map(([filter, label]) => (
                  <option key={filter} value={filter}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Głośność {volumeDraft ?? player.volume}%{" "}
              <input
                type="range"
                min={0}
                max={MAX_MUSIC_VOLUME}
                value={volumeDraft ?? player.volume}
                disabled={disabled}
                onChange={(event) => setVolumeDraft(Number(event.target.value))}
              />
            </label>
          </div>
        ) : null}
      </div>

      <form className="music-search" onSubmit={search}>
        <input
          type="search"
          aria-label="Szukaj muzyki"
          placeholder="Szukaj na YouTube albo wklej link"
          maxLength={MAX_MUSIC_QUERY_LENGTH}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="submit" disabled={disabled || query.trim() === ""}>
          Szukaj
        </button>
      </form>
      {results ? (
        <div className="music-results">
          {results.kind === "playlist" ? (
            <p>
              Playlista <strong>{results.name}</strong> ({results.total}){" "}
              <button
                type="button"
                disabled={disabled || noChannel}
                onClick={() => add(Array.from({ length: results.total }, (_, i) => i))}
              >
                Dodaj wszystkie
              </button>
            </p>
          ) : null}
          {noChannel ? <p className="muted">Wybierz kanał głosowy, aby dodać utwory.</p> : null}
          <ul>
            {results.tracks.map((track, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: one search never changes, and a video can come twice.
              <li key={`${track.key}-${index}`}>
                <TrackLine track={track} />{" "}
                <button type="button" disabled={disabled || noChannel} onClick={() => add([index])}>
                  Dodaj
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {queue ? (
        <div className="music-queue">
          <h3>
            Kolejka ({queue.total}
            {queue.total > 0 ? ` · ${formatTime(queue.totalDurationMs)}` : ""})
          </h3>
          <p>
            <button
              type="button"
              disabled={disabled || queue.total < 2}
              onClick={() => void run(() => shuffleQueue(guildId, fetcher))}
            >
              Wymieszaj
            </button>{" "}
            <button
              type="button"
              disabled={disabled || queue.total === 0}
              onClick={() => void run(() => clearQueue(guildId, fetcher))}
            >
              Wyczyść
            </button>
          </p>
          {queue.total === 0 ? <p className="muted">Kolejka jest pusta.</p> : null}
          <ol start={queue.offset + 1}>
            {queue.tracks.map((track, i) => {
              const index = queue.offset + i;
              return (
                <li key={`${track.key}-${index}`}>
                  <TrackLine track={track} />{" "}
                  <button
                    type="button"
                    aria-label="W górę"
                    disabled={disabled || index === 0}
                    onClick={() =>
                      void run(() => moveTrack(guildId, index, index - 1, track.key, fetcher))
                    }
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label="W dół"
                    disabled={disabled || index === queue.total - 1}
                    onClick={() =>
                      void run(() => moveTrack(guildId, index, index + 1, track.key, fetcher))
                    }
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    aria-label="Usuń"
                    disabled={disabled}
                    onClick={() => void run(() => removeTrack(guildId, index, track.key, fetcher))}
                  >
                    ✕
                  </button>
                </li>
              );
            })}
          </ol>
          {queue.total > MUSIC_QUEUE_PAGE ? (
            <p>
              <button
                type="button"
                disabled={offset === 0}
                onClick={() => changePage(Math.max(0, offset - MUSIC_QUEUE_PAGE))}
              >
                Poprzednie
              </button>{" "}
              <button
                type="button"
                disabled={offset + MUSIC_QUEUE_PAGE >= queue.total}
                onClick={() => changePage(offset + MUSIC_QUEUE_PAGE)}
              >
                Następne
              </button>
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
