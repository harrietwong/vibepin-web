/**
 * GET /api/auth/pinterest/connect
 *
 * Starts the Pinterest OAuth flow for the logged-in VibePin user:
 *   1. Require a Supabase cookie session.
 *   2. Generate a cryptographically random `state`.
 *   3. Seal { state, uid, exp } into an encrypted HttpOnly cookie (~10 min).
 *   4. Redirect to Pinterest's authorization page.
 *
 * The `state` param sent to Pinterest is opaque random — it never contains a user id.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getUserIdFromBearer, getUserIdFromCookies, getUserIdFromCookieSession } from "@/lib/server/authUser";
import { PINTEREST_INTEGRATIONS_PATH } from "@/lib/pinterestPaths";
import { buildAuthorizeUrl, getPinterestEnv, isPinterestConfigured } from "@/lib/server/pinterest/config";
import { ConfigurationError } from "@/lib/server/pinterest/errors";
import { isEncryptionConfigured } from "@/lib/server/crypto";
import {
  OAUTH_STATE_COOKIE,
  OAUTH_RETURN_COOKIE,
  generateState,
  sealState,
  stateCookieOptions,
  returnCookieOptions,
} from "@/lib/server/pinterest/oauthState";

export const dynamic = "force-dynamic";

function integrationsRedirect(req: NextRequest, status: string): NextResponse {
  const url = req.nextUrl.clone();
  url.pathname = PINTEREST_INTEGRATIONS_PATH;
  url.search = `?pinterest=${status}`;
  return NextResponse.redirect(url);
}

function sanitizeReturnTo(value: string | null | undefined): string {
  if (!value) return PINTEREST_INTEGRATIONS_PATH;
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded.startsWith("/app/")) return PINTEREST_INTEGRATIONS_PATH;
    if (decoded.startsWith("//") || decoded.includes("://")) return PINTEREST_INTEGRATIONS_PATH;
    return decoded;
  } catch {
    return PINTEREST_INTEGRATIONS_PATH;
  }
}

function loginRedirect(req: NextRequest, returnTo: string): NextResponse {
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(returnTo)}`;
  return NextResponse.redirect(url);
}

type ConnectPayload = { authorizeUrl: string; state: string };
type ConnectTimings = {
  returnTo: number;
  auth: number;
  state: number;
  authUrl: number;
  total: number;
};

function connectConfigError(): ConfigurationError | null {
  if (!isEncryptionConfigured()) {
    return new ConfigurationError(
      "PINTEREST_TOKEN_ENC_KEY is not set — add it to web/.env.local, then restart the dev server.",
    );
  }
  if (!isPinterestConfigured()) {
    return new ConfigurationError(
      "Pinterest OAuth env is incomplete — set PINTEREST_APP_ID, PINTEREST_APP_SECRET, and PINTEREST_REDIRECT_URI in web/.env.local.",
    );
  }
  return null;
}

function buildConnectPayload(): ConnectPayload {
  const configErr = connectConfigError();
  if (configErr) throw configErr;
  const env = getPinterestEnv();
  const state = generateState();
  const authorizeUrl = buildAuthorizeUrl(env, state);
  return { authorizeUrl, state };
}

function attachOAuthStateCookie(
  res: NextResponse,
  req: NextRequest,
  state: string,
  uid: string,
  returnTo: string,
): NextResponse {
  try {
    res.cookies.set(
      OAUTH_STATE_COOKIE,
      sealState(state, uid, returnTo),
      stateCookieOptions(req.nextUrl.protocol === "https:"),
    );
    return res;
  } catch (err) {
    console.error("[pinterest/connect] seal state failed:", (err as Error).message);
    throw new ConfigurationError("Pinterest OAuth could not be started — check PINTEREST_TOKEN_ENC_KEY.");
  }
}

function configErrorResponse(req: NextRequest, err: ConfigurationError, asJson: boolean): NextResponse {
  console.error("[pinterest/connect] config error:", err.message);
  if (asJson) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 500 });
  }
  return integrationsRedirect(req, "config_error");
}

async function resolveUserId(req: NextRequest): Promise<string | null> {
  return (await getUserIdFromBearer(req)) ?? (await getUserIdFromCookies());
}

async function resolveNavigationUserId(): Promise<string | null> {
  return getUserIdFromCookieSession();
}

/**
 * Attach a dev-only Server-Timing header so the connect-route latency can be broken
 * down in the browser Network panel (no secrets, no user data — only durations).
 */
function withServerTiming(res: NextResponse, marks: Record<string, number>): NextResponse {
  if (process.env.NODE_ENV !== "production") {
    res.headers.set(
      "Server-Timing",
      Object.entries(marks).map(([name, dur]) => `${name};dur=${dur.toFixed(1)}`).join(", "),
    );
  }
  return res;
}

const SLOW_STEP_MS = 500;

/** Logs which step was slow whenever a pre-redirect step exceeds SLOW_STEP_MS. */
function warnOnSlowSteps(marks: Record<string, number>): void {
  if (process.env.NODE_ENV === "production") return;
  if (typeof marks.auth === "number") console.log(`[Pinterest OAuth start] session/auth lookup: ${marks.auth.toFixed(1)} ms`);
  if (typeof marks.returnTo === "number") console.log(`[Pinterest OAuth start] returnTo parse/validate: ${marks.returnTo.toFixed(1)} ms`);
  if (typeof marks.state === "number") console.log(`[Pinterest OAuth start] state create/store: ${marks.state.toFixed(1)} ms`);
  if (typeof marks.authUrl === "number") console.log(`[Pinterest OAuth start] auth URL constructed: ${marks.authUrl.toFixed(1)} ms`);
  if (typeof marks.total === "number") console.log(`[Pinterest OAuth start] redirect response returned: ${marks.total.toFixed(1)} ms`);
  for (const [name, dur] of Object.entries(marks)) {
    if (dur > SLOW_STEP_MS) {
      console.warn(`[pinterest/connect] slow step "${name}": ${dur.toFixed(1)}ms`);
    }
  }
}

export async function GET(req: NextRequest) {
  const t0 = performance.now();
  const timings: Partial<ConnectTimings> = {};
  const tReturnTo = performance.now();
  const returnTo = sanitizeReturnTo(req.nextUrl.searchParams.get("next"));
  timings.returnTo = performance.now() - tReturnTo;

  const tAuth = performance.now();
  const uid = await resolveNavigationUserId();
  timings.auth = performance.now() - tAuth;
  if (!uid) {
    timings.total = performance.now() - t0;
    warnOnSlowSteps(timings as Record<string, number>);
    return withServerTiming(loginRedirect(req, returnTo), timings as Record<string, number>);
  }

  let payload: ConnectPayload;
  try {
    const tPayload = performance.now();
    const configErr = connectConfigError();
    if (configErr) throw configErr;
    const state = generateState();
    timings.state = performance.now() - tPayload;
    const tAuthUrl = performance.now();
    payload = { state, authorizeUrl: buildAuthorizeUrl(getPinterestEnv(), state) };
    timings.authUrl = performance.now() - tAuthUrl;
  } catch (err) {
    if (err instanceof ConfigurationError) return configErrorResponse(req, err, false);
    console.error("[pinterest/connect] unexpected error:", (err as Error).message);
    return integrationsRedirect(req, "config_error");
  }

  const res = NextResponse.redirect(payload.authorizeUrl);
  // Plain returnTo cookie (no secret) so the callback can send the user back to the
  // exact origin Pin even if state validation later fails. Mirrors the sealed cookie's
  // lifetime/scope. Cleared by the callback alongside the state cookie.
  res.cookies.set(OAUTH_RETURN_COOKIE, returnTo, returnCookieOptions(req.nextUrl.protocol === "https:"));
  try {
    const tStateStore = performance.now();
    const sealed = attachOAuthStateCookie(res, req, payload.state, uid, returnTo);
    timings.state = (timings.state ?? 0) + (performance.now() - tStateStore);
    timings.total = performance.now() - t0;
    warnOnSlowSteps(timings as Record<string, number>);
    return withServerTiming(sealed, timings as Record<string, number>);
  } catch (err) {
    if (err instanceof ConfigurationError) return configErrorResponse(req, err, false);
    return integrationsRedirect(req, "config_error");
  }
}

/**
 * Bearer-friendly OAuth bootstrap — used when JSON APIs auth via Authorization
 * header. This is the path the "Connect" button actually calls, so it's the hot
 * path for click-to-redirect latency: no board sync, no profile fetch, no
 * connection-status refresh, nothing beyond resolving the user and building the
 * authorize URL happens before the response goes out.
 */
export async function POST(req: NextRequest) {
  const t0 = performance.now();
  let returnTo = PINTEREST_INTEGRATIONS_PATH;
  try {
    const body = await req.json() as { next?: string };
    returnTo = sanitizeReturnTo(body.next ?? null);
  } catch {
    /* empty body ok */
  }

  const uid = await resolveUserId(req);
  const authDur = performance.now() - t0;
  if (!uid) {
    warnOnSlowSteps({ auth: authDur });
    return withServerTiming(
      NextResponse.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401 }),
      { auth: authDur, total: performance.now() - t0 },
    );
  }

  let payload: ConnectPayload;
  const tPayload = performance.now();
  try {
    payload = buildConnectPayload();
  } catch (err) {
    if (err instanceof ConfigurationError) return configErrorResponse(req, err, true);
    console.error("[pinterest/connect] unexpected error:", (err as Error).message);
    return NextResponse.json({ error: "Pinterest is not configured", code: "config_error" }, { status: 500 });
  }
  const stateDur = performance.now() - tPayload;

  const res = NextResponse.json({ url: payload.authorizeUrl });
  try {
    const sealed = attachOAuthStateCookie(res, req, payload.state, uid, returnTo);
    const total = performance.now() - t0;
    warnOnSlowSteps({ auth: authDur, state: stateDur, total });
    return withServerTiming(sealed, { auth: authDur, state: stateDur, total });
  } catch (err) {
    if (err instanceof ConfigurationError) return configErrorResponse(req, err, true);
    return NextResponse.json({ error: "Pinterest OAuth could not be started", code: "config_error" }, { status: 500 });
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
