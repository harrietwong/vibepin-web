/**
 * Server-side Supabase helpers for the support ticket system. All access goes
 * through the service-role client (support_tickets/messages/attachments/events
 * have RLS enabled with zero policies — see migrate_v35) — authorization is
 * enforced entirely in the API route layer, not by RLS.
 */

import { createServerClient } from "@/lib/supabase";
import type {
  EscalationState,
  ResolutionMode,
  SupportAttachment,
  SupportCategory,
  SupportEmail,
  SupportEmailStatus,
  SupportEvent,
  SupportEventType,
  SupportMessage,
  SupportPriority,
  SupportStatus,
  SupportTicket,
} from "./types";

const db = () => createServerClient();

// ── Row <-> domain mapping ───────────────────────────────────────────────

type TicketRow = {
  id: string;
  ticket_number: string;
  user_id: string;
  workspace_id: string | null;
  email: string;
  category: string;
  priority: string;
  status: string;
  subject: string | null;
  description: string;
  source: string | null;
  context: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  closed_at: string | null;
  customer_language?: string | null;
  ai_summary?: string | null;
  ai_summary_at?: string | null;
  // migrate_v43. Optional on the row type so this module still compiles
  // against a pre-v43 schema (the columns just come back undefined).
  resolution_mode?: string | null;
  escalation_state?: string | null;
  escalation_reason?: string | null;
  escalated_at?: string | null;
};

function mapTicket(row: TicketRow): SupportTicket {
  return {
    id: row.id,
    ticketNumber: row.ticket_number,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    email: row.email,
    category: row.category as SupportCategory,
    priority: row.priority as SupportPriority,
    status: row.status as SupportStatus,
    subject: row.subject,
    description: row.description,
    source: row.source,
    context: row.context,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    closedAt: row.closed_at,
    customerLanguage: row.customer_language ?? null,
    aiSummary: row.ai_summary ?? null,
    aiSummaryAt: row.ai_summary_at ?? null,
    resolutionMode: (row.resolution_mode as ResolutionMode | null | undefined) ?? null,
    escalationState: (row.escalation_state as EscalationState | null | undefined) ?? "none",
    escalationReason: row.escalation_reason ?? null,
    escalatedAt: row.escalated_at ?? null,
  };
}

type MessageRow = {
  id: string;
  ticket_id: string;
  sender_type: string;
  sender_id: string | null;
  body: string;
  is_internal: boolean;
  created_at: string;
  original_text?: string | null;
  original_language?: string | null;
  translated_text?: string | null;
  translated_language?: string | null;
  translation_status?: string | null;
  translation_manually_edited?: boolean | null;
};

function mapMessage(row: MessageRow): SupportMessage {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    senderType: row.sender_type as SupportMessage["senderType"],
    senderId: row.sender_id,
    body: row.body,
    isInternal: row.is_internal,
    createdAt: row.created_at,
    originalText: row.original_text ?? null,
    originalLanguage: row.original_language ?? null,
    translatedText: row.translated_text ?? null,
    translatedLanguage: row.translated_language ?? null,
    translationStatus: (row.translation_status as SupportMessage["translationStatus"]) ?? null,
    translationManuallyEdited: row.translation_manually_edited ?? false,
  };
}

type AttachmentRow = {
  id: string;
  ticket_id: string;
  message_id: string | null;
  file_url: string;
  file_type: string | null;
  file_name: string | null;
  created_at: string;
};

function mapAttachment(row: AttachmentRow): SupportAttachment {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    messageId: row.message_id,
    fileUrl: row.file_url,
    fileType: row.file_type,
    fileName: row.file_name,
    createdAt: row.created_at,
  };
}

// ── Ticket number ─────────────────────────────────────────────────────────

export async function nextTicketNumber(): Promise<string> {
  const { data, error } = await db().rpc("support_next_ticket_number");
  if (error) throw new Error(`support_next_ticket_number: ${error.message}`);
  return data as string;
}

// ── Tickets ───────────────────────────────────────────────────────────────

export async function createTicket(input: {
  ticketNumber: string;
  userId: string;
  workspaceId?: string | null;
  email: string;
  category: SupportCategory;
  priority: SupportPriority;
  subject: string | null;
  description: string;
  source: string | null;
  context: Record<string, unknown> | null;
}): Promise<SupportTicket> {
  const { data, error } = await db()
    .from("support_tickets")
    .insert({
      ticket_number: input.ticketNumber,
      user_id: input.userId,
      workspace_id: input.workspaceId ?? null,
      email: input.email,
      category: input.category,
      priority: input.priority,
      status: "Open",
      subject: input.subject,
      description: input.description,
      source: input.source,
      context: input.context,
    })
    .select("*")
    .single();
  if (error) throw new Error(`createTicket: ${error.message}`);
  return mapTicket(data as TicketRow);
}

export async function getTicketById(id: string): Promise<SupportTicket | null> {
  const { data, error } = await db().from("support_tickets").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`getTicketById: ${error.message}`);
  return data ? mapTicket(data as TicketRow) : null;
}

export async function listTicketsForUser(userId: string): Promise<SupportTicket[]> {
  const { data, error } = await db()
    .from("support_tickets")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listTicketsForUser: ${error.message}`);
  return (data as TicketRow[]).map(mapTicket);
}

export type AdminTicketFilters = {
  status?: SupportStatus;
  priority?: SupportPriority;
  category?: SupportCategory;
  // Support Inbox tab filter (PRD §6.2) — e.g. ["needs_email_reply",
  // "email_failed"] for the 待回复 tab. Undefined/empty = no filter.
  escalationStates?: string[];
};

export async function listTicketsForAdmin(filters: AdminTicketFilters): Promise<SupportTicket[]> {
  let query = db().from("support_tickets").select("*");
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.priority) query = query.eq("priority", filters.priority);
  if (filters.category) query = query.eq("category", filters.category);
  if (filters.escalationStates && filters.escalationStates.length > 0) query = query.in("escalation_state", filters.escalationStates);
  // Newest first; the API layer re-sorts client-side to also float Open+High first.
  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) throw new Error(`listTicketsForAdmin: ${error.message}`);
  return (data as TicketRow[]).map(mapTicket);
}

export async function updateTicket(
  id: string,
  patch: Partial<{
    status: SupportStatus;
    priority: SupportPriority;
    resolvedAt: string | null;
    closedAt: string | null;
    customerLanguage: string | null;
    aiSummary: string | null;
    resolutionMode: ResolutionMode | null;
    escalationState: EscalationState;
    escalationReason: string | null;
    escalatedAt: string | null;
  }>,
): Promise<SupportTicket> {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.priority !== undefined) row.priority = patch.priority;
  if (patch.resolvedAt !== undefined) row.resolved_at = patch.resolvedAt;
  if (patch.closedAt !== undefined) row.closed_at = patch.closedAt;
  if (patch.customerLanguage !== undefined) row.customer_language = patch.customerLanguage;
  if (patch.aiSummary !== undefined) {
    row.ai_summary = patch.aiSummary;
    row.ai_summary_at = new Date().toISOString();
  }
  if (patch.resolutionMode !== undefined) row.resolution_mode = patch.resolutionMode;
  if (patch.escalationState !== undefined) row.escalation_state = patch.escalationState;
  if (patch.escalationReason !== undefined) row.escalation_reason = patch.escalationReason;
  if (patch.escalatedAt !== undefined) row.escalated_at = patch.escalatedAt;

  const { data, error } = await db().from("support_tickets").update(row).eq("id", id).select("*").single();
  if (error) throw new Error(`updateTicket: ${error.message}`);
  return mapTicket(data as TicketRow);
}

// ── Messages ──────────────────────────────────────────────────────────────

export async function addMessage(input: {
  ticketId: string;
  senderType: SupportMessage["senderType"];
  senderId?: string | null;
  body: string;
  isInternal?: boolean;
  originalText?: string | null;
  originalLanguage?: string | null;
  translatedText?: string | null;
  translatedLanguage?: string | null;
  translationStatus?: "success" | "failed" | null;
  translationManuallyEdited?: boolean;
}): Promise<SupportMessage> {
  const row: Record<string, unknown> = {
    ticket_id: input.ticketId,
    sender_type: input.senderType,
    sender_id: input.senderId ?? null,
    body: input.body,
    is_internal: input.isInternal ?? false,
  };
  if (input.originalText !== undefined) row.original_text = input.originalText;
  if (input.originalLanguage !== undefined) row.original_language = input.originalLanguage;
  if (input.translatedText !== undefined) row.translated_text = input.translatedText;
  if (input.translatedLanguage !== undefined) row.translated_language = input.translatedLanguage;
  if (input.translationStatus !== undefined) row.translation_status = input.translationStatus;
  if (input.translationManuallyEdited !== undefined) row.translation_manually_edited = input.translationManuallyEdited;

  const { data, error } = await db().from("support_messages").insert(row).select("*").single();
  if (error) throw new Error(`addMessage: ${error.message}`);
  return mapMessage(data as MessageRow);
}

/**
 * Admin-only: attach/update the machine translation for an existing
 * message (used by the user-message -> Chinese auto-translate flow).
 * Never called from user-facing routes.
 */
export async function updateMessageTranslation(
  id: string,
  patch: {
    translatedText?: string | null;
    translatedLanguage?: string | null;
    originalLanguage?: string | null;
    translationStatus: "success" | "failed";
  },
): Promise<SupportMessage> {
  const row: Record<string, unknown> = { translation_status: patch.translationStatus };
  if (patch.translatedText !== undefined) row.translated_text = patch.translatedText;
  if (patch.translatedLanguage !== undefined) row.translated_language = patch.translatedLanguage;
  if (patch.originalLanguage !== undefined) row.original_language = patch.originalLanguage;

  const { data, error } = await db().from("support_messages").update(row).eq("id", id).select("*").single();
  if (error) throw new Error(`updateMessageTranslation: ${error.message}`);
  return mapMessage(data as MessageRow);
}

/** User-facing message list — internal notes are excluded at the query layer, not just the UI. */
export async function listMessagesForUser(ticketId: string): Promise<SupportMessage[]> {
  const { data, error } = await db()
    .from("support_messages")
    .select("*")
    .eq("ticket_id", ticketId)
    .eq("is_internal", false)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`listMessagesForUser: ${error.message}`);
  return (data as MessageRow[]).map(mapMessage);
}

/** Admin message list — includes internal notes. */
export async function listMessagesForAdmin(ticketId: string): Promise<SupportMessage[]> {
  const { data, error } = await db()
    .from("support_messages")
    .select("*")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`listMessagesForAdmin: ${error.message}`);
  return (data as MessageRow[]).map(mapMessage);
}

// ── Attachments ───────────────────────────────────────────────────────────

export async function addAttachments(
  ticketId: string,
  messageId: string | null,
  attachments: { fileUrl: string; fileType?: string; fileName?: string }[],
): Promise<SupportAttachment[]> {
  if (!attachments.length) return [];
  const { data, error } = await db()
    .from("support_attachments")
    .insert(
      attachments.map((a) => ({
        ticket_id: ticketId,
        message_id: messageId,
        file_url: a.fileUrl,
        file_type: a.fileType ?? null,
        file_name: a.fileName ?? null,
      })),
    )
    .select("*");
  if (error) throw new Error(`addAttachments: ${error.message}`);
  return (data as AttachmentRow[]).map(mapAttachment);
}

export async function listAttachmentsForTicket(ticketId: string): Promise<SupportAttachment[]> {
  const { data, error } = await db()
    .from("support_attachments")
    .select("*")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`listAttachmentsForTicket: ${error.message}`);
  return (data as AttachmentRow[]).map(mapAttachment);
}

// ── Events ────────────────────────────────────────────────────────────────

export async function addEvent(input: {
  ticketId: string;
  eventType: SupportEventType;
  metadata?: Record<string, unknown> | null;
}): Promise<SupportEvent> {
  const { data, error } = await db()
    .from("support_events")
    .insert({ ticket_id: input.ticketId, event_type: input.eventType, metadata: input.metadata ?? null })
    .select("*")
    .single();
  if (error) throw new Error(`addEvent: ${error.message}`);
  return data as unknown as SupportEvent;
}

/**
 * The user-visible verdict of the AI first-reply feedback prompt, derived
 * from support_events. Newest of the two verdict event types wins (a ticket
 * should only ever get one, but this stays correct even if that changes).
 */
export async function getAiFeedbackVerdict(ticketId: string): Promise<"helped" | "not_helpful" | null> {
  const { data, error } = await db()
    .from("support_events")
    .select("event_type, created_at")
    .eq("ticket_id", ticketId)
    .in("event_type", ["ai_resolved", "ai_not_helpful"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`getAiFeedbackVerdict: ${error.message}`);
  if (!data) return null;
  const eventType = (data as { event_type: string }).event_type;
  return eventType === "ai_resolved" ? "helped" : "not_helpful";
}

// ── support_emails (migrate_v43) — admin-only email-send audit log ─────────

type SupportEmailRow = {
  id: string;
  ticket_id: string;
  to_email: string;
  from_email: string;
  reply_to_email: string | null;
  subject: string;
  admin_source_text_zh: string | null;
  translated_text: string;
  target_language: string | null;
  translation_engine: string | null;
  translation_edited: boolean;
  status: string;
  provider_message_id: string | null;
  failure_code: string | null;
  failure_message: string | null;
  idempotency_key: string;
  retry_count: number;
  sent_at: string | null;
  created_at: string;
};

function mapSupportEmail(row: SupportEmailRow): SupportEmail {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    toEmail: row.to_email,
    fromEmail: row.from_email,
    replyToEmail: row.reply_to_email,
    subject: row.subject,
    adminSourceTextZh: row.admin_source_text_zh,
    translatedText: row.translated_text,
    targetLanguage: row.target_language,
    translationEngine: row.translation_engine,
    translationEdited: row.translation_edited,
    status: row.status as SupportEmailStatus,
    providerMessageId: row.provider_message_id,
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    idempotencyKey: row.idempotency_key,
    retryCount: row.retry_count,
    sentAt: row.sent_at,
    createdAt: row.created_at,
  };
}

export async function insertSupportEmail(input: {
  ticketId: string;
  toEmail: string;
  fromEmail: string;
  replyToEmail?: string | null;
  subject: string;
  adminSourceTextZh?: string | null;
  translatedText: string;
  targetLanguage?: string | null;
  translationEngine?: string | null;
  translationEdited?: boolean;
  status: SupportEmailStatus;
  idempotencyKey: string;
}): Promise<SupportEmail> {
  const { data, error } = await db()
    .from("support_emails")
    .insert({
      ticket_id: input.ticketId,
      to_email: input.toEmail,
      from_email: input.fromEmail,
      reply_to_email: input.replyToEmail ?? null,
      subject: input.subject,
      admin_source_text_zh: input.adminSourceTextZh ?? null,
      translated_text: input.translatedText,
      target_language: input.targetLanguage ?? null,
      translation_engine: input.translationEngine ?? null,
      translation_edited: input.translationEdited ?? false,
      status: input.status,
      idempotency_key: input.idempotencyKey,
    })
    .select("*")
    .single();
  if (error) throw new Error(`insertSupportEmail: ${error.message}`);
  return mapSupportEmail(data as SupportEmailRow);
}

export async function updateSupportEmail(
  id: string,
  patch: Partial<{
    status: SupportEmailStatus;
    providerMessageId: string | null;
    failureCode: string | null;
    failureMessage: string | null;
    retryCount: number;
    sentAt: string | null;
  }>,
): Promise<SupportEmail> {
  const row: Record<string, unknown> = {};
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.providerMessageId !== undefined) row.provider_message_id = patch.providerMessageId;
  if (patch.failureCode !== undefined) row.failure_code = patch.failureCode;
  if (patch.failureMessage !== undefined) row.failure_message = patch.failureMessage;
  if (patch.retryCount !== undefined) row.retry_count = patch.retryCount;
  if (patch.sentAt !== undefined) row.sent_at = patch.sentAt;

  const { data, error } = await db().from("support_emails").update(row).eq("id", id).select("*").single();
  if (error) throw new Error(`updateSupportEmail: ${error.message}`);
  return mapSupportEmail(data as SupportEmailRow);
}

export async function listEmailsForTicket(ticketId: string): Promise<SupportEmail[]> {
  const { data, error } = await db()
    .from("support_emails")
    .select("*")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`listEmailsForTicket: ${error.message}`);
  return (data as SupportEmailRow[]).map(mapSupportEmail);
}

export async function getEmailByIdempotencyKey(idempotencyKey: string): Promise<SupportEmail | null> {
  const { data, error } = await db()
    .from("support_emails")
    .select("*")
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (error) throw new Error(`getEmailByIdempotencyKey: ${error.message}`);
  return data ? mapSupportEmail(data as SupportEmailRow) : null;
}

export async function getSupportEmailById(id: string): Promise<SupportEmail | null> {
  const { data, error } = await db().from("support_emails").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`getSupportEmailById: ${error.message}`);
  return data ? mapSupportEmail(data as SupportEmailRow) : null;
}
