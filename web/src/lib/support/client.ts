/**
 * Client-side fetch helpers for the support ticket API. Same auth convention
 * as pinterestClient.ts: Supabase SSR browser client, `Authorization: Bearer
 * <access token>` read fresh on every call (never cached).
 */

import { createBrowserClient } from "@supabase/ssr";
import type { CreateTicketInput, CreateTicketResult, SenderType, SupportAttachment, SupportMessage, SupportTicket } from "./types";

let _client: ReturnType<typeof createBrowserClient> | null = null;
function browser() {
  if (_client) return _client;
  _client = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
  return _client;
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await browser().auth.getSession();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
  return headers;
}

async function asJson<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `Request failed (${res.status})`);
  return data as T;
}

export async function createSupportTicket(input: CreateTicketInput & { clientContext?: Record<string, unknown> }): Promise<CreateTicketResult> {
  const res = await fetch("/api/support/tickets", { method: "POST", headers: await authHeaders(), body: JSON.stringify(input) });
  return asJson<CreateTicketResult>(res);
}

export async function fetchMySupportTickets(): Promise<SupportTicket[]> {
  const res = await fetch("/api/support/tickets", { headers: await authHeaders() });
  const data = await asJson<{ tickets: SupportTicket[] }>(res);
  return data.tickets;
}

export async function fetchMySupportTicket(id: string): Promise<{
  ticket: Omit<SupportTicket, "context">;
  messages: SupportMessage[];
  attachments: Omit<SupportAttachment, "ticketId">[];
  aiFeedback: "helped" | "not_helpful" | null;
}> {
  const res = await fetch(`/api/support/tickets/${id}`, { headers: await authHeaders() });
  return asJson(res);
}

export async function replyToMySupportTicket(id: string, body: string): Promise<SupportMessage> {
  const res = await fetch(`/api/support/tickets/${id}/messages`, { method: "POST", headers: await authHeaders(), body: JSON.stringify({ body }) });
  const data = await asJson<{ message: SupportMessage }>(res);
  return data.message;
}

export async function sendAiFeedback(id: string, helped: boolean): Promise<"helped" | "not_helpful"> {
  const res = await fetch(`/api/support/tickets/${id}/ai-feedback`, { method: "POST", headers: await authHeaders(), body: JSON.stringify({ helped }) });
  const data = await asJson<{ verdict: "helped" | "not_helpful" }>(res);
  return data.verdict;
}

// ── Help-page chat (migrate_v43) ────────────────────────────────────────────
// The chat-first Help page surface — one support_tickets row IS the
// conversation record under the hood, but user-facing responses here never
// carry a ticket number. See docs/prd/客服系统简化版v1.1.txt §5/§10.

export type SupportChatMessage = {
  id: string;
  senderType: SenderType;
  body: string;
  createdAt: string;
};

export type SupportChatTurnResult = {
  messages: SupportChatMessage[];
  escalated: boolean;
  accountEmail: string | null;
};

export async function startSupportConversation(
  firstMessage: string,
  clientContext?: Record<string, unknown>,
): Promise<SupportChatTurnResult & { conversationId: string }> {
  const res = await fetch("/api/support/conversations", {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ firstMessage, clientContext }),
  });
  return asJson<SupportChatTurnResult & { conversationId: string }>(res);
}

export async function sendSupportChatMessage(id: string, text: string): Promise<SupportChatTurnResult> {
  const res = await fetch(`/api/support/conversations/${id}/messages`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ text }),
  });
  return asJson<SupportChatTurnResult>(res);
}

export async function escalateSupportConversation(id: string, reason?: string): Promise<{ escalated: boolean; accountEmail: string | null }> {
  const res = await fetch(`/api/support/conversations/${id}/escalate`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify(reason ? { reason } : {}),
  });
  return asJson<{ escalated: boolean; accountEmail: string | null }>(res);
}
