"use client";

import { useRouter } from "next/navigation";

/**
 * "← Back" affordance for public marketing/legal pages. Pinned in the sticky
 * nav (not just a buried footer link) so it's visible without scrolling.
 *
 * Prefers real browser-history back navigation when the user actually
 * navigated here from within the site (so it returns to wherever they came
 * from — pricing, a search result, another legal page, etc). Falls back to
 * Home when there's no same-origin referrer/history to go back to (direct
 * link, new tab, external referrer) — router.back() would otherwise do
 * nothing or leave the site.
 */
export function BackButton({ fallbackHref = "/" }: { fallbackHref?: string }) {
  const router = useRouter();

  function handleClick() {
    const cameFromSite =
      typeof window !== "undefined" &&
      window.history.length > 1 &&
      document.referrer &&
      new URL(document.referrer).origin === window.location.origin;

    if (cameFromSite) router.back();
    else router.push(fallbackHref);
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className="flex items-center gap-1.5 text-[12px] font-semibold transition-colors hover:text-white"
      style={{ color: "#9097A0", background: "none", border: "none", padding: 0, cursor: "pointer" }}
    >
      ← Back
    </button>
  );
}
