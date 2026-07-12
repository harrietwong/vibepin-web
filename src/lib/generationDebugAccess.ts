export type GenerationDebugUser = {
  app_metadata?: Record<string, unknown> | null;
  user_metadata?: Record<string, unknown> | null;
} | null | undefined;

const INTERNAL_ROLES = new Set(["admin", "internal_tester", "developer"]);

export function canViewGenerationDebug(
  user: GenerationDebugUser,
  envEnabled = process.env.NEXT_PUBLIC_STUDIO_DEBUG_GENERATION === "true",
): boolean {
  if (!envEnabled || !user) return false;
  const role = String(user.app_metadata?.role ?? user.user_metadata?.role ?? "").toLowerCase();
  return INTERNAL_ROLES.has(role);
}
