"use client";

/**
 * /admin/instagram-auto-dm — client section. Lists the admin's OWN Instagram
 * connections, their comment → DM rules (CRUD), a dry-run Preview per connection,
 * and recent events. All data comes from /api/admin/instagram-auto-dm/*.
 *
 * Only UI prose goes through the admin dictionary; usernames, comment text, rule
 * text, ids and Meta error messages always render verbatim.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useAdminChrome } from "../AdminChromeProvider";

type ConnectionView = {
  id: string;
  username: string | null;
  name: string | null;
  connectionStatus: string | null;
  hasCommentDmScopes: boolean;
};

type RuleView = {
  id: string;
  connectionId: string;
  mediaId: string | null;
  keywords: string[];
  dmText: string;
  publicReplyEnabled: boolean;
  publicReplyText: string | null;
  startAfter: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunError: string | null;
};

type EventView = {
  id: string;
  connectionId: string;
  ruleId: string | null;
  commentId: string;
  mediaId: string | null;
  commenterUsername: string | null;
  commentText: string | null;
  commentTimestamp: string | null;
  status: string;
  attempts: number;
  lastError: string | null;
  publicReplyStatus: string | null;
  sentAt: string | null;
  createdAt: string;
};

type Media = { id: string; timestamp: string | null; permalink: string | null; caption: string | null };

type PreviewResult = {
  outcome: string;
  message: string | null;
  mediaScanned: number;
  commentsSeen: number;
  matches: Array<{
    commentId: string;
    mediaId: string;
    username: string | null;
    text: string | null;
    timestamp: string | null;
    ruleId: string;
    keyword: string;
  }>;
  mediaErrors: Array<{ mediaId: string; message: string }>;
};

type Draft = {
  ruleId: string | null;
  connectionId: string;
  keywords: string;
  mediaId: string;
  dmText: string;
  publicReplyEnabled: boolean;
  publicReplyText: string;
  startAfter: string; // datetime-local value
};

const card = { background: "var(--admin-surface, #FFFFFF)", borderColor: "var(--admin-border, #E5E7EB)" };

function fmtDate(value: string | null): string {
  if (!value) return "—";
  const t = Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  if (!Number.isFinite(t)) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(t));
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const STATUS_TONE: Record<string, { bg: string; fg: string }> = {
  sent: { bg: "rgba(16,185,129,0.12)", fg: "#047857" },
  failed: { bg: "rgba(239,68,68,0.12)", fg: "#B91C1C" },
  claimed: { bg: "rgba(245,158,11,0.13)", fg: "#B45309" },
  skipped: { bg: "rgba(100,116,139,0.12)", fg: "#475569" },
};

function Pill({ tone, children }: { tone: { bg: string; fg: string }; children: React.ReactNode }) {
  return (
    <span className="inline-flex rounded-full px-2 py-0.5 text-[11px] font-bold" style={{ background: tone.bg, color: tone.fg }}>
      {children}
    </span>
  );
}

const btn = "rounded-md border px-2.5 py-1 text-[12px] font-bold disabled:opacity-50";
const btnPrimary = "rounded-md px-3 py-1.5 text-[12px] font-bold text-white disabled:opacity-50";

export default function InstagramAutoDmClient() {
  const { t, tFmt } = useAdminChrome();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connections, setConnections] = useState<ConnectionView[]>([]);
  const [rules, setRules] = useState<RuleView[]>([]);
  const [events, setEvents] = useState<EventView[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [media, setMedia] = useState<Record<string, Media[]>>({});
  const [mediaError, setMediaError] = useState<Record<string, string>>({});
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, PreviewResult | { error: string }>>({});
  const [retrying, setRetrying] = useState<string | null>(null);
  const [retryNotice, setRetryNotice] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/instagram-auto-dm", { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setConnections(json.connections ?? []);
      setRules(json.rules ?? []);
      setEvents(json.events ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const ruleIndex = useMemo(() => {
    const m = new Map<string, number>();
    rules.forEach((r, i) => m.set(r.id, i + 1));
    return m;
  }, [rules]);

  const loadMedia = useCallback(async (connectionId: string) => {
    setMediaError(prev => ({ ...prev, [connectionId]: "" }));
    try {
      const res = await fetch(`/api/admin/instagram-auto-dm/media?connectionId=${encodeURIComponent(connectionId)}`, {
        cache: "no-store",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setMedia(prev => ({ ...prev, [connectionId]: json.media ?? [] }));
    } catch (e) {
      setMediaError(prev => ({ ...prev, [connectionId]: (e as Error).message }));
    }
  }, []);

  const startNew = (connectionId: string) => {
    setActionError(null);
    setDraft({
      ruleId: null,
      connectionId,
      keywords: "",
      mediaId: "",
      dmText: "",
      publicReplyEnabled: false,
      publicReplyText: "",
      startAfter: toLocalInput(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()),
    });
  };

  const startEdit = (r: RuleView) => {
    setActionError(null);
    setDraft({
      ruleId: r.id,
      connectionId: r.connectionId,
      keywords: r.keywords.join(", "),
      mediaId: r.mediaId ?? "",
      dmText: r.dmText,
      publicReplyEnabled: r.publicReplyEnabled,
      publicReplyText: r.publicReplyText ?? "",
      startAfter: toLocalInput(r.startAfter),
    });
  };

  const saveDraft = async () => {
    if (!draft) return;
    setSaving(true);
    setActionError(null);
    const startMs = Date.parse(draft.startAfter);
    const body = {
      connectionId: draft.connectionId,
      keywords: draft.keywords,
      mediaId: draft.mediaId || null,
      dmText: draft.dmText,
      publicReplyEnabled: draft.publicReplyEnabled,
      publicReplyText: draft.publicReplyText,
      startAfter: Number.isFinite(startMs) ? new Date(startMs).toISOString() : draft.startAfter,
    };
    try {
      const res = await fetch(
        draft.ruleId ? `/api/admin/instagram-auto-dm/rules/${draft.ruleId}` : "/api/admin/instagram-auto-dm/rules",
        {
          method: draft.ruleId ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setDraft(null);
      await load();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const patchRule = async (id: string, patch: Record<string, unknown>) => {
    setActionError(null);
    try {
      const res = await fetch(`/api/admin/instagram-auto-dm/rules/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      await load();
    } catch (e) {
      setActionError((e as Error).message);
    }
  };

  const deleteRule = async (id: string) => {
    if (!window.confirm(t("igdm.rules.deleteConfirm"))) return;
    setActionError(null);
    try {
      const res = await fetch(`/api/admin/instagram-auto-dm/rules/${id}`, { method: "DELETE" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      await load();
    } catch (e) {
      setActionError((e as Error).message);
    }
  };

  const retryFailed = async (connectionId: string) => {
    if (!window.confirm(t("igdm.retryFailed.confirm"))) return;
    setRetrying(connectionId);
    setActionError(null);
    try {
      const res = await fetch("/api/admin/instagram-auto-dm/retry-failed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setRetryNotice(prev => ({
        ...prev,
        [connectionId]: tFmt("igdm.retryFailed.done", { count: Number(json.reset ?? 0) }),
      }));
      await load();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setRetrying(null);
    }
  };

  const preview = async (connectionId: string) => {
    setPreviewing(connectionId);
    try {
      const res = await fetch("/api/admin/instagram-auto-dm/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setPreviews(prev => ({ ...prev, [connectionId]: json.result as PreviewResult }));
    } catch (e) {
      setPreviews(prev => ({ ...prev, [connectionId]: { error: (e as Error).message } }));
    } finally {
      setPreviewing(null);
    }
  };

  if (loading && !connections.length) {
    return <p className="text-[13px] text-gray-500">{t("igdm.loading")}</p>;
  }
  if (error) {
    return (
      <div className="rounded-lg border px-4 py-3 text-[13px] text-red-700" style={card}>
        {t("igdm.loadFailed")}: {error}
        <button type="button" className={`${btn} ml-3`} onClick={() => void load()}>
          {t("igdm.refresh")}
        </button>
      </div>
    );
  }

  const renderDraft = (d: Draft) => {
    const mediaList = media[d.connectionId];
    return (
      <div className="mt-3 space-y-3 rounded-lg border p-3" style={{ ...card, background: "var(--admin-surface-2, #F9FAFB)" }}>
        <label className="block text-[12px] font-bold text-gray-700">
          {t("igdm.rules.keywords")}
          <input
            className="mt-1 w-full rounded-md border px-2 py-1.5 text-[13px] font-normal"
            value={d.keywords}
            onChange={e => setDraft({ ...d, keywords: e.target.value })}
            placeholder="price, link, 多少钱"
          />
        </label>
        <div className="text-[12px] font-bold text-gray-700">
          {t("igdm.rules.media")}
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <select
              className="max-w-[520px] rounded-md border px-2 py-1.5 text-[13px] font-normal"
              value={d.mediaId}
              onChange={e => setDraft({ ...d, mediaId: e.target.value })}
            >
              <option value="">{t("igdm.rules.allPosts")}</option>
              {d.mediaId && !(mediaList ?? []).some(m => m.id === d.mediaId) && (
                <option value={d.mediaId}>{d.mediaId}</option>
              )}
              {(mediaList ?? []).map(m => (
                <option key={m.id} value={m.id}>
                  {fmtDate(m.timestamp)} · {(m.caption ?? m.id).slice(0, 60)}
                </option>
              ))}
            </select>
            <button type="button" className={btn} onClick={() => void loadMedia(d.connectionId)}>
              {t("igdm.rules.loadMedia")}
            </button>
            {mediaError[d.connectionId] && (
              <span className="text-[12px] font-normal text-red-700">{mediaError[d.connectionId]}</span>
            )}
          </div>
        </div>
        <label className="block text-[12px] font-bold text-gray-700">
          {t("igdm.rules.dmText")}
          <textarea
            className="mt-1 w-full rounded-md border px-2 py-1.5 text-[13px] font-normal"
            rows={3}
            value={d.dmText}
            onChange={e => setDraft({ ...d, dmText: e.target.value })}
          />
        </label>
        <label className="flex items-center gap-2 text-[12px] font-bold text-gray-700">
          <input
            type="checkbox"
            checked={d.publicReplyEnabled}
            onChange={e => setDraft({ ...d, publicReplyEnabled: e.target.checked })}
          />
          {t("igdm.rules.publicReply")}
        </label>
        {d.publicReplyEnabled && (
          <label className="block text-[12px] font-bold text-gray-700">
            {t("igdm.rules.publicReplyText")}
            <input
              className="mt-1 w-full rounded-md border px-2 py-1.5 text-[13px] font-normal"
              value={d.publicReplyText}
              onChange={e => setDraft({ ...d, publicReplyText: e.target.value })}
            />
          </label>
        )}
        <label className="block text-[12px] font-bold text-gray-700">
          {t("igdm.rules.startAfter")}
          <input
            type="datetime-local"
            className="mt-1 block rounded-md border px-2 py-1.5 text-[13px] font-normal"
            value={d.startAfter}
            onChange={e => setDraft({ ...d, startAfter: e.target.value })}
          />
        </label>
        {!d.ruleId && <p className="text-[11.5px] text-gray-500">{t("igdm.rules.newDefaultsOff")}</p>}
        <div className="flex gap-2">
          <button
            type="button"
            className={btnPrimary}
            style={{ background: "#4F46E5" }}
            disabled={saving}
            onClick={() => void saveDraft()}
          >
            {saving ? t("igdm.rules.saving") : t("igdm.rules.save")}
          </button>
          <button type="button" className={btn} onClick={() => setDraft(null)}>
            {t("igdm.rules.cancel")}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-black text-gray-950">{t("igdm.connections.title")}</h2>
        <button type="button" className={`${btn} inline-flex items-center gap-1.5`} onClick={() => void load()}>
          <RefreshCw style={{ width: 13, height: 13 }} />
          {t("igdm.refresh")}
        </button>
      </div>
      {actionError && <p className="text-[12.5px] text-red-700">{actionError}</p>}

      {connections.length === 0 && (
        <p className="rounded-lg border px-4 py-3 text-[13px] text-gray-600" style={card}>
          {t("igdm.connections.empty")}
        </p>
      )}

      {connections.map(c => {
        const connRules = rules.filter(r => r.connectionId === c.id);
        const lastRun = connRules
          .filter(r => r.lastRunAt)
          .sort((a, b) => String(b.lastRunAt).localeCompare(String(a.lastRunAt)))[0];
        const pv = previews[c.id];
        const connectHref =
          `/api/auth/instagram/connect?features=comment_dm&reconnect=${encodeURIComponent(c.id)}`;
        return (
          <section key={c.id} className="rounded-xl border" style={card}>
            <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3" style={{ borderColor: card.borderColor }}>
              <div>
                <p className="text-[14px] font-black text-gray-950">
                  @{c.username ?? c.name ?? c.id}
                  <span className="ml-2 text-[11px] font-semibold text-gray-500">{c.connectionStatus}</span>
                </p>
                <div className="mt-1">
                  {c.hasCommentDmScopes ? (
                    <Pill tone={STATUS_TONE.sent}>{t("igdm.scopes.granted")}</Pill>
                  ) : (
                    <Pill tone={STATUS_TONE.failed}>{t("igdm.scopes.missing")}</Pill>
                  )}
                </div>
                <p className="mt-1 text-[11.5px] text-gray-500">
                  {t("igdm.connections.lastRun")}:{" "}
                  {lastRun ? `${fmtDate(lastRun.lastRunAt)} · ${lastRun.lastRunStatus ?? ""}` : t("igdm.connections.never")}
                  {lastRun?.lastRunError ? <span className="ml-1 text-red-700">— {lastRun.lastRunError}</span> : null}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <a href={connectHref} className={btn} style={{ textDecoration: "none" }}>
                  {t("igdm.scopes.grantButton")}
                </a>
                <button
                  type="button"
                  className={btn}
                  disabled={retrying !== null}
                  onClick={() => void retryFailed(c.id)}
                >
                  {retrying === c.id ? t("igdm.retryFailed.running") : t("igdm.retryFailed.button")}
                </button>
                <button
                  type="button"
                  className={btnPrimary}
                  style={{ background: "#0F766E" }}
                  disabled={previewing !== null || connRules.length === 0}
                  onClick={() => void preview(c.id)}
                >
                  {previewing === c.id ? t("igdm.preview.running") : t("igdm.preview.button")}
                </button>
              </div>
            </div>
            {retryNotice[c.id] && (
              <p className="border-b px-4 py-2 text-[12px] text-emerald-800" style={{ borderColor: card.borderColor }}>
                {retryNotice[c.id]}
              </p>
            )}
            {!c.hasCommentDmScopes && (
              <p className="border-b px-4 py-2 text-[12px] text-amber-800" style={{ borderColor: card.borderColor, background: "rgba(245,158,11,0.08)" }}>
                {t("igdm.scopes.help")}
              </p>
            )}

            <div className="px-4 py-3">
              <div className="flex items-center justify-between">
                <h3 className="text-[13px] font-black text-gray-900">{t("igdm.rules.title")}</h3>
                <button type="button" className={btn} onClick={() => startNew(c.id)}>
                  {t("igdm.rules.add")}
                </button>
              </div>
              {draft && !draft.ruleId && draft.connectionId === c.id && renderDraft(draft)}
              {connRules.length === 0 && <p className="mt-2 text-[12.5px] text-gray-500">{t("igdm.rules.empty")}</p>}
              <ul className="mt-2 space-y-2">
                {connRules.map(r => (
                  <li key={r.id} className="rounded-lg border px-3 py-2" style={card}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0 text-[12.5px] text-gray-800">
                        <span className="mr-2 font-black">#{ruleIndex.get(r.id)}</span>
                        <Pill tone={r.enabled ? STATUS_TONE.sent : STATUS_TONE.skipped}>
                          {r.enabled ? t("igdm.rules.enabled") : t("igdm.rules.disabled")}
                        </Pill>
                        <span className="ml-2 font-bold">{r.keywords.join(", ")}</span>
                        <span className="ml-2 text-gray-500">· {r.mediaId ?? t("igdm.rules.allPosts")}</span>
                        <span className="ml-2 text-gray-500">· ≥ {fmtDate(r.startAfter)}</span>
                      </div>
                      <div className="flex gap-1.5">
                        <button type="button" className={btn} onClick={() => void patchRule(r.id, { enabled: !r.enabled })}>
                          {r.enabled ? t("igdm.rules.disable") : t("igdm.rules.enable")}
                        </button>
                        <button type="button" className={btn} onClick={() => startEdit(r)}>
                          {t("igdm.rules.edit")}
                        </button>
                        <button type="button" className={`${btn} text-red-700`} onClick={() => void deleteRule(r.id)}>
                          {t("igdm.rules.delete")}
                        </button>
                      </div>
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-[12px] text-gray-600">{r.dmText}</p>
                    {r.publicReplyEnabled && (
                      <p className="mt-0.5 text-[11.5px] text-gray-500">
                        {t("igdm.col.publicReply")}: {r.publicReplyText}
                      </p>
                    )}
                    {draft?.ruleId === r.id && renderDraft(draft)}
                  </li>
                ))}
              </ul>

              {pv && (
                <div className="mt-4 rounded-lg border p-3" style={{ ...card, background: "var(--admin-surface-2, #F9FAFB)" }}>
                  <h4 className="text-[12.5px] font-black text-gray-900">{t("igdm.preview.title")}</h4>
                  <p className="text-[11.5px] text-gray-500">{t("igdm.preview.note")}</p>
                  {"error" in pv ? (
                    <p className="mt-2 text-[12px] text-red-700">{pv.error}</p>
                  ) : (
                    <>
                      <p className="mt-1 text-[11.5px] text-gray-600">
                        {pv.outcome} · media {pv.mediaScanned} · comments {pv.commentsSeen}
                        {pv.message ? <span className="ml-1 text-red-700">— {pv.message}</span> : null}
                      </p>
                      {pv.mediaErrors.map(me => (
                        <p key={me.mediaId} className="text-[11.5px] text-red-700">
                          {me.mediaId}: {me.message}
                        </p>
                      ))}
                      {pv.matches.length === 0 ? (
                        <p className="mt-2 text-[12px] text-gray-600">{t("igdm.preview.none")}</p>
                      ) : (
                        <table className="mt-2 w-full text-left text-[12px]">
                          <thead className="text-gray-500">
                            <tr>
                              <th className="py-1 pr-2">{t("igdm.col.user")}</th>
                              <th className="py-1 pr-2">{t("igdm.col.comment")}</th>
                              <th className="py-1 pr-2">{t("igdm.col.rule")}</th>
                              <th className="py-1">{t("igdm.col.time")}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {pv.matches.map(m => (
                              <tr key={m.commentId} className="border-t" style={{ borderColor: card.borderColor }}>
                                <td className="py-1 pr-2 font-bold">@{m.username ?? "?"}</td>
                                <td className="py-1 pr-2">{m.text}</td>
                                <td className="py-1 pr-2">#{ruleIndex.get(m.ruleId) ?? "?"} · {m.keyword}</td>
                                <td className="py-1">{fmtDate(m.timestamp)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </section>
        );
      })}

      <section className="rounded-xl border" style={card}>
        <div className="border-b px-4 py-3" style={{ borderColor: card.borderColor }}>
          <h2 className="text-[14px] font-black text-gray-950">{t("igdm.events.title")}</h2>
        </div>
        {events.length === 0 ? (
          <p className="px-4 py-3 text-[12.5px] text-gray-500">{t("igdm.events.empty")}</p>
        ) : (
          <div className="overflow-x-auto px-4 py-2">
            <table className="w-full text-left text-[12px]">
              <thead className="text-gray-500">
                <tr>
                  <th className="py-1 pr-2">{t("igdm.col.time")}</th>
                  <th className="py-1 pr-2">{t("igdm.col.user")}</th>
                  <th className="py-1 pr-2">{t("igdm.col.comment")}</th>
                  <th className="py-1 pr-2">{t("igdm.col.rule")}</th>
                  <th className="py-1 pr-2">{t("igdm.col.status")}</th>
                  <th className="py-1 pr-2">{t("igdm.col.publicReply")}</th>
                  <th className="py-1">{t("igdm.col.error")}</th>
                </tr>
              </thead>
              <tbody>
                {events.map(e => (
                  <tr key={e.id} className="border-t align-top" style={{ borderColor: card.borderColor }}>
                    <td className="py-1 pr-2 whitespace-nowrap">{fmtDate(e.sentAt ?? e.createdAt)}</td>
                    <td className="py-1 pr-2 font-bold">@{e.commenterUsername ?? "?"}</td>
                    <td className="py-1 pr-2">{e.commentText}</td>
                    <td className="py-1 pr-2">{e.ruleId ? `#${ruleIndex.get(e.ruleId) ?? "?"}` : "—"}</td>
                    <td className="py-1 pr-2">
                      <Pill tone={STATUS_TONE[e.status] ?? STATUS_TONE.skipped}>{e.status}</Pill>
                      {e.attempts > 1 ? <span className="ml-1 text-gray-500">×{e.attempts}</span> : null}
                    </td>
                    <td className="py-1 pr-2">{e.publicReplyStatus ?? "—"}</td>
                    <td className="py-1 text-red-700">{e.lastError ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
