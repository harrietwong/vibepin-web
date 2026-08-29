/**
 * scheduledDestinationsAvailable.ts — refuse to STORE a schedule aimed at an
 * account that cannot publish it.
 *
 * The case: the merchant removes an account, a tab that has been open since
 * before the removal syncs, and a brand-new schedule is written naming the row
 * that just went away. The cron would then own an orphan no screen can explain,
 * because the account it names is gone. Refusing the WRITE is what this does.
 *
 * Deliberately NOT a check the client can be trusted with. A stale tab is the
 * whole failure mode, so the authority has to be the write path itself.
 *
 * What this does NOT close, stated plainly because the previous version of this
 * comment claimed otherwise: the validation below and the write that follows it
 * are SEPARATE TRANSACTIONS. A removal that commits in between is accepted by
 * both — the read saw a live account, the write stores the schedule naming it —
 * and the atomic remove (remove_social_connection_if_unscheduled, v67) does not
 * catch it either, because at the moment it ran there was no schedule to find.
 * Neither guard is wrong; they simply do not share a transaction.
 *
 * That interleaving is an ACCEPTED RESIDUAL (owner decision, 2026-08-29). Its
 * whole consequence is a schedule that fails at publish time with
 * `target_disconnected` — a visible, explainable failure on a Content that was
 * never posted. There is no duplicate post and no silent success. Closing it
 * would mean holding a lock across the connection read and the draft write for
 * every batched PUT of up to 50 drafts, which costs more than the failure it
 * prevents.
 *
 * Server-only: it reads the connection store. The rule that decides WHICH ids
 * matter is the pure `requiredScheduleConnectionIds` in api/pin-drafts/promote.ts,
 * which stays importable under bare `tsx`.
 */

import { findConnection, listConnections } from "@/lib/social/server/socialConnectionStore";
import type { SocialProvider } from "@/lib/social/platforms";

/** One draft that names a destination we cannot publish through at due time. */
export interface UnavailableDestination {
  draftId: string;
  connectionId: string;
  /** Known when we could identify the row; null when the id resolves to nothing. */
  provider: SocialProvider | null;
  /** "missing" — no such connection for this user. "disconnected" — row exists, cannot publish. */
  reason: "missing" | "disconnected";
}

/** A draft to validate: its id and the connection ids its schedule will use. */
export interface ScheduleTarget {
  draftId: string;
  connectionIds: readonly string[];
}

/**
 * Which of these drafts name a connection that is gone or cannot publish.
 *
 * ONE `listConnections` for the whole batch: the PUT accepts up to 50 drafts and
 * a per-destination lookup would turn one sync into dozens of round trips.
 *
 * `listConnections` (the plain form) is the right reader here — it is the same
 * one the publish paths use, and it already excludes Pinterest rows the merchant
 * disconnected. It does NOT exclude a disconnected Facebook/Instagram row, which
 * still comes back with `connection_status = not_connected`, so the status check
 * is load-bearing: presence alone would accept an account that cannot publish.
 *
 * Ids containing ":" (the legacy synthetic `pinterest:<uid>`, and provider-reported
 * accounts that live outside our table) get a second, single-id lookup before being
 * refused: they resolve through a different path in `findConnection`, and refusing
 * a merchant's real account because the batch reader does not enumerate it would be
 * a worse failure than the one this guards.
 */
export async function unavailableScheduleDestinations(
  uid: string,
  targets: readonly ScheduleTarget[],
): Promise<UnavailableDestination[]> {
  const wanted = new Set<string>();
  for (const t of targets) for (const id of t.connectionIds) wanted.add(id);
  if (wanted.size === 0) return [];

  const connections = await listConnections(uid);
  const byId = new Map(connections.map(c => [c.id, c]));

  // id → why it cannot be used, or null when it is fine. Resolved once per id.
  const verdicts = new Map<string, { provider: SocialProvider | null; reason: "missing" | "disconnected" } | null>();
  for (const id of wanted) {
    let hit = byId.get(id) ?? null;
    if (!hit && id.includes(":")) hit = await findConnection(uid, id);
    if (!hit) {
      verdicts.set(id, { provider: null, reason: "missing" });
      continue;
    }
    verdicts.set(
      id,
      hit.connectionStatus === "connected"
        ? null
        : { provider: hit.provider, reason: "disconnected" },
    );
  }

  const out: UnavailableDestination[] = [];
  for (const t of targets) {
    for (const id of t.connectionIds) {
      const verdict = verdicts.get(id);
      if (!verdict) continue;
      out.push({ draftId: t.draftId, connectionId: id, provider: verdict.provider, reason: verdict.reason });
    }
  }
  return out;
}
