import type { MusicQuery } from "./ports.ts";

/** Longest search text sent to YouTube; longer input is cut, not refused. */
export const MAX_SEARCH_LENGTH = 200;

/**
 * Turns what a member typed into a query. Only http(s) links stay links; everything else, including text
 * that looks like a Lavalink prefix (`local:`, `scsearch:`), is search text. Discord's `<link>` form (which
 * hides the preview) is unwrapped. Null when nothing is left.
 */
export function parseQuery(input: string): MusicQuery | null {
  let text = input.trim();
  if (text.startsWith("<") && text.endsWith(">")) text = text.slice(1, -1).trim();
  if (text === "") return null;
  if (/^https?:\/\//i.test(text) && !/\s/.test(text) && URL.canParse(text)) {
    const { protocol } = new URL(text);
    if (protocol === "http:" || protocol === "https:") return { kind: "url", url: text };
  }
  return { kind: "search", text: [...text].slice(0, MAX_SEARCH_LENGTH).join("") };
}

/** `3:07`, `1:02:03`; negative or missing time counts as 0. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

const BAR_WIDTH = 16;

/** `▬▬▬▬🔘▬▬▬… 1:02 / 3:21`; a stream has no end, so it gets a live marker instead. */
export function progressLine(positionMs: number, durationMs: number, isStream: boolean): string {
  if (isStream || durationMs <= 0) return `🔴 Na żywo · ${formatDuration(positionMs)}`;
  const ratio = Math.min(1, Math.max(0, positionMs / durationMs));
  const knob = Math.min(BAR_WIDTH - 1, Math.floor(ratio * BAR_WIDTH));
  const bar = `${"▬".repeat(knob)}🔘${"▬".repeat(BAR_WIDTH - 1 - knob)}`;
  return `${bar} ${formatDuration(Math.min(positionMs, durationMs))} / ${formatDuration(durationMs)}`;
}

/** Track titles are user-controlled text: keep them from turning into Markdown (or breaking a link). */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\*_~`|>[\]()]/g, "\\$&");
}

/** Cuts to `max` code points with an ellipsis, for Discord's label and title limits. */
export function truncate(text: string, max: number): string {
  const points = [...text];
  return points.length <= max ? text : `${points.slice(0, max - 1).join("")}…`;
}

/** Only http(s) links may become embed links or thumbnails; Discord rejects the rest. */
export function httpUrl(url: string | null): string | undefined {
  if (url === null || !URL.canParse(url)) return undefined;
  const { protocol } = new URL(url);
  return protocol === "http:" || protocol === "https:" ? url : undefined;
}
