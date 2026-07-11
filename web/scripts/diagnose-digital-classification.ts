/**
 * diagnose-digital-classification.ts — READ-ONLY diagnosis of why products are
 * classified Digital in the Product Opportunity Finder. No writes. No schema change.
 *
 * Run: npx tsx scripts/diagnose-digital-classification.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { looksLikeAmazon, extractAsin } from "../src/lib/affiliate/amazon";
import { classifyDestination } from "../src/lib/assetClassification";
import { isDigitalProductType } from "../src/lib/productOpportunityCounts";

// ── env (.env.local; never printed) ───────────────────────────────────────────
const envText = readFileSync(fileURLToPath(new URL("../.env.local", import.meta.url)), "utf8");
const env: Record<string, string> = {};
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const SUPA_URL = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPA_KEY = env.SUPABASE_SERVICE_ROLE_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
if (!SUPA_URL || !SUPA_KEY) { console.error("Missing Supabase URL/key in .env.local"); process.exit(1); }

// ── CURRENT classifier rule (inlined, so this diagnosis is signature-independent) ─
const OLD_DIGITAL_SUBTYPES = new Set(["printable", "template", "digital_download", "game_asset", "map_asset", "course", "ebook", "software"]);
function oldIsDigital(p: Row): { digital: boolean; reason: string } {
  if (p.product_type === "digital_product") return { digital: true, reason: 'product_type === "digital_product"' };
  if (p.product_subtype && OLD_DIGITAL_SUBTYPES.has(p.product_subtype)) return { digital: true, reason: `product_subtype === "${p.product_subtype}"` };
  return { digital: false, reason: "no digital type/subtype" };
}

type Row = {
  id: string; product_name: string | null;
  domain: string | null; source_url: string | null; merchant: string | null; source_category: string | null;
  seed_keyword: string | null; price: number | null; currency: string | null;
  // Derived (same as the /api/products/top route's enrichRow) — NOT DB columns:
  product_type?: string | null; product_subtype?: string | null; item_type?: string | null;
};

// Reproduce the API's derivation so the diagnosis matches what the UI actually classifies.
function deriveTypes(p: Row): void {
  const c = classifyDestination({
    title: p.product_name, domain: p.domain, sourceUrl: p.source_url,
    price: p.price, currency: p.currency, category: p.seed_keyword, hasCommerceSignals: true,
  });
  p.product_type = c.product_type; p.product_subtype = c.product_subtype; p.item_type = c.item_type;
}

async function fetchAll(): Promise<Row[]> {
  const cols = "id,product_name,domain,source_url,merchant,source_category,seed_keyword,price,currency";
  const out: Row[] = []; let offset = 0; const page = 1000;
  for (;;) {
    const r = await fetch(`${SUPA_URL}/rest/v1/pin_products?select=${cols}&limit=${page}&offset=${offset}`,
      { headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` } });
    if (!r.ok) { console.error("fetch failed", r.status, (await r.text()).slice(0, 200)); process.exit(1); }
    const rows = (await r.json()) as Row[];
    out.push(...rows);
    if (rows.length < page) break;
    offset += rows.length;
  }
  return out;
}

function amazonOf(p: Row): boolean {
  return looksLikeAmazon({ productUrl: p.source_url, sourceUrl: p.source_url, domain: p.domain, merchant: p.merchant });
}

function newIsDigital(p: Row): boolean {
  return isDigitalProductType({ name: p.product_name, productType: p.product_type, productSubtype: p.product_subtype, isAmazon: amazonOf(p) });
}
function line(p: Row): string {
  const cur = oldIsDigital(p);
  const asin = extractAsin(p.source_url) ?? "-";
  const dom = (p.domain ?? "-").replace(/^www\./, "");
  return [
    `title=${JSON.stringify((p.product_name ?? "").slice(0, 60))}`,
    `amazon=${amazonOf(p)}`, `domain=${dom}`, `asin=${asin}`,
    `subtype=${p.product_subtype ?? "-"}`,
    `OLD=${cur.digital ? "DIGITAL" : "physical"}`, `NEW=${newIsDigital(p) ? "DIGITAL" : "physical"}`,
  ].join("  ");
}

async function main() {
  const all = await fetchAll();
  all.forEach(deriveTypes);
  console.log(`\nTotal pin_products fetched: ${all.length}`);
  const digital = all.filter(p => oldIsDigital(p).digital);
  const digAmazon = digital.filter(amazonOf);
  const digNon = digital.filter(p => !amazonOf(p));
  console.log(`OLD classified DIGITAL: ${digital.length}  (amazon=${digAmazon.length}, non-amazon=${digNon.length})`);

  const newDigital = all.filter(newIsDigital);
  const newDigAmazon = newDigital.filter(amazonOf);
  const amazonAll = all.filter(amazonOf);
  console.log(`NEW classified DIGITAL: ${newDigital.length}  (amazon=${newDigAmazon.length}, non-amazon=${newDigital.length - newDigAmazon.length})`);
  console.log(`NEW classified PHYSICAL: ${all.length - newDigital.length}   |  Amazon total=${amazonAll.length}, Amazon physical(new)=${amazonAll.length - newDigAmazon.length}`);
  const flippedToPhysical = digital.filter(p => !newIsDigital(p)).length;
  console.log(`Flipped DIGITAL->physical by fix: ${flippedToPhysical}`);

  const ASINS = ["B00GOVGZBC", "B0CL73VGKQ", "B0CL7BPQR"];
  console.log(`\n=== Screenshot ASIN examples ===`);
  for (const a of ASINS) {
    const hits = all.filter(p => (p.source_url ?? "").toUpperCase().includes(a) || extractAsin(p.source_url) === a);
    if (!hits.length) console.log(`  ${a}: (not found by source_url)`);
    else hits.slice(0, 2).forEach(p => console.log(`  ${a}: ${line(p)}`));
  }

  console.log(`\n=== 20 AMAZON products currently classified DIGITAL ===`);
  digAmazon.slice(0, 20).forEach((p, i) => console.log(`  ${String(i + 1).padStart(2)}. ${line(p)}`));

  console.log(`\n=== 20 NON-AMAZON products currently classified DIGITAL ===`);
  digNon.slice(0, 20).forEach((p, i) => console.log(`  ${String(i + 1).padStart(2)}. ${line(p)}`));

  // reason histogram
  const byReason: Record<string, number> = {};
  digital.forEach(p => { const r = oldIsDigital(p).reason.replace(/"[^"]*"/, '"X"'); byReason[r] = (byReason[r] ?? 0) + 1; });
  console.log(`\n=== Digital reason histogram ===`);
  Object.entries(byReason).sort((a, b) => b[1] - a[1]).forEach(([r, n]) => console.log(`  ${n}\t${r}`));
}

main().catch(e => { console.error(e); process.exit(1); });
