/** Shared, framework-free behavior used by the public shell and its tests. */

export const PUBLIC_CONTROL_MIN_SIZE = 44;
export const PUBLIC_HEADER_COMPACT_MAX_WIDTH = 390;

const PUBLIC_SHELL_PATHS = new Set([
  "/",
  "/pricing",
  "/contact",
  "/about",
  "/careers",
  "/privacy",
  "/terms",
  "/refund-policy",
  "/acceptable-use-policy",
  "/data-deletion-status",
  "/pinterest-app",
  "/welcome",
  "/login",
  "/signup",
]);

export function isPublicShellRoute(pathname: string): boolean {
  return PUBLIC_SHELL_PATHS.has(pathname.replace(/\/$/, "") || "/");
}

/**
 * The public header keeps the appearance controls in normal document flow.
 * At the narrowest supported viewport its neighboring navigation links are
 * hidden, so controls and the primary action never occupy the same pixels.
 */
export function isPublicHeaderCompact(viewportWidth: number): boolean {
  return viewportWidth <= PUBLIC_HEADER_COMPACT_MAX_WIDTH;
}

export function closePublicMenuOnEscape(
  key: string,
  close: () => void,
  focusTrigger: () => void,
): boolean {
  if (key !== "Escape") return false;
  close();
  focusTrigger();
  return true;
}
