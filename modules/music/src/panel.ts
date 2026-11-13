import type { ButtonSpec, Embed } from "@dzajcarz/core";
import { escapeMarkdown, type Locale, truncate } from "@dzajcarz/core";
import { formatDuration, httpUrl, progressLine } from "./format.ts";
import { t } from "./messages.ts";
import type { LoopMode, MusicFilter, MusicTrack, PanelMessage, PlayerState } from "./ports.ts";

export const PANEL_COLOR = 0x1db954;
/** Discord's embed title limit. */
const MAX_TITLE = 256;

/** The panel's buttons in one language; `panelMessage` takes the set of the language it draws in. */
export interface PanelButtons {
  pause: (paused: boolean) => ButtonSpec;
  skip: ButtonSpec;
  stop: ButtonSpec;
  queue: ButtonSpec;
  loop: (mode: LoopMode) => ButtonSpec;
  shuffle: ButtonSpec;
}

export function loopLabel(mode: LoopMode, locale: Locale): string {
  const text = t(locale);
  return { off: text.loopOff, track: text.loopTrack, queue: text.loopQueue }[mode];
}

export function filterLabel(filter: MusicFilter, locale: Locale): string {
  const labels: Record<MusicFilter, string> = {
    off: t(locale).filterNone,
    bassboost: "bassboost",
    nightcore: "nightcore",
    vaporwave: "vaporwave",
    "8d": "8D",
  };
  return labels[filter];
}

/** `Pętla: utwór · Głośność: 80% · Filtr: nightcore`, the settings part of the footer. */
export function settingsLine(
  state: Pick<PlayerState, "loop" | "volume" | "filter">,
  locale: Locale,
): string {
  return t(locale).settings(
    loopLabel(state.loop, locale),
    state.volume,
    filterLabel(state.filter, locale),
  );
}

/** Title (linked), author, cover, progress and who added the track. */
export function trackEmbed(
  track: MusicTrack,
  positionMs: number,
  upcoming: number,
  settings: string,
  locale: Locale,
): Embed {
  const text = t(locale);
  return {
    title: truncate(track.title, MAX_TITLE),
    url: httpUrl(track.uri),
    thumbnail: httpUrl(track.artworkUrl),
    color: PANEL_COLOR,
    description: [
      `**${text.author}:** ${escapeMarkdown(track.author)}`,
      ...(track.requesterId ? [`**${text.addedBy}:** <@${track.requesterId}>`] : []),
      progressLine(positionMs, track.durationMs, track.isStream, locale),
    ].join("\n"),
    footer: `${upcoming === 0 ? text.queueEmptyFooter : text.queuedFooter(upcoming)} · ${settings}`,
  };
}

/** The now playing panel; null when nothing is playing or the bot plays its own track. */
export function panelMessage(
  state: PlayerState,
  buttons: PanelButtons,
  locale: Locale,
): PanelMessage | null {
  if (!state.current || state.current.byBot) return null;
  return {
    embeds: [
      trackEmbed(
        state.current,
        state.positionMs,
        state.upcoming.length,
        settingsLine(state, locale),
        locale,
      ),
    ],
    components: [
      [buttons.pause(state.paused), buttons.skip, buttons.stop, buttons.queue],
      [buttons.loop(state.loop), buttons.shuffle],
    ],
  };
}

/** A link longer than this is not worth its share of the embed; the title stays without it. */
const MAX_QUEUE_LINK_LENGTH = 300;
/** Room for one `/queue` page's lines inside the 4096-character description, after the "now playing" head. */
const QUEUE_LINES_BUDGET = 3700;

/** One line of `/queue`: `3. [Title](link) · 3:21 · @member`; `withLink` false keeps only the title. */
function queueLine(index: number, track: MusicTrack, withLink: boolean, locale: Locale): string {
  const title = escapeMarkdown(truncate(track.title, 60));
  const url = withLink ? httpUrl(track.uri) : undefined;
  const label = url ? `[${title}](${url.replaceAll(")", "%29")})` : title;
  const length = track.isStream ? t(locale).liveShort : formatDuration(track.durationMs);
  return `\`${index}.\` ${label} · ${length}${track.requesterId ? ` · <@${track.requesterId}>` : ""}`;
}

/**
 * The lines of one `/queue` page, numbered from `firstIndex`. A long link is dropped, and when the page would
 * still pass the budget the links go from the last line backwards, so the description always fits.
 */
export function queueLines(
  firstIndex: number,
  tracks: readonly MusicTrack[],
  locale: Locale,
): string[] {
  const linked = tracks.map((track) => (httpUrl(track.uri)?.length ?? 0) <= MAX_QUEUE_LINK_LENGTH);
  const render = () =>
    tracks.map((track, i) => queueLine(firstIndex + i, track, linked[i] ?? false, locale));
  let lines = render();
  for (let i = tracks.length - 1; i >= 0 && lines.join("\n").length > QUEUE_LINES_BUDGET; i--) {
    linked[i] = false;
    lines = render();
  }
  return lines;
}
