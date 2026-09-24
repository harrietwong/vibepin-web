/**
 * T3 — one-time Amazon risk notice acknowledgement (design §5, ruling 8).
 * Stored on the synced `amazon_affiliate_settings` singleton (UX preference, not a
 * consent record). Run: npx tsx scripts/test-amazon-risk-notice.ts
 */
import assert from "node:assert/strict";

const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => { mem.set(k, String(v)); },
  removeItem: (k: string) => { mem.delete(k); },
  clear: () => mem.clear(),
};
let events = 0;
(globalThis as unknown as { window: unknown }).window = {
  addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => { events++; return true; },
};

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.error(`  ✗ ${name}\n    ${(error as Error).stack}`); }
}

async function main() {
  const s = await import("../src/lib/affiliate/amazonAffiliateSettings");
  const KEY = "vp:amazon_affiliate_settings:v1";

  test("fresh account: notice not acknowledged", () => {
    mem.clear();
    assert.equal(s.hasAcknowledgedAmazonRiskNotice(), false);
  });
  test("acknowledge → persisted with version + time, updatedAt bumped, change event emitted", () => {
    mem.clear(); events = 0;
    s.saveAmazonAffiliateSettings({ marketplace: "US", trackingId: "me-20", enabled: true });
    s.acknowledgeAmazonRiskNotice("2026-09-24T10:00:00.000Z");
    const stored = JSON.parse(mem.get(KEY)!);
    assert.equal(stored.riskNoticeAckVersion, s.AMAZON_RISK_NOTICE_VERSION);
    assert.equal(stored.riskNoticeAckAt, "2026-09-24T10:00:00.000Z");
    assert.equal(stored.updatedAt, "2026-09-24T10:00:00.000Z");
    assert.equal(stored.trackingId, "me-20", "merge-write keeps the tag");
    assert.ok(events >= 2);
    assert.equal(s.hasAcknowledgedAmazonRiskNotice(), true);
  });
  test("saving the Settings form afterwards keeps the acknowledgement", () => {
    s.saveAmazonAffiliateSettings({ marketplace: "UK", trackingId: "me-21", enabled: true });
    const loaded = s.getAmazonAffiliateSettings();
    assert.equal(loaded.trackingId, "me-21");
    assert.equal(loaded.riskNoticeAckVersion, s.AMAZON_RISK_NOTICE_VERSION);
    assert.equal(s.hasAcknowledgedAmazonRiskNotice(), true);
  });
  test("an older acknowledged version shows the notice again", () => {
    assert.equal(s.hasAcknowledgedAmazonRiskNotice({ marketplace: "US", trackingId: "", enabled: true, riskNoticeAckVersion: 0 }), false);
  });
  test("sync adapter carries the ack; a staler server doc cannot un-acknowledge", () => {
    const local = s.amazonAffiliateSettingsSyncAdapter.getAll();
    assert.equal((local[0].doc as { riskNoticeAckVersion?: number }).riskNoticeAckVersion, s.AMAZON_RISK_NOTICE_VERSION);
    s.amazonAffiliateSettingsSyncAdapter.mergeServer(
      [{ id: "settings", updatedAt: "2020-01-01T00:00:00.000Z", doc: { marketplace: "US", trackingId: "old", enabled: true, updatedAt: "2020-01-01T00:00:00.000Z" } }] as never,
      [] as never,
    );
    assert.equal(s.hasAcknowledgedAmazonRiskNotice(), true);
  });

  console.log(`\nAmazon risk notice: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}
main().catch(error => { console.error(error); process.exit(1); });
