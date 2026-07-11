/**
 * Batch Edit detector — pure analysis + a findings builder.
 *
 * `detectBatch` is a pure function over normalized rows (easy to unit-test). It reuses
 * the canonical readiness rules from `pinReadiness` for missing-field logic. The Batch
 * Edit drawer converts the report into findings with `buildBatchFindings`, attaching
 * `run`/`preview` closures that go through the drawer's own apply handlers — every
 * `apply` is preview-gated, and unsafe fixes are emitted as `review` instead.
 */
import type { AssistantFinding, AssistantPreview } from "../types";

export type BatchPinLike = {
  id:              string;
  title:           string;
  description:     string;
  boardId?:        string | null;
  boardName?:      string | null;
  destinationUrl:  string;
  imageUrl:        string;
  /** Whether a product is linked to this pin at all. */
  hasProduct:      boolean;
  /** The linked product's URL, if any. */
  productUrl?:     string | null;
  /** True when the linked product is an Amazon/affiliate product. */
  isAffiliate?:    boolean;
  plannedDate?:    string | null;
};

export type BatchReport = {
  total:               number;
  missingBoards:       string[];       // pin ids
  missingUrls:         string[];       // pin ids
  productLinksToReview: string[];      // pin ids: product present but no/invalid link
  similarTitleGroups:  string[][];     // groups of pin ids with near-duplicate titles
  duplicateImageGroups: string[][];    // groups of pin ids sharing an image
  weakDescriptions:    string[];       // pin ids
  scheduleConflicts:   { key: string; date: string; board: string; pinIds: string[] }[];
};

const WEAK_DESCRIPTION_MIN = 40;      // chars
const TITLE_SIMILARITY_THRESHOLD = 0.6;
const SCHEDULE_CONFLICT_MIN = 3;      // same board + same day

function clean(v: string | null | undefined): string {
  const s = (v ?? "").trim();
  return s === "undefined" || s === "null" ? "" : s;
}

export function normalizeTitle(title: string): Set<string> {
  return new Set(
    clean(title)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

/** Jaccard similarity of two title token sets. */
export function titleSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Group pins whose titles are near-duplicates (single-link agglomeration). */
export function similarTitleGroups(pins: BatchPinLike[], threshold = TITLE_SIMILARITY_THRESHOLD): string[][] {
  const tokens = pins.map((p) => ({ id: p.id, set: normalizeTitle(p.title) }));
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) && parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  tokens.forEach((t) => parent.set(t.id, t.id));
  for (let i = 0; i < tokens.length; i++) {
    for (let j = i + 1; j < tokens.length; j++) {
      if (tokens[i].set.size === 0 || tokens[j].set.size === 0) continue;
      if (titleSimilarity(tokens[i].set, tokens[j].set) >= threshold) {
        parent.set(find(tokens[i].id), find(tokens[j].id));
      }
    }
  }
  const groups = new Map<string, string[]>();
  for (const t of tokens) {
    const root = find(t.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(t.id);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

export function detectBatch(pins: BatchPinLike[]): BatchReport {
  const missingBoards: string[] = [];
  const missingUrls: string[] = [];
  const productLinksToReview: string[] = [];
  const weakDescriptions: string[] = [];
  const imageMap = new Map<string, string[]>();
  const scheduleMap = new Map<string, { date: string; board: string; pinIds: string[] }>();

  for (const p of pins) {
    if (!clean(p.boardId)) missingBoards.push(p.id);
    if (!clean(p.destinationUrl)) missingUrls.push(p.id);
    if (p.hasProduct && !clean(p.productUrl)) productLinksToReview.push(p.id);
    if (clean(p.description).length < WEAK_DESCRIPTION_MIN) weakDescriptions.push(p.id);

    const img = clean(p.imageUrl);
    if (img) {
      if (!imageMap.has(img)) imageMap.set(img, []);
      imageMap.get(img)!.push(p.id);
    }

    const date = clean(p.plannedDate);
    const board = clean(p.boardId);
    if (date && board) {
      const key = `${date}|${board}`;
      if (!scheduleMap.has(key)) scheduleMap.set(key, { date, board, pinIds: [] });
      scheduleMap.get(key)!.pinIds.push(p.id);
    }
  }

  return {
    total: pins.length,
    missingBoards,
    missingUrls,
    productLinksToReview,
    similarTitleGroups: similarTitleGroups(pins),
    duplicateImageGroups: [...imageMap.values()].filter((g) => g.length > 1),
    weakDescriptions,
    scheduleConflicts: [...scheduleMap.entries()]
      .filter(([, v]) => v.pinIds.length >= SCHEDULE_CONFLICT_MIN)
      .map(([key, v]) => ({ key, ...v })),
  };
}

/** Total number of distinct actionable issues in a report. */
export function countBatchIssues(r: BatchReport): number {
  let n = 0;
  if (r.similarTitleGroups.reduce((a, g) => a + g.length, 0) > 0) n += 1;
  if (r.missingBoards.length) n += 1;
  if (r.missingUrls.length) n += 1;
  if (r.productLinksToReview.length) n += 1;
  if (r.duplicateImageGroups.length) n += 1;
  if (r.weakDescriptions.length) n += 1;
  if (r.scheduleConflicts.length) n += 1;
  return n;
}

/**
 * Handlers supplied by the Batch Edit drawer. Each returns the set of changes it would
 * make so the finding can show a preview BEFORE anything is applied. `apply*` is only
 * invoked after the user confirms the preview. When a handler can't determine a safe
 * fix it returns `null`, and the finding is emitted as `review` (not `apply`).
 */
export type BatchHandlers = {
  previewSuggestBoards?: () => AssistantPreview | null;
  applySuggestBoards?:   () => void;
  previewFillUrls?:      () => AssistantPreview | null;
  applyFillUrls?:        () => void;
  reviewTitles?:         () => void;   // focus/scroll to the similar titles
  reviewProductLinks?:   () => void;
  reviewSchedule?:       () => void;
};

export function buildBatchFindings(report: BatchReport, handlers: BatchHandlers = {}): AssistantFinding[] {
  const out: AssistantFinding[] = [];
  const similarCount = report.similarTitleGroups.reduce((a, g) => a + g.length, 0);

  if (similarCount > 0) {
    out.push({
      id: "batch:titles",
      severity: "issue",
      title: `${similarCount} titles are too similar`,
      detail: "Near-duplicate titles compete with each other in search. Vary them for reach.",
      actions: [
        { kind: "review", label: "Fix titles", run: handlers.reviewTitles, explanation: "Jump to the similar titles so you can differentiate them." },
        { kind: "explain", label: "Explain", explanation: "Pinterest treats each Pin as its own search result; distinct titles surface for more queries." },
      ],
    });
  }

  if (report.missingBoards.length > 0) {
    const n = report.missingBoards.length;
    const preview = handlers.previewSuggestBoards?.() ?? null;
    out.push({
      id: "batch:boards",
      severity: "issue",
      title: `${n} Pin${n === 1 ? "" : "s"} ${n === 1 ? "is" : "are"} missing boards`,
      detail: "A Pin needs a real Pinterest board before it can publish.",
      actions: preview && handlers.applySuggestBoards
        ? [
            { kind: "apply", label: "Suggest boards", preview, run: handlers.applySuggestBoards },
            { kind: "explain", label: "Explain", explanation: "I match each Pin to the closest board by its topic and category." },
          ]
        : [
            { kind: "review", label: "Suggest boards", explanation: "Open the board picker for the Pins missing a board." },
          ],
    });
  }

  if (report.missingUrls.length > 0) {
    const n = report.missingUrls.length;
    const preview = handlers.previewFillUrls?.() ?? null;
    out.push({
      id: "batch:urls",
      severity: "suggestion",
      title: `${n} Pin${n === 1 ? "" : "s"} could use a destination URL`,
      detail: "A Website URL is optional but recommended for product Pins — it lets people click through to your page.",
      // Fill only when a safe URL is unambiguous; otherwise downgrade to review.
      actions: preview && handlers.applyFillUrls
        ? [
            { kind: "apply", label: "Fill missing URLs", preview, run: handlers.applyFillUrls },
            { kind: "explain", label: "Explain", explanation: "I only auto-fill when a linked product gives an unambiguous URL. Others are left for you to review." },
          ]
        : [
            { kind: "review", label: "Review URLs", run: handlers.reviewProductLinks, explanation: "No unambiguous URL to auto-fill — open the Pins to set them." },
          ],
    });
  }

  if (report.productLinksToReview.length > 0) {
    const n = report.productLinksToReview.length;
    out.push({
      id: "batch:product-links",
      severity: "issue",
      title: `${n} product link${n === 1 ? "" : "s"} need review`,
      detail: "Some Pins have a product but no valid link. Check them before publishing.",
      actions: [
        { kind: "review", label: "Review product links", run: handlers.reviewProductLinks, explanation: "Open the product-link column to fix the flagged Pins." },
        { kind: "explain", label: "Explain", explanation: "A linked product should carry a working destination (and affiliate tag, if applicable)." },
      ],
    });
  }

  if (report.duplicateImageGroups.length > 0) {
    const dupCount = report.duplicateImageGroups.reduce((a, g) => a + g.length, 0);
    out.push({
      id: "batch:images",
      severity: "suggestion",
      title: `${dupCount} Pins reuse the same image`,
      detail: "Repeated images can look spammy. Consider varying the creative.",
      actions: [{ kind: "explain", label: "Explain", explanation: "Pinterest favors fresh visuals; duplicates dilute reach across a batch." }],
    });
  }

  if (report.weakDescriptions.length > 0) {
    const n = report.weakDescriptions.length;
    out.push({
      id: "batch:descriptions",
      severity: "suggestion",
      title: `${n} description${n === 1 ? " is" : "s are"} thin`,
      detail: "Longer, keyword-rich descriptions help Pins get discovered.",
      actions: [{ kind: "explain", label: "Explain", explanation: "Aim for a sentence or two with natural keywords and a clear benefit." }],
    });
  }

  if (report.scheduleConflicts.length > 0) {
    const days = report.scheduleConflicts.length;
    out.push({
      id: "batch:schedule",
      severity: "suggestion",
      title: `${days} day${days === 1 ? " has" : "s have"} too many Pins for one board`,
      detail: "Spacing Pins for the same board avoids self-competition on a single day.",
      actions: [
        { kind: "review", label: "Check schedule", run: handlers.reviewSchedule, explanation: "Review the crowded days and spread them out." },
        { kind: "explain", label: "Explain", explanation: "Posting many Pins to one board on one day can suppress their individual reach." },
      ],
    });
  }

  // Every batch card is a real, data-driven finding → shown proactively.
  return out.map((f) => ({ proactive: true, ...f }));
}
