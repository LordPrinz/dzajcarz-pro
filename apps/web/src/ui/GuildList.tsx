import type { Guild, GuildsState } from "./api.ts";

function GuildRow({ guild }: { guild: Guild }) {
  return (
    <li className="guild">
      {guild.iconUrl ? (
        <img className="guild-icon" src={guild.iconUrl} alt="" width={40} height={40} />
      ) : (
        <span className="guild-icon guild-icon-fallback" aria-hidden="true">
          {[...guild.name][0]?.toUpperCase() ?? "?"}
        </span>
      )}
      <span className="guild-name">{guild.name}</span>
      <span className="guild-members">Członkowie: {guild.memberCount}</span>
    </li>
  );
}

/** The server list for one `GuildsState`. Pure, so it can be rendered to a string in tests. */
export function GuildList({ state }: { state: GuildsState }) {
  switch (state.kind) {
    case "loading":
      return <p className="notice">Ładowanie serwerów…</p>;
    case "unavailable":
      return (
        <p className="notice notice-warn" role="alert">
          Bot niedostępny
        </p>
      );
    case "error":
      return (
        <p className="notice notice-warn" role="alert">
          Nie udało się pobrać serwerów
        </p>
      );
    case "ready":
      return state.guilds.length === 0 ? (
        <p className="notice">Bot nie jest na żadnym serwerze</p>
      ) : (
        <ul className="guilds">
          {state.guilds.map((guild) => (
            <GuildRow key={guild.id} guild={guild} />
          ))}
        </ul>
      );
  }
}
