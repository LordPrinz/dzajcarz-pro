import { useEffect, useState } from "react";
import {
  type ActionResult,
  type ArchiveSettings,
  type BackfillResult,
  backfillChannel,
  type ChannelSummary,
  type ChannelsState,
  fetchArchiveSettings,
  fetchChannels,
  type Guild,
  type GuildArchiveSettings,
  type GuildsState,
  saveDmArchive,
  saveGuildArchive,
} from "./api.ts";

/** What one "Wczytaj starsze" button shows next to it. */
export type BackfillState =
  | { kind: "running" }
  | { kind: "done"; result: BackfillResult }
  | { kind: "failed"; error: Extract<ActionResult<never>, { ok: false }>["error"] };

const ACTION_ERRORS: Record<Extract<ActionResult<never>, { ok: false }>["error"], string> = {
  unavailable: "Bot niedostępny",
  audit_unavailable: "Nie można zapisać dziennika zmian, nic nie zostało zmienione",
  error: "Nie udało się zapisać zmiany",
};

/** Polish text for a backfill state. */
export function backfillText(state: BackfillState): string {
  if (state.kind === "running") return "Wczytywanie…";
  if (state.kind === "failed") return ACTION_ERRORS[state.error];
  const { result } = state;
  switch (result.status) {
    case "ok":
      return result.done
        ? `Zapisano ${result.stored} z ${result.fetched}. To już początek kanału.`
        : `Zapisano ${result.stored} z ${result.fetched}. Kliknij ponownie, by wczytać starsze.`;
    case "not_archived":
      return "Ten kanał nie jest archiwizowany";
    case "unknown_channel":
      return "Bot nie widzi tego kanału";
    case "no_access":
      return "Bot nie może czytać historii tego kanału";
  }
}

const OFF = (guildId: string): GuildArchiveSettings => ({
  guildId,
  enabled: false,
  excludedChannelIds: [],
});

/** Kinds that hold no messages of their own: their posts are threads, listed separately. */
const holdsMessages = (channel: ChannelSummary) =>
  channel.kind !== "forum" && channel.kind !== "media";

export interface ArchiveGuildProps {
  guild: Guild;
  settings: GuildArchiveSettings;
  saving: boolean;
  expanded: boolean;
  channels: ChannelsState | undefined;
  backfills: Readonly<Record<string, BackfillState>>;
  onToggle(enabled: boolean): void;
  onExpand(): void;
  onChannelToggle(channelId: string, archived: boolean): void;
  onBackfill(channelId: string): void;
}

function ChannelList({
  props,
  channels,
}: {
  props: ArchiveGuildProps;
  channels: ChannelsState | undefined;
}) {
  if (!channels || channels.kind === "loading") return <p className="notice">Ładowanie kanałów…</p>;
  if (channels.kind === "unavailable") {
    return (
      <p className="notice notice-warn" role="alert">
        Bot niedostępny
      </p>
    );
  }
  if (channels.kind === "error") {
    return (
      <p className="notice notice-warn" role="alert">
        Nie udało się pobrać kanałów
      </p>
    );
  }
  const { settings, saving, backfills } = props;
  return (
    <>
      <ul className="archive-channels">
        {channels.channels.map((channel) => {
          const excluded = settings.excludedChannelIds.includes(channel.id);
          const backfill = backfills[channel.id];
          return (
            <li
              key={channel.id}
              className={channel.kind === "thread" ? "archive-channel thread" : "archive-channel"}
            >
              <label>
                <input
                  type="checkbox"
                  checked={!excluded}
                  disabled={!settings.enabled || saving}
                  onChange={(event) => props.onChannelToggle(channel.id, event.target.checked)}
                />{" "}
                {channel.kind === "thread" ? "↳ " : "#"}
                {channel.name}
              </label>
              {holdsMessages(channel) ? (
                <button
                  type="button"
                  disabled={!settings.enabled || excluded || backfill?.kind === "running"}
                  onClick={() => props.onBackfill(channel.id)}
                >
                  Wczytaj starsze
                </button>
              ) : null}
              <span className="archive-result" aria-live="polite">
                {backfill ? backfillText(backfill) : ""}
              </span>
            </li>
          );
        })}
      </ul>
      {channels.truncated ? (
        <p className="notice">Pokazano tylko część kanałów tego serwera.</p>
      ) : null}
    </>
  );
}

/** One server in the archive settings. Pure, so it can be rendered to a string in tests. */
export function ArchiveGuild(props: ArchiveGuildProps) {
  const { guild, settings, saving, expanded } = props;
  const listId = `archive-channels-${guild.id}`;
  return (
    <li className="archive-guild">
      <div className="archive-guild-head">
        <span className="guild-name">{guild.name}</span>
        <label>
          <input
            type="checkbox"
            checked={settings.enabled}
            disabled={saving}
            onChange={(event) => props.onToggle(event.target.checked)}
          />{" "}
          Archiwizuj
        </label>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={props.onExpand}
        >
          {expanded ? "Ukryj kanały" : "Kanały"}
        </button>
      </div>
      {expanded ? (
        <div id={listId}>
          <ChannelList props={props} channels={props.channels} />
        </div>
      ) : null}
    </li>
  );
}

/** The archive settings view: the DM switch and, per server, the switch, exclusions and backfill. */
export function ArchivePanel({ guilds }: { guilds: GuildsState }) {
  const [settings, setSettings] = useState<ArchiveSettings | null | "loading">("loading");
  const [saving, setSaving] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [channels, setChannels] = useState<Record<string, ChannelsState>>({});
  const [backfills, setBackfills] = useState<Record<string, BackfillState>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetchArchiveSettings().then(setSettings);
  }, []);

  if (settings === "loading") return <p className="notice">Ładowanie ustawień archiwum…</p>;
  if (settings === null) {
    return (
      <p className="notice notice-warn" role="alert">
        Nie udało się wczytać ustawień archiwum
      </p>
    );
  }

  const busy = (key: string, on: boolean) =>
    setSaving((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const settingsOf = (guildId: string) =>
    settings.guilds.find((guild) => guild.guildId === guildId) ?? OFF(guildId);

  const saveGuild = async (next: GuildArchiveSettings) => {
    busy(next.guildId, true);
    const result = await saveGuildArchive(next.guildId, {
      enabled: next.enabled,
      excludedChannelIds: next.excludedChannelIds,
    });
    busy(next.guildId, false);
    if (!result.ok) {
      setError(ACTION_ERRORS[result.error]);
      return;
    }
    setError(null);
    setSettings((current) =>
      current && current !== "loading"
        ? {
            ...current,
            guilds: [
              ...current.guilds.filter((guild) => guild.guildId !== result.data.guildId),
              result.data,
            ],
          }
        : current,
    );
  };

  const saveDm = async (enabled: boolean) => {
    busy("dm", true);
    const result = await saveDmArchive(enabled);
    busy("dm", false);
    if (!result.ok) {
      setError(ACTION_ERRORS[result.error]);
      return;
    }
    setError(null);
    setSettings((current) =>
      current && current !== "loading" ? { ...current, dm: result.data } : current,
    );
  };

  const expand = (guildId: string) => {
    const opening = !expanded.has(guildId);
    setExpanded((current) => {
      const next = new Set(current);
      if (opening) next.add(guildId);
      else next.delete(guildId);
      return next;
    });
    if (opening && channels[guildId]?.kind !== "ready") {
      setChannels((current) => ({ ...current, [guildId]: { kind: "loading" } }));
      void fetchChannels(guildId).then((state) =>
        setChannels((current) => ({ ...current, [guildId]: state })),
      );
    }
  };

  const backfill = async (channelId: string) => {
    setBackfills((current) => ({ ...current, [channelId]: { kind: "running" } }));
    const result = await backfillChannel(channelId);
    setBackfills((current) => ({
      ...current,
      [channelId]: result.ok
        ? { kind: "done", result: result.data }
        : { kind: "failed", error: result.error },
    }));
  };

  return (
    <>
      {error ? (
        <p className="notice notice-warn" role="alert">
          {error}
        </p>
      ) : null}
      <label className="archive-dm">
        <input
          type="checkbox"
          checked={settings.dm.enabled}
          disabled={saving.has("dm")}
          onChange={(event) => void saveDm(event.target.checked)}
        />{" "}
        Archiwizuj wiadomości prywatne do bota
      </label>
      {guilds.kind === "ready" ? (
        <ul className="archive-guilds">
          {guilds.guilds.map((guild) => {
            const current = settingsOf(guild.id);
            return (
              <ArchiveGuild
                key={guild.id}
                guild={guild}
                settings={current}
                saving={saving.has(guild.id)}
                expanded={expanded.has(guild.id)}
                channels={channels[guild.id]}
                backfills={backfills}
                onToggle={(enabled) => void saveGuild({ ...current, enabled })}
                onExpand={() => expand(guild.id)}
                onChannelToggle={(channelId, archived) =>
                  void saveGuild({
                    ...current,
                    excludedChannelIds: archived
                      ? current.excludedChannelIds.filter((id) => id !== channelId)
                      : [...current.excludedChannelIds, channelId],
                  })
                }
                onBackfill={(channelId) => void backfill(channelId)}
              />
            );
          })}
        </ul>
      ) : (
        <p className="notice">Serwery pojawią się, gdy bot będzie dostępny.</p>
      )}
    </>
  );
}
