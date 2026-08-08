/**
 * meterTextGeneration.ts — SERVER-ONLY. Phase 4T: wire the v55 usage ledger into
 * /api/ai-copy (AI TEXT generation), in SHADOW MODE by default.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * WHAT THIS DOES (and why it is a sibling of meterGeneration, not a fork)
 * ═══════════════════════════════════════════════════════════════════════════════
 * This is the TEXT counterpart of the image meter (meterGeneration.ts, Phase 4I).
 * Text is deliberately simpler than images: synchronous (no worker, no job RPC), and
 * a single unit per request — one Pin's title/description/altText/tags, no per-slot
 * fan-out. So it reserves EXACTLY ONE slot (["s0"]) against usage_reserve DIRECTLY
 * (NOT usage_reserve_generation_job — that RPC is image-only and hardcodes ai_image),
 * with p_usage_type="ai_text_generation" and p_operation="text_generation".
 *
 * The three-mode machinery (off / shadow / enforce), the server-derived idempotency
 * key, the structured logger and the injectable RPC seam are IMPORTED from
 * meterGeneration.ts — this module does not re-implement any of them, so the two
 * meters can never drift on the mode contract or the fail-open semantics.
 *
 * ENFORCEMENT STAYS OFF. Default mode `off`: no ledger call at all, /api/ai-copy is
 * byte-for-byte unchanged. `shadow` records reserve+settle but NEVER blocks — any
 * ledger failure (insufficient balance, RPC error, unreachable Supabase) is logged and
 * copy generation PROCEEDS. `enforce` (reserved for Phase 6A, NOT enabled in prod this
 * phase) turns an insufficient-balance refusal into the ai_text_limit_reached response.
 *
 * ── WHY SHADOW FAILS OPEN — identical rationale to the image meter ──────────────
 * Metering in shadow mode is an accounting overlay proven against real traffic; a
 * ledger bug, an unseeded account, or a Supabase hiccup must never cost a paying user
 * copy they were entitled to. Every failure here is swallowed (logged, not thrown) and
 * the caller carries on. This is the OPPOSITE of the moderation gate (fail-closed) by
 * design — do not "unify" it.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * ONE REQUEST = ONE CHARGE (load-bearing — see /api/ai-copy/route.ts)
 * ═══════════════════════════════════════════════════════════════════════════════
 * The route reserves ONCE before the model calls and settles the single slot ONCE at
 * its single success return. The route's internal quality-gate retries (fast + vision
 * paths) and the keyword-refine call all live inside the SAME try/single success
 * return, so no matter how many model calls fire internally, there is exactly one
 * reserve and one settle. A quality-gate failure / timeout / provider error / invalid
 * JSON throws CopyError and reaches the catch, which RELEASES the reservation → net
 * zero charge.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * IDENTITY / SCOPE
 * ═══════════════════════════════════════════════════════════════════════════════
 * Only authenticated `user:<id>` callers meter (the route resolves userId before it
 * reaches here; anonymous callers are 401'd earlier and never arrive). The meter is
 * wired ONLY inside /api/ai-copy — the sibling routes /api/ai-copy/analyze and
 * /api/quality-judge share provider helpers but NOT this module, so they stay at zero
 * text charge by construction.
 */

import { ensureUsageAccount } from "./ensureAccount";
import {
  usageMeteringMode,
  deriveRequestKey,
  logEvent,
  defaultRpc,
  type UsageMeteringMode,
  type RpcRunner,
} from "./meterGeneration";

// Re-export the shared mode surface so callers can import the whole meter contract
// from one place if they prefer (the route imports usageMeteringMode from here).
export { usageMeteringMode, type UsageMeteringMode } from "./meterGeneration";

/** The single canonical slot key for a text reservation. One request = one unit. */
export const TEXT_SLOT_KEYS = ["s0"] as const;

// ── TEXT PATH: reserve, then settle the single slot in-process ──────────────────

export type TextReservation =
  | { kind: "off" }
  | { kind: "skipped"; reason: string }
  | { kind: "reserved"; reservationId: string }
  | { kind: "insufficient"; availableRecurring: number | null; availableBonus: number | null }
  | { kind: "error"; message: string };

/**
 * TEXT reserve: usage_reserve with a SINGLE slot ["s0"], usage_type ai_text_generation,
 * operation text_generation. ensureUsageAccount runs first (idempotent; seeds the row
 * the RPC locks and its ai_text_generations_limit), fail-open in shadow.
 *
 * Only ever called in shadow|enforce for an authenticated caller (the route gates on
 * mode !== "off" and a resolved userId). In shadow, an `insufficient` or `error`
 * outcome is NOT terminal — the caller proceeds unmetered. In enforce, the caller turns
 * `insufficient` into the ai_text_limit_reached response.
 */
export async function reserveTextGeneration(args: {
  userId: string;
  generationRequestId: string;
  deps?: { rpc?: RpcRunner; ensure?: typeof ensureUsageAccount };
}): Promise<TextReservation> {
  const mode = usageMeteringMode();
  if (mode === "off") return { kind: "off" };

  const ensure = args.deps?.ensure ?? ensureUsageAccount;
  const rpc = args.deps?.rpc ?? defaultRpc();
  const requestKey = deriveRequestKey(args.userId, args.generationRequestId);

  try {
    await ensure(args.userId);
  } catch (err) {
    logEvent("usage_meter_ensure_failed", {
      path: "text",
      mode,
      identityKind: "user",
      error: (err as Error)?.message?.slice(0, 200),
    });
    // In shadow, a failed ensure must not block — the account simply is not metered.
    return { kind: "error", message: "ensure_failed" };
  }

  // The RpcRunner seam is expected to RETURN {error}, not throw (defaultRpc awaits and
  // destructures the supabase-js result, which surfaces errors as values). But a genuine
  // transport failure could still throw — in shadow that must not cost the caller their
  // copy, so we catch it and treat it as a non-terminal reserve error (fail-open).
  let data: unknown;
  let error: { message: string; code?: string } | null;
  try {
    ({ data, error } = await rpc("usage_reserve", {
      p_user_id: args.userId,
      p_usage_type: "ai_text_generation",
      p_slot_keys: [...TEXT_SLOT_KEYS],
      p_request_key: requestKey,
      p_operation: "text_generation",
    }));
  } catch (err) {
    logEvent("usage_meter_reserve_threw", {
      path: "text",
      mode,
      slots: TEXT_SLOT_KEYS.length,
      error: (err as Error)?.message?.slice(0, 200),
    });
    return { kind: "error", message: (err as Error)?.message ?? "reserve_threw" };
  }

  if (error) {
    logEvent("usage_meter_reserve_error", {
      path: "text",
      mode,
      slots: TEXT_SLOT_KEYS.length,
      code: error.code,
      error: error.message?.slice(0, 200),
    });
    return { kind: "error", message: error.message };
  }

  const payload = (data ?? {}) as Record<string, unknown>;
  if (payload.ok !== true) {
    logEvent("usage_meter_insufficient", {
      path: "text",
      mode,
      slots: TEXT_SLOT_KEYS.length,
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
  if (!reservationId) {
    logEvent("usage_meter_reserve_incomplete", { path: "text", mode, slots: TEXT_SLOT_KEYS.length });
    return { kind: "error", message: "reserve_returned_no_id" };
  }
  logEvent("usage_meter_reserved", {
    path: "text",
    mode,
    slots: TEXT_SLOT_KEYS.length,
    replayed: payload.replayed === true,
  });
  return { kind: "reserved", reservationId };
}

/**
 * TEXT settle-success: the request produced its one Pin's copy. Settle slot s0 as
 * succeeded. Idempotent (v55 guards each item on state='pending'), so a re-run is
 * harmless. Every failure is swallowed — a settle hiccup must never turn a successful
 * generation into an error. The expiry sweeper is the safety net for anything unsettled.
 */
export async function settleTextGeneration(args: {
  reservation: TextReservation;
  deps?: { rpc?: RpcRunner };
}): Promise<void> {
  if (args.reservation.kind !== "reserved") return;
  const rpc = args.deps?.rpc ?? defaultRpc();
  try {
    const { error } = await rpc("usage_settle_reservation_item", {
      p_reservation_id: args.reservation.reservationId,
      p_slot_key: TEXT_SLOT_KEYS[0],
      p_outcome: "succeeded",
    });
    if (error) {
      logEvent("usage_meter_settle_error", {
        path: "text",
        slotKey: TEXT_SLOT_KEYS[0],
        outcome: "succeeded",
        error: error.message?.slice(0, 200),
      });
    }
  } catch (err) {
    logEvent("usage_meter_settle_threw", {
      path: "text",
      slotKey: TEXT_SLOT_KEYS[0],
      outcome: "succeeded",
      error: (err as Error)?.message?.slice(0, 200),
    });
  }
}

/**
 * TEXT release: give the whole reservation back when the request failed before
 * producing copy (a quality-gate failure, provider error, invalid JSON, timeout).
 * Idempotent and swallow-on-failure.
 */
export async function releaseTextGeneration(args: {
  reservation: TextReservation;
  reason?: string;
  deps?: { rpc?: RpcRunner };
}): Promise<void> {
  if (args.reservation.kind !== "reserved") return;
  const rpc = args.deps?.rpc ?? defaultRpc();
  try {
    const { error } = await rpc("usage_release_reservation", {
      p_reservation_id: args.reservation.reservationId,
      p_reason: args.reason ?? "text_generation_failed",
    });
    if (error) {
      logEvent("usage_meter_release_error", { path: "text", error: error.message?.slice(0, 200) });
    }
  } catch (err) {
    logEvent("usage_meter_release_threw", { path: "text", error: (err as Error)?.message?.slice(0, 200) });
  }
}

/**
 * The enforce-mode limit response body shape (reserved for Phase 6A — NOT enabled in
 * prod this phase). Consistent with /api/ai-copy's error envelope ({ ok:false, error,
 * userMessage }): a machine-readable error_type/code the client can branch on plus a
 * user-safe message, and the requestId echoed back.
 */
export function aiTextLimitResponseBody(requestId: string): Record<string, unknown> {
  return {
    ok: false,
    requestId,
    error_type: "ai_text_limit_reached",
    error: "ai_text_limit_reached",
    code: "ai_text_limit_reached",
    userMessage:
      "You've reached your AI copy limit for this billing period. Upgrade or wait for it to reset.",
  };
}
