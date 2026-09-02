import { getUserIdFromBearer } from "@/lib/server/authUser";
import { createServerClient } from "@/lib/supabase";
import { PublishIntentLedgerError, reconcilePublishIntent } from "@/lib/server/publish/publishIntentLedger";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const uid = await getUserIdFromBearer(req);
  if (!uid) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const intentId = url.searchParams.get("intentId")?.trim() ?? "";
  if (!/^publish:.{1,240}$/.test(intentId)) {
    return Response.json({ error: "A valid intentId is required.", code: "invalid_intent" }, { status: 400 });
  }
  try {
    const intent = await reconcilePublishIntent(createServerClient(), uid, intentId);
    if (!intent) return Response.json({ error: "Publish intent not found.", code: "intent_not_found" }, { status: 404 });
    return Response.json({ ok: true, ...intent });
  } catch (error) {
    const code = error instanceof PublishIntentLedgerError ? error.code : "unavailable";
    return Response.json({ error: "Could not reconcile this publish intent.", code: `publish_intent_${code}` }, { status: 503 });
  }
}
