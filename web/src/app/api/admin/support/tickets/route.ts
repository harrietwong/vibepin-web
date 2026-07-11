/**
 * GET /api/admin/support/tickets — list tickets for the admin console, with
 * optional status/priority/category filters. Open + High/Urgent first, then
 * newest first.
 */

import { requireAdminRoleFromRequest } from "@/lib/server/superAdmin";
import { listTicketsForAdmin } from "@/lib/support/db";
import { SUPPORT_CATEGORIES, SUPPORT_PRIORITIES, SUPPORT_STATUSES, type SupportCategory, type SupportPriority, type SupportStatus } from "@/lib/support/types";

export const dynamic = "force-dynamic";

const STATUS_RANK: Record<SupportStatus, number> = { Open: 0, "In progress": 1, "Waiting for user": 2, Resolved: 3, Closed: 4 };
const PRIORITY_RANK: Record<SupportPriority, number> = { Urgent: 0, High: 1, Normal: 2, Low: 3 };

export async function GET(req: Request) {
  const session = await requireAdminRoleFromRequest(req);
  if (!session) return Response.json({ error: "Forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status");
  const priorityParam = url.searchParams.get("priority");
  const categoryParam = url.searchParams.get("category");

  const status = statusParam && (SUPPORT_STATUSES as readonly string[]).includes(statusParam) ? (statusParam as SupportStatus) : undefined;
  const priority = priorityParam && (SUPPORT_PRIORITIES as readonly string[]).includes(priorityParam) ? (priorityParam as SupportPriority) : undefined;
  const category = categoryParam && (SUPPORT_CATEGORIES as readonly string[]).includes(categoryParam) ? (categoryParam as SupportCategory) : undefined;

  try {
    const tickets = await listTicketsForAdmin({ status, priority, category });
    // Default sort: open/high-priority first, newest first within each bucket.
    const sorted = [...tickets].sort((a, b) => {
      if (STATUS_RANK[a.status] !== STATUS_RANK[b.status]) return STATUS_RANK[a.status] - STATUS_RANK[b.status];
      if (PRIORITY_RANK[a.priority] !== PRIORITY_RANK[b.priority]) return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    return Response.json({ tickets: sorted });
  } catch (err) {
    console.error("[admin/support/tickets GET]", err);
    return Response.json({ error: "Failed to load tickets" }, { status: 500 });
  }
}
