/** Discord's message length limit; a longer greeting would be rejected on send. */
export const MAX_MESSAGE_LENGTH = 2000;

export interface WelcomeValues {
  /** Snowflake of the new member; rendered as a mention. */
  userId: string;
  username: string;
  serverName: string;
  memberCount: number;
}

/**
 * Fills `{user}`, `{username}`, `{server}` and `{memberCount}` in one pass over the template. Because
 * the substituted text is never scanned again, a member called `{server}` shows up literally instead of
 * turning into the server name. Unknown placeholders stay as written. The result is cut to Discord's limit.
 */
export function renderWelcome(template: string, values: WelcomeValues): string {
  const replacements: Record<string, string> = {
    user: `<@${values.userId}>`,
    username: values.username,
    server: values.serverName,
    memberCount: String(values.memberCount),
  };
  const rendered = template.replace(/\{(\w+)\}/g, (placeholder, key: string) =>
    Object.hasOwn(replacements, key) ? (replacements[key] as string) : placeholder,
  );
  return rendered.slice(0, MAX_MESSAGE_LENGTH);
}
