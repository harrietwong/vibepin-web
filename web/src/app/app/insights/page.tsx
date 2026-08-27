"use client";

import Link from "next/link";
import Image, { type ImageLoaderProps } from "next/image";
import { useEffect, useMemo, useState } from "react";
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
import { freshAccessToken, refreshSessionOnce } from "@/lib/supabaseBrowser";
import styles from "./insights.module.css";

type HeatMetric = "views" | "interactions" | "websiteClicks";
type InsightsFetchError = Error & { status?: number };
type HydratedPinMetadata = { id: string; title: string | null; imageUrl: string | null };

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function remoteImageLoader({ src }: ImageLoaderProps): string {
  return src;
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

function DashboardMetrics({ dashboard }: { dashboard: InsightsDashboard }) {
  const isPinterest = dashboard.platform === "pinterest";
  return (
    <div className={styles.metrics}>
      <MetricCard
        icon={<Eye size={14} />}
        label="Seen"
        value={formatNumber(dashboard.summary.views)}
        help={isPinterest ? "Times your Pins appeared on screen" : "Times your Instagram content was viewed"}
      />
      <MetricCard
        icon={<MousePointerClick size={14} />}
        label={isPinterest ? "Went to website" : "Profile link taps"}
        value={formatNumber(dashboard.summary.websiteClicks)}
        help={isPinterest ? "Clicks that left Pinterest" : "Account total — not tied to one image"}
      />
      <MetricCard
        icon={isPinterest ? <ArrowRight size={14} /> : <Share2 size={14} />}
        label={isPinterest ? "Clicks per 100 views" : "Saved & shared"}
        value={isPinterest
          ? (dashboard.summary.trafficRate == null ? "—" : (dashboard.summary.trafficRate * 100).toFixed(1))
          : formatNumber(dashboard.summary.saves + dashboard.summary.shares)}
        help={isPinterest ? "Your traffic rate, shown as a simple count" : "Strong signals that people want to keep the content"}
      />
      <MetricCard
        icon={<Heart size={14} />}
        label={isPinterest ? "Saved" : "Content interactions"}
        value={formatNumber(isPinterest ? dashboard.summary.saves : dashboard.summary.interactions)}
        help={isPinterest ? "People who kept a Pin for later" : "Likes, comments, saves and shares"}
      />
    </div>
  );
}

function Heatmap({ dashboard }: { dashboard: InsightsDashboard }) {
  const [metric, setMetric] = useState<HeatMetric>("views");
  const effectiveMetric = dashboard.platform === "instagram" && metric === "websiteClicks"
    ? "views"
    : metric;

  const max = Math.max(1, ...dashboard.daily.map(day => metricValue(day, effectiveMetric)));
  const firstWeekday = dashboard.daily[0]
    ? new Date(`${dashboard.daily[0].date}T00:00:00Z`).getUTCDay()
    : 0;
  const blanks = Array.from({ length: firstWeekday }, (_, index) => index);
  const metricLabel = effectiveMetric === "views" ? "Seen" : effectiveMetric === "interactions" ? "Interactions" : "Website clicks";

  return (
    <section className={styles.panel}>
      <div className={styles.panelHeader}>
        <div>
          <h2 className={styles.panelTitle}>Your last 30 days</h2>
          <p className={styles.panelHelp}>Darker days brought more {metricLabel.toLowerCase()}.</p>
        </div>
        <div className={styles.metricToggle} aria-label="Heatmap metric">
          {([
            ["views", "Seen"],
            ["interactions", "Interacted"],
            ...(dashboard.platform === "pinterest" ? [["websiteClicks", "Went to site"]] : []),
          ] as Array<[HeatMetric, string]>).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`${styles.toggleButton} ${effectiveMetric === value ? styles.toggleButtonActive : ""}`}
              onClick={() => setMetric(value)}
              aria-pressed={effectiveMetric === value}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.heatmapWrap}>
        <div className={styles.heatmap}>
          {WEEKDAYS.map(day => <div key={day} className={styles.weekday}>{day}</div>)}
          {blanks.map(blank => <div key={`blank-${blank}`} className={styles.heatBlank} />)}
          {dashboard.daily.map(day => {
            const value = metricValue(day, effectiveMetric);
            const intensity = value <= 0 ? 0 : .10 + .72 * Math.sqrt(value / max);
            const date = new Date(`${day.date}T00:00:00Z`);
            return (
              <div
                key={day.date}
                className={styles.heatCell}
                style={{ background: intensity === 0 ? "var(--app-inset)" : `rgba(124, 58, 237, ${intensity.toFixed(2)})` }}
                title={`${day.date}: ${formatNumber(value)} ${metricLabel.toLowerCase()}`}
              >
                <span className={styles.heatDate}>{date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}</span>
                <span className={styles.heatValue}>{formatNumber(value)}</span>
              </div>
            );
          })}
        </div>
        <div className={styles.legend}>
          Less
          {[.06, .2, .38, .58, .82].map(alpha => (
            <span key={alpha} className={styles.legendBox} style={{ background: `rgba(124, 58, 237, ${alpha})` }} />
          ))}
          More
        </div>
      </div>
    </section>
  );
}

function ContentRow({ item, platform }: { item: InsightsContent; platform: InsightsPlatform }) {
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
              <span className={styles.thumbFallback} title="Published Pin — preview unavailable" aria-label="Published Pin — preview unavailable">
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
      <td>{metricsAvailable ? formatNumber(item.metrics.views) : "—"}</td>
      <td>{metricsAvailable ? formatNumber(platform === "pinterest" ? item.metrics.saves : item.metrics.saves + item.metrics.shares) : "—"}</td>
      <td>
        {!metricsAvailable
          ? <span className={styles.mutedMetric}>Awaiting<br />Pinterest</span>
          : item.metrics.websiteClicks == null
          ? <span className={styles.mutedMetric}>Not available<br />for feed images</span>
          : <span className={styles.positiveMetric}>{formatNumber(item.metrics.websiteClicks)}</span>}
      </td>
      <td>{metricsAvailable ? formatRate(item.metrics.trafficRate) : "—"}</td>
      <td>
        {item.postUrl ? (
          <Link href={item.postUrl} target="_blank" rel="noreferrer" aria-label="Open post">
            <ExternalLink size={15} color="var(--app-text-muted)" />
          </Link>
        ) : "—"}
      </td>
    </tr>
  );
}

function ContentTable({
  dashboard,
  hydratedPins,
}: {
  dashboard: InsightsDashboard;
  hydratedPins: Record<string, HydratedPinMetadata>;
}) {
  const isPinterest = dashboard.platform === "pinterest";
  return (
    <section className={styles.panel}>
      <div className={styles.panelHeader}>
        <div>
          <h2 className={styles.panelTitle}>Content performance</h2>
          <p className={styles.panelHelp}>
            {isPinterest
              ? `All ${dashboard.content.length} Pins verified from VibePin publish records. Metrics cover the selected 30 days.`
              : "Recent images and videos. Website clicks cannot be assigned to a normal feed image."}
          </p>
        </div>
      </div>
      {dashboard.content.length === 0 ? (
        <div className={styles.empty} style={{ minHeight: 190 }}>
          <div>
            <h2>{isPinterest ? "No published VibePin Pins yet" : "No content data yet"}</h2>
            <p>{isPinterest
              ? "Only Pins with a successful VibePin publish record appear here."
              : "Publish content on this account, then return here after the platform has processed its insights."}</p>
          </div>
        </div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Content</th>
                <th>Seen</th>
                <th>{isPinterest ? "Saved" : "Saved / shared"}</th>
                <th>{isPinterest ? "Went to site" : "Website clicks"}</th>
                <th>Traffic rate</th>
                <th>Post</th>
              </tr>
            </thead>
            <tbody>{dashboard.content.map(item => {
              const hydrated = hydratedPins[item.id];
              const displayItem = hydrated ? {
                ...item,
                title: hydrated.title || item.title,
                imageUrl: hydrated.imageUrl || item.imageUrl,
              } : item;
              return <ContentRow key={item.id} item={displayItem} platform={dashboard.platform} />;
            })}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function EmptyState({ dashboard }: { dashboard: InsightsDashboard }) {
  const isPinterest = dashboard.platform === "pinterest";
  const reconnect = dashboard.connectionState === "needs_reconnect";
  const settingsHref = isPinterest ? "/app/settings/pinterest" : "/app/settings/social";
  const title = dashboard.connectionState === "business_account_required"
    ? "Pinterest Business account needed"
    : reconnect
      ? `Reconnect ${isPinterest ? "Pinterest" : "Instagram"}`
      : dashboard.connectionState === "not_connected"
        ? `Connect ${isPinterest ? "Pinterest" : "Instagram"}`
        : "Insights are temporarily unavailable";
  return (
    <section className={styles.panel}>
      <div className={styles.empty}>
        <div>
          <div className={styles.emptyIcon}><Link2 size={22} /></div>
          <h2>{title}</h2>
          <p>{dashboard.warning || (isPinterest
            ? "Connect a Pinterest Business account to see per-Pin views, saves, website clicks and traffic rate."
            : "Connect an Instagram Business or Creator account to see media views, saves, shares and account-level profile link taps.")}</p>
          <Link href={settingsHref} className={styles.connectLink}>
            Open account settings <ArrowRight size={14} />
          </Link>
        </div>
      </div>
    </section>
  );
}

export default function InsightsPage() {
  const [platform, setPlatform] = useState<InsightsPlatform>("pinterest");
  const [hydratedPins, setHydratedPins] = useState<Record<string, HydratedPinMetadata>>({});
  const { data, error, isLoading: loading } = useSWR<InsightsApiResponse>(
    `/api/insights?platform=${platform}&v=7`,
    insightsFetcher,
    { revalidateOnFocus: false, keepPreviousData: false, shouldRetryOnError: false },
  );
  const dashboard = data?.dashboard ?? null;
  const unauthorized = (error as InsightsFetchError | undefined)?.status === 401;

  const accountLabel = useMemo(() => dashboard?.account?.name ?? "Connected account", [dashboard]);
  const ready = dashboard?.connectionState === "ready";

  useEffect(() => {
    if (!dashboard || dashboard.platform !== "pinterest" || dashboard.connectionState !== "ready") return;
    const missingIds = dashboard.content.filter(item => !item.imageUrl).map(item => item.id);
    if (missingIds.length === 0) return;
    let cancelled = false;
    const hydrate = async () => {
      for (let index = 0; index < missingIds.length && !cancelled; index += 10) {
        const ids = missingIds.slice(index, index + 10);
        try {
          const response = await authedInsightsFetch(
            `/api/insights/pinterest-pins?ids=${encodeURIComponent(ids.join(","))}`,
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
    };
    hydrate();
    return () => { cancelled = true; };
  }, [dashboard]);

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>Insights</p>
            <h1 className={styles.title}>See what brings people to your business.</h1>
            <p className={styles.subtitle}>{accountLabel} · Clear results from the last 30 days</p>
          </div>
          <div className={styles.controls}>
            <label>
              <span className="sr-only">Platform</span>
              <select className={styles.select} value={platform} onChange={event => setPlatform(event.target.value as InsightsPlatform)}>
                <option value="pinterest">Pinterest</option>
                <option value="instagram">Instagram</option>
              </select>
            </label>
            <span className={styles.period}><CalendarDays size={14} /> Last 30 days</span>
          </div>
        </header>

        {loading ? (
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
                <DashboardMetrics dashboard={dashboard} />
                <Heatmap dashboard={dashboard} />
                <ContentTable dashboard={dashboard} hydratedPins={hydratedPins} />
              </>
            ) : <EmptyState dashboard={dashboard} />}
          </>
        ) : unauthorized ? (
          <section className={styles.panel}>
            <div className={styles.empty}>
              <div>
                <div className={styles.emptyIcon}><Link2 size={22} /></div>
                <h2>Sign in to view Insights</h2>
                <p>Your local session has ended. Sign in again to load analytics from your connected accounts.</p>
                <Link href="/login?next=/app/insights" className={styles.connectLink}>
                  Sign in <ArrowRight size={14} />
                </Link>
              </div>
            </div>
          </section>
        ) : error ? (
          <section className={styles.panel}>
            <div className={styles.empty}>
              <div><h2>Insights could not be loaded</h2><p>Refresh the page and try again.</p></div>
            </div>
          </section>
        ) : null}
      </div>
    </main>
  );
}
