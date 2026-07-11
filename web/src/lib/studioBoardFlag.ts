/**
 * studioBoardV2 feature flag — gates the new Create Pins editable Pin‑card board.
 *
 * Resolution priority (unchanged semantics):
 *   1. NEXT_PUBLIC_STUDIO_BOARD_V2 === "true"  → board-v2
 *   2. NEXT_PUBLIC_STUDIO_BOARD_V2 === "false" → legacy
 *   3. localStorage `vp:studio_board_v2` "1"/"0" (dev/local override, client-only)
 *   4. default                                  → board-v2
 *
 * Steps 1–2 are a build-time-inlined public env var, so they resolve SYNCHRONOUSLY
 * on both the server render and the first client render — no post-mount delay, no
 * hydration mismatch, and no reason to ever render the legacy Studio first. Steps
 * 3–4 depend on localStorage and are therefore client-only; they matter only when
 * the env var is unset. The Create Pins page uses the two resolvers below to render
 * exactly one experience and never flash the wrong one.
 */

export const STUDIO_BOARD_V2_KEY = "vp:studio_board_v2";

/** The three experience states used to render exactly one Studio without a flash. */
export type StudioExperience = "resolving" | "legacy" | "board-v2";

/**
 * Env-only decision, safe during SSR and the first client render (build-time
 * inlined). Returns null when the env var is unset — i.e. the decision still needs
 * the client-only localStorage override (see resolveStudioExperienceFromClient).
 */
export function resolveStudioExperienceFromEnv(): "legacy" | "board-v2" | null {
  if (process.env.NEXT_PUBLIC_STUDIO_BOARD_V2 === "true") return "board-v2";
  if (process.env.NEXT_PUBLIC_STUDIO_BOARD_V2 === "false") return "legacy";
  return null;
}

/**
 * Client-only override, consulted ONLY when the env var is unset. Reads the
 * localStorage toggle, otherwise falls back to the default (board-v2). Safe to call
 * on the server (returns the default) but intended for a post-mount effect.
 */
export function resolveStudioExperienceFromClient(): "legacy" | "board-v2" {
  if (typeof window !== "undefined") {
    try {
      const local = window.localStorage.getItem(STUDIO_BOARD_V2_KEY);
      if (local === "1") return "board-v2";
      if (local === "0") return "legacy";
    } catch {
      /* storage unavailable */
    }
  }
  return "board-v2";
}

/** Composed boolean form (identical semantics to the two resolvers above). */
export function isStudioBoardV2Enabled(): boolean {
  const env = resolveStudioExperienceFromEnv();
  if (env) return env === "board-v2";
  return resolveStudioExperienceFromClient() === "board-v2";
}

/** Dev/local opt‑in toggle (no effect when the env flag forces it on). */
export function setStudioBoardV2(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STUDIO_BOARD_V2_KEY, enabled ? "1" : "0");
  } catch {
    /* storage unavailable */
  }
}
