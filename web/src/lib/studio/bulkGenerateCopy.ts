/**
 * bulkGenerateCopy.ts — the ONE bulk "Generate copy" orchestration (design §4, T4).
 *
 * Shared by the Create Pins bulk bar and Batch Edit (flag-on path). Pure: no React,
 * no store, no network. The caller injects `generate` (one card → one AI Copy call)
 * and `apply` (merge that card's result into FRESH state), so the rules below are
 * testable without a browser.
 *
 * Rules (design §4.2):
 *  - every card is an independent task; one failure never touches another card
 *  - at most `concurrency` (default 2) requests in flight
 *  - a field the user edited (touched) and that is non-empty is NEVER overwritten
 *    unless the caller explicitly opted into `replaceTouched` (fixes D8)
 *  - 402 (plan allowance spent) stops the batch: nothing new is sent; the refused
 *    card and everything not yet sent are `not_started` (not failures)
 *  - 429 pauses the batch for Retry-After, then resumes ONCE; a second 429 stops it
 *  - cancel: nothing new is sent; in-flight requests finish
 *  - generation only ever writes copy fields — never schedule / publish state
 */

export type CopyField = "title" | "description" | "altText";
export const COPY_FIELDS: readonly CopyField[] = ["title", "description", "altText"];

export type CopyTouchedFlags = {
  titleTouched?: boolean;
  descriptionTouched?: boolean;
  altTextTouched?: boolean;
};

const TOUCHED_KEY: Record<CopyField, keyof CopyTouchedFlags> = {
  title: "titleTouched",
  description: "descriptionTouched",
  altText: "altTextTouched",
};

export type BulkCopyCard = {
  id: string;
  title: string;
  description: string;
  altText: string;
  touched?: CopyTouchedFlags;
  /** Amazon affiliate card: `canGenerate` is the §2.3 product-name gate. Absent = not Amazon. */
  amazon?: { canGenerate: boolean } | null;
  /** A copy request (or the Pin's own generation) is already running for this card. */
  busy?: boolean;
};

export type GeneratedCopy = { title: string; description: string; altText: string };

export type BulkCopyOptions = { replaceTouched?: boolean };

/** True when this field must be kept as the user left it. */
export function isFieldProtected(card: Pick<BulkCopyCard, CopyField | "touched">, field: CopyField, opts: BulkCopyOptions = {}): boolean {
  if (opts.replaceTouched) return false;
  const value = (card[field] ?? "").trim();
  return value.length > 0 && card.touched?.[TOUCHED_KEY[field]] === true;
}

export type BulkCopyPreflight = {
  ready: BulkCopyCard[];
  /** Amazon cards without a product name (§2.3 gate) — no request is sent. */
  needsProductName: BulkCopyCard[];
  /** Already generating — skipped, never doubled up. */
  generating: BulkCopyCard[];
  /** Every copy field is the user's own text — nothing to write, no request sent. */
  alreadyCopyComplete: BulkCopyCard[];
};

/** Split the selection BEFORE any request, so skipped cards never cost a generation. */
export function preflightBulkCopy(cards: BulkCopyCard[], opts: BulkCopyOptions = {}): BulkCopyPreflight {
  const out: BulkCopyPreflight = { ready: [], needsProductName: [], generating: [], alreadyCopyComplete: [] };
  for (const card of cards) {
    if (card.busy) out.generating.push(card);
    else if (card.amazon && !card.amazon.canGenerate) out.needsProductName.push(card);
    else if (COPY_FIELDS.every(field => isFieldProtected(card, field, opts))) out.alreadyCopyComplete.push(card);
    else out.ready.push(card);
  }
  return out;
}

export type MergeResult = {
  patch: Partial<Record<CopyField, string>>;
  written: CopyField[];
  /** Fields kept because the user edited them. */
  kept: CopyField[];
};

/**
 * Per-field merge (design §4.2): write a field only when it is empty or untouched,
 * unless `replaceTouched`. `current` must be read FRESH at apply time — the user may
 * have typed into the card while its request was in flight.
 */
export function mergeGeneratedCopy(current: Pick<BulkCopyCard, CopyField | "touched">, generated: GeneratedCopy, opts: BulkCopyOptions = {}): MergeResult {
  const result: MergeResult = { patch: {}, written: [], kept: [] };
  for (const field of COPY_FIELDS) {
    const next = (generated[field] ?? "").trim();
    if (!next) continue;
    if (isFieldProtected(current, field, opts)) { result.kept.push(field); continue; }
    result.patch[field] = generated[field];
    result.written.push(field);
  }
  return result;
}

// ── Quota preflight (soft) ────────────────────────────────────────────────────

export type TextUsage = { used: number | null; limit: number | null } | null;

export type QuotaPreflight =
  /** Usage could not be read — say nothing definite; the server still decides. */
  | { kind: "unknown"; needed: number }
  | { kind: "unlimited"; needed: number }
  | { kind: "enough"; needed: number; remaining: number }
  /** Not enough: only the first `remaining` would be generated. Soft — never blocks. */
  | { kind: "short"; needed: number; remaining: number };

/** One AI text generation per ready card (only `generate` reserves; analyze is free). */
export function quotaPreflight(usage: TextUsage, readyCount: number): QuotaPreflight {
  if (!usage) return { kind: "unknown", needed: readyCount };
  if (usage.limit === null) return { kind: "unlimited", needed: readyCount };
  const remaining = Math.max(0, usage.limit - (usage.used ?? 0));
  return remaining >= readyCount
    ? { kind: "enough", needed: readyCount, remaining }
    : { kind: "short", needed: readyCount, remaining };
}

// ── Runner ────────────────────────────────────────────────────────────────────

export type BulkCopyItemStatus = "queued" | "running" | "succeeded" | "failed" | "skipped" | "not_started";

export type BulkCopyItem = {
  id: string;
  status: BulkCopyItemStatus;
  /** failed: error message; skipped / not_started: a reason code. */
  reason?: string;
  written?: CopyField[];
  kept?: CopyField[];
};

export type BulkCopyErrorKind =
  | { kind: "text_limit" }
  | { kind: "rate_limited"; retryAfterSeconds: number | null }
  | { kind: "needs_product_name" }
  | { kind: "busy" }
  | { kind: "failed"; message: string };

export type BulkCopyStopReason = "text_limit" | "rate_limited" | "cancelled";

export type BulkCopySummary = {
  items: BulkCopyItem[];
  succeeded: number;
  failed: number;
  skipped: number;
  notStarted: number;
  /** How many cards kept each field because the user had edited it. */
  keptByField: Record<CopyField, number>;
  stoppedBy: BulkCopyStopReason | null;
  /** True when the batch paused on a 429 and resumed. */
  resumedAfterRateLimit: boolean;
};

export type RunBulkCopyInput = {
  /** Cards to send, in order (normally `preflight.ready`). */
  cards: BulkCopyCard[];
  generate: (card: BulkCopyCard) => Promise<GeneratedCopy>;
  /** Merge against FRESH state and persist; returns what was written / kept. */
  apply: (cardId: string, generated: GeneratedCopy) => Pick<MergeResult, "written" | "kept">;
  classifyError: (error: unknown) => BulkCopyErrorKind;
  concurrency?: number;
  isCancelled?: () => boolean;
  onUpdate?: (items: BulkCopyItem[]) => void;
  /** Injected so tests never wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Pause used when a 429 carries no Retry-After. */
  defaultRetryAfterSeconds?: number;
};

export const BULK_COPY_CONCURRENCY = 2;

export async function runBulkGenerateCopy(input: RunBulkCopyInput): Promise<BulkCopySummary> {
  const concurrency = Math.max(1, Math.min(BULK_COPY_CONCURRENCY, Math.floor(input.concurrency ?? BULK_COPY_CONCURRENCY)));
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const items = new Map<string, BulkCopyItem>(input.cards.map(card => [card.id, { id: card.id, status: "queued" as const }]));
  const queue = [...input.cards];
  let stoppedBy: BulkCopyStopReason | null = null;
  let rateLimitHits = 0;
  let resumedAfterRateLimit = false;
  let pause: Promise<void> | null = null;

  const emit = () => input.onUpdate?.(input.cards.map(card => ({ ...items.get(card.id)! })));
  const set = (id: string, patch: Partial<BulkCopyItem>) => { items.set(id, { ...items.get(id)!, ...patch }); emit(); };

  async function worker(): Promise<void> {
    for (;;) {
      if (pause) await pause;
      if (stoppedBy) return;
      if (input.isCancelled?.()) { stoppedBy = "cancelled"; return; }
      const card = queue.shift();
      if (!card) return;
      set(card.id, { status: "running", reason: undefined });
      let generated: GeneratedCopy;
      try {
        generated = await input.generate(card);
      } catch (error) {
        const kind = input.classifyError(error);
        if (kind.kind === "text_limit") {
          stoppedBy = stoppedBy ?? "text_limit";
          set(card.id, { status: "not_started", reason: "text_limit" });
          return;
        }
        if (kind.kind === "rate_limited") {
          if (pause) {
            // Another request already triggered this pause: same event, not a second hit.
            queue.unshift(card);
            set(card.id, { status: "queued" });
            continue;
          }
          rateLimitHits++;
          if (rateLimitHits > 1) {
            stoppedBy = stoppedBy ?? "rate_limited";
            set(card.id, { status: "not_started", reason: "rate_limited" });
            return;
          }
          queue.unshift(card);
          set(card.id, { status: "queued", reason: "rate_limited_paused" });
          const seconds = kind.retryAfterSeconds ?? input.defaultRetryAfterSeconds ?? 30;
          pause = sleep(Math.max(0, seconds) * 1000).then(() => { pause = null; resumedAfterRateLimit = true; });
          continue;
        }
        if (kind.kind === "needs_product_name") { set(card.id, { status: "skipped", reason: "needs_product_name" }); continue; }
        if (kind.kind === "busy") { set(card.id, { status: "skipped", reason: "generating" }); continue; }
        set(card.id, { status: "failed", reason: kind.message });
        continue;
      }
      try {
        const merged = input.apply(card.id, generated);
        set(card.id, { status: "succeeded", written: merged.written, kept: merged.kept });
      } catch (error) {
        set(card.id, { status: "failed", reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  emit();
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, input.cards.length)) }, () => worker()));

  // Anything never sent is "not started" — never a failure.
  for (const card of queue) {
    const current = items.get(card.id)!;
    if (current.status === "queued") items.set(card.id, { ...current, status: "not_started", reason: stoppedBy ?? "cancelled" });
  }
  const list = input.cards.map(card => items.get(card.id)!);
  const keptByField: Record<CopyField, number> = { title: 0, description: 0, altText: 0 };
  for (const item of list) for (const field of item.kept ?? []) keptByField[field]++;
  const summary: BulkCopySummary = {
    items: list,
    succeeded: list.filter(i => i.status === "succeeded").length,
    failed: list.filter(i => i.status === "failed").length,
    skipped: list.filter(i => i.status === "skipped").length,
    notStarted: list.filter(i => i.status === "not_started").length,
    keptByField,
    stoppedBy,
    resumedAfterRateLimit,
  };
  input.onUpdate?.(list.map(i => ({ ...i })));
  return summary;
}

/** Ids of the failed items — "Retry failed" re-runs exactly these. */
export function failedIds(summary: Pick<BulkCopySummary, "items">): string[] {
  return summary.items.filter(item => item.status === "failed").map(item => item.id);
}
