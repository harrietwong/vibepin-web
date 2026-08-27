import assert from "node:assert/strict";
import { assertAllowedVerificationUrl, findProductTruthViolations } from "./verify-product-truth-url";

const safeRenderedText = `
  VibePin connects real product pages with auditable Pinterest evidence.
  Product Opportunities do not use a competition badge or an opportunity score.
  Live chat is available during support hours.
`;

assert.deepEqual(findProductTruthViolations(safeRenderedText), [], "truthful retirement copy must pass");

const blockedClaims: Record<string, string> = {
  numeric_opportunity_score: "Opportunity score 94",
  competition_verdict: "Low Competition",
  commercial_competition: "Commercial competition",
  fabricated_demand_delta: "+210% Demand",
  fabricated_demand_window: "Demand vs last 30 days",
  fabricated_week_delta: "+18% this week",
  fabricated_live_badge: "● Live",
  fabricated_high_save_inventory: "High-save Pins",
  fabricated_product_inventory: "Product signals discovered",
  product_demand_verdict: "Product demand High",
  estimated_opportunity_verdict: "Estimated opportunity High",
  fabricated_weekly_growth: "Weekly growth +22%",
};

for (const [expectedId, claim] of Object.entries(blockedClaims)) {
  const violations = findProductTruthViolations(`${safeRenderedText} ${claim}`);
  assert.ok(violations.includes(expectedId), `${claim} must trigger ${expectedId}`);
}

assert.deepEqual(
  findProductTruthViolations("A generic marketing page with no Product evidence boundary."),
  ["missing_auditable_product_evidence_copy"],
  "the verifier must fail closed when the expected truthful release boundary is absent",
);

assert.equal(assertAllowedVerificationUrl("https://vibepin.co/").hostname, "vibepin.co");
assert.equal(assertAllowedVerificationUrl("https://candidate-123.vercel.app/").hostname, "candidate-123.vercel.app");
assert.equal(assertAllowedVerificationUrl("http://localhost:3000/").hostname, "localhost");
assert.throws(() => assertAllowedVerificationUrl("http://vibepin.co/"), /must use HTTPS/);
assert.throws(() => assertAllowedVerificationUrl("https://example.com/"), /must be vibepin\.co or a Vercel preview/);

console.log("product live truth verifier: PASS");
