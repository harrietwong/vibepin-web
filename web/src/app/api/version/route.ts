/**
 * GET /api/version
 *
 * Public, secret-free build/version identification endpoint. Used to confirm
 * which build is live (e.g. after a deploy) and which UI generation is
 * active. MUST NEVER return a token, secret, database URL, or user data —
 * only the static fields below.
 */

import pkg from "../../../../package.json";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(
    {
      appVersion: typeof pkg?.version === "string" ? pkg.version : null,
      buildSha: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      buildRef: process.env.VERCEL_GIT_COMMIT_REF ?? null,
      deploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? null,
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? null,
      region: process.env.VERCEL_REGION ?? null,
      uiGeneration: "current",
      createPinsUiVersion: "board-v2",
      weeklyPlanUiVersion: "plan-v2",
      discoverUiVersion: "waterfall-v1",
      appShellUiVersion: "shell-v2",
    },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
