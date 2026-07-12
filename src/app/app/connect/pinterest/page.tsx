"use client";

/**
 * Pinterest connect interstitial.
 *
 * The /api/auth/pinterest/connect route does a Supabase session lookup before it can
 * return its 302 to Pinterest, which can take a second or two. Navigating to it
 * directly leaves the previous page looking frozen. This lightweight client page
 * paints instantly ("Opening Pinterest…"), then kicks off the real OAuth route from
 * an effect — so the user always sees immediate, honest feedback during the wait.
 *
 * It carries the `next` return URL through untouched (which already encodes pinId,
 * weeklyPlanItemId, and source), and never touches OAuth state / PKCE / tokens.
 */

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import BrandLogo from "@/components/BrandLogo";

const UI = {
  bg: "var(--app-bg, #0B0F1A)",
  card: "var(--app-surface, #161D2E)",
  border: "var(--app-border, rgba(255,255,255,0.10))",
  text: "var(--app-text, #E2E8F0)",
  textSec: "var(--app-text-sec, #8892A4)",
  textMuted: "#5B6577",
  gradient: "linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)",
};

import { SETTINGS_PINTEREST_PATH } from "@/lib/settingsPaths";

/** Only allow same-origin app return targets (mirrors the connect route's guard). */
function safeNext(value: string | null): string {
  if (!value) return SETTINGS_PINTEREST_PATH;
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded.startsWith("/app/")) return SETTINGS_PINTEREST_PATH;
    if (decoded.startsWith("//") || decoded.includes("://")) return SETTINGS_PINTEREST_PATH;
    return decoded;
  } catch {
    return SETTINGS_PINTEREST_PATH;
  }
}

function ConnectInterstitial() {
  const searchParams = useSearchParams();
  const next = safeNext(searchParams.get("next"));
  const connectUrl = `/api/auth/pinterest/connect?next=${encodeURIComponent(next)}`;

  const [timedOut, setTimedOut] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedRef = useRef(false);

  const go = useCallback(() => {
    setTimedOut(false);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    // If the browser hasn't navigated away within ~10s, surface a retry.
    timeoutRef.current = setTimeout(() => setTimedOut(true), 10000);
    // Next paint, then hand off to the OAuth route. Use replace() (not assign()) so
    // this interstitial is NOT a back-navigable history entry: pressing Back on
    // Pinterest returns to the page the user started from (Plan / Settings), never
    // to this page frozen mid-redirect.
    requestAnimationFrame(() => { window.location.replace(connectUrl); });
  }, [connectUrl]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    go();
    return () => { if (timeoutRef.current) clearTimeout(timeoutRef.current); };
  }, [go]);

  // Back-forward cache guard: if a browser restores this page from bfcache (e.g. the
  // user pressed Back on Pinterest and the browser keeps the interstitial), the
  // redirect already fired in a previous life and the mount effect will NOT re-run —
  // which would otherwise leave the "Opening Pinterest…" spinner frozen forever
  // inside the app shell. Detect the restore and surface the manual choice instead.
  useEffect(() => {
    function onPageShow(e: PageTransitionEvent) {
      if (!e.persisted) return;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      setTimedOut(true);
    }
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: UI.bg, padding: 20 }}>
      <div data-testid="pinterest-connect-interstitial" style={{ width: "min(420px, 92vw)", textAlign: "center", background: UI.card, border: `1px solid ${UI.border}`, borderRadius: 18, padding: "32px 28px", boxShadow: "0 24px 70px rgba(0,0,0,0.5)" }}>
        {/* Current VibePin logo — shared BrandLogo component (same as the app sidebar). */}
        <BrandLogo size={48} style={{ margin: "0 auto 18px" }} />

        {timedOut ? (
          <>
            <p data-testid="connect-timeout-title" style={{ margin: "0 0 8px", fontSize: 16, fontWeight: 800, color: UI.text }}>Continue connecting Pinterest?</p>
            <p style={{ margin: "0 0 20px", fontSize: 12.5, color: UI.textSec, lineHeight: 1.55 }}>You can continue to Pinterest, or go back to VibePin and try again later.</p>
            <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
              <button type="button" data-testid="connect-retry" onClick={go}
                style={{ padding: "11px 20px", borderRadius: 10, border: "none", background: UI.gradient, color: "#fff", fontSize: 13, fontWeight: 800, cursor: "pointer" }}>
                Continue to Pinterest
              </button>
              <button type="button" data-testid="connect-cancel" onClick={() => { window.location.replace(next); }}
                style={{ padding: "11px 20px", borderRadius: 10, border: `1px solid ${UI.border}`, background: "transparent", color: UI.text, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                Back to app
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={{ width: 34, height: 34, margin: "0 auto 16px", border: "3px solid rgba(255,255,255,0.15)", borderTopColor: "#D946EF", borderRadius: "50%", animation: "vp-connect-spin 0.7s linear infinite" }} />
            <p style={{ margin: "0 0 6px", fontSize: 16, fontWeight: 800, color: UI.text }}>Opening Pinterest…</p>
            <p style={{ margin: 0, fontSize: 12.5, color: UI.textSec, lineHeight: 1.55 }}>You&apos;ll return to your Pin after connecting your account.</p>
          </>
        )}
      </div>
      <style>{`@keyframes vp-connect-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

export default function PinterestConnectPage() {
  return (
    <Suspense fallback={
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: UI.bg, color: UI.textSec }}>
        Opening Pinterest…
      </div>
    }>
      <ConnectInterstitial />
    </Suspense>
  );
}
