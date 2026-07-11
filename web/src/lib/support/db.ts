/**
 * Server-side Supabase helpers for the support ticket system. All access goes
 * through the service-role client (support_tickets/messages/attachments/events
 * have RLS enabled with zero policies — see migrate_v35) — authorization is
 * enforced entirely in the API route layer, not by RLS.
 */

import { createServerClient } from "@/lib/supabase";
import type {
  SupportAttachment,
  SupportCategory,
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
};

export async function listTicketsForAdmin(filters: AdminTicketFilters): Promise<SupportTicket[]> {
  let query = db().from("support_tickets").select("*");
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.priority) query = query.eq("priority", filters.priority);
  if (filters.category) query = query.eq("category", filters.category);
  // Newest first; the API layer re-sorts client-side to also float Open+High first.
  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) throw new Error(`listTicketsForAdmin: ${error.message}`);
  return (data as TicketRow[]).map(mapTicket);
}

export async function updateTicket(
  id: string,
  patch: Partial<{ status: SupportStatus; priority: SupportPriority; resolvedAt: string | null; closedAt: string | null }>,
): Promise<SupportTicket> {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.priority !== undefined) row.priority = patch.priority;
  if (patch.resolvedAt !== undefined) row.resolved_at = patch.resolvedAt;
  if (patch.closedAt !== undefined) row.closed_at = patch.closedAt;

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
}): Promise<SupportMessage> {
  const { data, error } = await db()
    .from("support_messages")
    .insert({
      ticket_id: input.ticketId,
      sender_type: input.senderType,
      sender_id: input.senderId ?? null,
      body: input.body,
      is_internal: input.isInternal ?? false,
    })
    .select("*")
    .single();
  if (error) throw new Error(`addMessage: ${error.message}`);
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
