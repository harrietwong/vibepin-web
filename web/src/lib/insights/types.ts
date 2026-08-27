export type InsightsPlatform = "pinterest" | "instagram";

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
  websiteClickAvailability: InsightsMetricAvailability;
  diagnosis: string;
};

export type InsightsAccount = {
  id: string;
  name: string;
  username: string | null;
};

export type InsightsDashboard = {
  platform: InsightsPlatform;
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
  latestAvailableAt: string | null;
  syncedAt: string;
  warning: string | null;
};

export type InsightsApiResponse = {
  dashboard: InsightsDashboard;
};
