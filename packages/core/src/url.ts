/**
 * Whether the credentials of `scheme://user:password@host/…` parse as written. An unencoded `/`, `?` or `#`
 * in the password ends the host part early, and a second `@` is read differently by different parsers, so
 * the client would connect somewhere else or without the password. An `@` in the query string trips it too,
 * which is fine: compose never builds such a URL.
 */
export function credentialsIntact(value: string): boolean {
  const afterScheme = value.slice(value.indexOf("://") + 3);
  const at = afterScheme.lastIndexOf("@");
  if (at === -1) return true;
  const userinfo = afterScheme.slice(0, at);
  if (/[@/?#]/.test(userinfo)) return false;
  // `user:` with nothing after the colon is a password that got lost on the way, e.g. an unset variable.
  return !userinfo.endsWith(":");
}
