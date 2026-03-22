const COOKIE_REGEX = /(?:^|;\s*)_codex_session=([^;]*)/;

/** Extract the _codex_session cookie value from a Cookie header. */
export function parseSessionCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  const match = COOKIE_REGEX.exec(cookieHeader);
  return match ? match[1] : undefined;
}
