/**
 * Public Product marketing must not advertise retired scores/competition or
 * present static example numbers as live Product data. The truthful landing
 * path keeps the evidence -> product -> Create Pins workflow while the legacy
 * mock intelligence panels remain unreachable.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (relative: string) => readFileSync(resolve(process.cwd(), relative), "utf8");
const page = read("src/app/page.tsx");
const assets = read("src/lib/landingAssets.ts");
const execution = read("src/components/landing/ExecutionSystem.tsx");
const conversion = read("src/lib/landing/conversionData.ts");
const homeStart = page.indexOf("export default function HomePage");
assert.ok(homeStart >= 0, "HomePage entry point must exist");
const renderedHome = page.slice(homeStart);

assert.match(renderedHome, /<HeroComposer\s+products=/, "The hero must demonstrate the real Product-to-Create-Pins workflow");
assert.match(renderedHome, /<ExecutionSystem/, "The landing page must keep the evidence-to-execution explanation");
for (const safeSection of ["SupportedNichesStrip", "PricingSection", "FaqSection", "LandingFooter"]) {
  assert.match(renderedHome, new RegExp(`<${safeSection}`), `${safeSection} must remain on the public page`);
}

assert.doesNotMatch(
  renderedHome,
  /<(?:HeroOpportunityCard|OpportunityIntelligence|IntelligenceInAction|LandingConversionBlock)\b/,
  "Legacy mock intelligence panels must not be reachable from the public HomePage",
);
assert.doesNotMatch(
  renderedHome,
  /Opportunity score|Commercial competition|Low comp(?:etition|\.)?|● Live|\+\d+% this week|High-save Pins|Product signals discovered/i,
  "Rendered public Product marketing must not claim retired or fabricated metrics",
);

assert.doesNotMatch(assets, /opportunity_score|sort=opportunity|score:\s*p\./, "Legacy Opportunity Score must not cross the landing API boundary");
assert.match(assets, /sort=most_saved/, "Landing Product selection must use a supported evidence fact");

const renderedProductMarketing = [renderedHome, execution, conversion].join("\n");
assert.doesNotMatch(
  renderedProductMarketing,
  /match(?:ed)? (?:your )?products? to (?:rising )?(?:Pinterest )?demand|compare opportunity and competition|opportunity scores? and recommendations|products? (?:and Pin formats )?are already working|focus on what will perform/i,
  "Rendered Product marketing must not promise retired metrics or unproven outcomes",
);
assert.match(renderedProductMarketing, /real product pages? with auditable Pinterest evidence/i, "Public copy must explain the evidence-backed Product boundary");
assert.match(conversion, /recent demand (?:or|and) momentum (?:appears|are shown) only when enough valid (?:save )?history exists/i, "Public copy must explain that recent Product metrics require valid history");
assert.match(conversion, /do not use a competition badge or an opportunity score/i, "Public FAQ must explicitly retire Product competition and score claims");

console.log("product marketing truth boundary: PASS");
