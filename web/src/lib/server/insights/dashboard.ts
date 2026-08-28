import "server-only";

import {
  attachDiagnoses,
  emptyMetrics,
  fillDailyRange,
  finiteMetric,
  summarizeDays,
  trafficRate,
  utcDateDaysAgo,
} from "@/lib/insights/businessRules";
import type {
  InsightsContent,
  InsightsDashboard,
  InsightsDay,
  InsightsPlatform,
} from "@/lib/insights/types";
import {
  PinterestApiError,
  PinterestClient,
  type PinterestBulkPinAnalyticsResponse,
  type PinterestOrganicAnalyticsSlice,
  type PinterestOrganicMetricMap,
} from "@/lib/server/pinterest/service";
import { hasInstagramInsightsScope } from "@/lib/server/instagram/config";
import { getInstagramAccessToken } from "@/lib/server/instagram/connectionStore";
import {
  accountMetricDaily,
  accountMetricTotal,
  fetchInstagramAccountMetric,
  fetchInstagramMediaMetrics,
  InstagramInsightsError,
  listInstagramMedia,
} from "./instagram";
import { listConnections } from "@/lib/social/server/socialConnectionStore";
import type { SocialConnection } from "@/lib/social/types";
import { listVibePinPublishedPinterestPins } from "./vibepinPublishedPins";
import { attributePinToConnection } from "./collectorLogic";
import { ownerConnectionsForPins } from "./collectorStore";

const CACHE_TTL_MS = 10 * 60 * 1000;
const DASHBOARD_LOAD_TIMEOUT_MS = 20_000;
const PIN_SINGLE_ANALYTICS_FALLBACK_LIMIT = 60;
const PIN_SINGLE_ANALYTICS_CONCURRENCY = 20;
const dashboardCache = new Map<string, { at: number; value: InsightsDashboard }>();

async function withDashboardTimeout<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Insights data source timed out")),
          DASHBOARD_LOAD_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function readMetric(metrics: PinterestOrganicMetricMap | undefined, key: string): number {
  return finiteMetric(metrics?.[key]);
}

function pinAnalyticsSlice(
  response: PinterestBulkPinAnalyticsResponse,
  pinId: string,
): PinterestOrganicAnalyticsSlice | null {
  const byApp = response[pinId];
  if (!byApp || typeof byApp !== "object") return null;
  return byApp.ALL ?? Object.values(byApp).find(value => value && typeof value === "object") ?? null;
}

function summarizePinterestSlice(slice: PinterestOrganicAnalyticsSlice | null): PinterestOrganicMetricMap {
  if (!slice) return {};
  if (slice.summary_metrics) return slice.summary_metrics;
  const summary: PinterestOrganicMetricMap = {};
  for (const row of slice.daily_metrics ?? []) {
    for (const [key, value] of Object.entries(row.metrics ?? {})) {
      summary[key] = finiteMetric(summary[key]) + finiteMetric(value);
    }
  }
  return summary;
}

async function loadVerifiedPinterestAnalytics(
  client: PinterestClient,
  pinIds: string[],
  startDate: string,
  endDate: string,
  metrics: Parameters<PinterestClient["getOrganicPinsAnalytics"]>[3],
): Promise<{ response: PinterestBulkPinAnalyticsResponse; available: boolean }> {
  if (pinIds.length === 0) return { response: {}, available: true };

  const response: PinterestBulkPinAnalyticsResponse = {};
  // Pinterest's bulk endpoint is a restricted beta and this app is not entitled
  // to it. The stable single-Pin endpoint returns the same response shape. Keep
  // calls bounded by the documented org-analytics allowance and run them in
  // parallel chunks so the first dashboard load stays responsive.
  const fallbackIds = pinIds.slice(0, PIN_SINGLE_ANALYTICS_FALLBACK_LIMIT);
  for (let index = 0; index < fallbackIds.length; index += PIN_SINGLE_ANALYTICS_CONCURRENCY) {
    const chunk = fallbackIds.slice(index, index + PIN_SINGLE_ANALYTICS_CONCURRENCY);
    const settled = await Promise.allSettled(chunk.map(pinId => client.getOrganicPinAnalytics(
      pinId,
      startDate,
      endDate,
      metrics,
    )));
    settled.forEach((result, resultIndex) => {
      if (result.status === "fulfilled") response[chunk[resultIndex]] = result.value;
    });
  }
  return { response, available: Object.keys(response).length > 0 };
}

function mediaFormat(mediaType: string | null): InsightsContent["format"] {
  const value = (mediaType ?? "").toUpperCase();
  if (value.includes("CAROUSEL")) return "carousel";
  if (value.includes("VIDEO") || value.includes("REEL")) return "video";
  if (value.includes("IMAGE")) return "image";
  return "unknown";
}

function titleFromCaption(caption: string | null, fallback: string): string {
  const firstLine = (caption ?? "").split(/\r?\n/).map(value => value.trim()).find(Boolean);
  if (!firstLine) return fallback;
  return firstLine.length > 72 ? `${firstLine.slice(0, 69)}…` : firstLine;
}

function emptyDashboard(
  platform: InsightsPlatform,
  state: InsightsDashboard["connectionState"],
  startDate: string,
  endDate: string,
  warning: string | null,
): InsightsDashboard {
  const websiteClicksAvailable = platform === "pinterest";
  return {
    platform,
    connectionState: state,
    account: null,
    range: { startDate, endDate, days: 30 },
    summary: emptyMetrics(websiteClicksAvailable ? 0 : null),
    daily: fillDailyRange([], startDate, endDate, websiteClicksAvailable),
    content: [],
    availability: {
      views: platform === "pinterest" ? "pin_level" : "media_level",
      websiteClicks: platform === "pinterest" ? "pin_level" : "account_level",
      message: platform === "pinterest"
        ? "Pinterest reports outbound clicks per Pin. A click means someone left Pinterest — it does not prove the page finished loading."
        : "A normal Instagram feed image has no clickable caption link. Only account-level profile link taps are available, and they cannot be assigned to one image.",
    },
    latestAvailableAt: null,
    syncedAt: new Date().toISOString(),
    warning,
  };
}

async function buildPinterestDashboard(
  uid: string,
  connection: SocialConnection,
  startDate: string,
  endDate: string,
  /** Every Pinterest connection this user holds. Scopes the registry ownership
   *  lookup to their own accounts — a Pin's owner is only meaningful among them. */
  siblingConnectionIds: string[] = [connection.id],
): Promise<InsightsDashboard> {
  const [client, provenance] = await Promise.all([
    PinterestClient.forConnection(uid, connection.id),
    listVibePinPublishedPinterestPins(uid),
  ]);
  const metrics = [
    "IMPRESSION",
    "SAVE",
    "PIN_CLICK",
    "OUTBOUND_CLICK",
    "TOTAL_COMMENTS",
    "TOTAL_REACTIONS",
  ] as const;
  const account = await client.getCurrentPinterestUser().catch(() => ({
      id: connection.providerAccountId,
      username: connection.providerAccountUsername,
      accountType: null,
    }));
  // `remotePinId` is written only after Pinterest confirms a successful
  // publish. Use the complete VibePin provenance set as the source of truth;
  // intersecting with the first page of Pinterest-owned Pins silently dropped
  // older VibePin posts from Insights.
  //
  // With several connected accounts, a Pin belongs to the connection it was
  // published through (`targetConnectionId`, adopt-once PRD §14). Without this
  // filter every account's dashboard would list every account's Pins, so the
  // All-accounts view would repeat each Pin once per account and this account's
  // token would return no metrics for the other account's Pins — reported as
  // "Pinterest has not returned metrics yet" rather than as the mis-attribution
  // it really is.
  //
  // Drafts published before targets were recorded carry no attribution of their
  // own. The v64 content registry answers for them: the account whose own token
  // listed a Pin is the account that owns it, which is real evidence rather than
  // a guess. Only when the registry has no row yet — collection has not run, or
  // the migration is not applied here — does a Pin fall back to being visible on
  // every card, where the owning account is still the only one that returns
  // metrics for it.
  const allPublished = Array.from(provenance.pins.values());
  const legacyPinIds = allPublished
    .filter(item => item.targetConnectionId === null)
    .map(item => item.pinId);
  // One query for every unattributed Pin, not one per Pin. A registry that is not
  // there yet resolves to an empty map, so this never breaks the dashboard.
  const registryOwners = legacyPinIds.length > 0
    ? await ownerConnectionsForPins(siblingConnectionIds, legacyPinIds).catch(() => new Map<string, string>())
    : new Map<string, string>();
  const published = allPublished.filter(item => attributePinToConnection(
    item.targetConnectionId,
    registryOwners.get(item.pinId) ?? null,
    connection.id,
  ));
  const analyticsResult = await loadVerifiedPinterestAnalytics(
    client,
    published.map(item => item.pinId),
    startDate,
    endDate,
    [...metrics],
  );

  const analytics = analyticsResult.response;
  const slices = new Map(published.map(item => [item.pinId, pinAnalyticsSlice(analytics, item.pinId)]));
  const byDate = new Map<string, InsightsDay>();
  for (const slice of slices.values()) {
    for (const row of slice?.daily_metrics ?? []) {
      if (typeof row.date !== "string") continue;
      const current = byDate.get(row.date) ?? {
        date: row.date,
        views: 0,
        interactions: 0,
        saves: 0,
        shares: 0,
        websiteClicks: 0,
        trafficRate: null,
      };
      const views = readMetric(row.metrics, "IMPRESSION");
      const saves = readMetric(row.metrics, "SAVE");
      const clicks = readMetric(row.metrics, "OUTBOUND_CLICK");
      const pinClicks = readMetric(row.metrics, "PIN_CLICK");
      const comments = readMetric(row.metrics, "TOTAL_COMMENTS");
      const reactions = readMetric(row.metrics, "TOTAL_REACTIONS");
      current.views += views;
      current.saves += saves;
      current.websiteClicks = (current.websiteClicks ?? 0) + clicks;
      current.interactions += saves + clicks + pinClicks + comments + reactions;
      current.trafficRate = trafficRate(current.websiteClicks, current.views);
      byDate.set(row.date, current);
    }
  }
  const daily = fillDailyRange(Array.from(byDate.values()), startDate, endDate, true);

  const rawContent: InsightsContent[] = published
    .map((record): InsightsContent => {
      const slice = slices.get(record.pinId) ?? null;
      const pinMetrics = summarizePinterestSlice(slice);
      const views = readMetric(pinMetrics, "IMPRESSION");
      const saves = readMetric(pinMetrics, "SAVE");
      const clicks = readMetric(pinMetrics, "OUTBOUND_CLICK");
      const pinClicks = readMetric(pinMetrics, "PIN_CLICK");
      const comments = readMetric(pinMetrics, "TOTAL_COMMENTS");
      const reactions = readMetric(pinMetrics, "TOTAL_REACTIONS");
      return {
        id: record.pinId,
        title: record.title || `VibePin Pin ${record.pinId.slice(-6)}`,
        imageUrl: record.imageUrl,
        postUrl: record.postUrl,
        publishedAt: record.publishedAt ?? null,
        format: mediaFormat(record.mediaType),
        metrics: {
          views,
          interactions: saves + clicks + pinClicks + comments + reactions,
          saves,
          shares: 0,
          websiteClicks: clicks,
          trafficRate: trafficRate(clicks, views),
        },
        metricsAvailable: slice !== null,
        websiteClickAvailability: "pin_level",
        diagnosis: "",
      };
    })
    .sort((a, b) => {
      const clickDiff = (b.metrics.websiteClicks ?? -1) - (a.metrics.websiteClicks ?? -1);
      if (clickDiff !== 0) return clickDiff;
      return (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "");
    });

  const summary = rawContent
    .filter(item => item.metricsAvailable !== false)
    .reduce((total, item) => ({
      views: total.views + item.metrics.views,
      interactions: total.interactions + item.metrics.interactions,
      saves: total.saves + item.metrics.saves,
      shares: total.shares + item.metrics.shares,
      websiteClicks: (total.websiteClicks ?? 0) + (item.metrics.websiteClicks ?? 0),
      trafficRate: null,
    }), emptyMetrics(0));
  summary.trafficRate = trafficRate(summary.websiteClicks, summary.views);

  const missingAnalytics = rawContent.filter(item => item.metricsAvailable === false).length;
  const missingImages = rawContent.filter(item => !item.imageUrl).length;
  let warning: string | null = null;
  if (!provenance.storageAvailable) {
    warning = "VibePin publish records are temporarily unavailable. To avoid mixing in Pins we cannot verify, none are shown here.";
  } else if (published.length === 0) {
    warning = "No VibePin content has a confirmed Pinterest publish record yet. Images without a publish record are never shown here.";
  } else if (!analyticsResult.available || missingAnalytics > 0) {
    warning = `Pinterest has not returned official metrics for ${missingAnalytics || published.length} of ${published.length} published VibePin Pins yet. Those rows show — instead of a number.`;
  } else if (missingImages > 0) {
    warning = `${missingImages} confirmed VibePin Pins have no local thumbnail yet. VibePin keeps fetching them from Pinterest.`;
  }

  return {
    platform: "pinterest",
    connectionState: "ready",
    account: {
      id: account.id ?? connection.providerAccountId ?? connection.id,
      name: account.username ? `@${account.username}` : connection.providerAccountName ?? "Pinterest",
      username: account.username,
    },
    range: { startDate, endDate, days: 30 },
    summary,
    daily,
    content: attachDiagnoses("pinterest", rawContent),
    availability: {
      views: "pin_level",
      websiteClicks: "pin_level",
      message: "Shows every Pin with a confirmed VibePin publish record; drafts without one never appear here. \"Went to site\" means someone left Pinterest — it does not prove the page finished loading.",
    },
    latestAvailableAt: null,
    syncedAt: new Date().toISOString(),
    warning,
  };
}

async function buildInstagramDashboard(
  uid: string,
  connection: SocialConnection,
  startDate: string,
  endDate: string,
): Promise<InsightsDashboard> {
  if (!hasInstagramInsightsScope(connection.scopes)) {
    const dashboard = emptyDashboard("instagram", "needs_reconnect", startDate, endDate, null);
    dashboard.account = {
      id: connection.providerAccountId ?? connection.id,
      name: connection.providerAccountName ?? connection.providerAccountUsername ?? "Instagram",
      username: connection.providerAccountUsername,
    };
    dashboard.warning = "Reconnect Instagram so VibePin can read views, saves, shares and profile link taps.";
    return dashboard;
  }

  const token = await getInstagramAccessToken(uid, connection.id);
  const userId = token?.userId ?? connection.providerAccountId;
  if (!token?.accessToken || !userId) {
    const dashboard = emptyDashboard("instagram", "needs_reconnect", startDate, endDate, null);
    dashboard.warning = "This Instagram authorization is no longer valid. Please reconnect the account.";
    return dashboard;
  }

  const [viewsRow, interactionsRow, savesRow, sharesRow, profileLinksRow, media] = await Promise.all([
    fetchInstagramAccountMetric(token.accessToken, userId, "views", startDate, endDate),
    fetchInstagramAccountMetric(token.accessToken, userId, "total_interactions", startDate, endDate)
      .catch(() => null),
    fetchInstagramAccountMetric(token.accessToken, userId, "saves", startDate, endDate)
      .catch(() => null),
    fetchInstagramAccountMetric(token.accessToken, userId, "shares", startDate, endDate)
      .catch(() => null),
    fetchInstagramAccountMetric(token.accessToken, userId, "profile_links_taps", startDate, endDate)
      .catch(() => null),
    listInstagramMedia(token.accessToken, userId).catch(() => []),
  ]);

  const viewsByDay = accountMetricDaily(viewsRow);
  const interactionsByDay = accountMetricDaily(interactionsRow);
  const savesByDay = accountMetricDaily(savesRow);
  const sharesByDay = accountMetricDaily(sharesRow);
  const profileLinksByDay = accountMetricDaily(profileLinksRow);
  const daily = fillDailyRange(Array.from(new Set([
    ...viewsByDay.keys(),
    ...interactionsByDay.keys(),
    ...savesByDay.keys(),
    ...sharesByDay.keys(),
    ...profileLinksByDay.keys(),
  ])).map((date): InsightsDay => ({
    date,
    views: viewsByDay.get(date) ?? 0,
    interactions: interactionsByDay.get(date) ?? 0,
    saves: savesByDay.get(date) ?? 0,
    shares: sharesByDay.get(date) ?? 0,
    websiteClicks: profileLinksByDay.get(date) ?? 0,
    trafficRate: null,
  })), startDate, endDate, true);

  // Limit the first release to 20 recent media objects. A media insights request
  // is one Graph call per item; bounding it keeps the page below Meta rate limits.
  const recentMedia = media
    .filter(item => !item.timestamp || item.timestamp.slice(0, 10) >= startDate)
    .slice(0, 20);
  const metricResults = await Promise.allSettled(
    recentMedia.map(item => fetchInstagramMediaMetrics(token.accessToken, item.id)),
  );
  const metricById = new Map(metricResults
    .filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof fetchInstagramMediaMetrics>>> => result.status === "fulfilled")
    .map(result => [result.value.id, result.value.metrics]));

  const rawContent: InsightsContent[] = recentMedia.map((item): InsightsContent => {
    const metrics = metricById.get(item.id) ?? {};
    const saves = finiteMetric(metrics.saved);
    const shares = finiteMetric(metrics.shares);
    const comments = finiteMetric(metrics.comments);
    const likes = finiteMetric(metrics.likes);
    return {
      id: item.id,
      title: titleFromCaption(item.caption, `Instagram content ${item.id.slice(-6)}`),
      imageUrl: item.imageUrl,
      postUrl: item.permalink,
      publishedAt: item.timestamp,
      format: mediaFormat(item.mediaType),
      metrics: {
        views: finiteMetric(metrics.views || metrics.reach),
        interactions: finiteMetric(metrics.total_interactions) || likes + comments + saves + shares,
        saves,
        shares,
        websiteClicks: null,
        trafficRate: null,
      },
      websiteClickAvailability: "unavailable",
      diagnosis: "",
    };
  }).sort((a, b) => b.metrics.views - a.metrics.views);

  const summary = summarizeDays(daily, true);
  // `profile_links_taps` may be a total_value metric without daily rows.
  summary.websiteClicks = accountMetricTotal(profileLinksRow);
  summary.trafficRate = null;

  const failedMedia = metricResults.filter(result => result.status === "rejected").length;
  return {
    platform: "instagram",
    connectionState: "ready",
    account: {
      id: userId,
      name: connection.providerAccountName ?? connection.providerAccountUsername ?? "Instagram",
      username: connection.providerAccountUsername,
    },
    range: { startDate, endDate, days: 30 },
    summary,
    daily,
    content: attachDiagnoses("instagram", rawContent),
    availability: {
      views: "media_level",
      websiteClicks: "account_level",
      message: "Profile link taps are an account total for the last 30 days and cannot be attributed to one feed image. Image rows show only official media interactions.",
    },
    latestAvailableAt: null,
    syncedAt: new Date().toISOString(),
    warning: failedMedia > 0
      ? `Instagram has not returned some metrics for ${failedMedia} items. Missing data is never presented as website clicks.`
      : "Instagram image rows are lifetime media totals; the heatmap and profile link taps cover the last 30 days.",
  };
}

export async function getInsightsDashboard(
  uid: string,
  platform: InsightsPlatform,
  connectionId?: string | null,
): Promise<InsightsDashboard> {
  const startDate = utcDateDaysAgo(29);
  const endDate = utcDateDaysAgo(0);
  let connection: SocialConnection | null = null;
  try {
    const connections = (await listConnections(uid)).filter(item => item.provider === platform);
    connection = connections.find(item => item.id === connectionId)
      ?? connections.find(item => item.connectionStatus === "connected")
      ?? connections[0]
      ?? null;

    if (!connection) return emptyDashboard(platform, "not_connected", startDate, endDate, null);
    if (connection.connectionStatus !== "connected") {
      const dashboard = emptyDashboard(platform, "needs_reconnect", startDate, endDate, null);
      dashboard.account = {
        id: connection.providerAccountId ?? connection.id,
        name: connection.providerAccountName ?? connection.providerAccountUsername ?? platform,
        username: connection.providerAccountUsername,
      };
      return dashboard;
    }

    const cacheKey = `${uid}:${platform}:${connection.id}:${startDate}:${endDate}`;
    const cached = dashboardCache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

    const dashboard = await withDashboardTimeout(platform === "pinterest"
      ? buildPinterestDashboard(uid, connection, startDate, endDate, connections.map(item => item.id))
      : buildInstagramDashboard(uid, connection, startDate, endDate));
    dashboardCache.set(cacheKey, { at: Date.now(), value: dashboard });
    return dashboard;
  } catch (error) {
    const isBusinessGate = platform === "pinterest"
      && error instanceof PinterestApiError
      && error.status === 403;
    const dashboard = emptyDashboard(
      platform,
      isBusinessGate ? "business_account_required" : "unavailable",
      startDate,
      endDate,
      error instanceof InstagramInsightsError || error instanceof PinterestApiError
        ? error.message
        : "Platform data could not be read right now. Please try again shortly.",
    );
    dashboard.account = connection ? {
      id: connection.providerAccountId ?? connection.id,
      name: connection.providerAccountName ?? connection.providerAccountUsername ?? platform,
      username: connection.providerAccountUsername,
    } : null;
    return dashboard;
  }
}
