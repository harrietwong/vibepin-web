/**
 * Per-platform connected-account limit — the last advertised allowance that had
 * NO enforcement.
 *
 * The pricing page has always promised 1 / 1 / 2 / 3 accounts per platform
 * (free / starter / pro / business), but nothing ever counted: a free user could
 * connect unlimited accounts on all four platforms. planEntitlements.ts is the
 * single source of that number (connectedAccountsPerPlatform).
 *
 * ── WHY THIS IS A HARD CHECK, NOT A METER ──────────────────────────────────────
 * The usage ledger (images / text / posts) is a shadow ACCOUNTING overlay: it
 * records, it does not block, and a ledger outage must never cost a paying user a
 * generation. This is the opposite kind of rule. A connection is a durable
 * capability, not a consumable — letting one extra slip through does not "spend"
 * anything, it permanently exceeds the plan until someone disconnects. So it is
 * enforced inline, at the one moment a NEW row would be created, and it refuses.
 *
 * ── ONLY NEW CONNECTIONS COUNT ─────────────────────────────────────────────────
 * Reconnecting an account you already have (token refresh, re-auth, changing the
 * selected Page) is an UPDATE, never an insert, so it never consults this. Only
 * the branch that would add a row asks, which means an at-limit user can always
 * still repair an existing connection.
 *
 * ── GRANDFATHERING ────────────────────────────────────────────────────────────
 * Nothing is revoked. Accounts connected before this shipped stay connected even
 * if they exceed the new ceiling; the user simply cannot add another on that
 * platform until they are back under it. Enforcing retroactively would silently
 * break live publishing for people who did nothing wrong.
 */
import { createServerClient } from "@/lib/supabase";
import { resolvePlan } from "@/lib/server/entitlements";
import { getPlanEntitlements } from "@/lib/server/planEntitlements";

const TABLE = "social_connections";

export type ConnectionLimitVerdict =
  | { allowed: true }
  | { allowed: false; limit: number; current: number; plan: string };

/** A missing social_connections table must not block a connect attempt. */
function isMissingTable(code?: string): boolean {
  return code === "PGRST205" || code === "42P01";
}

/**
 * May `uid` add ONE MORE connection on `provider`?
 *
 * Fails OPEN on any infrastructure problem (missing table, unreachable DB,
 * unresolvable plan): an outage in the limit check must not stop a user from
 * connecting an account they are entitled to. The limit exists to hold the plan
 * ceiling, not to be a second availability dependency on the connect flow.
 */
export async function canConnectAnotherAccount(
  uid: string,
  provider: string,
  deps?: {
    resolvePlanFn?: typeof resolvePlan;
    countExisting?: (uid: string, provider: string) => Promise<number | null>;
  },
): Promise<ConnectionLimitVerdict> {
  try {
    const plan = await (deps?.resolvePlanFn ?? resolvePlan)(uid);
    const limit = getPlanEntitlements(plan).connectedAccountsPerPlatform;

    // null = unlimited by the config's own convention. No plan uses it today,
    // but honouring it here keeps the semantics consistent with the allowances.
    if (limit === null) return { allowed: true };

    const current = deps?.countExisting
      ? await deps.countExisting(uid, provider)
      : await countConnections(uid, provider);

    // null = we could not count. Fail open rather than guess.
    if (current === null) return { allowed: true };

    if (current >= limit) return { allowed: false, limit, current, plan };
    return { allowed: true };
  } catch (err) {
    console.warn(
      "[social] connection limit check unavailable, allowing:",
      err instanceof Error ? err.message : String(err),
    );
    return { allowed: true };
  }
}

/** Existing connections for one provider. null when the count is unavailable. */
async function countConnections(uid: string, provider: string): Promise<number | null> {
  const { count, error } = await createServerClient()
    .from(TABLE)
    .select("id", { count: "exact", head: true })
    .eq("user_id", uid)
    .eq("provider", provider);

  if (error) {
    if (!isMissingTable(error.code)) {
      console.error("[social] count connections:", error.message);
    }
    return null;
  }
  return count ?? null;
}

/**
 * Thrown by the connection stores when a NEW connection would exceed the plan.
 * A distinct type so callers map it to a plan-limit response instead of the
 * generic "could not be saved" 500 — the user needs to know they hit a ceiling
 * they can act on, not that something broke.
 */
export class ConnectionLimitError extends Error {
  readonly verdict: Extract<ConnectionLimitVerdict, { allowed: false }>;
  constructor(verdict: Extract<ConnectionLimitVerdict, { allowed: false }>) {
    super(
      `Connected-account limit reached: plan ${verdict.plan} allows ${verdict.limit} per platform, ` +
      `${verdict.current} already connected`,
    );
    this.name = "ConnectionLimitError";
    this.verdict = verdict;
  }
}

/** The refusal body, shaped like the other plan-limit responses. */
export function connectionLimitResponseBody(verdict: Extract<ConnectionLimitVerdict, { allowed: false }>) {
  return {
    ok: false as const,
    error_type: "connected_account_limit_reached",
    code: "connected_account_limit_reached",
    error:
      `Your plan includes ${verdict.limit} account${verdict.limit === 1 ? "" : "s"} per platform. ` +
      "Disconnect one, or upgrade to connect more.",
    limit: verdict.limit,
    current: verdict.current,
  };
}
