/** Discord's hosts for avatars, icons, emoji, attachments and its proxy copies of embed images. */
const DISCORD_MEDIA = "https://cdn.discordapp.com https://media.discordapp.net";

/**
 * Sent with every response (ADR 9). The page loads its script, style and data from its own origin only, and
 * images and video only from Discord's media hosts (anything elsewhere shows as a link); it cannot be framed,
 * and no form or `<base>` can send it elsewhere.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy":
    `default-src 'self'; img-src 'self' ${DISCORD_MEDIA}; media-src ${DISCORD_MEDIA}; ` +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

/**
 * Adds the security headers, and `Cache-Control: no-store` to any response that sets no caching of its own:
 * API, health and error answers hold live guild data that neither the browser nor a proxy should keep. The
 * page and its hashed assets set their own.
 */
export function withSecurityHeaders(response: Response): Response {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.headers.set(name, value);
  if (!response.headers.has("Cache-Control")) response.headers.set("Cache-Control", "no-store");
  return response;
}
