export type GenerationDebugUser = {
  app_metadata?: Record<string, unknown> | null;
  user_metadata?: Record<string, unknown> | null;
} | null | undefined;

const INTERNAL_ROLES = new Set(["admin", "internal_tester", "developer"]);

/**
 * SECURITY — the role is read ONLY from `app_metadata` (service-role writable).
 *
 * `user_metadata` is user-writable (`supabase.auth.updateUser({ data: { role } })`),
 * so trusting it here let any signed-in user grant themselves an internal debug
 * role and read the full internal prompt. Do not add it back. Mirrors the same
 * fix in src/lib/server/superAdmin.ts and the earlier `security(billing)` removal
 * of `user_metadata.plan` from entitlement resolution.
 */
export function canViewGenerationDebug(
  user: GenerationDebugUser,
  envEnabled = process.env.NEXT_PUBLIC_STUDIO_DEBUG_GENERATION === "true",
): boolean {
  if (!envEnabled || !user) return false;
  const role = String(user.app_metadata?.role ?? "").toLowerCase();
  return INTERNAL_ROLES.has(role);
}
