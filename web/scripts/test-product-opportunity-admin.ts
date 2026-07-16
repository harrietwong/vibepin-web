import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildFreshnessStatusFromInputs } from "../src/lib/server/productOpportunityAdminStatus";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  OK ${name}`);
}

// NOTE: the admin console moved from /app/admin (inside the customer /app shell)
// to a standalone internal console at /admin (src/app/admin/page.tsx +
// src/app/admin/layout.tsx). src/app/app/admin/page.tsx is now just a
// `redirect("/admin")` stub — the real super-admin guard and dashboard moved
// with it, so this test now points at the real locations.
const ADMIN_PAGE_SRC = readFileSync(
  fileURLToPath(new URL("../src/app/admin/page.tsx", import.meta.url)),
  "utf8",
);
const ADMIN_LAYOUT_SRC = readFileSync(
  fileURLToPath(new URL("../src/app/admin/layout.tsx", import.meta.url)),
  "utf8",
);
const ADMIN_API_SRC = readFileSync(
  fileURLToPath(new URL("../src/app/api/admin/product-opportunities/status/route.ts", import.meta.url)),
  "utf8",
);
const ADMIN_ME_SRC = readFileSync(
  fileURLToPath(new URL("../src/app/api/admin/me/route.ts", import.meta.url)),
  "utf8",
);
const GUARD_SRC = readFileSync(
  fileURLToPath(new URL("../src/lib/server/superAdmin.ts", import.meta.url)),
  "utf8",
);

test("admin page is server-protected before loading overview data", () => {
  assert.ok(ADMIN_PAGE_SRC.includes("getCurrentSuperAdmin"), "admin page must check super admin session");
  assert.ok(ADMIN_PAGE_SRC.includes('redirect("/app?admin=forbidden")'), "non-admin page access should redirect safely");
  const bodyStart = ADMIN_PAGE_SRC.indexOf("export default async function AdminHomePage");
  assert.ok(
    ADMIN_PAGE_SRC.indexOf("getCurrentSuperAdmin", bodyStart) < ADMIN_PAGE_SRC.indexOf("getAdminOverview", bodyStart),
    "guard must run before overview data load",
  );
});

test("admin console shell (layout) also gates on super admin before rendering", () => {
  assert.ok(ADMIN_LAYOUT_SRC.includes("getCurrentSuperAdmin"), "admin layout must check super admin session");
  assert.ok(ADMIN_LAYOUT_SRC.includes('redirect("/app?admin=forbidden")'), "non-admin layout access should redirect safely");
});

test("admin API returns 403 to non-admin callers", () => {
  assert.ok(ADMIN_API_SRC.includes("requireSuperAdminFromRequest"), "admin API must use server auth guard");
  assert.ok(ADMIN_API_SRC.includes("status: 403"), "admin API must return 403 when forbidden");
  assert.ok(ADMIN_ME_SRC.includes("status: 403"), "admin nav probe must return 403 when forbidden");
});

test("super admin access supports role or env allowlist without hardcoded emails", () => {
  assert.ok(GUARD_SRC.includes('role === "super_admin"'), "super_admin role should grant access");
  assert.ok(GUARD_SRC.includes("SUPER_ADMIN_EMAILS"), "env allowlist should grant access");
  assert.ok(!/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(GUARD_SRC), "guard must not hardcode email addresses");
});

test("product data can be fresh while score freshness is stale", () => {
  const now = new Date().toISOString();
  const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  const status = buildFreshnessStatusFromInputs({
    productData: {
      latestCreatedAt: now,
      latestScrapedAt: now,
      rowsCreatedLast24h: 59,
      rowsCreatedLast48h: 59,
      rowsCreatedLast5d: 254,
      totalRows: 1000,
    },
    scoreData: {
      latestScoredAt: fiveDaysAgo,
      scoresUpdatedLast24h: 0,
      scoresUpdatedLast48h: 0,
      scoresUpdatedLast5d: 0,
      totalRows: 900,
    },
    latestSuccessfulDailyRun: {
      job_type: "daily",
      status: "completed",
      finished_at: fiveDaysAgo,
      metadata: { deprecated: true, rows_processed: 0 },
    },
    latestFailedDailyRun: null,
    latestAttemptedScoreRun: {
      job_type: "stl-score",
      status: "running",
      started_at: fiveDaysAgo,
      created_at: fiveDaysAgo,
    },
  });

  assert.equal(status.productDataFreshness.status, "fresh");
  assert.equal(status.scoreFreshness.status, "stale");
  assert.equal(status.pipelineSummary.scoreRunStatus, "running");
  assert.equal(status.pipelineSummary.scoreRunStillMarkedRunning, true);
  assert.equal(status.pipelineSummary.legacyDailyDeprecated, true);
  assert.equal(status.pipelineSummary.legacyDailyZeroYield, true);
});

test("5-day-old product_scores.scored_at maps to Stale", () => {
  const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  const status = buildFreshnessStatusFromInputs({
    productData: {
      latestCreatedAt: null,
      latestScrapedAt: null,
      rowsCreatedLast24h: 0,
      rowsCreatedLast48h: 0,
      rowsCreatedLast5d: 0,
      totalRows: 0,
    },
    scoreData: {
      latestScoredAt: fiveDaysAgo,
      scoresUpdatedLast24h: 0,
      scoresUpdatedLast48h: 0,
      scoresUpdatedLast5d: 0,
      totalRows: 1,
    },
  });
  assert.equal(status.scoreFreshness.status, "stale");
});

test("fresh pin_products.created_at/scraped_at maps to Fresh", () => {
  const now = new Date().toISOString();
  const status = buildFreshnessStatusFromInputs({
    productData: {
      latestCreatedAt: now,
      latestScrapedAt: now,
      rowsCreatedLast24h: 1,
      rowsCreatedLast48h: 1,
      rowsCreatedLast5d: 1,
      totalRows: 1,
    },
    scoreData: {
      latestScoredAt: null,
      scoresUpdatedLast24h: 0,
      scoresUpdatedLast48h: 0,
      scoresUpdatedLast5d: 0,
      totalRows: 0,
    },
  });
  assert.equal(status.productDataFreshness.status, "fresh");
});

console.log(`\n${passed} passed`);
