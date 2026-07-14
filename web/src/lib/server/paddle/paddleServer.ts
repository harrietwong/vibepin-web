/**
 * Server-only Paddle Node SDK singleton.
 *
 * Reads PADDLE_API_KEY + NEXT_PUBLIC_PADDLE_ENV. Never silently defaults the
 * environment — an unset/invalid value throws so a misconfiguration surfaces
 * loudly (a webhook/portal 500) rather than quietly hitting the wrong Paddle
 * host. NEVER import this from client code: it would leak the API key into the
 * browser bundle.
 */

import { Environment, Paddle } from "@paddle/paddle-node-sdk";

let cached: Paddle | null = null;

/** Parse NEXT_PUBLIC_PADDLE_ENV into the SDK Environment; throws on anything else. */
function resolveEnvironment(): Environment {
  const raw = (process.env.NEXT_PUBLIC_PADDLE_ENV ?? "").trim();
  if (raw === "production") return Environment.production;
  if (raw === "sandbox") return Environment.sandbox;
  throw new Error(
    `NEXT_PUBLIC_PADDLE_ENV must be exactly "production" or "sandbox" (got ${
      raw === "" ? "empty/unset" : `"${raw}"`
    }).`,
  );
}

/** Lazy singleton Paddle Node SDK client (server-side). */
export function getPaddleServer(): Paddle {
  if (cached) return cached;

  const apiKey = (process.env.PADDLE_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error("PADDLE_API_KEY is not set (server-side Paddle API key required).");
  }

  cached = new Paddle(apiKey, { environment: resolveEnvironment() });
  return cached;
}
