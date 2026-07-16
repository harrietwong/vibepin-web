import { redirect } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  User as UserIcon,
  Boxes,
  Plug,
  Activity,
  Sparkles,
  Lock,
  AlertTriangle,
  ShieldCheck,
  CheckCircle2,
} from "lucide-react";
import { getCurrentSuperAdmin } from "@/lib/server/superAdmin";
import { getUserDetail, type UserDetail } from "@/lib/server/customer360";
import { getUserBlockers, type BlockerType, type UserHealth } from "@/lib/server/adminActionCenter";
import { BLOCKER_LABEL_KEY, HEALTH_DRIVER_KEY, HEALTH_BAND_KEY } from "@/lib/admin/adminConsoleKeys";
import SupportNotesClient from "./SupportNotesClient";
import { AdminT } from "../../AdminT";

export const dynamic = "force-dynamic";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(t));
}

function fmtRelative(iso: string | null): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function Card({ icon: Icon, title, right, children }: { icon: React.ComponentType<{ className?: string }>; title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border" style={{ background: "#FFFFFF", borderColor: "#E5E7EB" }}>
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3" style={{ borderColor: "#E5E7EB" }}>
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

function Field({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="px-4 py-3" style={{ background: "#FFFFFF" }}>
      <dt className="text-[11px] font-bold uppercase" style={{ color: "#6B7280" }}>{label}</dt>
      <dd className={`mt-1 font-semibold ${mono ? "font-mono text-[12px]" : ""}`} style={{ color: "#111827" }}>{value}</dd>
    </div>
  );
}

function na(v: React.ReactNode): React.ReactNode {
  return v === null || v === undefined || v === "" ? <span className="text-gray-300">n/a</span> : v;
}

const FRESH_TONE: Record<string, { bg: string; fg: string }> = {
  fresh: { bg: "rgba(16,185,129,0.12)", fg: "#047857" },
  stale: { bg: "rgba(245,158,11,0.13)", fg: "#B45309" },
  unknown: { bg: "rgba(107,114,128,0.10)", fg: "#4B5563" },
};

function Pill({ tone, children }: { tone: { bg: string; fg: string }; children: React.ReactNode }) {
  return <span className="rounded-full px-2 py-0.5 text-[10.5px] font-black uppercase" style={{ background: tone.bg, color: tone.fg }}>{children}</span>;
}

const GEN_TONE: Record<string, { bg: string; fg: string }> = {
  completed: { bg: "rgba(16,185,129,0.12)", fg: "#047857" },
  failed: { bg: "rgba(239,68,68,0.12)", fg: "#B91C1C" },
  running: { bg: "rgba(59,130,246,0.12)", fg: "#1D4ED8" },
  pending: { bg: "rgba(59,130,246,0.12)", fg: "#1D4ED8" },
  partial: { bg: "rgba(245,158,11,0.13)", fg: "#B45309" },
};

// ── Alert strip + health badge (adminActionCenter) ────────────────────────

const HEALTH_TONE: Record<UserHealth["band"], { bg: string; fg: string }> = {
  green: { bg: "rgba(16,185,129,0.12)", fg: "#047857" },
  yellow: { bg: "rgba(245,158,11,0.13)", fg: "#B45309" },
  red: { bg: "rgba(239,68,68,0.12)", fg: "#B91C1C" },
};

function AlertStrip({ blockers }: { blockers: Array<{ blockerType: BlockerType; dataQuality: "exact" | "inferred" }> }) {
  if (blockers.length === 0) {
    return (
      <div className="mb-2 flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-black uppercase" style={{ background: "rgba(16,185,129,0.12)", color: "#047857" }}>
          <CheckCircle2 className="h-3.5 w-3.5" />
          <AdminT k="c360.alerts.none" />
        </span>
      </div>
    );
  }
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5">
      {blockers.map((b, i) => (
        <span key={i} className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-black uppercase" style={{ background: "rgba(239,68,68,0.10)", color: "#B91C1C" }}>
          <AdminT k={BLOCKER_LABEL_KEY[b.blockerType]} />
          {b.dataQuality === "inferred" && (
            <span className="ml-1 rounded-full px-1.5 py-0.5 text-[9.5px] font-black normal-case" style={{ background: "rgba(107,114,128,0.14)", color: "#6B7280" }}>
              <AdminT k="today.dataQuality.inferred" />
            </span>
          )}
        </span>
      ))}
    </div>
  );
}

function HealthBadgeRow({ health }: { health: UserHealth }) {
  const tone = HEALTH_TONE[health.band];
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 text-[12px]">
      <span className="inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-black uppercase" style={{ background: tone.bg, color: tone.fg }}>
        <AdminT k={HEALTH_BAND_KEY[health.band]} />
      </span>
      {health.drivers.length > 0 && (
        <span className="text-gray-500">
          <AdminT k="c360.health.driversPrefix" />{" "}
          {health.drivers.map((d, i) => (
            <span key={d}>
              {i > 0 && "; "}
              <AdminT k={HEALTH_DRIVER_KEY[d]} />
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

export default async function UserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const admin = await getCurrentSuperAdmin();
  if (!admin) redirect("/app?admin=forbidden");

  const { id } = await params;
  const [detail, userBlockers]: [UserDetail, Awaited<ReturnType<typeof getUserBlockers>>] = await Promise.all([
    getUserDetail(id),
    getUserBlockers(id),
  ]);

  if (!detail.found || !detail.account) {
    return (
      <main className="h-full overflow-y-auto" style={{ background: "#F8FAFC", color: "#111827" }}>
        <div className="mx-auto max-w-[900px] px-6 py-7">
          <Link href="/admin/users" className="mb-4 inline-flex items-center gap-1.5 text-[12.5px] font-bold text-indigo-700 hover:underline">
            <ArrowLeft className="h-3.5 w-3.5" /> Back to Customers
          </Link>
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div>
                <p className="text-[13px] font-bold text-amber-900">User not available</p>
                {detail.warnings.map((w, i) => <p key={i} className="mt-1 text-[12px] text-amber-800">{w}</p>)}
                <p className="mt-1 font-mono text-[11px] text-amber-700">{id}</p>
              </div>
            </div>
          </div>
        </div>
      </main>
    );
  }

  const a = detail.account;

  return (
    <main className="h-full overflow-y-auto" style={{ background: "#F8FAFC", color: "#111827" }}>
      <div className="mx-auto max-w-[1080px] px-6 py-7">
        {/* Header */}
        <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
          <div>
            <Link href="/admin/users" className="mb-2 inline-flex items-center gap-1.5 text-[12.5px] font-bold text-indigo-700 hover:underline">
              <ArrowLeft className="h-3.5 w-3.5" /> Back to Customers
            </Link>
            <div className="mb-2 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-bold" style={{ background: "#FFFFFF", borderColor: "#E5E7EB", color: "#4B5563" }}>
              <Lock className="h-3.5 w-3.5" />
              Super Admin only · Internal
            </div>
            <h1 className="text-[23px] font-black tracking-tight text-gray-950">{a.email ?? "(no email)"}</h1>
          </div>
        </div>

        {/* Alert strip + health badge (adminActionCenter) */}
        <AlertStrip blockers={userBlockers.blockers} />
        <HealthBadgeRow health={userBlockers.health} />

        {detail.warnings.length > 0 && (
          <div className="mb-4 rounded-lg border px-4 py-3 text-[11.5px] text-gray-500" style={{ background: "#FFFFFF", borderColor: "#E5E7EB" }}>
            {detail.warnings.map((w, i) => <p key={i}>· {w}</p>)}
          </div>
        )}

        <div className="flex flex-col gap-5">
          {/* 1. Account Summary */}
          <Card icon={UserIcon} title="Account Summary">
            <dl className="grid grid-cols-1 gap-px sm:grid-cols-2 lg:grid-cols-3" style={{ background: "#E5E7EB" }}>
              <Field label="Email" value={na(a.email)} />
              <Field label="User ID" value={a.id} mono />
              <Field label="Created" value={fmtDate(a.createdAt)} />
              <Field label="Last login" value={fmtRelative(a.lastLoginAt)} />
              <Field label="Plan" value={na(a.plan)} />
              <Field label="Status" value={a.status} />
              <Field label="Token balance" value={na(a.tokenBalance !== null ? a.tokenBalance.toLocaleString() : null)} />
              <Field label="Internal tags" value={a.internalTags.length ? a.internalTags.join(", ") : na(null)} />
              <Field label="Support notes" value={<span className="text-gray-500">See section below</span>} />
            </dl>
          </Card>

          {/* 2. Workspaces */}
          <Card
            icon={Boxes}
            title="Workspaces"
            right={detail.workspaces.derived ? <span className="text-[11px] font-semibold text-gray-400">derived from categories (no workspaces table)</span> : undefined}
          >
            {detail.workspaces.rows.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-[12.5px]">
                  <thead>
                    <tr className="border-b text-left text-[10.5px] uppercase text-gray-400" style={{ borderColor: "#EEF0F3" }}>
                      <th className="px-4 py-2 font-bold">Workspace</th>
                      <th className="px-3 py-2 font-bold">Category</th>
                      <th className="px-3 py-2 font-bold">Created</th>
                      <th className="px-3 py-2 font-bold">Latest activity</th>
                      <th className="px-3 py-2 font-bold">Latest generation</th>
                      <th className="px-3 py-2 font-bold">Product Ideas</th>
                      <th className="px-4 py-2 font-bold">Freshness</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.workspaces.rows.map(w => (
                      <tr key={w.id} className="border-b" style={{ borderColor: "#F3F4F6" }}>
                        <td className="px-4 py-2.5 font-bold text-gray-900">{w.name}</td>
                        <td className="px-3 py-2.5 text-gray-600">{na(w.category)}</td>
                        <td className="px-3 py-2.5 text-gray-600">{fmtDate(w.createdAt)}</td>
                        <td className="px-3 py-2.5 text-gray-600">{fmtRelative(w.latestActivityAt)}</td>
                        <td className="px-3 py-2.5 text-gray-600">{fmtRelative(w.latestGenerationAt)}</td>
                        <td className="px-3 py-2.5 text-gray-400">{na(w.latestProductIdeasAt)}</td>
                        <td className="px-4 py-2.5"><Pill tone={FRESH_TONE[w.freshness]}>{w.freshness}</Pill></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="flex items-center gap-2 px-4 py-4 text-[12.5px] text-gray-400">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-500" /> No workspace activity found for this user.
              </div>
            )}
            <p className="px-4 py-2 text-[11px] text-gray-400">Latest Product Ideas activity is not tracked per-workspace yet.</p>
          </Card>

          {/* 3. Connected Accounts / Integrations */}
          <Card icon={Plug} title="Connected Accounts / Integrations">
            {detail.integrations.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-[12.5px]">
                  <thead>
                    <tr className="border-b text-left text-[10.5px] uppercase text-gray-400" style={{ borderColor: "#EEF0F3" }}>
                      <th className="px-4 py-2 font-bold">Provider</th>
                      <th className="px-3 py-2 font-bold">Status</th>
                      <th className="px-3 py-2 font-bold">Account</th>
                      <th className="px-3 py-2 font-bold">Token expires</th>
                      <th className="px-3 py-2 font-bold">Last sync</th>
                      <th className="px-3 py-2 font-bold">Reauth</th>
                      <th className="px-4 py-2 font-bold">Last sync error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.integrations.map((i, idx) => (
                      <tr key={idx} className="border-b" style={{ borderColor: "#F3F4F6" }}>
                        <td className="px-4 py-2.5 font-bold capitalize text-gray-900">{i.provider}</td>
                        <td className="px-3 py-2.5">
                          <span className="font-semibold" style={{ color: i.connected ? "#047857" : i.reauthRequired ? "#B45309" : "#9CA3AF" }}>{i.status}</span>
                        </td>
                        <td className="px-3 py-2.5 text-gray-600">{na(i.accountLabel)}</td>
                        <td className="px-3 py-2.5 text-gray-600">{fmtDate(i.tokenExpiresAt)}</td>
                        <td className="px-3 py-2.5 text-gray-600">{fmtRelative(i.lastSyncAt)}</td>
                        <td className="px-3 py-2.5 font-bold" style={{ color: i.reauthRequired ? "#B91C1C" : "#047857" }}>{i.reauthRequired ? "Yes" : "No"}</td>
                        <td className="px-4 py-2.5 text-[11.5px] text-gray-500">{na(i.lastSyncError)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="flex items-center gap-2 px-4 py-4 text-[12.5px] text-gray-400">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-500" /> No integration records found.
              </div>
            )}
            <p className="flex items-center gap-1.5 px-4 py-2 text-[11px] text-gray-400">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
              Token/secret values are never loaded or shown — only safe status, expiry, and sync metadata.
            </p>
          </Card>

          {/* 4. Recent Activity */}
          <Card icon={Activity} title="Recent Activity">
            {detail.activity.events.length > 0 ? (
              <ul className="divide-y" style={{ borderColor: "#F3F4F6" }}>
                {detail.activity.events.map((e, i) => (
                  <li key={i} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10.5px] font-black uppercase text-gray-600">{e.type}</span>
                      {e.detail && <span className="truncate text-[12px] text-gray-500">{e.detail}</span>}
                    </div>
                    <span className="shrink-0 text-[11px] text-gray-400">{fmtRelative(e.at)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="flex items-center gap-2 px-4 py-4 text-[12.5px] text-gray-400">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-500" /> No recent activity found.
              </div>
            )}
            {detail.activity.note && <p className="px-4 py-2 text-[11px] text-gray-400">{detail.activity.note}</p>}
          </Card>

          {/* 5. Recent Generation Logs */}
          <Card icon={Sparkles} title="Recent Generation Logs">
            {detail.generations.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-[12.5px]">
                  <thead>
                    <tr className="border-b text-left text-[10.5px] uppercase text-gray-400" style={{ borderColor: "#EEF0F3" }}>
                      <th className="px-4 py-2 font-bold">Preview</th>
                      <th className="px-3 py-2 font-bold">Type</th>
                      <th className="px-3 py-2 font-bold">Status</th>
                      <th className="px-3 py-2 font-bold">Created</th>
                      <th className="px-3 py-2 font-bold">Prompt ver.</th>
                      <th className="px-3 py-2 font-bold">Model</th>
                      <th className="px-4 py-2 font-bold">Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.generations.map(g => (
                      <tr key={g.id} className="border-b align-middle" style={{ borderColor: "#F3F4F6" }}>
                        <td className="px-4 py-2">
                          {g.previewImageUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element -- internal admin thumbnail of the user's own generated image
                            <img src={g.previewImageUrl} alt="" referrerPolicy="no-referrer" loading="lazy" style={{ width: 34, height: 34, objectFit: "cover", borderRadius: 6, background: "#F1F5F9" }} />
                          ) : (
                            <span className="text-gray-300">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-gray-700">{na(g.type)}</td>
                        <td className="px-3 py-2">
                          {g.status ? <Pill tone={GEN_TONE[g.status] ?? FRESH_TONE.unknown}>{g.status}</Pill> : na(null)}
                        </td>
                        <td className="px-3 py-2 text-gray-600">{fmtRelative(g.createdAt)}</td>
                        <td className="px-3 py-2 text-gray-400">{na(g.promptVersion)}</td>
                        <td className="px-3 py-2 text-gray-400">{na(g.model)}</td>
                        <td className="max-w-[220px] truncate px-4 py-2 text-[11.5px] text-red-600" title={g.errorMessage ?? undefined}>
                          {g.status === "failed" ? (g.errorCode ?? g.errorMessage ?? "failed") : <span className="text-gray-300">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="flex items-center gap-2 px-4 py-4 text-[12.5px] text-gray-400">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-500" /> No generation logs found.
              </div>
            )}
            <p className="px-4 py-2 text-[11px] text-gray-400">Prompt version and model are not stored on pin_generations yet. Preview is the user&rsquo;s own generated image.</p>
          </Card>

          {/* 6. Support Notes (client — the only write action) */}
          <SupportNotesClient userId={a.id} />
        </div>

        {/* Footer */}
        <div className="mt-5 inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-[12px] font-semibold" style={{ background: "#FFFFFF", borderColor: "#E5E7EB", color: "#6B7280" }}>
          <ShieldCheck className="h-4 w-4 text-emerald-600" />
          Read-only except adding a support note. No delete / impersonation / requeue / crawler / prompt / ranking actions.
        </div>
      </div>
    </main>
  );
}
