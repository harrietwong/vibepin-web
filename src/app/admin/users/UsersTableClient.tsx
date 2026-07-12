"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Search, Lock, AlertTriangle, Users } from "lucide-react";
import type { UsersOverview, UserListRow, AccountStatus } from "@/lib/server/customer360";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(new Date(t));
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

const STATUS_TONE: Record<AccountStatus, { bg: string; fg: string }> = {
  active: { bg: "rgba(16,185,129,0.12)", fg: "#047857" },
  unconfirmed: { bg: "rgba(245,158,11,0.13)", fg: "#B45309" },
  banned: { bg: "rgba(239,68,68,0.12)", fg: "#B91C1C" },
};

function StatusBadge({ status }: { status: AccountStatus }) {
  const tone = STATUS_TONE[status];
  return (
    <span className="rounded-full px-2 py-0.5 text-[10.5px] font-black uppercase" style={{ background: tone.bg, color: tone.fg }}>
      {status}
    </span>
  );
}

function IntegrationCell({ row }: { row: UserListRow }) {
  const { pinterest, socialConnected, hasIssue } = row.integration;
  const pinLabel = pinterest === "connected" ? "Pinterest ✓" : pinterest === "reconnect" ? "Pinterest ⚠ reauth" : "Pinterest —";
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11.5px] font-semibold" style={{ color: pinterest === "connected" ? "#047857" : pinterest === "reconnect" ? "#B45309" : "#9CA3AF" }}>
        {pinLabel}
      </span>
      <span className="text-[10.5px] text-gray-400">
        {socialConnected > 0 ? `${socialConnected} social` : "no social"}
        {hasIssue ? " · issue" : ""}
      </span>
    </div>
  );
}

type Toggle = "failedGen" | "integrationIssue" | "recentlyActive" | "noRecentActivity";

const RECENT_MS = 7 * 24 * 3_600_000;
const INACTIVE_MS = 30 * 24 * 3_600_000;

// Module-scope so the "now" read stays out of the component render body.
function isRecentlyActive(iso: string | null): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && Date.now() - t <= RECENT_MS;
}
function hasNoRecentActivity(iso: string | null): boolean {
  if (!iso) return true;
  const t = Date.parse(iso);
  return !Number.isFinite(t) || Date.now() - t > INACTIVE_MS;
}

export default function UsersTableClient({ overview }: { overview: UsersOverview }) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<AccountStatus | "all">("all");
  const [toggles, setToggles] = useState<Record<Toggle, boolean>>({
    failedGen: false,
    integrationIssue: false,
    recentlyActive: false,
    noRecentActivity: false,
  });

  const toggle = (t: Toggle) => setToggles(prev => ({ ...prev, [t]: !prev[t] }));

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return overview.rows.filter(r => {
      if (q && !(r.email ?? "").toLowerCase().includes(q) && !r.id.toLowerCase().includes(q)) return false;
      if (statusFilter !== "all" && r.accountStatus !== statusFilter) return false;
      if (toggles.failedGen && !r.hasFailedGeneration) return false;
      if (toggles.integrationIssue && !r.integration.hasIssue) return false;
      if (toggles.recentlyActive && !isRecentlyActive(r.latestActivityAt)) return false;
      if (toggles.noRecentActivity && !hasNoRecentActivity(r.latestActivityAt)) return false;
      return true;
    });
  }, [overview.rows, query, statusFilter, toggles]);

  const chip = (t: Toggle, label: string) => (
    <button
      type="button"
      onClick={() => toggle(t)}
      className="rounded-lg border px-2.5 py-1.5 text-[12px] font-bold"
      style={{
        background: toggles[t] ? "#111827" : "#FFFFFF",
        color: toggles[t] ? "#FFFFFF" : "#6B7280",
        borderColor: toggles[t] ? "#111827" : "#E5E7EB",
      }}
    >
      {label}
    </button>
  );

  return (
    <main className="h-full overflow-y-auto" style={{ background: "#F8FAFC", color: "#111827" }}>
      <div className="mx-auto max-w-[1320px] px-6 py-7">
        {/* Header */}
        <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="mb-2 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-bold" style={{ background: "#FFFFFF", borderColor: "#E5E7EB", color: "#4B5563" }}>
              <Lock className="h-3.5 w-3.5" />
              Super Admin only · Internal
            </div>
            <h1 className="text-[25px] font-black tracking-tight text-gray-950">Customers</h1>
            <p className="mt-1 text-[13px] text-gray-500">Search a customer to review account, workspace, binding status, recent actions, usage, and generation errors.</p>
          </div>
          <div className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-[12px] font-semibold text-gray-500" style={{ background: "#FFFFFF", borderColor: "#E5E7EB" }}>
            <Users className="h-4 w-4" />
            {overview.rows.length.toLocaleString()} users
          </div>
        </div>

        {!overview.available && (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <p className="text-[13px] font-semibold text-amber-900">
                User list unavailable — listing auth users requires a Supabase service-role key on the server.
              </p>
            </div>
          </div>
        )}

        {overview.warnings.length > 0 && (
          <div className="mb-4 rounded-lg border px-4 py-3 text-[11.5px] text-gray-500" style={{ background: "#FFFFFF", borderColor: "#E5E7EB" }}>
            {overview.warnings.map((w, i) => <p key={i}>· {w}</p>)}
          </div>
        )}

        {/* Filters */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center gap-2 rounded-lg border px-3 py-2" style={{ background: "#FFFFFF", borderColor: "#E5E7EB" }}>
            <Search className="h-4 w-4 text-gray-400" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search email or user id…"
              className="w-[240px] text-[13px] outline-none"
              style={{ background: "transparent", color: "#111827" }}
            />
          </div>
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value as AccountStatus | "all")}
            className="rounded-lg border px-2.5 py-2 text-[12px] font-bold"
            style={{ background: "#FFFFFF", borderColor: "#E5E7EB", color: "#374151" }}
          >
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="unconfirmed">Unconfirmed</option>
            <option value="banned">Banned</option>
          </select>
          {chip("failedGen", "Has failed generation")}
          {chip("integrationIssue", "Has integration issue")}
          {chip("recentlyActive", "Recently active")}
          {chip("noRecentActivity", "No recent activity")}
          <span className="ml-auto text-[12px] font-semibold text-gray-400">{filtered.length} shown</span>
        </div>

        {/* Table */}
        <div className="overflow-x-auto rounded-xl border" style={{ background: "#FFFFFF", borderColor: "#E5E7EB" }}>
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="border-b text-left text-[10.5px] uppercase text-gray-400" style={{ borderColor: "#EEF0F3" }}>
                <th className="px-4 py-2.5 font-bold">Email</th>
                <th className="px-3 py-2.5 font-bold">Created</th>
                <th className="px-3 py-2.5 font-bold">Last login</th>
                <th className="px-3 py-2.5 font-bold">Plan</th>
                <th className="px-3 py-2.5 font-bold">Workspaces</th>
                <th className="px-3 py-2.5 font-bold">Gens</th>
                <th className="px-3 py-2.5 font-bold">24h</th>
                <th className="px-3 py-2.5 font-bold">Status</th>
                <th className="px-3 py-2.5 font-bold">Integrations</th>
                <th className="px-4 py-2.5 font-bold">Latest activity</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => (
                <tr key={r.id} className="border-b align-top hover:bg-gray-50" style={{ borderColor: "#F3F4F6" }}>
                  <td className="px-4 py-2.5">
                    <Link href={`/admin/users/${r.id}`} className="font-bold text-indigo-700 hover:underline">
                      {r.email ?? "(no email)"}
                    </Link>
                    <div className="mt-0.5 font-mono text-[10px] text-gray-400">{r.id}</div>
                  </td>
                  <td className="px-3 py-2.5 text-gray-600">{fmtDate(r.createdAt)}</td>
                  <td className="px-3 py-2.5 text-gray-600">{fmtRelative(r.lastLoginAt)}</td>
                  <td className="px-3 py-2.5 text-gray-600">{r.plan ?? <span className="text-gray-300">n/a</span>}</td>
                  <td className="px-3 py-2.5 text-gray-700">
                    {r.totalWorkspaces ?? 0}
                    <span className="text-gray-400"> · {r.activeWorkspaces ?? 0} active</span>
                  </td>
                  <td className="px-3 py-2.5 text-gray-700">{r.totalGenerations ?? 0}</td>
                  <td className="px-3 py-2.5" style={{ color: (r.generations24h ?? 0) > 0 ? "#047857" : "#9CA3AF" }}>{r.generations24h ?? 0}</td>
                  <td className="px-3 py-2.5"><StatusBadge status={r.accountStatus} /></td>
                  <td className="px-3 py-2.5"><IntegrationCell row={r} /></td>
                  <td className="px-4 py-2.5 text-gray-600">{fmtRelative(r.latestActivityAt)}</td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-4 py-16 text-center text-[13px] text-gray-400">No users match the current filters.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {overview.generationsWindowSaturated && (
          <p className="mt-3 text-[11px] text-gray-400">
            Generation totals reflect the most recent {(5000).toLocaleString()} generations scanned — older per-user totals may be undercounted.
          </p>
        )}
      </div>
    </main>
  );
}
