/**
 * `Retry-After` header parsing (RFC 9110 §10.2.3). A deliberate leaf module with
 * ZERO imports: `service.ts`, `videoPinAdapter.ts`, and `retryClassification.ts`
 * all need this, and `service.ts` (via `videoPinAdapter.ts`) and
 * `retryClassification.ts` (via `service.ts`'s error classes) already import each
 * other — anything with a dependency in any of those directions would close a
 * value-import cycle. See retryClassification.ts's module header for the fuller
 * story of why retry-after and retry-class are split across files at all.
 */

/**
 * Parse a `Retry-After` header value. Supports both forms:
 *   - delta-seconds: an unsigned integer, e.g. "120" (no clock needed)
 *   - HTTP-date: e.g. "Wed, 21 Oct 2026 07:28:00 GMT" (needs `now`)
 *
 * `now` is a thunk, not a value, so callers whose `now()` is an instrumented/
 * counted dependency (videoPinAdapter.ts's injected `now` in particular) are
 * never charged a call for the common case — it is invoked only in the
 * HTTP-date branch, never for delta-seconds and never when the header is
 * absent or malformed.
 *
 * Returns `undefined` for anything absent, malformed, unparseable, or
 * resolving to a non-positive delay (a date in the past is not a retry hint;
 * ignore it rather than schedule "retry immediately" as if it were meaningful).
 */
export function parseRetryAfterSeconds(headerValue: string | null | undefined, now: () => number): number | undefined {
  if (typeof headerValue !== "string") return undefined;
  const raw = headerValue.trim();
  if (!raw) return undefined;

  if (/^\d+$/.test(raw)) {
    const seconds = Number.parseInt(raw, 10);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
  }

  const parsedMs = Date.parse(raw);
  if (!Number.isFinite(parsedMs)) return undefined;
  const deltaSeconds = Math.round((parsedMs - now()) / 1000);
  return deltaSeconds > 0 ? deltaSeconds : undefined;
}
