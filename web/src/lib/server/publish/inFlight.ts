/** A publish attempt older than this is treated as abandoned. */
export const STALE_AFTER_MS = 10 * 60 * 1000;

export function isAttemptLive(createdAt: string, nowMs = Date.now()): boolean {
  const startedMs = Date.parse(createdAt);
  // The row exists and says it is publishing. A malformed timestamp should not
  // invite the merchant to publish again while the first attempt may be live.
  if (!Number.isFinite(startedMs)) return true;
  return nowMs - startedMs <= STALE_AFTER_MS;
}
