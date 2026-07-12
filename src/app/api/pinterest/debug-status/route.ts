/**
 * GET /api/pinterest/debug-status
 *
 * Safe, non-secret diagnostics for the Pinterest environment. Used to confirm
 * sandbox demo wiring (e.g. while recording the API approval video).
 *
 * Returns ONLY booleans and non-secret strings — never the access token, never an
 * Authorization header. `sandboxTokenPresent` reflects presence, not the value.
 *
 *   {
 *     apiEnv: "sandbox" | "production",
 *     baseUrl: string,
 *     sandboxTokenPresent: boolean,
 *     canAttemptSandboxPublish: boolean,
 *     standardAccessRequired: boolean
 *   }
 */

import {
  getPinterestApiEnv,
  getPinterestApiBase,
  getPinterestSandboxAccessToken,
  canAttemptSandboxPublish,
} from "@/lib/server/pinterest/config";

export const dynamic = "force-dynamic";

export async function GET() {
  const canSandbox = canAttemptSandboxPublish();
  return Response.json({
    apiEnv: getPinterestApiEnv(),
    baseUrl: getPinterestApiBase(),
    sandboxTokenPresent: getPinterestSandboxAccessToken() !== null,
    canAttemptSandboxPublish: canSandbox,
    // Production Standard access gating only applies when the sandbox demo path is
    // not active. In sandbox mode with a token, no Standard access is required.
    standardAccessRequired: !canSandbox,
  });
}
