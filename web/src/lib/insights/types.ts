import type { InsightsDiagnosis } from "./recommendations";
import type { INSIGHTS_DIAGNOSIS_LOCKED } from "./paidGate";

/**
 * What the `diagnosis` field of a dashboard may be: the real reading, the paid-gate
 * placeholder, or nothing to say. See InsightsDashboard.diagnosis for which is which.
 */
export type InsightsDiagnosisPayload =
  | InsightsDiagnosis
  | typeof INSIGHTS_DIAGNOSIS_LOCKED
  | null;

export type InsightsPlatform = "pinterest" | "instagram";

/**
 * Which set of content a Pinterest dashboard describes.
 *
 * `vibepin`  — only Pins with a confirmed VibePin publish record (the original,
 *              and still the default: it is the set the user acted on).
 * `account`  — everything the collector has registered for the connected account,
 *              including Pins published outside VibePin. Its summary and heatmap
 *              come from account-level daily observations, not from adding up Pins:
 *              the two are different measurements and summing rows would answer a
 *              question Pinterest never asked.
 */
export type InsightsScope = "vibepin" | "account";

export type InsightsMetricAvailability =
  | "pin_level"
  | "media_level"
  | "account_level"
  | "unavailable";

export type InsightsConnectionState =
  | "ready"
  | "not_connected"
  | "needs_reconnect"
  | "business_account_required"
  | "unavailable";

/** The four facts the v64 observation ledger keeps apart. */
export type InsightsObservationStatus = "ok" | "not_returned" | "no_permission" | "not_collected";

/**
 * What a row's numbers are worth.
 *
 * `stale` is the one that does not exist in the database: it means we HAVE a value
 * from an earlier run, and a LATER attempt did not return one. Showing the old
 * number is right (it is a real measurement), but presenting it as current would be
 * a lie, so the state travels with it.
 */
export type InsightsMetricState = "ok" | "stale" | "not_returned" | "no_permission" | "not_collected";

/** Who put the content on Pinterest, per the content registry. */
export type InsightsContentOrigin = "vibepin" | "pinterest";

export type InsightsMetrics = {
  views: number;
  interactions: number;
  saves: number;
  shares: number;
  websiteClicks: number | null;
  trafficRate: number | null;
};

export type InsightsDay = InsightsMetrics & {
  date: string;
};

export type InsightsContent = {
  id: string;
  title: string;
  imageUrl: string | null;
  postUrl: string | null;
  publishedAt: string | null;
  format: "image" | "carousel" | "video" | "unknown";
  metrics: InsightsMetrics;
  /** False when the platform did not return analytics for this verified post. */
  metricsAvailable?: boolean;
  /** Why the numbers are what they are. Absent on the Instagram path. */
  metricsState?: InsightsMetricState;
  /** Only set in the "Your account" scope, where rows are not all VibePin's. */
  origin?: InsightsContentOrigin;
  websiteClickAvailability: InsightsMetricAvailability;
  diagnosis: string;
};

export type InsightsAccount = {
  id: string;
  name: string;
  username: string | null;
};

/**
 * Where this dashboard's numbers came from, so the page can say so.
 *
 * `collected`          — read from the nightly collection; `dataUpdatedAt` is the
 *                        finish time of the newest run for this connection.
 * `awaiting_first_run` — the collector has not finished a run for this connection
 *                        yet, so there is nothing to read. Nothing is shown rather
 *                        than something wrong, and `skippedReason` says why if the
 *                        last attempt stopped early.
 *
 * There is deliberately no third mode. A `live_sample` one existed and read Pinterest
 * during the request to avoid an empty first screen; those calls were outside every
 * budget the collector keeps. The page now makes no Pinterest call in any state.
 */
export type InsightsCollectionState = {
  mode: "collected" | "awaiting_first_run";
  dataUpdatedAt: string | null;
  /** `collection_run.skipped_reason` of the most recent run, when it stopped early. */
  skippedReason: string | null;
  /** Always null. Retained so stored dashboards from before the live sample was
   *  removed still parse; nothing writes a number here any more. */
  sampleLimit: number | null;
};

export type InsightsDashboard = {
  platform: InsightsPlatform;
  scope: InsightsScope;
  connectionState: InsightsConnectionState;
  account: InsightsAccount | null;
  range: {
    startDate: string;
    endDate: string;
    days: number;
  };
  summary: InsightsMetrics;
  daily: InsightsDay[];
  content: InsightsContent[];
  availability: {
    views: InsightsMetricAvailability;
    websiteClicks: InsightsMetricAvailability;
    message: string;
  };
  /** Null on the Instagram path, which has no collection layer of its own. */
  collection: InsightsCollectionState | null;
  /**
   * The evidence-engine read on this account: headline, findings, Keep/Change/Test.
   *
   * Three distinguishable answers, and the page must tell them apart.
   *
   * `null` — there is nothing to reason about: Instagram (no collection layer), an
   * unusable connection, the state before the first collection run in the account
   * scope. Null is NOT "no problems found": that answer is a diagnosis carrying the
   * fallback headline and an empty findings list.
   *
   * `{ locked: true }` — the reading exists and this plan is not entitled to it
   * (lib/insights/paidGate.ts). The placeholder is the entire payload; no headline,
   * finding, recommendation or evidence value travels with it.
   */
  diagnosis: InsightsDiagnosisPayload;
  latestAvailableAt: string | null;
  syncedAt: string;
  warning: string | null;
};

export type InsightsApiResponse = {
  dashboard: InsightsDashboard;
};
