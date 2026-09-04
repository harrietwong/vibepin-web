/**
 * GET /api/history-storage
 *
 * Recovers generated image history from the authenticated user's durable,
 * service-role-only generation jobs. It never lists the shared Storage prefix:
 * legacy unowned objects remain stored but fail closed until ownership is proven.
 */

import { handleHistoryStorageGet } from "@/lib/server/historyStorageHandler";

export const runtime     = "nodejs";
export const maxDuration = 15;

export async function GET(req: Request) {
  return handleHistoryStorageGet(req);
}

