"use client";

/**
 * SyncStatusIndicator — WP-E. A small, low-key topbar dot that surfaces the
 * account-level sync state so a silent sync failure is no longer invisible.
 *
 *   synced  → renders nothing (unobtrusive; the happy path stays quiet)
 *   syncing → a quiet pulsing blue dot + tooltip "Syncing… (N pending)"
 *   error   → an amber dot + tooltip "Sync issue — retrying. Your data is safe."
 *
 * It merges BOTH sync engines (userStoreSync aggregate + pinDraftSync) via
 * useSyncExternalStore. SSR-safe: the server snapshot is always "synced" (→ null),
 * matching the client's first paint before any engine reports, so there is no
 * hydration mismatch. Copy runs through the typed i18n catalog (English fallback).
 */

import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import {
  getAggregateSyncStatus,
  subscribeSyncStatus,
  type AggregateSyncStatus,
} from "@/lib/userStoreSync";
import {
  getPinDraftSyncStatus,
  subscribePinDraftSyncStatus,
  type PinDraftSyncStatus,
} from "@/lib/pinDraftSync";
import { useLocale } from "@/lib/i18n/LocaleProvider";

// Stable references so useSyncExternalStore's server/first-paint snapshot never
// changes identity (a fresh object each call would loop React forever).
const SERVER_SNAPSHOT: AggregateSyncStatus = { state: "synced", pendingCount: 0, errorStores: [] };
const serverSnapshot = () => SERVER_SNAPSHOT;

type CombinedState = "synced" | "syncing" | "error";

function combine(a: AggregateSyncStatus, b: PinDraftSyncStatus): { state: CombinedState; pendingCount: number } {
  const state: CombinedState =
    a.state === "error" || b.state === "error"
      ? "error"
      : a.state === "syncing" || b.state === "syncing"
        ? "syncing"
        : "synced";
  return { state, pendingCount: a.pendingCount + b.pendingCount };
}

export function SyncStatusIndicator() {
  const { t } = useLocale();
  const aggregate = useSyncExternalStore(subscribeSyncStatus, getAggregateSyncStatus, serverSnapshot);
  const drafts = useSyncExternalStore(subscribePinDraftSyncStatus, getPinDraftSyncStatus, serverSnapshot);

  const [tip, setTip] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);

  const show = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setTip({ top: r.bottom + 8, left: r.left + r.width / 2 });
  }, []);
  const hide = useCallback(() => setTip(null), []);

  const { state, pendingCount } = combine(aggregate, drafts);

  // Happy path stays silent.
  if (state === "synced") return null;

  const isError = state === "error";
  const color = isError ? "#F59E0B" : "#3B82F6";
  const label =
    isError
      ? t("sync.status.error")
      : `${t("sync.status.syncing")}${pendingCount > 0 ? ` (${pendingCount})` : ""}`;

  return (
    <>
      <style>{"@keyframes vp-sync-pulse{0%,100%{opacity:.35;transform:scale(.85)}50%{opacity:1;transform:scale(1)}}"}</style>
      <span
        ref={ref}
        role="status"
        aria-live="polite"
        aria-label={label}
        data-testid="sync-status-indicator"
        data-sync-state={state}
        onMouseEnter={show}
        onMouseLeave={hide}
        style={{
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          width: 22, height: 22, borderRadius: "50%", cursor: "default", flexShrink: 0,
        }}
      >
        <span
          style={{
            width: 8, height: 8, borderRadius: "50%", background: color,
            boxShadow: `0 0 0 3px ${isError ? "rgba(245,158,11,0.16)" : "rgba(59,130,246,0.16)"}`,
            animation: isError ? undefined : "vp-sync-pulse 1.2s ease-in-out infinite",
          }}
        />
      </span>
      {tip && (
        <span
          role="tooltip"
          style={{
            position: "fixed", top: tip.top, left: tip.left, transform: "translateX(-50%)",
            maxWidth: 240, whiteSpace: "normal", textAlign: "center",
            padding: "6px 11px", borderRadius: 8,
            background: "var(--app-dropdown-bg)", border: "1px solid var(--app-dropdown-border)",
            color: "var(--app-text)", fontSize: 12, fontWeight: 600, lineHeight: 1.35,
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)", zIndex: 1000, pointerEvents: "none",
          }}
        >
          {label}
        </span>
      )}
    </>
  );
}

export default SyncStatusIndicator;
