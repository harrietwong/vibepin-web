/**
 * splitPairIdentity.ts — the id rule that ties a split Instagram child to its
 * Pinterest parent (design 0924 §2), and the scheduled-post metering identity that
 * follows from it (Fable ruling on T2 block 4, 2026-09-24, option A).
 *
 * Kept dependency-free (no pinDraftStore / social imports) so the cron route can
 * import it without pulling in client-side modules. `splitMixedVideoDraft.ts`
 * re-exports both names, so there is still exactly one definition.
 */

/** Suffix that names an Instagram child produced by `splitMixedVideoDraft`. */
export const IG_CHILD_ID_SUFFIX = "__ig";

/**
 * Strict inverse of the child-id rule: only a real `${x}__ig` where `x` is
 * non-empty and does not itself end in `__ig` (which would mean `id` was
 * already a child id with a second suffix appended — never a legitimate
 * parent). Case-sensitive, no trimming — a stray space or wrong case is not
 * a match, it is a different (and invalid) id.
 */
export function parentIdOf(childId: unknown): string | null {
  if (typeof childId !== "string") return null;
  if (!childId.endsWith(IG_CHILD_ID_SUFFIX)) return null;
  const prefix = childId.slice(0, -IG_CHILD_ID_SUFFIX.length);
  if (!prefix) return null;
  if (prefix.endsWith(IG_CHILD_ID_SUFFIX)) return null;
  return prefix;
}

/**
 * The draft identity a SCHEDULED post is metered under (Fable ruling, T2 block 4,
 * option A): "same Content + same schedule instant = one distribution = 1 unit;
 * moved apart = two publish events = 1 unit each".
 *
 * A split child `foo__ig` meters as its parent `foo`; the caller combines this with
 * the row's OWN `scheduled_at` (deriveScheduledPostKey), so:
 *   - both halves due at the same instant → identical key → the second consume is a
 *     replay (1 unit), and the existing v68 fresh/replay + release/re-arm rules give
 *     the right refund outcome for every success/failure mix;
 *   - rescheduled apart → two keys → two units, by design.
 * Pairing comes ONLY from the id (never a payload field — payload is client-
 * writable), and it is owner-scoped because the key also hashes the user id: a
 * different owner's `foo__ig` can never land on this owner's `foo` key.
 *
 * Deliberately NOT used on the immediate ("publish now") paths: publishing the two
 * halves separately right now is two independent events (same ruling).
 */
export function scheduledPostMeterIdentity(draftId: string): string {
  return parentIdOf(draftId) ?? draftId;
}

/**
 * How many scheduled_post units a batch of newly scheduled drafts will cost at due
 * time — the SAME identity the cron meters under: a split pair (`foo` + `foo__ig`)
 * saved together with the SAME scheduled_at is one unit; with different times it is
 * two. Used by the `/api/pin-drafts` quota pre-check (it lives here, not in the
 * route file, because a Next.js route module may only export handlers).
 *
 * Only pairs inside the given batch are collapsed; a half whose sibling was
 * scheduled by an earlier save still counts 1 (conservative — it can only
 * over-estimate by one at the quota boundary).
 */
export function scheduledPostUnits(draftIds: readonly string[], scheduledAt: ReadonlyMap<string, string>): number {
  const keys = new Set<string>();
  for (const id of draftIds) {
    keys.add(`${scheduledPostMeterIdentity(id)}|${scheduledAt.get(id) ?? `unscheduled:${id}`}`);
  }
  return keys.size;
}
