/**
 * Shared types for the Customer Support MVP (ticket system).
 *
 * This is a real ticket system — Help & Support page -> Contact Support form
 * -> support ticket -> admin reply -> email notification. No live chat, no
 * presence/typing/read-receipt state, no AI assistant.
 */

export const SUPPORT_CATEGORIES = [
  "publishing_issue",
  "scheduling_issue",
  "pinterest_connection_issue",
  "ai_generation_issue",
  "credits_issue",
  "billing_or_subscription",
  "bug_report",
  "feature_request",
  "other",
] as const;

export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];

export const SUPPORT_CATEGORY_LABELS: Record<SupportCategory, string> = {
  publishing_issue: "Publishing issue",
  scheduling_issue: "Scheduling issue",
  pinterest_connection_issue: "Pinterest connection issue",
  ai_generation_issue: "AI generation issue",
  credits_issue: "Credits issue",
  billing_or_subscription: "Billing or subscription",
  bug_report: "Bug report",
  feature_request: "Feature request",
  other: "Other",
};

export const SUPPORT_PRIORITIES = ["Low", "Normal", "High", "Urgent"] as const;
export type SupportPriority = (typeof SUPPORT_PRIORITIES)[number];

export const SUPPORT_STATUSES = ["Open", "In progress", "Waiting for user", "Resolved", "Closed"] as const;
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];

// Where a ticket was opened from — drives default category/subject and which
// source-specific context fields buildSupportContext attaches.
export const SUPPORT_SOURCES = [
  "help_center",
  "publish_failed",
  "ai_generation",
  "pinterest_connection",
  "billing",
  "other",
] as const;
export type SupportSource = (typeof SUPPORT_SOURCES)[number];

export type SenderType = "user" | "admin" | "ai" | "system";

export type SupportTicket = {
  id: string;
  ticketNumber: string;
  userId: string;
  workspaceId: string | null;
  email: string;
  category: SupportCategory;
  priority: SupportPriority;
  status: SupportStatus;
  subject: string | null;
  description: string;
  source: string | null;
  context: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  closedAt: string | null;
  // Admin-only (Phase B, migrate_v42). Never exposed on user-facing routes.
  // Best-effort detected language of the customer (ISO 639-1-ish, e.g. "es",
  // "zh"); null until a message or translation preview has detected it.
  customerLanguage?: string | null;
  // Concise Chinese AI summary of the ticket for the (Chinese-speaking)
  // support agent, plus when it was last generated. Never emailed, never
  // shown to the user.
  aiSummary?: string | null;
  aiSummaryAt?: string | null;
};

export type SupportMessage = {
  id: string;
  ticketId: string;
  senderType: SenderType;
  senderId: string | null;
  // User-facing canonical text: for user messages, what the user typed;
  // for admin messages, what was actually sent to the user (already in
  // their language). User-facing APIs return only this field plus the
  // pre-existing ones below — never the translation fields.
  body: string;
  isInternal: boolean;
  createdAt: string;
  // Admin-only (Phase B, migrate_v42). Never exposed on user-facing routes.
  //
  // What the SENDER typed, in the sender's own language. For an admin
  // reply composed in Chinese, originalText = the Chinese draft and
  // originalLanguage = "zh". For a user message, originalText is usually
  // null (body IS the original) and originalLanguage is the detected
  // language of body.
  originalText?: string | null;
  originalLanguage?: string | null;
  // The cross-language counterpart to `body`. For a user message: the
  // Chinese translation shown to admins (translatedLanguage = "zh"). For
  // an admin reply: equals body/customer language (may be set for
  // symmetry even though body already holds it).
  translatedText?: string | null;
  translatedLanguage?: string | null;
  // null = never attempted / not needed; "success"; "failed". A failed or
  // null status must never block reading or replying — see the "send
  // original as-is" fallback in the admin UI.
  translationStatus?: "success" | "failed" | null;
  // True when an admin hand-edited the machine-translated preview before
  // sending it.
  translationManuallyEdited?: boolean;
};

export type SupportAttachment = {
  id: string;
  ticketId: string;
  messageId: string | null;
  fileUrl: string;
  fileType: string | null;
  fileName: string | null;
  createdAt: string;
};

export type SupportEventType =
  | "ticket_created"
  | "status_changed"
  | "priority_changed"
  | "admin_replied"
  | "user_replied"
  | "ai_replied"
  | "internal_note_added"
  | "ticket_resolved"
  | "ticket_closed";

export type SupportEvent = {
  id: string;
  ticketId: string;
  eventType: SupportEventType;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

// ── Client -> server ticket creation payload ────────────────────────────────

export type CreateTicketInput = {
  category: SupportCategory;
  subject?: string;
  description: string;
  source?: SupportSource;
  attachments?: { fileUrl: string; fileType?: string; fileName?: string }[];
  // Client-gathered ambient context (page URL, browser, OS, timezone) plus
  // source-specific fields (draftId, publishJobId, generationRequestId, …).
  // Sanitized server-side by buildSupportContext before it ever reaches the DB.
  clientContext?: Record<string, unknown>;
};

export type CreateTicketResult = {
  id: string;
  ticketNumber: string;
  status: SupportStatus;
  // True when the AI First Responder posted a confident, article-grounded
  // reply immediately after ticket creation. Absent/false is the common case
  // (no LINAPI_KEY configured, or the AI wasn't confident) — a human still
  // always follows up either way.
  aiReplied?: boolean;
};
