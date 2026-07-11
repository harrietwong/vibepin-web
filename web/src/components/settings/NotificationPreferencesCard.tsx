"use client";

import { useCallback, useEffect, useState } from "react";
import { Bell } from "lucide-react";
import { toast } from "sonner";
import {
  getNotificationPrefs,
  saveNotificationPrefs,
  type NotificationKey,
  type NotificationPrefs,
} from "@/lib/notificationPrefsStore";

const UI = {
  surface: "var(--app-surface, #161D2E)",
  surface2: "var(--app-surface-2, #1A2235)",
  border: "var(--app-border, rgba(255,255,255,0.10))",
  text: "var(--app-text, #E2E8F0)",
  textSec: "var(--app-text-sec, #8892A4)",
  textMuted: "#5B6577",
  on: "#10B981",
};

const ROWS: { key: NotificationKey; label: string; description: string }[] = [
  { key: "publishFailed", label: "Publishing failed", description: "Notify me when a scheduled Pin fails to publish." },
  { key: "publishSuccess", label: "Publishing success", description: "Notify me when a Pin publishes successfully." },
  { key: "needsDetails", label: "Scheduled Pin needs details", description: "Remind me when a scheduled Pin is missing required details." },
  { key: "lowTokenBalance", label: "Low token balance", description: "Notify me when my token balance is running low." },
  { key: "weeklySummary", label: "Weekly plan summary", description: "A weekly recap of planned and published Pins." },
  { key: "productOpportunity", label: "Product opportunity alerts", description: "Surface new product opportunities worth acting on." },
];

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onClick}
      style={{
        width: 38, height: 22, borderRadius: 999, border: "none", cursor: "pointer", flexShrink: 0,
        background: on ? UI.on : "rgba(255,255,255,0.14)", position: "relative", transition: "background 0.15s",
      }}
    >
      <span style={{ position: "absolute", top: 3, left: on ? 19 : 3, width: 16, height: 16, borderRadius: "50%", background: "#fff", transition: "left 0.15s" }} />
    </button>
  );
}

export function NotificationPreferencesCard() {
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);

  const load = useCallback(() => setPrefs(getNotificationPrefs()), []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  function toggle(key: NotificationKey) {
    setPrefs(prev => {
      if (!prev) return prev;
      const next = { ...prev, [key]: !prev[key] };
      saveNotificationPrefs(next);
      toast.success("Notification preferences saved");
      return next;
    });
  }

  return (
    <section data-testid="notification-preferences" style={{ background: UI.surface, border: `1px solid ${UI.border}`, borderRadius: 16, padding: "20px 18px", marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 4 }}>
        <Bell size={16} style={{ color: UI.textSec }} />
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 800, color: UI.text }}>Notification preferences</h2>
      </div>
      <p style={{ margin: "0 0 14px", fontSize: 12, color: UI.textSec, lineHeight: 1.55 }}>
        Choose which in-app notifications VibePin shows you. Email delivery is coming soon.
      </p>

      {/* Channel header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 18, padding: "0 2px 8px", borderBottom: `1px solid ${UI.border}` }}>
        <span style={{ fontSize: 10, fontWeight: 800, color: UI.textSec, textTransform: "uppercase", letterSpacing: "0.05em", width: 44, textAlign: "center" }}>In-app</span>
        <span style={{ fontSize: 10, fontWeight: 800, color: UI.textMuted, textTransform: "uppercase", letterSpacing: "0.05em", width: 44, textAlign: "center" }}>Email</span>
      </div>

      {prefs === null ? (
        <p data-testid="notification-loading" style={{ margin: "14px 0 0", fontSize: 12, color: UI.textSec }}>Loading preferences…</p>
      ) : (
        <div>
          {ROWS.map(row => (
            <div key={row.key} data-testid={`notification-row-${row.key}`}
              style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 2px", borderBottom: `1px solid ${UI.border}` }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: UI.text }}>{row.label}</p>
                <p style={{ margin: "2px 0 0", fontSize: 11.5, color: UI.textSec, lineHeight: 1.45 }}>{row.description}</p>
              </div>
              <div style={{ width: 44, display: "flex", justifyContent: "center" }}>
                <Toggle on={prefs[row.key]} onClick={() => toggle(row.key)} label={`${row.label} in-app`} />
              </div>
              <div style={{ width: 44, display: "flex", justifyContent: "center" }}>
                <span data-testid={`notification-email-comingsoon-${row.key}`} title="Email delivery is coming soon"
                  style={{ fontSize: 8.5, fontWeight: 800, color: UI.textMuted, textTransform: "uppercase", letterSpacing: "0.03em", textAlign: "center", lineHeight: 1.2 }}>
                  Coming<br />soon
                </span>
              </div>
            </div>
          ))}
          <p style={{ margin: "12px 0 0", fontSize: 11, color: UI.textMuted, lineHeight: 1.5 }}>
            Preferences are saved to this browser. Email notifications will be available once delivery is configured.
          </p>
        </div>
      )}
    </section>
  );
}
