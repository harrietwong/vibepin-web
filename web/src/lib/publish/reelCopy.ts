/**
 * reelCopy.ts — what title an Instagram Reel publish sends (Fable ruling 2, design
 * 0924 §3).
 *
 * Instagram has no title field: the provider joins `title` and `caption` into one
 * caption body (official.ts). For a split-off Instagram child
 * (`copyProfile === "instagram_caption"`) the `description` already IS the full
 * caption and `title` only holds its first line (so the status / confirmation checks
 * see a non-empty title) — sending it would print that first line twice, and an
 * empty one would surface the receipt's "Untitled content" fallback. So such a draft
 * sends NO title.
 *
 * Both Reel paths — the cron (v76InstagramReelsDue.ts) and "publish now"
 * (/api/publish/social) — call this ONE function. `copyProfile` must come from the
 * owner's stored draft row, never from the request body, and it is deliberately NOT
 * part of the confirmation fingerprint (adding a key would invalidate every frozen
 * receipt).
 */
export function reelPostTitle(copyProfile: unknown, title: string | null | undefined): string | undefined {
  if (copyProfile === "instagram_caption") return undefined;
  return title || undefined;
}
