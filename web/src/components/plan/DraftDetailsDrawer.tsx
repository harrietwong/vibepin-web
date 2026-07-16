"use client";

/**
 * Pin Details & Publish — the single centered modal for the Weekly Plan.
 *
 * This is the ONLY surface for editing a Pin's metadata and publishing it to
 * Pinterest. There is no separate side drawer and no second publish modal: the
 * user edits Title / Description / Alt text / Destination URL / Planned date,
 * picks a board, attaches product links, and either Saves or Publishes — all in
 * one place.
 *
 * The component keeps the legacy export name `DraftDetailsDrawer` and prop shape
 * so the Weekly Plan call sites are unchanged. Saving writes through
 * pinDraftStore.updateDraft, which emits DRAFT_STORE_EVENT — every Weekly Plan
 * section listens and refreshes live, so Save keeps this modal open.
 *
 * Backend connection status loads via /api/pinterest/status first. When disconnected,
 * board selection shows Connect Pinterest; Publish redirects to OAuth immediately.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { X, Loader2, CheckCircle2, ExternalLink, AlertCircle, Info, MoreVertical } from "lucide-react";
import { PinBoardSection } from "@/components/pin-details/PinBoardSection";
import { PinPlannedDateTimeSection } from "@/components/pin-details/PinPlannedDateTimeSection";
import { PinProductLinksSection } from "@/components/pin-details/PinProductLinksSection";
import { getPinDisplayContext } from "@/lib/studio/pinDisplayContext";
import { PinTitleSection } from "@/components/pin-details/PinTitleSection";
import { PinAltTextSection } from "@/components/pin-details/PinAltTextSection";
import { toast } from "sonner";
import type { PinDraft } from "@/lib/pinDraftStore";
import * as pinDraftStore from "@/lib/pinDraftStore";
import { sanitizeHandoffField, plannableDateISO } from "@/lib/weeklyPlanHandoff";
import { formatEnglishDateTime } from "@/lib/dateTimeFormat";
import { writePinProducts, type LinkedProduct } from "@/lib/pinMetadata";
import {
  combinePlannedAt,
  getPinReadiness,
  type PinDetailsDraft,
  type PinDetailsMode,
  type PinDetailsSource,
} from "@/lib/pinDetailsModel";
import { toProxyUrl } from "@/lib/imageProxy";
import {
  fetchPinterestBoards,
  fetchPinterestDefaultBoard,
  fetchPinterestStatusCached,
  publishPin,
  savePinterestDefaultBoard,
  createSandboxDemoBoard,
  PINTEREST_DISCONNECTED_EVENT,
  type AttachedProduct,
  type PinterestBoard,
  type PinterestDefaultBoard,
  type PinterestClientError,
  type PinterestStatus,
} from "@/lib/pinterestClient";
import { getCachedBoardsResult, isCacheFresh, setCachedBoardsResult } from "@/lib/pinterest/boardsCache";
import { isRealPinterestConnection, canPublishWithPinterest } from "@/lib/pinterest/connection";
import { beginPublish, endPublish, mapPublishErrorToCategory } from "@/lib/studio/pinLifecycle";
import { ConfirmPublishDialog } from "@/components/shared/ConfirmPublishDialog";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { isPublishableImage, isValidDestinationUrl, pinFieldErrors } from "@/lib/pinReadiness";
import { PublishDestinations } from "@/components/social/PublishDestinations";
import { PinAICopyPanel } from "@/components/pins/PinAICopyPanel";
import { publishToSocial } from "@/lib/social/socialClient";
import { platformName, type SocialProvider } from "@/lib/social/platforms";
import { useLocale } from "@/lib/i18n/LocaleProvider";

const UI = {
  card: "var(--app-surface, #161D2E)",
  surface2: "var(--app-surface-2, #1A2236)",
  surface3: "var(--app-surface-3, #0F1524)",
  border: "var(--app-border, rgba(255,255,255,0.10))",
  fieldBorder: "var(--app-border-hi, rgba(255,255,255,0.18))",
  text: "var(--app-text, #E2E8F0)",
  textSec: "var(--app-text-sec, #8892A4)",
  textMuted: "var(--app-text-muted, #5B6577)",
  purple: "#A78BFA",
  purpleBg: "rgba(139,92,246,0.16)",
  warning: "#D97706",
  error: "#EF4444",
  success: "#10B981",
  info: "#60A5FA",
  gradient: "linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)",
};

let _pid = 0;
function newProductId(): string { return `vp_prod_${Date.now()}_${_pid++}`; }

type BoardsStatus = "checking" | "preparing" | "loading" | "ready" | "not_connected" | "error";

function needsPinterestConnect(err?: PinterestClientError | { code?: string; needsReconnect?: boolean }): boolean {
  // Deliberately NOT "unauthorized" here: that code means our own Supabase Bearer
  // token was rejected (see routeHelpers.ts unauthorized()) — an app-session auth
  // problem, not a fact about the Pinterest connection. Misclassifying it caused a
  // transient token hiccup right after OAuth return to flip the UI to "Connect
  // Pinterest to choose a board", falsely telling a just-connected user they weren't
  // connected. An "unauthorized" that survives the client's retry-once now correctly
  // falls through to the generic "Could not load boards. Try again" state instead.
  return !!err?.needsReconnect
    || err?.code === "not_connected"
    || err?.code === "needs_reconnect"
    || err?.code === "configuration_error";
}

export type PinDetailsModalProps = {
  draft: PinDraft | null;
  open: boolean;
  source: PinDetailsSource;
  mode: PinDetailsMode;
  onClose: () => void;
  onSaved?: (updated: PinDraft) => void;
  onAddToPlan?: (updated: PinDraft) => void;
  oauthReturnContext?: {
    viewMode?: "calendar" | "list";
    calendarScope?: "week" | "month";
    weekStart?: string;
    month?: string;
    category?: string;
  };
};

export function PinDetailsModal({
  draft, open, source, mode, onClose, onSaved, onAddToPlan, oauthReturnContext,
}: PinDetailsModalProps) {
  const { t } = useLocale();
  // ── Editable Pin metadata ───────────────────────────────────────────────────
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [altText, setAltText] = useState("");
  const [destinationUrl, setDestinationUrl] = useState("");
  const [plannedDate, setPlannedDate] = useState("");
  const [products, setProducts] = useState<AttachedProduct[]>([]);
  const [primaryProductId, setPrimaryProductId] = useState("");

  // ── Board loading (background) ──────────────────────────────────────────────
  const [boards, setBoards] = useState<PinterestBoard[]>([]);
  const [boardId, setBoardId] = useState("");
  const [defaultBoard, setDefaultBoard] = useState<PinterestDefaultBoard | null>(null);
  const defaultBoardRef = useRef<PinterestDefaultBoard | null>(null);
  const [boardsStatus, setBoardsStatus] = useState<BoardsStatus>("checking");
  const [pinterestConnected, setPinterestConnected] = useState(false);
  const [pinterestAccount, setPinterestAccount] = useState<PinterestStatus["account"] | null>(null);
  // Sandbox demo mode: lets the user seed a demo board when the sandbox account is empty.
  const [sandboxMode, setSandboxMode] = useState(false);
  const [creatingBoard, setCreatingBoard] = useState(false);

  // ── Save / dirty state ──────────────────────────────────────────────────────
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const autoSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistDraftRef = useRef<(() => PinDraft | null) | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const seededId = useRef<string | null>(null);

  // ── Add-product-link inline form ────────────────────────────────────────────
  const [addLinkOpen, setAddLinkOpen] = useState(false);
  const [lpUrl, setLpUrl] = useState("");
  const [lpName, setLpName] = useState("");

  // ── Publish state ───────────────────────────────────────────────────────────
  const [publishing, setPublishing] = useState(false);
  const [result, setResult] = useState<{ pinUrl: string; pinId: string; boardName: string; environment?: "sandbox" | "production" } | null>(null);
  const [trialAccess, setTrialAccess] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  // Purely additive — feeds the "Contact support" CTA's context, never read by
  // any publish/business logic. Counts attempts made in this modal session.
  const [publishAttempts, setPublishAttempts] = useState(0);
  // Lightweight inline validation shown next to the board field (no warning banner).
  const [boardError, setBoardError] = useState(false);
  // Field-level Website URL format error (PRD §14.2: shown near the field, not just a toast).
  const [urlError, setUrlError] = useState(false);
  // Field-level title/description over-limit error (WP1 follow-up) — empty stays fine;
  // only an over-cap value blocks Schedule/Publish. maxLength on the inputs prevents a
  // typed overflow, but an AI-generated or imported value can still land over the cap.
  const [fieldErrors, setFieldErrors] = useState<{ title?: string; description?: string }>({});
  // "Replace the current destination URL?" confirm (PRD §10.2) — replaces window.confirm.
  const [confirmReplaceUrlOpen, setConfirmReplaceUrlOpen] = useState(false);
  // Contact Support entry points (publish failed / AI generation failed). Supplements
  // Retry publish / Try again — never replaces them.
  // The "Contact support" entry points here open ContactSupportModal, which ships with
  // the Support cluster (deferred out of RC0 Create Pins). Until it lands the failure
  // UI keeps its error message + retry; the support shortcut is simply not offered.
  // Extra repurpose destinations chosen by the merchant (Pinterest is published
  // by the existing flow; these are the additional connected channels).
  const [socialDestinations, setSocialDestinations] = useState<SocialProvider[]>([]);
  // Guards the one-shot fan-out to extra channels after a successful publish.
  const socialFannedOutRef = useRef(false);

  // ── Scheduling ──────────────────────────────────────────────────────────────
  const [scheduledTime, setScheduledTime] = useState("");
  // "Keep this time when rebalancing" — reflects/edits the Pin's scheduleLocked flag.
  const [keepTimeLocked, setKeepTimeLocked] = useState(false);
  // Inline date/time editor revealed by the Schedule / Reschedule action.
  const [scheduleEditorOpen, setScheduleEditorOpen] = useState(false);
  // Overflow menu (Publish now / Unschedule) — keeps the footer to one primary CTA.
  const [overflowOpen, setOverflowOpen] = useState(false);
  // "Publish now" is irreversible and, when scheduled, drops the slot — confirm first.
  const [confirmPublishOpen, setConfirmPublishOpen] = useState(false);
  const boardSelectRef = useRef<HTMLInputElement | null>(null);

  // ── Pinterest redirect feedback ─────────────────────────────────────────────
  // A full-page navigation to the connect route — and Pinterest's own authorize page
  // after it — can legitimately take several seconds before the browser leaves this
  // page. We paint a "Redirecting to Pinterest…" state so the drawer never looks
  // frozen. IMPORTANT: there is deliberately NO timer that flips this to a failure
  // state. window.location.assign() cannot be "cancelled" from JS once called, so a
  // race-driven timeout only ever produces a false "could not open Pinterest" dialog
  // while the real navigation is still silently completing in the background (a
  // confirmed P0 bug — clicking "Cancel" on that false dialog still landed on
  // Pinterest, proving the redirect had never failed). `redirectFailed` is set ONLY
  // from a genuine synchronous failure of the assign() call itself.
  const [isRedirectingToPinterest, setIsRedirectingToPinterest] = useState(false);

  // Request-sequence + abort guard (mirrors PinterestSettingsPanel's status loader):
  // a new loadBoards() call supersedes any in-flight one, so a slow/late response can
  // never overwrite fresher state (e.g. flip back to "not connected" after the user
  // just connected, or clobber a newer board selection).
  const boardsLoadSeqRef = useRef(0);

  useEffect(() => {
    defaultBoardRef.current = defaultBoard;
  }, [defaultBoard]);

  const chooseBoardId = useCallback((items: PinterestBoard[], preferBoardId?: string, currentBoardId?: string) => {
    const defaultId = defaultBoardRef.current?.boardId ?? "";
    const candidates = [preferBoardId, currentBoardId, defaultId].map(v => v?.trim()).filter(Boolean) as string[];
    const match = candidates.find(id => items.some(b => b.id === id));
    if (match) return match;
    return items.length === 1 ? items[0].id : "";
  }, []);

  // Applies a boards result to UI state ONLY — does not touch the cache. Used both to
  // paint from an existing cache entry (must NOT refresh its timestamp — that would
  // make isCacheFresh() lie and the background revalidation below would never run
  // again) and to apply a freshly-fetched result (the caller writes the cache itself).
  const applyBoardsResult = useCallback((status: PinterestStatus, items: PinterestBoard[], preferBoardId?: string) => {
    setSandboxMode(status.environment === "sandbox");
    setPinterestConnected(isRealPinterestConnection(status));
    setPinterestAccount(status.account);
    setBoards(items);
    setBoardId(prev => {
      const next = chooseBoardId(items, preferBoardId, prev);
      if (next && !defaultBoardRef.current) {
        const board = items.find(b => b.id === next);
        if (board) {
          const value = { boardId: board.id, boardName: board.name };
          setDefaultBoard(value);
          void savePinterestDefaultBoard(value).catch(() => {});
        }
      }
      return next;
    });
    setBoardsStatus("ready");
  }, [chooseBoardId]);

  const loadBoards = useCallback(async (preferBoardId?: string) => {
    const seq = ++boardsLoadSeqRef.current;
    const isCurrent = () => seq === boardsLoadSeqRef.current;

    // Cache-first instant paint: reopening a drawer within the session shouldn't
    // re-run the full status → boards round trip (incl. a live Pinterest API call)
    // from a blank "checking…" state every time.
    const cached = getCachedBoardsResult();
    // Publish-path capability (db OR sandbox_demo) — NOT the strict merchant-connection
    // check: the sandbox demo flow must keep boards/publish working on drawer reopen.
    const paintedFromCache = !!cached && canPublishWithPinterest(cached.status);
    if (paintedFromCache) {
      applyBoardsResult(cached.status, cached.boards, preferBoardId);
      if (isCacheFresh(cached)) return; // fresh enough — skip the network round trip entirely
      // else: fall through and silently revalidate in the background (no spinner).
    } else if (cached) {
      // Cached "not connected" — still instant, but always revalidate (cheap, and the
      // user may have just completed OAuth in this same tab).
      setSandboxMode(cached.status.environment === "sandbox");
      setBoards([]);
      setBoardId("");
      setPinterestConnected(false);
      setPinterestAccount(null);
      setBoardsStatus("not_connected");
    } else {
      // No cache at all → first load this session, typically right after an OAuth
      // return. "preparing" reads as a calm one-time setup, not a slow reload.
      setBoardsStatus("preparing");
    }

    // Hard timeout so the board field never sits on "Checking…" / "Loading…" forever —
    // Pinterest's own /boards API can be slow, especially right after a fresh OAuth.
    let timedOut = false;
    const timeoutAfter = async <T,>(promise: Promise<T>): Promise<T> => {
      // The race itself enforces the 8s cap (it stops waiting). We deliberately do NOT
      // abort the underlying fetch: aborting it rejects the request with an AbortError
      // that has no remaining awaiter once the timeout wins, surfacing as an "Uncaught
      // (in promise) AbortError" that pops Next's dev overlay (looks like the modal
      // crashing). Instead the timed-out fetch is simply left to settle in the
      // background, ignored — and this no-op catch marks its eventual settlement handled
      // so it can never become an unhandled rejection.
      promise.catch(() => {});
      let timeout: ReturnType<typeof setTimeout> | null = null;
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              timedOut = true;
              reject(new Error("pinterest_boards_timeout"));
              // 12s, not 8s: a COLD boards load right after OAuth (no cache, dev
              // compile or high-latency proxy) routinely lands between 6.5s and
              // 8s — timing out at 8s turned a slow-but-successful load into a
              // spurious "Could not load boards".
            }, 12_000);
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    };
    // Run status and boards CONCURRENTLY. Serial "status → boards" doubled the
    // wall-clock of opening the drawer from a high-latency region; firing both at once
    // collapses it to max(status, boards). This is now safe on the post-OAuth path too
    // because the client GETs self-heal a just-expired token via 401-retry-once
    // (authedPinterestGet). We skip the eager boards call ONLY when a cached status
    // already proves the user is genuinely disconnected — post-OAuth (cached === null)
    // we fire both.
    const DEV = process.env.NODE_ENV !== "production";
    const t0 = DEV ? performance.now() : 0;
    const mark = (label: string) => { if (DEV) console.log(`[Pinterest boards timing] ${label}: ${(performance.now() - t0).toFixed(0)}ms`); };
    mark(paintedFromCache ? "load start (cache paint, revalidating)" : "drawer opened / load start");

    const fireBoards = paintedFromCache || !cached;
    mark(`status start${fireBoards ? " + boards start (concurrent)" : ""}`);
    // Used ONLY when the status request itself rejects (network/timeout) — a board
    // success alone proves SOME working connection, but never its real source, so
    // this is deliberately NOT tagged "db" (connectionSource left undefined/unknown).
    // A successful boards fetch must never by itself produce connectionSource: "db".
    const connectedFallbackStatus: PinterestStatus = {
      connected: true,
      account: null,
      scopes: [],
      needsReconnect: false,
    };
    const statusPromise = timeoutAfter(fetchPinterestStatusCached()).then(s => { mark("status finished"); return s; });
    const boardsPromise = fireBoards
      ? timeoutAfter(fetchPinterestBoards()).then(r => { mark(`boards finished (${r.items.length} boards)`); return r; })
      : null;
    // If we bail on status below (not connected), the in-flight boards call must not
    // surface as an unhandled rejection. This handler is independent of the await.
    boardsPromise?.catch(() => {});
    statusPromise.catch(() => {});
    try {
      if (boardsPromise) {
        try {
          const { items } = await boardsPromise;
          if (!isCurrent()) return;
          // The connection status used downstream is ALWAYS the real awaited status
          // result — never discarded just because it isn't a "real" (db) connection.
          // Only an outright failure of the status request itself falls back.
          let status: PinterestStatus;
          try {
            status = await statusPromise;
          } catch {
            // Board success already proves a working Pinterest connection can read
            // boards. Do not block the dropdown on a slower/failed account lookup.
            status = connectedFallbackStatus;
          }
          setCachedBoardsResult(status, items);
          applyBoardsResult(status, items, preferBoardId);
          mark(`ready - dropdown populated (${items.length} boards)`);
          return;
        } catch (boardsErr) {
          const status = await statusPromise;
          if (!isCurrent()) return;
          if (!canPublishWithPinterest(status)) {
            setCachedBoardsResult(status, []);
            if (!paintedFromCache) {
              setBoards([]);
              setBoardId("");
            }
            setPinterestConnected(false);
            setPinterestAccount(null);
            setBoardsStatus("not_connected");
            return;
          }
          setPinterestConnected(true);
          setPinterestAccount(status.account);
          throw boardsErr;
        }
      }

      const status = await statusPromise;
      if (!isCurrent()) return; // superseded by a newer load
      if (!canPublishWithPinterest(status)) {
        setCachedBoardsResult(status, []);
        if (!paintedFromCache) {
          setBoards([]);
          setBoardId("");
        }
        setPinterestConnected(false);
        setPinterestAccount(null);
        setBoardsStatus("not_connected");
        return;
      }
      setPinterestConnected(true);
      setPinterestAccount(status.account);
      // Keep the calm "preparing" copy on the first (no-cache) load; only show the
      // plain "loading" state when we're revalidating a prior (non-connected) cache.
      if (!paintedFromCache && cached) setBoardsStatus("loading");
      // Reuse the concurrent boards fetch when we prefetched it; otherwise (we thought
      // the user was disconnected but status says connected) fetch it now.
      const { items } = await timeoutAfter(fetchPinterestBoards())
        .then(r => { mark(`boards finished (${r.items.length} boards, late)`); return r; });
      if (!isCurrent()) return; // superseded by a newer load
      setCachedBoardsResult(status, items); // real network data — safe to (re)stamp the cache
      applyBoardsResult(status, items, preferBoardId);
      mark(`ready — dropdown populated (${items.length} boards)`);
    } catch (e) {
      if (!isCurrent()) return; // superseded — never let a stale/aborted result touch state
      // A background revalidation (we already painted usable cached boards) failing
      // silently is correct — the user still has working, if slightly stale, data.
      if (paintedFromCache) {
        console.warn("[Pinterest boards] background revalidation failed:", (e as Error)?.message);
        return;
      }
      const err = e as PinterestClientError;
      if (process.env.NODE_ENV !== "production") {
        // Diagnostic: distinguishes a Supabase-auth 401 (code "unauthorized" — our
        // Bearer token rejected) from a Pinterest-API 401 (code "pinterest_api_error"
        // / needsReconnect — Pinterest rejected the Pinterest token). No secrets.
        console.warn("[Pinterest boards] load failed:", {
          code: err.code ?? null,
          httpStatus: err.httpStatus ?? null,
          needsReconnect: err.needsReconnect === true,
          pinterestCode: err.pinterestCode ?? null,
          timedOut,
          message: err.message,
        });
      }
      setBoards([]);
      setBoardId("");
      if (!timedOut && needsPinterestConnect(err)) {
        setPinterestConnected(false);
        setPinterestAccount(null);
        setBoardsStatus("not_connected");
      } else {
        setBoardsStatus("error");
      }
    }
  }, [applyBoardsResult]);

  // Sandbox-only: create a demo board, then refresh the selector and preselect it.
  const handleCreateDemoBoard = useCallback(async () => {
    setCreatingBoard(true);
    try {
      const board = await createSandboxDemoBoard();
      // Optimistically show + select the new board. The sandbox board list is
      // eventually consistent, so it may not appear in a re-fetch for a few
      // seconds — don't make the user wait to see/select it.
      setBoards(prev => (prev.some(b => b.id === board.id) ? prev : [{ id: board.id, name: board.name }, ...prev]));
      setBoardId(board.id);
      setBoardsStatus("ready");
      setBoardError(false);
      markDirty();
      toast.success(t("pinDetails.toast.demoBoardCreated"));
      // Reconcile with the server list, but never drop the just-created board even
      // if the list hasn't caught up yet (eventual consistency).
      try {
        const { items } = await fetchPinterestBoards();
        setBoards(items.some(b => b.id === board.id) ? items : [{ id: board.id, name: board.name }, ...items]);
      } catch {
        /* keep the optimistic board on a transient list-fetch failure */
      }
    } catch {
      toast.error(t("pinDetails.toast.demoBoardError"));
    } finally {
      setCreatingBoard(false);
    }
    // markDirty is a stable per-render marker; setters are stable. No reactive deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const publicImage = draft ? toProxyUrl(draft.imageUrl) : "";
  const primaryProduct = useMemo(
    () => products.find(p => p.id === primaryProductId) ?? products[0] ?? null,
    [products, primaryProductId],
  );

  // Paint the "Redirecting to Pinterest…" state, THEN start the full-page navigation
  // on the next animation frame. flushSync forces React to commit the loading UI
  // before we hand the document over, so the drawer never appears frozen during the
  // connect wait. No timer marks this as failed — once assign() is called without
  // throwing, the browser owns navigation and JS cannot know it "failed" vs. "still
  // loading Pinterest's slow authorize page". The only real failure is assign()
  // itself throwing synchronously (malformed URL, blocked navigation, etc.).
  const beginPinterestRedirect = useCallback((targetUrl: string, clickT0?: number) => {
    const DEV = process.env.NODE_ENV !== "production";
    // Paint the "Redirecting to Pinterest…" state synchronously so the drawer reacts
    // on the very next frame — before any navigation work.
    flushSync(() => {
      setIsRedirectingToPinterest(true);
      setPublishError(null);
    });
    if (DEV && clickT0 != null) console.log(`[Pinterest connect start] visible redirecting state: ${(performance.now() - clickT0).toFixed(1)}ms`);
    requestAnimationFrame(() => {
      // Direct navigation to the server OAuth start route (no interstitial page,
      // no fetch-for-JSON). The route reads the session cookie and 302s to Pinterest.
      window.location.assign(targetUrl);
      if (DEV && clickT0 != null) console.log(`[Pinterest connect start] window.location.assign called: ${(performance.now() - clickT0).toFixed(1)}ms`);
    });
  }, [setIsRedirectingToPinterest, setPublishError]);

  // Go STRAIGHT to the OAuth start route — no interstitial page, no second confirmation.
  // The route reads the session cookie and 302s to Pinterest. We paint an inline
  // "Redirecting to Pinterest…" state (beginPinterestRedirect) so the drawer never looks
  // frozen. The `next` URL carries the return context (pinId, modal=publish, source,
  // weeklyPlanItemId) so we reopen this exact Pin after the callback returns.
  const goToPinterestOAuth = useCallback(() => {
    const DEV = process.env.NODE_ENV !== "production";
    // t0 = the instant the click handler starts. There is NO pre-redirect work here
    // (no status / boards / social-connections / sync-account / Settings refresh) —
    // just building the returnTo and navigating — so click→navigation is ~one frame.
    const clickT0 = DEV ? performance.now() : 0;
    if (DEV) console.log("[Pinterest connect start] click handler entered");
    const params = new URLSearchParams(window.location.search);
    if (draft?.id) {
      params.set("pinId", draft.id);
      params.set("modal", "publish");
      params.set("source", "weekly_plan_publish_modal");
      if (draft.weeklyPlanItemId) params.set("weeklyPlanItemId", draft.weeklyPlanItemId);
    }
    if (oauthReturnContext?.viewMode) params.set("view", oauthReturnContext.viewMode);
    if (oauthReturnContext?.calendarScope) params.set("scope", oauthReturnContext.calendarScope);
    if (oauthReturnContext?.weekStart) params.set("weekStart", oauthReturnContext.weekStart);
    if (oauthReturnContext?.month) params.set("month", oauthReturnContext.month);
    if (oauthReturnContext?.category) params.set("category", oauthReturnContext.category);
    // returnTo preserves the exact Plan context (path + view + pinId + drawer intent)
    // so the callback reopens this Pin. Never a Settings route for a Plan-origin connect.
    const next = `${window.location.pathname}?${params.toString()}`;
    if (DEV) console.log(`[Pinterest connect start] returnTo built: ${(performance.now() - clickT0).toFixed(1)}ms`);
    const internalUrl = `/api/auth/pinterest/connect?next=${encodeURIComponent(next)}`;
    if (DEV) console.log(`[Pinterest connect start] internal URL built: ${(performance.now() - clickT0).toFixed(1)}ms`);
    beginPinterestRedirect(internalUrl, clickT0);
  }, [draft, oauthReturnContext, beginPinterestRedirect]);

  // Seed once per draft when the modal opens. Keyed on draft id so live store
  // refreshes (Save → DRAFT_STORE_EVENT) never clobber in-progress edits.
  useEffect(() => {
    if (!open || !draft) return;
    if (seededId.current === draft.id) return;
    seededId.current = draft.id;
    setTitle(draft.title);
    setDescription(draft.description);
    setAltText(draft.altText);
    setDestinationUrl(draft.destinationUrl);
    // Status sync: derive the scheduled date/time from scheduledDate, falling back
    // to plannedAt, so the modal never shows "Not scheduled" for a Pin the card
    // shows as Scheduled.
    const seedDate = draft.scheduledDate?.trim() || (draft.plannedAt?.trim() ? draft.plannedAt.slice(0, 10) : "");
    const seedTime = draft.scheduledTime?.trim() || (draft.plannedAt?.includes("T") ? draft.plannedAt.slice(11, 16) : "");
    setPlannedDate(seedDate);
    setScheduledTime(seedTime);
    setKeepTimeLocked(!!draft.scheduleLocked);
    setScheduleEditorOpen(false);
    setProducts(seedProducts(draft));
    setPrimaryProductId(draft.primaryProductId ?? seedProducts(draft)[0]?.id ?? "");
    setDirty(false);
    setConfirmDiscard(false);
    setAddLinkOpen(false);
    setLpUrl(""); setLpName("");
    setPublishing(false);
    setResult(null);
    setTrialAccess(false);
    setPublishError(null);
    setBoardError(false);
    setUrlError(false);
    setConfirmReplaceUrlOpen(false);
    setPinterestConnected(false);
    setPinterestAccount(null);
    setSocialDestinations([]);
    socialFannedOutRef.current = false;
    setIsRedirectingToPinterest(false);
    void fetchPinterestDefaultBoard()
      .then(board => setDefaultBoard(board))
      .catch(() => {});
    void loadBoards(draft.boardId);
  }, [open, draft, loadBoards]);

  useEffect(() => {
    if (!open || boardsStatus !== "ready" || boardId || boards.length === 0) return;
    const next = chooseBoardId(boards, draft?.boardId);
    if (!next) return;
    setBoardId(next);
    if (!defaultBoard) {
      const board = boards.find(b => b.id === next);
      if (board) {
        const value = { boardId: board.id, boardName: board.name };
        setDefaultBoard(value);
        void savePinterestDefaultBoard(value).catch(() => {});
      }
    }
  }, [open, boardsStatus, boards, boardId, draft?.boardId, chooseBoardId, defaultBoard]);

  // Disconnecting Pinterest in Settings does not unmount this drawer when Settings is
  // opened as an overlay on top of it — nothing would otherwise tell this already-open
  // drawer its "Connected" state (board field, Publishing accounts) just went stale.
  // React live to the broadcast: drop the connected state immediately and re-run
  // loadBoards() so the board field/Publishing accounts reflect not-connected right
  // away instead of only after the drawer is closed and reopened.
  useEffect(() => {
    if (!open) return;
    function onDisconnected() {
      setPinterestConnected(false);
      setPinterestAccount(null);
      setBoards([]);
      setBoardId("");
      setDefaultBoard(null);
      setBoardsStatus("not_connected");
      void loadBoards();
    }
    window.addEventListener(PINTEREST_DISCONNECTED_EVENT, onDisconnected);
    return () => window.removeEventListener(PINTEREST_DISCONNECTED_EVENT, onDisconnected);
  }, [open, loadBoards]);

  // Reset the seed guard when the modal closes so reopening reseeds cleanly.
  useEffect(() => {
    if (!open) seededId.current = null;
  }, [open]);

  const requestClose = useCallback(() => {
    // Don't let a backdrop/Esc close interrupt an in-progress Pinterest redirect.
    if (isRedirectingToPinterest) return;
    // Auto-save means there is never unsaved data to discard — flush any pending
    // debounced save, then close.
    if (autoSaveRef.current) { clearTimeout(autoSaveRef.current); autoSaveRef.current = null; }
    if (dirty && !result) { persistDraftRef.current?.(); }
    onClose();
  }, [dirty, result, onClose, isRedirectingToPinterest]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (addLinkOpen) { setAddLinkOpen(false); return; }
      if (confirmDiscard) { setConfirmDiscard(false); return; }
      requestClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, addLinkOpen, confirmDiscard, requestClose]);

  if (!open || !draft) return null;
  const activeDraft = draft;

  // Auto-save: every field change schedules a debounced persist. There is no manual
  // save button — the small save-state indicator reflects Saving… / Saved / Failed.
  function markDirty() {
    setDirty(true);
    setSaveState("saving");
    if (autoSaveRef.current) clearTimeout(autoSaveRef.current);
    autoSaveRef.current = setTimeout(() => {
      const updated = persistDraft();
      setSaveState(updated ? "saved" : "failed");
    }, 600);
  }

  /** Flush any pending debounced auto-save immediately (used on close). */
  function flushSave() {
    if (autoSaveRef.current) { clearTimeout(autoSaveRef.current); autoSaveRef.current = null; }
    if (dirty) { const updated = persistDraft(); setSaveState(updated ? "saved" : "failed"); }
  }

  // Persist current modal fields to the draft store (single source of truth).
  function persistDraft(): PinDraft | null {
    const trimmedDate = plannedDate.trim();
    const selectedBoard = boards.find(b => b.id === boardId);
    const linkedProducts: LinkedProduct[] = canonicalDraft.linkedProducts;
    const primary = linkedProducts.find(p => p.productId === canonicalDraft.primaryProductId) ?? linkedProducts[0] ?? null;
    const tagged = primary ? linkedProducts.filter(p => p !== primary) : linkedProducts;
    const metadataWithProducts = activeDraft.metadataDraft
      ? writePinProducts(activeDraft.metadataDraft, primary, tagged)
      : activeDraft.metadataDraft;
    const metadataDraft = metadataWithProducts ? {
      ...metadataWithProducts,
      boardId: selectedBoard?.id,
      boardName: selectedBoard?.name,
      destinationUrl: destinationUrl.trim() || undefined,
      plannedDate: trimmedDate || undefined,
      updatedAt: new Date().toISOString(),
    } : metadataWithProducts;
    const patch: Parameters<typeof pinDraftStore.updateDraft>[1] = {
      title: title.trim(),
      description: description.trim(),
      altText: altText.trim(),
      destinationUrl: destinationUrl.trim(),
      scheduledDate: trimmedDate,
      scheduledTime: trimmedDate ? scheduledTime.trim() : "",
      linkedProducts,
      primaryProductId: primary?.productId ?? "",
      metadataDraft,
    };
    patch.boardId = selectedBoard?.id ?? "";
    patch.boardName = selectedBoard?.name ?? "";
    // Setting a date implies the pin is on the plan — keep the flags in sync so
    // it lands on the calendar and leaves the "not added" / "needs date" trays.
    if (trimmedDate && !sanitizeHandoffField(activeDraft.addedToPlanAt)) {
      patch.addedToPlanAt = new Date().toISOString();
    }
    // Editing the planned date/time here is a manual pin → skipped by rebalance.
    // Only when it actually changed (copy-only edits must not lock a smart Pin).
    const dateChanged = trimmedDate !== (activeDraft.scheduledDate ?? "");
    const timeChanged = (trimmedDate ? scheduledTime.trim() : "") !== (activeDraft.scheduledTime ?? "");
    if (trimmedDate && (dateChanged || timeChanged)) {
      patch.scheduleSource = "manual";
    }
    // The "Keep this time when rebalancing" toggle is the explicit lock control; a manual
    // date/time change also locks by default.
    if (trimmedDate) {
      patch.scheduleLocked = keepTimeLocked || dateChanged || timeChanged;
    }
    const updated = pinDraftStore.updateDraft(activeDraft.id, patch);
    if (updated) onSaved?.(updated);
    setDirty(false);
    return updated;
  }
  // Keep a live ref so the (pre-return) requestClose callback can flush a save.
  persistDraftRef.current = persistDraft;

  function attachProduct(p: AttachedProduct) {
    setProducts(prev => {
      if (prev.some(x => x.id === p.id || (x.productUrl && x.productUrl === p.productUrl))) return prev;
      return [...prev, p];
    });
    if (!primaryProductId) setPrimaryProductId(p.id);
    // PRD §10.1/§10.3.1: Product URL belongs to the Product, Website URL belongs to
    // the Pin Draft. Attaching a product must NEVER auto-fill the destination URL —
    // the user explicitly opts in via the "Use product link as destination" affordance.
    markDirty();
  }

  function removeProduct(id: string) {
    setProducts(prev => prev.filter(p => p.id !== id));
    if (primaryProductId === id) {
      setPrimaryProductId(products.find(p => p.id !== id)?.id ?? "");
    }
    markDirty();
  }

  function handleAddLink() {
    const url = lpUrl.trim();
    if (!url) { toast.error(t("pinDetails.toast.enterProductUrl")); return; }
    let domain = "";
    try { domain = new URL(url).hostname.replace(/^www\./, ""); } catch { /* keep empty */ }
    attachProduct({
      id: newProductId(),
      title: lpName.trim() || domain || "Product",
      productUrl: url,
      sourceDomain: domain || undefined,
    });
    setLpUrl(""); setLpName("");
    setAddLinkOpen(false);
    toast.success(t("pinDetails.toast.productAttached"));
  }

  // User clicked a "Publish now" affordance (footer / overflow / failed-retry). Publishing
  // is immediate and irreversible, so confirm first (the actual publish runs on confirm).
  // Silent guards mirror handlePublish's own: never open the dialog while a publish or an
  // OAuth redirect is already in flight.
  function requestPublish() {
    if (publishing || isRedirectingToPinterest) return;
    setConfirmPublishOpen(true);
  }

  async function handlePublish() {
    // Dev-only click trace — verifies the handler fires from a real browser click.
    if (process.env.NODE_ENV !== "production") {
      console.log("[publish-click]", {
        pinId: activeDraft.id,
        weeklyPlanItemId: activeDraft.weeklyPlanItemId,
        pinterestConnected: boardsStatus === "ready",
        boardsStatus,
        selectedBoardId: boardId || null,
        publishing,
      });
    }

    // Duplicate-click / in-flight-redirect protection — the ONLY silent return.
    if (publishing || isRedirectingToPinterest) return;

    // Auto-save current values, then clear prior feedback.
    persistDraft();
    setPublishError(null);
    setBoardError(false);
    setTrialAccess(false);
    setPublishAttempts((n) => n + 1);

    // "Publish now" publishes immediately — branching happens here.
    // Every branch below produces visible feedback (footer message / redirect / loading).

    // Disconnected → start Pinterest OAuth (paints "Opening Pinterest…", no Connect card).
    if (boardsStatus === "not_connected") {
      goToPinterestOAuth();
      return;
    }

    // Connection/boards still resolving → tell the user and re-fetch fresh.
    if (boardsStatus === "checking" || boardsStatus === "loading") {
      setPublishError(t("pinDetails.error.boardsLoading"));
      void loadBoards(boardId);
      return;
    }

    // Board load failed → readable retry message.
    if (boardsStatus === "error") {
      setPublishError(t("pinDetails.error.boardsLoadFailed"));
      return;
    }

    // Connected but no board chosen → inline validation + footer message + focus selector.
    if (!boardId) {
      setBoardError(true);
      setPublishError(t("pinDetails.board.chooseBoardToPublish"));
      toast.error(t("pinDetails.toast.completeRequired"));
      setTimeout(() => boardSelectRef.current?.focus(), 0);
      return;
    }

    // Block on missing required Pin details. Website URL / destination link is
    // OPTIONAL (recommended for product Pins) — never a blocker on its own; only an
    // ILLEGAL (non-http/https) value blocks (PRD §14.2/§14.3). Uses the same canonical
    // pinReadiness.isPublishableImage check Studio/Batch Edit use, so "publishable image"
    // means the same thing everywhere (public http(s) URL, not blob/data/localhost).
    if (!isPublishableImage(publicImage)) {
      const msg = "This Pin needs an image before it can be published.";
      setPublishError(msg);
      toast.error(msg);
      return;
    }
    if (!isValidDestinationUrl(destinationUrl)) {
      setUrlError(true);
      setPublishError(t("pinDetails.error.invalidUrl"));
      toast.error(t("pinDetails.error.invalidUrl"));
      return;
    }
    // Title ≤100 / description ≤500 — over-limit blocks (empty stays fine). Field-level
    // errors render next to the title/description inputs; the toast/footer are a summary.
    const lenErrors = pinFieldErrors({ title, description });
    if (lenErrors.title || lenErrors.description) {
      setFieldErrors(lenErrors);
      const msg = lenErrors.title || lenErrors.description!;
      setPublishError(msg);
      toast.error(msg);
      return;
    }

    // Module-level in-flight lock (shared with Studio's card/batch publish) — guards
    // against this same Pin being published concurrently from another surface. Same
    // silent early-return contract as the `publishing` guard above: no error UI.
    if (!beginPublish(activeDraft.id)) return;

    setPublishing(true);
    try {
      const publishT0 = process.env.NODE_ENV !== "production" ? performance.now() : 0;
      const res = await publishPin({
        boardId,
        imageUrl: publicImage,
        title: title.trim() || undefined,
        description: description.trim() || undefined,
        link: destinationUrl.trim() || undefined,
        altText: altText.trim() || undefined,
        sourcePinId: activeDraft.id,
        attachedProducts: products.length ? products : undefined,
        primaryProductUrl: primaryProduct?.productUrl,
        productAttachmentMode: products.length ? "vibepin_metadata_v1" : undefined,
      });
      if (process.env.NODE_ENV !== "production") {
        console.log("[publish-result]", {
          pinId: activeDraft.id,
          pinterestPinId: res.pin.id,
          boardId,
          environment: res.environment ?? "production",
          durationMs: Math.round(performance.now() - publishT0),
        });
      }
      const boardName = boards.find(b => b.id === boardId)?.name ?? res.board.name;
      // Mark the Pin posted and capture the live Pinterest Pin id + the board actually
      // published to — existing PinDraft fields (Studio's own publish path already writes
      // remotePinId the same way; see StudioBoard.tsx) so the drawer's published-state
      // summary (View on Pinterest, Board) is accurate immediately, not dependent on the
      // debounced board-selection autosave having already flushed. updateDraft (not
      // markDraftPosted) so all of this lands in one write; it still emits
      // DRAFT_STORE_EVENT, which the Weekly Plan listens to and refreshes from — so we do
      // NOT call onSaved here (some callers close the modal in onSaved, which would hide
      // the success state from the user).
      pinDraftStore.updateDraft(activeDraft.id, {
        postedAt: new Date().toISOString(),
        remotePinId: res.pin.id,
        remotePinUrl: res.pin.url,
        boardId,
        boardName,
        // Clear any prior publish-failure state so a Pin that previously failed and is
        // now published is fully clean (no stale "failed" lifecycle / retry framing).
        publishError: undefined,
        failureType: undefined,
        errorCategory: undefined,
        previousScheduledTime: undefined,
        publishErrorCode: undefined,
      });
      setResult({ pinUrl: res.pin.url, pinId: res.pin.id, boardName, environment: res.environment });
      toast.success(t("pinDetails.toast.publishSuccess"), {
        action: {
          label: t("pinDetails.viewPin"),
          onClick: () => window.open(res.pin.url, "_blank", "noopener,noreferrer"),
        },
      });

      // Fan out to any additional connected channels the merchant selected.
      // Dormant until non-Pinterest providers are connectable; guarded so it
      // runs at most once per publish.
      const extras = socialDestinations.filter(p => p !== "pinterest");
      if (extras.length && !socialFannedOutRef.current) {
        socialFannedOutRef.current = true;
        void publishToSocial({
          postId: activeDraft.id,
          post: {
            imageUrls: publicImage ? [publicImage] : [],
            title: title.trim() || undefined,
            caption: description.trim() || undefined,
            destinationUrl: destinationUrl.trim() || undefined,
            altText: altText.trim() || undefined,
          },
          destinations: extras.map(provider => ({ provider })),
        })
          .then(r => {
            const published = r.destinations.filter(d => d.status === "published");
            const failed = r.destinations.filter(d => d.status === "failed");
            if (published.length) {
              toast.success(`${t("pinDetails.toast.alsoPublishedPrefix")}${published.map(d => platformName(d.provider)).join(t("pinDetails.listSeparator"))}`);
            }
            if (failed.length) {
              toast.info(failed[0].error || `${t("pinDetails.toast.couldNotPublishPrefix")}${platformName(failed[0].provider)}${t("pinDetails.toast.couldNotPublishSuffix")}`);
            }
          })
          .catch(() => {/* non-blocking — Pinterest already succeeded */});
      }
    } catch (e) {
      const err = e as PinterestClientError;
      if (process.env.NODE_ENV !== "production") {
        console.warn("[publish-error]", {
          pinId: activeDraft.id,
          code: err.code ?? null,
          httpStatus: err.httpStatus ?? null,
          needsReconnect: err.needsReconnect === true,
          message: err.message,
        });
      }
      // Persist the failure so it survives a reload and is truthfully reflected as a
      // "failed" Pin — NOT still "Scheduled" (PRD WP-B §11.5). This is additive to the
      // local setPublishError feedback below (immediate) — the store write is durable.
      // We clear scheduledDate/scheduledTime (a failed publish no longer holds a slot)
      // but remember the time in previousScheduledTime so it can be offered back later.
      //
      // Exception: a trial/Standard-access block is NOT a real publish failure — the Pin
      // is publishable, just not until Pinterest grants access. The product promise is
      // "save this Pin and publish after access is approved", so we keep its schedule and
      // do NOT mark it failed (it stays Scheduled/Unscheduled). Only the notice is shown.
      if (err.code !== "pinterest_trial_access") {
        const errorCategory = mapPublishErrorToCategory(err.code, err.message);
        const previousScheduledTime = plannedDate.trim()
          ? new Date(`${plannedDate}T${(scheduledTime.trim() || "09:00")}:00`).toISOString()
          : undefined;
        pinDraftStore.updateDraft(activeDraft.id, {
          publishError: t("pinDetails.error.publishFailed"),
          failureType: "publish",
          errorCategory,
          publishErrorCode: err.code,
          previousScheduledTime,
          // A failed publish no longer occupies its scheduled slot (§11.5).
          scheduledDate: "",
          scheduledTime: "",
        });
      }

      if (needsPinterestConnect(err)) {
        goToPinterestOAuth();
      } else if (err.code === "pinterest_trial_access") {
        // Trial/Standard access block → clean, user-facing notice only (never raw API text).
        setTrialAccess(true);
      } else {
        // Any other failure → short, readable message. No raw API/debug details surfaced.
        // Modal stays open and edits are preserved (nothing is reset on failure).
        setPublishError(t("pinDetails.error.publishFailed"));
        toast.error(t("pinDetails.error.publishFailed"));
      }
    } finally {
      setPublishing(false);
      endPublish(activeDraft.id);
    }
  }

  const destMissing = !destinationUrl.trim();

  // ── Derived values ──────────────────────────────────────────────────────────
  const primaryUrl = (primaryProduct?.productUrl ?? "").trim();
  // The action is meaningful whenever a primary product URL exists and the destination
  // doesn't already match it (offer it even when a custom URL is present, but never
  // silently clobber — confirm before overwriting a different existing URL). URL must
  // itself be a legal http(s) address (PRD §10.3.6) — a malformed product URL is never
  // offered as a one-click destination.
  const canUsePrimaryUrl = !!primaryUrl && isValidDestinationUrl(primaryUrl) && destinationUrl.trim() !== primaryUrl;
  // PRD §10.2: empty destination → fill directly; existing value → confirm via the
  // in-app ConfirmDialog (never window.confirm, which breaks the product's visual language).
  const requestUsePrimaryUrl = () => {
    if (!primaryUrl) return;
    if (destinationUrl.trim() && destinationUrl.trim() !== primaryUrl) {
      setConfirmReplaceUrlOpen(true);
      return;
    }
    setDestinationUrl(primaryUrl);
    setUrlError(false);
    markDirty();
  };
  const confirmUsePrimaryUrl = () => {
    setConfirmReplaceUrlOpen(false);
    setDestinationUrl(primaryUrl);
    setUrlError(false);
    markDirty();
  };
  const isScheduled = !!plannedDate.trim();
  const canonicalDraft: PinDetailsDraft = {
    imageUrl: activeDraft.imageUrl,
    title,
    description,
    altText,
    destinationUrl,
    linkedProducts: products.map(p => ({
      productId: p.id,
      title: p.title,
      imageUrl: p.imageUrl,
      productUrl: p.productUrl,
      store: p.sourceDomain,
      price: p.price,
      source: "manual",
      linkType: "manual",
    })),
    primaryProductId,
    boardId,
    boardName: boards.find(b => b.id === boardId)?.name ?? "",
    boardSuggestion: activeDraft.metadataDraft?.boardSuggestion ?? "",
    plannedDate,
    plannedTime: scheduledTime,
    plannedAt: combinePlannedAt(plannedDate, scheduledTime),
    addedToPlanAt: activeDraft.addedToPlanAt ?? "",
    planStatus: activeDraft.postedAt ? "posted" : plannedDate ? "scheduled" : activeDraft.addedToPlanAt ? "needs_date" : "not_planned",
    detailsStatus: "need_details",
  };
  const readiness = getPinReadiness({
    imageUrl: activeDraft.imageUrl,
    title,
    description,
    altText,
    destinationUrl,
    boardId,
    addedToPlanAt: activeDraft.addedToPlanAt,
    scheduledDate: plannedDate,
    postedAt: activeDraft.postedAt,
  });
  canonicalDraft.detailsStatus = readiness.detailsStatus;

  // ── Pin state → which action rows to show ──────────────────────────────────────
  const isPosted = !!activeDraft.postedAt;
  const isFailed = !isPosted && /fail/i.test(activeDraft.generationStatus ?? "");
  // Live Pinterest Pin URL — prefers the real URL Pinterest returned at publish time
  // (remotePinUrl); the `https://www.pinterest.com/pin/<id>/` reconstruction is a
  // fallback ONLY for legacy drafts published before remotePinUrl existed. Same
  // preference order as Studio's board card (PinBoardCard.tsx).
  const publishedPinUrl = activeDraft.remotePinUrl || (activeDraft.remotePinId ? `https://www.pinterest.com/pin/${activeDraft.remotePinId}/` : "");

  function openScheduleEditor() {
    if (!isScheduled) {
      setPlannedDate(plannableDateISO(1));
      if (!scheduledTime.trim()) setScheduledTime("09:00");
    }
    setScheduleEditorOpen(true);
    markDirty();
  }
  function doUnschedule() {
    setPlannedDate("");
    setScheduledTime("");
    setScheduleEditorOpen(false);
    markDirty();
  }

  // ── styles ──────────────────────────────────────────────────────────────────
  // Bigger, clearer inputs that read as editable (not passive preview cards).
  const field: React.CSSProperties = {
    width: "100%", boxSizing: "border-box", padding: "11px 13px", borderRadius: 10,
    border: `1px solid ${UI.fieldBorder}`, fontSize: 13.5, color: UI.text, background: UI.surface3,
    outline: "none", lineHeight: 1.5,
  };
  const lbl: React.CSSProperties = { fontSize: 12.5, fontWeight: 800, color: UI.text };
  // Compact, low-pressure quick-edit card: tighter field rhythm, no numbered sections.
  const fieldBlock: React.CSSProperties = { marginBottom: 2 };
  // Light Tailwind-style action buttons (top action row).
  const lightBtn: React.CSSProperties = {
    display: "inline-flex", alignItems: "center", gap: 5, padding: "6px 12px", borderRadius: 8,
    border: `1px solid ${UI.fieldBorder}`, background: UI.surface3, color: UI.text,
    fontSize: 12, fontWeight: 700, cursor: "pointer", textDecoration: "none", whiteSpace: "nowrap",
  };
  const ghostBtn: React.CSSProperties = {
    padding: "9px 14px", borderRadius: 9, border: `1px solid ${UI.border}`, background: "transparent",
    color: UI.textSec, fontSize: 12.5, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap",
  };
  const primaryBtn: React.CSSProperties = {
    display: "inline-flex", alignItems: "center", gap: 6, padding: "9px 16px", borderRadius: 9, border: "none",
    background: "#7C3AED", color: "#fff", fontSize: 12.5, fontWeight: 800, cursor: "pointer", whiteSpace: "nowrap",
  };
  // Small, non-clickable auto-save indicator: Saving… / Saved / Failed to save.
  const saveIndicator = (
    <span data-testid="draft-save-state" style={{ fontSize: 10.5, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 4,
      color: saveState === "failed" ? UI.error : saveState === "saving" ? UI.textMuted : UI.success }}>
      {saveState === "saving" ? <><Loader2 size={11} className="animate-spin" /> {t("pinDetails.savingState")}</>
        : saveState === "failed" ? <><AlertCircle size={11} /> {t("pinDetails.failedToSave")}</>
        : saveState === "saved" ? <><CheckCircle2 size={11} /> {t("pinDetails.saved")}</>
        : null}
    </span>
  );

  // One planning CTA needs a board + a date + a time. Otherwise it's disabled with
  // clear helper text. PRD §14.2 hard-blocks Schedule on: missing/non-public image,
  // missing board, and an illegal (non-http/https) Website URL — same canonical checks
  // used by the Publish gate (pinReadiness), so Schedule and Publish never disagree on
  // what's required. Title/Description are length-capped inline (maxLength on the
  // fields) and — as of WP1's follow-up — an over-cap VALUE (e.g. from AI-generated copy,
  // which bypasses the DOM maxLength) also hard-blocks; empty stays fine (never required).
  const hasBoard = !!boardId;
  const hasWhen = !!plannedDate.trim() && !!scheduledTime.trim();
  const hasValidImage = isPublishableImage(publicImage);
  const hasValidUrl = isValidDestinationUrl(destinationUrl);
  const lenErrors = pinFieldErrors({ title, description });
  const hasValidFieldLengths = !lenErrors.title && !lenErrors.description;
  const canSchedule = hasBoard && hasWhen && hasValidImage && hasValidUrl && hasValidFieldLengths && boardsStatus !== "checking";
  const scheduleHelper = boardsStatus === "not_connected"
    ? t("pinDetails.helper.connectPinterest")
    : !hasValidImage ? "This Pin needs an image before it can be scheduled."
    : !hasValidUrl ? t("pinDetails.error.invalidUrl")
    : !hasValidFieldLengths ? (lenErrors.title || lenErrors.description!)
    : !hasBoard && !hasWhen ? t("pinDetails.helper.chooseBoardAndTime")
    : !hasBoard ? t("pinDetails.helper.chooseBoard")
    : !hasWhen ? t("pinDetails.helper.pickTime")
    : "";

  // Primary CTA: set a date/time (if missing) then persist → scheduled. Re-validates the
  // hard gate here too (not just via the disabled attribute) so a stale/edge-case click
  // (e.g. keyboard Enter) can't slip through with a field-level error left unshown.
  function handleSchedulePrimary() {
    if (!hasValidImage) {
      setPublishError("This Pin needs an image before it can be scheduled.");
      return;
    }
    if (!hasValidUrl) {
      setUrlError(true);
      setPublishError(t("pinDetails.error.invalidUrl"));
      toast.error(t("pinDetails.error.invalidUrl"));
      return;
    }
    if (!hasValidFieldLengths) {
      setFieldErrors(lenErrors);
      const msg = lenErrors.title || lenErrors.description!;
      setPublishError(msg);
      toast.error(msg);
      return;
    }
    if (!hasBoard) {
      setBoardError(true);
      setTimeout(() => boardSelectRef.current?.focus(), 0);
      return;
    }
    if (!plannedDate.trim()) setPlannedDate(plannableDateISO(1));
    if (!scheduledTime.trim()) setScheduledTime("09:00");
    setScheduleEditorOpen(true);
    flushSave();
    const updated = persistDraft();
    setSaveState(updated ? "saved" : "failed");
    if (updated) toast.success(isScheduled ? t("pinDetails.toast.scheduleUpdated") : t("pinDetails.toast.pinScheduled"));
  }

  return (
    <>
      <div data-testid="draft-details-backdrop" onClick={requestClose}
        style={{ position: "fixed", inset: 0, zIndex: 80, background: "rgba(0,0,0,0.6)" }} />
      <div
        data-testid="draft-details-drawer"
        role="dialog"
        aria-label={isPosted ? t("pinDetails.publishedTitle") : t("pinDetails.editTitle")}
        style={{
          position: "fixed", left: "50%", top: "50%", transform: "translate(-50%,-50%)", zIndex: 81,
          width: 480, maxWidth: "calc(100vw - 32px)", maxHeight: "calc(100vh - 32px)", overflow: "hidden",
          background: UI.card, border: `1px solid ${UI.border}`, borderRadius: 16,
          boxShadow: "0 24px 70px rgba(0,0,0,0.5)", display: "flex", flexDirection: "column",
        }}
      >
        {/* Title row — quiet, no subtitle/banner. Overflow holds secondary actions
            (Publish now / Unschedule) so the footer keeps a single primary CTA. */}
        <header style={{ padding: "12px 16px", borderBottom: `1px solid ${UI.border}`, display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 800, color: UI.text }}>{isPosted ? t("pinDetails.publishedTitle") : isScheduled ? t("pinDetails.editScheduledTitle") : t("pinDetails.editTitle")}</h2>
          <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
            {!isPosted && (
              <div style={{ position: "relative" }}>
                <button type="button" data-testid="draft-overflow-btn" onClick={() => setOverflowOpen(o => !o)} aria-label={t("pinDetails.moreActions")}
                  style={{ background: "none", border: "none", cursor: "pointer", color: UI.textSec, padding: 2, display: "flex" }}>
                  <MoreVertical size={18} />
                </button>
                {overflowOpen && (
                  <>
                    <div onClick={() => setOverflowOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 90 }} />
                    <div data-testid="draft-overflow-menu" style={{ position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 91, minWidth: 168, background: UI.card, border: `1px solid ${UI.border}`, borderRadius: 10, boxShadow: "0 12px 32px rgba(0,0,0,0.5)", overflow: "hidden" }}>
                      <button type="button" data-testid="draft-overflow-pin-now" disabled={publishing || isRedirectingToPinterest}
                        onClick={() => { setOverflowOpen(false); requestPublish(); }}
                        style={{ display: "block", width: "100%", textAlign: "left", padding: "9px 12px", border: "none", background: "none", color: UI.text, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                        {publishing ? t("pinDetails.publishing") : t("pinDetails.publishNow")}
                      </button>
                      {isScheduled && (
                        <button type="button" data-testid="draft-overflow-unschedule" onClick={() => { setOverflowOpen(false); doUnschedule(); }}
                          style={{ display: "block", width: "100%", textAlign: "left", padding: "9px 12px", border: "none", borderTop: `1px solid ${UI.border}`, background: "none", color: UI.text, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                          {t("pinDetails.overflow.unschedule")}
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
            <button type="button" data-testid="draft-details-close" onClick={requestClose} aria-label={t("pinDetails.close")}
              style={{ background: "none", border: "none", cursor: "pointer", color: UI.textSec, padding: 2, display: "flex" }}>
              <X size={18} />
            </button>
          </div>
        </header>

        {/* Single-column compact card body */}
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "14px 16px 16px", display: "flex", flexDirection: "column", gap: 12 }}>

          {/* Thumbnail + schedule summary + top action row */}
          <div style={{ display: "flex", gap: 12 }}>
            <div data-testid="draft-preview" style={{ width: 72, height: 96, borderRadius: 10, overflow: "hidden", border: `1px solid ${UI.border}`, background: UI.surface3, flexShrink: 0 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={publicImage} alt={altText || title || t("pinDetails.pinPreviewAlt")} style={{ display: "block", width: "100%", height: "100%", objectFit: "cover" }} />
            </div>
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }}>
              <div data-testid="draft-planned-summary">
                {isPosted ? (
                  <div data-testid="draft-published-summary" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <p style={{ margin: 0, fontSize: 13, fontWeight: 800, color: UI.success, display: "flex", alignItems: "center", gap: 5 }}>
                      <CheckCircle2 size={14} /> {t("pinDetails.published")}
                    </p>
                    <p style={{ margin: 0, fontSize: 11.5, color: UI.textSec }}>
                      {platformName("pinterest")}
                      {activeDraft.postedAt && formatEnglishDateTime(activeDraft.postedAt) && ` · ${formatEnglishDateTime(activeDraft.postedAt)}`}
                    </p>
                    {activeDraft.boardName?.trim() && (
                      <p data-testid="draft-published-board" style={{ margin: 0, fontSize: 11, color: UI.textMuted }}>
                        {t("pinDetails.boardLabel")} {activeDraft.boardName}
                      </p>
                    )}
                    {pinterestAccount?.username && (
                      <p data-testid="draft-published-account" style={{ margin: 0, fontSize: 11, color: UI.textMuted }}>
                        {t("pinDetails.accountLabel")} @{pinterestAccount.username}
                      </p>
                    )}
                    <p style={{ margin: "2px 0 0", fontSize: 10.5, color: UI.textMuted }}>{t("pinDetails.publishedSuccess")}</p>
                  </div>
                ) : isScheduled ? (
                  <>
                    <p style={{ margin: 0, fontSize: 13, fontWeight: 800, color: UI.text }}>{formatSchedDate(plannedDate)}</p>
                    <p style={{ margin: "2px 0 0", fontSize: 12, color: UI.textSec }}>{scheduledTime.trim() ? `${fmt12h(scheduledTime)} ${gmtLabel()}` : t("pinDetails.timeNotSet")}</p>
                  </>
                ) : (
                  <p data-testid="draft-not-scheduled" style={{ margin: 0, fontSize: 13, fontWeight: 700, color: UI.textMuted }}>{t("pinDetails.notScheduled")}</p>
                )}
              </div>
              {/* Quiet secondary affordance only — the single primary action lives in
                  the footer; Publish now lives in the overflow menu. */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {!isPosted && !isFailed && (
                  <button type="button" data-testid={isScheduled ? "draft-action-reschedule" : "draft-action-schedule"} onClick={openScheduleEditor} style={lightBtn}>
                    {isScheduled ? t("pinDetails.editDateTime") : t("pinDetails.addDateTime")}
                  </button>
                )}
                {/* Only rendered when a real published Pin URL exists — no URL means no
                    button and no broken link, never an error. Primary-styled: it is
                    the ONE action of the read-only published view (footer is hidden). */}
                {isPosted && publishedPinUrl && (
                  <a data-testid="draft-view-on-pinterest" href={publishedPinUrl} target="_blank" rel="noopener noreferrer" style={{ ...primaryBtn, textDecoration: "none" }}>
                    {t("pinDetails.viewOnPinterest")} <ExternalLink size={12} />
                  </a>
                )}
                {isPosted && !publishedPinUrl && (
                  <span data-testid="draft-pin-url-unavailable" style={{ fontSize: 11, color: UI.textMuted }}>
                    {t("pinDetails.publishedUrlUnavailable")}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Inline schedule editor — revealed by Schedule / Reschedule. */}
          {scheduleEditorOpen && !isPosted && (
            <div data-testid="draft-schedule-editor" style={{ padding: 11, borderRadius: 10, border: `1px solid ${UI.border}`, background: UI.surface2 }}>
              <PinPlannedDateTimeSection
                plannedDate={plannedDate}
                plannedTime={scheduledTime}
                onToggle={() => { if (isScheduled) { doUnschedule(); } else { setPlannedDate(plannableDateISO(1)); markDirty(); } }}
                onDateChange={(date) => { setPlannedDate(date); markDirty(); }}
                onTimeChange={(time) => { setScheduledTime(time); markDirty(); }}
              />
              {isScheduled && (
                <label data-testid="pin-details-lock-toggle" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, fontSize: 12, color: UI.textSec, cursor: "pointer" }}>
                  <input type="checkbox" checked={keepTimeLocked}
                    onChange={e => { setKeepTimeLocked(e.target.checked); markDirty(); }}
                    style={{ width: 15, height: 15, accentColor: "#7C3AED", cursor: "pointer" }} />
                  {t("pinDetails.keepTimeLocked")}
                </label>
              )}
            </div>
          )}

          {/* Published: read-only content preview — plain text only, never inputs,
              so an already-published Pin can't look editable. */}
          {isPosted && (
            <div data-testid="draft-published-readonly" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {title.trim() && (
                <div>
                  <div style={{ marginBottom: 4 }}><span style={lbl}>{t("pinDetails.title.label")}</span></div>
                  <p style={{ margin: 0, fontSize: 13, color: UI.textSec, lineHeight: 1.5, overflowWrap: "anywhere" }}>{title}</p>
                </div>
              )}
              {description.trim() && (
                <div>
                  <div style={{ marginBottom: 4 }}><span style={lbl}>{t("pinDetails.description")}</span></div>
                  <p style={{ margin: 0, fontSize: 13, color: UI.textSec, lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{description}</p>
                </div>
              )}
              {destinationUrl.trim() && (
                <div>
                  <div style={{ marginBottom: 4 }}><span style={lbl}>{t("pinDetails.websiteUrl")}</span></div>
                  <p style={{ margin: 0, fontSize: 13, color: UI.textSec, lineHeight: 1.5, overflowWrap: "anywhere" }}>{destinationUrl}</p>
                </div>
              )}
            </div>
          )}

          {/* Editable form — everything below is hidden once the Pin is published
              (AI copy, title/description/URL inputs, boards, products, alt text). */}
          {!isPosted && (<>
          {/* AI Copy — shared panel (same component as Create Pins & Batch Edit).
              Applies title/description/alt text to this draft only on explicit Generate;
              manual edits are otherwise preserved. */}
          <div style={fieldBlock}>
            <PinAICopyPanel
              draftId={draft.id} imageUrl={draft.imageUrl}
              title={title} description={description} altText={altText}
              boardId={boardId || draft.boardId} boardName={draft.boardName}
              category={draft.category} keyword={draft.keyword} destinationUrl={destinationUrl}
              imageSummary={draft.imageSummary} recommendedKeywords={draft.recommendedKeywords}
              boards={boards}
              analysisStatus={draft.imageAnalysisStatus} keywordStatus={draft.keywordStatus}
              hasGeneratedBefore={!!draft.metadataDraft?.copyGenerationMeta}
              onApplyCopy={(r) => {
                // Same fill-in-the-blank rule as Studio's PinBoardCard.applyCopy (WP-D):
                // title/description overwrite only when the user explicitly confirmed a
                // full replace OR the field was empty before this run; alt text only ever
                // fills when empty. Keeps Plan drawer and Studio card AI Copy behavior
                // consistent — never a silent, unconditional overwrite of manual edits.
                setTitle(prev => (r.confirmedReplace || !prev.trim() ? r.title : prev));
                setDescription(prev => (r.confirmedReplace || !prev.trim() ? r.description : prev));
                setAltText(prev => (prev.trim() ? prev : r.altText));
                markDirty();
              }}
            />
          </div>

          {/* Title */}
          <div style={fieldBlock}>
            <PinTitleSection value={title}
              onChange={(v) => { setTitle(v); if (fieldErrors.title) setFieldErrors(prev => ({ ...prev, title: undefined })); markDirty(); }}
              error={fieldErrors.title} />
          </div>

          {/* Description */}
          <div style={fieldBlock}>
            <div style={{ marginBottom: 6 }}><span style={lbl}>{t("pinDetails.description")}</span></div>
            <textarea data-testid="draft-edit-description" value={description} maxLength={500}
              onChange={e => { setDescription(e.target.value); if (fieldErrors.description) setFieldErrors(prev => ({ ...prev, description: undefined })); markDirty(); }}
              style={{ ...field, minHeight: 120, resize: "vertical", ...(fieldErrors.description ? { border: `1px solid ${UI.error}` } : {}) }} placeholder={t("pinDetails.descriptionPlaceholder")} />
            <div style={{ textAlign: "right", fontSize: 10, color: UI.textMuted, marginTop: 3 }}>{description.length}/500</div>
            {fieldErrors.description && (
              <p data-testid="draft-edit-description-error" style={{ margin: "2px 0 0", fontSize: 10.5, fontWeight: 700, color: UI.error }}>
                {fieldErrors.description}
              </p>
            )}
          </div>

          {/* Website URL */}
          <div style={fieldBlock}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
              <span style={lbl}>{t("pinDetails.websiteUrl")}</span>
              {destMissing ? (
                // Optional field — neutral, non-error styling (never blocks publishing).
                <span data-testid="draft-dest-source" style={{ fontSize: 10, fontWeight: 700, color: UI.textMuted, border: `1px solid ${UI.border}`, borderRadius: 20, padding: "1px 8px" }}>{t("pinDetails.optional")}</span>
              ) : (
                <span data-testid="draft-dest-source" style={{ fontSize: 10, fontWeight: 700, color: destinationUrl.trim() === primaryUrl ? UI.success : UI.textMuted, border: `1px solid ${UI.border}`, borderRadius: 20, padding: "1px 8px" }}>
                  {destinationUrl.trim() === primaryUrl ? t("pinDetails.fromPrimaryProduct") : t("pinDetails.customUrl")}
                </span>
              )}
            </div>
            <input data-testid="draft-edit-destination-url" value={destinationUrl} placeholder={t("pinDetails.urlPlaceholder")}
              onChange={e => {
                setDestinationUrl(e.target.value);
                if (urlError) setUrlError(false);
                markDirty();
              }}
              onBlur={() => setUrlError(!isValidDestinationUrl(destinationUrl))}
              style={{ ...field, ...(urlError ? { border: `1px solid ${UI.error}` } : {}) }} />
            {/* Field-level format error (PRD §14.2/§14.3) — never just a toast. */}
            {urlError && (
              <p data-testid="draft-dest-url-error" style={{ display: "flex", alignItems: "center", gap: 4, margin: "5px 0 0", fontSize: 10.5, fontWeight: 700, color: UI.error }}>
                <AlertCircle size={11} /> {t("pinDetails.error.invalidUrl")}
              </p>
            )}
            {(() => {
              // Small, neutral status only — the full link + product identifiers live
              // in the Product section, not the main form.
              const ctx = draft ? getPinDisplayContext({ ...draft, destinationUrl }) : null;
              if (!ctx?.affiliateUrl) return null;
              const usingAffiliate = destinationUrl.trim() === ctx.affiliateUrl;
              return (
                <span data-testid="draft-affiliate-url" style={{ display: "inline-flex", alignItems: "center", gap: 4, margin: "5px 0 0", fontSize: 10, fontWeight: 700, color: usingAffiliate ? UI.success : UI.textMuted, background: usingAffiliate ? "rgba(16,185,129,0.10)" : "transparent", border: `1px solid ${usingAffiliate ? "rgba(16,185,129,0.30)" : UI.border}`, borderRadius: 999, padding: "1px 8px" }}>
                  {usingAffiliate ? t("pinDetails.usingAffiliate") : t("pinDetails.affiliateReady")}
                </span>
              );
            })()}
            {/* PRD §10.2: "Product link available" banner — explicit opt-in only, never
                an auto-fill. Shown whenever the linked product has a distinct, valid URL. */}
            {canUsePrimaryUrl && (
              <div data-testid="draft-product-link-banner" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 8, padding: "8px 10px", borderRadius: 9, border: `1px solid ${UI.border}`, background: UI.surface3 }}>
                <span style={{ fontSize: 11, color: UI.textSec }}>{t("pinDetails.productLinkAvailable")}</span>
                <button type="button" data-testid="draft-use-primary-url" onClick={requestUsePrimaryUrl}
                  style={{ background: "none", border: "none", padding: 0, fontSize: 11, fontWeight: 700, color: UI.purple, cursor: "pointer", whiteSpace: "nowrap" }}>
                  {t("pinDetails.useProductLinkAsDestination")}
                </button>
              </div>
            )}
            {/* A product is linked but has no URL yet → friendly, non-blocking note. */}
            {!!primaryProduct && !primaryUrl && (
              <p data-testid="draft-no-product-url" style={{ margin: "5px 0 0", fontSize: 10.5, color: UI.textMuted }}>
                {t("pinDetails.noProductUrl")}
              </p>
            )}
            {/* Optional-field guidance when no URL is set and none to inherit. */}
            {destMissing && !canUsePrimaryUrl && !primaryProduct && (
              <p data-testid="draft-dest-optional-help" style={{ margin: "5px 0 0", fontSize: 10.5, color: UI.textMuted }}>
                {t("pinDetails.destOptionalHelp")}
              </p>
            )}
          </div>

          {/* Boards */}
          <div style={fieldBlock}>
            <div style={{ marginBottom: 6 }}><span style={lbl}>{t("pinDetails.boards")}</span></div>
            <PinBoardSection
              boardId={boardId}
              boards={boards}
              boardsStatus={boardsStatus}
              boardError={boardError}
              disabled={publishing}
              selectRef={boardSelectRef}
              onChange={(id) => {
                setBoardId(id);
                const board = boards.find(b => b.id === id);
                if (board) {
                  const value = { boardId: board.id, boardName: board.name };
                  setDefaultBoard(value);
                  void savePinterestDefaultBoard(value).catch(() => {});
                }
                markDirty();
              }}
              onClearBoardError={() => setBoardError(false)}
              onRetryLoad={() => void loadBoards(boardId)}
              onNeedsConnect={goToPinterestOAuth}
              sandboxMode={sandboxMode}
              creatingDemoBoard={creatingBoard}
              onCreateDemoBoard={handleCreateDemoBoard}
            />
          </div>

          {/* Product (optional) — single lightweight row */}
          <div style={fieldBlock} data-testid="draft-products-section">
            <PinProductLinksSection
              products={products}
              primaryProductId={primaryProductId}
              addLinkOpen={addLinkOpen}
              lpUrl={lpUrl}
              lpName={lpName}
              onSetPrimary={(id) => { setPrimaryProductId(id); markDirty(); }}
              onRemove={removeProduct}
              onToggleAddLink={setAddLinkOpen}
              onLpUrlChange={setLpUrl}
              onLpNameChange={setLpName}
              onAddLink={handleAddLink}
              pin={draft ? { ...draft, destinationUrl } : undefined}
            />
          </div>

          {/* Alt text (optional) */}
          <div style={{ ...fieldBlock, marginBottom: 0 }}>
            <PinAltTextSection value={altText} onChange={(v) => { setAltText(v); markDirty(); }} />
          </div>
          </>)}

          {/* Publish destinations — choose which connected channels to repurpose to.
              Pinterest is published by the flow below; extra channels fan out on success. */}
          {!isPosted && !result && (
            <div style={{ ...fieldBlock, marginBottom: 0, marginTop: 14 }}>
              <PublishDestinations
                selected={socialDestinations}
                onSelectedChange={setSocialDestinations}
                onConnectPinterest={goToPinterestOAuth}
                connectingPinterest={isRedirectingToPinterest}
                pinterestConnected={pinterestConnected}
                pinterestAccountName={pinterestAccount?.username ?? null}
              />
            </div>
          )}

          {/* Subtle publish notices */}
          {trialAccess && (
            <div data-testid="draft-trial-access" style={{ display: "flex", gap: 9, padding: "10px 12px", borderRadius: 10, background: "rgba(96,165,250,0.10)", border: "1px solid rgba(96,165,250,0.30)" }}>
              <Info size={15} style={{ color: UI.info, flexShrink: 0, marginTop: 1 }} />
              <div>
                <p style={{ margin: "0 0 3px", fontSize: 12, fontWeight: 800, color: UI.text }}>{t("pinDetails.trialAccessTitle")}</p>
                <p style={{ margin: 0, fontSize: 11, color: UI.textSec, lineHeight: 1.5 }}>{t("pinDetails.trialAccessMsg")}</p>
              </div>
            </div>
          )}
          {result && (
            <div data-testid="draft-publish-success" style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 12px", borderRadius: 10, background: "rgba(16,185,129,0.08)", border: "1px solid rgba(16,185,129,0.30)" }}>
              <CheckCircle2 size={16} style={{ color: UI.success, flexShrink: 0, marginTop: 1 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <p style={{ margin: 0, fontSize: 12, fontWeight: 800, color: UI.text }}>{t("pinDetails.publishedSuccess")}</p>
                  {result.environment === "sandbox" && (
                    <span data-testid="draft-publish-env" style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: 0.3, color: UI.info, background: "rgba(96,165,250,0.12)", border: "1px solid rgba(96,165,250,0.35)", borderRadius: 999, padding: "1px 7px", textTransform: "uppercase" }}>
                      {t("pinDetails.sandboxMode")}
                    </span>
                  )}
                </div>
                <p style={{ margin: "2px 0 0", fontSize: 10.5, color: UI.textSec, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {t("pinDetails.environment")} {result.environment === "sandbox" ? t("pinDetails.envSandbox") : t("pinDetails.envProduction")}
                </p>
                <p data-testid="draft-publish-pin-id" style={{ margin: "1px 0 0", fontSize: 10.5, color: UI.textSec, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t("pinDetails.pinIdLabel")} {result.pinId}</p>
                <p style={{ margin: "1px 0 0", fontSize: 10.5, color: UI.textSec, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t("pinDetails.boardLabel")} {result.boardName}</p>
              </div>
              <a data-testid="draft-view-link" href={result.pinUrl} target="_blank" rel="noopener noreferrer"
                style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 700, color: UI.text, textDecoration: "none", flexShrink: 0, whiteSpace: "nowrap" }}>
                {t("pinDetails.viewOnPinterest")} <ExternalLink size={12} />
              </a>
            </div>
          )}
        </div>

        {/* ── State-based footer (compact; Publish is never the only action).
            Hidden entirely for a published Pin: the read-only view's single action
            is "View on Pinterest" in the summary, and the header X closes. ── */}
        {!isPosted && (
        <div style={{ flexShrink: 0, borderTop: `1px solid ${UI.border}`, padding: "10px 16px", background: UI.card }}>
          {publishError && !result && !trialAccess && (
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8, margin: "0 0 8px" }}>
              <p data-testid="draft-publish-error" style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 11.5, color: UI.error, margin: 0 }}>
                <AlertCircle size={13} style={{ marginTop: 1, flexShrink: 0 }} /> {publishError}
              </p>
            </div>
          )}
          {/* Single primary CTA + a small non-clickable auto-save indicator.
              No manual-save / add-to-plan / cancel buttons. */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {saveIndicator}
            {!canSchedule && !isPosted && scheduleHelper && (
              <span data-testid="draft-cta-helper" style={{ fontSize: 10.5, color: UI.textMuted }}>{scheduleHelper}</span>
            )}
            <div style={{ flex: 1 }} />
            {result?.pinUrl ? (
                <a data-testid="draft-cta-view-pin" href={result.pinUrl} target="_blank" rel="noopener noreferrer" style={{ ...primaryBtn, textDecoration: "none" }}>
                  <ExternalLink size={13} /> {t("pinDetails.viewPin")}
                </a>
            ) : isFailed ? (
              <>
                <button type="button" data-testid="draft-cta-try-again" onClick={requestPublish} disabled={publishing || isRedirectingToPinterest}
                  style={{ ...primaryBtn, opacity: (publishing || isRedirectingToPinterest) ? 0.6 : 1 }}>
                  {publishing ? <><Loader2 size={13} className="animate-spin" /> {t("pinDetails.publishing")}</> : t("pinDetails.tryAgain")}
                </button>
              </>
            ) : (
              <>
                {/* Secondary: publish immediately (does NOT change the schedule time).
                    Enabled without a date/time — publishing needs no schedule. Disabled
                    only while a publish/redirect is in flight. */}
                <button type="button" data-testid="draft-cta-publish-now"
                  onClick={requestPublish} disabled={publishing || isRedirectingToPinterest}
                  style={{ ...ghostBtn, opacity: (publishing || isRedirectingToPinterest) ? 0.6 : 1, cursor: (publishing || isRedirectingToPinterest) ? "not-allowed" : "pointer" }}>
                  {publishing ? <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><Loader2 size={13} className="animate-spin" /> {t("pinDetails.publishing")}</span> : t("pinDetails.publishNow")}
                </button>
                {/* Primary: save the schedule (date/time). */}
                <button type="button" data-testid="draft-cta-schedule" onClick={handleSchedulePrimary} disabled={!canSchedule || publishing}
                  style={{ ...primaryBtn, opacity: (canSchedule && !publishing) ? 1 : 0.5, cursor: (canSchedule && !publishing) ? "pointer" : "not-allowed" }}>
                  {isScheduled ? t("pinDetails.updateSchedule") : t("pinDetails.schedule")}
                </button>
              </>
            )}
          </div>
        </div>
        )}

        {/* Discard-unsaved-changes confirmation */}
        {confirmDiscard && (
          <div data-testid="draft-discard-confirm" style={{ position: "absolute", inset: 0, zIndex: 5, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
            <div style={{ width: "min(360px, 92%)", background: UI.card, border: `1px solid ${UI.border}`, borderRadius: 14, padding: 18, boxShadow: "0 24px 70px rgba(0,0,0,0.5)" }}>
              <p style={{ margin: "0 0 4px", fontSize: 14, fontWeight: 800, color: UI.text }}>{t("pinDetails.discardTitle")}</p>
              <p style={{ margin: "0 0 14px", fontSize: 11.5, color: UI.textSec, lineHeight: 1.5 }}>{t("pinDetails.discardBody")}</p>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button type="button" data-testid="draft-discard-keep" onClick={() => setConfirmDiscard(false)}
                  style={{ padding: "8px 14px", borderRadius: 8, border: `1px solid ${UI.border}`, background: "transparent", color: UI.text, fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}>
                  {t("pinDetails.keepEditing")}
                </button>
                <button type="button" data-testid="draft-discard-confirm-btn" onClick={() => { setConfirmDiscard(false); onClose(); }}
                  style={{ padding: "8px 14px", borderRadius: 8, border: "none", background: UI.error, color: "#fff", fontSize: 11.5, fontWeight: 800, cursor: "pointer" }}>
                  {t("pinDetails.discard")}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Confirm before an immediate publish (shared with Plan list / hover, which
            funnel here rather than publishing on their own). The second sentence about the
            scheduled time only shows when the Pin actually holds one. */}
        <ConfirmPublishDialog
          open={confirmPublishOpen}
          hasSchedule={isScheduled}
          busy={publishing || isRedirectingToPinterest}
          onCancel={() => setConfirmPublishOpen(false)}
          onConfirm={() => { setConfirmPublishOpen(false); void handlePublish(); }}
          ui={{ card: UI.card, border: UI.border, text: UI.text, textSec: UI.textSec }}
        />

        {/* "Use product link as destination" replace-confirm (PRD §10.2) — replaces
            window.confirm with an in-app modal matching the product's visual language. */}
        <ConfirmDialog
          open={confirmReplaceUrlOpen}
          testId="draft-confirm-replace-url"
          title={t("pinDetails.confirmReplaceUrlTitle")}
          body={t("pinDetails.confirmReplaceUrlBody")}
          cancelLabel={t("pinDetails.confirmReplaceUrlKeep")}
          confirmLabel={t("pinDetails.confirmReplaceUrlUse")}
          onCancel={() => setConfirmReplaceUrlOpen(false)}
          onConfirm={confirmUsePrimaryUrl}
          ui={{ card: UI.card, border: UI.border, text: UI.text, textSec: UI.textSec }}
        />

        {/* Pinterest redirect feedback — non-blocking status only. No button click is
            ever required to "continue" the OAuth redirect: the loading state persists
            for as long as the real navigation takes (Pinterest's own authorize page can
            take several seconds), and `redirectFailed` appears ONLY when assign() threw
            synchronously — never from a guessed timeout. */}
        {isRedirectingToPinterest && (
          <div data-testid="draft-redirect-overlay" style={{ position: "absolute", inset: 0, zIndex: 7, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
            <div style={{ width: "min(380px, 92%)", background: UI.card, border: `1px solid ${UI.border}`, borderRadius: 14, padding: 22, textAlign: "center", boxShadow: "0 24px 70px rgba(0,0,0,0.5)" }}>
              <Loader2 size={26} className="animate-spin" style={{ color: UI.purple, marginBottom: 12 }} />
              <p data-testid="draft-redirect-status" style={{ margin: "0 0 5px", fontSize: 15, fontWeight: 800, color: UI.text }}>{t("pinDetails.redirectStatus")}</p>
              <p style={{ margin: 0, fontSize: 12, color: UI.textSec, lineHeight: 1.55 }}>{t("pinDetails.redirectBody")}</p>
            </div>
          </div>
        )}

      </div>
    </>
  );
}

/** Backward-compatible Weekly Plan entry point. */
export function DraftDetailsDrawer(props: Omit<PinDetailsModalProps, "source" | "mode">) {
  return <PinDetailsModal {...props} source="weekly_plan" mode="publish" />;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function seedProducts(draft: PinDraft): AttachedProduct[] {
  if (draft.linkedProducts?.length) {
    return draft.linkedProducts.map((p, i) => ({
      id: p.productId ?? `linked_prod_${draft.id}_${i}`,
      title: p.title,
      imageUrl: p.imageUrl,
      productUrl: p.productUrl,
      sourceDomain: p.store,
      price: p.price,
    }));
  }
  return (draft.setupSnapshot?.selectedProducts ?? [])
    .filter(p => p.title || p.imageUrl || p.productUrl)
    .map((p, i) => ({
      id: p.productId ?? `plan_prod_${draft.id}_${i}`,
      title: p.title?.trim() || "Product",
      imageUrl: p.imageUrl ?? undefined,
      productUrl: p.productUrl,
      sourceDomain: p.sourceDomain ?? p.source,
    }));
}

function fmt12h(time: string): string {
  const [hRaw, mRaw] = time.split(":");
  const h = Number(hRaw);
  if (Number.isNaN(h)) return time;
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(Number(mRaw ?? 0)).padStart(2, "0")} ${ampm}`;
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

/** e.g. "Tue Jun 30th, 2026" */
function formatSchedDate(dateISO: string): string {
  try {
    const d = new Date(`${dateISO}T00:00:00`);
    const wd = d.toLocaleDateString("en-US", { weekday: "short" });
    const mo = d.toLocaleDateString("en-US", { month: "short" });
    return `${wd} ${mo} ${ordinal(d.getDate())}, ${d.getFullYear()}`;
  } catch { return dateISO; }
}

/** Local UTC-offset label, e.g. "GMT+8". */
function gmtLabel(): string {
  const off = -new Date().getTimezoneOffset() / 60;
  const sign = off >= 0 ? "+" : "-";
  return `GMT${sign}${Math.abs(off)}`;
}
