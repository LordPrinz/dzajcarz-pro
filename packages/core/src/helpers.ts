import { UserError } from "./errors.ts";

/**
 * Small pieces several modules need. They live here because ADR 5 forbids imports between modules; only
 * what at least two modules share belongs in this file.
 */

/** PermissionFlagsBits.ManageGuild; modules do not import discord.js at runtime. */
export const MANAGE_GUILD = 1n << 5n;

export const GUILD_ONLY = "Ta komenda działa tylko na serwerze.";

/**
 * The guild id of a command run in a guild. Commands are guild-only by default, so the dispatcher refuses
 * DMs first; this narrows the type and guards a future change of `contexts`.
 */
export function requireGuild(guildId: string | null, message = GUILD_ONLY): string {
  if (guildId === null) throw new UserError(message);
  return guildId;
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

const DISCORD_MESSAGE_LIMIT = 2000;
/** Discord caps a message at 2000 characters; the fences and a margin leave room for the text. */
const CODE_BLOCK_SIZE = 1900;

/** Length in code points, the way Discord and Postgres' char_length count. */
const characters = (text: string): number => [...text].length;

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

/** Room kept at the end of a cut list for "… i jeszcze N". */
const MORE_RESERVE = 20;

/** The lines that fit one message (`limit` characters); the rest is counted in a last "… i jeszcze N" line. */
export function fitLines(lines: readonly string[], limit = DISCORD_MESSAGE_LIMIT): string {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const next = used + (kept.length > 0 ? 1 : 0) + characters(line);
    if (next > limit - MORE_RESERVE) break;
    kept.push(line);
    used = next;
  }
  const hidden = lines.length - kept.length;
  return hidden > 0 ? `${kept.join("\n")}\n… i jeszcze ${hidden}` : kept.join("\n");
}
