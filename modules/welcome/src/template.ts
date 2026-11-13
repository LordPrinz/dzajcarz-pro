import { DISCORD_LIMITS, escapeMarkdown, fillTemplate } from "@dzajcarz/core";

/** Discord's message length limit; a longer greeting would be rejected on send. */
export const MAX_MESSAGE_LENGTH = DISCORD_LIMITS.content;

export interface WelcomeValues {
  /** Snowflake of the new member; rendered as a mention. */
  userId: string;
  username: string;
  serverName: string;
  memberCount: number;
}

/**
 * Fills `{user}`, `{username}`, `{server}` and `{memberCount}`; member and server names are markdown-escaped.
 * See `fillTemplate` for the rules.
 */
export function renderWelcome(template: string, values: WelcomeValues): string {
  return fillTemplate(template, {
    user: `<@${values.userId}>`,
    username: escapeMarkdown(values.username),
    server: escapeMarkdown(values.serverName),
    memberCount: String(values.memberCount),
  });
}
