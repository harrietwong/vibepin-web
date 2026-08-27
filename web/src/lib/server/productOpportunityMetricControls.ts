export type ProductMetricFamily = "physical" | "digital";

export type ProductMetricReleaseGate = {
  product_family: ProductMetricFamily;
  metric_version: number;
  valid_g30_g7_coverage: number;
  visible_product_count: number;
  quality_review_passed: boolean;
  demand_trend_filters_enabled: boolean;
  approved_at: string | null;
};

export type ProductMetricCalibrationGate = {
  product_family: ProductMetricFamily;
  metric_version: number;
  effective_from: string;
  approved_at: string | null;
};

export type ProductMetricControls = {
  available: boolean;
  family: ProductMetricFamily | null;
  metricVersion: number | null;
};

export function metricsPublishedForFamily(family: ProductMetricFamily): boolean {
  return family === "physical"
    ? process.env.NEXT_PUBLIC_PRODUCT_METRICS_PHYSICAL_ENABLED === "true"
    : process.env.NEXT_PUBLIC_PRODUCT_METRICS_DIGITAL_ENABLED === "true";
}

export function resolveProductMetricControls(
  family: ProductMetricFamily | undefined,
  rows: ProductMetricReleaseGate[],
  calibrations: ProductMetricCalibrationGate[] = [],
  now = new Date(),
): ProductMetricControls {
  // Physical and Digital are calibrated independently. The combined catalog
  // never receives one ambiguous cross-family control policy.
  if (!family || !metricsPublishedForFamily(family)) {
    return { available: false, family: null, metricVersion: null };
  }
  const gate = rows.find((row) => row.product_family === family);
  const calibration = calibrations.find((row) => (
    row.product_family === family
    && row.metric_version === gate?.metric_version
    && Boolean(row.approved_at)
    && Number.isFinite(Date.parse(row.effective_from))
    && new Date(row.effective_from) <= now
  ));
  const available = Boolean(
    gate
      && calibration
      && gate.demand_trend_filters_enabled === true
      && gate.quality_review_passed === true
      && gate.approved_at
      && Number(gate.valid_g30_g7_coverage) >= 0.70
      && Number.isInteger(gate.visible_product_count)
      && gate.visible_product_count > 0
      && Number.isInteger(gate.metric_version)
      && gate.metric_version > 0,
  );
  return available
    ? { available: true, family, metricVersion: gate!.metric_version }
    : { available: false, family: null, metricVersion: null };
}
