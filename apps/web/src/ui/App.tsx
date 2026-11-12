import { useCallback, useEffect, useRef, useState } from "react";
import { ArchivePanel } from "./ArchiveSettings.tsx";
import {
  type ChannelsState,
  fetchBotOnline,
  fetchChannels,
  fetchGuilds,
  type Guild,
  type GuildsState,
} from "./api.ts";
import { ChannelView } from "./ChannelView.tsx";
import { GuildList } from "./GuildList.tsx";
import { type DmsState, fetchDms } from "./reading-api.ts";
import { type SearchTarget, SearchView } from "./SearchView.tsx";
import { type Selection, Sidebar } from "./Sidebar.tsx";
import { type ConnectionState, connectSocket, type PanelSocket } from "./socket.ts";
import { type LiveEvent, parseLiveEvent } from "./timeline.ts";

/** The socket pushes heartbeats; this poll notices when they stop, since silence sends nothing. */
const STATUS_POLL_MS = 15_000;

export function App() {
  const [guilds, setGuilds] = useState<GuildsState>({ kind: "loading" });
  const [botOnline, setBotOnline] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [selection, setSelection] = useState<Selection>({ kind: "none" });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [channels, setChannels] = useState<Record<string, ChannelsState>>({});
  const [dms, setDms] = useState<DmsState>({ kind: "loading" });
  /** Times the socket opened again after the first time; a channel view reloads its end on each. */
  const [reconnects, setReconnects] = useState(0);
  const opened = useRef(false);
  const socket = useRef<PanelSocket | null>(null);
  const listeners = useRef(new Set<(event: LiveEvent) => void>());

  useEffect(() => {
    void fetchGuilds().then(setGuilds);
    void fetchDms().then(setDms);
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    socket.current = connectSocket({
      url: `${scheme}://${location.host}/api/ws`,
      onStatus: (message) => setBotOnline(message.online),
      onState: (state) => {
        setConnection(state);
        if (state !== "open") return;
        if (opened.current) setReconnects((n) => n + 1);
        opened.current = true;
      },
      onEvent: (data) => {
        const event = parseLiveEvent(data);
        if (event) for (const listener of listeners.current) listener(event);
      },
    });
    const poll = setInterval(() => {
      void fetchBotOnline().then((online) => online !== null && setBotOnline(online));
    }, STATUS_POLL_MS);
    return () => {
      socket.current?.stop();
      clearInterval(poll);
    };
  }, []);

  // The bot coming back is the moment a failed list is worth asking for again.
  useEffect(() => {
    if (!botOnline) return;
    void fetchGuilds().then(setGuilds);
    void fetchDms().then(setDms);
  }, [botOnline]);

  const watched = selection.kind === "channel" ? selection.channel.id : null;
  useEffect(() => {
    socket.current?.watch(watched);
  }, [watched]);

  const subscribe = useCallback((listener: (event: LiveEvent) => void) => {
    listeners.current.add(listener);
    return () => void listeners.current.delete(listener);
  }, []);

  const loadChannels = (guildId: string) => {
    setChannels((current) => ({ ...current, [guildId]: { kind: "loading" } }));
    void fetchChannels(guildId).then((state) =>
      setChannels((current) => ({ ...current, [guildId]: state })),
    );
  };

  const expand = (guild: Guild) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(guild.id)) next.delete(guild.id);
      else next.add(guild.id);
      return next;
    });
    const known = channels[guild.id];
    if (!known || known.kind === "unavailable" || known.kind === "error") loadChannels(guild.id);
  };

  const channelInfo = (channelId: string) => {
    for (const state of Object.values(channels)) {
      if (state.kind !== "ready") continue;
      const found = state.channels.find((channel) => channel.id === channelId);
      if (found) return found;
    }
    return null;
  };

  const openResult = (target: SearchTarget) => {
    const info = channelInfo(target.channelId);
    const dm =
      dms.kind === "ready" ? dms.dms.find((entry) => entry.channelId === target.channelId) : null;
    setSelection({
      kind: "channel",
      channel: {
        id: target.channelId,
        guildId: target.guildId,
        parentId: info?.kind === "thread" ? info.parentId : null,
        name:
          info?.name ??
          (dm?.recipient ? (dm.recipient.displayName ?? dm.recipient.username) : target.channelId),
      },
      focusId: target.messageId,
    });
  };

  const readyGuilds = guilds.kind === "ready" ? guilds.guilds : [];

  return (
    <div className="layout">
      <header className="topbar">
        <h1>Dżajcarz</h1>
        <p className="status">
          <span className={botOnline ? "dot dot-online" : "dot dot-offline"} aria-hidden="true" />
          {botOnline ? "Bot online" : "Bot offline"}
        </p>
      </header>
      {connection === "expired" ? (
        <p className="notice notice-warn" role="alert">
          Sesja wygasła, odśwież stronę
        </p>
      ) : null}
      <Sidebar
        guilds={guilds}
        expanded={expanded}
        channels={channels}
        dms={dms}
        selection={selection}
        onExpand={expand}
        onSelect={setSelection}
      />
      <main className="content">
        {selection.kind === "channel" ? (
          <ChannelView
            key={`${selection.channel.id}:${selection.focusId ?? ""}`}
            channel={selection.channel}
            focusId={selection.focusId ?? null}
            subscribe={subscribe}
            reconnects={reconnects}
          />
        ) : selection.kind === "search" ? (
          <SearchView
            guilds={readyGuilds}
            channelName={(channelId) => channelInfo(channelId)?.name ?? null}
            onOpen={openResult}
          />
        ) : selection.kind === "archive" ? (
          <>
            <h2>Archiwum wiadomości</h2>
            <ArchivePanel guilds={guilds} />
          </>
        ) : (
          <>
            <h2>Serwery</h2>
            <GuildList state={guilds} />
            <p className="notice">Wybierz kanał lub rozmowę z listy.</p>
          </>
        )}
      </main>
    </div>
  );
}
