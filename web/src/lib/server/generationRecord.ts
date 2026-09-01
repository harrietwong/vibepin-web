/**
 * generationRecord.ts — SERVER-SIDE `pin_generations` instrumentation.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS
 * ═══════════════════════════════════════════════════════════════════════════════
 * `pin_generations` is the ONLY table six admin surfaces read to know that a
 * generation happened at all (adminActionCenter, adminActivationFunnel,
 * adminAiAdoption, adminOverview, customer360, generationLogs). Production has
 * had FOUR rows in it since 2026-06-14, and every one of them is from the retired
 * composer.
 *
 * Measured root cause (not inferred):
 *   * The only writer in the repo is the CLIENT one in `lib/studioPersistence.ts`
 *     (`createRunningSessionInDb` / `updateSessionInDb` / `insertGenerationToDb`),
 *     called from `app/app/studio/page.tsx::handleGenerate`.
 *   * `studio/page.tsx` early-returns `<StudioBoard/>` whenever the experience is
 *     `board-v2`, so `handleGenerate` and its button are never rendered. The flag
 *     compiles to a RUNTIME `process.env.NEXT_PUBLIC_STUDIO_BOARD_V2` lookup which
 *     is `undefined` in the browser, and the resolver's fallback returns
 *     `"board-v2"` — so production is board-v2 unconditionally, regardless of what
 *     Vercel is configured with.
 *   * `StudioBoard`'s generation path (`generateAiVersions.ts` → `/api/generate`)
 *     touches `pin_generations` in ZERO places (whole-repo scan by table name).
 *
 * So the fix belongs on the SERVER, at `/api/generate` — the one chokepoint every
 * generation path flows through. Writing from the client is what failed silently in
 * the first place (`catch {}` around a PGRST204), and the current production path is
 * an async worker job whose outcome the client may never stay around to report.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * HARD BOUNDARY — instrumentation MUST NOT change generation behaviour
 * ═══════════════════════════════════════════════════════════════════════════════
 *   - Every function here is total: it NEVER throws, for any input, ever. Callers
 *     may `await` it without wrapping (they wrap anyway, belt and braces).
 *   - A write failure can never turn a successful generation into a failure, never
 *     mask a provider error, and never add meaningful latency.
 *   - Every function returns a discriminated result so a caller (and the tests) can
 *     tell "recorded" from "not recorded" WITHOUT an exception. Silent success on a
 *     failed write is exactly the defect this module is repairing.
 *   - NEVER persist tokens, Authorization headers, or raw third-party responses.
 *     Failure rows carry only a stable code plus a sanitized, length-capped message
 *     (sanitizeErrorMessage, reused from publishEvents.ts — same contract).
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * ONLY WRITE WHAT WE ACTUALLY KNOW
 * ═══════════════════════════════════════════════════════════════════════════════
 * A field the route cannot observe is OMITTED from the insert, never defaulted to a
 * plausible-looking value. The admin surfaces treat these columns as facts; a
 * fabricated `total_pins` or an invented `category` would be worse than a null,
 * because a null is visibly missing and a fabrication is not. `buildGenerationRow`
 * is pure and exported precisely so this rule is unit-testable.
 *
 * `source` is `"board"` (or `"board_worker"`) — deliberately NOT `"studio"`. The old
 * composer's rows say `studio`, and the admin console must be able to tell the two
 * lineages apart. Do not "unify" these values.
 */

import type { createServerClient } from "@/lib/supabase";
import { sanitizeErrorMessage, MAX_ERROR_MESSAGE_LENGTH } from "./publishEvents";

export { MAX_ERROR_MESSAGE_LENGTH };

/**
 * Terminal statuses this module writes, plus the non-terminal `running` the worker
 * enqueue path records. Mirrors `lib/status/pinStatuses.ts::GenerationStatus`, but is
 * declared locally: that module is client-lineage and importing it here would drag UI
 * code into a server module for a six-member string union.
 */
export type GenerationRecordStatus =
  | "running"
  | "completed"
  | "partial"
  | "failed";

/**
 * Where the generation was dispatched from. Distinguishes the new StudioBoard
 * lineage from the retired composer's `studio` rows, AND distinguishes the async
 * worker enqueue (whose outcome this route never observes) from the inline run
 * (whose outcome it does).
 */
export type GenerationRecordSource = "board" | "board_worker";

/** Facts a caller can supply. Everything optional is omitted when absent. */
export interface GenerationRecordInput {
  /** auth.users id. REQUIRED — the column is NOT NULL and every consumer groups by it. */
  userId: string;
  /** The route's generationRequestId. Written to BOTH session_id and generation_request_id. */
  generationRequestId: string;
  status: GenerationRecordStatus;
  source: GenerationRecordSource;

  /** Pinterest search phrase driving the generation. */
  keyword?: string | null;
  /** Creative-direction category, as sent on the wire. */
  category?: string | null;
  /** Images actually produced. Omitted when unknown (e.g. the async worker path). */
  totalPins?: number | null;
  /** Images requested (post-clamp). */
  expectedTotal?: number | null;
  /** Reference image URLs fed to the provider. */
  refUrls?: string[] | null;
  /** Flat list of produced image URLs. */
  pinUrls?: string[] | null;
  /** Count of product images supplied. */
  productCount?: number | null;
  /** Stable failure code (`error_type` on the wire, e.g. "quota_exceeded"). */
  errorType?: string | null;
  /** Raw failure detail — sanitized + capped before it is stored. */
  errorMessage?: unknown;
  /** The assembled prompt. Stored truncated as prompt_excerpt (never in full here). */
  promptExcerpt?: string | null;
}

/**
 * Outcome of an attempted write. `recorded: false` is a normal, expected value — it
 * is how a caller learns the instrumentation degraded without an exception being
 * thrown at it. `reason` is for logs and tests only; nothing branches on it.
 */
export type GenerationRecordResult =
  | { recorded: true }
  | { recorded: false; reason: "no_client" | "no_user" | "insert_error" | "threw" };

/** Cap on the stored prompt preview. Matches the old composer's ~120-char excerpt. */
export const MAX_PROMPT_EXCERPT_LENGTH = 300;

/**
 * The insert payload. Keys are only present when the corresponding fact is KNOWN —
 * see "ONLY WRITE WHAT WE ACTUALLY KNOW" above. Values are the narrow set of JSON
 * types the v17/v52 columns accept.
 */
export type GenerationRow = Record<string, string | number | string[] | null>;

/** Trim to a string, or undefined when there is nothing meaningful to store. */
function text(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/** A finite, non-negative integer, or undefined. Never coerces NaN/Infinity to 0. */
function count(value: number | null | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const n = Math.floor(value);
  return n >= 0 ? n : undefined;
}

/** A non-empty array of non-empty strings, or undefined. */
function urls(value: string[] | null | undefined): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const cleaned = value.filter((u): u is string => typeof u === "string" && u.trim().length > 0);
  return cleaned.length ? cleaned : undefined;
}

/**
 * Build the `pin_generations` row for one generation. PURE — no DB, no clock, no
 * randomness — so the omission rule above can be asserted directly in tests.
 *
 * Returns null when the row would be unattributable (`userId` or
 * `generationRequestId` missing): a row with no owner is invisible to every consumer
 * (they all group by user_id) and would only add noise, and `user_id` is NOT NULL so
 * the insert would be rejected anyway. Refusing to build it is the honest outcome.
 *
 * `created_at` is deliberately NOT set — the column defaults to now() in Postgres,
 * and the activation funnel orders on it, so the DB's clock is the right authority.
 */
export function buildGenerationRow(input: GenerationRecordInput): GenerationRow | null {
  const userId = text(input.userId);
  const requestId = text(input.generationRequestId);
  if (!userId || !requestId) return null;

  const row: GenerationRow = {
    user_id: userId,
    // Both columns carry the same value on purpose: `session_id` is what the
    // generation-logs UI shows as the source id and what the old composer keyed on,
    // and `generation_request_id` (v52) is the EXACT join key drafts persist as
    // payload.sourceGenerationId for the AI-adoption report.
    session_id: requestId,
    generation_request_id: requestId,
    status: input.status,
    source: input.source,
  };

  const keyword = text(input.keyword);
  if (keyword !== undefined) row.keyword = keyword;

  const category = text(input.category);
  if (category !== undefined) row.category = category;

  const totalPins = count(input.totalPins);
  if (totalPins !== undefined) row.total_pins = totalPins;

  const expectedTotal = count(input.expectedTotal);
  if (expectedTotal !== undefined) row.expected_total = expectedTotal;

  const productCount = count(input.productCount);
  if (productCount !== undefined) row.product_count = productCount;

  const refList = urls(input.refUrls);
  if (refList !== undefined) {
    row.ref_urls = refList;
    // ref_count is DERIVED from the list we are actually storing, so the two can
    // never disagree. When no refs are known, neither field is written.
    row.ref_count = refList.length;
  }

  const pinList = urls(input.pinUrls);
  if (pinList !== undefined) row.pin_urls = pinList;

  const errorType = text(input.errorType);
  if (errorType !== undefined) row.error_type = errorType;

  // Sanitize FIRST, then let sanitizeErrorMessage's own cap apply — it redacts
  // credential-shaped substrings and truncates to MAX_ERROR_MESSAGE_LENGTH. Trimming
  // before redacting could cut a token in half and leave the fragment unmatched.
  if (input.errorMessage !== undefined && input.errorMessage !== null) {
    const message = sanitizeErrorMessage(input.errorMessage);
    if (message) row.error_message = message;
  }

  const prompt = text(input.promptExcerpt);
  if (prompt !== undefined) {
    row.prompt_excerpt = prompt.length > MAX_PROMPT_EXCERPT_LENGTH
      ? prompt.slice(0, MAX_PROMPT_EXCERPT_LENGTH - 1) + "…"
      : prompt;
  }

  return row;
}

type ServerClient = ReturnType<typeof createServerClient>;

/**
 * Minimal structural type of what this module needs from the client. Declared
 * structurally (rather than requiring the concrete Supabase client) so tests can pass
 * an in-memory double without casting through `any`.
 */
export interface GenerationRecordDb {
  from(table: string): {
    insert(row: GenerationRow): Promise<{ error: { message?: string } | null }> | { error: { message?: string } | null };
    // Optional: only finalizeGenerationRecord (below) calls .update(). recordGeneration's
    // insert-only test doubles remain valid GenerationRecordDb implementations without it.
    update?(patch: GenerationRow): GenerationRecordUpdateBuilder;
  };
}

/**
 * The fluent chain `finalizeGenerationRecord` needs from `.update(...)`: two `.eq()`
 * filters (row identity + the CAS guard on current `status`), then `.select()` so the
 * response reports how many rows actually matched — Supabase/PostgREST apply filters
 * BEFORE the write, so this is a real conditional UPDATE, not a read-then-write race.
 */
export interface GenerationRecordUpdateBuilder {
  eq(column: string, value: string): GenerationRecordUpdateBuilder;
  select(columns: string): Promise<{ data: unknown[] | null; error: { message?: string } | null }>;
}

/**
 * Insert ONE `pin_generations` row. BEST-EFFORT and TOTAL: it never throws, for any
 * input or any client, and reports what happened through its return value instead.
 *
 * `db` is the SERVICE-ROLE client (createServerClient). RLS on this table only admits
 * `auth.uid() = user_id` inserts, which a route acting on a bearer/cookie session
 * cannot satisfy — the service role is what makes a server-side write possible at all.
 * Pass null when a client could not be constructed; the call degrades to
 * `{recorded:false, reason:"no_client"}` rather than blowing up the request.
 */
export async function recordGeneration(
  db: GenerationRecordDb | ServerClient | null | undefined,
  input: GenerationRecordInput,
): Promise<GenerationRecordResult> {
  try {
    if (!db) {
      console.warn("[generationRecord] no service client — dropped generation row");
      return { recorded: false, reason: "no_client" };
    }
    const row = buildGenerationRow(input);
    if (!row) {
      console.warn("[generationRecord] missing userId/generationRequestId — dropped generation row");
      return { recorded: false, reason: "no_user" };
    }
    const result = await (db as GenerationRecordDb).from("pin_generations").insert(row);
    const error = result?.error ?? null;
    if (error) {
      console.warn("[generationRecord] insert failed:", error.message ?? "unknown");
      return { recorded: false, reason: "insert_error" };
    }
    return { recorded: true };
  } catch (err) {
    // The whole point of the module: an instrumentation problem must never escape
    // onto the generation path as an exception.
    console.warn("[generationRecord] insert threw:", err instanceof Error ? err.message : String(err));
    return { recorded: false, reason: "threw" };
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * finalizeGenerationRecord — close out the `running` row the worker enqueue path
 * writes, once GET /api/generation-jobs/[id] observes a TERMINAL generation_jobs
 * status.
 * ═══════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS: `recordRunningWorkerGeneration` (in /api/generate) writes
 * status='running' at enqueue time because that route hands the job to the VPS
 * worker and returns immediately — it never learns the outcome. The poll route is
 * the one place server-side that DOES: generation_jobs.status reaches a terminal
 * value (done / partial / failed per migrate_v51_generation_jobs.sql and
 * api/app/worker.py::terminal_status) exactly there, on the same row the poll
 * already fetched. This function is that missing update.
 *
 * TERMINAL STATUS MAPPING (source: migrate_v51_generation_jobs.sql comment block +
 * api/app/worker.py::terminal_status — done = every slot succeeded, partial = some
 * did, failed = none did):
 *   done              → pin_generations.status = 'completed'
 *   partial            → pin_generations.status = 'partial'
 *   failed             → pin_generations.status = 'failed' + error_type/error_message
 * `queued` / `running` are NOT terminal — callers must not invoke this for them
 * (the CAS guard below would simply no-op, but the caller should not pay the
 * round trip).
 *
 * IDEMPOTENT AND NON-REGRESSING BY CONSTRUCTION: the UPDATE is filtered on
 * `generation_request_id = <id> AND status = 'running'`, exactly like the
 * worker's own claim CAS. A job polled 50 times only matches the FIRST finalize —
 * every later call's filter matches zero rows (the row is no longer 'running') and
 * is a harmless no-op. This also makes a stale/out-of-order terminal read
 * impossible to regress an already-finalized row back toward 'running': the only
 * status this function ever WRITES is a terminal one, and it only ever writes it
 * onto a row that is still 'running'.
 *
 * ONLY WRITE WHAT WE ACTUALLY KNOW — same rule as buildGenerationRow. `totalPins`
 * / `pinUrls` are supplied by the caller from the job's own `results` array (real
 * produced-image data), never invented here.
 *
 * BEST-EFFORT and TOTAL: never throws, for any input or client. A finalize failure
 * must never turn a successful poll response into a failed one — the caller
 * (GET .../[id]) must not await this on the response's critical path in a way that
 * could reject it.
 */
export type GenerationFinalizeStatus = "completed" | "partial" | "failed";

export interface GenerationFinalizeInput {
  /** Matches the `generation_request_id` a running row was written under. */
  generationRequestId: string;
  status: GenerationFinalizeStatus;
  /** Images actually produced, from the job's own results — omitted when unknown. */
  totalPins?: number | null;
  /** Produced image URLs, from the job's own results — omitted when unknown. */
  pinUrls?: string[] | null;
  /** Stable failure code. Only meaningful (and only written) when status='failed'. */
  errorType?: string | null;
  /** Raw failure detail — sanitized + capped before storage, same as recordGeneration. */
  errorMessage?: unknown;
}

export type GenerationFinalizeResult =
  | { finalized: true }
  | {
      finalized: false;
      reason: "no_client" | "no_request_id" | "update_error" | "threw" | "no_match";
    };

/**
 * Build the terminal-state PATCH. PURE — no DB — so the "only known facts, never
 * fabricated" rule is directly assertable, same pattern as buildGenerationRow.
 */
export function buildGenerationFinalizePatch(input: GenerationFinalizeInput): GenerationRow {
  const patch: GenerationRow = { status: input.status };

  const totalPins = count(input.totalPins);
  if (totalPins !== undefined) patch.total_pins = totalPins;

  const pinList = urls(input.pinUrls);
  if (pinList !== undefined) patch.pin_urls = pinList;

  // error_type/error_message are only meaningful for a failed job, but the guard is
  // "was a value actually supplied", not "is status failed" — a caller that knows an
  // error code for a partial job should not have it silently dropped.
  const errorType = text(input.errorType);
  if (errorType !== undefined) patch.error_type = errorType;

  if (input.errorMessage !== undefined && input.errorMessage !== null) {
    const message = sanitizeErrorMessage(input.errorMessage);
    if (message) patch.error_message = message;
  }

  return patch;
}

export async function finalizeGenerationRecord(
  db: GenerationRecordDb | ServerClient | null | undefined,
  input: GenerationFinalizeInput,
): Promise<GenerationFinalizeResult> {
  try {
    if (!db) {
      console.warn("[generationRecord] finalize: no service client — dropped update");
      return { finalized: false, reason: "no_client" };
    }
    const requestId = text(input.generationRequestId);
    if (!requestId) {
      console.warn("[generationRecord] finalize: missing generationRequestId — dropped update");
      return { finalized: false, reason: "no_request_id" };
    }

    const patch = buildGenerationFinalizePatch({ ...input, generationRequestId: requestId });

    const table = (db as GenerationRecordDb).from("pin_generations");
    if (!table.update) {
      console.warn("[generationRecord] finalize: client has no update() — dropped update");
      return { finalized: false, reason: "no_client" };
    }
    // CAS guard: only a row still 'running' is eligible. This is what makes repeated
    // polls of the same finished job idempotent and prevents a delayed/duplicate
    // finalize call from ever moving an already-terminal row backward.
    const result = await table
      .update(patch)
      .eq("generation_request_id", requestId)
      .eq("status", "running")
      .select("id");

    const error = result?.error ?? null;
    if (error) {
      console.warn("[generationRecord] finalize: update failed:", error.message ?? "unknown");
      return { finalized: false, reason: "update_error" };
    }
    const matched = Array.isArray(result?.data) ? result.data.length : 0;
    if (matched === 0) {
      // Not an error: either already finalized (idempotent replay) or no running row
      // exists for this request id (e.g. the insert itself degraded). Either way
      // there is nothing more to do.
      return { finalized: false, reason: "no_match" };
    }
    return { finalized: true };
  } catch (err) {
    console.warn("[generationRecord] finalize threw:", err instanceof Error ? err.message : String(err));
    return { finalized: false, reason: "threw" };
  }
}
