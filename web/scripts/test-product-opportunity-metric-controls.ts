import assert from "node:assert/strict";
import {
  resolveProductMetricControls,
  type ProductMetricCalibrationGate,
  type ProductMetricReleaseGate,
} from "../src/lib/server/productOpportunityMetricControls";

const physicalFlag = process.env.NEXT_PUBLIC_PRODUCT_METRICS_PHYSICAL_ENABLED;
const digitalFlag = process.env.NEXT_PUBLIC_PRODUCT_METRICS_DIGITAL_ENABLED;

function gate(overrides: Partial<ProductMetricReleaseGate> = {}): ProductMetricReleaseGate {
  return {
    product_family: "physical",
    metric_version: 3,
    valid_g30_g7_coverage: 0.70,
    visible_product_count: 100,
    quality_review_passed: true,
    demand_trend_filters_enabled: true,
    approved_at: "2026-08-26T00:00:00Z",
    ...overrides,
  };
}

function calibration(overrides: Partial<ProductMetricCalibrationGate> = {}): ProductMetricCalibrationGate {
  return {
    product_family: "physical",
    metric_version: 3,
    effective_from: "2026-08-25T00:00:00Z",
    approved_at: "2026-08-25T00:00:00Z",
    ...overrides,
  };
}

try {
  process.env.NEXT_PUBLIC_PRODUCT_METRICS_PHYSICAL_ENABLED = "true";
  process.env.NEXT_PUBLIC_PRODUCT_METRICS_DIGITAL_ENABLED = "true";

  const now = new Date("2026-08-26T00:00:00Z");
  assert.equal(resolveProductMetricControls(undefined, [gate()], [calibration()], now).available, false);
  assert.equal(resolveProductMetricControls("physical", [gate()], [], now).available, false);
  assert.equal(resolveProductMetricControls("physical", [gate()], [calibration({ approved_at: null })], now).available, false);
  assert.equal(resolveProductMetricControls("physical", [gate()], [calibration({ effective_from: "2026-08-27T00:00:00Z" })], now).available, false);
  assert.equal(resolveProductMetricControls("physical", [gate()], [calibration({ metric_version: 4 })], now).available, false);
  assert.equal(resolveProductMetricControls("physical", [gate({ valid_g30_g7_coverage: 0.6999 })], [calibration()], now).available, false);
  assert.equal(resolveProductMetricControls("physical", [gate({ visible_product_count: 0 })], [calibration()], now).available, false);
  assert.equal(resolveProductMetricControls("physical", [gate({ quality_review_passed: false })], [calibration()], now).available, false);
  assert.equal(resolveProductMetricControls("physical", [gate({ approved_at: null })], [calibration()], now).available, false);
  assert.equal(resolveProductMetricControls("physical", [gate({ demand_trend_filters_enabled: false })], [calibration()], now).available, false);
  assert.equal(resolveProductMetricControls("physical", [gate({ metric_version: 0 })], [calibration()], now).available, false);

  const physical = resolveProductMetricControls("physical", [gate()], [calibration()], now);
  assert.deepEqual(physical, { available: true, family: "physical", metricVersion: 3 });
  assert.equal(resolveProductMetricControls("digital", [gate()], [calibration()], now).available, false);

  const digital = resolveProductMetricControls("digital", [gate({
    product_family: "digital",
    metric_version: 7,
  })], [calibration({ product_family: "digital", metric_version: 7 })], now);
  assert.deepEqual(digital, { available: true, family: "digital", metricVersion: 7 });

  process.env.NEXT_PUBLIC_PRODUCT_METRICS_PHYSICAL_ENABLED = "false";
  assert.equal(resolveProductMetricControls("physical", [gate()], [calibration()], now).available, false);
  assert.equal(resolveProductMetricControls("digital", [gate({ product_family: "digital" })], [calibration({ product_family: "digital" })], now).available, true);
} finally {
  if (physicalFlag === undefined) delete process.env.NEXT_PUBLIC_PRODUCT_METRICS_PHYSICAL_ENABLED;
  else process.env.NEXT_PUBLIC_PRODUCT_METRICS_PHYSICAL_ENABLED = physicalFlag;
  if (digitalFlag === undefined) delete process.env.NEXT_PUBLIC_PRODUCT_METRICS_DIGITAL_ENABLED;
  else process.env.NEXT_PUBLIC_PRODUCT_METRICS_DIGITAL_ENABLED = digitalFlag;
}

console.log("product opportunity metric controls: PASS");
