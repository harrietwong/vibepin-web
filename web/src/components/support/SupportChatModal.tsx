"use client";

/**
 * SupportChatModal — 520px modal shell hosting SupportChat. Replaces
 * ContactSupportModal as the "ask for help" entry point across the app
 * (Help page chat is the primary surface; this is for contextual CTAs like
 * "Publish failed" / "Trouble connecting Pinterest" that want to seed the
 * first message). See docs/prd/客服系统简化版v1.1.txt §5.
 */

import { X } from "lucide-react";
import { SupportChat } from "./SupportChat";

const UI = {
  overlay: "rgba(8,10,18,0.6)",
  card: "var(--app-surface, #161D2E)",
  border: "var(--app-border, rgba(255,255,255,0.10))",
  borderHi: "var(--app-border-hi, rgba(255,255,255,0.16))",
  text: "var(--app-text, #E2E8F0)",
  textSec: "var(--app-text-sec, #8892A4)",
};

export type SupportChatModalProps = {
  open: boolean;
  onClose: () => void;
  initialContext?: Record<string, unknown>;
  seedText?: string;
};

export function SupportChatModal({ open, onClose, initialContext, seedText }: SupportChatModalProps) {
  if (!open) return null;

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 100000, display: "flex", alignItems: "center", justifyContent: "center", background: UI.overlay, padding: 16 }}
      onClick={onClose}
    >
      <div
        data-testid="support-chat-modal"
        role="dialog"
        aria-label="Ask VibePin Support"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(520px, 100%)", maxHeight: "min(88vh, 720px)", display: "flex", flexDirection: "column",
          background: UI.card, border: `1px solid ${UI.borderHi}`, borderRadius: 16, boxShadow: "0 24px 70px rgba(0,0,0,0.5)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 18px", borderBottom: `1px solid ${UI.border}`, flexShrink: 0 }}>
          <p style={{ margin: 0, fontSize: 15, fontWeight: 800, color: UI.text }}>Ask VibePin Support</p>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            data-testid="support-chat-modal-close"
            style={{ border: "none", background: "none", cursor: "pointer", color: UI.textSec, display: "flex" }}
          >
            <X size={18} />
          </button>
        </div>

        <div style={{ padding: 18, overflowY: "auto", display: "flex", flexDirection: "column", minHeight: 0 }}>
          <SupportChat initialContext={initialContext} seedText={seedText} compact />
        </div>
      </div>
    </div>
  );
}
