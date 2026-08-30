/**
 * meterGeneration.ts — SERVER-ONLY. Phase 4I: wire the v55 usage ledger into
 * /api/generate, in SHADOW MODE by default.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * WHAT THIS DOES (and what it deliberately does NOT do)
 * ═══════════════════════════════════════════════════════════════════════════════
 * The v55 primitives (usage_reserve_generation_job / usage_settle_reservation_item /
 * usage_release_reservation) have, until this phase, had exactly one caller: the DB
 * test harness. This module is the FIRST application caller. It reserves image-slot
 * capacity against the user's usage account BEFORE dispatch, and settles it per slot
 * afterwards — so the ledger tracks real image spend.
 *
 * ENFORCEMENT STAYS OFF. The default mode is `off`: no ledger call happens at all and
 * production behaviour is byte-for-byte unchanged until USAGE_METERING_MODE is set.
 * `shadow` records to the ledger but NEVER blocks generation — any ledger failure
 * (insufficient balance, RPC error, unreachable Supabase) is logged and generation
 * PROCEEDS. `enforce` (reserved for a later phase, not enabled in prod here) turns an
 * insufficient-balance refusal into a 402-style limit response.
 *
 * ── WHY SHADOW FAILS OPEN — the inverse of the moderation gate ─────────────────
 * /api/generate's moderation gate fails CLOSED: a compliance control must refuse when
 * it cannot decide. Metering in shadow mode is the OPPOSITE by design. It is an
 * observability/accounting overlay we are proving out against real traffic; a ledger
 * bug, an unseeded account, or a Supabase hiccup must never cost a paying user a
 * generation they were entitled to. So every failure here is swallowed (logged, not
 * thrown) and the caller carries on. This asymmetry is deliberate; do not "unify" it.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * SLOT-KEY CONTRACT (load-bearing — mirrored in api/app/worker.py)
 * ═══════════════════════════════════════════════════════════════════════════════
 * The reservation is created with slot keys ["s0","s1",...,"s{count-1}"] — one per
 * requested image, matching array length == quantity (v55's rule). The worker settles
 * each slot with the SAME key, derived from its integer slot index as "s" + str(slot).
 * TS produces the keys here; Python reproduces them there. If either side changes the
 * shape, per-slot settlement silently stops matching, so both sites carry this note.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * IDENTITY / SCOPE
 * ═══════════════════════════════════════════════════════════════════════════════
 * Only authenticated `user:<id>` callers meter. Anonymous inline callers
 * (session:/anon:) have no usage account and are skipped entirely. The FastAPI branch
 * is fire-and-forget (the route never learns its outcome) so it is NOT reserved —
 * reserving there would leak reserved capacity forever. See callers in
 * app/api/generate/route.ts.
 */

import crypto from "crypto";
import { createServerClient } from "@/lib/supabase";
import { ensureUsageAccount } from "./ensureAccount";

/** off | shadow | enforce. Defaults to `off` — production is unchanged until set. */
export type UsageMeteringMode = "off" | "shadow" | "enforce";

export function usageMeteringMode(): UsageMeteringMode {
  const raw = (process.env.USAGE_METERING_MODE ?? "off").trim().toLowerCase();
  if (raw === "shadow") return "shadow";
  if (raw === "enforce") return "enforce";
  return "off";
}

/** True when the ledger should be touched at all (shadow or enforce). */
export function meteringActive(): boolean {
  return usageMeteringMode() !== "off";
}

// ── PER-TYPE ENFORCE SWITCHES (product decision #8, 2026-08-28) ─────────────────
// The three usage types (AI images, AI text, scheduled posts) must be switchable
// independently. USAGE_METERING_MODE stays the single ON/OFF for the ledger itself
// (off = no ledger call at all; shadow/enforce both record). Whether an `insufficient`
// outcome actually BLOCKS the request is a SEPARATE, per-type decision layered on top:
// setting the global mode to "enforce" alone blocks NOTHING until the matching
// per-type flag below is also turned on, so enforcement can be rolled out type by type
// rather than as one global cutover.
export type UsageEnforceType = "ai_image" | "ai_text_generation" | "scheduled_post";

/** Exported so predeploy-guard.mjs can print these without duplicating the names. */
export const USAGE_ENFORCE_ENV_VAR: Record<UsageEnforceType, string> = {
  ai_image: "USAGE_ENFORCE_AI_IMAGES",
  ai_text_generation: "USAGE_ENFORCE_AI_TEXT",
  scheduled_post: "USAGE_ENFORCE_SCHEDULED_POSTS",
};

function isTruthyFlag(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true";
}

/**
 * True ONLY when the global mode is "enforce" AND the per-type env flag
 * (USAGE_ENFORCE_AI_IMAGES / USAGE_ENFORCE_AI_TEXT / USAGE_ENFORCE_SCHEDULED_POSTS,
 * accepting "1"/"true" case-insensitively, default false) is set for `type`. This is
 * the single decision point every blocking call site must use instead of comparing
 * `usageMeteringMode() === "enforce"` directly.
 */
export function usageEnforceFor(type: UsageEnforceType): boolean {
  if (usageMeteringMode() !== "enforce") return false;
  return isTruthyFlag(process.env[USAGE_ENFORCE_ENV_VAR[type]]);
}

/**
 * The canonical slot keys for a `count`-image reservation: ["s0","s1",...]. Array
 * length IS the quantity (v55 derives quantity from the slots). The worker rebuilds
 * the same key per slot as "s" + str(slot) — keep these two in lockstep.
 */
export function slotKeysForCount(count: number): string[] {
  const n = Math.max(1, Math.floor(count) || 1);
  return Array.from({ length: n }, (_, i) => `s${i}`);
}

/**
 * SERVER-DERIVED reservation idempotency key. v55 requires this never be a raw
 * client-supplied opaque string (a client that picks its own key could replay a cheap
 * key to mask an expensive request). We salt the (client-influenced) generationRequestId
 * with a server secret + the user id, exactly like the route salts nothing today but the
 * ledger's UNIQUE(account_id, request_key) demands a stable, non-forgeable key: the same
 * request retried by the client yields the same key (so no double-reserve), while a
 * different user or a tampered id cannot collide with someone else's reservation.
 */
export function deriveRequestKey(userId: string, generationRequestId: string): string {
  const salt = process.env.USAGE_REQUEST_KEY_SALT ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "vibepin-usage";
  return crypto
    .createHash("sha256")
    .update(`${salt}|${userId}|${generationRequestId}`)
    .digest("hex")
    .slice(0, 48);
}

/**
 * Structured log — identifiers and counts only, never prompts/keys/bytes.
 * Exported so the text sibling (meterTextGeneration.ts) reuses the SAME emitter
 * rather than duplicating the swallow-on-failure idiom (F1: share, do not copy).
 */
export function logEvent(event: string, fields: Record<string, unknown>): void {
  try {
    console.warn(JSON.stringify({ event, ...fields }));
  } catch {
    /* logging must never itself throw into the caller */
  }
}

export type RpcRunner = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>;

/**
 * The default RPC seam over createServerClient().rpc — exported so the text sibling
 * shares the ONE Supabase-client boundary (and the ONE injectable seam tests spy on).
 */
export function defaultRpc(): RpcRunner {
  return async (fn, args) => {
    const { data, error } = await createServerClient().rpc(fn, args);
    return { data, error: error ? { message: error.message, code: error.code } : null };
  };
}

// ── WORKER PATH: reserve + enqueue in one transaction ───────────────────────────

export type WorkerReserveOutcome =
  | { kind: "off" }
  | { kind: "skipped"; reason: string }
  | { kind: "reserved"; reservationId: string; jobId: string; slots: number }
  | { kind: "insufficient"; availableRecurring: number | null; availableBonus: number | null }
  | { kind: "error"; message: string };

/**
 * WORKER MODE reserve: replaces the plain generation_jobs insert with
 * usage_reserve_generation_job, which inserts the job AND the reservation atomically
 * and writes usage_reservation_id onto the job row. Returns the enqueued jobId so the
 * route responds identically to the plain-insert path.
 *
 * Only ever called in shadow|enforce for a `user:<id>` caller (the route gates on that
 * before calling). In shadow, an `insufficient` or `error` outcome is NOT terminal —
 * the caller falls back to the plain insert so the user still generates. In enforce,
 * the caller turns `insufficient` into a limit response.
 */
export async function reserveGenerationJobViaLedger(args: {
  userId: string;
  count: number;
  generationRequestId: string;
  params: Record<string, unknown>;
  deps?: { rpc?: RpcRunner; ensure?: typeof ensureUsageAccount };
}): Promise<WorkerReserveOutcome> {
  const mode = usageMeteringMode();
  if (mode === "off") return { kind: "off" };

  const ensure = args.deps?.ensure ?? ensureUsageAccount;
  const rpc = args.deps?.rpc ?? defaultRpc();
  const slotKeys = slotKeysForCount(args.count);
  const requestKey = deriveRequestKey(args.userId, args.generationRequestId);

  // ensure → reserve (F8: idempotent; seeds the account row the RPC locks).
  try {
    await ensure(args.userId);
  } catch (err) {
    logEvent("usage_meter_ensure_failed", {
      path: "worker",
      mode,
      identityKind: "user",
      error: (err as Error)?.message?.slice(0, 200),
    });
    // In shadow, a failed ensure must not block — the account simply is not metered.
    return { kind: "error", message: "ensure_failed" };
  }

  const { data, error } = await rpc("usage_reserve_generation_job", {
    p_user_id: args.userId,
    p_slot_keys: slotKeys,
    p_request_key: requestKey,
    p_params: args.params,
    p_operation: "image_generation",
  });

  if (error) {
    logEvent("usage_meter_reserve_error", {
      path: "worker",
      mode,
      slots: slotKeys.length,
      code: error.code,
      error: error.message?.slice(0, 200),
    });
    return { kind: "error", message: error.message };
  }

  const payload = (data ?? {}) as Record<string, unknown>;
  if (payload.ok !== true) {
    // Capacity refusal: nothing was reserved, nothing enqueued.
    logEvent("usage_meter_insufficient", {
      path: "worker",
      mode,
      slots: slotKeys.length,
      reason: payload.reason,
    });
    return {
      kind: "insufficient",
      availableRecurring:
        payload.available_recurring === undefined ? null : (payload.available_recurring as number | null),
      availableBonus:
        payload.available_bonus === undefined ? null : (payload.available_bonus as number | null),
    };
  }

  const reservationId = String(payload.reservation_id ?? "");
  const jobId = String(payload.job_id ?? "");
  if (!reservationId || !jobId) {
    logEvent("usage_meter_reserve_incomplete", { path: "worker", mode, slots: slotKeys.length });
    return { kind: "error", message: "reserve_returned_no_job" };
  }
  logEvent("usage_meter_reserved", {
    path: "worker",
    mode,
    slots: slotKeys.length,
    replayed: payload.replayed === true,
  });
  return { kind: "reserved", reservationId, jobId, slots: slotKeys.length };
}

// ── INLINE PATH: reserve, then settle in-process from the parsed result ─────────

export type InlineReservation =
  | { kind: "off" }
  | { kind: "skipped"; reason: string }
  | { kind: "reserved"; reservationId: string; slotKeys: string[] }
  | { kind: "insufficient"; availableRecurring: number | null; availableBonus: number | null }
  | { kind: "error"; message: string };

/**
 * INLINE MODE reserve (no job row — the route spawns generator.py itself and settles
 * synchronously from the parsed urls[]). Uses usage_reserve directly.
 */
export async function reserveInline(args: {
  userId: string;
  count: number;
  generationRequestId: string;
  deps?: { rpc?: RpcRunner; ensure?: typeof ensureUsageAccount };
}): Promise<InlineReservation> {
  const mode = usageMeteringMode();
  if (mode === "off") return { kind: "off" };

  const ensure = args.deps?.ensure ?? ensureUsageAccount;
  const rpc = args.deps?.rpc ?? defaultRpc();
  const slotKeys = slotKeysForCount(args.count);
  const requestKey = deriveRequestKey(args.userId, args.generationRequestId);

  try {
    await ensure(args.userId);
  } catch (err) {
    logEvent("usage_meter_ensure_failed", {
      path: "inline",
      mode,
      identityKind: "user",
      error: (err as Error)?.message?.slice(0, 200),
    });
    return { kind: "error", message: "ensure_failed" };
  }

  const { data, error } = await rpc("usage_reserve", {
    p_user_id: args.userId,
    p_usage_type: "ai_image",
    p_slot_keys: slotKeys,
    p_request_key: requestKey,
    p_operation: "image_generation",
  });

  if (error) {
    logEvent("usage_meter_reserve_error", {
      path: "inline",
      mode,
      slots: slotKeys.length,
      code: error.code,
      error: error.message?.slice(0, 200),
    });
    return { kind: "error", message: error.message };
  }

  const payload = (data ?? {}) as Record<string, unknown>;
  if (payload.ok !== true) {
    logEvent("usage_meter_insufficient", { path: "inline", mode, slots: slotKeys.length, reason: payload.reason });
    return {
      kind: "insufficient",
      availableRecurring:
        payload.available_recurring === undefined ? null : (payload.available_recurring as number | null),
      availableBonus:
        payload.available_bonus === undefined ? null : (payload.available_bonus as number | null),
    };
  }

  const reservationId = String(payload.reservation_id ?? "");
  if (!reservationId) {
    logEvent("usage_meter_reserve_incomplete", { path: "inline", mode, slots: slotKeys.length });
    return { kind: "error", message: "reserve_returned_no_id" };
  }
  logEvent("usage_meter_reserved", {
    path: "inline",
    mode,
    slots: slotKeys.length,
    replayed: payload.replayed === true,
  });
  return { kind: "reserved", reservationId, slotKeys };
}

/**
 * INLINE settle: the parse returned `successCount` urls. Settle slots s0..s{N-1} as
 * succeeded, the remaining reserved slots as terminal failure. Idempotent (v55 guards
 * each item on state='pending'), so a re-run is harmless. Every failure is swallowed
 * — a settle hiccup must never turn a successful generation into an error.
 */
export async function settleInline(args: {
  reservation: InlineReservation;
  successCount: number;
  deps?: { rpc?: RpcRunner };
}): Promise<void> {
  if (args.reservation.kind !== "reserved") return;
  const rpc = args.deps?.rpc ?? defaultRpc();
  const { reservationId, slotKeys } = args.reservation;
  const success = Math.max(0, Math.min(slotKeys.length, Math.floor(args.successCount) || 0));

  for (let i = 0; i < slotKeys.length; i++) {
    const outcome = i < success ? "succeeded" : "terminal_failed";
    try {
      const { error } = await rpc("usage_settle_reservation_item", {
        p_reservation_id: reservationId,
        p_slot_key: slotKeys[i],
        p_outcome: outcome,
      });
      if (error) {
        // Log-not-crash: the expiry sweeper is the safety net for anything unsettled.
        logEvent("usage_meter_settle_error", {
          path: "inline",
          slotKey: slotKeys[i],
          outcome,
          error: error.message?.slice(0, 200),
        });
      }
    } catch (err) {
      logEvent("usage_meter_settle_threw", {
        path: "inline",
        slotKey: slotKeys[i],
        outcome,
        error: (err as Error)?.message?.slice(0, 200),
      });
    }
  }
}

/**
 * INLINE release: give back the whole reservation when the run failed before producing
 * any slot (a synchronous dispatch error). Idempotent and swallow-on-failure.
 */
export async function releaseInline(args: {
  reservation: InlineReservation;
  reason?: string;
  deps?: { rpc?: RpcRunner };
}): Promise<void> {
  if (args.reservation.kind !== "reserved") return;
  const rpc = args.deps?.rpc ?? defaultRpc();
  try {
    const { error } = await rpc("usage_release_reservation", {
      p_reservation_id: args.reservation.reservationId,
      p_reason: args.reason ?? "generation_failed",
    });
    if (error) {
      logEvent("usage_meter_release_error", { path: "inline", error: error.message?.slice(0, 200) });
    }
  } catch (err) {
    logEvent("usage_meter_release_threw", { path: "inline", error: (err as Error)?.message?.slice(0, 200) });
  }
}

/**
 * The enforce-mode limit response body shape (reserved for a later phase — NOT enabled
 * in prod this phase). Consistent with the route's error envelope: a machine-readable
 * `code` the client can branch on, an empty urls[], the request id echoed back.
 */
export function aiImageLimitResponseBody(
  generationRequestId: string,
  availability?: { availableRecurring: number | null; availableBonus: number | null; requested: number },
): Record<string, unknown> {
  return {
    ok: false,
    error_type: "ai_image_limit_reached",
    code: "ai_image_limit_reached",
    error: "You've reached your AI image limit for this billing period. Upgrade or wait for it to reset.",
    urls: [],
    generation_request_id: generationRequestId,
    ...(availability
      ? {
          available_recurring: availability.availableRecurring,
          available_bonus: availability.availableBonus,
          requested: availability.requested,
        }
      : {}),
  };
}

/**
 * Product decision #11 (2026-08-28): the enqueue response should carry a usage
 * snapshot so the client can show remaining capacity without a second round trip.
 *
 * usage_reserve_generation_job's SUCCESS payload does not include an availability
 * figure (only its `insufficient` refusal branch does — see availableRecurring above)
 * — so on a successful reserve we read usage_accounts ONCE, straight after the
 * reserve, and compute limit - used - reserved ourselves. `reserved` already reflects
 * THIS request's slots at that point, so the number is accurate for what the caller
 * can request next. No migration: same columns /api/billing/usage already reads.
 *
 * Never throws: an availability-readback failure must not fail a successful enqueue
 * response, so any error resolves to `null` (client renders it as "unknown").
 */
export type UsageAccountBalanceRow = {
  ai_images_used: number | null;
  ai_images_limit: number | null;
  ai_images_reserved: number | null;
};

export async function readImagesAvailableAfterReservation(
  userId: string,
  deps?: { client?: { from: (table: string) => { select: (columns: string) => { eq: (col: string, val: string) => { maybeSingle: () => Promise<{ data: unknown; error: unknown }> } } } } },
): Promise<number | null> {
  try {
    const client = deps?.client ?? createServerClient();
    const { data, error } = await client
      .from("usage_accounts")
      .select("ai_images_used, ai_images_limit, ai_images_reserved")
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as UsageAccountBalanceRow;
    if (row.ai_images_limit === null || row.ai_images_limit === undefined) return null; // unlimited plan
    const used = typeof row.ai_images_used === "number" ? row.ai_images_used : 0;
    const reserved = typeof row.ai_images_reserved === "number" ? row.ai_images_reserved : 0;
    return Math.max(0, row.ai_images_limit - used - reserved);
  } catch (err) {
    logEvent("usage_meter_availability_read_failed", {
      path: "worker",
      error: (err as Error)?.message?.slice(0, 200),
    });
    return null;
  }
}
