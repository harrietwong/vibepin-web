"use client";

/**
 * Settings → Smart Schedule. Renders the SAME canonical SmartScheduleConfigForm as the
 * Weekly Plan Smart Schedule modal, reading/writing the one smartScheduleConfig. Saving
 * here emits SMART_SCHEDULE_EVENT so Weekly Plan reflects the change, and vice-versa.
 * There is no separate Settings-local config.
 */

import { useRef } from "react";
import { SmartScheduleConfigForm } from "@/components/plan/SmartScheduleConfigForm";

export default function SmartScheduleSettingsPage() {
  const saveRef = useRef<(() => void) | null>(null);
  return (
    <div data-testid="settings-smart-schedule" style={{ maxWidth: 720, margin: "0 auto", padding: "24px 20px 40px" }}>
      <h1 style={{ margin: "0 0 6px", fontSize: 20, fontWeight: 800, color: "var(--app-text)" }}>Smart Schedule</h1>
      <p style={{ margin: "0 0 22px", fontSize: 13, color: "var(--app-text-sec)", lineHeight: 1.5 }}>
        One canonical posting schedule shared with Weekly Plan. Changes you save here update Weekly Plan, and changes saved from Weekly Plan appear here.
      </p>
      <SmartScheduleConfigForm saveRef={saveRef} />
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 22 }}>
        <button
          type="button"
          data-testid="settings-smart-schedule-save"
          onClick={() => saveRef.current?.()}
          style={{ padding: "10px 20px", borderRadius: 10, border: "none", background: "linear-gradient(135deg,#FF4D8D,#7C3AED)", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer" }}
        >
          Save Smart Schedule
        </button>
      </div>
    </div>
  );
}
