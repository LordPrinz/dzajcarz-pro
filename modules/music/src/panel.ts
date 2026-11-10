import type { ButtonSpec, Embed } from "@dzajcarz/core";
import { plural, truncate } from "@dzajcarz/core";
import { escapeMarkdown, formatDuration, httpUrl, progressLine } from "./format.ts";
import type { LoopMode, MusicFilter, MusicTrack, PanelMessage, PlayerState } from "./ports.ts";

export const PANEL_COLOR = 0x1db954;
/** Discord's embed title limit. */
const MAX_TITLE = 256;

export interface PanelButtons {
  pause: (paused: boolean) => ButtonSpec;
  skip: ButtonSpec;
  stop: ButtonSpec;
  queue: ButtonSpec;
  loop: (mode: LoopMode) => ButtonSpec;
  shuffle: ButtonSpec;
}

export const LOOP_LABELS: Record<LoopMode, string> = {
  off: "wył.",
  track: "utwór",
  queue: "kolejka",
};

export const FILTER_LABELS: Record<MusicFilter, string> = {
  off: "brak",
  bassboost: "bassboost",
  nightcore: "nightcore",
  vaporwave: "vaporwave",
  "8d": "8D",
};

/** `Pętla: utwór · Głośność: 80% · Filtr: nightcore`, the settings part of the footer. */
export function settingsLine(state: Pick<PlayerState, "loop" | "volume" | "filter">): string {
  return `Pętla: ${LOOP_LABELS[state.loop]} · Głośność: ${state.volume}% · Filtr: ${FILTER_LABELS[state.filter]}`;
}

/** Title (linked), author, cover, progress and who added the track. */
export function trackEmbed(
  track: MusicTrack,
  positionMs: number,
  upcoming: number,
  settings: string,
): Embed {
  return {
    title: truncate(track.title, MAX_TITLE),
    url: httpUrl(track.uri),
    thumbnail: httpUrl(track.artworkUrl),
    color: PANEL_COLOR,
    description: [
      `**Autor:** ${escapeMarkdown(track.author)}`,
      `**Dodał(a):** <@${track.requesterId}>`,
      progressLine(positionMs, track.durationMs, track.isStream),
    ].join("\n"),
    footer: `${upcoming === 0 ? "Kolejka jest pusta" : `W kolejce: ${upcoming}`} · ${settings}`,
  };
}

/** The now playing panel; null when nothing is playing or the bot plays its own track. */
export function panelMessage(state: PlayerState, buttons: PanelButtons): PanelMessage | null {
  if (!state.current || state.current.byBot) return null;
  return {
    embeds: [
      trackEmbed(state.current, state.positionMs, state.upcoming.length, settingsLine(state)),
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
function queueLine(index: number, track: MusicTrack, withLink: boolean): string {
  const title = escapeMarkdown(truncate(track.title, 60));
  const url = withLink ? httpUrl(track.uri) : undefined;
  const label = url ? `[${title}](${url.replaceAll(")", "%29")})` : title;
  const length = track.isStream ? "na żywo" : formatDuration(track.durationMs);
  return `\`${index}.\` ${label} · ${length} · <@${track.requesterId}>`;
}

/**
 * The lines of one `/queue` page, numbered from `firstIndex`. A long link is dropped, and when the page would
 * still pass the budget the links go from the last line backwards, so the description always fits.
 */
export function queueLines(firstIndex: number, tracks: readonly MusicTrack[]): string[] {
  const linked = tracks.map((track) => (httpUrl(track.uri)?.length ?? 0) <= MAX_QUEUE_LINK_LENGTH);
  const render = () =>
    tracks.map((track, i) => queueLine(firstIndex + i, track, linked[i] ?? false));
  let lines = render();
  for (let i = tracks.length - 1; i >= 0 && lines.join("\n").length > QUEUE_LINES_BUDGET; i--) {
    linked[i] = false;
    lines = render();
  }
  return lines;
}

/** 1 utwór, 2 utwory, 5 utworów, 22 utwory. */
export function tracksWord(count: number): string {
  return plural(count, "utwór", "utwory", "utworów");
}
