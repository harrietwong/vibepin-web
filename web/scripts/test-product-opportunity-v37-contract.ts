import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildPrefillFromProductOpportunity } from "../src/lib/createPinsPrefill";

const root = path.resolve(process.cwd());
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

const page = read("src/app/app/products/page.tsx");
const component = read("src/components/products/ProductOpportunitiesV1.tsx");
const client = read("src/lib/productOpportunitiesClient.ts");
const prefill = read("src/lib/createPinsPrefill.ts");
const server = read("src/lib/server/productOpportunities.ts");
const listApi = read("src/app/api/product-opportunities/route.ts");
const detailApi = read("src/app/api/product-opportunities/[id]/route.ts");
const savedApi = read("src/app/api/saved-product-opportunities/route.ts");
const legacyPickerApi = read("src/app/api/products/top/route.ts");
const legacyProductIntelligenceApi = read("src/app/api/product/[id]/intelligence/route.ts");
const analytics = read("src/lib/analytics.ts");
const metricControls = read("src/lib/server/productOpportunityMetricControls.ts");

assert.match(page, /ProductOpportunitiesV1/, "Product page must use the stable v3.7 catalog");
assert.doesNotMatch(page + component, /assetStore|saveProductToLibrary/, "Save must not write to the Create Pins asset library");
assert.match(component, /setProductOpportunitySaved/, "Save must use the Saved Products relation");
assert.match(component, /buildPrefillFromProductOpportunity/, "Create Pin must keep the dedicated handoff");
assert.match(component, /openCreatePinsWithDraft/, "Create Pin must persist its handoff before navigation");
assert.match(component, /freshAccessToken/, "Persistent Create Pin handoff must use the authenticated draft route");
assert.match(prefill, /never create or remove a Saved Products record/, "Create Pin and Save boundary must be explicit");
const nullNameHandoff = buildPrefillFromProductOpportunity({
  id: "opportunity-1",
  productName: null,
  productImageUrl: "https://merchant.example/images/item.jpg",
  productUrl: "https://merchant.example/products/item",
  domain: "merchant.example",
  category: "womens-fashion",
});
assert.equal(nullNameHandoff.opportunity, undefined, "A reviewed category must not be fabricated into an opportunity title or keyword");
assert.equal(nullNameHandoff.productImages?.[0]?.title, undefined, "A missing Product Name must remain absent in Create Pins");
assert.equal(nullNameHandoff.productImages?.[0]?.imageUrl, "https://merchant.example/images/item.jpg", "Create Pins must keep the merchant product image");
assert.equal(nullNameHandoff.productImages?.[0]?.productUrl, "https://merchant.example/products/item", "Create Pins must keep the merchant PDP");
assert.equal(nullNameHandoff.productImages?.[0]?.category, "Women's Fashion", "Create Pins must not expose an internal category slug");
const namedHandoff = buildPrefillFromProductOpportunity({
  id: "opportunity-2",
  productName: "  Linen dress  ",
  productImageUrl: "https://merchant.example/images/dress.jpg",
  productUrl: "https://merchant.example/products/dress",
  domain: "merchant.example",
  category: "fashion",
});
assert.equal(namedHandoff.productImages?.[0]?.title, "Linen dress", "A proven Product Name must survive exactly after boundary whitespace cleanup");
assert.match(prefill, /const nestedDraft = draft\.draft/, "Studio must accept the composer draft API response envelope");
assert.match(prefill, /draft_id=.*prefillKey=/, "Create Pin must keep a one-shot fallback beside the persistent draft id");
assert.match(component, /\/app\/products\/saved/, "Saved Products must have a return entry");
assert.match(component, /Free includes 10 complete Product Opportunities/, "Free limit must be explained as ten complete records");
assert.match(component, /Based on Pinterest saves gained in the last 30 days/, "G30 explanation must be user-facing and specific");
assert.match(component, /Current 7 days/, "The detail modal must show the current G7 fact when valid");
assert.match(component, /Previous 7 days/, "The detail modal must show the previous G7 fact when valid");
assert.match(component, /Last updated/, "The detail modal must show the observation timestamp when available");
assert.match(component, /Product Pin on Pinterest/, "Product Pin evidence must be labeled honestly");
assert.match(component, /Source Pin on Pinterest/, "Source Pin evidence must not be mislabeled as a Product Pin");
assert.match(component, /More Pinterest references/, "The detail modal must expose additional Pinterest references");
const cardPinterestLink = component.indexOf(">Pinterest <ExternalLink");
const cardProductLink = component.indexOf(">View Product <ExternalLink");
assert.ok(cardPinterestLink >= 0 && cardProductLink > cardPinterestLink, "Cards must put Pinterest evidence before the merchant product link");
const modalPrimaryEvidence = component.indexOf("item.pinterestEvidenceType === \"product_pin\"");
const modalAdditionalEvidence = component.indexOf("item.additionalPinterestEvidence.length > 0");
const modalProductSource = component.indexOf(">View product page <ExternalLink");
assert.ok(
  modalPrimaryEvidence >= 0 && modalAdditionalEvidence > modalPrimaryEvidence && modalProductSource > modalAdditionalEvidence,
  "Details must present Primary Evidence, Additional Evidence, then Product Source",
);
assert.match(component, /Trend figures use only the primary Pinterest reference above/, "Additional references must not imply metric aggregation");
assert.match(component, /fetchProductOpportunity\(item\.id\)/, "Additional references must load only after the detail modal opens");
assert.match(server, /\.eq\("evidence_status", "active"\)/, "Only active Pinterest references may be exposed");
assert.match(server, /if \(row\.is_primary\)/, "Primary and additional references must remain separate");
assert.doesNotMatch(component, /Still gathering history/, "Missing metrics must be omitted instead of rendered as a pseudo-result");
assert.match(metricControls, /NEXT_PUBLIC_PRODUCT_METRICS_PHYSICAL_ENABLED/, "Physical metrics need an independent release flag");
assert.match(metricControls, /NEXT_PUBLIC_PRODUCT_METRICS_DIGITAL_ENABLED/, "Digital metrics need an independent release flag");
assert.match(component, /<Heart/, "Save must use the approved heart icon language");
assert.match(component, /Saved to Saved Products/, "Save and Create Pin need distinct feedback");
assert.match(component, /Return to products you want to compare or turn into a Pin/, "Saved Products must describe a shortlist, not a tracking trigger");
assert.doesNotMatch(component, /compare, track, or turn into a Pin/, "Saving must not imply that user action starts Product tracking");
assert.doesNotMatch(
  component,
  /fetchSavedProductOpportunities[\s\S]{0,300}catch\(\(\) => undefined\)/,
  "A Saved Products read failure must not be silently rendered as an unsaved catalog",
);
assert.match(component, /savedState !== "ready"/, "Save mutations must pause until the existing saved state is known");
assert.match(component, /saved products could not be checked/, "Catalog users need a retryable Saved Products read error");
assert.match(component, /historyItem/, "Paid Saved Products must retain truthful read-only history");
assert.match(component, /Previous product page/, "Historical saved records must keep the product reference");
assert.match(component, /Pinterest reference/, "Historical saved records must keep Pinterest evidence");
assert.match(component, /Remove/, "Historical saved records must remain removable");
assert.doesNotMatch(
  server,
  /"(?:upgrade_required|no_longer_available|plan_limited|history_only|viewable)"/,
  "Saved Products API must not expose internal-sounding lifecycle states",
);
assert.match(server, /requiresUpgrade: boolean/, "Saved Products must expose user intent instead of an internal status enum");
assert.match(component, /record\.requiresUpgrade/, "Saved Products UI must use the user-intent access flag");
assert.match(component, /Product added to Create Pins/, "Create Pin needs distinct feedback");
const createPinHandoff = component.indexOf("await openCreatePinsWithDraft");
const createPinSuccess = component.indexOf('toast.success("Product added to Create Pins")');
assert.ok(
  createPinHandoff >= 0 && createPinSuccess > createPinHandoff,
  "Create Pin success must be reported only after a usable handoff exists",
);
assert.match(component, /Could not add product to Create Pins/, "Create Pin handoff failure must be visible");
assert.match(prefill, /function savePrefillStrict/, "Product handoff needs a strict storage boundary without changing legacy callers");
assert.match(prefill, /throw new Error\("Create Pins context could not be saved"\)/, "Storage failure must reject instead of navigating empty context");
for (const event of [
  "product_opportunities_viewed",
  "product_card_opened",
  "pinterest_evidence_clicked",
  "external_product_clicked",
  "product_saved",
  "product_unsaved",
  "create_pin_from_product_clicked",
  "demand_filter_used",
  "trend_filter_used",
  "saved_products_viewed",
]) {
  assert.match(analytics, new RegExp(`\\| \\"${event}\\"`), `${event} must be accepted by the durable analytics client`);
  assert.match(component, new RegExp(`track\\(\\"${event}\\"`), `${event} must be emitted by the Product Opportunities UI`);
}
assert.match(component, /Most Saved/, "The first truthful sort must remain available");
assert.match(component, /Newest Discovered/, "Newest discovery sorting must remain available");
assert.match(component, />Category</, "Category filtering must remain user-visible");
assert.doesNotMatch(component, /"womens-fashion": "Women's Fashion"/, "Acquisition provenance must not become a second business category");
assert.match(component, /"wedding-celebrations": "Wedding & Celebrations"/, "Wedding needs a user-facing label");
assert.match(component, /gifts: "Gifts"/, "Gifts needs a user-facing label");
assert.match(component, /"jewelry-accessories": "Jewelry & Accessories"/, "Jewelry needs a user-facing label");
assert.match(component, /"digital-products": "Digital Products"/, "Digital category needs a user-facing label");
assert.match(component, /Object\.entries\(CATEGORY_LABELS\)/, "Category filtering must render labels while submitting stable slugs");
assert.match(component, />Platform</, "Platform filtering must remain user-visible");
assert.match(server, /productType: opportunity\.product_type/, "Proven merchant Product Type must survive the API boundary");
assert.match(component, /item\.productType/, "Proven merchant Product Type must be shown when present");
assert.match(server, /product_opportunity_catalog_v1/, "Catalog queries must use the evidence-safe joined view");
assert.match(server, /hasRowsOutsideFreePreview/, "The Free upgrade panel must be backed by a real locked-catalog count");
assert.match(server, /\(count \?\? 0\) > freeLimit/, "Ten or fewer real products must not produce a fake locked-catalog claim");
assert.doesNotMatch(server, /hasLockedCatalog:\s*scope\.limit !== null/, "Plan type alone must not fabricate a larger catalog");
assert.match(server, /search_text/, "Search must run server-side across the complete accessible catalog");
assert.match(server, /highRecentDemand/, "High-demand wording must be backed by approved family calibration");
assert.match(server, /product_metric_calibrations/, "Physical and Digital calibration must come from persisted policy");
assert.match(server, /\.lte\("effective_from", new Date\(\)\.toISOString\(\)\)/, "Future calibrations must not become effective early");
assert.match(server, /metricsPublishedForFamily/, "Shadow metrics must be gated at the server API boundary");
assert.match(metricControls, /NEXT_PUBLIC_PRODUCT_METRICS_PHYSICAL_ENABLED/, "The server must independently gate Physical metric publication");
assert.match(metricControls, /NEXT_PUBLIC_PRODUCT_METRICS_DIGITAL_ENABLED/, "The server must independently gate Digital metric publication");
assert.match(server, /metricsPublishedForFamily\(opportunity\.product_family\)\s*&&\s*metric/, "Direct API callers must not bypass family metric flags");
assert.match(server, /\["valid", "insufficient_activity", "calibration_pending"\]\.includes\(metric\.trend_status\)/, "Raw G7 facts must still fail closed for stale, regression, or incomplete history");
assert.match(server, /product_metric_release_gates/, "Metric controls must read the persisted family release gate");
assert.match(metricControls, /valid_g30_g7_coverage\) >= 0\.70/, "Metric controls must remain hidden below seventy percent valid coverage");
assert.match(metricControls, /visible_product_count > 0/, "Metric controls must never open for an empty family catalog");
assert.match(metricControls, /quality_review_passed === true/, "Metric controls need an explicit quality review");
assert.match(metricControls, /approved_at/, "Metric controls need an explicit approval record");
assert.match(server, /product_metric_calibrations/, "Metric controls must prove an approved effective calibration for the same family version");
assert.match(server, /\.eq\("metric_version", gate\.metric_version\)/, "Metric controls must use the release gate's exact metric version");
assert.match(server, /\.lte\("effective_from", new Date\(\)\.toISOString\(\)\)/, "Metric controls must reject future calibration policy");
assert.match(component, /metricControls\.available \? <label><span>Demand/, "Demand must render only after the family gate passes");
assert.match(component, /metricControls\.available \? <label><span>Trend/, "Trend must render only after the family gate passes");
assert.match(component, /metricControls\.available \? <option value="fastest_growing">Fastest Growing/, "Fastest Growing must render only after the family gate passes");
assert.match(listApi, /ProductMetricControlsNotReadyError/, "Direct API callers must be rejected when gated controls are not ready");
assert.doesNotMatch(
  component + listApi + detailApi + savedApi,
  /\b(?:unavailable|retired|inactive|insufficient_signal)\b/i,
  "Internal state language must never reach Product Opportunity users",
);
assert.doesNotMatch(component, /productName\s*\|\|\s*["']Product["']/, "Missing product names must never become a fabricated Product title");
assert.doesNotMatch(component, /Product opportunity from/, "Accessible labels must describe missing-title products without inventing a title");
assert.match(component, /Product details from/, "Missing-title accessible labels must remain descriptive and truthful");
assert.match(component, /after product discovery and review/, "Empty catalog copy must name the workflow that can actually add products");
assert.doesNotMatch(component, /after the next daily tracking run/, "Trend tracking must not be described as product discovery");
assert.match(component, /No products match these filters/, "Filtered catalog emptiness must not be presented as an empty product catalog");
assert.match(component, /No saved products match this product type/, "A saved-family mismatch must not claim that the user has no saved products");
assert.match(component, /Show all saved products/, "Saved-family empty state must provide a truthful recovery action");
assert.doesNotMatch(component, /number\(item\.latestPinterestSaves!\)/, "Missing Pinterest saves must never be formatted as a fabricated zero");
assert.doesNotMatch(client, /\.from\s*\(|pin_products/i, "Browser client must not query product tables or bypass server-side plan access");
assert.doesNotMatch(
  legacyPickerApi,
  /public_metrics|opportunity_score:|trend_score:|save_velocity_score:|competition_score:|latestDemandUpdatedAt|latestCompetitionUpdatedAt|latestScoreUpdatedAt/,
  "Legacy Product Picker API must not expose retired Product Opportunity conclusions",
);
assert.doesNotMatch(
  legacyPickerApi,
  /sort === ["'](?:rising|low_competition|velocity|opportunity)["']/,
  "Legacy Product Picker API must not sort users by retired Product Opportunity conclusions",
);
assert.match(
  legacyProductIntelligenceApi,
  /status:\s*410/,
  "The legacy pin_products intelligence endpoint must be explicitly retired",
);
assert.match(
  legacyProductIntelligenceApi,
  /This older product insights view is no longer available\. Open Product Opportunities for current product details\./,
  "The legacy API must explain the replacement in ordinary user language",
);
assert.doesNotMatch(
  legacyProductIntelligenceApi,
  /error:\s*["'][^"']*\b(?:unavailable|retired|inactive|insufficient_signal)\b/i,
  "Legacy API error copy must not expose internal lifecycle vocabulary",
);
assert.doesNotMatch(
  legacyProductIntelligenceApi,
  /product_scores|opportunity_score|trend_score|save_velocity_score|competition_score|yearly_change/,
  "The retired legacy product detail API must not expose old Product conclusions",
);

console.log("product opportunity v3.7 UI contract: PASS");
