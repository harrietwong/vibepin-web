/**
 * Per-platform connected-account limit for Facebook / Instagram — a thin adapter
 * over the ONE allowance rule in `accountAllowance.ts`.
 *
 * The pricing page promises 1 / 1 / 2 / 3 accounts per platform (free / starter /
 * pro / business); `planEntitlements.ts` is the single source of that number
 * (connectedAccountsPerPlatform), and a user may hold MORE than it by buying extra
 * account slots (a shared, any-platform pool). Both halves of that rule live in
 * accountAllowance.ts so Pinterest and Facebook/Instagram cannot drift apart —
 * this file only keeps the verdict/error shapes its callers already speak.
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
 * ── EVERY ROW HELD COUNTS ──────────────────────────────────────────────────────
 * A slot is occupied by every account row the user holds, connected or not. That is
 * the product rule, not an implementation detail (PRD 0805 §11): Disconnect keeps
 * the account — it stays in Settings with a Reconnect — and keeps its slot; REMOVE
 * hard-deletes the row and is the only action that gives the slot back.
 *
 * This is not the old ratchet returning. Back then a disconnect left a row nobody
 * could see or delete, so the seat was lost forever; now the row is visible on every
 * platform and Remove frees it. The counting rule and the Remove action are two
 * halves of one decision — see accountAllowance.ts.
 *
 * ── GRANDFATHERING ────────────────────────────────────────────────────────────
 * Nothing is revoked. Accounts connected before this shipped stay connected even
 * if they exceed the ceiling — including after an add-on subscription is canceled;
 * the user simply cannot add another until they are back under it. Enforcing
 * retroactively would silently break live publishing for people who did nothing
 * wrong.
 */
import { resolvePlan } from "@/lib/server/entitlements";
import { evaluateAccountAllowance } from "./accountAllowance";

export type ConnectionLimitVerdict =
  | { allowed: true }
  | { allowed: false; limit: number; current: number; plan: string };

/**
 * May `uid` add ONE MORE connection on `provider`?
 *
 * Fails OPEN on any infrastructure problem (missing table, unreachable DB,
 * unresolvable plan): an outage in the limit check must not stop a user from
 * connecting an account they are entitled to. The limit exists to hold the plan
 * ceiling, not to be a second availability dependency on the connect flow.
 *
 * `deps` is the legacy injection shape (a plan resolver and a per-provider count).
 * It is preserved because the callers and tests speak it; both are translated into
 * the allowance module's own injection points, so an injected count never reaches
 * the database.
 */
export async function canConnectAnotherAccount(
  uid: string,
  provider: string,
  deps?: {
    resolvePlanFn?: typeof resolvePlan;
    countExisting?: (uid: string, provider: string) => Promise<number | null>;
  },
): Promise<ConnectionLimitVerdict> {
  const countExisting = deps?.countExisting;
  const allowance = await evaluateAccountAllowance(uid, provider, {
    resolvePlanFn: deps?.resolvePlanFn,
    // A caller that supplies its own count knows about ONE provider. Feed exactly
    // that (null = uncountable → fail open) instead of touching the DB.
    countConnections: countExisting
      ? async (id: string) => {
          const count = await countExisting(id, provider);
          return count === null ? null : { [provider]: count };
        }
      : undefined,
  });

  if (allowance.allowed) return { allowed: true };
  return {
    allowed: false,
    // `limit` is what the PLAN includes per platform; purchased slots (already
    // accounted for in `allowed`) are not folded in, so the refusal keeps naming
    // the plan's own number.
    limit: allowance.included ?? 0,
    current: allowance.held,
    plan: allowance.plan,
  };
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
