import type {
  InsightsContent,
  InsightsDay,
  InsightsMetrics,
  InsightsPlatform,
} from "./types";

export function finiteMetric(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export function trafficRate(clicks: number | null, views: number): number | null {
  if (clicks == null || views <= 0) return null;
  return clicks / views;
}

export function emptyMetrics(websiteClicks: number | null = null): InsightsMetrics {
  return {
    views: 0,
    interactions: 0,
    saves: 0,
    shares: 0,
    websiteClicks,
    trafficRate: null,
  };
}

export function utcDateDaysAgo(daysAgo: number, now = new Date()): string {
  const date = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - daysAgo,
  ));
  return date.toISOString().slice(0, 10);
}

export function fillDailyRange(
  rows: InsightsDay[],
  startDate: string,
  endDate: string,
  websiteClicksAvailable: boolean,
): InsightsDay[] {
  const byDate = new Map(rows.map(row => [row.date, row]));
  const result: InsightsDay[] = [];
  const cursor = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  while (cursor <= end) {
    const date = cursor.toISOString().slice(0, 10);
    const existing = byDate.get(date);
    result.push(existing ?? {
      date,
      ...emptyMetrics(websiteClicksAvailable ? 0 : null),
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

export function summarizeDays(days: InsightsDay[], websiteClicksAvailable: boolean): InsightsMetrics {
  const summary = days.reduce<InsightsMetrics>((total, row) => ({
    views: total.views + row.views,
    interactions: total.interactions + row.interactions,
    saves: total.saves + row.saves,
    shares: total.shares + row.shares,
    websiteClicks: websiteClicksAvailable
      ? (total.websiteClicks ?? 0) + (row.websiteClicks ?? 0)
      : null,
    trafficRate: null,
  }), emptyMetrics(websiteClicksAvailable ? 0 : null));
  summary.trafficRate = trafficRate(summary.websiteClicks, summary.views);
  return summary;
}

/**
 * The one-line read on a piece of content, as an i18n KEY rather than a sentence.
 *
 * This function runs on the server, where there is no locale: the dashboard is built
 * once per connection and the same object is cached and served to whoever asks. A
 * sentence baked in here would be one hardcoded language for every user of an app
 * that ships in 18 — which is exactly what it used to be. Returning a key moves the
 * choice of language to the only place that knows it, the page.
 *
 * Every branch must therefore have a key in `insights.diagnosis.*` in all catalogs;
 * an unknown key renders as itself, which is visible but useless.
 */
export function diagnoseContent(
  platform: InsightsPlatform,
  metrics: InsightsMetrics,
  cohort: InsightsMetrics[],
): string {
  const comparable = cohort.filter(item => item.views > 0);
  const median = (values: number[]): number => {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];
  };
  const medianViews = median(comparable.map(item => item.views));
  const medianRate = median(comparable
    .map(item => item.trafficRate)
    .filter((value): value is number => value != null));

  if (platform === "pinterest" && metrics.views >= 100 && metrics.trafficRate != null) {
    if (metrics.trafficRate > medianRate && metrics.views < medianViews) {
      return "insights.diagnosis.efficientButSmallReach";
    }
    if (metrics.views >= medianViews && ((metrics.websiteClicks ?? 0) === 0 || metrics.trafficRate < medianRate)) {
      return "insights.diagnosis.seenButFewClicks";
    }
    if ((metrics.websiteClicks ?? 0) > 0 && metrics.trafficRate >= medianRate && metrics.views >= medianViews) {
      return "insights.diagnosis.seenAndConverts";
    }
  }

  if (metrics.saves + metrics.shares > 0 && metrics.interactions > 0) {
    return platform === "instagram"
      ? "insights.diagnosis.savedInstagram"
      : "insights.diagnosis.savedPinterest";
  }
  return metrics.views > 0
    ? "insights.diagnosis.tooEarly"
    : "insights.diagnosis.noData";
}

/**
 * The line shown for a row that has no numbers.
 *
 * "No numbers" is four different situations and they call for four different
 * actions, which is the entire reason the v64 ledger records a status per
 * measurement instead of just writing rows when it has them:
 *   - `no_permission`  the token cannot read this. Reconnecting fixes it.
 *   - `not_collected`  we have not spent a call on it yet. Waiting fixes it.
 *   - `not_returned`   Pinterest answered without the metric. Only time fixes it,
 *                      and for a Pin we did not publish the wording must not claim
 *                      a VibePin publish record.
 * Collapsing them into one "no data yet" is what turns an analytics page into
 * something nobody trusts.
 */
function missingMetricsDiagnosis(item: InsightsContent): string {
  if (item.metricsState === "no_permission") return "insights.diagnosis.noPermission";
  if (item.metricsState === "not_collected") return "insights.diagnosis.notCollected";
  return item.origin === "pinterest"
    ? "insights.diagnosis.awaitingPlatform"
    : "insights.diagnosis.awaitingMetrics";
}

export function attachDiagnoses(
  platform: InsightsPlatform,
  content: InsightsContent[],
): InsightsContent[] {
  const cohort = content.map(item => item.metrics);
  return content.map(item => ({
    ...item,
    diagnosis: item.metricsAvailable === false
      ? missingMetricsDiagnosis(item)
      : diagnoseContent(platform, item.metrics, cohort),
  }));
}
