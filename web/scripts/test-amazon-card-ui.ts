/**
 * T3 — server-render smoke test for the Amazon card section and risk banner.
 * (No browser here; this asserts markup, keys and wiring, not interaction.)
 *
 *  - manual mode after a blocked fetch shows the product-name / Brand / Material /
 *    Size fields and the "name required" hint; no raw i18n keys leak
 *  - the clean-link chip appears only when the suggestion differs from the pasted
 *    link (ruling 6: suggestion, never a silent replace)
 *  - 422 claim hints render against the named field
 *  - banner: hidden without an Amazon card; hidden after acknowledgement (SSR
 *    snapshot is "acknowledged", so it never flashes server-side)
 *  - PinBoardCard wiring: URL blur hook, section mount, disclosure warning, gate
 *
 * Run: npx tsx scripts/test-amazon-card-ui.ts
 */
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "anon";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

let passed = 0, failed = 0;
async function test(name: string, fn: () => unknown | Promise<unknown>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.error(`  ✗ ${name}\n    ${(error as Error).stack}`); }
}

async function main() {
  const { LocaleProvider } = await import("../src/lib/i18n/LocaleProvider");
  const { AmazonCardSection } = await import("../src/components/studio/AmazonCardSection");
  const { AmazonRiskNoticeBanner } = await import("../src/components/studio/AmazonRiskNoticeBanner");
  const src = await import("../src/lib/studio/amazonCardSource");
  const en = (await import("../src/lib/i18n/messages/en")).default as Record<string, string>;

  const pasted = "https://www.amazon.com/Stanley-Tumbler/dp/B0BSHF7WHW?tag=harriet-20&ref_=abc";
  const base = src.amazonSourceForUrl(pasted, undefined, "2026-09-24T00:00:00.000Z")!;
  const render = (el: React.ReactElement) => renderToStaticMarkup(React.createElement(LocaleProvider, null, el));
  const section = (source: typeof base, hints: Array<{ field: "brand" | "material" | "size"; value: string }> = []) => render(
    React.createElement(AmazonCardSection, {
      draftId: "d", source, fetching: false, lastFetchAt: null, claimHints: hints,
      onFetch: () => {}, onManualChange: () => {}, onUseLink: () => {},
    }),
  );
  const noRawKeys = (html: string) => {
    const leaked = html.match(/studioBoard\.amazon\.[A-Za-z_.]+|amazonRiskNotice\.[A-Za-z_.]+/g);
    assert.equal(leaked, null, `raw keys rendered: ${leaked?.join(", ")}`);
  };

  await test("every Amazon key the components reference exists in en (40 keys: 39 from T3 + studioBoard.amazon.copyRequiresV2 from c712e7f3)", () => {
    const keys = Object.keys(en).filter(k => k.startsWith("studioBoard.amazon.") || k.startsWith("amazonRiskNotice."));
    assert.equal(keys.length, 40);
    assert.ok(keys.includes("studioBoard.amazon.copyRequiresV2"), "the 40th key is the v2-required gate message");
    const files = ["src/components/studio/AmazonCardSection.tsx", "src/components/studio/AmazonRiskNoticeBanner.tsx", "src/components/studio/PinBoardCard.tsx", "src/components/pins/PinAICopyPanel.tsx"];
    const used = new Set(files.flatMap(f => readFileSync(f, "utf8").match(/"(?:studioBoard\.amazon|amazonRiskNotice)\.[A-Za-z_.]+"/g) ?? []).map(s => s.slice(1, -1)));
    for (const key of used) assert.ok(key in en, `missing en key ${key}`);
    assert.ok(used.size >= 30, `referenced ${used.size}`);
  });
  await test("manual mode (blocked fetch): fields, gate hint, reason text", () => {
    const blocked = { ...base, fetch: { status: "blocked" as const, reason: "bot_check" } };
    const html = section(blocked);
    for (const id of ["amazon-productName", "amazon-sellingPoints", "amazon-brand", "amazon-material", "amazon-size", "amazon-name-required"]) {
      assert.ok(html.includes(`data-testid="${id}"`), id);
    }
    assert.ok(html.includes('data-mode="manual"'));
    assert.ok(html.includes(en["studioBoard.amazon.manualIntro"].replace(/'/g, "&#x27;")), "generic manual intro");
    noRawKeys(html);
  });
  await test("fetched mode: title prefilled into the name box, no gate hint", () => {
    const fetched = { ...base, fetch: { status: "ok" as const }, extracted: { title: "Stanley Quencher", bullets: ["Cold 11h"] } };
    const html = section(fetched);
    assert.ok(html.includes('value="Stanley Quencher"'));
    assert.ok(!html.includes('data-testid="amazon-name-required"'));
    assert.ok(html.includes('data-mode="fetched"'));
  });
  await test("clean-link chip only when the suggestion differs from what was pasted", () => {
    assert.ok(section(base).includes('data-testid="amazon-clean-link-chip"'), "ref_ junk → chip offered");
    const already = src.amazonSourceForUrl("https://www.amazon.com/dp/B0BSHF7WHW?tag=harriet-20", undefined)!;
    assert.ok(!section(already).includes('data-testid="amazon-clean-link-chip"'), "already clean → no chip");
  });
  await test("422 claim hint names the field and value", () => {
    const html = section({ ...base, manual: { productName: "Tumbler" } }, [{ field: "brand", value: "Stanley" }]);
    assert.ok(html.includes('data-testid="amazon-claim-hint"'));
    assert.ok(html.includes("Stanley"));
  });
  await test("banner: SSR snapshot never shows it; no Amazon card → nothing", () => {
    assert.equal(render(React.createElement(AmazonRiskNoticeBanner, { hasAmazonCard: false })), "");
    assert.ok(!render(React.createElement(AmazonRiskNoticeBanner, { hasAmazonCard: true })).includes("amazon-risk-notice"));
  });
  await test("PinBoardCard wiring (source): blur recognises the link, section, disclosure warning, gate", () => {
    const card = readFileSync("src/components/studio/PinBoardCard.tsx", "utf8");
    assert.match(card, /onBlur=\{handleUrlBlur\}/);
    assert.match(card, /<AmazonCardSection/);
    assert.match(card, /data-testid="card-amazon-disclosure-missing"/);
    assert.match(card, /disabled=\{publishing \|\| !cardFieldsEditable \|\| amazonNeedsName\}/);
    // The Amazon handlers persist amazonSource only — never the user's text fields.
    const block = card.slice(card.indexOf("// ── Amazon link (T3)"), card.indexOf("// Actions flush pending edits first."));
    assert.ok(block.length > 0);
    assert.doesNotMatch(block, /onPersist\(draft\.id, \{[^}]*(title|description|destinationUrl)\s*:/, "no title/description/URL writes");
    const board = readFileSync("src/components/studio/StudioBoard.tsx", "utf8");
    assert.match(board, /<AmazonRiskNoticeBanner hasAmazonCard=/);
  });

  console.log(`\nAmazon card UI: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}
main().catch(error => { console.error(error); process.exit(1); });
