/**
 * Pure decision logic for which extra OAuth scopes `/api/auth/instagram/connect`
 * requests, extracted out of the route so it can be unit tested directly (route
 * files may only export handlers/config).
 *
 * Two ways the comment-DM scopes get appended:
 *   1. `?features=comment_dm` — an explicit opt-in, only honoured for a super admin
 *      starting their OWN connect (unchanged from before this file existed).
 *   2. `reconnect=<connectionId>` WITHOUT `features=comment_dm` — an ordinary
 *      "Reconnect" click (e.g. from Settings) aimed at a connection that ALREADY
 *      has the comment-DM scopes. Without this, reconnecting through the generic
 *      Settings button re-requests only the 2 base scopes, Instagram's callback
 *      overwrites `scopes` with that narrower grant, and comment→DM automation
 *      silently stops working on a row that used to have permission. This case is
 *      also gated to super admins (mirrors case 1) and additionally requires that
 *      the reconnect target is a row owned by THIS uid that already satisfies
 *      `hasInstagramCommentDmScopes` — so an ordinary reconnect on a connection
 *      that never had the extra scopes still gets exactly the base scopes.
 */

import { hasInstagramCommentDmScopes, INSTAGRAM_COMMENT_DM_SCOPES } from "./config";

export type ExtraScopesReason =
  | "feature_honored"
  | "reconnect_preserved"
  | "not_requested"
  | "not_super_admin"
  | "id_mismatch"
  | "target_missing_or_foreign"
  | "target_lacks_scopes"
  | "check_threw";

export type ExtraScopesResult = {
  scopes: readonly string[];
  reason: ExtraScopesReason;
};

/** The subset of a social_connections row this decision needs. */
export type OwnedConnectionScopes = { user_id: string; scopes: unknown };

export type ExtraScopesDeps = {
  /** Resolves to the super admin's own uid, or null if the requester isn't one. */
  superAdminId: () => Promise<string | null>;
  /**
   * Reads the reconnect target, already filtered to this uid's own instagram rows
   * (e.g. getOwnInstagramConnection). Returns null for a missing/foreign id.
   */
  ownConnection: (uid: string, connectionId: string) => Promise<OwnedConnectionScopes | null>;
};

export type ExtraScopesInput = {
  uid: string;
  features: readonly string[];
  reconnectId: string | null;
};

/**
 * Decide which extra scopes (if any) to append to the authorize URL. Never
 * throws: any failure in the injected deps degrades to no extra scopes (fail
 * closed — the pre-existing behaviour for the features=comment_dm case).
 */
export async function decideExtraScopes(
  input: ExtraScopesInput,
  deps: ExtraScopesDeps,
): Promise<ExtraScopesResult> {
  const featureRequested = input.features.includes("comment_dm");

  if (featureRequested) {
    try {
      const adminId = await deps.superAdminId();
      if (adminId && adminId === input.uid) {
        return { scopes: INSTAGRAM_COMMENT_DM_SCOPES, reason: "feature_honored" };
      }
      return { scopes: [], reason: adminId ? "id_mismatch" : "not_super_admin" };
    } catch {
      return { scopes: [], reason: "check_threw" };
    }
  }

  if (!input.reconnectId) {
    return { scopes: [], reason: "not_requested" };
  }

  // Reconnect without features=comment_dm: only preserve the grant for a super
  // admin reconnecting their OWN row that already has it. Check admin status
  // FIRST so an ordinary user's reconnect never triggers the extra DB read.
  try {
    const adminId = await deps.superAdminId();
    if (!adminId || adminId !== input.uid) {
      return { scopes: [], reason: adminId ? "id_mismatch" : "not_super_admin" };
    }
    const target = await deps.ownConnection(input.uid, input.reconnectId);
    if (!target || target.user_id !== input.uid) {
      return { scopes: [], reason: "target_missing_or_foreign" };
    }
    if (!hasInstagramCommentDmScopes(Array.isArray(target.scopes) ? (target.scopes as string[]) : null)) {
      return { scopes: [], reason: "target_lacks_scopes" };
    }
    return { scopes: INSTAGRAM_COMMENT_DM_SCOPES, reason: "reconnect_preserved" };
  } catch {
    return { scopes: [], reason: "check_threw" };
  }
}
