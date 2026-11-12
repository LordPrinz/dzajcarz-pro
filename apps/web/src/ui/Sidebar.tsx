import type { ChannelSummary, ChannelsState, Guild, GuildsState } from "./api.ts";
import { authorName, type ChannelRef, type DmsState } from "./reading-api.ts";

/** Channel kinds with messages to read; a forum or media channel holds only threads. */
const READABLE = new Set<ChannelSummary["kind"]>([
  "text",
  "announcement",
  "voice",
  "stage",
  "thread",
]);

export const isReadable = (channel: ChannelSummary): boolean => READABLE.has(channel.kind);

export type Selection =
  | { kind: "channel"; channel: ChannelRef; focusId?: string | null }
  | { kind: "search" }
  | { kind: "archive" }
  | { kind: "new-dm" }
  | { kind: "music" }
  | { kind: "none" };

export interface SidebarProps {
  guilds: GuildsState;
  expanded: ReadonlySet<string>;
  channels: Readonly<Record<string, ChannelsState>>;
  dms: DmsState;
  selection: Selection;
  onExpand: (guild: Guild) => void;
  onSelect: (selection: Selection) => void;
}

const selectedChannel = (selection: Selection) =>
  selection.kind === "channel" ? selection.channel.id : null;

function GuildChannels({
  guild,
  state,
  selection,
  onSelect,
}: {
  guild: Guild;
  state: ChannelsState | undefined;
  selection: Selection;
  onSelect: SidebarProps["onSelect"];
}) {
  if (!state || state.kind === "loading") return <p className="side-note">Ładowanie kanałów…</p>;
  if (state.kind === "unavailable") return <p className="side-note">Bot niedostępny</p>;
  if (state.kind === "error") return <p className="side-note">Nie udało się pobrać kanałów</p>;
  return (
    <ul className="side-channels">
      {state.channels.map((channel) => (
        <li key={channel.id} className={channel.kind === "thread" ? "side-thread" : undefined}>
          <button
            type="button"
            className="side-item"
            disabled={!isReadable(channel)}
            aria-current={selectedChannel(selection) === channel.id ? "page" : undefined}
            onClick={() =>
              onSelect({
                kind: "channel",
                channel: {
                  id: channel.id,
                  guildId: guild.id,
                  parentId: channel.kind === "thread" ? channel.parentId : null,
                  name: channel.name,
                },
              })
            }
          >
            {channel.kind === "thread" ? "↳ " : "# "}
            {channel.name}
          </button>
        </li>
      ))}
      {state.truncated ? <li className="side-note">Lista skrócona</li> : null}
    </ul>
  );
}

function Dms({ dms, selection, onSelect }: Pick<SidebarProps, "dms" | "selection" | "onSelect">) {
  if (dms.kind === "loading") return <p className="side-note">Ładowanie…</p>;
  if (dms.kind === "error") return <p className="side-note">Nie udało się pobrać rozmów</p>;
  return (
    <>
      {dms.dms.length === 0 ? <p className="side-note">Brak znanych rozmów</p> : null}
      <ul className="side-channels">
        {dms.dms.map((dm) => {
          const name = dm.recipient ? authorName(dm.recipient) : `Rozmowa ${dm.channelId}`;
          return (
            <li key={dm.channelId}>
              <button
                type="button"
                className="side-item"
                aria-current={selectedChannel(selection) === dm.channelId ? "page" : undefined}
                onClick={() =>
                  onSelect({
                    kind: "channel",
                    channel: { id: dm.channelId, guildId: null, name },
                  })
                }
              >
                @ {name}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="side-note">
        {dms.botAvailable
          ? "Discord nie daje botowi listy rozmów: widać te z archiwum i aktywne od startu bota."
          : "Bot niedostępny: widać tylko rozmowy z archiwum."}
        {dms.truncated ? " Lista skrócona." : ""}
      </p>
    </>
  );
}

/** Servers with their channels and threads, the DMs, and the tools. */
export function Sidebar(props: SidebarProps) {
  const { guilds, expanded, channels, selection, onExpand, onSelect } = props;
  return (
    <nav className="sidebar" aria-label="Kanały">
      <div className="side-tools">
        <button
          type="button"
          className="side-item"
          aria-current={selection.kind === "search" ? "page" : undefined}
          onClick={() => onSelect({ kind: "search" })}
        >
          Szukaj
        </button>
        <button
          type="button"
          className="side-item"
          aria-current={selection.kind === "archive" ? "page" : undefined}
          onClick={() => onSelect({ kind: "archive" })}
        >
          Ustawienia archiwum
        </button>
        <button
          type="button"
          className="side-item"
          aria-current={selection.kind === "music" ? "page" : undefined}
          onClick={() => onSelect({ kind: "music" })}
        >
          Muzyka
        </button>
      </div>
      <h2 className="side-heading">Serwery</h2>
      {guilds.kind === "ready" ? (
        <ul className="side-guilds">
          {guilds.guilds.map((guild) => (
            <li key={guild.id}>
              <button
                type="button"
                className="side-guild"
                aria-expanded={expanded.has(guild.id)}
                onClick={() => onExpand(guild)}
              >
                {guild.name}
              </button>
              {expanded.has(guild.id) ? (
                <GuildChannels
                  guild={guild}
                  state={channels[guild.id]}
                  selection={selection}
                  onSelect={onSelect}
                />
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="side-note">
          {guilds.kind === "loading"
            ? "Ładowanie serwerów…"
            : guilds.kind === "unavailable"
              ? "Bot niedostępny"
              : "Nie udało się pobrać serwerów"}
        </p>
      )}
      <h2 className="side-heading">Wiadomości prywatne</h2>
      <button
        type="button"
        className="side-item"
        aria-current={selection.kind === "new-dm" ? "page" : undefined}
        onClick={() => onSelect({ kind: "new-dm" })}
      >
        + Nowa rozmowa
      </button>
      <Dms dms={props.dms} selection={selection} onSelect={onSelect} />
    </nav>
  );
}
