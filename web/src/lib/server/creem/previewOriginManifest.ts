import manifest from "../../../../config/creem-preview-origin-manifest.json";

/**
 * Audited stable Preview aliases. New aliases require an explicit manifest diff;
 * a broad *.vercel.app rule is never an acceptable checkout return contract.
 */
export const CREEM_PREVIEW_STABLE_ORIGINS: readonly string[] = manifest.stableOrigins;
