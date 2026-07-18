/**
 * escalationCore.ts — pure, network/DB-free helpers shared by escalation.ts.
 * Split out (matching the metricsCore.ts convention) so unit tests can
 * import this without pulling in db.ts's top-level Supabase client
 * construction, which throws outside a Next.js runtime unless env vars are
 * already loaded.
 */

const DEFAULT_ESCALATION_REASON = "user_requested_human";

/**
 * Blank/whitespace-only/missing reasons fall back to "user_requested_human"
 * (the PRD's own default for the manual escalate path — see §5.2/§10).
 */
export function resolveEscalationReason(reason?: string | null): string {
  const trimmed = (reason ?? "").trim();
  return trimmed || DEFAULT_ESCALATION_REASON;
}
