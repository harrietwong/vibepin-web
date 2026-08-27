import "server-only";

import { INSTAGRAM_GRAPH_URL } from "@/lib/server/instagram/config";
import { finiteMetric } from "@/lib/insights/businessRules";

type GraphErrorBody = {
  error?: { message?: string; code?: number; type?: string };
};

export class InstagramInsightsError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "InstagramInsightsError";
    this.status = status;
  }
}

export type InstagramAccountMetricRow = {
  name?: string;
  values?: Array<{ value?: number | Record<string, number>; end_time?: string }>;
  total_value?: { value?: number | Record<string, number> };
};

export type InstagramMediaRow = {
  id: string;
  caption: string | null;
  mediaType: string | null;
  imageUrl: string | null;
  permalink: string | null;
  timestamp: string | null;
};

export type InstagramMediaMetrics = {
  id: string;
  metrics: Record<string, number>;
};

function scalarValue(value: unknown): number {
  if (typeof value === "number") return finiteMetric(value);
  if (!value || typeof value !== "object") return 0;
  return Object.values(value as Record<string, unknown>)
    .reduce<number>((sum, entry) => sum + finiteMetric(entry), 0);
}

async function graphGet<T>(
  path: string,
  accessToken: string,
  params: Record<string, string>,
): Promise<T> {
  const query = new URLSearchParams({ ...params, access_token: accessToken });
  const response = await fetch(`${INSTAGRAM_GRAPH_URL}/${path}?${query.toString()}`, {
    method: "GET",
    cache: "no-store",
  });
  const body = (await response.json().catch(() => ({}))) as T & GraphErrorBody;
  if (!response.ok || body.error) {
    throw new InstagramInsightsError(
      body.error?.message || `Instagram Insights request failed (${response.status})`,
      response.status,
    );
  }
  return body;
}

export async function fetchInstagramAccountMetric(
  accessToken: string,
  userId: string,
  metric: "views" | "total_interactions" | "profile_links_taps" | "saves" | "shares",
  startDate: string,
  endDate: string,
): Promise<InstagramAccountMetricRow | null> {
  const common = {
    metric,
    period: "day",
    since: startDate,
    until: endDate,
  };
  try {
    const result = await graphGet<{ data?: InstagramAccountMetricRow[] }>(
      `${encodeURIComponent(userId)}/insights`,
      accessToken,
      common,
    );
    return result.data?.find(row => row.name === metric) ?? result.data?.[0] ?? null;
  } catch (error) {
    // Some account metrics are total-value metrics in newer Graph versions.
    // Retry that documented shape once; never turn a missing metric into zero.
    if (metric !== "profile_links_taps") throw error;
    const result = await graphGet<{ data?: InstagramAccountMetricRow[] }>(
      `${encodeURIComponent(userId)}/insights`,
      accessToken,
      { ...common, metric_type: "total_value" },
    );
    return result.data?.find(row => row.name === metric) ?? result.data?.[0] ?? null;
  }
}

export function accountMetricTotal(row: InstagramAccountMetricRow | null): number {
  if (!row) return 0;
  if (row.total_value) return scalarValue(row.total_value.value);
  return (row.values ?? []).reduce((sum, value) => sum + scalarValue(value.value), 0);
}

export function accountMetricDaily(row: InstagramAccountMetricRow | null): Map<string, number> {
  const daily = new Map<string, number>();
  for (const value of row?.values ?? []) {
    if (!value.end_time) continue;
    // Meta's day value ends at the next boundary. Use its UTC calendar date as
    // returned rather than applying the viewer's browser timezone.
    const date = value.end_time.slice(0, 10);
    daily.set(date, (daily.get(date) ?? 0) + scalarValue(value.value));
  }
  return daily;
}

export async function listInstagramMedia(
  accessToken: string,
  userId: string,
): Promise<InstagramMediaRow[]> {
  const result = await graphGet<{ data?: Array<Record<string, unknown>> }>(
    `${encodeURIComponent(userId)}/media`,
    accessToken,
    {
      fields: "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp",
      limit: "50",
    },
  );
  return (result.data ?? [])
    .filter(row => typeof row.id === "string")
    .map(row => ({
      id: row.id as string,
      caption: typeof row.caption === "string" ? row.caption : null,
      mediaType: typeof row.media_type === "string" ? row.media_type : null,
      imageUrl:
        typeof row.thumbnail_url === "string"
          ? row.thumbnail_url
          : typeof row.media_url === "string"
            ? row.media_url
            : null,
      permalink: typeof row.permalink === "string" ? row.permalink : null,
      timestamp: typeof row.timestamp === "string" ? row.timestamp : null,
    }));
}

export async function fetchInstagramMediaMetrics(
  accessToken: string,
  mediaId: string,
): Promise<InstagramMediaMetrics> {
  const result = await graphGet<{ data?: Array<{
    name?: string;
    values?: Array<{ value?: number | Record<string, number> }>;
    total_value?: { value?: number | Record<string, number> };
  }> }>(
    `${encodeURIComponent(mediaId)}/insights`,
    accessToken,
    { metric: "views,reach,likes,comments,saved,shares,total_interactions" },
  );
  const metrics: Record<string, number> = {};
  for (const row of result.data ?? []) {
    if (!row.name) continue;
    metrics[row.name] = row.total_value
      ? scalarValue(row.total_value.value)
      : (row.values ?? []).reduce((sum, value) => sum + scalarValue(value.value), 0);
  }
  return { id: mediaId, metrics };
}
