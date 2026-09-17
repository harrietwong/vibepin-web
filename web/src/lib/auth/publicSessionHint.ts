type CookieLike = { name: string; value: string };

/**
 * A public-page rendering hint only. It deliberately does not parse, refresh, or
 * trust the cookie value; client `auth.getUser()` remains the auth boundary.
 */
export function hasPublicSessionCookie(cookies: readonly CookieLike[]): boolean {
  return cookies.some(({ name, value }) =>
    value.length > 0 && name.startsWith("sb-") && /-auth-token(?:\.\d+)?$/.test(name),
  );
}
