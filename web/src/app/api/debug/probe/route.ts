/**
 * POST /api/debug/probe — leave a greppable breadcrumb in the deployment log.
 *
 * The app calls this once on entering /app with a traceId that is also shown in
 * the PREVIEW badge. Searching the logs for that traceId then proves — without
 * guessing at timestamps or filtering by verb — whether the browser session was
 * really talking to THIS deployment.
 *
 * DISABLED IN PRODUCTION (404). Logs deployment identity only: never a token,
 * secret, user id, or request body beyond the caller-supplied traceId.
 */

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (process.env.VERCEL_ENV === "production") {
    return new Response("Not found", { status: 404 });
  }

  let traceId = "";
  let path = "";
  try {
    const body = (await req.json()) as { traceId?: unknown; path?: unknown };
    if (typeof body.traceId === "string") traceId = body.traceId.slice(0, 64);
    if (typeof body.path === "string") path = body.path.slice(0, 200);
  } catch {
    /* body is optional — a bare probe still records deployment identity */
  }
  if (!traceId) traceId = crypto.randomUUID().slice(0, 8);

  const record = {
    traceId,
    host: req.headers.get("x-forwarded-host") ?? req.headers.get("host"),
    path,
    vercelEnv: process.env.VERCEL_ENV ?? "local",
    gitCommitSha: (process.env.VERCEL_GIT_COMMIT_SHA ?? "").slice(0, 7) || null,
    deploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? null,
    timestamp: new Date().toISOString(),
  };

  console.log("[preview-probe]", JSON.stringify(record));
  return Response.json({ ok: true, ...record });
}
