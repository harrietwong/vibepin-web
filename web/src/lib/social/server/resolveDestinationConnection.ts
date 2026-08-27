/**
 * WHICH account a publish destination means.
 *
 * `/api/publish/social` used to answer this with
 * `accounts.find(a => a.connectionStatus === "connected")` whenever the destination
 * carried no `socialConnectionId` — i.e. "the first connected account of that
 * platform". With one connected account that is the right answer by construction.
 * With two, it is the wrong-account failure PRD 0826 §16 forbids: the post appears on
 * an account the merchant never chose, and they only find out by seeing it there.
 *
 * So the rule is the same one `resolveScheduledAccount` applies to scheduled intent:
 *
 *   1. an explicitly named account always wins — it is the merchant's own choice,
 *      and it is verified against THEIR connections by the caller (`findConnection`
 *      is user-scoped) rather than trusted from the request body;
 *   2. exactly one connected account ⇒ use it (a single-account merchant is never
 *      asked to make a choice that has only one answer);
 *   3. several connected and none named ⇒ REFUSE. Not a guess, not the first one.
 *
 * This module is deliberately free of DB access — no Supabase client is built at
 * import time — so it is unit-testable under bare `tsx`, exactly like `publishRules`.
 */

import { platformName, type SocialProvider } from "../platforms";
import type { SocialConnection } from "../types";

/**
 * What the caller should do about one destination.
 *
 * `explicit` deliberately hands back only an id: resolving it is the caller's job
 * (`findConnection`, which scopes the lookup to the publishing user), so a connection
 * id belonging to someone else can never be honoured just because it was requested.
 */
export type DestinationConnectionChoice =
  | { kind: "explicit"; connectionId: string }
  | { kind: "only"; connection: SocialConnection }
  | { kind: "none" }
  | { kind: "ambiguous"; count: number };

/** The connected accounts a summary reports for its platform. */
type SummaryLike = { accounts?: readonly SocialConnection[] } | null | undefined;

export function resolveDestinationConnection(
  summary: SummaryLike,
  destination: { socialConnectionId?: unknown },
): DestinationConnectionChoice {
  const requested = typeof destination?.socialConnectionId === "string"
    ? destination.socialConnectionId.trim()
    : "";
  if (requested) return { kind: "explicit", connectionId: requested };

  // Only accounts that can publish RIGHT NOW count. An expired or revoked row is not
  // a candidate, and it must not make a single usable account look ambiguous either.
  const connected = (summary?.accounts ?? []).filter(a => a.connectionStatus === "connected");
  if (connected.length === 0) return { kind: "none" };
  if (connected.length === 1) return { kind: "only", connection: connected[0] };
  return { kind: "ambiguous", count: connected.length };
}

/** Nothing to publish to. */
export function connectAccountMessage(provider: SocialProvider): string {
  return `Connect a ${platformName(provider)} account first.`;
}

/**
 * Several accounts to publish to and no choice made. The merchant has to pick — the
 * one thing we must not do is pick for them and post to the wrong audience.
 */
export function chooseAccountMessage(provider: SocialProvider): string {
  return `Choose which ${platformName(provider)} account to publish to.`;
}
