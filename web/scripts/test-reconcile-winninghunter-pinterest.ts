import assert from "node:assert/strict";

import { reconcile } from "./reconcile-winninghunter-pinterest";

const EXPECTED_USER_ID = "4cf569cd-1f20-404d-93d7-1e2c0b8a7251";
const EXPECTED_CONNECTION_ID = "a273f91c-4589-4fce-b19c-e24f2bdf6c99";

const queue = Array.from({ length: 48 }, (_, index) => ({
  queue_rank: index + 1,
  queue_class: "ready_after_platform_gates",
  readiness: "ready_after_platform_gates",
  sha256: `${index + 1}`.padStart(64, "0"),
  platforms: {
    pinterest: {
      status: "not_scheduled",
      scheduled_at: null,
      remote_id: null,
      attempts: [],
    },
  },
}));

const receipt = {
  mode: "stage-apply",
  mayPublish: false,
  previewRef: "snulmwprsahzqvdbyenc",
  userId: EXPECTED_USER_ID,
  connectionId: EXPECTED_CONNECTION_ID,
  plans: queue.map((item, index) => ({
    draftId: `draft-${index + 1}`,
    sha256: item.sha256,
    idempotencyKey: `winninghunter:${item.sha256}`,
    plannedAt: `2026-09-${index < 24 ? "22" : "23"}T09:00`,
    scheduledAt: `2026-09-${index < 24 ? "22" : "23"}T13:00:00Z`,
  })),
};

const result = reconcile(receipt, { queue }, new Date("2026-09-21T22:00:00Z"));

assert.equal(result.updates.length, 48);
assert.equal(result.updatedQueue.queue[0].platforms.pinterest.status, "scheduled");
assert.equal(result.updatedQueue.queue[0].platforms.pinterest.scheduled_at, "2026-09-22T13:00:00Z");
assert.equal(result.updatedQueue.queue[0].platforms.pinterest.remote_id, null);
assert.equal(result.updatedQueue.queue[0].platforms.pinterest.attempts, 0);
assert.equal(result.receipt.user_id, EXPECTED_USER_ID);
assert.equal(result.receipt.connection_id, EXPECTED_CONNECTION_ID);
assert.equal(result.receipt.items[0].draft_id, "draft-1");

assert.throws(
  () => reconcile({ ...receipt, connectionId: "wrong-connection" }, { queue }),
  /unexpected_connection_id/,
);
assert.throws(
  () => reconcile({ ...receipt, mayPublish: true }, { queue }),
  /receipt_may_publish/,
);

console.log("reconcile-winninghunter-pinterest: ok");
