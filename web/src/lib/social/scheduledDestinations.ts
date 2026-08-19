/**
 * Scheduled publish INTENT — the canonical read/write rules.
 *
 * Three separate business facts, kept separate on purpose (the P0 architecture
 * decision):
 *
 *   A. intent   where a Pin is MEANT to publish when its time comes.
 *               Lives on the draft (`payload.scheduledDestinations`).
 *   B. attempt  a publish execution that actually started.
 *               `social_publish_jobs`, created only when dispatch begins.
 *   C. result   what each destination of that attempt achieved.
 *               `social_publish_job_destinations`.
 *
 * Conflating A with B/C is what produced the defect this fixes: the merchant's
 * multi-platform choice existed only in React state, so a three-platform
 * schedule silently executed as Pinterest-only. Pre-creating job rows at
 * schedule time would have been the other wrong answer — `customer360` and
 * `adminOverview` both read every job row as publishing activity that already
 * happened, so future intent sitting in those tables would corrupt analytics.
 *
 * This module is import-safe on both server and client: no secrets, no Node
 * APIs, no DB access.
 */

import { isSocialProvider, type SocialProvider } from "./platforms";
import type { PinDraft, ScheduledDestination } from "../pinDraftStore";

/** Trim a possibly-undefined string field to a usable value, or "". */
function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Build the intent record for a Pinterest destination from the draft's existing
 * pinned target. This is the shape the drawer writes and the shape historical
 * drafts are read AS — it is deliberately the same code path, so a legacy Pin
 * and a freshly scheduled one behave identically at due time.
 */
export function pinterestDestinationFrom(
  draft: Partial<Pick<PinDraft, "targetConnectionId" | "targetAccountLabel" | "boardId" | "boardName">>,
  capturedAt: string,
): ScheduledDestination | null {
  const connectionId = str(draft.targetConnectionId);
  if (!connectionId) return null;
  const d: ScheduledDestination = {
    provider: "pinterest",
    socialConnectionId: connectionId,
    capturedAt,
  };
  const label = str(draft.targetAccountLabel);
  const boardId = str(draft.boardId);
  const boardName = str(draft.boardName);
  if (label) d.accountLabel = label;
  if (boardId) d.boardId = boardId;
  if (boardName) d.boardName = boardName;
  return d;
}

/** A stored entry is only usable if it names a real provider AND an account. */
export function isUsableDestination(d: unknown): d is ScheduledDestination {
  if (!d || typeof d !== "object") return false;
  const r = d as Record<string, unknown>;
  return isSocialProvider(r.provider) && !!str(r.socialConnectionId);
}

/**
 * THE read rule. Everything that needs to know where a scheduled Pin should
 * publish — the due-time worker above all — must go through this.
 *
 * Stored intent wins. When there is none (every Pin scheduled before this
 * feature existed), the Pinterest target already pinned on the draft is derived
 * as an equivalent Pinterest-only intent.
 *
 * That derivation is deliberately READ-SIDE rather than a backfill migration:
 *
 *   - Rewriting ~3.7k historical payloads would bump every `updatedAt` and push
 *     a full LWW re-sync to every client — a large, irreversible cost for data
 *     we can compute exactly.
 *   - It is a pure function, so it is testable and cannot corrupt stored rows.
 *
 * It NEVER invents Instagram or Facebook. Those were never recorded for
 * historical Pins, so they cannot be recovered — and guessing them from the
 * currently-connected accounts or the workspace default would fabricate a
 * merchant decision that was never made.
 */
export function resolveScheduledDestinations(
  draft: Partial<
    Pick<
      PinDraft,
      "scheduledDestinations" | "targetConnectionId" | "targetAccountLabel" | "boardId" | "boardName"
    >
  >,
): ScheduledDestination[] {
  const stored = Array.isArray(draft.scheduledDestinations) ? draft.scheduledDestinations : [];
  const usable = stored.filter(isUsableDestination);
  if (usable.length) return usable;

  // Legacy Pin: derive Pinterest-only from the pinned target, if it has one.
  // `capturedAt` reflects that this was derived now, not chosen by the merchant.
  const derived = pinterestDestinationFrom(draft, new Date().toISOString());
  return derived ? [derived] : [];
}

/**
 * True when a draft carries destination intent the merchant explicitly chose,
 * as opposed to intent we derived from a legacy Pinterest target. Callers that
 * must not treat a derivation as a merchant decision (e.g. anything offering to
 * "keep your previous destinations") use this.
 */
export function hasExplicitIntent(draft: Partial<Pick<PinDraft, "scheduledDestinations">>): boolean {
  return Array.isArray(draft.scheduledDestinations)
    && draft.scheduledDestinations.filter(isUsableDestination).length > 0;
}

/**
 * THE write rule: turn the merchant's current selection into frozen intent.
 *
 * Pinterest takes its account and board from the draft's pinned target, so the
 * intent and the legacy `targetConnectionId`/`boardId` fields can never
 * disagree — the due-time worker and any un-migrated code path keep seeing the
 * same Pinterest destination.
 *
 * Non-Pinterest platforms need an explicitly resolved connection id; a selected
 * platform with no resolvable account is dropped from the intent rather than
 * stored as a half-record that would fail at due time with nothing to point at.
 * Callers are expected to have refused that selection upstream.
 */
export function buildScheduledDestinations(
  selected: readonly SocialProvider[],
  draft: Partial<Pick<PinDraft, "targetConnectionId" | "targetAccountLabel" | "boardId" | "boardName">>,
  resolveConnection: (provider: SocialProvider) => { id: string; label?: string } | null,
  now: Date = new Date(),
): ScheduledDestination[] {
  const capturedAt = now.toISOString();
  const out: ScheduledDestination[] = [];
  for (const provider of selected) {
    if (provider === "pinterest") {
      const p = pinterestDestinationFrom(draft, capturedAt);
      if (p) out.push(p);
      continue;
    }
    const conn = resolveConnection(provider);
    if (!conn || !str(conn.id)) continue;
    const d: ScheduledDestination = {
      provider,
      socialConnectionId: str(conn.id),
      capturedAt,
    };
    const label = str(conn.label);
    if (label) d.accountLabel = label;
    out.push(d);
  }
  return out;
}

/** The providers named by a draft's effective intent, in order. */
export function scheduledProviders(
  draft: Parameters<typeof resolveScheduledDestinations>[0],
): SocialProvider[] {
  return resolveScheduledDestinations(draft)
    .map(d => d.provider)
    .filter(isSocialProvider);
}
