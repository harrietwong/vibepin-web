/**
 * Upload flows prefill a new draft's title with the file name (extension stripped,
 * capped at 100 chars) and put the same text in the first upload media's altText.
 * That title is a placeholder, not the user's copy: AI Copy must treat it as empty —
 * neither send it to the model as the user's title nor refuse to overwrite it.
 *
 * Detection is exact: the first media item came from an upload and the title still
 * equals its altText-derived name. Any edit to the title breaks the match, so a
 * user-written title is never mistaken for a placeholder.
 */

type UploadMediaLike = { source?: string | null; altText?: string | null };

export function isUploadPlaceholderTitle(
  draft: { media?: ReadonlyArray<UploadMediaLike> | null },
  title: string | null | undefined,
): boolean {
  const current = (title ?? "").trim();
  if (!current) return false;
  const first = draft.media?.[0];
  if (!first || first.source !== "upload") return false;
  const derived = (first.altText ?? "").slice(0, 100).trim();
  return derived.length > 0 && current === derived;
}

/** The title AI Copy should see: "" when it is only the upload placeholder. */
export function copyInputTitle(
  draft: { media?: ReadonlyArray<UploadMediaLike> | null },
  title: string,
): string {
  return isUploadPlaceholderTitle(draft, title) ? "" : title;
}
