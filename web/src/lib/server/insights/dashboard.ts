import "server-only";

import {
  emptyMetrics,
  fillDailyRange,
  finiteMetric,
  attachDiagnoses,
  summarizeDays,
  utcDateDaysAgo,
} from "@/lib/insights/businessRules";
import {
  ACCOUNT_CONTENT_ROW_LIMIT,
  buildPinterestInsights,
  type CollectionSources,
} from "@/lib/insights/collectionDashboard";
import type {
  InsightsContent,
  InsightsDashboard,
  InsightsDay,
  InsightsPlatform,
  InsightsScope,
} from "@/lib/insights/types";
// PinterestApiError only — the error TYPE, for classifying a failure that happened
// elsewhere. The client itself is deliberately not imported: this module builds the
// page, and the page makes no Pinterest calls.
import { PinterestApiError } from "@/lib/server/pinterest/service";
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
import { ownerConnectionsForPins } from "./collectorStore";
import {
  loadAccountMetrics,
  loadContentMetrics,
  loadLatestFinishedRun,
  loadLatestRun,
  loadObservationHistory,
  loadRegistry,
} from "./insightsReadStore";
import { loadAccountKeywordSet } from "./keywordSetStore";
import { EMPTY_KEYWORD_SET } from "@/lib/insights/keywordSet";

const CACHE_TTL_MS = 10 * 60 * 1000;
const DASHBOARD_LOAD_TIMEOUT_MS = 20_000;
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
  scope: InsightsScope,
  state: InsightsDashboard["connectionState"],
  startDate: string,
  endDate: string,
  warning: string | null,
): InsightsDashboard {
  const websiteClicksAvailable = platform === "pinterest";
  return {
    platform,
    scope,
    connectionState: state,
    account: null,
    range: { startDate, endDate, days: 30 },
    summary: emptyMetrics(websiteClicksAvailable ? 0 : null),
    daily: fillDailyRange([], startDate, endDate, websiteClicksAvailable),
    content: [],
    unattributedContent: [],
    availability: {
      views: platform === "pinterest" ? "pin_level" : "media_level",
      websiteClicks: platform === "pinterest" ? "pin_level" : "account_level",
      message: platform === "pinterest"
        ? "Pinterest reports outbound clicks per Pin. A click means someone left Pinterest — it does not prove the page finished loading."
        : "A normal Instagram feed image has no clickable caption link. Only account-level profile link taps are available, and they cannot be assigned to one image.",
    },
    collection: null,
    diagnosis: null,
    latestAvailableAt: null,
    syncedAt: new Date().toISOString(),
    warning,
  };
}

/**
 * The readers the Pinterest dashboard is built from.
 *
 * Every one of them touches our own database. There is no Pinterest client here at
 * all any more: the last one, `loadLiveAnalytics`, served the pre-first-run fallback
 * and made up to 20 single-Pin analytics calls per account per page view, outside the
 * collector's budget and ledger. Its absence is what makes "a page request makes no
 * Pinterest API call" true by construction rather than by discipline — the account
 * name likewise comes from the stored connection row, not from
 * `getCurrentPinterestUser()`, which this file used to call on every request.
 */
function pinterestSources(
  uid: string,
  connection: SocialConnection,
  siblingConnectionIds: string[],
  startDate: string,
  endDate: string,
): CollectionSources {
  return {
    loadLatestFinishedRun: () => loadLatestFinishedRun(connection.id),
    loadLatestRun: () => loadLatestRun(connection.id),
    loadAccountMetrics: (from, to) => loadAccountMetrics(connection.id, from, to),
    loadRegistry: limit => loadRegistry(connection.id, limit),
    loadContentMetrics: (pinIds, options) => loadContentMetrics(connection.id, pinIds, options),
    loadObservationHistory: pinIds => loadObservationHistory(connection.id, pinIds),
    // The phrase set is the one reader allowed to WRITE: an inferred category is
    // persisted so tomorrow does not re-guess it, and a rebuilt set is versioned so
    // an old diagnosis stays explainable. Both writes are best effort — a page that
    // fails because a keyword set could not be stored would be trading the feature
    // for its own bookkeeping.
    loadKeywordSet: inferenceTexts => loadAccountKeywordSet({
      uid,
      connectionId: connection.id,
      metadata: connection.metadata ?? null,
      inferenceTexts,
    }).catch(error => {
      console.error("[insights] keyword set unavailable", error);
      return EMPTY_KEYWORD_SET;
    }),
    loadProvenance: async () => {
      const result = await listVibePinPublishedPinterestPins(uid);
      return { pins: Array.from(result.pins.values()), storageAvailable: result.storageAvailable };
    },
    // Scoped to the connections of this user, so ownership can never be probed
    // across accounts. A registry that is not there yet resolves to an empty map.
    loadRegistryOwners: pinIds => ownerConnectionsForPins(siblingConnectionIds, pinIds)
      .catch(() => new Map<string, string>()),
  };
}

async function buildInstagramDashboard(
  uid: string,
  connection: SocialConnection,
  startDate: string,
  endDate: string,
): Promise<InsightsDashboard> {
  if (!hasInstagramInsightsScope(connection.scopes)) {
    const dashboard = emptyDashboard("instagram", "vibepin", "needs_reconnect", startDate, endDate, null);
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
    const dashboard = emptyDashboard("instagram", "vibepin", "needs_reconnect", startDate, endDate, null);
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
    scope: "vibepin",
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
    // Instagram has no collection ledger and no registry, so there is no third
    // answer to give: a media object either came back from the account's own token
    // or it is not here at all.
    unattributedContent: [],
    availability: {
      views: "media_level",
      websiteClicks: "account_level",
      message: "Profile link taps are an account total for the last 30 days and cannot be attributed to one feed image. Image rows show only official media interactions.",
    },
    collection: null,
    // Instagram has no collection ledger, no cohorts and no keyword set of its own,
    // so there is nothing for the evidence engine to read. A diagnosis assembled from
    // a different platform data would be a guess wearing the same panel.
    diagnosis: null,
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
  scope: InsightsScope = "vibepin",
): Promise<InsightsDashboard> {
  const startDate = utcDateDaysAgo(29);
  const endDate = utcDateDaysAgo(0);
  // Instagram has no collection layer and no second scope; asking for one must not
  // silently return Pinterest-shaped emptiness under an Instagram header.
  const effectiveScope: InsightsScope = platform === "pinterest" ? scope : "vibepin";
  let connection: SocialConnection | null = null;
  try {
    const connections = (await listConnections(uid)).filter(item => item.provider === platform);
    connection = connections.find(item => item.id === connectionId)
      ?? connections.find(item => item.connectionStatus === "connected")
      ?? connections[0]
      ?? null;

    if (!connection) return emptyDashboard(platform, effectiveScope, "not_connected", startDate, endDate, null);
    if (connection.connectionStatus !== "connected") {
      const dashboard = emptyDashboard(platform, effectiveScope, "needs_reconnect", startDate, endDate, null);
      dashboard.account = {
        id: connection.providerAccountId ?? connection.id,
        name: connection.providerAccountName ?? connection.providerAccountUsername ?? platform,
        username: connection.providerAccountUsername,
      };
      return dashboard;
    }

    const cacheKey = `${uid}:${platform}:${connection.id}:${effectiveScope}:${startDate}:${endDate}`;
    const cached = dashboardCache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

    const activeConnection = connection;
    const dashboard = await withDashboardTimeout(platform === "pinterest"
      ? buildPinterestInsights({
        scope: effectiveScope,
        connection: {
          id: activeConnection.id,
          providerAccountId: activeConnection.providerAccountId,
          providerAccountName: activeConnection.providerAccountName,
          providerAccountUsername: activeConnection.providerAccountUsername,
        },
        startDate,
        endDate,
      }, pinterestSources(
        uid,
        activeConnection,
        connections.map(item => item.id),
        startDate,
        endDate,
      ))
      : buildInstagramDashboard(uid, activeConnection, startDate, endDate));
    dashboardCache.set(cacheKey, { at: Date.now(), value: dashboard });
    return dashboard;
  } catch (error) {
    const isBusinessGate = platform === "pinterest"
      && error instanceof PinterestApiError
      && error.status === 403;
    const dashboard = emptyDashboard(
      platform,
      effectiveScope,
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

/**
 * Drop every cached dashboard of one connection.
 *
 * Called when the account category changes. Without it the user picks a category,
 * the page reloads, and the ten-minute cache serves back a diagnosis measured
 * against the phrases of the category they just rejected — which reads exactly like
 * the setting not working. The cache key carries scope and date range, so the whole
 * map is scanned rather than a key guessed.
 */
export function invalidateInsightsCache(uid: string, connectionId: string): number {
  const prefix = `${uid}:pinterest:${connectionId}:`;
  let dropped = 0;
  for (const key of [...dashboardCache.keys()]) {
    if (key.startsWith(prefix)) {
      dashboardCache.delete(key);
      dropped += 1;
    }
  }
  return dropped;
}

export { ACCOUNT_CONTENT_ROW_LIMIT };
