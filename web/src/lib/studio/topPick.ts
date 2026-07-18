/**
 * Top pick derivation (Creative Intelligence — WP1).
 *
 * Picks ONE qualitative "Top pick" per generation batch (generationSessionId).
 * A batch card qualifies only when it is an AI-generated result with a READY quality
 * judge, a non-invalid verdict, and a numeric overall score. The highest overall wins;
 * ties break toward the earliest-created card (createdAt asc, then id asc). A batch must
 * have at least two qualifying cards for a Top pick to exist at all — a lone result is
 * never "top". No numeric score ever leaves this module (badge is purely qualitative).
 *
 * Pure + sibling-blind by design: callers pass the full draft list and get back the set
 * of top-pick ids, so the badge transfers automatically when a top card is removed/hidden.
 */

import type { PinDraft } from "@/lib/pinDraftStore";

const MIN_BATCH_QUALIFIED = 2;

function qualifies(d: Pick<PinDraft, "source" | "generationSessionId" | "qualityJudge">): boolean {
  if (d.source !== "ai_generated_from_upload") return false;
  if (!d.generationSessionId) return false;
  const j = d.qualityJudge;
  if (!j || j.status !== "ready") return false;
  if (j.verdict === "invalid") return false;
  return typeof j.overall === "number";
}

/** True when `a` should outrank `b` (higher overall; tie → earlier created, then lower id). */
function outranks(a: PinDraft, b: PinDraft): boolean {
  const ao = a.qualityJudge!.overall!;
  const bo = b.qualityJudge!.overall!;
  if (ao !== bo) return ao > bo;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt;
  return a.id < b.id;
}

/** Set of draft ids that should show the "Top pick" badge (at most one per batch). */
export function deriveTopPickIds(drafts: PinDraft[]): Set<string> {
  const bySession = new Map<string, PinDraft[]>();
  for (const d of drafts) {
    if (!qualifies(d)) continue;
    const group = bySession.get(d.generationSessionId);
    if (group) group.push(d);
    else bySession.set(d.generationSessionId, [d]);
  }

  const top = new Set<string>();
  for (const group of bySession.values()) {
    if (group.length < MIN_BATCH_QUALIFIED) continue;
    let best = group[0];
    for (let i = 1; i < group.length; i++) {
      if (outranks(group[i], best)) best = group[i];
    }
    top.add(best.id);
  }
  return top;
}
