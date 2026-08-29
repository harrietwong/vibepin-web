/**
 * limitReached.ts — the ONE client-side parser for the three usage-limit refusals.
 *
 * The server has three separate meters (images / text / scheduled posts) whose 402
 * bodies are shaped by three separate modules, and they do NOT agree on which field
 * carries the prose:
 *
 *   ai_image_limit_reached       → `error`        (meterGeneration.aiImageLimitResponseBody)
 *   ai_text_limit_reached        → `userMessage`  (meterTextGeneration.aiTextLimitResponseBody)
 *   scheduled_post_limit_reached → `error`        (meterScheduledPost.scheduledPostLimitResponseBody)
 *
 * Rather than teach every call site those three shapes, each client seam calls this
 * once and branches on `kind`. Keeping the shape knowledge in one file is what makes
 * "the server added a field" a one-line change instead of a hunt.
 *
 * ── WHY `message` IS A FALLBACK, NOT THE THING WE RENDER ──────────────────────────
 * The strings the server ships are NOT the strings the PRD specifies for the UI
 * (PRD v3.2 §4.3 / §6.4 give different, friendlier sentences). The UI renders the
 * PRD text from the i18n catalog, keyed off `kind`. `message` is carried only as a
 * last-resort fallback for a surface that has no catalog entry — never preferred over
 * the localized copy.
 *
 * ── EXACT-CODE MATCHING IS LOAD-BEARING ──────────────────────────────────────────
 * `connected_account_limit_reached` (lib/server/social/connectionLimit.ts) is a
 * DIFFERENT refusal with its own UI and must not be captured here. So this matches
 * the three codes by exact equality — never by `.endsWith("limit_reached")`, which
 * would swallow it.
 */

/** The three metered actions, keyed by the server code they refuse with. */
export type LimitReachedKind = "ai_image" | "ai_text" | "scheduled_post";

export type LimitReached = {
  kind: LimitReachedKind;
  /**
   * Images remaining from the recurring (plan) allowance, when the server told us.
   * `null` means "the server did not say" — NOT "zero". Callers must treat null as
   * unknown and fall back to the plain upgrade message rather than offering a
   * "generate 0 instead" adjustment.
   */
  availableRecurring: number | null;
  /** Remaining bonus//referral images, same null semantics. Passed through only. */
  availableBonus: number | null;
  /** The server's own prose, for surfaces with no catalog entry. May be "". */
  message: string;
};

const CODE_TO_KIND: Record<string, LimitReachedKind> = {
  ai_image_limit_reached: "ai_image",
  ai_text_limit_reached: "ai_text",
  scheduled_post_limit_reached: "scheduled_post",
};

/** Non-negative integer, or null for anything else (absent, null, NaN, "3", -1). */
function readCount(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  const n = Math.floor(raw);
  return n >= 0 ? n : null;
}

/**
 * Read a count that the server may spell in snake_case (the RPC payload's own
 * spelling) or camelCase (the TS outcome object's). Whichever appears first wins.
 */
function readEitherSpelling(body: Record<string, unknown>, snake: string, camel: string): number | null {
  const fromSnake = readCount(body[snake]);
  if (fromSnake !== null) return fromSnake;
  return readCount(body[camel]);
}

function readMessage(body: Record<string, unknown>): string {
  for (const key of ["userMessage", "error", "message"]) {
    const v = body[key];
    // meterTextGeneration sets `error` to the CODE itself, not prose. A value equal
    // to a known code is machine-readable, not user-readable — skip it.
    if (typeof v === "string" && v.trim() && !(v in CODE_TO_KIND)) return v;
  }
  return "";
}

/**
 * Recognise a usage-limit refusal.
 *
 * Returns null for anything that is not one of the three limits — a success, an
 * unrelated error (including `connected_account_limit_reached`), a non-object body,
 * or a 2xx response. The status is required to be a client refusal because a 200
 * body that happens to contain the string is not a refusal; the server only ever
 * emits these with 402.
 *
 * Deliberately tolerant about WHICH 4xx: the code is the real signal, and pinning it
 * to exactly 402 would silently stop working if a proxy or a future route rewrote the
 * status. Any 4xx carrying one of the three codes is treated as that limit.
 */
export function parseLimitReached(status: number, body: unknown): LimitReached | null {
  if (!Number.isFinite(status) || status < 400 || status >= 500) return null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;

  const record = body as Record<string, unknown>;
  const rawCode = typeof record.code === "string" ? record.code
    : typeof record.error_type === "string" ? record.error_type
    : "";
  const kind = CODE_TO_KIND[rawCode];
  if (!kind) return null;

  return {
    kind,
    availableRecurring: readEitherSpelling(record, "available_recurring", "availableRecurring"),
    availableBonus: readEitherSpelling(record, "available_bonus", "availableBonus"),
    message: readMessage(record),
  };
}

/**
 * The count we can honestly offer as a one-click adjustment (product decision #6).
 *
 * R = recurring + bonus: both allowances are spendable through this path, so the
 * one-click retry must offer the combined remainder, not just the recurring slice.
 * Returns null when the server told us NEITHER number (both fields absent/unparsed) —
 * an unknown remainder must degrade to the plain upgrade message, never to a silent
 * "generate 0 instead". A server-confirmed zero (recurring 0 + bonus 0, i.e. "all
 * used") is a real, honest 0 and is returned as such — callers treat 0 as "no offer"
 * the same way they always have, but it is a known 0, not a stand-in for unknown.
 */
export function offerableRemaining(parsed: LimitReached): number | null {
  const { availableRecurring, availableBonus } = parsed;
  if (availableRecurring === null && availableBonus === null) return null;
  return (availableRecurring ?? 0) + (availableBonus ?? 0);
}

/**
 * The typed error the generation client seams throw so the run loop and the UI can
 * branch on a usage refusal instead of pattern-matching a message string.
 *
 * It carries the parsed payload verbatim: the run loop needs `kind` to stop the
 * batch, and StudioBoard needs the remaining count to decide between the one-click
 * adjustment dialog (R > 0) and the plain upgrade message (R === 0 / unknown).
 */
export class LimitReachedError extends Error {
  readonly limit: LimitReached;
  constructor(limit: LimitReached) {
    super(limit.message || `${limit.kind}_limit_reached`);
    this.name = "LimitReachedError";
    this.limit = limit;
  }
}

/** True when `err` is a usage-limit refusal (optionally of a specific kind). */
export function isLimitReachedError(err: unknown, kind?: LimitReachedKind): err is LimitReachedError {
  if (!(err instanceof LimitReachedError)) return false;
  return kind === undefined || err.limit.kind === kind;
}

/**
 * Read a fetch Response that is known to be !ok and return the limit refusal it
 * describes, or null. Never throws: a body that is not JSON is simply "not a limit".
 * Callers pass the ALREADY-PARSED body when they have one (the response body can only
 * be read once), and this overload when they do not.
 */
export async function parseLimitReachedResponse(res: Response): Promise<LimitReached | null> {
  try {
    const body: unknown = await res.clone().json();
    return parseLimitReached(res.status, body);
  } catch {
    return null;
  }
}

/** The i18n key carrying the PRD's user-facing sentence for each limit. */
export const LIMIT_MESSAGE_KEY: Record<LimitReachedKind, string> = {
  ai_image: "studioBoard.limit.image.allUsed",
  ai_text: "studioBoard.limit.text.allUsed",
  scheduled_post: "studioBoard.limit.post.allUsed",
};

/**
 * Map a publish-failure `code` to the PRD sentence for that limit, or null when the
 * code is not a usage limit.
 *
 * Publish failures reach the UI as an already-parsed { code, message } pair (the
 * response body is long gone by then), so this is the code-only entry point those
 * surfaces use instead of parseLimitReached. Keeping it here means all four call
 * sites agree on which codes count as usage limits.
 */
export function limitMessageKeyForCode(code: string | undefined | null): string | null {
  if (!code) return null;
  const kind = CODE_TO_KIND[code];
  return kind ? LIMIT_MESSAGE_KEY[kind] : null;
}
