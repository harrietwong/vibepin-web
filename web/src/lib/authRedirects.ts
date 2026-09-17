/** Shared, environment-neutral auth redirect and error helpers. */

export const DEFAULT_AUTH_NEXT = "/app/studio";

const REDIRECT_CHECK_ORIGIN = "https://vibepin.invalid";

function hasEncodedRemainder(value: string): boolean {
  return /%[0-9a-f]{2}/i.test(value);
}

function isAuthLoopPath(pathname: string): boolean {
  return ["/login", "/signup", "/auth"].some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/** Decode the one transport encoding used by the transient auth cookie. */
export function decodeAuthNextCookie(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const decoded = decodeURIComponent(value);
    // A second encoded layer is never produced by login/signup. Reject it
    // instead of guessing which redirect the caller meant.
    if (hasEncodedRemainder(decoded) || decoded.includes("\uFFFD")) return null;
    return decoded;
  } catch {
    // A malformed cookie is attacker-controlled input, not a server error.
    return null;
  }
}

/** Resolve query/cookie state with an explicit query-first precedence rule. */
export function resolveAuthNext(
  queryNext: string | null | undefined,
  cookieNext: string | null | undefined,
): string {
  if (queryNext !== null && queryNext !== undefined) {
    // URLSearchParams has already consumed one encoding layer. A remaining
    // escape therefore indicates a double-encoded value and must fail closed.
    if (hasEncodedRemainder(queryNext)) return DEFAULT_AUTH_NEXT;
    return safeNextPath(queryNext);
  }
  return safeNextPath(decodeAuthNextCookie(cookieNext));
}

/** Only allow same-origin application paths as post-auth destinations. */
export function safeNextPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.includes("\\") || value.includes("\uFFFD")) {
    return DEFAULT_AUTH_NEXT;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return DEFAULT_AUTH_NEXT;
  }

  if (
    !decoded.startsWith("/") ||
    decoded.startsWith("//") ||
    decoded.includes("\\") ||
    decoded.includes("\uFFFD") ||
    hasEncodedRemainder(decoded)
  ) {
    return DEFAULT_AUTH_NEXT;
  }

  try {
    const normalized = new URL(decoded, REDIRECT_CHECK_ORIGIN);
    if (
      normalized.origin !== REDIRECT_CHECK_ORIGIN ||
      normalized.pathname.startsWith("//") ||
      isAuthLoopPath(normalized.pathname)
    ) {
      return DEFAULT_AUTH_NEXT;
    }
  } catch {
    return DEFAULT_AUTH_NEXT;
  }

  return value;
}

export type AuthUiErrorCode =
  | "oauth_unavailable"
  | "oauth_callback"
  | "authentication_failed";

/**
 * Deliberately static user-facing copy. Raw Supabase/Google messages, OAuth codes,
 * emails, tokens and configuration values must never be reflected into the UI.
 */
export function authUiErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  if (code === "oauth_unavailable") {
    return "Google sign-in is unavailable for this environment. Use email and password, or contact support if you need help.";
  }
  if (code === "oauth_callback") {
    return "Google sign-in could not be completed. Use email and password, or try Google again later.";
  }
  return "Authentication failed. Check your details and try again, or contact support if the problem continues.";
}

/** Safe callback-failure redirect that preserves only the validated in-app path. */
export function authFailureRedirect(next: string): string {
  const params = new URLSearchParams({
    error: "oauth_callback",
    next: safeNextPath(next),
  });
  return `/login?${params.toString()}`;
}
