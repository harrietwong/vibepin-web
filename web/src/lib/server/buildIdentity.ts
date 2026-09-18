const FULL_COMMIT_SHA = /^[a-f0-9]{40}$/i;

type BuildIdentityEnv = { readonly [key: string]: string | undefined };

/**
 * Returns a secret-free, exact build identity for public diagnostics.
 *
 * Vercel's CLI deploys do not always populate VERCEL_GIT_COMMIT_SHA. The
 * explicit fallback is intentionally accepted only when it is a complete
 * 40-character hexadecimal commit, so a short or arbitrary value can never
 * masquerade as an exact build binding.
 */
export function resolveBuildSha(env: BuildIdentityEnv = process.env): string | null {
  for (const value of [env.VERCEL_GIT_COMMIT_SHA, env.VIBEPIN_BUILD_SHA]) {
    if (typeof value === "string" && FULL_COMMIT_SHA.test(value.trim())) return value.trim();
  }
  return null;
}
