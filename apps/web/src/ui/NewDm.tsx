import { useEffect, useMemo, useState } from "react";
import type { Guild } from "./api.ts";
import { authorName } from "./reading-api.ts";
import {
  debounce,
  type MemberResult,
  MIN_MEMBER_QUERY_LENGTH,
  openDm,
  SEARCH_DEBOUNCE_MS,
  searchMembers,
  WRITE_ERRORS,
  type WriteError,
} from "./write-api.ts";

type SearchState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; members: MemberResult[] }
  | { kind: "failed"; error: WriteError };

export interface NewDmProps {
  guilds: Guild[];
  /** The DM is open: show it. */
  onOpened: (channelId: string, recipient: MemberResult) => void;
}

/** Starts a DM with a member of a server the bot shares, found by name. */
export function NewDm({ guilds, onOpened }: NewDmProps) {
  const [query, setQuery] = useState("");
  const [guildId, setGuildId] = useState("");
  const [search, setSearch] = useState<SearchState>({ kind: "idle" });
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const find = async (text: string, guild: string) => {
    if (text.trim().length < MIN_MEMBER_QUERY_LENGTH) return;
    setSearch({ kind: "loading" });
    const result = await searchMembers(text.trim(), guild || null);
    setSearch(
      result.ok
        ? { kind: "ready", members: result.data.members }
        : { kind: "failed", error: result.error },
    );
  };
  // Searches as the name is typed, once typing pauses.
  // biome-ignore lint/correctness/useExhaustiveDependencies: one debouncer for the component's life.
  const typed = useMemo(() => debounce(find, SEARCH_DEBOUNCE_MS), []);
  useEffect(() => () => typed.cancel(), [typed]);
  const ready = query.trim().length >= MIN_MEMBER_QUERY_LENGTH;

  const open = async (member: MemberResult) => {
    setOpening(member.id);
    setError(null);
    const result = await openDm(member.id);
    setOpening(null);
    if (!result.ok) {
      setError(WRITE_ERRORS[result.error]);
      return;
    }
    onOpened(result.data.channelId, result.data.recipient);
  };

  return (
    <section aria-label="Nowa rozmowa">
      <h2>Nowa rozmowa</h2>
      <form
        className="search-form"
        onSubmit={(event) => {
          event.preventDefault();
          typed.cancel();
          void find(query, guildId);
        }}
      >
        <label>
          Nazwa
          <input
            value={query}
            maxLength={32}
            placeholder="początek nazwy"
            onChange={(event) => {
              setQuery(event.target.value);
              typed.call(event.target.value, guildId);
            }}
          />
        </label>
        <label>
          Serwer
          <select value={guildId} onChange={(event) => setGuildId(event.target.value)}>
            <option value="">Wszystkie wspólne serwery</option>
            {guilds.map((guild) => (
              <option key={guild.id} value={guild.id}>
                {guild.name}
              </option>
            ))}
          </select>
        </label>
        <div className="search-actions">
          <button type="submit" disabled={!ready || search.kind === "loading"}>
            Szukaj
          </button>
        </div>
      </form>
      {error ? (
        <p className="notice notice-warn" role="alert">
          {error}
        </p>
      ) : null}
      {search.kind === "loading" ? <p className="notice">Szukanie…</p> : null}
      {search.kind === "failed" ? (
        <p className="notice notice-warn" role="alert">
          {WRITE_ERRORS[search.error]}
        </p>
      ) : null}
      {search.kind === "ready" ? (
        search.members.length === 0 ? (
          <p className="notice">Nikogo nie znaleziono</p>
        ) : (
          <ul className="member-results">
            {search.members.map((member) => (
              <li key={member.id}>
                <span>
                  {authorName(member)} <span className="muted">@{member.username}</span>
                </span>
                <button type="button" disabled={opening !== null} onClick={() => void open(member)}>
                  {opening === member.id ? "Otwieranie…" : "Napisz"}
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}
