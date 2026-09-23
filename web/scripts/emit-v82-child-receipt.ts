/**
 * emit-v82-child-receipt.ts — generate a REAL child receipt for the test-DB probe.
 *
 * The v82 RPC validates a receipt whose `fingerprint` must equal the SHA-256 of
 * the canonical serialization of its own identity. Hand-written JSON therefore
 * cannot pass, and reimplementing `stablePublishString` in Python would be a
 * second implementation to keep in sync — the probe would then be testing the
 * copy, not the thing production ships.
 *
 * So the receipts come from the production builders, exactly as the route calls
 * them, and are emitted as JSON for the probe to feed to Postgres verbatim.
 *
 * Usage:  npx tsx scripts/emit-v82-child-receipt.ts <outFile> <userId> <checkId>
 */
import { writeFileSync } from "node:fs";
import {
  buildDueVideoReceipt,
  buildReconcileChildVideoReceipt,
} from "../src/lib/server/publish/v76PinterestVideoBindings";
import { videoPublishSourceIdentityFingerprint } from "../src/lib/server/publish/v76PinterestVideoPublish";

const [outFile, , checkId, connArg] = process.argv.slice(2);
if (!outFile || !checkId || !connArg) {
  console.error("usage: emit-v82-child-receipt.ts <outFile> <userId> <checkId> <connectionUuid>");
  process.exit(2);
}

const DRAFT = "pd_v82_e2e_1";
// v76 requires the destination's socialConnectionId to be a real UUID naming a
// CONNECTED `social_connections` row (migrate_v76:839-849), so the probe passes
// the id of the fixture it created rather than a readable placeholder.
const CONN = connArg;
const BOARD = "board-e2e";
const DUE_AT = "2026-09-01T09:00:00.000Z";
const UPDATED_AT = "2026-09-01T08:55:00.000Z";
const DEST_KEY = `pinterest:${CONN}`;

const payload: Record<string, unknown> = {
  contentId: "content_v82_e2e_1",
  title: "E2E autumn clip",
  description: "probe content",
  altText: "clip",
  destinationUrl: "https://shop.example.com/e2e",
  imageUrl: "https://cdn.test/poster.jpg",
  media: [{
    id: "media-e2e-1", kind: "video", url: "https://cdn.test/clip.mp4",
    width: 1080, height: 1920, durationMs: 8000,
    posterUrl: "https://cdn.test/poster.jpg", source: "upload",
  }],
  boardId: BOARD,
  scheduledDestinations: [
    { provider: "pinterest", socialConnectionId: CONN, boardId: BOARD, boardName: "E2E", capturedAt: DUE_AT },
  ],
  destinationResults: [
    {
      destinationId: DEST_KEY, provider: "pinterest", socialConnectionId: CONN,
      status: "delivery_unknown", submittedAt: DUE_AT,
    },
  ],
};

const base = { draftId: DRAFT, updatedAt: UPDATED_AT, scheduledAt: DUE_AT, payload };
const parent = buildDueVideoReceipt(base);
const child = buildReconcileChildVideoReceipt({
  ...base,
  reconcileCheckId: checkId,
  parentIntentId: parent.intentId,
  destinationId: DEST_KEY,
});

writeFileSync(outFile, JSON.stringify({
  draftId: DRAFT,
  contentId: "content_v82_e2e_1",
  destinationId: DEST_KEY,
  boardId: BOARD,
  connectionId: CONN,
  scheduledAt: DUE_AT,
  parent,
  child,
  // The same fingerprint the production `confirmPrepare` passes as
  // `p_source_identity_fingerprint`, computed by the same function.
  parentSourceFingerprint: videoPublishSourceIdentityFingerprint(parent),
  childSourceFingerprint: videoPublishSourceIdentityFingerprint(child),
}, null, 2), "utf-8");

console.log(`wrote ${outFile}`);
console.log(`  parent intentId : ${parent.intentId}`);
console.log(`  child  intentId : ${child.intentId}`);
console.log(`  child  dispatch : ${JSON.stringify(child.dispatchDestinationIds)}`);
console.log(`  child  prior    : ${child.priorIntentId}`);
