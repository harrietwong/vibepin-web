/**
 * POST /api/pinterest/sandbox/create-demo-board
 *
 * Creates a single demo board on the Pinterest **sandbox** account so the API
 * approval video can show a board in the publish selector. Sandbox accounts start
 * with zero boards, so this seeds one on demand.
 *
 * Guardrails:
 *   - Requires the authenticated VibePin user (Bearer).
 *   - Only works when the server is in sandbox mode AND a sandbox token is present
 *     (canAttemptSandboxPublish). In production it returns 403 — never creates a
 *     board on a real connected account.
 *   - Uses the sandbox token via PinterestClient.forSandboxDemo. Never logs or returns the
 *     token or Authorization header.
 */

import { getUserIdFromBearer } from "@/lib/server/authUser";
import { PinterestClient } from "@/lib/server/pinterest/service";
import { canAttemptSandboxPublish } from "@/lib/server/pinterest/config";
import { pinterestErrorResponse, unauthorized } from "@/lib/server/pinterest/routeHelpers";

export const dynamic = "force-dynamic";

const DEMO_BOARD_NAME = "VibePin Sandbox Demo Board";
const DEMO_BOARD_DESCRIPTION = "Demo board for VibePin Pinterest API review video.";

export async function POST(req: Request) {
  const uid = await getUserIdFromBearer(req);
  if (!uid) return unauthorized();

  if (!canAttemptSandboxPublish()) {
    return Response.json(
      {
        error: "Sandbox demo board creation is only available in Pinterest sandbox mode.",
        code: "sandbox_not_enabled",
      },
      { status: 403 },
    );
  }

  try {
    const client = await PinterestClient.forSandboxDemo(uid);
    const board = await client.createBoard(DEMO_BOARD_NAME, DEMO_BOARD_DESCRIPTION);
    return Response.json(
      { ok: true, board: { id: board.id, name: board.name }, environment: "sandbox" },
      { status: 201 },
    );
  } catch (err) {
    return pinterestErrorResponse(err);
  }
}
