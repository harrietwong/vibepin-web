/** Preview Supabase single-object limit; keep this below provider rejection (413). */
export const MAX_VIDEO_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_VIDEO_UPLOAD_ITEMS = 20;
export const MIN_VIDEO_DURATION_MS = 4_000;
export const MAX_VIDEO_DURATION_MS = 5 * 60_000;
export const VIDEO_FINALIZE_CLAIM_MS = 2 * 60_000;
/** Supabase signed-upload capabilities are fixed at two hours by the provider. */
export const VIDEO_SIGNED_UPLOAD_CAPABILITY_MS = 2 * 60 * 60_000;
/** First cleanup observation after the signed capability expires. */
export const VIDEO_UPLOAD_SETTLE_GRACE_MS = 5 * 60_000;
/** Maximum time allowed for one 50 MiB browser-to-Storage request. */
export const VIDEO_UPLOAD_MAX_IN_FLIGHT_MS = 15 * 60_000;
/** Final Storage visibility/deletion check after the last permitted in-flight request. */
export const VIDEO_UPLOAD_LATE_COMMIT_VISIBILITY_MS = 5 * 60_000;
export const VIDEO_UPLOAD_LEDGER_MS = VIDEO_SIGNED_UPLOAD_CAPABILITY_MS
  + VIDEO_UPLOAD_MAX_IN_FLIGHT_MS + VIDEO_UPLOAD_LATE_COMMIT_VISIBILITY_MS;
