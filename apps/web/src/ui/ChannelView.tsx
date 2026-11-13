import { useCallback, useEffect, useRef, useState } from "react";
import { backfillChannel } from "./api.ts";
import { Composer } from "./Composer.tsx";
import { Message } from "./Message.tsx";
import { MessageActions } from "./MessageActions.tsx";
import {
  type ChannelRef,
  type Cursor,
  fetchMessages,
  type PageResult,
  type PanelMessage,
} from "./reading-api.ts";
import {
  applyLiveEvent,
  eventChannel,
  type LiveEvent,
  type Timeline,
  timelineOf,
  withLatest,
  withNewer,
  withOlder,
} from "./timeline.ts";
import { VirtualList } from "./VirtualList.tsx";
import { type ChannelInfo, fetchChannelInfo } from "./write-api.ts";

type ViewState =
  | { kind: "loading" }
  | { kind: "ready"; timeline: Timeline }
  | { kind: "failed"; error: Extract<PageResult, { ok: false }>["error"] };

const ERRORS: Record<Extract<PageResult, { ok: false }>["error"], string> = {
  unavailable: "Bot niedostępny: ten kanał jest poza archiwum, więc czyta się go przez bota",
  database: "Archiwum jest niedostępne",
  no_access: "Bot nie ma dostępu do tego kanału",
  unknown_channel: "Bot nie widzi tego kanału",
  unknown_message: "Tej wiadomości nie ma w archiwum",
  not_archived: "Ten kanał nie jest już archiwizowany",
  timeout: "Archiwum odpowiadało za długo, spróbuj jeszcze raz",
  error: "Nie udało się wczytać wiadomości",
};

export interface ChannelViewProps {
  channel: ChannelRef;
  /** Open around this message (a search result) instead of at the latest one. */
  focusId?: string | null;
  /** Registers the listener for live events; returns a function that removes it. */
  subscribe: (listener: (event: LiveEvent) => void) => () => void;
  /** Goes up each time the socket comes back: events sent while it was down were missed. */
  reconnects?: number;
  /** Whether the bot is up; what it may do here is asked again when it comes back. */
  botOnline?: boolean;
}

/** One channel or DM: pages from the archive or live from Discord, and live events on top. */
export function ChannelView({
  channel,
  focusId = null,
  subscribe,
  reconnects = 0,
  botOnline = true,
}: ChannelViewProps) {
  const [state, setState] = useState<ViewState>({ kind: "loading" });
  const [busy, setBusy] = useState<"older" | "newer" | "backfill" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** What the bot may do here, for the composer and the message actions; null while unknown. */
  const [info, setInfo] = useState<ChannelInfo | null>(null);
  const [replyTo, setReplyTo] = useState<PanelMessage | null>(null);
  const busyRef = useRef(false);
  /** Events that arrive while the first page loads, applied once it is there. */
  const early = useRef<LiveEvent[]>([]);
  /** Whether the first page is still loading; read by the event listener, outside any state update. */
  const loading = useRef(true);

  useEffect(() => {
    let cancelled = false;
    early.current = [];
    loading.current = true;
    setState({ kind: "loading" });
    setNotice(null);
    void fetchMessages(channel, focusId ? { around: focusId } : null).then((result) => {
      if (cancelled) return;
      loading.current = false;
      if (!result.ok) {
        setState({ kind: "failed", error: result.error });
        return;
      }
      let timeline = timelineOf(result.page);
      for (const event of early.current) timeline = applyLiveEvent(timeline, event);
      early.current = [];
      setState({ kind: "ready", timeline });
    });
    return () => {
      cancelled = true;
    };
  }, [channel, focusId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: another channel is the reason to reset.
  useEffect(() => {
    setInfo(null);
    setReplyTo(null);
  }, [channel.id]);

  // Asked again when the bot comes back or the socket reopens: a bot that was down on the first try
  // leaves no "Edytuj" and the default upload limit until then.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a reconnect is the reason to ask again.
  useEffect(() => {
    if (!botOnline) return;
    let cancelled = false;
    void fetchChannelInfo(channel.id).then((result) => {
      if (!cancelled && result.ok) setInfo(result.data);
    });
    return () => {
      cancelled = true;
    };
  }, [channel.id, botOnline, reconnects]);

  useEffect(
    () =>
      subscribe((event) => {
        if (eventChannel(event) !== channel.id) return;
        if (loading.current) {
          early.current.push(event);
          return;
        }
        setState((current) =>
          current.kind === "ready"
            ? { kind: "ready", timeline: applyLiveEvent(current.timeline, event) }
            : current,
        );
      }),
    [subscribe, channel.id],
  );

  const timeline = state.kind === "ready" ? state.timeline : null;

  const load = useCallback(
    async (direction: "older" | "newer") => {
      if (!timeline || busyRef.current) return;
      const edge = direction === "older" ? timeline.messages[0] : timeline.messages.at(-1);
      if (!edge) return;
      if (direction === "older" ? !timeline.hasOlder : !timeline.hasNewer) return;
      busyRef.current = true;
      setBusy(direction);
      const cursor: Cursor = direction === "older" ? { before: edge.id } : { after: edge.id };
      // Older pages come from where the shown ones came from; newer ones exist only in the archive.
      const result = await fetchMessages(channel, cursor, { source: timeline.source });
      busyRef.current = false;
      setBusy(null);
      if (!result.ok) {
        setNotice(ERRORS[result.error]);
        return;
      }
      setState((current) =>
        current.kind === "ready"
          ? {
              kind: "ready",
              timeline: (direction === "older" ? withOlder : withNewer)(
                current.timeline,
                result.page,
              ),
            }
          : current,
      );
    },
    [channel, timeline],
  );

  // After a reconnect the missed messages are fetched when the view shows the latest end; a view opened
  // around a search result cannot join them, so it says so instead.
  const seenReconnects = useRef(reconnects);
  useEffect(() => {
    if (reconnects === seenReconnects.current) return;
    // Not counted while the first page is loading: the gap is fetched once the timeline is there.
    if (!timeline) return;
    seenReconnects.current = reconnects;
    if (timeline.hasNewer) {
      setNotice("Połączenie wznowione: odśwież, aby zobaczyć nowe wiadomości");
      return;
    }
    void fetchMessages(channel, null, { source: timeline.source }).then((result) => {
      if (!result.ok) return;
      setState((current) =>
        current.kind === "ready"
          ? { kind: "ready", timeline: withLatest(current.timeline, result.page) }
          : current,
      );
    });
  }, [reconnects, timeline, channel]);

  /** Asks the bot to store older messages from Discord, then shows them. */
  const backfill = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy("backfill");
    const result = await backfillChannel(channel.id);
    busyRef.current = false;
    setBusy(null);
    if (!result.ok) {
      setNotice(
        result.error === "audit_unavailable"
          ? "Dziennik zmian niedostępny, nic nie zrobiono"
          : "Bot niedostępny",
      );
      return;
    }
    if (result.data.status !== "ok") {
      setNotice("Tego kanału nie da się uzupełnić");
      return;
    }
    if (result.data.stored === 0 && result.data.done) {
      setNotice("To już początek kanału");
      return;
    }
    const first = timeline?.messages[0];
    const page = await fetchMessages(channel, first ? { before: first.id } : null, {
      source: "archive",
    });
    if (page.ok) {
      setState((current) =>
        current.kind === "ready"
          ? { kind: "ready", timeline: withOlder(current.timeline, page.page) }
          : { kind: "ready", timeline: timelineOf(page.page) },
      );
    }
  };

  if (state.kind === "loading") return <p className="notice">Ładowanie wiadomości…</p>;
  if (state.kind === "failed") {
    return (
      <p className="notice notice-warn" role="alert">
        {ERRORS[state.error]}
      </p>
    );
  }
  const { messages, resolved, source, hasOlder, hasNewer } = state.timeline;
  const archived = source === "archive";
  return (
    <section className="channel-view" aria-label={channel.name}>
      <header className="channel-head">
        <h2>{channel.guildId ? `#${channel.name}` : channel.name}</h2>
        <span className={archived ? "tag" : "tag tag-live"}>
          {archived ? "archiwum" : "na żywo, bez zapisu"}
        </span>
        {hasOlder ? (
          <button type="button" disabled={busy !== null} onClick={() => void load("older")}>
            {busy === "older" ? "Ładowanie…" : "Starsze"}
          </button>
        ) : archived ? (
          <button type="button" disabled={busy !== null} onClick={() => void backfill()}>
            {busy === "backfill" ? "Pobieranie…" : "Wczytaj starsze z Discorda"}
          </button>
        ) : null}
        {hasNewer ? (
          <button type="button" disabled={busy !== null} onClick={() => void load("newer")}>
            {busy === "newer" ? "Ładowanie…" : "Nowsze"}
          </button>
        ) : null}
      </header>
      {notice ? (
        <p className="notice notice-warn" role="status">
          {notice}
        </p>
      ) : null}
      {messages.length === 0 ? (
        <p className="notice">Brak wiadomości</p>
      ) : (
        <VirtualList
          items={messages}
          keyOf={(message) => message.id}
          focusKey={focusId}
          label={`Wiadomości: ${channel.name}`}
          onReachTop={() => void load("older")}
          onReachBottom={() => void load("newer")}
          render={(message) => (
            <div className="message-row">
              <Message
                message={message}
                resolved={resolved}
                archived={archived}
                highlighted={message.id === focusId}
              />
              <MessageActions
                message={message}
                info={info}
                onReply={setReplyTo}
                onNotice={setNotice}
              />
            </div>
          )}
        />
      )}
      <Composer
        channel={channel}
        info={info}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
      />
    </section>
  );
}
