"use client";

import { useEffect, useRef } from "react";

/**
 * Contextual back/close for full-screen in-app overlays (Batch Edit, and any
 * similar workspace that renders on top of a route instead of as its own route).
 *
 * ## Why this exists
 * Batch Edit opens as an in-page overlay — it does NOT push a browser history
 * entry. The on-screen X/Escape close it correctly and keep you on the entry
 * page. But the browser / hardware **Back button** (and edge-swipe back) was not
 * intercepted, so Back discarded the current route entirely and navigated to the
 * *previously visited* page. For a user who reached Create Pins from Weekly Plan,
 * that previous page is Weekly Plan — which is exactly why "Create Pins → Batch
 * Edit → Back" appeared to "default to Weekly Plan". There is no hardcoded
 * `/weekly-plan` fallback; the culprit is the un-intercepted browser history.
 *
 * ## The fix (return-navigation for overlays)
 * When the overlay opens we push a throwaway history entry that keeps the SAME
 * URL (so Next's router does not treat it as a route change — this integrates
 * with the App Router per the "Native History API" guide). A Back gesture then
 * pops that entry and fires `popstate`, which we intercept to close the overlay
 * (or its innermost sub-layer) WITHOUT navigating. The user therefore stays on
 * the page that opened the overlay — Create Pins stays on Create Pins, Weekly
 * Plan stays on Weekly Plan, Monthly Plan stays on Monthly Plan — with no
 * per-entry `returnTo` route to pass or get stale. Programmatic closes (X /
 * Escape) unwind the pushed entry so the history stack stays clean.
 *
 * `onBack` returns `true` when the overlay fully closed, or `false` when it only
 * dismissed an inner layer (e.g. a nested Pin-details drawer) and should stay
 * open — in which case Back is re-armed so the next Back closes the next layer.
 * This mirrors the Escape key's layered dismiss.
 */

export interface HistoryLike {
  pushState(data: unknown, unused: string, url?: string | null): void;
  back(): void;
}

export interface WindowLike {
  history: HistoryLike;
  location: { href: string };
  addEventListener(type: "popstate", listener: () => void): void;
  removeEventListener(type: "popstate", listener: () => void): void;
}

/** Marker stored on the pushed history entry so we can recognise our own entries. */
export const OVERLAY_HISTORY_MARKER = "__vpOverlayBack";

/**
 * Framework-agnostic controller that owns the pushState/popstate bookkeeping.
 * Extracted from the hook so the history behaviour is unit-testable without a
 * React renderer (see scripts/test-batch-edit-back-close.ts).
 */
export function createOverlayHistory(win: WindowLike, onBack: () => boolean) {
  let armed = false;
  // True once a Back gesture consumed our pushed entry (so disarm must NOT pop
  // again — the entry is already gone).
  let closedByBack = false;

  const push = () => win.history.pushState({ [OVERLAY_HISTORY_MARKER]: true }, "", win.location.href);

  const onPopState = () => {
    const fullyClosed = onBack();
    if (fullyClosed) {
      closedByBack = true;
    } else {
      // Only an inner layer closed; the overlay is still open. Back consumed our
      // entry, so re-arm with a fresh one to catch the next Back.
      push();
    }
  };

  return {
    arm() {
      if (armed) return;
      armed = true;
      closedByBack = false;
      push();
      win.addEventListener("popstate", onPopState);
    },
    /**
     * @param opts.unmounting true when tearing down because the whole route is
     *   navigating away (a real component unmount). In that case the outgoing
     *   navigation owns the history stack, so we must NOT call history.back() —
     *   doing so would undo the user's navigation.
     */
    disarm(opts?: { unmounting?: boolean }) {
      if (!armed) return;
      armed = false;
      win.removeEventListener("popstate", onPopState);
      if (!closedByBack && !opts?.unmounting) {
        // Closed via X / Escape while our entry is still on top → remove it.
        win.history.back();
      }
    },
  };
}

export function useBackButtonClose(active: boolean, onBack: () => boolean) {
  const onBackRef = useRef(onBack);
  useEffect(() => { onBackRef.current = onBack; });

  // Distinguishes a real unmount (route change) from an `active` toggle so a
  // programmatic close never fights an in-flight route navigation. Declared
  // before the main effect so its cleanup runs first on unmount.
  const unmounting = useRef(false);
  useEffect(() => () => { unmounting.current = true; }, []);

  useEffect(() => {
    if (!active || typeof window === "undefined") return;
    const ctrl = createOverlayHistory(window as unknown as WindowLike, () => onBackRef.current());
    ctrl.arm();
    return () => ctrl.disarm({ unmounting: unmounting.current });
  }, [active]);
}
