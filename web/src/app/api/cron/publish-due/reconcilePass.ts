/**
 * reconcilePass.ts — stage 0 of the publish-due cron: settle the deliveries
 * nobody knows the outcome of (发布可靠性 P0 技术设计 v0.1 §5).
 *
 * Runs BEFORE the due scan, inside the same cron invocation, on its own 60s
 * sub-budget. Every provider call it makes is a GET; the only rows it writes
 * are its own tables plus one narrow edit to the draft's result list.
 *
 * ── WHAT IT IS FOR ──────────────────────────────────────────────────────────
 * A round that ends in `delivery_unknown` is a publish where the request left
 * and the answer never came back. The Pin may exist. Because it may exist,
 * NOTHING in this codebase will send it again — `pendingDestinations` counts
 * `delivery_unknown` as closed, and the dispatcher early-returns on it. That is
 * correct and it is also a dead end: without someone going to ask Pinterest,
 * the destination sits there forever.
 *
 * This pass is that someone. It asks, and then it does exactly one of three
 * things (§5.3), never a fourth.
 *
 * ── THE INVARIANT EVERY READER SHOULD CHECK FIRST ───────────────────────────
 * This file must never cause a provider CREATE call. It calls `getPin`,
 * `getMediaStatus` and `listBoardPins` — three GETs — and it authorizes a
 * future re-send only by removing a stored result row, which puts the
 * destination back on the ordinary path where the five-attempt ledger, the
 * backoff gate and the claim all still apply. The tests assert the create count
 * directly for that reason: P18 (=1), P19 (=2, and only after the verdict),
 * P20 (=1), P28 (=1 forever).
 *
 * ── AND THE SECOND ONE ──────────────────────────────────────────────────────
 * `still_unknown` writes NOTHING to `pin_drafts`. Not a status, not a message,
 * not a timestamp. Any write bumps `payload.updatedAt`, which is what the
 * browser's last-write-wins merge compares — so a pass that touched the row
 * every five minutes would push a re-sync to every connected client forever,
 * and would make the "payload is unchanged" promise (§5.3) untrue.
 *
 * ── ★ KNOWN LIMITATION: VIDEO `confirmed_absent` DOES NOT RE-SEND ───────────
 * This pass is COMPLETE for images and INCOMPLETE for video, deliberately, and
 * the incomplete half fails safe. Stated here because the behaviour is not
 * obvious from any single file:
 *
 * Removing the stored result row re-opens the destination, which is all an
 * image needs. A video row instead goes back through `dispatchV76PinterestVideo`,
 * which inspects the v76 ledger, finds the PARENT destination still sitting at
 * `delivery_unknown`, and early-returns `unknownResult`
 * (v76PinterestVideoPublish.ts:358) — before any claim and before any provider
 * call. The route records a fresh `delivery_unknown` row and re-flags
 * reconciliation at the next attempt number.
 *
 * So a video whose delivery is confirmed absent cycles reconcile → absent →
 * re-dispatch → unknown, advancing one attempt each time, until attempt 5
 * stamps `final_failure_at`. The consequences, precisely:
 *
 *   · ZERO provider create calls at any point — no duplicate Pin is possible.
 *   · The merchant's video is NOT re-sent; it ends as a final failure they can
 *     retry by hand through the existing v78 path.
 *
 * Fixing it needs a CHILD intent via `publish_intent_confirm_prepare_v82`,
 * which is built and verified (probe_v82_task4.py) but not wired. One thing
 * still must happen: a child receipt with its own deterministic actionId,
 * `onlyPending: true` and a single-element dispatch set (migrate_v82:440-454).
 *
 * The OTHER half is now done. `recordVerdict` used to pass
 * `p_intent_row_id: null`, which made every video check row UNREDEEMABLE — the
 * RPC requires `v_parent.id = v_check.publish_intent_id` (migrate_v82:458) and
 * refuses otherwise. `resolveParentIntentRowId` below now records the parent
 * intent's database id on the check row, so the proof this pass writes can
 * actually be consumed once the child path is wired.
 */

import type { createServerClient } from "@/lib/supabase";
import {
  PinterestApiError,
  PinterestClient,
  type FetchedPin,
  type PinterestMediaStatus,
} from "@/lib/server/pinterest/service";
import {
  destinationResultKey,
  recordReconciledPublish,
  removeDestinationResult,
  type DueRowRef,
  type RowIo,
} from "./persistRow";
import {
  nextProbe,
  reconcileVerdict,
  type ProbeResult,
  type ReconcileAnchors,
  type ReconcileProbes,
  type ReconcileVerdict,
} from "./reconcileVerdict";
import { recordAttempt } from "./attemptLedger";
import { MAX_PUBLISH_ATTEMPTS } from "./retrySchedule";
import { computeNextAttemptAt } from "@/lib/server/publish/retryClassification";

type Db = ReturnType<typeof createServerClient>;

/** Stage 0's own wall-clock budget (design §6.1). */
export const RECONCILE_BUDGET_MS = 60_000;
/** At most this many open reconciliations per tick — the rest wait one tick. */
export const RECONCILE_LIMIT = 10;

const ATTEMPTS_TABLE = "scheduled_publish_attempts";
const CHECKS_TABLE = "publish_reconcile_checks";
const RECONCILE_RPC = "publish_reconcile_record_v82";

/** One destination awaiting a verdict, as read from the attempt ledger. */
type OpenReconciliation = {
  ownerUserId: string;
  draftId: string;
  scheduledAt: string;
  provider: string;
  socialConnectionId: string | null;
  attempt: number;
  finalFailureAt: string | null;
  mediaId: string | null;
  /** When the attempt that produced the unknown delivery was recorded. */
  startedAtMs: number | null;
};

export type ReconcilePassResult = {
  examined: number;
  confirmedPublished: number;
  confirmedAbsent: number;
  stillUnknown: number;
  /** Rows left for the next tick because the sub-budget ran out. */
  deferred: number;
};

/**
 * The provider surface this pass needs, as an interface rather than a concrete
 * client.
 *
 * Injected so tests can drive every branch of the verdict — a 404, a timeout,
 * an ambiguous board listing — without a network, and, more importantly, so a
 * test can assert that NO create method was ever reachable from here. The real
 * implementation below builds a per-connection `PinterestClient`.
 */
export type ReconcileProbeClient = {
  getPin(pinId: string): Promise<FetchedPin | null>;
  getMediaStatus(mediaId: string): Promise<PinterestMediaStatus | null>;
  listBoardPins(boardId: string): Promise<{ items: FetchedPin[]; bookmark: string | null }>;
};

export type ReconcileProbeFactory = (
  userId: string,
  socialConnectionId: string | null,
) => Promise<ReconcileProbeClient>;

const defaultProbeFactory: ReconcileProbeFactory = async (userId, connectionId) => {
  const client = connectionId
    ? await PinterestClient.forConnection(userId, connectionId)
    : await PinterestClient.forUser(userId);
  return {
    getPin: id => client.getPin(id),
    getMediaStatus: id => client.getMediaStatus(id),
    listBoardPins: id => client.listBoardPins(id),
  };
};

/** Turn a thrown provider error into a probe result, preserving the 404. */
function toProbe<T>(run: () => Promise<T | null>): Promise<ProbeResult<T>> {
  return run().then(
    value => (value === null
      ? { kind: "not_found" as const }
      : { kind: "ok" as const, value }),
    (err: unknown) => ({
      kind: "error" as const,
      message: err instanceof PinterestApiError
        ? `${err.code ?? "pinterest_api_error"}:${err.providerStatus ?? err.status}`
        : (err as Error)?.message ?? "probe_failed",
    }),
  );
}

/**
 * The reconciliations waiting for an answer.
 *
 * Read from the ATTEMPT ledger, not from `pin_drafts`: the ledger is
 * service-role-only, so an open reconciliation cannot be invented by a client
 * editing its own draft. The payload is consulted afterwards, to confirm the
 * destination really does carry a `delivery_unknown` row — both halves must
 * agree before anything is probed.
 */
async function loadOpenReconciliations(db: Db, limit: number): Promise<OpenReconciliation[]> {
  const { data, error } = await db
    .from(ATTEMPTS_TABLE)
    .select(
      "owner_user_id, draft_id, scheduled_at, provider, social_connection_id, attempt,"
      + " final_failure_at, last_media_id, created_at",
    )
    .not("reconcile_required_at", "is", null)
    .is("reconciled_at", null)
    .order("reconcile_required_at", { ascending: true })
    .limit(limit);
  if (error) {
    // Degrade to "nothing to reconcile", exactly as the ledger read in stage 1
    // does. A bookkeeping outage must not take scheduled publishing down with
    // it — stage 1 still runs.
    console.error("[cron/publish-due] reconcile scan:", error.message);
    return [];
  }
  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map(r => ({
    ownerUserId: String(r.owner_user_id),
    draftId: String(r.draft_id),
    scheduledAt: String(r.scheduled_at),
    provider: String(r.provider),
    socialConnectionId: typeof r.social_connection_id === "string" && r.social_connection_id
      ? r.social_connection_id
      : null,
    attempt: Number(r.attempt),
    finalFailureAt: typeof r.final_failure_at === "string" ? r.final_failure_at : null,
    mediaId: typeof r.last_media_id === "string" && r.last_media_id ? r.last_media_id : null,
    startedAtMs: typeof r.created_at === "string" && !Number.isNaN(Date.parse(r.created_at))
      ? Date.parse(r.created_at)
      : null,
  }));
}

/** The draft row this reconciliation is about, or null if it is gone/changed. */
async function loadDraft(
  db: Db,
  item: OpenReconciliation,
): Promise<{ payload: Record<string, unknown>; scheduledAt: string | null } | null> {
  const { data, error } = await db
    .from("pin_drafts")
    .select("payload, scheduled_at")
    .eq("vibepin_user_id", item.ownerUserId)
    .eq("draft_id", item.draftId)
    .maybeSingle();
  if (error || !data) {
    if (error) console.error("[cron/publish-due] reconcile draft read:", error.message);
    return null;
  }
  const row = data as { payload?: unknown; scheduled_at?: string | null };
  return {
    payload: (row.payload && typeof row.payload === "object"
      ? row.payload
      : {}) as Record<string, unknown>,
    scheduledAt: row.scheduled_at ?? null,
  };
}

/**
 * The anchors for one reconciliation, taken ONLY from server-side evidence.
 *
 * ── WHY THE PAYLOAD IS NOT AN ANCHOR SOURCE ─────────────────────────────────
 * `pin_drafts` is writable by its owner and merged last-write-wins from the
 * browser. A pinId taken from there could be chosen by the merchant — and a
 * chosen id that 404s produces `confirmed_absent`, which is the one verdict
 * that authorizes a re-send. That is a self-service duplicate-Pin button. So
 * the pin and media ids come from `pinterest_publish_evidence` (v81, service-
 * role) and the attempt ledger (service-role) only.
 *
 * The board, title and link ARE read from the payload, and that is safe for a
 * different reason: they can only make the listing match STRICTER or fail to
 * match. A tampered title cannot manufacture a 404; the worst it can do is
 * produce `still_unknown`, which sends nothing.
 */
async function loadAnchors(
  db: Db,
  item: OpenReconciliation,
  payload: Record<string, unknown>,
): Promise<ReconcileAnchors> {
  const destinationKey = destinationResultKey(item.provider, item.socialConnectionId);
  let pinId: string | null = null;
  let mediaId = item.mediaId;

  // v81 rich evidence, when the video lineage recorded any for this destination.
  // Missing table (v81 not installed) is a degrade, not an error: the design
  // says so explicitly (§2.2 A).
  try {
    const { data, error } = await db
      .from("pinterest_publish_evidence")
      .select("evidence")
      .eq("owner_user_id", item.ownerUserId)
      .eq("destination_id", destinationKey)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!error && data) {
      const evidence = (data as { evidence?: unknown }).evidence;
      if (evidence && typeof evidence === "object") {
        const e = evidence as Record<string, unknown>;
        if (typeof e.pinId === "string" && e.pinId.trim()) pinId = e.pinId.trim();
        if (!mediaId && typeof e.mediaId === "string" && e.mediaId.trim()) {
          mediaId = e.mediaId.trim();
        }
      }
    }
  } catch (err) {
    console.error("[cron/publish-due] reconcile evidence read:", (err as Error).message);
  }

  const destination = Array.isArray(payload.scheduledDestinations)
    ? (payload.scheduledDestinations as Array<Record<string, unknown>>).find(d =>
      d?.provider === item.provider
      && (typeof d?.socialConnectionId === "string" ? d.socialConnectionId : null)
        === item.socialConnectionId)
    : undefined;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

  return {
    pinId,
    mediaId,
    boardId: str(destination?.boardId) ?? str(payload.boardId),
    title: str(payload.title),
    link: str(payload.destinationUrl) ?? str(payload.link) ?? str(payload.websiteUrl),
    attemptStartedAtMs: item.startedAtMs,
  };
}

/** Probe in §5.2's order, stopping at the first decisive answer. */
async function runProbes(
  client: ReconcileProbeClient,
  anchors: ReconcileAnchors,
): Promise<ReconcileProbes> {
  const probes: ReconcileProbes = {};
  // Bounded by the three probe kinds; `nextProbe` returns null once each has
  // been attempted, so this cannot spin.
  for (let step = 0; step < 3; step++) {
    const which = nextProbe(anchors, probes);
    if (!which) break;
    if (which === "pin" && anchors.pinId) {
      probes.pin = await toProbe(() => client.getPin(anchors.pinId as string));
    } else if (which === "media" && anchors.mediaId) {
      probes.media = await toProbe(() => client.getMediaStatus(anchors.mediaId as string));
    } else if (which === "boardPins" && anchors.boardId) {
      probes.boardPins = await toProbe(async () =>
        client.listBoardPins(anchors.boardId as string));
    } else {
      break;
    }
  }
  return probes;
}

/**
 * The v76 intent row this destination's unknown delivery belongs to — the
 * DATABASE id (`publish_intents.id`), not the text `intent_id`.
 *
 * ── WHY THIS LOOKUP EXISTS AT ALL ───────────────────────────────────────────
 * `publish_intent_confirm_prepare_v82` refuses unless
 * `v_parent.id = v_check.publish_intent_id` (migrate_v82:458). A check row
 * written without it is UNREDEEMABLE: the proof is recorded, and nothing can
 * ever consume it. So the id has to be resolved here, at write time, while the
 * destination is still identifiable — there is no second chance later, because
 * the RPC compares against the stored column, not against anything the caller
 * passes at redemption.
 *
 * ── WHY IT IS SCOPED BY THE DESTINATION, NOT JUST THE DRAFT ─────────────────
 * One draft can carry several intents (an immediate publish, then a scheduled
 * one, then a v78 retry child). "Latest intent for this draft" would pick
 * whichever ran last, which is not necessarily the one holding THIS
 * destination's unknown delivery. The join narrows it to the intent that owns a
 * destination row sitting at `delivery_unknown` for this exact destination key,
 * which is precisely the row the RPC will later demand (migrate_v82:467-473).
 *
 * ── IMAGES ARE UNAFFECTED ───────────────────────────────────────────────────
 * The image path has no intent ledger row, so this finds nothing and returns
 * null — the same value that was passed unconditionally before. Any error is
 * also null: a bookkeeping lookup must never be the reason stage 0 stops, and
 * failing to null degrades to exactly today's behaviour (proof recorded,
 * unredeemable) rather than to a lost verdict.
 */
async function resolveParentIntentRowId(
  db: Db,
  item: OpenReconciliation,
  destinationKey: string,
): Promise<string | null> {
  try {
    const { data, error } = await db
      .from("publish_intent_destinations")
      .select("publish_intent_id, publish_intents!inner(id, user_id, draft_id)")
      .eq("destination_id", destinationKey)
      .eq("status", "delivery_unknown")
      .eq("publish_intents.user_id", item.ownerUserId)
      .eq("publish_intents.draft_id", item.draftId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) {
      if (error) console.error("[cron/publish-due] reconcile intent lookup:", error.message);
      return null;
    }
    const id = (data as { publish_intent_id?: unknown }).publish_intent_id;
    return typeof id === "string" && id ? id : null;
  } catch (err) {
    console.error("[cron/publish-due] reconcile intent lookup threw:", (err as Error).message);
    return null;
  }
}

/** Write the verdict to `publish_reconcile_checks`. Returns the check row id. */
async function recordVerdict(
  db: Db,
  item: OpenReconciliation,
  verdict: ReconcileVerdict,
  anchors: ReconcileAnchors,
): Promise<string | null> {
  try {
    const destinationKey = destinationResultKey(item.provider, item.socialConnectionId);
    const intentRowId = await resolveParentIntentRowId(db, item, destinationKey);
    const { data, error } = await db.rpc(RECONCILE_RPC, {
      p_user_id: item.ownerUserId,
      p_draft_id: item.draftId,
      p_scheduled_at: item.scheduledAt,
      p_provider: item.provider,
      p_connection_id: item.socialConnectionId,
      p_attempt: item.attempt,
      p_outcome: verdict.outcome,
      p_remote_id: verdict.remoteId ?? null,
      p_remote_url: verdict.remoteUrl ?? null,
      p_intent_row_id: intentRowId,
      p_destination_id: destinationKey,
      p_provider_attempt_id: null,
      p_evidence: {
        reason: verdict.reason,
        ...(anchors.pinId ? { pinId: anchors.pinId } : {}),
        ...(anchors.mediaId ? { mediaId: anchors.mediaId } : {}),
      },
    });
    if (error) {
      console.error("[cron/publish-due] reconcile record:", error.message);
      return null;
    }
    const id = (data as { id?: unknown } | null)?.id;
    return typeof id === "string" ? id : null;
  } catch (err) {
    console.error("[cron/publish-due] reconcile record threw:", (err as Error).message);
    return null;
  }
}

/**
 * Stage 0. Settle what can be settled; leave everything else exactly as it was.
 *
 * Returns counts for the run summary. Never throws: a failure anywhere here
 * must not stop stage 1 from publishing the rows that are due.
 */
export async function runReconcilePass(
  db: Db,
  io: RowIo,
  options: {
    startedMs: number;
    budgetMs?: number;
    limit?: number;
    probeFactory?: ReconcileProbeFactory;
  },
): Promise<ReconcilePassResult> {
  const result: ReconcilePassResult = {
    examined: 0, confirmedPublished: 0, confirmedAbsent: 0, stillUnknown: 0, deferred: 0,
  };
  const budgetMs = options.budgetMs ?? RECONCILE_BUDGET_MS;
  const probeFactory = options.probeFactory ?? defaultProbeFactory;
  const open = await loadOpenReconciliations(db, options.limit ?? RECONCILE_LIMIT);
  if (!open.length) return result;

  for (const item of open) {
    // Checked BEFORE the work, like the claim budget in stage 1: an item not
    // started is untouched and simply waits. Stage 1 is what must not be
    // starved — a late reconciliation is a delay, a skipped due scan is a
    // publish that did not happen.
    if (Date.now() - options.startedMs >= budgetMs) {
      result.deferred++;
      continue;
    }
    // Pinterest only in P0 (design §10): IG/FB have no reconciliation surface
    // here and must not be probed with a Pinterest client.
    if (item.provider !== "pinterest") continue;

    try {
      const draft = await loadDraft(db, item);
      if (!draft) continue;
      const destinationKey = destinationResultKey(item.provider, item.socialConnectionId);
      const rows = Array.isArray(draft.payload.destinationResults)
        ? (draft.payload.destinationResults as Array<Record<string, unknown>>)
        : [];
      const stored = rows.find(r => r?.destinationId === destinationKey);
      // Both halves must agree. A ledger entry whose draft no longer shows an
      // unknown delivery describes a situation that has already moved on
      // (republished by hand, destination removed, Content deleted): probing it
      // could only produce a verdict about a row that no longer exists.
      if (!stored || stored.status !== "delivery_unknown") continue;

      result.examined++;
      const anchors = await loadAnchors(db, item, draft.payload);
      const client = await probeFactory(item.ownerUserId, item.socialConnectionId);
      const probes = await runProbes(client, anchors);
      const verdict = reconcileVerdict(anchors, probes);
      const ref: DueRowRef = {
        vibepin_user_id: item.ownerUserId,
        draft_id: item.draftId,
        // The schedule this reconciliation belongs to. `removeDestinationResult`
        // and the merge both CAS on the row's CURRENT schedule, so passing the
        // ledger's value here only records which lifecycle this was about.
        scheduled_at: draft.scheduledAt,
      };

      if (verdict.outcome === "confirmed_published") {
        // Record FIRST: the check row is the durable evidence, and the RPC is
        // what closes the ledger entry. If the payload write then fails, the
        // next tick re-probes, gets the same answer, and writes it again —
        // idempotent, because the destination result is keyed and replaced.
        await recordVerdict(db, item, verdict, anchors);
        const { error } = await recordReconciledPublish(io, ref, {
          provider: item.provider, socialConnectionId: item.socialConnectionId,
        }, { id: verdict.remoteId ?? "", url: verdict.remoteUrl ?? null });
        if (error) console.error("[cron/publish-due] reconcile publish persist:", error);
        result.confirmedPublished++;
        continue;
      }

      if (verdict.outcome === "confirmed_absent") {
        await recordVerdict(db, item, verdict, anchors);
        // ── The five-attempt cap still binds ────────────────────────────────
        // A destination whose ledger row is already terminal does NOT get its
        // result row removed: removing it would put a destination that has
        // spent its budget back on the owed list, and the next tick would send
        // a sixth time. The check is recorded either way — knowing the Pin was
        // never created is worth storing even when the answer is "and it never
        // will be". Closing the reconciliation lets the row finish normally
        // and surface as the final failure it is.
        if (item.finalFailureAt || item.attempt >= MAX_PUBLISH_ATTEMPTS) {
          result.confirmedAbsent++;
          continue;
        }
        // The retry is scheduled on the SAME attempt number: this round
        // consumed no provider attempt — it was a reconciliation, not a send —
        // so the RPC's unique index takes its DO UPDATE path and the sequence
        // does not advance. What changes is `next_attempt_at`, which is what
        // re-opens the gate.
        const next = computeNextAttemptAt(item.attempt, undefined);
        await recordAttempt(db, {
          userId: item.ownerUserId, draftId: item.draftId,
          scheduledAt: item.scheduledAt, provider: item.provider,
          connectionId: item.socialConnectionId,
          attempt: item.attempt, retryClass: "retryable",
          nextAttemptAt: next ? next.toISOString() : null,
          reconcileRequiredAt: null,
          evidence: { providerCode: "reconciled_absent" },
        });
        const removal = await removeDestinationResult(io, ref, destinationKey, {
          nextAttemptAt: next ? next.toISOString() : null,
        });
        if (removal.error) {
          console.error("[cron/publish-due] reconcile absent persist:", removal.error);
        }
        result.confirmedAbsent++;
        continue;
      }

      // ── still_unknown ──────────────────────────────────────────────────────
      // The check row is written; `pin_drafts` is NOT touched, by design, and
      // the RPC deliberately leaves `reconcile_required_at` pending so the
      // schedule stays held and the question is asked again next tick.
      await recordVerdict(db, item, verdict, anchors);
      result.stillUnknown++;
      // The alarm. P0's channel is the log (design §10); a real alerting
      // surface is P2. Shaped so the age of an unknown delivery is greppable,
      // because "oldest delivery_unknown" is the metric the PRD asks for.
      console.error(
        `[cron/publish-due] reconcile still_unknown draft_id=${item.draftId}`
        + ` user=${item.ownerUserId} destination=${destinationKey}`
        + ` attempt=${item.attempt} scheduled_at=${item.scheduledAt}`
        + ` ageMs=${item.startedAtMs ? Date.now() - item.startedAtMs : "unknown"}`
        + ` reason=${verdict.reason}`,
      );
    } catch (err) {
      // One unreconcilable destination must not abort the pass, and certainly
      // must not abort stage 1.
      console.error(
        `[cron/publish-due] reconcile threw draft_id=${item.draftId}:`,
        (err as Error).message,
      );
    }
  }
  return result;
}

/**
 * The most recent `confirmed_absent` verdict for one destination, if any.
 *
 * Read by the VIDEO re-send path in stage 1: a video destination cannot simply
 * be re-dispatched (the v76 dispatcher early-returns on a `delivery_unknown`
 * parent, and the parent's intent id is derived deterministically, so a naive
 * re-send would loop forever returning "unknown"). It needs a CHILD intent, and
 * `publish_intent_confirm_prepare_v82` will only open one when handed the id of
 * a row whose outcome is `confirmed_absent`. This is where that id comes from.
 *
 * Returns null on any error or absence — which leaves the video destination
 * exactly where it was, un-retried. Failing toward "do not re-send" is the
 * whole posture of this feature.
 */
export async function latestConfirmedAbsentCheck(
  db: Db,
  args: {
    userId: string; draftId: string; scheduledAt: string;
    provider: string; socialConnectionId: string | null;
  },
): Promise<{
  id: string;
  attempt: number;
  /** The parent intent's DATABASE id. Null on rows written before that fix. */
  publishIntentId: string | null;
  /** The destination this proof vouches for — the RPC accepts no other. */
  destinationId: string | null;
} | null> {
  try {
    const { data, error } = await db
      .from(CHECKS_TABLE)
      .select("id, attempt, outcome, checked_at, publish_intent_id, destination_id")
      .eq("owner_user_id", args.userId)
      .eq("draft_id", args.draftId)
      .eq("scheduled_at", args.scheduledAt)
      .eq("provider", args.provider)
      // ★ THE DESTINATION FILTER IS LOAD-BEARING, NOT DECORATIVE.
      // Without it a draft with two Pinterest accounts returns account A's
      // proof while the fan-out loop is evaluating account B: every gate
      // condition passes, a child intent is built for A, and B's ORDINARY
      // first send is dispatched under it. B then fails on a child intent that
      // does not contain it — a send lost and a failure row invented, for a
      // destination no reconciliation ever examined.
      // A proof vouches for its own destination and no other.
      .eq("destination_id", destinationResultKey(args.provider, args.socialConnectionId))
      .eq("outcome", "confirmed_absent")
      .order("checked_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) {
      if (error) console.error("[cron/publish-due] reconcile check read:", error.message);
      return null;
    }
    const row = data as {
      id?: unknown; attempt?: unknown;
      publish_intent_id?: unknown; destination_id?: unknown;
    };
    return typeof row.id === "string"
      ? {
        id: row.id,
        attempt: Number(row.attempt) || 1,
        publishIntentId: typeof row.publish_intent_id === "string" && row.publish_intent_id
          ? row.publish_intent_id
          : null,
        destinationId: typeof row.destination_id === "string" && row.destination_id
          ? row.destination_id
          : null,
      }
      : null;
  } catch (err) {
    console.error("[cron/publish-due] reconcile check read threw:", (err as Error).message);
    return null;
  }
}

/**
 * The parent intent's TEXT `intent_id`, given its database id.
 *
 * Two different identifiers are in play and confusing them is silent: the check
 * row stores the parent's UUID (`publish_intents.id`), while the receipt's
 * `priorIntentId` is matched against the TEXT `intent_id`
 * (migrate_v82:457). The child receipt needs the text form, so one more read is
 * unavoidable.
 *
 * Null on anything unexpected, which the caller treats as "no credential" and
 * therefore "do not re-send".
 */
export async function parentIntentTextId(
  db: Db,
  userId: string,
  intentRowId: string,
): Promise<string | null> {
  try {
    const { data, error } = await db
      .from("publish_intents")
      .select("intent_id")
      .eq("id", intentRowId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data) {
      if (error) console.error("[cron/publish-due] parent intent read:", error.message);
      return null;
    }
    const id = (data as { intent_id?: unknown }).intent_id;
    return typeof id === "string" && id ? id : null;
  } catch (err) {
    console.error("[cron/publish-due] parent intent read threw:", (err as Error).message);
    return null;
  }
}
