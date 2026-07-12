/**
 * Redaction guard for support ticket context. Applied to every context object
 * before it's written to support_tickets.context, regardless of source.
 *
 * This is a denylist of key *names* (case/format-insensitive) that must never
 * be persisted, plus a value-shape check for things that look like tokens
 * even under an unexpected key name. It intentionally does NOT try to be a
 * full PII scrubber — only the specific secrets called out in the product
 * spec (tokens, cookies, passwords, API keys, raw payment data, OAuth secrets).
 */

const UNSAFE_KEY_PATTERNS: RegExp[] = [
  /access[_-]?token/i,
  /refresh[_-]?token/i,
  /oauth[_-]?secret/i,
  /session[_-]?token/i,
  /\bcookie/i,
  /\bpassword\b/i,
  /api[_-]?key/i,
  /\bsecret\b/i,
  /card[_-]?number/i,
  /cvv|cvc/i,
  /payment[_-]?method/i,
  /auth[_-]?header/i,
  /\bbearer\b/i,
];

// Looks like a raw secret/token value even if the key name is innocuous
// (e.g. a stray `token` field holding a long opaque string).
function looksLikeSecretValue(key: string, value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (!/token|secret|key/i.test(key)) return false;
  return value.length > 20;
}

function isUnsafeKey(key: string): boolean {
  return UNSAFE_KEY_PATTERNS.some((re) => re.test(key));
}

/** Recursively strip unsafe keys/values from a plain JSON-able object. */
export function redactContext<T>(input: T): T {
  return redactValue(input) as T;
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (isUnsafeKey(key) || looksLikeSecretValue(key, v)) continue;
      out[key] = redactValue(v);
    }
    return out;
  }
  return value;
}
