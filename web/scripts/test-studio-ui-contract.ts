// @ts-expect-error Node's strip-types runner needs the explicit extension; the app
// bundler resolves the same production module extensionlessly.
import { canEnterCardEdit, mediaAspectResetKey, resolveMediaAspectRatio, shouldShowStudioMetadataField, studioCardPresentation } from "../src/lib/studio/studioCardPresentation.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Studio UI contract failed: ${message}`);
}

for (const lifecycle of ["unscheduled", "scheduled", "failed", "needs_attention"] as const) {
  const view = studioCardPresentation(lifecycle);
  assert(view.fieldsVisible && view.fieldsEditable && !view.readOnly, `${lifecycle} is editable by default`);
  assert(view.metadataFields.includes("altText"), `${lifecycle} exposes alt text`);
  assert(shouldShowStudioMetadataField(lifecycle, "altText"), `${lifecycle} renders alt text through production field policy`);
  assert(canEnterCardEdit(lifecycle), `${lifecycle} can enter edit`);
}
const posted = studioCardPresentation("posted");
assert(posted.fieldsVisible && !posted.fieldsEditable && posted.readOnly, "posted is read-only");
assert(!canEnterCardEdit("posted"), "posted cannot enter edit even when stale active");
const generating = studioCardPresentation("generating");
assert(generating.fieldsVisible && !generating.fieldsEditable, "generating fields remain visible but disabled");
assert(studioCardPresentation("posted").metadataFields.includes("altText"), "posted exposes alt text read-only");
assert(shouldShowStudioMetadataField("posted", "altText"), "posted renders alt text through production field policy");

assert(resolveMediaAspectRatio(1920, 1080) === "1920 / 1080", "known media ratio is preserved");
assert(resolveMediaAspectRatio() === "auto", "unknown media ratio is neutral");
assert(resolveMediaAspectRatio(0, 0) === "auto", "invalid media ratio is neutral");
assert(mediaAspectResetKey("media-1", "one.mp4", 1920, 1080) === mediaAspectResetKey("media-1", "one.mp4", 1920, 1080), "unrelated draft updates preserve ratio key");
assert(mediaAspectResetKey("media-1", "one.mp4", 1920, 1080) !== mediaAspectResetKey("media-2", "one.mp4", 1920, 1080), "media id change resets ratio key");
assert(mediaAspectResetKey("media-1", "one.mp4") !== mediaAspectResetKey("media-1", "two.mp4"), "media URL replacement resets unknown ratio key");
assert(mediaAspectResetKey("media-1", "one.mp4", 1920, 1080) !== mediaAspectResetKey("media-1", "one.mp4", 1080, 1080), "declared dimension change resets ratio key");

console.log("Studio UI contract: PASS");
