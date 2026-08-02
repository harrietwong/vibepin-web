/**
 * GET /api/debug/deployment — which deployment am I actually talking to?
 *
 * Exists because "is this Preview or Production?" was repeatedly ambiguous from
 * the browser alone: the two look identical, and a request that LOOKS like it
 * went to Preview can land on Production. This answers it from the server's own
 * point of view, so the answer cannot be confused by a stale tab or a cached
 * bundle.
 *
 * DISABLED IN PRODUCTION (404) — it is a debugging aid, not a public surface.
 * Returns only deployment identity: host, env, commit, deployment id. Never a
 * token, secret, database URL, or any credential-adjacent value.
 */

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (process.env.VERCEL_ENV === "production") {
    return new Response("Not found", { status: 404 });
  }

  const url = new URL(req.url);
  const forwardedHost = req.headers.get("x-forwarded-host");
  const forwardedProto = req.headers.get("x-forwarded-proto");

  return Response.json({
    host: req.headers.get("host"),
    forwardedHost,
    forwardedProto,
    // The origin the server would build from this request — the value that
    // decides where an OAuth callback sends the browser back to.
    origin: forwardedHost ? `${forwardedProto ?? "https"}://${forwardedHost}` : url.origin,
    vercelEnv: process.env.VERCEL_ENV ?? "local",
    vercelUrl: process.env.VERCEL_URL ?? null,
    gitCommitSha: (process.env.VERCEL_GIT_COMMIT_SHA ?? "").slice(0, 7) || null,
    deploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? null,
    buildTimestamp: process.env.VERCEL_BUILD_TIMESTAMP ?? null,
    serverTime: new Date().toISOString(),
  });
}
