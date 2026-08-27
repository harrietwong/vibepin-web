"use client";

import Link from "next/link";
import Image, { type ImageLoaderProps } from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import {
  ArrowRight,
  CalendarDays,
  Eye,
  ExternalLink,
  Heart,
  ImageOff,
  Link2,
  MousePointerClick,
  Share2,
} from "lucide-react";
import type {
  InsightsApiResponse,
  InsightsContent,
  InsightsDashboard,
  InsightsDay,
  InsightsPlatform,
} from "@/lib/insights/types";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { freshAccessToken, refreshSessionOnce } from "@/lib/supabaseBrowser";
import styles from "./insights.module.css";

type HeatMetric = "views" | "interactions" | "websiteClicks";
type InsightsFetchError = Error & { status?: number };
type HydratedPinMetadata = { id: string; title: string | null; imageUrl: string | null };
type Translate = (key: string) => string;

/** One connected account of the selected platform, as the switcher needs it. */
type InsightsAccountOption = {
  id: string;
  name: string;
  username: string | null;
  avatarUrl: string | null;
  connectionStatus: string;
};

/** Sentinel for the side-by-side view. Never a real connection id. */
const ALL_ACCOUNTS = "__all__";
const ACCOUNT_STORAGE_KEY = "vibepin.insights.pinterestAccount";

const WEEKDAY_KEYS = [
  "insights.weekday.sun",
  "insights.weekday.mon",
  "insights.weekday.tue",
  "insights.weekday.wed",
  "insights.weekday.thu",
  "insights.weekday.fri",
  "insights.weekday.sat",
] as const;

function remoteImageLoader({ src }: ImageLoaderProps): string {
  return src;
}

function fill(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replace(new RegExp(`\\{${key}\\}`, "g"), String(value)),
    template,
  );
}

async function authedInsightsFetch(url: string): Promise<Response> {
  let response = await fetch(url, {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (response.status === 401) {
    const token = await freshAccessToken();
    if (token) {
      response = await fetch(url, {
        cache: "no-store",
        headers: { Authorization: `Bearer ${token}` },
      });
    }
    if (response.status === 401) {
      const refreshedToken = await refreshSessionOnce();
      if (refreshedToken) {
        response = await fetch(url, {
          cache: "no-store",
          headers: { Authorization: `Bearer ${refreshedToken}` },
        });
      }
    }
  }
  return response;
}

async function insightsFetcher(url: string): Promise<InsightsApiResponse> {
  const response = await authedInsightsFetch(url);
  if (!response.ok) {
    const error = new Error(`Insights could not be loaded (${response.status})`) as InsightsFetchError;
    error.status = response.status;
    throw error;
  }
  return response.json() as Promise<InsightsApiResponse>;
}

/**
 * Connected accounts for the switcher. Reuses /api/social/connections — it
 * already returns the client-safe SocialConnection projection (never tokens),
 * so Insights needs no endpoint of its own.
 */
async function accountsFetcher(url: string): Promise<InsightsAccountOption[]> {
  const response = await authedInsightsFetch(url);
  if (!response.ok) {
    const error = new Error(`Accounts could not be loaded (${response.status})`) as InsightsFetchError;
    error.status = response.status;
    throw error;
  }
  const body = await response.json() as {
    connections?: Array<{
      id: string;
      provider: string;
      providerAccountName: string | null;
      providerAccountUsername: string | null;
      providerAccountAvatarUrl: string | null;
      connectionStatus: string;
    }>;
  };
  return (body.connections ?? [])
    .filter(item => item.provider === "pinterest")
    .map(item => ({
      id: item.id,
      name: item.providerAccountName ?? item.providerAccountUsername ?? "Pinterest",
      username: item.providerAccountUsername,
      avatarUrl: item.providerAccountAvatarUrl,
      connectionStatus: item.connectionStatus,
    }));
}

function accountHandle(account: InsightsAccountOption): string {
  return account.username ? `@${account.username}` : account.name;
}

function formatNumber(value: number | null): string {
  if (value == null) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}K`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

function formatRate(value: number | null): string {
  if (value == null) return "—";
  return `${(value * 100).toFixed(value >= .1 ? 1 : 2)}%`;
}

function metricValue(day: InsightsDay, metric: HeatMetric): number {
  if (metric === "websiteClicks") return day.websiteClicks ?? 0;
  return day[metric];
}

function clicksPer100(dashboard: InsightsDashboard): string {
  return dashboard.summary.trafficRate == null
    ? "—"
    : (dashboard.summary.trafficRate * 100).toFixed(1);
}

function MetricCard({
  icon,
  label,
  value,
  help,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  help: string;
}) {
  return (
    <div className={styles.metric}>
      <div className={styles.metricLabel}>{icon}{label}</div>
      <div className={styles.metricValue}>{value}</div>
      <div className={styles.metricHelp}>{help}</div>
    </div>
  );
}

function DashboardMetrics({ dashboard, tr }: { dashboard: InsightsDashboard; tr: Translate }) {
  const isPinterest = dashboard.platform === "pinterest";
  return (
    <div className={styles.metrics}>
      <MetricCard
        icon={<Eye size={14} />}
        label={tr("insights.metric.seen")}
        value={formatNumber(dashboard.summary.views)}
        help={tr(isPinterest ? "insights.metric.seenHelpPinterest" : "insights.metric.seenHelpInstagram")}
      />
      <MetricCard
        icon={<MousePointerClick size={14} />}
        label={tr(isPinterest ? "insights.metric.wentToWebsite" : "insights.metric.profileLinkTaps")}
        value={formatNumber(dashboard.summary.websiteClicks)}
        help={tr(isPinterest ? "insights.metric.wentToWebsiteHelp" : "insights.metric.profileLinkTapsHelp")}
      />
      <MetricCard
        icon={isPinterest ? <ArrowRight size={14} /> : <Share2 size={14} />}
        label={tr(isPinterest ? "insights.metric.clicksPer100" : "insights.metric.savedAndShared")}
        value={isPinterest
          ? clicksPer100(dashboard)
          : formatNumber(dashboard.summary.saves + dashboard.summary.shares)}
        help={tr(isPinterest ? "insights.metric.clicksPer100Help" : "insights.metric.savedAndSharedHelp")}
      />
      <MetricCard
        icon={<Heart size={14} />}
        label={tr(isPinterest ? "insights.metric.saved" : "insights.metric.contentInteractions")}
        value={formatNumber(isPinterest ? dashboard.summary.saves : dashboard.summary.interactions)}
        help={tr(isPinterest ? "insights.metric.savedHelp" : "insights.metric.contentInteractionsHelp")}
      />
    </div>
  );
}

/**
 * One account's 30-day strip. In the All-accounts view these stack as separate
 * rows: two accounts' days are never added into one cell, because a combined
 * cell would answer a question ("how did we do") that neither account can act on.
 */
function HeatmapGrid({
  dashboard,
  metric,
  tr,
}: {
  dashboard: InsightsDashboard;
  metric: HeatMetric;
  tr: Translate;
}) {
  const max = Math.max(1, ...dashboard.daily.map(day => metricValue(day, metric)));
  const firstWeekday = dashboard.daily[0]
    ? new Date(`${dashboard.daily[0].date}T00:00:00Z`).getUTCDay()
    : 0;
  const blanks = Array.from({ length: firstWeekday }, (_, index) => index);
  const metricLabel = tr(`insights.heatmap.metricLabel.${metric}`).toLowerCase();

  return (
    <div className={styles.heatmap}>
      {WEEKDAY_KEYS.map(key => <div key={key} className={styles.weekday}>{tr(key)}</div>)}
      {blanks.map(blank => <div key={`blank-${blank}`} className={styles.heatBlank} />)}
      {dashboard.daily.map(day => {
        const value = metricValue(day, metric);
        const intensity = value <= 0 ? 0 : .10 + .72 * Math.sqrt(value / max);
        const date = new Date(`${day.date}T00:00:00Z`);
        return (
          <div
            key={day.date}
            className={styles.heatCell}
            style={{ background: intensity === 0 ? "var(--app-inset)" : `rgba(124, 58, 237, ${intensity.toFixed(2)})` }}
            title={`${day.date}: ${formatNumber(value)} ${metricLabel}`}
          >
            <span className={styles.heatDate}>{date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}</span>
            <span className={styles.heatValue}>{formatNumber(value)}</span>
          </div>
        );
      })}
    </div>
  );
}

function HeatmapLegend({ tr }: { tr: Translate }) {
  return (
    <div className={styles.legend}>
      {tr("insights.heatmap.legendLess")}
      {[.06, .2, .38, .58, .82].map(alpha => (
        <span key={alpha} className={styles.legendBox} style={{ background: `rgba(124, 58, 237, ${alpha})` }} />
      ))}
      {tr("insights.heatmap.legendMore")}
    </div>
  );
}

function MetricToggle({
  dashboards,
  metric,
  setMetric,
  tr,
}: {
  dashboards: InsightsDashboard[];
  metric: HeatMetric;
  setMetric: (next: HeatMetric) => void;
  tr: Translate;
}) {
  const anyPinterest = dashboards.some(item => item.platform === "pinterest");
  const options: Array<[HeatMetric, string]> = [
    ["views", tr("insights.heatmap.seen")],
    ["interactions", tr("insights.heatmap.interacted")],
    ...(anyPinterest ? [["websiteClicks", tr("insights.heatmap.wentToSite")] as [HeatMetric, string]] : []),
  ];
  return (
    <div className={styles.metricToggle} aria-label={tr("insights.heatmap.metricAria")}>
      {options.map(([value, label]) => (
        <button
          key={value}
          type="button"
          className={`${styles.toggleButton} ${metric === value ? styles.toggleButtonActive : ""}`}
          onClick={() => setMetric(value)}
          aria-pressed={metric === value}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Single-account heatmap: one strip, unchanged from the single-account page. */
function Heatmap({ dashboard, tr }: { dashboard: InsightsDashboard; tr: Translate }) {
  const [metric, setMetric] = useState<HeatMetric>("views");
  const effectiveMetric = dashboard.platform === "instagram" && metric === "websiteClicks"
    ? "views"
    : metric;
  const metricLabel = tr(`insights.heatmap.metricLabel.${effectiveMetric}`).toLowerCase();

  return (
    <section className={styles.panel}>
      <div className={styles.panelHeader}>
        <div>
          <h2 className={styles.panelTitle}>{tr("insights.heatmap.title")}</h2>
          <p className={styles.panelHelp}>{fill(tr("insights.heatmap.help"), { metric: metricLabel })}</p>
        </div>
        <MetricToggle dashboards={[dashboard]} metric={effectiveMetric} setMetric={setMetric} tr={tr} />
      </div>
      <div className={styles.heatmapWrap}>
        <HeatmapGrid dashboard={dashboard} metric={effectiveMetric} tr={tr} />
        <HeatmapLegend tr={tr} />
      </div>
    </section>
  );
}

/** All-accounts heatmap: one labelled strip per account, stacked — never overlaid. */
function MultiAccountHeatmap({
  entries,
  tr,
}: {
  entries: Array<{ account: InsightsAccountOption; dashboard: InsightsDashboard }>;
  tr: Translate;
}) {
  const [metric, setMetric] = useState<HeatMetric>("views");
  const metricLabel = tr(`insights.heatmap.metricLabel.${metric}`).toLowerCase();

  return (
    <section className={styles.panel}>
      <div className={styles.panelHeader}>
        <div>
          <h2 className={styles.panelTitle}>{tr("insights.heatmap.title")}</h2>
          <p className={styles.panelHelp}>
            {fill(tr("insights.heatmap.help"), { metric: metricLabel })} {tr("insights.heatmap.perAccountHelp")}
          </p>
        </div>
        <MetricToggle
          dashboards={entries.map(entry => entry.dashboard)}
          metric={metric}
          setMetric={setMetric}
          tr={tr}
        />
      </div>
      <div className={styles.heatmapWrap}>
        {entries.map(({ account, dashboard }) => (
          <div key={account.id} className={styles.heatmapRow}>
            <div className={styles.heatmapRowLabel}>{accountHandle(account)}</div>
            <HeatmapGrid dashboard={dashboard} metric={metric} tr={tr} />
          </div>
        ))}
        <HeatmapLegend tr={tr} />
      </div>
    </section>
  );
}

function ContentRow({
  item,
  platform,
  accountLabel,
  tr,
}: {
  item: InsightsContent;
  platform: InsightsPlatform;
  /** Present only in the All-accounts view, where a row's owner is not obvious. */
  accountLabel: string | null;
  tr: Translate;
}) {
  const metricsAvailable = item.metricsAvailable !== false;
  return (
    <tr>
      <td>
        <div className={styles.contentCell}>
          <div className={styles.thumb}>
            {item.imageUrl ? (
              <Image
                loader={remoteImageLoader}
                unoptimized
                src={item.imageUrl}
                alt=""
                width={46}
                height={56}
              />
            ) : (
              <span
                className={styles.thumbFallback}
                title={tr("insights.content.previewUnavailable")}
                aria-label={tr("insights.content.previewUnavailable")}
              >
                <ImageOff size={15} />
              </span>
            )}
          </div>
          <div>
            <div className={styles.contentTitle}>{item.title}</div>
            <div className={styles.diagnosis}>{item.diagnosis}</div>
          </div>
        </div>
      </td>
      {accountLabel !== null ? <td className={styles.accountCell}>{accountLabel}</td> : null}
      <td>{metricsAvailable ? formatNumber(item.metrics.views) : "—"}</td>
      <td>{metricsAvailable ? formatNumber(platform === "pinterest" ? item.metrics.saves : item.metrics.saves + item.metrics.shares) : "—"}</td>
      <td>
        {!metricsAvailable
          ? <span className={styles.mutedMetric}>{tr("insights.content.awaitingPinterest")}</span>
          : item.metrics.websiteClicks == null
          ? <span className={styles.mutedMetric}>{tr("insights.content.notAvailableForFeedImages")}</span>
          : <span className={styles.positiveMetric}>{formatNumber(item.metrics.websiteClicks)}</span>}
      </td>
      <td>{metricsAvailable ? formatRate(item.metrics.trafficRate) : "—"}</td>
      <td>
        {item.postUrl ? (
          <Link href={item.postUrl} target="_blank" rel="noreferrer" aria-label={tr("insights.content.openPost")}>
            <ExternalLink size={15} color="var(--app-text-muted)" />
          </Link>
        ) : "—"}
      </td>
    </tr>
  );
}

type ContentTableRow = {
  key: string;
  item: InsightsContent;
  platform: InsightsPlatform;
  accountId: string | null;
  accountLabel: string | null;
};

function ContentTable({
  rows,
  platform,
  totalPinCount,
  hydratedPins,
  accounts,
  showAccountColumn,
  tr,
}: {
  rows: ContentTableRow[];
  platform: InsightsPlatform;
  totalPinCount: number;
  hydratedPins: Record<string, HydratedPinMetadata>;
  /** Accounts offered in the row filter. Empty in single-account mode. */
  accounts: InsightsAccountOption[];
  showAccountColumn: boolean;
  tr: Translate;
}) {
  const [accountFilter, setAccountFilter] = useState<string>(ALL_ACCOUNTS);
  const isPinterest = platform === "pinterest";
  const visibleRows = accountFilter === ALL_ACCOUNTS
    ? rows
    : rows.filter(row => row.accountId === accountFilter);

  return (
    <section className={styles.panel}>
      <div className={styles.panelHeader}>
        <div>
          <h2 className={styles.panelTitle}>{tr("insights.content.title")}</h2>
          <p className={styles.panelHelp}>
            {isPinterest
              ? fill(tr("insights.content.helpPinterest"), { count: totalPinCount })
              : tr("insights.content.helpInstagram")}
          </p>
        </div>
        {showAccountColumn && accounts.length > 1 ? (
          <label className={styles.filterLabel}>
            <span className="sr-only">{tr("insights.content.filterAccount")}</span>
            <select
              className={styles.select}
              value={accountFilter}
              onChange={event => setAccountFilter(event.target.value)}
            >
              <option value={ALL_ACCOUNTS}>{tr("insights.content.filterAllAccounts")}</option>
              {accounts.map(account => (
                <option key={account.id} value={account.id}>{accountHandle(account)}</option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      {visibleRows.length === 0 ? (
        <div className={styles.empty} style={{ minHeight: 190 }}>
          <div>
            <h2>{tr(isPinterest ? "insights.content.emptyPinterestTitle" : "insights.content.emptyInstagramTitle")}</h2>
            <p>{tr(isPinterest ? "insights.content.emptyPinterestBody" : "insights.content.emptyInstagramBody")}</p>
          </div>
        </div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>{tr("insights.content.colContent")}</th>
                {showAccountColumn ? <th>{tr("insights.content.colAccount")}</th> : null}
                <th>{tr("insights.content.colSeen")}</th>
                <th>{tr(isPinterest ? "insights.content.colSaved" : "insights.content.colSavedShared")}</th>
                <th>{tr(isPinterest ? "insights.content.colWentToSite" : "insights.content.colWebsiteClicks")}</th>
                <th>{tr("insights.content.colTrafficRate")}</th>
                <th>{tr("insights.content.colPost")}</th>
              </tr>
            </thead>
            <tbody>{visibleRows.map(row => {
              const hydrated = hydratedPins[row.item.id];
              const displayItem = hydrated ? {
                ...row.item,
                title: hydrated.title || row.item.title,
                imageUrl: hydrated.imageUrl || row.item.imageUrl,
              } : row.item;
              return (
                <ContentRow
                  key={row.key}
                  item={displayItem}
                  platform={row.platform}
                  accountLabel={showAccountColumn ? row.accountLabel : null}
                  tr={tr}
                />
              );
            })}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function EmptyState({ dashboard, tr }: { dashboard: InsightsDashboard; tr: Translate }) {
  const isPinterest = dashboard.platform === "pinterest";
  const reconnect = dashboard.connectionState === "needs_reconnect";
  const settingsHref = isPinterest ? "/app/settings/pinterest" : "/app/settings/social";
  const title = dashboard.connectionState === "business_account_required"
    ? tr("insights.state.businessRequired")
    : reconnect
      ? tr(isPinterest ? "insights.state.reconnectPinterest" : "insights.state.reconnectInstagram")
      : dashboard.connectionState === "not_connected"
        ? tr(isPinterest ? "insights.state.connectPinterest" : "insights.state.connectInstagram")
        : tr("insights.state.unavailable");
  return (
    <section className={styles.panel}>
      <div className={styles.empty}>
        <div>
          <div className={styles.emptyIcon}><Link2 size={22} /></div>
          <h2>{title}</h2>
          <p>{dashboard.warning || tr(isPinterest
            ? "insights.state.connectPinterestBody"
            : "insights.state.connectInstagramBody")}</p>
          <Link href={settingsHref} className={styles.connectLink}>
            {tr("insights.state.openSettings")} <ArrowRight size={14} />
          </Link>
        </div>
      </div>
    </section>
  );
}

/**
 * One account's summary in the All-accounts view.
 *
 * These sit side by side and are deliberately NOT summed. Two Pinterest
 * accounts usually serve different audiences; a combined "12K seen" hides
 * which brand actually earned it and is not a number anyone can act on. A
 * failing account renders its own error card so one bad token cannot blank
 * the whole page.
 */
function AccountSummaryCard({
  account,
  dashboard,
  loading,
  failed,
  tr,
}: {
  account: InsightsAccountOption;
  dashboard: InsightsDashboard | null;
  loading: boolean;
  failed: boolean;
  tr: Translate;
}) {
  return (
    <article className={styles.accountCard}>
      <header className={styles.accountCardHeader}>
        {account.avatarUrl ? (
          <Image
            loader={remoteImageLoader}
            unoptimized
            src={account.avatarUrl}
            alt=""
            width={28}
            height={28}
            className={styles.accountAvatar}
          />
        ) : <span className={styles.accountAvatarFallback} aria-hidden="true" />}
        <span className={styles.accountCardHandle}>{accountHandle(account)}</span>
      </header>

      {loading ? (
        <div className={`${styles.accountCardBody} ${styles.skeleton}`} />
      ) : failed || !dashboard ? (
        <div className={styles.accountCardError}>
          <strong>{tr("insights.state.accountFailed")}</strong>
          <span>{tr("insights.state.accountFailedBody")}</span>
        </div>
      ) : (
        <>
          <div className={styles.accountCardBody}>
            <div className={styles.accountStat}>
              <span className={styles.accountStatLabel}>{tr("insights.metric.seen")}</span>
              <span className={styles.accountStatValue}>{formatNumber(dashboard.summary.views)}</span>
            </div>
            <div className={styles.accountStat}>
              <span className={styles.accountStatLabel}>{tr("insights.metric.saved")}</span>
              <span className={styles.accountStatValue}>{formatNumber(dashboard.summary.saves)}</span>
            </div>
            <div className={styles.accountStat}>
              <span className={styles.accountStatLabel}>{tr("insights.metric.wentToWebsite")}</span>
              <span className={styles.accountStatValue}>{formatNumber(dashboard.summary.websiteClicks)}</span>
            </div>
            <div className={styles.accountStat}>
              <span className={styles.accountStatLabel}>{tr("insights.metric.clicksPer100")}</span>
              <span className={styles.accountStatValue}>{clicksPer100(dashboard)}</span>
            </div>
          </div>
          {dashboard.warning || dashboard.availability.message ? (
            <p className={styles.accountCardNote}>
              {dashboard.warning || dashboard.availability.message}
            </p>
          ) : null}
        </>
      )}
    </article>
  );
}

/**
 * Loads one account's dashboard. One hook per account keeps each request (and
 * each failure) isolated: SWR dedupes and runs them in parallel, and a rejected
 * account surfaces on its own card instead of failing the page.
 */
function useAccountDashboard(platform: InsightsPlatform, connectionId: string | null) {
  return useSWR<InsightsApiResponse>(
    connectionId ? `/api/insights?platform=${platform}&connectionId=${encodeURIComponent(connectionId)}&v=8` : null,
    insightsFetcher,
    { revalidateOnFocus: false, keepPreviousData: false, shouldRetryOnError: false },
  );
}

function AccountCardLoader({
  account,
  platform,
  tr,
  onLoaded,
}: {
  account: InsightsAccountOption;
  platform: InsightsPlatform;
  tr: Translate;
  onLoaded: (accountId: string, dashboard: InsightsDashboard | null) => void;
}) {
  const { data, error, isLoading } = useAccountDashboard(platform, account.id);
  const dashboard = data?.dashboard ?? null;

  useEffect(() => {
    if (isLoading) return;
    onLoaded(account.id, dashboard);
  }, [account.id, dashboard, isLoading, onLoaded]);

  return (
    <AccountSummaryCard
      account={account}
      dashboard={dashboard}
      loading={isLoading}
      failed={Boolean(error)}
      tr={tr}
    />
  );
}

export default function InsightsPage() {
  const { t } = useLocale();
  const tr = t as unknown as Translate;
  const [platform, setPlatform] = useState<InsightsPlatform>("pinterest");
  const [selectedAccount, setSelectedAccount] = useState<string>(ALL_ACCOUNTS);
  const [hydratedPins, setHydratedPins] = useState<Record<string, HydratedPinMetadata>>({});
  // Dashboards collected from the per-account cards, so the merged content
  // table and the stacked heatmap reuse the same fetches the cards already made.
  const [accountDashboards, setAccountDashboards] = useState<Record<string, InsightsDashboard | null>>({});

  const { data: accountList } = useSWR<InsightsAccountOption[]>(
    platform === "pinterest" ? "/api/social/connections" : null,
    accountsFetcher,
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );
  const accounts = useMemo(() => accountList ?? [], [accountList]);
  // The switcher is a Pinterest-only affordance: Instagram keeps the plain
  // platform select until it has a real multi-account story of its own.
  const multiAccount = platform === "pinterest" && accounts.length > 1;
  const allAccountsView = multiAccount && selectedAccount === ALL_ACCOUNTS;

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(ACCOUNT_STORAGE_KEY);
      if (stored) setSelectedAccount(stored);
    } catch {
      // A blocked localStorage must never keep Insights from rendering.
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(ACCOUNT_STORAGE_KEY, selectedAccount);
    } catch {
      // Persisting the last account is a convenience, never a requirement.
    }
  }, [selectedAccount]);

  // A stored id for an account that has since been disconnected must fall back
  // to All accounts rather than requesting a connection the user no longer has.
  useEffect(() => {
    if (selectedAccount === ALL_ACCOUNTS) return;
    if (accounts.length === 0) return;
    if (!accounts.some(account => account.id === selectedAccount)) setSelectedAccount(ALL_ACCOUNTS);
  }, [accounts, selectedAccount]);

  const singleConnectionId = multiAccount && selectedAccount !== ALL_ACCOUNTS ? selectedAccount : null;
  const singleQuery = `/api/insights?platform=${platform}${
    singleConnectionId ? `&connectionId=${encodeURIComponent(singleConnectionId)}` : ""
  }&v=8`;
  const { data, error, isLoading: loading } = useSWR<InsightsApiResponse>(
    allAccountsView ? null : singleQuery,
    insightsFetcher,
    { revalidateOnFocus: false, keepPreviousData: false, shouldRetryOnError: false },
  );
  const dashboard = data?.dashboard ?? null;
  const unauthorized = (error as InsightsFetchError | undefined)?.status === 401;

  const handleAccountLoaded = useCallback((accountId: string, loaded: InsightsDashboard | null) => {
    setAccountDashboards(current => (current[accountId] === loaded
      ? current
      : { ...current, [accountId]: loaded }));
  }, []);

  const readyEntries = useMemo(
    () => accounts
      .map(account => ({ account, dashboard: accountDashboards[account.id] ?? null }))
      .filter((entry): entry is { account: InsightsAccountOption; dashboard: InsightsDashboard } =>
        entry.dashboard !== null && entry.dashboard.connectionState === "ready"),
    [accounts, accountDashboards],
  );

  // Merged rows for the All-accounts table. Rows are concatenated and tagged
  // with their owner — never merged by Pin id and never summed across accounts.
  const mergedRows = useMemo<ContentTableRow[]>(
    () => readyEntries.flatMap(({ account, dashboard: accountDashboard }) =>
      accountDashboard.content.map(item => ({
        key: `${account.id}:${item.id}`,
        item,
        platform: accountDashboard.platform,
        accountId: account.id,
        accountLabel: accountHandle(account),
      }))),
    [readyEntries],
  );

  const singleRows = useMemo<ContentTableRow[]>(
    () => (dashboard?.content ?? []).map(item => ({
      key: item.id,
      item,
      platform: dashboard!.platform,
      accountId: singleConnectionId,
      accountLabel: null,
    })),
    [dashboard, singleConnectionId],
  );

  const accountLabel = useMemo(() => {
    if (allAccountsView) return tr("insights.accounts.all");
    return dashboard?.account?.name ?? tr("insights.connectedAccount");
  }, [allAccountsView, dashboard, tr]);

  const ready = dashboard?.connectionState === "ready";

  // Pins whose thumbnail is missing locally, paired with the account whose token
  // can actually read them — a Pin is only visible to the account that owns it,
  // so the owning connection id is required, never optional. With one connected
  // account the selection is implicit, so resolve it from the account list
  // rather than letting the server pick a default on our behalf.
  const soleConnectionId = accounts.length === 1 ? accounts[0].id : null;
  const activeConnectionId = singleConnectionId ?? soleConnectionId;
  const hydrationTargets = useMemo<Array<{ connectionId: string; ids: string[] }>>(() => {
    if (platform !== "pinterest") return [];
    if (allAccountsView) {
      return readyEntries
        .map(({ account, dashboard: accountDashboard }) => ({
          connectionId: account.id,
          ids: accountDashboard.content.filter(item => !item.imageUrl).map(item => item.id),
        }))
        .filter(target => target.ids.length > 0);
    }
    if (!dashboard || dashboard.connectionState !== "ready") return [];
    // Without a known owning account we cannot ask for previews honestly, so we
    // skip hydration and keep the placeholder rather than guess an account.
    if (!activeConnectionId) return [];
    const ids = dashboard.content.filter(item => !item.imageUrl).map(item => item.id);
    return ids.length > 0 ? [{ connectionId: activeConnectionId, ids }] : [];
  }, [platform, allAccountsView, readyEntries, dashboard, activeConnectionId]);

  const hydrationKey = useMemo(
    () => hydrationTargets.map(target => `${target.connectionId}:${target.ids.join(",")}`).join("|"),
    [hydrationTargets],
  );

  useEffect(() => {
    if (hydrationTargets.length === 0) return;
    let cancelled = false;
    const hydrate = async () => {
      for (const target of hydrationTargets) {
        for (let index = 0; index < target.ids.length && !cancelled; index += 10) {
          const ids = target.ids.slice(index, index + 10);
          try {
            const response = await authedInsightsFetch(
              `/api/insights/pinterest-pins?ids=${encodeURIComponent(ids.join(","))}`
              + `&connectionId=${encodeURIComponent(target.connectionId)}`,
            );
            if (!response.ok) continue;
            const body = await response.json() as { items?: HydratedPinMetadata[] };
            if (cancelled || !body.items?.length) continue;
            setHydratedPins(current => {
              const next = { ...current };
              for (const item of body.items ?? []) next[item.id] = item;
              return next;
            });
          } catch {
            // A missing preview must never hide the Pin's real analytics row.
          }
        }
      }
    };
    hydrate();
    return () => { cancelled = true; };
    // hydrationKey collapses the target list to a stable identity so this does
    // not re-run on every render that rebuilds an equivalent array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrationKey]);

  const subtitle = allAccountsView
    ? `${fill(tr("insights.accounts.subtitleAll"), { n: accounts.length })} · ${tr("insights.subtitleSuffix")}`
    : `${accountLabel} · ${tr("insights.subtitleSuffix")}`;

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>{tr("insights.eyebrow")}</p>
            <h1 className={styles.title}>{tr("insights.title")}</h1>
            <p className={styles.subtitle}>{subtitle}</p>
          </div>
          <div className={styles.controls}>
            <label>
              <span className="sr-only">{tr("insights.platformLabel")}</span>
              <select
                className={styles.select}
                value={platform}
                onChange={event => setPlatform(event.target.value as InsightsPlatform)}
              >
                <option value="pinterest">{tr("insights.platform.pinterest")}</option>
                <option value="instagram">{tr("insights.platform.instagram")}</option>
              </select>
            </label>
            <span className={styles.period}><CalendarDays size={14} /> {tr("insights.period")}</span>
          </div>
        </header>

        {multiAccount ? (
          <div className={styles.accountSwitcher} role="group" aria-label={tr("insights.accounts.label")}>
            <button
              type="button"
              className={`${styles.accountChip} ${selectedAccount === ALL_ACCOUNTS ? styles.accountChipActive : ""}`}
              onClick={() => setSelectedAccount(ALL_ACCOUNTS)}
              aria-pressed={selectedAccount === ALL_ACCOUNTS}
            >
              {tr("insights.accounts.all")}
            </button>
            {accounts.map(account => (
              <button
                key={account.id}
                type="button"
                className={`${styles.accountChip} ${selectedAccount === account.id ? styles.accountChipActive : ""}`}
                onClick={() => setSelectedAccount(account.id)}
                aria-pressed={selectedAccount === account.id}
              >
                {account.avatarUrl ? (
                  <Image
                    loader={remoteImageLoader}
                    unoptimized
                    src={account.avatarUrl}
                    alt=""
                    width={18}
                    height={18}
                    className={styles.accountChipAvatar}
                  />
                ) : null}
                {accountHandle(account)}
                {account.connectionStatus !== "connected"
                  ? <span className={styles.accountChipWarning}>{tr("insights.accounts.needsReconnect")}</span>
                  : null}
              </button>
            ))}
          </div>
        ) : null}

        {allAccountsView ? (
          <>
            <div className={styles.notice}>
              <MousePointerClick size={16} style={{ flex: "0 0 auto", marginTop: 1 }} />
              <span>{tr("insights.accounts.allHelp")}</span>
            </div>
            <div className={styles.accountCards}>
              {accounts.map(account => (
                <AccountCardLoader
                  key={account.id}
                  account={account}
                  platform={platform}
                  tr={tr}
                  onLoaded={handleAccountLoaded}
                />
              ))}
            </div>
            {readyEntries.length > 0 ? (
              <>
                <MultiAccountHeatmap entries={readyEntries} tr={tr} />
                <ContentTable
                  rows={mergedRows}
                  platform={platform}
                  totalPinCount={mergedRows.length}
                  hydratedPins={hydratedPins}
                  accounts={readyEntries.map(entry => entry.account)}
                  showAccountColumn
                  tr={tr}
                />
              </>
            ) : null}
          </>
        ) : loading ? (
          <div className={styles.metrics}>
            {[0, 1, 2, 3].map(item => <div key={item} className={`${styles.metric} ${styles.skeleton}`} />)}
          </div>
        ) : dashboard ? (
          <>
            <div className={styles.notice}>
              <MousePointerClick size={16} style={{ flex: "0 0 auto", marginTop: 1 }} />
              <span>
                {dashboard.availability.message}
                {dashboard.warning ? ` ${dashboard.warning}` : ""}
              </span>
            </div>
            {ready ? (
              <>
                <DashboardMetrics dashboard={dashboard} tr={tr} />
                <Heatmap dashboard={dashboard} tr={tr} />
                <ContentTable
                  rows={singleRows}
                  platform={dashboard.platform}
                  totalPinCount={dashboard.content.length}
                  hydratedPins={hydratedPins}
                  accounts={[]}
                  showAccountColumn={false}
                  tr={tr}
                />
              </>
            ) : <EmptyState dashboard={dashboard} tr={tr} />}
          </>
        ) : unauthorized ? (
          <section className={styles.panel}>
            <div className={styles.empty}>
              <div>
                <div className={styles.emptyIcon}><Link2 size={22} /></div>
                <h2>{tr("insights.state.signInTitle")}</h2>
                <p>{tr("insights.state.signInBody")}</p>
                <Link href="/login?next=/app/insights" className={styles.connectLink}>
                  {tr("insights.state.signIn")} <ArrowRight size={14} />
                </Link>
              </div>
            </div>
          </section>
        ) : error ? (
          <section className={styles.panel}>
            <div className={styles.empty}>
              <div>
                <h2>{tr("insights.state.loadFailedTitle")}</h2>
                <p>{tr("insights.state.loadFailedBody")}</p>
              </div>
            </div>
          </section>
        ) : null}
      </div>
    </main>
  );
}
