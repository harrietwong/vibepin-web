/**
 * Server-only symmetric encryption for sensitive Pinterest values.
 *
 * Used for:
 *   - Encrypting Pinterest access/refresh tokens at rest (DB column).
 *   - Sealing the short-lived OAuth `state` cookie ({ state, uid, exp }).
 *
 * Algorithm: AES-256-GCM. Output format: "v1:" + base64(iv | ciphertext | tag).
 *
 * The key comes from PINTEREST_TOKEN_ENC_KEY (32 bytes, supplied as base64 or
 * hex). This module must never be imported into client components — it relies on
 * node:crypto and a server-only secret.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12; // GCM standard nonce length
const TAG_LEN = 16;
const PREFIX = "v1:";

let cachedKey: Buffer | null = null;

/** Decode a 32-byte AES key from an env var's raw value (base64 or hex). Throws if missing/invalid. */
function decodeKeyFromEnv(envVarName: string, raw: string | undefined): Buffer {
  if (!raw) {
    throw new Error(
      `${envVarName} is not set. Generate one with: ` +
        "node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }

  let key: Buffer | null = null;
  // hex (64 chars) first, then base64.
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, "hex");
  } else {
    try {
      const b = Buffer.from(raw, "base64");
      if (b.length === 32) key = b;
    } catch {
      /* fall through */
    }
  }

  if (!key || key.length !== 32) {
    throw new Error(
      `${envVarName} must decode to exactly 32 bytes (base64 or hex).`,
    );
  }

  return key;
}

/** Resolve the 32-byte AES key from env (base64 or hex). Throws if missing/invalid. */
function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  cachedKey = decodeKeyFromEnv(
    "PINTEREST_TOKEN_ENC_KEY",
    process.env.PINTEREST_TOKEN_ENC_KEY?.trim(),
  );
  return cachedKey;
}

/** True when a usable encryption key is configured (for safe status checks). */
export function isEncryptionConfigured(): boolean {
  try {
    getKey();
    return true;
  } catch {
    return false;
  }
}

function encryptWithKey(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, ct, tag]).toString("base64");
}

function decryptWithKey(key: Buffer, payload: string): string {
  if (!payload.startsWith(PREFIX)) {
    throw new Error("Ciphertext missing version prefix");
  }
  const buf = Buffer.from(payload.slice(PREFIX.length), "base64");
  if (buf.length < IV_LEN + TAG_LEN + 1) {
    throw new Error("Ciphertext too short");
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ct = buf.subarray(IV_LEN, buf.length - TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** Encrypt a UTF-8 string. Returns "v1:"-prefixed base64. */
export function encryptSecret(plaintext: string): string {
  return encryptWithKey(getKey(), plaintext);
}

/** Decrypt a value produced by encryptSecret. Throws on tamper/format errors. */
export function decryptSecret(payload: string): string {
  return decryptWithKey(getKey(), payload);
}

/** Encrypt a small JSON object (used for the sealed OAuth state cookie). */
export function sealJson(obj: unknown): string {
  return encryptSecret(JSON.stringify(obj));
}

/** Decrypt + parse a sealed JSON object. Returns null on any failure. */
export function unsealJson<T>(payload: string | undefined | null): T | null {
  if (!payload) return null;
  try {
    return JSON.parse(decryptSecret(payload)) as T;
  } catch {
    return null;
  }
}

/** Constant-time string comparison for opaque tokens (e.g. OAuth state). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ── Per-integration cipher factory ───────────────────────────────────────────

/** AES-256-GCM cipher bound to one env-configured key (same "v1:" wire format). */
export type TokenCipher = {
  /** Encrypt a UTF-8 string. Returns "v1:"-prefixed base64. */
  encrypt(plaintext: string): string;
  /** Decrypt a value produced by encrypt(). Throws on tamper/format errors. */
  decrypt(payload: string): string;
  /** Encrypt a small JSON object (e.g. a sealed OAuth state cookie). */
  sealJson(obj: unknown): string;
  /** Decrypt + parse a sealed JSON object. Returns null on any failure. */
  unsealJson<T>(payload: string | undefined | null): T | null;
};

/**
 * Create a cipher bound to the 32-byte key held in `process.env[envVarName]`
 * (base64 or hex), e.g. createTokenCipher("SHOPIFY_TOKEN_ENCRYPTION_KEY").
 *
 * The key is resolved lazily on first use (never at import time) and cached
 * afterwards. Output format is identical to encryptSecret ("v1:" + base64),
 * but values are only interchangeable when the underlying keys match.
 */
export function createTokenCipher(envVarName: string): TokenCipher {
  let key: Buffer | null = null;
  const resolveKey = (): Buffer => {
    if (!key) key = decodeKeyFromEnv(envVarName, process.env[envVarName]?.trim());
    return key;
  };

  const encrypt = (plaintext: string): string => encryptWithKey(resolveKey(), plaintext);
  const decrypt = (payload: string): string => decryptWithKey(resolveKey(), payload);

  return {
    encrypt,
    decrypt,
    sealJson: (obj: unknown): string => encrypt(JSON.stringify(obj)),
    unsealJson<T>(payload: string | undefined | null): T | null {
      if (!payload) return null;
      try {
        return JSON.parse(decrypt(payload)) as T;
      } catch {
        return null;
      }
    },
  };
}
