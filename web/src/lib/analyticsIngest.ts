/**
 * analyticsIngest.ts — pure, dependency-free normalization for POST /api/analytics/events.
 *
 * Extracted from the route so batch validation + payload truncation unit-test without
 * a running server or Supabase client (scripts/test-analytics-ingest.ts). The route is
 * thin orchestration: auth → normalizeAnalyticsEvents → insert. Best-effort by design —
 * malformed items are dropped, never fatal.
 */

/** Hard cap on events accepted per request (client buffers under this). */
export const MAX_EVENTS_PER_BATCH = 20;
/** Serialized-payload cap; larger props are replaced with a truncation marker. */
export const MAX_PAYLOAD_BYTES = 4 * 1024;
export const MAX_EVENT_NAME_LEN = 120;
export const MAX_DRAFT_ID_LEN = 200;

export interface RawAnalyticsEvent {
  event?:   unknown;
  payload?: unknown;
  props?:   unknown;   // client `track(event, props)` shape — accepted as an alias for payload
  draftId?: unknown;
  ts?:      unknown;
}

/** A validated row ready for insert (workspace_id/user_id are added by the route). */
export interface AnalyticsEventRow {
  event_name: string;
  payload:    Record<string, unknown> | null;
  draft_id:   string | null;
}

function byteLength(value: unknown): number {
  try {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(JSON.stringify(value ?? null)).length;
  } catch { /* fall through */ }
  // Node fallback without TextEncoder.
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
}

/** Coerce an item's payload into a bounded plain object (or null). */
function normalizePayload(raw: RawAnalyticsEvent): Record<string, unknown> | null {
  const src = raw.payload ?? raw.props;
  if (!src || typeof src !== "object" || Array.isArray(src)) return null;
  const obj = src as Record<string, unknown>;
  if (Object.keys(obj).length === 0) return null;
  if (byteLength(obj) > MAX_PAYLOAD_BYTES) {
    return { _truncated: true, _bytes: byteLength(obj) };
  }
  return obj;
}

/**
 * Accepts either a bare array or `{ events: [...] }`. Returns at most
 * MAX_EVENTS_PER_BATCH validated rows; items without a usable event name are dropped.
 */
export function normalizeAnalyticsEvents(input: unknown): AnalyticsEventRow[] {
  const list: unknown[] = Array.isArray(input)
    ? input
    : (input && typeof input === "object" && Array.isArray((input as { events?: unknown }).events)
        ? (input as { events: unknown[] }).events
        : []);

  const rows: AnalyticsEventRow[] = [];
  for (const item of list.slice(0, MAX_EVENTS_PER_BATCH)) {
    if (!item || typeof item !== "object") continue;
    const raw = item as RawAnalyticsEvent;
    const name = typeof raw.event === "string" ? raw.event.trim() : "";
    if (!name || name.length > MAX_EVENT_NAME_LEN) continue;
    const draftId = typeof raw.draftId === "string" && raw.draftId && raw.draftId.length <= MAX_DRAFT_ID_LEN
      ? raw.draftId
      : null;
    rows.push({ event_name: name, payload: normalizePayload(raw), draft_id: draftId });
  }
  return rows;
}
