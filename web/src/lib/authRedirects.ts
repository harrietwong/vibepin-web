/** Shared, environment-neutral auth redirect and error helpers. */

export const DEFAULT_AUTH_NEXT = "/app/studio";

/** Only allow same-origin application paths as post-auth destinations. */
export function safeNextPath(value: string | null | undefined): string {
  if (
    value &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\\") &&
    !value.startsWith("/login") &&
    !value.startsWith("/signup") &&
    !value.startsWith("/auth")
  ) {
    return value;
  }
  return DEFAULT_AUTH_NEXT;
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
