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

export type SenderType = "user" | "admin" | "system";

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
};

export type SupportMessage = {
  id: string;
  ticketId: string;
  senderType: SenderType;
  senderId: string | null;
  body: string;
  isInternal: boolean;
  createdAt: string;
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
};
