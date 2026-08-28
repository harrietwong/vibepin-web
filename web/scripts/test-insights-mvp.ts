import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  attachDiagnoses,
  fillDailyRange,
  summarizeDays,
  trafficRate,
} from "../src/lib/insights/businessRules";
import type { InsightsContent } from "../src/lib/insights/types";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

async function main() {
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "test-anon-key";
const { PinterestClient } = await import("../src/lib/server/pinterest/service");

await test("traffic rate uses outbound clicks divided by impressions", () => {
  assert.equal(trafficRate(25, 1_000), 0.025);
  assert.equal(trafficRate(null, 1_000), null);
  assert.equal(trafficRate(0, 0), null);
});

await test("30-day heatmap fills missing dates without fabricating unavailable metrics", () => {
  const rows = fillDailyRange([{
    date: "2026-08-02",
    views: 100,
    interactions: 9,
    saves: 3,
    shares: 0,
    websiteClicks: null,
    trafficRate: null,
  }], "2026-08-01", "2026-08-03", false);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].websiteClicks, null);
  assert.equal(rows[1].views, 100);
  assert.equal(rows[2].websiteClicks, null);
});

await test("Pinterest summary keeps clicks and computes a user-facing rate", () => {
  const summary = summarizeDays([{
    date: "2026-08-01",
    views: 200,
    interactions: 20,
    saves: 8,
    shares: 0,
    websiteClicks: 6,
    trafficRate: .03,
  }, {
    date: "2026-08-02",
    views: 300,
    interactions: 30,
    saves: 12,
    shares: 0,
    websiteClicks: 9,
    trafficRate: .03,
  }], true);
  assert.equal(summary.views, 500);
  assert.equal(summary.websiteClicks, 15);
  assert.equal(summary.trafficRate, .03);
});

await test("zero outbound clicks never receives a positive traffic diagnosis", () => {
  const content: InsightsContent[] = [{
    id: "pin-zero-clicks",
    title: "High-view Pin",
    imageUrl: null,
    postUrl: null,
    publishedAt: null,
    format: "image",
    metrics: {
      views: 500,
      interactions: 10,
      saves: 10,
      shares: 0,
      websiteClicks: 0,
      trafficRate: 0,
    },
    websiteClickAvailability: "pin_level",
    diagnosis: "",
  }];
  const diagnosed = attachDiagnoses("pinterest", content);
  // The rule returns an i18n key, not a sentence: it runs on the server, where
  // there is no locale. The page resolves it.
  assert.equal(diagnosed[0].diagnosis, "insights.diagnosis.seenButFewClicks");
  assert.notEqual(diagnosed[0].diagnosis, "insights.diagnosis.seenAndConverts");
});

await test("diagnosis never assigns Instagram profile-link taps to an image", () => {
  const content: InsightsContent[] = [{
    id: "ig-1",
    title: "Post",
    imageUrl: null,
    postUrl: null,
    publishedAt: null,
    format: "image",
    metrics: {
      views: 500,
      interactions: 40,
      saves: 12,
      shares: 5,
      websiteClicks: null,
      trafficRate: null,
    },
    websiteClickAvailability: "unavailable",
    diagnosis: "",
  }];
  const diagnosed = attachDiagnoses("instagram", content);
  assert.equal(diagnosed[0].metrics.websiteClicks, null);
  assert.equal(diagnosed[0].diagnosis, "insights.diagnosis.savedInstagram");
});

await test("Pinterest client requests account, bulk Pin analytics and Pin metadata endpoints", async () => {
  const requested: string[] = [];
  const client = PinterestClient.forTest({
    accessToken: "token",
    hooks: {
      fetchImpl: async input => {
        const url = String(input);
        requested.push(url);
        if (url.includes("/analytics/top_pins")) {
          return new Response(JSON.stringify({ pins: [{ pin_id: "123", metrics: { IMPRESSION: 10 } }] }), { status: 200 });
        }
        if (url.includes("/pins/analytics?")) {
          return new Response(JSON.stringify({
            "123": { ALL: { daily_metrics: [], summary_metrics: { IMPRESSION: 10, OUTBOUND_CLICK: 2 } } },
          }), { status: 200 });
        }
        if (url.includes("/user_account/analytics?")) {
          return new Response(JSON.stringify({ all: { daily_metrics: [], summary_metrics: {} } }), { status: 200 });
        }
        if (url.endsWith("/pins/123")) {
          return new Response(JSON.stringify({
            id: "123",
            title: "Recovered older Pin",
            media: { media_type: "image", images: { "600x": { url: "https://i.pinimg.com/older.jpg" } } },
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          items: [{
            id: "123",
            title: "A useful Pin",
            created_at: "2026-08-01T00:00:00Z",
            media: { media_type: "image", images: { "600x": { url: "https://i.pinimg.com/a.jpg" } } },
          }],
          bookmark: null,
        }), { status: 200 });
      },
    },
  });
  const metrics = ["IMPRESSION", "SAVE", "OUTBOUND_CLICK"] as const;
  await client.getOrganicAccountAnalytics("2026-08-01", "2026-08-30", [...metrics]);
  await client.getOrganicTopPins("2026-08-01", "2026-08-30", [...metrics]);
  const bulk = await client.getOrganicPinsAnalytics(["123"], "2026-08-01", "2026-08-30", [...metrics]);
  const pins = await client.listPinMetadata();
  const recovered = await client.getPinMetadata("123");
  assert.equal(pins.items[0].title, "A useful Pin");
  assert.equal(pins.items[0].imageUrl, "https://i.pinimg.com/a.jpg");
  assert.equal(recovered?.imageUrl, "https://i.pinimg.com/older.jpg");
  assert.equal(bulk["123"].ALL.summary_metrics?.OUTBOUND_CLICK, 2);
  assert(requested.some(url => url.endsWith("/pins/123")));
  assert(requested.some(url => url.includes("/pins/analytics?") && url.includes("pin_ids=123")));
  assert(requested.some(url => url.includes("source=YOUR_PINS")));
  assert(requested.some(url => url.includes("sort_by=IMPRESSION")));
});

await test("Insights stays a single simple page with honest platform language", () => {
  const page = readFileSync(join(process.cwd(), "src/app/app/insights/page.tsx"), "utf8");
  const layout = readFileSync(join(process.cwd(), "src/app/app/layout.tsx"), "utf8");
  const instagramConfig = readFileSync(join(process.cwd(), "src/lib/server/instagram/config.ts"), "utf8");
  const dashboard = readFileSync(join(process.cwd(), "src/lib/server/insights/dashboard.ts"), "utf8");
  const provenance = readFileSync(join(process.cwd(), "src/lib/server/insights/publishProvenance.ts"), "utf8");
  // The page renders through the i18n catalog now, so the honest-language
  // wording lives in en/insights.ts rather than as JSX literals.
  const catalog = readFileSync(join(process.cwd(), "src/lib/i18n/messages/en/insights.ts"), "utf8");
  assert.match(layout, /href: "\/app\/insights"/);
  assert.match(catalog, /Last 30 days/);
  assert.match(catalog, /Went to website/);
  assert.match(catalog, /Not available for feed images/);
  assert.match(page, /freshAccessToken/);
  assert.match(page, /Authorization: `Bearer \$\{token\}`/);
  // The page used to hydrate thumbnails through /api/insights/pinterest-pins, and
  // this file used to assert that it did. Both the route and the caller are gone:
  // the thumbnail is collected into content_registry, and the page makes no
  // Pinterest call in any state (see test-insights-read.ts for the fetch spies).
  assert.doesNotMatch(page, /`\/api\/insights\/pinterest-pins/);
  assert.doesNotMatch(page, /"\/api\/insights\/pinterest-pins/);
  assert.match(dashboard, /DASHBOARD_LOAD_TIMEOUT_MS = 20_000/);
  // The read path no longer constructs a Pinterest client at all — not per Pin, not
  // in a bounded fallback. `forConnection` remains the only accessor the COLLECTOR
  // may use (a user-scoped client would read whichever account is "active", so a
  // two-account user would see one account's numbers under the other's header), and
  // that assertion now lives against collector.ts rather than the dashboard.
  assert.doesNotMatch(dashboard, /getOrganicPinAnalytics/);
  assert.doesNotMatch(dashboard, /PinterestClient\.forConnection\(/);
  assert.doesNotMatch(dashboard, /forUser\(/);
  const collector = readFileSync(join(process.cwd(), "src/lib/server/insights/collector.ts"), "utf8");
  assert.match(collector, /PinterestClient\.forConnection\(/);
  assert.doesNotMatch(collector, /forUser\(/);
  assert.match(dashboard, /listVibePinPublishedPinterestPins/);
  assert.match(provenance, /payload\.remotePinId/);
  assert.match(provenance, /if \(!pinId\) return null/);
  assert.match(catalog, /All \{count\} Pins verified from VibePin publish records/);
  assert.doesNotMatch(page, /Overview[\s\S]*Pins[\s\S]*Analytics[\s\S]*Boards[\s\S]*Audience/);
  assert.match(instagramConfig, /instagram_business_manage_insights/);
});

await test("All-accounts view shows accounts side by side and never sums them", () => {
  const page = readFileSync(join(process.cwd(), "src/app/app/insights/page.tsx"), "utf8");
  const catalog = readFileSync(join(process.cwd(), "src/lib/i18n/messages/en/insights.ts"), "utf8");
  // One request per account rather than one aggregate request: two accounts that
  // serve different audiences have no meaningful combined number, and a summed
  // "12K seen" would hide which brand actually earned it.
  assert.match(page, /ALL_ACCOUNTS = "__all__"/);
  assert.match(page, /accountCards/);
  // Each account owns its own loading and failure state, so one bad token
  // cannot blank the page for the accounts that are fine.
  assert.match(page, /insights\.state\.accountFailed/);
  // The merged table tags each row with its owner instead of collapsing rows.
  assert.match(page, /accountLabel: accountHandle\(account\)/);
  assert.match(catalog, /"insights\.content\.colAccount"/);
  assert.match(catalog, /"insights\.accounts\.all"/);
});

await test("Pin metadata is collected with the owning account, never fetched by the page", () => {
  const collector = readFileSync(join(process.cwd(), "src/lib/server/insights/collector.ts"), "utf8");
  const store = readFileSync(join(process.cwd(), "src/lib/server/insights/collectorStore.ts"), "utf8");

  // A Pin is only readable with its own account's token; a user-scoped client would
  // 404 every Pin of the non-default account and silently drop its thumbnail. That
  // constraint did not go away — it moved to the collector, which is now the only
  // thing that reads Pin metadata at all.
  assert.match(collector, /PinterestClient\.forConnection\(userId, connectionId\)/);
  assert.doesNotMatch(collector, /forUser\(/);

  // The image is captured while listing and stored, so the page never asks for one.
  assert.match(collector, /imageUrl: item\.imageUrl/);
  assert.match(store, /image_url: entry\.imageUrl \?\? prior\?\.imageUrl \?\? null/);
});

await test("Insights attributes each Pin to the account that published it", () => {
  const provenance = readFileSync(join(process.cwd(), "src/lib/server/insights/publishProvenance.ts"), "utf8");
  const dashboard = readFileSync(join(process.cwd(), "src/lib/server/insights/dashboard.ts"), "utf8");
  assert.match(provenance, /nonEmptyString\(payload\.targetConnectionId\)/);
  // Fan-out records win over the legacy root field; see publishProvenance.ts.
  assert.match(provenance, /parseDestinationResults\(payload\.destinationResults\)/);
  // Attribution precedence: the draft's own recorded target, then the v64 content
  // registry (the account whose token listed the Pin owns it). With neither, the
  // answer is "unknown" — NOT "visible on every account", which is what it used to
  // be and which put the same Pin on both cards of a two-account user, with metrics
  // on one and blanks on the other.
  //
  // The rule itself lives in the pure read layer so it can be exercised directly
  // (see test-insights-read.ts); dashboard.ts still supplies the cross-account
  // registry lookup it depends on, which is the half that needs a database.
  const collectionRead = readFileSync(join(process.cwd(), "src/lib/insights/collectionDashboard.ts"), "utf8");
  assert.match(collectionRead, /export function attributePin\(/);
  assert.match(collectionRead, /return "unknown";/);
  assert.match(dashboard, /ownerConnectionsForPins\(/);
});

await test("server-side Insights strings are not hardcoded Chinese", () => {
  const dashboard = readFileSync(join(process.cwd(), "src/lib/server/insights/dashboard.ts"), "utf8");
  const rules = readFileSync(join(process.cwd(), "src/lib/insights/businessRules.ts"), "utf8");
  const catalog = readFileSync(join(process.cwd(), "src/lib/i18n/messages/en/insights.ts"), "utf8");
  const page = readFileSync(join(process.cwd(), "src/app/app/insights/page.tsx"), "utf8");
  // Both run on the server with no locale, so neither may carry user-facing text in
  // one hardcoded language. dashboard.ts uses plain English; businessRules.ts
  // returns i18n keys, which the page resolves.
  assert.doesNotMatch(dashboard, /[一-鿿]/);
  assert.doesNotMatch(rules, /[一-鿿]/);
  assert.match(rules, /"insights\.diagnosis\.seenButFewClicks"/);
  assert.match(page, /tr\(item\.diagnosis\)/);
  // Every branch of the rule needs a key, or the page renders the key itself.
  for (const key of ["efficientButSmallReach", "seenButFewClicks", "seenAndConverts",
    "savedInstagram", "savedPinterest", "tooEarly", "noData", "awaitingMetrics"]) {
    assert.match(rules, new RegExp(`"insights\.diagnosis\.${key}"`), `rule key ${key}`);
    assert.match(catalog, new RegExp(`"insights\.diagnosis\.${key}":`), `catalog key ${key}`);
  }
});


console.log(`\n${passed} Insights MVP tests passed.`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
