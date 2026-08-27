import { redirect } from "next/navigation";
import Link from "next/link";
import {
  AlertTriangle,
  CheckCircle2,
  ListTodo,
  Lock,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  TrendingDown,
  Minus,
  Trophy,
} from "lucide-react";
import { getCurrentSuperAdmin } from "@/lib/server/superAdmin";
import { getActionCenter, type BlockerItem, type BlockerType } from "@/lib/server/adminActionCenter";
import type { AccountKind } from "@/lib/server/adminAccountKind";
import { getActivationFunnel, type StageCount } from "@/lib/server/adminActivationFunnel";
import { getAiAdoption } from "@/lib/server/adminAiAdoption";
import { BLOCKER_LABEL_KEY, BLOCKER_ACTION_KEY, FUNNEL_STAGE_KEY, ACCOUNT_KIND_KEY } from "@/lib/admin/adminConsoleKeys";
import { AdminT, AdminTFmt } from "../AdminT";
import type { AdminMessageKey } from "@/lib/admin/adminMessages";

export const dynamic = "force-dynamic";

// ── formatters ───────────────────────────────────────────────────────────────

// Returns a catalog key + interpolation vars so the value renders in the admin
// language via <AdminTFmt>, or null for an un-parseable/absent instant (caller
// renders the em-dash placeholder). Never emits hardcoded English.
function relativeParts(iso: string | null): { key: AdminMessageKey; vars: Record<string, number> } | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const diff = Date.now() - t;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return { key: "time.relative.justNow", vars: {} };
  if (mins < 60) return { key: "time.relative.minutesAgo", vars: { n: mins } };
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return { key: "time.relative.hoursAgo", vars: { n: hrs } };
  return { key: "time.relative.daysAgo", vars: { n: Math.round(hrs / 24) } };
}

function Relative({ iso }: { iso: string | null }) {
  const parts = relativeParts(iso);
  if (!parts) return <>—</>;
  return <AdminTFmt k={parts.key} vars={parts.vars} />;
}

function fmtNum(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : v.toLocaleString();
}

function fmtPct(rate: number | null): string {
  if (rate === null) return "—";
  return `${Math.round(rate * 1000) / 10}%`;
}

// ── presentational shell (matches admin/data + admin/page conventions) ───────

function Card({ icon: Icon, title, right, children }: { icon: React.ComponentType<{ className?: string }>; title: React.ReactNode; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border" style={{ background: "var(--admin-surface, #FFFFFF)", borderColor: "var(--admin-border, #E5E7EB)" }}>
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3" style={{ borderColor: "var(--admin-border, #E5E7EB)" }}>
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-gray-500" />
          <h2 className="text-[14px] font-black text-gray-950">{title}</h2>
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

function Unavailable({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-4 py-4 text-[12.5px] font-semibold" style={{ color: "var(--admin-text-muted, #9CA3AF)" }}>
      <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
      {children}
    </div>
  );
}

function InferredChip() {
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-black uppercase"
      style={{ background: "rgba(107,114,128,0.12)", color: "var(--admin-text-secondary, #6B7280)" }}
    >
      <AdminT k="today.dataQuality.inferred" />
    </span>
  );
}

/**
 * Small marker next to an email when the row is NOT a real customer. Rendered
 * only in the include-everything view (customers carry no chip at all), so the
 * operator can always tell which rows are noise.
 */
function AccountKindChip({ kind }: { kind: AccountKind }) {
  const key = ACCOUNT_KIND_KEY[kind];
  if (!key) return null;
  const tone = kind === "internal"
    ? { bg: "rgba(99,102,241,0.12)", fg: "#4338CA" }
    : { bg: "rgba(245,158,11,0.14)", fg: "#B45309" };
  return (
    <span
      className="ml-1.5 inline-flex items-center rounded-full px-1.5 py-0.5 text-[9.5px] font-black uppercase align-middle"
      style={{ background: tone.bg, color: tone.fg }}
    >
      <AdminT k={key} />
    </span>
  );
}

// ── Action Center ──────────────────────────────────────────────────────────

function BlockerBadge({ type }: { type: BlockerType }) {
  return (
    <span
      className="inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-black uppercase"
      style={{ background: "rgba(239,68,68,0.10)", color: "#B91C1C" }}
    >
      <AdminT k={BLOCKER_LABEL_KEY[type]} />
    </span>
  );
}

function BlockerReason({ item }: { item: BlockerItem }) {
  const e = item.evidence;
  switch (item.blockerType) {
    case "publish_failure":
      return e.publishErrorCode ? (
        <AdminTFmt k="blocker.evidence.publishFailureWithCode" vars={{ count: e.failedPublishCount ?? 1, code: e.publishErrorCode }} />
      ) : (
        <AdminTFmt k="blocker.evidence.publishFailure" vars={{ count: e.failedPublishCount ?? 1 }} />
      );
    case "pinterest_disconnected":
      return <AdminT k={e.disconnectReason === "disconnected" ? "blocker.evidence.pinterestDisconnected.disconnected" : "blocker.evidence.pinterestDisconnected.needsReconnect"} />;
    case "generation_failures":
      return <AdminTFmt k="blocker.evidence.generationFailures" vars={{ count: e.failedGenerationCount ?? 0 }} />;
    case "signup_not_connected":
      return <AdminTFmt k="blocker.evidence.signupNotConnected" vars={{ hours: e.ageHours ?? 0 }} />;
    case "connected_not_creating":
      return <AdminTFmt k="blocker.evidence.connectedNotCreating" vars={{ hours: e.ageHours ?? 0 }} />;
    default:
      return null;
  }
}

function ActionCenterCard({ items, available, windowHours }: { items: BlockerItem[]; available: boolean; windowHours: number }) {
  return (
    <Card icon={ListTodo} title={<AdminT k="today.actionCenter.title" />} right={items.length > 0 ? <span className="text-[12px] font-bold text-red-600">{items.length}</span> : undefined}>
      {!available ? (
        <Unavailable><AdminT k="today.actionCenter.unavailable" /></Unavailable>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
          <CheckCircle2 className="h-8 w-8 text-emerald-500" />
          <p className="text-[15px] font-black" style={{ color: "var(--admin-text, #111827)" }}><AdminT k="today.actionCenter.empty.title" /></p>
          <p className="text-[12.5px]" style={{ color: "var(--admin-text-muted, #9CA3AF)" }}><AdminT k="today.actionCenter.empty.subtitle" /></p>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-b text-left" style={{ borderColor: "var(--admin-border, #E5E7EB)" }}>
                  {(["today.actionCenter.col.user", "today.actionCenter.col.blocker", "today.actionCenter.col.firstSeen", "today.actionCenter.col.reason", "today.actionCenter.col.suggestedAction"] as AdminMessageKey[]).map(h => (
                    <th key={h} className="px-4 py-2.5 text-[11px] font-bold uppercase text-gray-400"><AdminT k={h} /></th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((item, i) => (
                  <tr key={`${item.userId}-${item.blockerType}-${i}`} className="border-b last:border-0 align-top" style={{ borderColor: "var(--admin-border-soft, #EEF0F3)" }}>
                    <td className="px-4 py-2.5">
                      <Link href={`/admin/users/${item.userId}`} className="font-semibold text-indigo-700 hover:underline">
                        {item.email ?? item.userId}
                      </Link>
                      <AccountKindChip kind={item.accountKind} />
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <BlockerBadge type={item.blockerType} />
                        {item.dataQuality === "inferred" && <InferredChip />}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-gray-600"><Relative iso={item.firstSeenAt} /></td>
                    <td className="px-3 py-2.5 text-gray-700"><BlockerReason item={item} /></td>
                    <td className="px-4 py-2.5 text-gray-500"><AdminT k={BLOCKER_ACTION_KEY[item.blockerType]} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="px-4 py-2 text-[11px] text-gray-400">
            <AdminTFmt k="today.actionCenter.windowNote" vars={{ hours: windowHours }} />
          </p>
        </>
      )}
    </Card>
  );
}

// ── Activation Funnel ──────────────────────────────────────────────────────

function FunnelBar({ stage, cohortSize, split }: { stage: StageCount; cohortSize: number; split?: { exact: number; inferred: number } }) {
  const pct = cohortSize > 0 ? Math.round((stage.reached / cohortSize) * 1000) / 10 : 0;
  return (
    <div className="px-4 py-3">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-[12.5px] font-bold" style={{ color: "var(--admin-text, #111827)" }}><AdminT k={FUNNEL_STAGE_KEY[stage.stage]} /></span>
        <span className="text-[11.5px] text-gray-500">
          <AdminT k="today.funnel.reached" />: <strong className="text-gray-800">{fmtNum(stage.reached)}</strong>
          {stage.stuck > 0 && (
            <>
              {" · "}<AdminT k="today.funnel.stuck" />: <strong className="text-amber-600">{fmtNum(stage.stuck)}</strong>
            </>
          )}
        </span>
      </div>
      <div className="h-2.5 w-full overflow-hidden rounded-full" style={{ background: "var(--admin-surface-2, #F1F5F9)" }}>
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: "linear-gradient(90deg,#6366F1,#4338CA)" }} />
      </div>
      {split && (
        <p className="mt-1 text-[10.5px] text-gray-400">
          {split.exact === 0 && split.inferred === 0 ? (
            <AdminT k="today.funnel.splitNote.empty" />
          ) : (
            <AdminTFmt k="today.funnel.splitNote" vars={{ exact: split.exact, inferred: split.inferred }} />
          )}
        </p>
      )}
    </div>
  );
}

// ── AI Adoption trend arrow ────────────────────────────────────────────────

function TrendArrow({ direction }: { direction: -1 | 0 | 1 }) {
  if (direction > 0) return <span className="inline-flex items-center gap-1 text-emerald-600"><TrendingUp className="h-4 w-4" /><AdminT k="today.aiAdoption.trend.up" /></span>;
  if (direction < 0) return <span className="inline-flex items-center gap-1 text-red-600"><TrendingDown className="h-4 w-4" /><AdminT k="today.aiAdoption.trend.down" /></span>;
  return <span className="inline-flex items-center gap-1 text-gray-400"><Minus className="h-4 w-4" /><AdminT k="today.aiAdoption.trend.flat" /></span>;
}

// ── page ────────────────────────────────────────────────────────────────────

/**
 * Banner explaining WHICH population the page is currently reporting on, with
 * the one-click toggle to the other view. Always rendered — an operator must
 * never have to guess whether the numbers above include the founders' own
 * accounts. Counts come from the action center (the whole-user-table pass);
 * the funnel and adoption report their own, cohort/row-scoped tallies, and
 * summing the three would double-count the same people.
 */
function AccountScopeNote({ includeNonCustomers, excluded }: { includeNonCustomers: boolean; excluded: { test: number; internal: number } }) {
  return (
    <p className="mt-2 text-[12px]" style={{ color: "var(--admin-text-muted, #9CA3AF)" }}>
      {includeNonCustomers ? (
        <>
          <AdminT k="today.accounts.includingAll" />
          {" · "}
          <Link href="/admin/today" className="font-semibold text-indigo-700 hover:underline">
            <AdminT k="today.accounts.customersOnly" />
          </Link>
        </>
      ) : (
        <>
          <AdminTFmt k="today.accounts.excluded" vars={{ test: excluded.test, internal: excluded.internal }} />
          {" · "}
          <Link href="/admin/today?accounts=all" className="font-semibold text-indigo-700 hover:underline">
            <AdminT k="today.accounts.showAll" />
          </Link>
        </>
      )}
    </p>
  );
}

export default async function AdminTodayPage({ searchParams }: { searchParams: Promise<{ accounts?: string }> }) {
  const admin = await getCurrentSuperAdmin();
  if (!admin) redirect("/app?admin=forbidden");

  // `?accounts=all` opts into the unfiltered view; anything else (including the
  // absent param) means the default: real customers only.
  const { accounts } = await searchParams;
  const includeNonCustomers = accounts === "all";
  const options = { includeNonCustomers };

  const [actionCenter, funnel, adoption] = await Promise.all([
    getActionCenter(undefined, options),
    getActivationFunnel(undefined, options),
    getAiAdoption(undefined, options),
  ]);

  const allWarnings = [...actionCenter.warnings, ...funnel.warnings, ...adoption.warnings];

  const firstPublishSplit = funnel.publishSplit.find(s => s.stage === "firstPublish");
  const repeatPublishSplit = funnel.publishSplit.find(s => s.stage === "repeatPublish");

  return (
    <main className="h-full overflow-y-auto" style={{ background: "var(--admin-bg, #F8FAFC)", color: "var(--admin-text, #111827)" }}>
      <div className="mx-auto max-w-[1180px] px-6 py-7">
        {/* Header */}
        <div className="mb-5">
          <div className="mb-2 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-bold" style={{ background: "var(--admin-surface, #FFFFFF)", borderColor: "var(--admin-border, #E5E7EB)", color: "var(--admin-text-secondary, #4B5563)" }}>
            <Lock className="h-3.5 w-3.5" />
            <AdminT k="today.badge" />
          </div>
          <h1 className="text-[25px] font-black tracking-tight text-gray-950"><AdminT k="today.title" /></h1>
          <p className="mt-1 text-[13px] text-gray-500"><AdminT k="today.subtitle" /></p>
          <AccountScopeNote includeNonCustomers={includeNonCustomers} excluded={actionCenter.excluded} />
        </div>

        {allWarnings.length > 0 && (
          <div className="mb-5 rounded-lg border px-4 py-3 text-[11.5px] text-gray-500" style={{ background: "var(--admin-surface, #FFFFFF)", borderColor: "var(--admin-border, #E5E7EB)" }}>
            {allWarnings.map((w, i) => <p key={i}>· {w}</p>)}
          </div>
        )}

        <div className="flex flex-col gap-5">
          {/* 1. Action Center */}
          <ActionCenterCard items={actionCenter.items} available={actionCenter.available} windowHours={actionCenter.windowHours} />

          {/* 2. Activation Funnel */}
          <Card icon={Sparkles} title={<AdminT k="today.funnel.title" />}>
            {!funnel.available ? (
              <Unavailable><AdminT k="today.funnel.unavailable" /></Unavailable>
            ) : (
              <>
                <p className="px-4 pt-3 text-[11.5px] text-gray-400">
                  <AdminTFmt k="today.funnel.cohortNote" vars={{ count: funnel.cohortSize, days: funnel.cohortWindowDays }} />
                </p>
                <div className="divide-y" style={{ borderColor: "var(--admin-border-soft, #EEF0F3)" }}>
                  {funnel.stages.map(stage => (
                    <FunnelBar
                      key={stage.stage}
                      stage={stage}
                      cohortSize={funnel.cohortSize}
                      split={stage.stage === "firstPublish" ? firstPublishSplit : stage.stage === "repeatPublish" ? repeatPublishSplit : undefined}
                    />
                  ))}
                </div>
              </>
            )}
          </Card>

          {/* 3. Top Creators placeholder */}
          <Card icon={Trophy} title={<AdminT k="today.topCreators.title" />}>
            <p className="px-4 py-6 text-center text-[12.5px]" style={{ color: "var(--admin-text-muted, #9CA3AF)" }}>
              <AdminT k="today.topCreators.note" />
            </p>
          </Card>

          {/* 4. AI Adoption */}
          <Card icon={Sparkles} title={<AdminT k="today.aiAdoption.title" />}>
            {!adoption.available ? (
              <Unavailable><AdminT k="today.aiAdoption.unavailable" /></Unavailable>
            ) : (
              <div className="px-4 py-4">
                <div className="flex flex-wrap items-baseline gap-3">
                  <span className="text-[36px] font-black tracking-tight" style={{ color: "var(--admin-text, #111827)" }}>{fmtPct(adoption.rate)}</span>
                  <TrendArrow direction={adoption.trend.direction} />
                </div>
                <p className="mt-1 text-[12.5px] text-gray-500">
                  <AdminTFmt k="today.aiAdoption.ratio" vars={{ adopted: adoption.adopted, completed: adoption.completed }} />
                </p>
                <p className="mt-2 text-[11.5px] text-gray-400">
                  <AdminTFmt k="today.aiAdoption.linkSplitNote" vars={{ exact: adoption.linkSplit.exact, inferred: adoption.linkSplit.inferred }} />
                </p>
                <p className="mt-3 border-t pt-3 text-[11px] text-gray-400" style={{ borderColor: "var(--admin-border-soft, #EEF0F3)" }}>
                  <AdminT k="today.aiAdoption.methodology" />
                </p>
              </div>
            )}
          </Card>
        </div>

        <div className="mt-5 inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-[12px] font-semibold" style={{ background: "var(--admin-surface, #FFFFFF)", borderColor: "var(--admin-border, #E5E7EB)", color: "var(--admin-text-secondary, #6B7280)" }}>
          <ShieldCheck className="h-4 w-4 text-emerald-600" />
          <AdminT k="today.footer" />
        </div>
      </div>
    </main>
  );
}
