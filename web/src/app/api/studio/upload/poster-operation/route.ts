import { getUserIdFromBearer } from "@/lib/server/authUser";
import { createVideoPosterOperationStore } from "@/lib/server/media/videoPosterOperationStore";
import { createServerClient } from "@/lib/supabase";
import { DEFAULT_DRAFT_BUCKET } from "../handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function requestId(req: Request) { return (req.headers.get("x-request-id") ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 128); }
export async function POST(req: Request) {
  const id = requestId(req);
  const owner = await getUserIdFromBearer(req);
  if (!owner) return Response.json({ error: "Unauthorized", code: "unauthorized", requestId: id }, { status: 401 });
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return Response.json({ error: "Unavailable", code: "config_error", requestId: id }, { status: 503 });
  let body: { action?: unknown; batchId?: unknown; ordinal?: unknown; path?: unknown } | null;
  try { body = await req.json(); } catch { body = null; }
  if (!body || body.action !== "retain" || typeof body.batchId !== "string" || !UUID.test(body.batchId)
    || !Number.isInteger(body.ordinal) || (body.ordinal as number) < 0 || (body.ordinal as number) > 19 || typeof body.path !== "string") {
    return Response.json({ error: "Invalid request", code: "bad_request", requestId: id }, { status: 400 });
  }
  const path = body.path as string;
  const foreign = /^studio\/uploads\/([0-9A-Fa-f-]{8,64})\//.exec(path);
  if (foreign && foreign[1] !== owner) return Response.json({ error: "Forbidden", code: "forbidden", requestId: id }, { status: 403 });
  const escapedOwner = owner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ownPath = new RegExp(`^studio/uploads/${escapedOwner}/[A-Za-z0-9][A-Za-z0-9_.-]{0,200}\\.(?:png|jpe?g|webp|gif)$`, "i");
  if (!ownPath.test(path) || /[%\\\0]|\.\.|\/\//.test(path)) return Response.json({ error: "Invalid request", code: "bad_request", requestId: id }, { status: 400 });
  const bucket = process.env.VIBEPIN_DRAFT_BUCKET ?? DEFAULT_DRAFT_BUCKET;
  try {
    const store = createVideoPosterOperationStore(createServerClient());
    const input = { ownerUserId: owner, batchId: body.batchId as string, ordinal: body.ordinal as number, bucketId: bucket, objectPath: path };
    await store.retain(input);
    return Response.json({ ok: true, requestId: id });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "video_poster_operation_unavailable";
    const status = code === "v80_poster_operation_conflict" ? 409 : 503;
    return Response.json({ error: "Poster operation unavailable", code, requestId: id }, { status });
  }
}
