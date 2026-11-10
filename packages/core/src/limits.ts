import type { Embed, Reply } from "./command.ts";

/** Discord's message and embed limits. A reply over any of them is rejected by the API as a whole. */
export const DISCORD_LIMITS = {
  content: 2000,
  embeds: 10,
  title: 256,
  description: 4096,
  fields: 25,
  fieldName: 256,
  fieldValue: 1024,
  footer: 2048,
  authorName: 256,
  /** Title, description, field names and values, footer and author name of all embeds together. */
  embedTotal: 6000,
} as const;

/**
 * Length in code points, the way Discord and Postgres' char_length count: an emoji is one character even
 * though it takes two UTF-16 units.
 */
export const characterCount = (text: string): number => [...text].length;

const length = (text: string | undefined) => (text === undefined ? 0 : characterCount(text));

function check(problems: string[], what: string, text: string | undefined, limit: number): void {
  const size = length(text);
  if (size > limit) problems.push(`${what} has ${size} characters, Discord allows ${limit}`);
}

function embedSize(embed: Embed): number {
  return (
    length(embed.title) +
    length(embed.description) +
    length(embed.footer) +
    length(embed.author?.name) +
    (embed.fields ?? []).reduce((sum, field) => sum + length(field.name) + length(field.value), 0)
  );
}

/** What in the reply breaks a Discord limit; empty when Discord would accept it. */
export function replyLimitProblems(reply: Reply): string[] {
  const problems: string[] = [];
  if (typeof reply === "string") {
    check(problems, "content", reply, DISCORD_LIMITS.content);
    return problems;
  }
  check(problems, "content", reply.content, DISCORD_LIMITS.content);
  const embeds = reply.embeds ?? [];
  if (embeds.length > DISCORD_LIMITS.embeds) {
    problems.push(`${embeds.length} embeds, Discord allows ${DISCORD_LIMITS.embeds}`);
  }
  embeds.forEach((embed, index) => {
    const at = `embed ${index}`;
    check(problems, `${at} title`, embed.title, DISCORD_LIMITS.title);
    check(problems, `${at} description`, embed.description, DISCORD_LIMITS.description);
    check(problems, `${at} footer`, embed.footer, DISCORD_LIMITS.footer);
    check(problems, `${at} author`, embed.author?.name, DISCORD_LIMITS.authorName);
    const fields = embed.fields ?? [];
    if (fields.length > DISCORD_LIMITS.fields) {
      problems.push(`${at} has ${fields.length} fields, Discord allows ${DISCORD_LIMITS.fields}`);
    }
    fields.forEach((field, fieldIndex) => {
      check(problems, `${at} field ${fieldIndex} name`, field.name, DISCORD_LIMITS.fieldName);
      check(problems, `${at} field ${fieldIndex} value`, field.value, DISCORD_LIMITS.fieldValue);
    });
  });
  const total = embeds.reduce((sum, embed) => sum + embedSize(embed), 0);
  if (total > DISCORD_LIMITS.embedTotal) {
    problems.push(
      `embeds have ${total} characters together, Discord allows ${DISCORD_LIMITS.embedTotal}`,
    );
  }
  return problems;
}

/**
 * Throws when Discord would reject the reply. The adapters call it before sending, so the log names the
 * field that is too long instead of Discord's generic "Invalid Form Body"; the fake contexts call it so a
 * test catches the same reply.
 */
export function validateReplyLimits(reply: Reply): void {
  const problems = replyLimitProblems(reply);
  if (problems.length > 0) throw new Error(`Reply breaks Discord limits: ${problems.join("; ")}`);
}
