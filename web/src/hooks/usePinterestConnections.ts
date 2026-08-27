"use client";

/**
 * usePinterestConnections — the user's usable Pinterest accounts, client side.
 *
 * Reads the SAME source the Settings panel and the publish destination rows read
 * (`/api/social/connections` via socialClient + the shared connections cache), so those
 * three surfaces can never disagree about which accounts exist. No bespoke fetch.
 *
 * Disconnected rows are filtered out here (see PUBLISHABLE_STATUSES): the shared endpoint
 * now lists them for Settings, but a dead account is not a publish target.
 *
 * Order is the server's: created_at ascending, so `fallback` (index 0) is the account
 * `pickDefaultConnection` resolves for a user-scoped call. That makes an adopt-once on the
 * client land on exactly the row the server would have used on its own — the pre-v59
 * target — instead of a second, divergent notion of "default".
 */

import { useCallback, useEffect, useState } from "react";
import { fetchSocialConnections } from "@/lib/social/socialClient";
import {
  getCachedConnections,
  setCachedConnections,
  SOCIAL_CONNECTIONS_CHANGED_EVENT,
} from "@/lib/social/connectionsCache";
import { PINTEREST_DISCONNECTED_EVENT } from "@/lib/pinterestClient";
import type { PlatformConnectionSummary, SocialConnection } from "@/lib/social/types";
import type { TargetableConnection } from "@/lib/studio/publishTarget";

/**
 * A connection row as the publish-target logic needs it.
 *
 * `username` is derived here, once, from the row's own fields — `providerAccountUsername`
 * first (the real @handle), then the display name. Deriving it in one place keeps the
 * picker, the retry guard and the stored `targetAccountLabel` snapshot showing the SAME
 * text for an account, instead of each surface inventing its own label.
 */
export type PinterestTargetConnection = SocialConnection & TargetableConnection;

function toTargetable(row: SocialConnection): PinterestTargetConnection {
  return { ...row, username: row.providerAccountUsername ?? row.providerAccountName ?? null };
}

/**
 * Statuses a publish target may be in. A WHITELIST on purpose: `/api/social/connections`
 * is the Settings listing too, so since PRD 0805 §11 it also carries the merchant’s
 * DISCONNECTED rows (kept so they can be reconnected or removed). Those must not reach
 * this hook — it feeds the account picker, the adopt-once `fallback` a Pin pins itself
 * to, and `retryBlockReason`, whose whole job is to STOP a retry whose target is no
 * longer in this list. A blacklist would let a future status leak through by default.
 */
const PUBLISHABLE_STATUSES: ReadonlySet<string> = new Set(["connected", "expired"]);

function pinterestAccountsOf(platforms: PlatformConnectionSummary[]): PinterestTargetConnection[] {
  return (platforms.find(p => p.provider === "pinterest")?.accounts ?? [])
    .filter(a => PUBLISHABLE_STATUSES.has(a.connectionStatus))
    .map(toTargetable);
}

export type UsePinterestConnections = {
  /** Every usable Pinterest account, oldest first. */
  connections: PinterestTargetConnection[];
  /** The account a Pin with no stored target adopts. Null when none are connected. */
  fallback: PinterestTargetConnection | null;
  loading: boolean;
  refresh: () => void;
};

export function usePinterestConnections(): UsePinterestConnections {
  // Paint instantly from the session cache when it's there (a second drawer in the same
  // session shouldn't blank the account row), then revalidate in the background.
  const cached = getCachedConnections();
  const [connections, setConnections] = useState<PinterestTargetConnection[]>(
    cached ? pinterestAccountsOf(cached.platforms) : [],
  );
  const [loading, setLoading] = useState(!cached);

  const load = useCallback(async () => {
    try {
      const { platforms } = await fetchSocialConnections();
      setCachedConnections(platforms);
      setConnections(pinterestAccountsOf(platforms));
    } catch {
      // A failed read is NOT evidence that accounts went away: keep whatever we last
      // knew rather than collapsing the picker (and, with it, a Pin's visible target).
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // Connect / disconnect from any surface must be reflected here immediately —
    // otherwise a just-connected second account stays invisible to the picker.
    const onChange = () => { void load(); };
    window.addEventListener(SOCIAL_CONNECTIONS_CHANGED_EVENT, onChange);
    window.addEventListener(PINTEREST_DISCONNECTED_EVENT, onChange);
    return () => {
      window.removeEventListener(SOCIAL_CONNECTIONS_CHANGED_EVENT, onChange);
      window.removeEventListener(PINTEREST_DISCONNECTED_EVENT, onChange);
    };
  }, [load]);

  return {
    connections,
    fallback: connections[0] ?? null,
    loading,
    refresh: () => { void load(); },
  };
}
