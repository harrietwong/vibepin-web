"use client";

/**
 * @deprecated Superseded by SupportChatModal (docs/prd/客服系统简化版v1.1.txt
 * §5): the user-facing support surface is now a chat-first flow with no
 * ticket-creation form and no ticket number shown to the user. This file is
 * kept (not deleted) because /app/support/tickets still reads/writes
 * classic tickets and nothing currently imports this component — do not
 * wire it up to any new call site. Prefer
 * `@/components/support/SupportChatModal` for any "ask for help" entry
 * point going forward.
 *
 * ContactSupportModal — the one and only "create a support ticket" form.
 * Compact (max ~520px), single column. Context (draftId, publishJobId,
 * generationRequestId, plan, browser, …) is gathered automatically — the user
 * never types userId/email/plan/browser/workspaceId/etc. themselves.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { X, Loader2, CheckCircle2, Paperclip, XCircle } from "lucide-react";
import { createSupportTicket } from "@/lib/support/client";
import { useSupportContext } from "@/lib/support/useSupportContext";
import { SupportContextSummary } from "./SupportContextSummary";
import { SUPPORT_CATEGORIES, SUPPORT_CATEGORY_LABELS, type CreateTicketResult, type SupportCategory, type SupportSource } from "@/lib/support/types";

const UI = {
  overlay: "rgba(8,10,18,0.6)",
  card: "var(--app-surface, #161D2E)",
  surface2: "var(--app-surface-2, #1A2236)",
  border: "var(--app-border, rgba(255,255,255,0.10))",
  borderHi: "var(--app-border-hi, rgba(255,255,255,0.16))",
  text: "var(--app-text, #E2E8F0)",
  textSec: "var(--app-text-sec, #8892A4)",
  textMuted: "var(--app-text-muted, #4A5568)",
  error: "#EF4444",
  gradient: "linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)",
};

export type ContactSupportModalProps = {
  open: boolean;
  onClose: () => void;
  defaultCategory?: SupportCategory;
  defaultSubject?: string;
  source?: SupportSource;
  /** Source-specific fields the caller already has in hand (draftId, publishJobId, …). */
  extraContext?: Record<string, unknown>;
};

type Attachment = { fileUrl: string; fileType?: string; fileName?: string };

export function ContactSupportModal({
  open,
  onClose,
  defaultCategory = "other",
  defaultSubject = "",
  source = "help_center",
  extraContext,
}: ContactSupportModalProps) {
  const { gatherAmbientContext } = useSupportContext();
  const [category, setCategory] = useState<SupportCategory>(defaultCategory);
  const [subject, setSubject] = useState(defaultSubject);
  const [description, setDescription] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateTicketResult | null>(null);

  // The modal stays mounted across open/close (parents just flip `open`), so
  // the form is reset here — during render, per React's "adjusting state
  // when a prop changes" pattern — the moment a fresh "open" transition is
  // seen, instead of via a useEffect (which would cost an extra render pass).
  const [wasOpen, setWasOpen] = useState(false);
  if (open && !wasOpen) {
    setWasOpen(true);
    setCategory(defaultCategory);
    setSubject(defaultSubject);
    setDescription("");
    setAttachments([]);
    setError(null);
    setResult(null);
  } else if (!open && wasOpen) {
    setWasOpen(false);
  }

  const ambientContext = useMemo(() => gatherAmbientContext(extraContext), [gatherAmbientContext, extraContext]);

  if (!open) return null;

  async function handleUpload(file: File) {
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/studio/upload", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Upload failed");
      setAttachments((prev) => [...prev, { fileUrl: data.publicUrl, fileType: file.type, fileName: file.name }]);
    } catch (e) {
      setError((e as Error).message || "Screenshot upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function handleSubmit() {
    if (!description.trim()) {
      setError("Please describe the issue.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await createSupportTicket({
        category,
        subject: subject.trim() || undefined,
        description: description.trim(),
        source,
        attachments,
        clientContext: ambientContext,
      });
      setResult(res);
    } catch (e) {
      setError((e as Error).message || "Failed to create ticket. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 100000, display: "flex", alignItems: "center", justifyContent: "center", background: UI.overlay, padding: 16 }}
      onClick={onClose}>
      <div
        data-testid="contact-support-modal"
        role="dialog"
        aria-label="Contact Support"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(520px, 100%)", maxHeight: "min(88vh, 720px)", overflowY: "auto", background: UI.card, border: `1px solid ${UI.borderHi}`, borderRadius: 16, boxShadow: "0 24px 70px rgba(0,0,0,0.5)" }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 18px", borderBottom: `1px solid ${UI.border}` }}>
          <p style={{ margin: 0, fontSize: 15, fontWeight: 800, color: UI.text }}>Contact Support</p>
          <button type="button" aria-label="Close" onClick={onClose} data-testid="contact-support-close"
            style={{ border: "none", background: "none", cursor: "pointer", color: UI.textSec, display: "flex" }}>
            <X size={18} />
          </button>
        </div>

        {result ? (
          <div data-testid="contact-support-success" style={{ padding: "28px 20px", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
            <CheckCircle2 size={36} style={{ color: "#34D399" }} />
            <p style={{ margin: 0, fontSize: 16, fontWeight: 800, color: UI.text }}>Ticket created</p>
            <p data-testid="contact-support-ticket-number" style={{ margin: 0, fontSize: 14, fontWeight: 700, color: UI.text }}>
              Support ID: {result.ticketNumber}
            </p>
            <p style={{ margin: 0, fontSize: 12.5, color: UI.textSec, maxWidth: 340, lineHeight: 1.5 }}>
              We usually reply within 24 hours — you&apos;ll get our reply by email.
            </p>
            {result.aiReplied && (
              <p style={{ margin: 0, fontSize: 12.5, color: UI.textSec, maxWidth: 340, lineHeight: 1.5 }}>
                We&apos;ve posted a first answer to your ticket.
              </p>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <Link href={`/app/support/tickets/${result.id}`} data-testid="contact-support-view-ticket"
                style={{ padding: "9px 16px", borderRadius: 9, border: `1px solid ${UI.border}`, color: UI.text, fontSize: 12.5, fontWeight: 700, textDecoration: "none" }}>
                View ticket
              </Link>
              <button type="button" onClick={onClose} style={{ padding: "9px 16px", borderRadius: 9, border: "none", background: UI.gradient, color: "#fff", fontSize: 12.5, fontWeight: 800, cursor: "pointer" }}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <label style={{ display: "block", fontSize: 11.5, fontWeight: 700, color: UI.textSec, marginBottom: 5 }}>Issue type</label>
              <select
                data-testid="contact-support-category"
                value={category}
                onChange={(e) => setCategory(e.target.value as SupportCategory)}
                style={{ width: "100%", padding: "9px 10px", borderRadius: 9, border: `1px solid ${UI.border}`, background: UI.surface2, color: UI.text, fontSize: 13, fontWeight: 600 }}
              >
                {SUPPORT_CATEGORIES.map((c) => (
                  <option key={c} value={c}>{SUPPORT_CATEGORY_LABELS[c]}</option>
                ))}
              </select>
            </div>

            <div>
              <label style={{ display: "block", fontSize: 11.5, fontWeight: 700, color: UI.textSec, marginBottom: 5 }}>Subject</label>
              <input
                data-testid="contact-support-subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="A short summary"
                style={{ width: "100%", padding: "9px 10px", borderRadius: 9, border: `1px solid ${UI.border}`, background: UI.surface2, color: UI.text, fontSize: 13 }}
              />
            </div>

            <div>
              <label style={{ display: "block", fontSize: 11.5, fontWeight: 700, color: UI.textSec, marginBottom: 5 }}>Description</label>
              <textarea
                data-testid="contact-support-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What happened? Include any steps that help us reproduce it."
                rows={5}
                style={{ width: "100%", padding: "9px 10px", borderRadius: 9, border: `1px solid ${UI.border}`, background: UI.surface2, color: UI.text, fontSize: 13, resize: "vertical", fontFamily: "inherit" }}
              />
            </div>

            <div>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700, color: UI.textSec, cursor: "pointer" }}>
                <Paperclip size={13} />
                {uploading ? "Uploading…" : "Attach a screenshot"}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  data-testid="contact-support-screenshot-input"
                  style={{ display: "none" }}
                  disabled={uploading}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleUpload(f); e.target.value = ""; }}
                />
              </label>
              {attachments.length > 0 && (
                <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 5 }}>
                  {attachments.map((a, i) => (
                    <div key={a.fileUrl} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 11.5, color: UI.textSec }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.fileName || "screenshot"}</span>
                      <button type="button" onClick={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
                        style={{ border: "none", background: "none", cursor: "pointer", color: UI.textMuted, display: "flex" }}>
                        <XCircle size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={{ padding: "10px 12px", borderRadius: 10, background: UI.surface2, border: `1px solid ${UI.border}` }}>
              <p style={{ margin: "0 0 6px", fontSize: 11, fontWeight: 700, color: UI.textMuted, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                Automatically attached
              </p>
              <SupportContextSummary source={source} ambientContext={ambientContext} />
            </div>

            {error && <p data-testid="contact-support-error" style={{ margin: 0, fontSize: 12, color: UI.error }}>{error}</p>}

            <button
              type="button"
              data-testid="contact-support-submit"
              onClick={() => void handleSubmit()}
              disabled={submitting || uploading}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                padding: "11px 16px", borderRadius: 10, border: "none", background: UI.gradient,
                color: "#fff", fontSize: 13.5, fontWeight: 800, cursor: submitting ? "not-allowed" : "pointer",
                opacity: submitting ? 0.7 : 1,
              }}
            >
              {submitting ? <><Loader2 size={15} className="animate-spin" /> Submitting…</> : "Submit"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
