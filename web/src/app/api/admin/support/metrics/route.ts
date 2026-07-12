/**
 * GET /api/admin/support/metrics — aggregate numbers for the admin support
 * dashboard's metric cards (new tickets, stale-open, AI reply/resolve
 * rates, avg first human reply time). See lib/support/metrics.ts.
 */

import { requireAdminRoleFromRequest } from "@/lib/server/superAdmin";
import { computeSupportMetrics } from "@/lib/support/metrics";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await requireAdminRoleFromRequest(req);
  if (!session) return Response.json({ error: "Forbidden" }, { status: 403 });

  try {
    const metrics = await computeSupportMetrics();
    return Response.json(metrics);
  } catch (err) {
    console.error("[admin/support/metrics GET]", err);
    return Response.json({ error: "Failed to load metrics" }, { status: 500 });
  }
}
