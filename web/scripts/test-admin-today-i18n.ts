/**
 * i18n gate for the admin operator console (/admin/today + Customer 360 strip).
 * Run: npx tsx scripts/test-admin-today-i18n.ts   (from web/)
 *
 * Asserts:
 *   - every BlockerType has a label key AND a suggested-action key,
 *   - every FunnelStage has a stage-name key,
 *   - every health driver + band has a key,
 *   - every key those maps point at resolves in BOTH locales (en + zh),
 *   - every new today.* / blocker.* / funnel.* / c360.* key exists in BOTH
 *     locales with a non-empty value (adminMessages zh is typed as
 *     Record<keyof typeof en, string>, but an empty string would still slip
 *     through the type system),
 *   - placeholder tokens ({count}, {hours}, …) match between en and zh for
 *     every templated key, and adminTFmt interpolates them.
 */

import assert from "node:assert";
import { adminT, adminTFmt, type AdminLanguage, type AdminMessageKey } from "../src/lib/admin/adminMessages";
import {
  BLOCKER_LABEL_KEY,
  BLOCKER_ACTION_KEY,
  FUNNEL_STAGE_KEY,
  HEALTH_DRIVER_KEY,
  HEALTH_BAND_KEY,
} from "../src/lib/admin/adminConsoleKeys";
import type { BlockerType } from "../src/lib/server/adminActionCenter";
import { FUNNEL_STAGES } from "../src/lib/server/adminActivationFunnel";

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); console.log(`  OK ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}`); console.error(`       ${(e as Error).message}`); failed++; }
}

const LOCALES: AdminLanguage[] = ["en", "zh"];

/** A key "exists in a locale" when adminT returns a non-empty string that is not the key itself. */
function assertResolves(key: AdminMessageKey) {
  for (const lang of LOCALES) {
    const v = adminT(lang, key);
    assert.ok(typeof v === "string" && v.trim().length > 0, `key "${key}" resolves to empty in ${lang}`);
    assert.notStrictEqual(v, key, `key "${key}" is missing in ${lang} (fell through to the key itself)`);
  }
}

console.log("admin operator console i18n gate");

// ── 1. every BlockerType has a label key + an action key, both locales ───────

const ALL_BLOCKER_TYPES: BlockerType[] = [
  "publish_failure",
  "pinterest_disconnected",
  "generation_failures",
  "signup_not_connected",
  "connected_not_creating",
];

test("every BlockerType has a label key resolving in en + zh", () => {
  for (const t of ALL_BLOCKER_TYPES) {
    const key = BLOCKER_LABEL_KEY[t];
    assert.ok(key, `BlockerType "${t}" has no label key`);
    assertResolves(key);
  }
});

test("every BlockerType has a suggested-action key resolving in en + zh", () => {
  for (const t of ALL_BLOCKER_TYPES) {
    const key = BLOCKER_ACTION_KEY[t];
    assert.ok(key, `BlockerType "${t}" has no action key`);
    assertResolves(key);
  }
});

// ── 2. every FunnelStage has a name key, both locales ────────────────────────

test("every FunnelStage (from the server layer's FUNNEL_STAGES) has a name key resolving in en + zh", () => {
  assert.equal(FUNNEL_STAGES.length, 5, "expected exactly 5 funnel stages");
  for (const stage of FUNNEL_STAGES) {
    const key = FUNNEL_STAGE_KEY[stage];
    assert.ok(key, `FunnelStage "${stage}" has no name key`);
    assertResolves(key);
  }
});

// ── 3. health drivers + bands ─────────────────────────────────────────────────

test("every health driver + band has a key resolving in en + zh", () => {
  for (const key of Object.values(HEALTH_DRIVER_KEY)) assertResolves(key);
  for (const key of Object.values(HEALTH_BAND_KEY)) assertResolves(key);
});

// ── 4. every new console key exists in BOTH locales, non-empty ───────────────

const NEW_KEYS: AdminMessageKey[] = [
  "nav.today",
  "today.badge", "today.title", "today.subtitle", "today.footer",
  "today.actionCenter.title",
  "today.actionCenter.col.user", "today.actionCenter.col.blocker", "today.actionCenter.col.firstSeen",
  "today.actionCenter.col.reason", "today.actionCenter.col.suggestedAction",
  "today.actionCenter.empty.title", "today.actionCenter.empty.subtitle",
  "today.actionCenter.unavailable", "today.actionCenter.windowNote",
  "today.funnel.title", "today.funnel.cohortNote", "today.funnel.unavailable",
  "today.funnel.reached", "today.funnel.stuck", "today.funnel.splitNote",
  "today.topCreators.title", "today.topCreators.note",
  "today.aiAdoption.title", "today.aiAdoption.unavailable", "today.aiAdoption.ratio",
  "today.aiAdoption.linkSplitNote", "today.aiAdoption.methodology",
  "today.aiAdoption.trend.up", "today.aiAdoption.trend.down", "today.aiAdoption.trend.flat",
  "today.dataQuality.inferred", "today.dataQuality.exact",
  "blocker.evidence.publishFailure", "blocker.evidence.publishFailureWithCode",
  "blocker.evidence.pinterestDisconnected.disconnected", "blocker.evidence.pinterestDisconnected.needsReconnect",
  "blocker.evidence.generationFailures", "blocker.evidence.signupNotConnected",
  "blocker.evidence.connectedNotCreating",
  "c360.alerts.title", "c360.alerts.none", "c360.health.driversPrefix",
];

test("every new operator-console key resolves in en + zh (non-empty, not key-fallback)", () => {
  for (const key of NEW_KEYS) assertResolves(key);
});

// ── 5. placeholder parity + interpolation ─────────────────────────────────────

function tokensOf(s: string): string[] {
  return Array.from(s.matchAll(/\{(\w+)\}/g), m => m[1]).sort();
}

test("templated keys carry the SAME placeholder tokens in en and zh", () => {
  for (const key of NEW_KEYS) {
    const enTokens = tokensOf(adminT("en", key));
    const zhTokens = tokensOf(adminT("zh", key));
    assert.deepEqual(zhTokens, enTokens, `key "${key}" placeholder mismatch: en=[${enTokens}] zh=[${zhTokens}]`);
  }
});

test("adminTFmt interpolates every placeholder (no {token} residue) in both locales", () => {
  const vars = { count: 3, hours: 49, code: "auth_expired", exact: 12, inferred: 3, adopted: 8, completed: 20, days: 30 };
  for (const key of NEW_KEYS) {
    for (const lang of LOCALES) {
      if (tokensOf(adminT(lang, key)).length === 0) continue;
      const out = adminTFmt(lang, key, vars);
      assert.ok(!/\{\w+\}/.test(out), `key "${key}" (${lang}) left un-interpolated tokens: "${out}"`);
    }
  }
});

// ── summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
