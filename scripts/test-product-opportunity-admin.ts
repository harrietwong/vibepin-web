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

const ADMIN_PAGE_SRC = readFileSync(
  fileURLToPath(new URL("../src/app/app/admin/page.tsx", import.meta.url)),
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
const LAYOUT_SRC = readFileSync(
  fileURLToPath(new URL("../src/app/app/layout.tsx", import.meta.url)),
  "utf8",
);
const GUARD_SRC = readFileSync(
  fileURLToPath(new URL("../src/lib/server/superAdmin.ts", import.meta.url)),
  "utf8",
);

test("admin page is server-protected before loading status data", () => {
  assert.ok(ADMIN_PAGE_SRC.includes("getCurrentSuperAdmin"), "admin page must check super admin session");
  assert.ok(ADMIN_PAGE_SRC.includes('redirect("/app?admin=forbidden")'), "non-admin page access should redirect safely");
  const bodyStart = ADMIN_PAGE_SRC.indexOf("export default async function AdminPage");
  assert.ok(
    ADMIN_PAGE_SRC.indexOf("getCurrentSuperAdmin", bodyStart) < ADMIN_PAGE_SRC.indexOf("getProductOpportunityAdminStatus", bodyStart),
    "guard must run before status load",
  );
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

test("sidebar Admin item is only shown after server-backed super admin probe", () => {
  assert.ok(LAYOUT_SRC.includes('href: "/app/admin"'), "sidebar should define Admin route");
  assert.ok(LAYOUT_SRC.includes("superAdminOnly: true"), "Admin nav item must be super-admin-only");
  assert.ok(LAYOUT_SRC.includes('fetch("/api/admin/me"'), "sidebar should use server-backed admin probe");
});

test("admin API exposes split freshness fields without ambiguous lastUpdatedAt", () => {
  assert.ok(ADMIN_PAGE_SRC.includes("Product Data Freshness"), "dashboard should show product-data freshness");
  assert.ok(ADMIN_PAGE_SRC.includes("Score Freshness"), "dashboard should show score freshness");
  assert.ok(ADMIN_PAGE_SRC.includes("Pipeline / Scheduler Summary"), "dashboard should show pipeline summary");
  assert.ok(ADMIN_API_SRC.includes("getProductOpportunityAdminStatus"), "API should return the split status helper");
  assert.ok(!ADMIN_PAGE_SRC.includes("Pipeline status"), "dashboard should not use one ambiguous status");
  assert.ok(!ADMIN_PAGE_SRC.includes("Run crawler"), "dashboard must not include run buttons");
  assert.ok(!ADMIN_PAGE_SRC.includes("Requeue"), "dashboard must not include requeue controls");
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
