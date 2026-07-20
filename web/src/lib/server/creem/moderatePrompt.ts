/**
 * Creem prompt-moderation client — the AI-compliance gate for image generation.
 *
 * FAIL-CLOSED by design: any outcome that is not an explicit "allow" blocks
 * generation. `deny`/`flag` → rejected; a missing key, a network/timeout error,
 * a non-2xx response, malformed JSON, a missing/unknown `decision` → "unavailable"
 * (the request is refused rather than silently allowed).
 *
 * Creem Moderation API (confirmed from docs.creem.io):
 *   POST {base}/v1/moderation/prompt
 *   header  x-api-key: <moderation key>
 *   body    { prompt: string, external_id?: string }
 *   200     { id, object:"moderation_result", prompt, external_id,
 *             decision: "allow"|"deny"|"flag", usage:{units} }
 *
 * KEY SEPARATION (deliberate): moderation reads a DEDICATED
 * `CREEM_MODERATION_API_KEY`, NOT the billing `CREEM_API_KEY`. This breaks a
 * startup deadlock — the review/Demo phase runs CREEM_MODE=disabled with the
 * billing key EMPTY (checkout stays "Coming soon"), while moderation still needs
 * a working (test) key so Create Pins can generate. Sharing one key made
 * "production deploy succeeds" and "Demo can generate" mutually exclusive (the
 * predeploy guard rejects a test billing key). A test MODERATION key never opens
 * checkout, so the guard does not police it. For backward-compat and the later
 * all-live phase, if `CREEM_MODERATION_API_KEY` is unset we fall back to
 * `CREEM_API_KEY` (so a single live key can serve both once billing goes live).
 *
 * Base URL is chosen by the moderation key's prefix exactly like
 * web/src/lib/server/creem/creemClient.ts (creem_test_ → test endpoint, else
 * prod). We do NOT import creemClient (it is under a hard freeze) — the 2-line
 * rule is replicated here with this pointer.
 *
 * Server-only: reads process.env. NEVER import into client code and NEVER prefix
 * the key with NEXT_PUBLIC_.
 */

const PROD_BASE_URL = "https://api.creem.io";
const TEST_BASE_URL = "https://test-api.creem.io";
const MODERATION_PATH = "/v1/moderation/prompt";
const MODERATION_TIMEOUT_MS = 5000;

export type ModerationResult =
  | { ok: true; resultId: string }
  | { ok: false; reason: "rejected" | "unavailable"; resultId?: string };

export type ModeratePromptInput = {
  prompt: string;
  externalId?: string;
};

export type ModeratePromptDeps = {
  /** Injected for tests so the live path stays pure. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
};

/**
 * Resolve the moderation base URL from an api key, mirroring creemClient's rule:
 * a `creem_test_` key routes to the test endpoint; anything else is treated as
 * live. Exported for test assertions.
 */
export function moderationBaseUrl(apiKey: string): string {
  return apiKey.trim().startsWith("creem_test_") ? TEST_BASE_URL : PROD_BASE_URL;
}

type RawModerationResponse = {
  id?: unknown;
  decision?: unknown;
};

function logModeration(fields: {
  resultId: string | null;
  decision: string | null;
  externalId: string | null;
  httpStatus: number | null;
  durationMs: number;
}): void {
  // Structured JSON log. NEVER log the api key, the raw prompt, images, or secrets.
  // externalId is a non-sensitive reference (a generation request id), never PII.
  console.log(
    JSON.stringify({
      event: "prompt_moderation",
      resultId: fields.resultId,
      decision: fields.decision,
      externalId: fields.externalId,
      httpStatus: fields.httpStatus,
      durationMs: fields.durationMs,
      ts: new Date().toISOString(),
    }),
  );
}

/**
 * Screen a user-submitted prompt through Creem moderation.
 *
 * Test seam: when ALLOW_GENERATION_MOCK_PROVIDER==="true", the env
 * MODERATION_MOCK_DECISION forces a deterministic outcome without any network
 * call. It is IGNORED in every other case, so production can never mock
 * moderation. Accepted values: allow | flag | deny | timeout | error |
 * malformed | non2xx | unknown | missing_key.
 */
export async function moderatePrompt(
  input: ModeratePromptInput,
  deps: ModeratePromptDeps = {},
): Promise<ModerationResult> {
  const externalId = input.externalId ?? null;

  // ── Test-only deterministic seam (never active in production) ────────────────
  if (process.env.ALLOW_GENERATION_MOCK_PROVIDER === "true") {
    const forced = (process.env.MODERATION_MOCK_DECISION ?? "").trim().toLowerCase();
    if (forced) {
      return applyMockDecision(forced, externalId);
    }
  }

  // Dedicated moderation key; fall back to the billing key only when the dedicated
  // one is unset (single-live-key phase). See the module header for why these are
  // separate during the disabled/Demo phase.
  const apiKey =
    (process.env.CREEM_MODERATION_API_KEY ?? "").trim() ||
    (process.env.CREEM_API_KEY ?? "").trim();
  if (!apiKey) {
    // Fail closed. Log a config error but do NOT throw — the route maps this to 503.
    console.error(
      JSON.stringify({
        event: "prompt_moderation",
        error: "config_error",
        message: "No moderation key set (CREEM_MODERATION_API_KEY / CREEM_API_KEY) — cannot moderate prompts. Blocking generation (fail-closed).",
        externalId,
        ts: new Date().toISOString(),
      }),
    );
    return { ok: false, reason: "unavailable" };
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const baseUrl = moderationBaseUrl(apiKey);
  const start = Date.now();
  let httpStatus: number | null = null;

  try {
    const res = await fetchImpl(`${baseUrl}${MODERATION_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({ prompt: input.prompt, external_id: externalId ?? undefined }),
      cache: "no-store",
      signal: AbortSignal.timeout(MODERATION_TIMEOUT_MS),
    });
    httpStatus = res.status;

    if (!res.ok) {
      logModeration({ resultId: null, decision: null, externalId, httpStatus, durationMs: Date.now() - start });
      return { ok: false, reason: "unavailable" };
    }

    let data: RawModerationResponse;
    try {
      data = (await res.json()) as RawModerationResponse;
    } catch {
      logModeration({ resultId: null, decision: "malformed", externalId, httpStatus, durationMs: Date.now() - start });
      return { ok: false, reason: "unavailable" };
    }

    const decision = typeof data.decision === "string" ? data.decision : null;
    const resultId = typeof data.id === "string" ? data.id : undefined;
    logModeration({ resultId: resultId ?? null, decision, externalId, httpStatus, durationMs: Date.now() - start });

    if (decision === "allow") {
      // A valid allow must carry an id; a missing id is malformed → block.
      if (!resultId) return { ok: false, reason: "unavailable" };
      return { ok: true, resultId };
    }
    if (decision === "deny" || decision === "flag") {
      return { ok: false, reason: "rejected", resultId };
    }
    // Missing / unknown decision string → unknown blocks (fail-closed).
    return { ok: false, reason: "unavailable" };
  } catch (err) {
    // Network error OR AbortError (timeout) → unavailable.
    const decision = (err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError" ? "timeout" : "network_error";
    logModeration({ resultId: null, decision, externalId, httpStatus, durationMs: Date.now() - start });
    return { ok: false, reason: "unavailable" };
  }
}

function applyMockDecision(forced: string, externalId: string | null): ModerationResult {
  const start = Date.now();
  switch (forced) {
    case "allow":
      logModeration({ resultId: "mock_allow", decision: "allow", externalId, httpStatus: 200, durationMs: Date.now() - start });
      return { ok: true, resultId: "mock_allow" };
    case "flag":
      logModeration({ resultId: "mock_flag", decision: "flag", externalId, httpStatus: 200, durationMs: Date.now() - start });
      return { ok: false, reason: "rejected", resultId: "mock_flag" };
    case "deny":
      logModeration({ resultId: "mock_deny", decision: "deny", externalId, httpStatus: 200, durationMs: Date.now() - start });
      return { ok: false, reason: "rejected", resultId: "mock_deny" };
    case "unknown":
      logModeration({ resultId: "mock_unknown", decision: "sideways", externalId, httpStatus: 200, durationMs: Date.now() - start });
      return { ok: false, reason: "unavailable" };
    case "non2xx":
      logModeration({ resultId: null, decision: null, externalId, httpStatus: 500, durationMs: Date.now() - start });
      return { ok: false, reason: "unavailable" };
    case "malformed":
      logModeration({ resultId: null, decision: "malformed", externalId, httpStatus: 200, durationMs: Date.now() - start });
      return { ok: false, reason: "unavailable" };
    case "timeout":
      logModeration({ resultId: null, decision: "timeout", externalId, httpStatus: null, durationMs: Date.now() - start });
      return { ok: false, reason: "unavailable" };
    case "error":
    case "missing_key":
    default:
      logModeration({ resultId: null, decision: "network_error", externalId, httpStatus: null, durationMs: Date.now() - start });
      return { ok: false, reason: "unavailable" };
  }
}
