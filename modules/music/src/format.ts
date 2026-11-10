import type { MusicQuery } from "./ports.ts";

/** Longest search text sent to YouTube; longer input is cut, not refused. */
export const MAX_SEARCH_LENGTH = 200;

/** Hosts whose links `/play` loads (exact names; Bandcamp artists also get their own subdomain). */
const LINK_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "bandcamp.com",
  "twitch.tv",
  "www.twitch.tv",
  "m.twitch.tv",
  "vimeo.com",
  "www.vimeo.com",
  "player.vimeo.com",
]);

/** `hostname` as the URL parser gives it: lowercase, IDN already in punycode. */
function isSupportedHost(hostname: string): boolean {
  return LINK_HOSTS.has(hostname) || hostname.endsWith(".bandcamp.com");
}

/** What a member typed: a query, or a link to a site the bot does not load. */
export type ParsedQuery = MusicQuery | { kind: "unsupported" };

/**
 * Turns what a member typed into a query. An http(s) link stays a link only on a supported host, without
 * credentials or a port, and goes on in the parser's normalised form (so the node sees the host that was
 * checked); any other link is `unsupported`. Everything else, including text that looks like a Lavalink
 * prefix (`local:`, `scsearch:`), is search text. Discord's `<link>` form (which hides the preview) is
 * unwrapped. Null when nothing is left.
 */
export function parseQuery(input: string): ParsedQuery | null {
  let text = input.trim();
  if (text.startsWith("<") && text.endsWith(">")) text = text.slice(1, -1).trim();
  if (text === "") return null;
  if (/^https?:\/\//i.test(text) && !/\s/.test(text)) {
    if (!URL.canParse(text)) return { kind: "unsupported" };
    const url = new URL(text);
    const plain = url.username === "" && url.password === "" && url.port === "";
    return plain && isSupportedHost(url.hostname)
      ? { kind: "url", url: url.href }
      : { kind: "unsupported" };
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

/**
 * Track titles are user-controlled text: keep them from turning into Markdown (or breaking a link). `#` and
 * `-` start a heading, a list or `-#` subtext at the head of a line, and `<` opens `<@…>` and `<t:…>`.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\*_~`|>[\]()#<-]/g, "\\$&");
}

/** Cuts to `max` code points with an ellipsis, for Discord's label and title limits. */
export function truncate(text: string, max: number): string {
  const points = [...text];
  return points.length <= max ? text : `${points.slice(0, max - 1).join("")}…`;
}

/** Longest link put into an embed; Discord refuses the whole message over its limit. */
export const MAX_URL_LENGTH = 2048;

/**
 * Only http(s) links may become embed links or thumbnails; Discord rejects the rest. Returns the parsed,
 * normalised form, or nothing when that is too long.
 */
export function httpUrl(url: string | null): string | undefined {
  if (url === null || !URL.canParse(url)) return undefined;
  const { protocol, href } = new URL(url);
  if (protocol !== "http:" && protocol !== "https:") return undefined;
  return href.length <= MAX_URL_LENGTH ? href : undefined;
}

/** Longest time `/seek` reads: 99:59:59, far past any track. */
const MAX_TIME_SECONDS = 359_999;

/**
 * A time typed by a member, in milliseconds: `90` (seconds), `1:30`, `1:02:03`, `1m30s`, `1m30`, `1 m 30 s`,
 * `1h2m`, `45s`. Both forms follow the same rules: a part after a larger one stays under 60 (`1:75`, `1m90s`
 * and `1h75m` are refused), minutes before seconds go up to 99 without hours (longer times name the hours),
 * and the whole is at most 99:59:59. Null for anything else, including an empty string or a negative number.
 */
export function parseTime(input: string): number | null {
  const text = input.trim().toLowerCase();
  if (/^\d{1,6}$/.test(text)) return toTimeMs(undefined, undefined, text);
  const clock = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(text);
  if (clock) return toTimeMs(clock[1], clock[2], clock[3]);
  // A bare number at the end counts as seconds only after minutes (`1m30`), never after hours alone.
  const units = /^(?:(\d{1,2})\s*h)?\s*(?:(\d{1,2})\s*m)?\s*(?:(\d{1,6})\s*(s?))?$/.exec(text);
  if (!units || text === "") return null;
  const [, hours, minutes, seconds, secondsUnit] = units;
  if (seconds !== undefined && secondsUnit === "" && minutes === undefined) return null;
  return toTimeMs(hours, minutes, seconds);
}

function toTimeMs(
  hours: string | undefined,
  minutes: string | undefined,
  seconds: string | undefined,
): number | null {
  if (hours !== undefined && Number(minutes ?? 0) > 59) return null;
  if ((hours !== undefined || minutes !== undefined) && Number(seconds ?? 0) > 59) return null;
  const total = Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0);
  return total > MAX_TIME_SECONDS ? null : total * 1000;
}
