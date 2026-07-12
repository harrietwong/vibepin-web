"use client";

import { useCallback, useEffect, useState } from "react";
import { StickyNote, Send, AlertTriangle } from "lucide-react";

type SupportNote = {
  id: string;
  note: string;
  authorEmail: string | null;
  createdAt: string | null;
};

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(t));
}

export default function SupportNotesClient({ userId }: { userId: string }) {
  const [notes, setNotes] = useState<SupportNote[]>([]);
  const [persistenceAvailable, setPersistenceAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await fetch(`/api/admin/users/${userId}/notes`, { credentials: "include" });
      if (!resp.ok) {
        setError(resp.status === 403 ? "Forbidden — super admin only." : `Failed to load notes (${resp.status})`);
        return;
      }
      const body = (await resp.json()) as { notes: SupportNote[]; persistenceAvailable: boolean };
      setNotes(body.notes ?? []);
      setPersistenceAvailable(body.persistenceAvailable ?? true);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [userId]);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    void load();
  }, [load]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const submit = useCallback(async () => {
    const note = draft.trim();
    if (!note) return;
    setSaving(true);
    setError(null);
    try {
      const resp = await fetch(`/api/admin/users/${userId}/notes`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note }),
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setError((body as { error?: string }).error ?? `Failed to save (${resp.status})`);
        if (resp.status === 503) setPersistenceAvailable(false);
        return;
      }
      setNotes(prev => [(body as { note: SupportNote }).note, ...prev]);
      setDraft("");
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [draft, userId]);

  return (
    <section className="rounded-xl border" style={{ background: "#FFFFFF", borderColor: "#E5E7EB" }}>
      <div className="flex items-center gap-2 border-b px-4 py-3" style={{ borderColor: "#E5E7EB" }}>
        <StickyNote className="h-4 w-4 text-gray-500" />
        <h2 className="text-[14px] font-black text-gray-950">Support Notes</h2>
        <span className="text-[11px] font-semibold text-gray-400">({notes.length})</span>
      </div>

      {!persistenceAvailable && (
        <div className="flex items-start gap-2 border-b bg-amber-50 px-4 py-3" style={{ borderColor: "#FDE68A" }}>
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <p className="text-[12px] text-amber-800">
            Notes storage not set up — apply <code>backend/db/migrate_v33_admin_support_notes.sql</code> to enable saving.
          </p>
        </div>
      )}

      {/* Add note */}
      <div className="border-b px-4 py-3" style={{ borderColor: "#F1F5F9" }}>
        <textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder="Add an internal support note (never shown to the customer)…"
          rows={2}
          maxLength={4000}
          className="w-full resize-none rounded-lg border px-3 py-2 text-[12.5px] outline-none"
          style={{ borderColor: "#E5E7EB", color: "#111827", background: "#FFFFFF" }}
        />
        <div className="mt-2 flex items-center justify-between">
          {error ? <span className="text-[11.5px] font-semibold text-red-600">{error}</span> : <span className="text-[11px] text-gray-400">Internal only · MVP allows adding notes only</span>}
          <button
            type="button"
            onClick={submit}
            disabled={saving || !draft.trim() || !persistenceAvailable}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-bold"
            style={{
              background: "#111827",
              color: "#FFFFFF",
              cursor: saving || !draft.trim() || !persistenceAvailable ? "not-allowed" : "pointer",
              opacity: saving || !draft.trim() || !persistenceAvailable ? 0.5 : 1,
            }}
          >
            <Send className="h-3.5 w-3.5" />
            {saving ? "Saving…" : "Add note"}
          </button>
        </div>
      </div>

      {/* List */}
      {loading ? (
        <p className="px-4 py-6 text-center text-[12.5px] text-gray-400">Loading notes…</p>
      ) : notes.length === 0 ? (
        <p className="px-4 py-6 text-center text-[12.5px] text-gray-400">No notes yet.</p>
      ) : (
        <ul className="divide-y" style={{ borderColor: "#F3F4F6" }}>
          {notes.map(n => (
            <li key={n.id} className="px-4 py-3">
              <p className="whitespace-pre-wrap text-[12.5px] text-gray-800">{n.note}</p>
              <p className="mt-1 text-[11px] text-gray-400">
                {n.authorEmail ?? "unknown"} · {fmtDateTime(n.createdAt)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
