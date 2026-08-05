/**
 * Verification for Meta's `signed_request` payload (server-only).
 *
 * Meta POSTs this to the deauthorize and data-deletion callbacks that every app
 * using Facebook Login must implement. Format:
 *
 *   <base64url_signature>.<base64url_payload>
 *
 * where `payload` is a base64url-encoded JSON object (containing at least
 * `user_id`) and `signature` is HMAC-SHA256(payload_part, FACEBOOK_APP_SECRET),
 * also base64url-encoded.
 *
 * Reference: https://developers.facebook.com/docs/facebook-login/guides/advanced/existing-token
 *
 * This is a DIFFERENT trust mechanism than the OAuth-flow's sealed state cookie
 * (oauthState.ts) — there is no cookie or session here, only the app secret HMAC.
 * getFacebookEnv() is reused purely for its `appSecret` field so we never read
 * process.env directly in this module either.
 */

import { createHmac } from "node:crypto";
import { getFacebookEnv } from "./config";
import { safeEqual } from "../crypto";

export type FacebookSignedRequestPayload = {
  user_id: string;
  algorithm?: string;
  issued_at?: number;
  [key: string]: unknown;
};

/** Decode a base64url string to a Buffer (no throwing on missing padding). */
function base64UrlDecode(input: string): Buffer {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

/**
 * Verify and parse a Facebook `signed_request` string. Returns the decoded
 * payload (including `userId` normalized from `user_id`) on success, or `null`
 * on ANY failure — malformed input, bad signature, unsupported algorithm, or
 * missing app secret. Never throws.
 */
export function parseSignedRequest(
  signedRequest: string | null | undefined,
): ({ userId: string } & FacebookSignedRequestPayload) | null {
  if (!signedRequest || typeof signedRequest !== "string") return null;

  const parts = signedRequest.split(".");
  if (parts.length !== 2) return null;
  const [encodedSig, encodedPayload] = parts;
  if (!encodedSig || !encodedPayload) return null;

  let appSecret: string;
  try {
    appSecret = getFacebookEnv().appSecret;
  } catch {
    return null;
  }

  let signatureBuf: Buffer;
  let payloadJson: FacebookSignedRequestPayload;
  try {
    signatureBuf = base64UrlDecode(encodedSig);
    payloadJson = JSON.parse(base64UrlDecode(encodedPayload).toString("utf8")) as FacebookSignedRequestPayload;
  } catch {
    return null;
  }

  // Meta requires checking the algorithm field to guard against downgrade attacks.
  if (typeof payloadJson.algorithm === "string" && payloadJson.algorithm.toUpperCase() !== "HMAC-SHA256") {
    return null;
  }

  const expectedSig = createHmac("sha256", appSecret).update(encodedPayload).digest();

  // Constant-time compare. safeEqual operates on strings/Buffers of matching
  // length; base64-encode both sides so length mismatches short-circuit safely
  // without leaking timing info tied to the raw byte length either.
  const expectedB64 = expectedSig.toString("base64");
  const actualB64 = signatureBuf.toString("base64");
  if (!safeEqual(expectedB64, actualB64)) return null;

  const userId = typeof payloadJson.user_id === "string" ? payloadJson.user_id : "";
  if (!userId) return null;

  return { ...payloadJson, userId };
}
