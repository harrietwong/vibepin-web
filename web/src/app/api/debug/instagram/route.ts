/**
 * GET /api/debug/instagram — is Instagram configured on THIS deployment?
 *
 * Vercel bakes env vars at build time, so "I set the variable" and "the running
 * deployment can read it" are different facts. This reports the second one, from
 * the server's own point of view.
 *
 * DISABLED IN PRODUCTION (404). Reports booleans and the redirect URI — which is
 * public by nature (it is registered with Meta and appears in the authorize URL).
 * Never the app id, the secret, the encryption key, or any token.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  if (process.env.VERCEL_ENV === "production") {
    return new Response("Not found", { status: 404 });
  }

  return Response.json({
    instagramAppIdConfigured: Boolean(process.env.INSTAGRAM_APP_ID?.trim()),
    instagramAppSecretConfigured: Boolean(process.env.INSTAGRAM_APP_SECRET?.trim()),
    instagramRedirectUri: process.env.INSTAGRAM_REDIRECT_URI?.trim() ?? null,
    instagramTokenEncryptionConfigured: Boolean(process.env.INSTAGRAM_TOKEN_ENC_KEY?.trim()),
    vercelEnv: process.env.VERCEL_ENV ?? "local",
  });
}
