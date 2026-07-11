"use client";

/**
 * useSupportContext — the single place every page gathers client-side
 * ambient context (current page URL, browser, OS, timezone) before opening
 * ContactSupportModal. Source-specific fields (draftId, publishJobId, …) are
 * passed in by the caller per entry point; this hook only centralizes the
 * ambient bits so no page has to re-derive them.
 *
 * The actual sanitization/normalization happens server-side in
 * buildSupportContext (web/src/lib/support/context.ts) — this hook never
 * decides what's "safe", it just collects what the browser can see.
 */

import { usePathname } from "next/navigation";
import { useCallback } from "react";

function detectOs(userAgent: string): string {
  if (/windows/i.test(userAgent)) return "Windows";
  if (/mac os|macintosh/i.test(userAgent)) return "macOS";
  if (/android/i.test(userAgent)) return "Android";
  if (/iphone|ipad|ios/i.test(userAgent)) return "iOS";
  if (/linux/i.test(userAgent)) return "Linux";
  return "Unknown";
}

export function useSupportContext() {
  const pathname = usePathname();

  const gatherAmbientContext = useCallback(
    (extra?: Record<string, unknown>): Record<string, unknown> => {
      const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "";
      return {
        pageUrl: typeof window !== "undefined" ? window.location.href : pathname,
        browser: userAgent || null,
        os: userAgent ? detectOs(userAgent) : null,
        timezone: typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : null,
        ...extra,
      };
    },
    [pathname],
  );

  return { gatherAmbientContext };
}
