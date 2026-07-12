import { getUserIdFromSameOriginSession } from "@/lib/server/authUser";
import { getPinterestDefaultBoard, savePinterestDefaultBoard } from "@/lib/social/server/socialConnectionStore";
import { unauthorized } from "@/lib/server/pinterest/routeHelpers";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const uid = await getUserIdFromSameOriginSession(req);
  if (!uid) return unauthorized();
  const board = await getPinterestDefaultBoard(uid);
  return Response.json({ board });
}

export async function PATCH(req: Request) {
  const uid = await getUserIdFromSameOriginSession(req);
  if (!uid) return unauthorized();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON", code: "bad_request" }, { status: 400 });
  }

  const input = body as { boardId?: unknown; boardName?: unknown };
  const boardId = typeof input.boardId === "string" ? input.boardId.trim() : "";
  const boardName = typeof input.boardName === "string" ? input.boardName.trim() : null;
  if (!boardId) {
    return Response.json({ error: "boardId is required", code: "bad_request" }, { status: 400 });
  }

  const board = await savePinterestDefaultBoard(uid, { boardId, boardName });
  return Response.json({ board });
}
