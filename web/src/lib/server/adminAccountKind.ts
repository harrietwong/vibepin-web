// ── Account kind classification — real customer vs test vs internal ──────────
//
// The operator console must answer "how are our CUSTOMERS doing", but every
// environment's auth.users table is polluted with accounts that are not
// customers: the founders' own logins, and the e2e/seed accounts the test suites
// create. Counting those as customers quietly inflates every activation number
// and fills the blocker list with rows nobody will ever act on.
//
// This module is the single place that decision is made. It is PURE (no db, no
// next/headers, no supabase import) so both the server derivation layer and the
// tsx test scripts can call it directly — the same reason adminActionCenter.ts
// inlines its own normalizePlanKey instead of importing entitlements.ts.
//
// SECURITY: only `app_metadata` (service-role writable) and env allowlists are
// consulted. `user_metadata` is USER-EDITABLE and is NEVER read here — reading
// it would let any signed-up user relabel themselves "test" and vanish from the
// operator's blocker list, the same trust-boundary hole security(billing) closed
// for plan resolution.

export type AccountKind = "customer" | "test" | "internal";

export interface ClassifiableUser {
  email: string | null;
  app_metadata?: Record<string, unknown> | null;
}

type EnvLike = Record<string, string | undefined>;

/** Parse a comma-separated env allowlist into a lowercased email Set. */
function emailSet(raw: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const part of (raw ?? "").split(",")) {
    const v = part.trim().toLowerCase();
    if (v) out.add(v);
  }
  return out;
}

/**
 * Local-part token match for the e2e/test naming conventions this codebase
 * actually uses (`paddle-e2e-test@…`, `e2e-cockpit-a@…`).
 *
 * The boundary classes matter: a bare /test/ substring would also swallow
 * genuine customer addresses like `contest@x.com` or `attestation@x.com`, so the
 * token must be delimited by the start/end of the local part or by one of the
 * separators real addresses use (- _ . +).
 */
const TEST_TOKEN_RE = /(^|[-_.+])(e2e|test)([-_.+]|$)/i;

/** Domains reserved for automated tests (RFC 6761-style .test TLD usage here). */
const TEST_DOMAINS = new Set(["example.test"]);

/**
 * Classify one auth user. Order is deliberate and NOT interchangeable:
 *
 *   1. internal — the founders / support staff, named by the SUPER_ADMIN_EMAILS
 *      or SUPPORT_ADMIN_EMAILS allowlists. Checked FIRST so a staff address that
 *      happens to contain a "test" token is still reported as internal.
 *   2. test — flagged via trusted `app_metadata.is_test`, named in
 *      ADMIN_TEST_ACCOUNT_EMAILS, on a reserved test domain, or carrying an
 *      e2e/test token in its local part.
 *   3. customer — everything else, including users with no email at all (we
 *      never guess a real signup away).
 */
export function classifyAccount(u: ClassifiableUser, env: EnvLike = process.env): AccountKind {
  const email = typeof u.email === "string" ? u.email.trim().toLowerCase() : "";

  if (email) {
    const internal = emailSet(env.SUPER_ADMIN_EMAILS);
    for (const e of emailSet(env.SUPPORT_ADMIN_EMAILS)) internal.add(e);
    if (internal.has(email)) return "internal";
  }

  if (u.app_metadata?.["is_test"] === true) return "test";

  if (email) {
    if (emailSet(env.ADMIN_TEST_ACCOUNT_EMAILS).has(email)) return "test";
    const at = email.lastIndexOf("@");
    const local = at === -1 ? email : email.slice(0, at);
    const domain = at === -1 ? "" : email.slice(at + 1);
    if (domain && TEST_DOMAINS.has(domain)) return "test";
    if (TEST_TOKEN_RE.test(local)) return "test";
  }

  return "customer";
}

/** Convenience: is this kind hidden from the default (customers-only) views? */
export function isNonCustomer(kind: AccountKind): boolean {
  return kind !== "customer";
}

/** Running tally of excluded users, returned by every cockpit derivation. */
export interface ExcludedCounts {
  test: number;
  internal: number;
}

export function emptyExcluded(): ExcludedCounts {
  return { test: 0, internal: 0 };
}
