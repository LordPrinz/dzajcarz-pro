import type { ButtonSpec, Embed } from "@dzajcarz/core";
import { escapeMarkdown, formatDuration, httpUrl, progressLine, truncate } from "./format.ts";
import type { MusicTrack, PanelMessage, PlayerState } from "./ports.ts";

export const PANEL_COLOR = 0x1db954;
/** Discord's embed title limit. */
const MAX_TITLE = 256;

export interface PanelButtons {
  pause: (paused: boolean) => ButtonSpec;
  skip: ButtonSpec;
  stop: ButtonSpec;
  queue: ButtonSpec;
}

/** Title (linked), author, cover, progress and who added the track. */
export function trackEmbed(track: MusicTrack, positionMs: number, upcoming: number): Embed {
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
    footer: upcoming === 0 ? "Kolejka jest pusta" : `W kolejce: ${upcoming}`,
  };
}

/** The now playing panel; null when nothing is playing or the bot plays its own track. */
export function panelMessage(state: PlayerState, buttons: PanelButtons): PanelMessage | null {
  if (!state.current || state.current.byBot) return null;
  return {
    embeds: [trackEmbed(state.current, state.positionMs, state.upcoming.length)],
    components: [[buttons.pause(state.paused), buttons.skip, buttons.stop, buttons.queue]],
  };
}

/** One line of `/queue`: `3. [Title](link) · 3:21 · @member`. */
export function queueLine(index: number, track: MusicTrack): string {
  const title = escapeMarkdown(truncate(track.title, 60));
  const url = httpUrl(track.uri);
  const label = url ? `[${title}](${url.replaceAll(")", "%29")})` : title;
  const length = track.isStream ? "na żywo" : formatDuration(track.durationMs);
  return `\`${index}.\` ${label} · ${length} · <@${track.requesterId}>`;
}

/** 1 utwór, 2 utwory, 5 utworów, 22 utwory. */
export function tracksWord(count: number): string {
  if (count === 1) return "utwór";
  const lastTwo = count % 100;
  const last = count % 10;
  return last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14) ? "utwory" : "utworów";
}
