import { useEffect, useState } from "react";
import { ArchivePanel } from "./ArchiveSettings.tsx";
import { fetchBotOnline, fetchGuilds, type GuildsState } from "./api.ts";
import { GuildList } from "./GuildList.tsx";
import { type ConnectionState, connectSocket } from "./socket.ts";

/** The socket pushes heartbeats; this poll notices when they stop, since silence sends nothing. */
const STATUS_POLL_MS = 15_000;

export function App() {
  const [guilds, setGuilds] = useState<GuildsState>({ kind: "loading" });
  const [botOnline, setBotOnline] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>("connecting");

  useEffect(() => {
    void fetchGuilds().then(setGuilds);
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const stop = connectSocket({
      url: `${scheme}://${location.host}/api/ws`,
      onStatus: (message) => setBotOnline(message.online),
      onState: setConnection,
    });
    const poll = setInterval(() => {
      void fetchBotOnline().then((online) => online !== null && setBotOnline(online));
    }, STATUS_POLL_MS);
    return () => {
      stop();
      clearInterval(poll);
    };
  }, []);

  // The bot coming back is the moment a failed list is worth asking for again.
  useEffect(() => {
    if (botOnline) void fetchGuilds().then(setGuilds);
  }, [botOnline]);

  return (
    <main>
      <header>
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
      <h2>Serwery</h2>
      <GuildList state={guilds} />
      <h2>Archiwum wiadomości</h2>
      <ArchivePanel guilds={guilds} />
    </main>
  );
}
