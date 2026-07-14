/**
 * Client-side Paddle Billing loader.
 *
 * Lazy singleton around `initializePaddle` from @paddle/paddle-js. The
 * environment and client-side token come from NEXT_PUBLIC_ env vars only —
 * this module never touches PADDLE_API_KEY (that server secret must never
 * reach the browser).
 *
 * If the required env vars are missing or invalid, `getPaddle()` throws a
 * descriptive Error. Callers (e.g. the pricing page) catch it and fall back to
 * static rendering — we never silently default the environment or hardcode a
 * token.
 */
import { initializePaddle, type Environments, type Paddle } from "@paddle/paddle-js";

let paddlePromise: Promise<Paddle> | null = null;

function readEnvironment(): Environments {
  const env = process.env.NEXT_PUBLIC_PADDLE_ENV;
  if (env !== "production" && env !== "sandbox") {
    throw new Error(
      `Paddle is not configured: NEXT_PUBLIC_PADDLE_ENV must be exactly "production" or "sandbox" (got ${
        env ? `"${env}"` : "empty"
      }).`,
    );
  }
  return env;
}

function readToken(): string {
  const token = process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN;
  if (!token) {
    throw new Error(
      "Paddle is not configured: NEXT_PUBLIC_PADDLE_CLIENT_TOKEN is missing.",
    );
  }
  return token;
}

/**
 * Returns a ready Paddle instance, initializing it once per page load.
 * Throws if the env vars are missing/invalid, or if Paddle.js fails to load.
 */
export function getPaddle(): Promise<Paddle> {
  if (paddlePromise) return paddlePromise;

  const environment = readEnvironment();
  const token = readToken();

  paddlePromise = initializePaddle({ environment, token }).then(paddle => {
    if (!paddle) {
      throw new Error("Paddle failed to initialize (Paddle.js returned undefined).");
    }
    return paddle;
  });

  // Do not cache a rejected promise — allow a later retry.
  paddlePromise.catch(() => {
    paddlePromise = null;
  });

  return paddlePromise;
}
