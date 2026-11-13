import { type MemberText, UserError } from "./errors.ts";
import { DEFAULT_LOCALE, type Locale } from "./i18n.ts";
import { characterCount, DISCORD_LIMITS } from "./limits.ts";
import { common } from "./messages.ts";

/**
 * Small pieces several modules need. They live here because ADR 5 forbids imports between modules; only
 * what at least two modules share belongs in this file.
 */

/**
 * The guild id of a command run in a guild. Commands are guild-only by default, so the dispatcher refuses
 * DMs first; this narrows the type and guards a future change of `contexts`.
 */
export function requireGuild(
  guildId: string | null,
  message: MemberText = (locale) => common(locale).guildOnly,
): string {
  if (guildId === null) throw new UserError(message);
  return guildId;
}

/**
 * Keeps user-controlled text (track titles, player and member names) from turning into Markdown or breaking
 * a link. `#` and `-` start a heading, a list or `-#` subtext at the head of a line, `<` opens `<@…>` and
 * `<t:…>`, and `@` and `:` stop `@everyone` and `:emoji:` from forming.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\*_~`|>[\]()#<@:-]/g, "\\$&");
}

/** Cuts to `max` code points with an ellipsis, for Discord's label, title and list-line limits. */
export function truncate(text: string, max: number): string {
  const points = [...text];
  return points.length <= max ? text : `${points.slice(0, max - 1).join("")}…`;
}

/** Asks Discord about channels, so a channel id typed by a member is never trusted on its own. */
export interface TextChannels {
  /** Whether the channel is a text or announcement channel of this guild. */
  isTextChannelOf(guildId: string, channelId: string): Promise<boolean>;
}

/** Polish noun form for a count: 1 → one, 2–4 (not 12–14) → few, otherwise many. */
export function plural(count: number, one: string, few: string, many: string): string {
  if (count === 1) return one;
  const tens = count % 100;
  const ones = count % 10;
  if (ones >= 2 && ones <= 4 && (tens < 12 || tens > 14)) return few;
  return many;
}

/** Discord caps a message at 2000 characters; the fences and a margin leave room for the text. */
const CODE_BLOCK_SIZE = 1900;

/**
 * The text as message-sized code blocks, so markdown and mentions in it show as typed. A backtick gets a
 * zero-width space after it, so a run of them cannot close the block.
 */
export function codeBlocks(text: string): string[] {
  const chars = [...text.replaceAll("`", "`\u200b")];
  const blocks: string[] = [];
  for (let start = 0; start < chars.length; start += CODE_BLOCK_SIZE) {
    blocks.push(`\`\`\`\n${chars.slice(start, start + CODE_BLOCK_SIZE).join("")}\n\`\`\``);
  }
  return blocks;
}

/** Room kept at the end of a cut list for "… i jeszcze N" in any language. */
const MORE_RESERVE = 20;

/** The lines that fit one message (`limit` characters); the rest is counted in a last "… i jeszcze N" line. */
export function fitLines(
  lines: readonly string[],
  limit: number = DISCORD_LIMITS.content,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const next = used + (kept.length > 0 ? 1 : 0) + characterCount(line);
    if (next > limit - MORE_RESERVE) break;
    kept.push(line);
    used = next;
  }
  const hidden = lines.length - kept.length;
  return hidden > 0 ? `${kept.join("\n")}\n${common(locale).more(hidden)}` : kept.join("\n");
}

/**
 * Fills `{name}` placeholders in one pass, so substituted text is never scanned again: a member called
 * `{server}` shows up literally. Unknown placeholders stay as written. The values go in as given, so escape
 * member-controlled text first. The result is cut by code points to Discord's message limit.
 */
export function fillTemplate(template: string, values: Readonly<Record<string, string>>): string {
  const rendered = template.replace(/\{(\w+)\}/g, (placeholder, key: string) =>
    Object.hasOwn(values, key) ? (values[key] as string) : placeholder,
  );
  return [...rendered].slice(0, DISCORD_LIMITS.content).join("");
}
