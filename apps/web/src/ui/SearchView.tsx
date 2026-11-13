import { type FormEvent, useRef, useState } from "react";
import type { Guild } from "./api.ts";
import { Message } from "./Message.tsx";
import {
  authorName,
  mergeResolved,
  type PanelMessage,
  type Resolved,
  type SearchFilters,
  searchArchive,
} from "./reading-api.ts";

export interface SearchTarget {
  guildId: string | null;
  channelId: string;
  messageId: string;
}

type SearchState =
  | { kind: "idle" }
  | { kind: "loading" }
  | {
      kind: "ready";
      /** The filters these results were found with: "Więcej wyników" continues with them. */
      filters: SearchFilters;
      results: PanelMessage[];
      resolved: Resolved;
      nextBefore: string | null;
    }
  | { kind: "failed"; message: string };

const EMPTY: SearchFilters = { q: "", guild: "", channel: "", author: "", from: "", to: "" };

const FAILURES = {
  invalid: "Sprawdź pola wyszukiwania: potrzebne jest choć jedno słowo bez minusa",
  database: "Archiwum jest niedostępne",
  timeout: "Wyszukiwanie trwało za długo, zawęź je",
  error: "Wyszukiwanie się nie udało",
} as const;

export interface SearchViewProps {
  guilds: Guild[];
  /** A channel name for a result, when the panel knows it. */
  channelName: (channelId: string) => string | null;
  onOpen: (target: SearchTarget) => void;
}

/** Full-text search over the archive; a result opens its channel at that message. */
export function SearchView({ guilds, channelName, onOpen }: SearchViewProps) {
  const [filters, setFilters] = useState<SearchFilters>(EMPTY);
  const [state, setState] = useState<SearchState>({ kind: "idle" });
  const [loadingMore, setLoadingMore] = useState(false);
  /** Counts searches: a "more" reply for an earlier one is dropped. */
  const searches = useRef(0);

  const set = (key: keyof SearchFilters) => (value: string) =>
    setFilters((current) => ({ ...current, [key]: value }));

  const run = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!filters.q.trim()) return;
    const used = filters;
    searches.current += 1;
    setState({ kind: "loading" });
    const result = await searchArchive(used, null);
    setState(
      result.ok
        ? { kind: "ready", filters: used, ...result.page }
        : { kind: "failed", message: FAILURES[result.error] },
    );
  };

  const more = async () => {
    if (state.kind !== "ready" || !state.nextBefore || loadingMore) return;
    const search = searches.current;
    setLoadingMore(true);
    const result = await searchArchive(state.filters, state.nextBefore);
    setLoadingMore(false);
    if (!result.ok || search !== searches.current) return;
    setState((current) =>
      current.kind === "ready"
        ? {
            kind: "ready",
            filters: current.filters,
            results: [...current.results, ...result.page.results],
            resolved: mergeResolved(current.resolved, result.page.resolved),
            nextBefore: result.page.nextBefore,
          }
        : current,
    );
  };

  return (
    <section className="search-view" aria-label="Szukaj w archiwum">
      <h2>Szukaj w archiwum</h2>
      <form className="search-form" onSubmit={(event) => void run(event)}>
        <label className="search-q">
          Szukane słowa
          <input
            type="search"
            value={filters.q}
            maxLength={200}
            placeholder='np. pizza -ananas, "dokładna fraza"'
            onChange={(event) => set("q")(event.target.value)}
          />
        </label>
        <label>
          Serwer
          <select value={filters.guild} onChange={(event) => set("guild")(event.target.value)}>
            <option value="">Wszystkie</option>
            <option value="dm">Wiadomości prywatne</option>
            {guilds.map((guild) => (
              <option key={guild.id} value={guild.id}>
                {guild.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          ID kanału
          <input
            value={filters.channel}
            inputMode="numeric"
            pattern="\d{17,20}"
            onChange={(event) => set("channel")(event.target.value.trim())}
          />
        </label>
        <label>
          ID autora
          <input
            value={filters.author}
            inputMode="numeric"
            pattern="\d{17,20}"
            onChange={(event) => set("author")(event.target.value.trim())}
          />
        </label>
        <label>
          Od
          <input
            type="date"
            value={filters.from}
            onChange={(event) => set("from")(event.target.value)}
          />
        </label>
        <label>
          Do
          <input
            type="date"
            value={filters.to}
            onChange={(event) => set("to")(event.target.value)}
          />
        </label>
        <div className="search-actions">
          <button type="submit" disabled={!filters.q.trim() || state.kind === "loading"}>
            Szukaj
          </button>
          <button
            type="button"
            onClick={() => {
              setFilters(EMPTY);
              setState({ kind: "idle" });
            }}
          >
            Wyczyść
          </button>
        </div>
      </form>
      {state.kind === "loading" ? <p className="notice">Szukam…</p> : null}
      {state.kind === "failed" ? (
        <p className="notice notice-warn" role="alert">
          {state.message}
        </p>
      ) : null}
      {state.kind === "ready" ? (
        state.results.length === 0 ? (
          <p className="notice">Nic nie znaleziono</p>
        ) : (
          <ol className="search-results">
            {state.results.map((message) => (
              <li key={message.id} className="search-result">
                <p className="search-where muted">
                  {message.guildId === null
                    ? "Wiadomość prywatna"
                    : `#${channelName(message.channelId) ?? state.resolved.channels[message.channelId] ?? message.channelId}`}
                  {" · "}
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => set("author")(message.author.id)}
                  >
                    tylko {authorName(message.author)}
                  </button>
                  {" · "}
                  <button
                    type="button"
                    className="link-button"
                    onClick={() =>
                      onOpen({
                        guildId: message.guildId,
                        channelId: message.channelId,
                        messageId: message.id,
                      })
                    }
                  >
                    Przejdź do wiadomości
                  </button>
                </p>
                <Message message={message} resolved={state.resolved} archived />
              </li>
            ))}
          </ol>
        )
      ) : null}
      {state.kind === "ready" && state.nextBefore ? (
        <button type="button" disabled={loadingMore} onClick={() => void more()}>
          {loadingMore ? "Ładowanie…" : "Więcej wyników"}
        </button>
      ) : null}
    </section>
  );
}
