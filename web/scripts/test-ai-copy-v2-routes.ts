process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service";

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Module } from "node:module";
import type { RateLimitStore, WindowKey } from "../src/lib/server/rateLimit";
import type { ClaimGenerationParams, ClaimSessionParams, GenerationLedgerRow, SessionRow, SessionStore } from "../src/lib/ai-copy/v2/sessionStore";
import type { CopyGenerationProvider, ProviderCopyOutput } from "../src/lib/ai-copy/v2/orchestrator";

let passed = 0, failed = 0;
async function test(name: string, fn: () => unknown | Promise<unknown>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.error(`  ✗ ${name}\n    ${(error as Error).stack}`); }
}
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const eq = (actual: unknown, expected: unknown, message: string) => { if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); };
const delay = (ms: number) => new Promise(resolveDelay => setTimeout(resolveDelay, ms));

let mockUserId: string | null = "user_123";
let productionDb: unknown = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const originalLoad = (Module as any)._load;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module as any)._load = function(request: string, parent: unknown, isMain: boolean) {
  if (request.includes("server/authUser")) return { getUserIdFromBearerOrCookies: async () => mockUserId };
  if (request === "@/lib/supabase" || request.endsWith("/lib/supabase")) return { createServerClient: () => productionDb };
  return originalLoad.call(this, request, parent, isMain);
};

function rateStore(): RateLimitStore {
  const hits = new Map<string, number>();
  const key = (k: WindowKey) => `${k.userId}:${k.route}:${k.windowStart}`;
  return {
    async read(k) { const value = hits.get(key(k)); return value == null ? null : { hits: value }; },
    async create(k) { if (hits.has(key(k))) return false; hits.set(key(k), 1); return true; },
    async bump(k, seen) { if (hits.get(key(k)) !== seen) return false; hits.set(key(k), seen + 1); return true; },
    async prune() {},
  };
}

function memoryStore(options: { failCompleteSessionOnce?: boolean } = {}) {
  const sessions = new Map<string, SessionRow>();
  const generations = new Map<string, GenerationLedgerRow>();
  let failComplete = Boolean(options.failCompleteSessionOnce);
  const store: SessionStore & { sessions: typeof sessions; generations: typeof generations; sessionClaims: number; generationClaims: number } = {
    sessions, generations, sessionClaims: 0, generationClaims: 0,
    async claimSession(p: ClaimSessionParams) {
      const existing = [...sessions.values()].find(s => s.vibepin_user_id === p.userId && s.analyze_idempotency_key === p.analyzeIdempotencyKey);
      if (existing) {
        if (existing.status === "completed") return { state: "completed" as const, row: existing };
        const leased = existing as SessionRow & { claim_token: string; claim_expires_at: string };
        if (leased.claim_expires_at > new Date().toISOString()) return { state: "pending" as const, row: existing };
        leased.claim_token = randomUUID(); leased.claim_expires_at = new Date(Date.now() + 30_000).toISOString(); leased.updated_at = new Date().toISOString();
        return { state: "claimed" as const, row: existing };
      }
      store.sessionClaims++;
      const now = new Date().toISOString();
      const row: SessionRow = {
        id: randomUUID(), vibepin_user_id: p.userId, workspace_id: p.workspaceId, draft_id: p.draftId,
        analyze_idempotency_key: p.analyzeIdempotencyKey, status: "pending", claim_token: randomUUID(), claim_expires_at: new Date(Date.now() + 30_000).toISOString(), fact_card: null, keyword_evidence: null,
        last_output: null, validation_report: null, model_version: p.modelVersion, prompt_version: p.promptVersion,
        last_generation_idempotency_key: null, generation_count: 0,
        expires_at: p.expiresAtIso ?? new Date(Date.now() + 86_400_000).toISOString(), created_at: now, updated_at: now,
      };
      sessions.set(row.id, row); return { state: "claimed" as const, row };
    },
    async completeSession(p) {
      if (failComplete) { failComplete = false; throw new Error("db down"); }
      const row = sessions.get(p.sessionId);
      if (!row || row.vibepin_user_id !== p.userId || row.status !== "pending" || (row as SessionRow & { claim_token: string }).claim_token !== (p as typeof p & { claimToken?: string }).claimToken) throw new Error("bad claim");
      row.fact_card = p.factCard; row.keyword_evidence = p.keywordEvidence; row.status = "completed"; row.updated_at = new Date().toISOString(); return row;
    },
    async releaseSessionClaim(id, userId, claimToken?: string) { const row = sessions.get(id); if (row?.status === "pending" && row.vibepin_user_id === userId && (row as SessionRow & { claim_token: string }).claim_token === claimToken) sessions.delete(id); },
    async getValidSession(id, userId, now = new Date().toISOString()) {
      const row = sessions.get(id); return row && row.vibepin_user_id === userId && row.status === "completed" && row.expires_at > now ? row : null;
    },
    async claimGeneration(p: ClaimGenerationParams) {
      const key = `${p.sessionId}:${p.userId}:${p.idempotencyKey}`;
      const existing = generations.get(key);
      if (existing) {
        if (existing.status === "completed") return { state: "completed" as const, row: existing };
        const leased = existing as GenerationLedgerRow & { claim_token: string; claim_expires_at: string };
        if (leased.claim_expires_at > new Date().toISOString()) return { state: "pending" as const, row: existing };
        leased.claim_token = randomUUID(); leased.claim_expires_at = new Date(Date.now() + 30_000).toISOString(); leased.output = null; leased.validation_report = null; leased.updated_at = new Date().toISOString();
        return { state: "claimed" as const, row: existing };
      }
      store.generationClaims++;
      const now = new Date().toISOString();
      const row: GenerationLedgerRow = { id: randomUUID(), session_id: p.sessionId, vibepin_user_id: p.userId, idempotency_key: p.idempotencyKey, status: "pending", claim_token: randomUUID(), claim_expires_at: new Date(Date.now() + 30_000).toISOString(), angle_id: p.angleId ?? null, output: null, validation_report: null, created_at: now, updated_at: now };
      generations.set(key, row); return { state: "claimed" as const, row };
    },
    async completeGeneration(p) {
      const row = [...generations.values()].find(g => g.id === p.generationId && g.session_id === p.sessionId && g.vibepin_user_id === p.userId);
      const session = sessions.get(p.sessionId);
      if (!row || row.status !== "pending" || !session || session.status !== "completed" || (row as GenerationLedgerRow & { claim_token: string }).claim_token !== (p as typeof p & { claimToken?: string }).claimToken) throw new Error("bad generation claim");
      row.status = "completed"; row.output = p.output; row.validation_report = p.validationReport; row.updated_at = new Date().toISOString();
      session.last_output = p.output; session.validation_report = p.validationReport; session.last_generation_idempotency_key = row.idempotency_key; session.generation_count++; return row;
    },
    async releaseGenerationClaim(id, sessionId, userId, claimToken?: string) {
      for (const [key, row] of generations) if (row.id === id && row.session_id === sessionId && row.vibepin_user_id === userId && row.status === "pending" && (row as GenerationLedgerRow & { claim_token: string }).claim_token === claimToken) generations.delete(key);
    },
  };
  return store;
}

type TestProviderOutput = ProviderCopyOutput & { detectedClaims?: Array<Record<string, unknown>> };
const validOutput = (overrides: Partial<TestProviderOutput> = {}): TestProviderOutput => ({
  title: "Modern Reading Corner", description: "Create a calm reading corner with warm neutral details.", altText: "A calm reading corner", detectedClaims: [], ...overrides,
});
const analyzeReq = (key: string, extra: Record<string, unknown> = {}) => new Request("http://x/api/ai-copy/v2/analyze", { method: "POST", body: JSON.stringify({ draftId: "draft_1", idempotencyKey: key, ...extra }) });
const generateReq = (sessionId: string, key: string, extra: Record<string, unknown> = {}) => new Request("http://x/api/ai-copy/v2/generate", { method: "POST", body: JSON.stringify({ sessionId, idempotencyKey: key, ...extra }) });

async function seed(store: ReturnType<typeof memoryStore>, overrides: Partial<SessionRow> = {}) {
  const claim = await store.claimSession({ userId: "user_123", workspaceId: "user_123", draftId: "draft_1", analyzeIdempotencyKey: randomUUID(), modelVersion: "test:model", promptVersion: "p" });
  const row = claim.row;
  await store.completeSession({ sessionId: row.id, userId: "user_123", claimToken: (row as SessionRow & { claim_token: string }).claim_token, factCard: { version: "fact-card-v1", sessionId: row.id, draftId: "draft_1", locale: "en", facts: [] }, keywordEvidence: { keywordSetId: "ks", sessionId: row.id, draftId: "draft_1", candidates: [], selectedKeywordIds: [], degradedMode: "no_keyword_demand_data" } } as Parameters<SessionStore["completeSession"]>[0]);
  Object.assign(row, overrides); return row;
}

async function main() {
  const { __setRateLimitStoreForTests } = await import("../src/lib/server/rateLimit");
  const sessionModule = await import("../src/lib/ai-copy/v2/sessionStore");
  const { __setCopyProviderForTests, orchestrateCopyGeneration, buildPromptForSession } = await import("../src/lib/ai-copy/v2/orchestrator");
  const { __setTrendKeywordLoaderForTests, TREND_KEYWORD_SELECT_FIELDS } = await import("../src/lib/ai-copy/v2/trendKeywordSource");
  const { POST: analyze } = await import("../src/app/api/ai-copy/v2/analyze/route");
  const { POST: generate } = await import("../src/app/api/ai-copy/v2/generate/route");
  const setProvider = (provider: Record<string, unknown>) => {
    const generated = provider.generate as ((...args: unknown[]) => Promise<ProviderCopyOutput>) | undefined;
    __setCopyProviderForTests({
      ...provider,
      generate: generated!,
      detectClaims: provider.detectClaims ?? (async (output: TestProviderOutput) => ({
        status: "completed", claims: output.detectedClaims ?? [],
      })),
    } as unknown as CopyGenerationProvider);
  };
  const reset = (store = memoryStore()) => {
    process.env.AI_COPY_V2_ENABLED = "true"; mockUserId = "user_123";
    __setRateLimitStoreForTests(rateStore()); sessionModule.__setSessionStoreForTests(store);
    __setTrendKeywordLoaderForTests(async () => []); setProvider({ async generate() { return validOutput(); } });
    return store;
  };

  await test("trend keyword select matches the versioned schema", () => {
    const fields = TREND_KEYWORD_SELECT_FIELDS.split(",");
    for (const required of ["id", "keyword", "region", "data_quality", "source", "source_layer"]) assert(fields.includes(required), `select includes ${required}`);
    for (const missing of ["language", "locale", "country"]) assert(!fields.includes(missing), `select excludes nonexistent ${missing}`);
  });

  await test("feature off is 404 and unauthenticated is 401", async () => {
    reset(); delete process.env.AI_COPY_V2_ENABLED; eq((await analyze(analyzeReq("a"))).status, 404, "flag");
    process.env.AI_COPY_V2_ENABLED = "true"; mockUserId = null; eq((await analyze(analyzeReq("b"))).status, 401, "auth");
  });

  await test("malformed bodies are rejected", async () => {
    reset(); eq((await analyze(analyzeReq("", { userKeywords: "bad" }))).status, 400, "analyze body");
    eq((await generate(generateReq("x", "y", { lengthPreference: "huge" }))).status, 400, "generate body");
  });

  await test("429 is returned before body parsing or provider work", async () => {
    const store = reset();
    __setRateLimitStoreForTests({
      async read() { return { hits: 999 }; }, async create() { return false; },
      async bump() { return false; }, async prune() {},
    });
    let providerCalls = 0;
    setProvider({ async generate() { providerCalls++; return validOutput(); } });
    const response = await analyze(new Request("http://x/api/ai-copy/v2/analyze", { method: "POST", body: "not-json" }));
    eq(response.status, 429, "limited before JSON"); eq(providerCalls, 0, "no provider"); eq(store.sessionClaims, 0, "no DB claim");
  });

  await test("analyze preserves raw trend ID and data quality; client semantics are asserted", async () => {
    const store = reset();
    __setTrendKeywordLoaderForTests(async () => [{ id: "raw-db-id", keyword: "oak desk ideas", data_quality: "estimated", language: "en", volume_score: 4 }]);
    const response = await analyze(analyzeReq("raw", { productContext: { title: "Oak Desk", vendor: "Acme", price: "$20", availability: "in stock" }, pageContext: { title: "Oak collection" }, imageObserved: { summary: "oak desk" }, boardContext: { name: "Office ideas" }, userKeywords: ["desk office"] }));
    eq(response.status, 200, "status"); const json = await response.json();
    assert(/^[0-9a-f-]{36}$/.test(json.sessionId), "real UUID session");
    eq(json.keywordEvidence.candidates[0].id, "raw-db-id", "raw id"); eq(json.keywordEvidence.candidates[0].provenance, "estimated", "quality");
    assert(json.factCard.facts.every((f: { trustLevel: string }) => ["asserted", "observed"].includes(f.trustLevel)), "client facts never marked verified");
    const sources = new Set(json.factCard.facts.map((f: { source: string }) => f.source));
    for (const source of ["product_catalog", "page_metadata", "image_observed", "board_context"]) assert(sources.has(source), `source preserved: ${source}`);
    for (const key of ["product_vendor", "product_price", "product_availability"]) {
      const fact = json.factCard.facts.find((f: { key: string }) => f.key === key);
      eq(fact?.claimPolicy, "copy_allowed", `${key} is explicitly asserted`); eq(fact?.claimPolarity, "affirmed", `${key} polarity`);
    }
    assert(!json.factCard.facts.some((f: { key: string }) => f.key === "user_keywords"), "keywords are relevance only");
    eq(store.sessionClaims, 1, "one claim");
  });

  await test("true concurrent analyze claims before delayed loader; loser is 409 and spends zero", async () => {
    const store = reset(); let loads = 0;
    __setTrendKeywordLoaderForTests(async () => { loads++; await delay(40); return []; });
    const [a, b] = await Promise.all([analyze(analyzeReq("race")), analyze(analyzeReq("race"))]);
    const statuses = [a.status, b.status].sort(); eq(statuses.join(","), "200,409", "race statuses"); eq(loads, 1, "one loader call"); eq(store.sessionClaims, 1, "one claim");
  });

  await test("completed analyze idempotency replays the original session", async () => {
    reset(); let loads = 0; __setTrendKeywordLoaderForTests(async () => { loads++; return []; });
    const first = await analyze(analyzeReq("replay-analysis")); const firstJson = await first.json();
    const replay = await analyze(analyzeReq("replay-analysis", { draftId: "changed" })); const replayJson = await replay.json();
    eq(replay.status, 200, "replay status"); eq(replayJson.replayed, true, "replay marker"); eq(replayJson.sessionId, firstJson.sessionId, "same session"); eq(loads, 1, "no second load");
  });

  await test("failed analyze finalization releases claim for retry", async () => {
    const store = reset(memoryStore({ failCompleteSessionOnce: true }));
    eq((await analyze(analyzeReq("retry-analysis"))).status, 502, "first fails");
    eq((await analyze(analyzeReq("retry-analysis"))).status, 200, "retry succeeds"); eq(store.sessionClaims, 2, "new atomic claim");
  });

  await test("expired session lease has one stealer and stale owner cannot finalize or release", async () => {
    const store = memoryStore();
    const params = { userId: "user_123", workspaceId: "user_123", draftId: "d", analyzeIdempotencyKey: "lease", modelVersion: "m", promptVersion: "p" };
    const first = await store.claimSession(params); const staleToken = (first.row as SessionRow & { claim_token: string }).claim_token;
    (first.row as SessionRow & { claim_expires_at: string }).claim_expires_at = new Date(0).toISOString();
    const [stealA, stealB] = await Promise.all([store.claimSession(params), store.claimSession(params)]);
    eq([stealA.state, stealB.state].sort().join(","), "claimed,pending", "one atomic stealer");
    const active = stealA.state === "claimed" ? stealA : stealB; const activeToken = (active.row as SessionRow & { claim_token: string }).claim_token;
    let staleFailed = false;
    try { await store.completeSession({ sessionId: first.row.id, userId: "user_123", claimToken: staleToken, factCard: {} as never, keywordEvidence: {} as never } as never); } catch { staleFailed = true; }
    assert(staleFailed, "stale finalizer rejected"); await (store.releaseSessionClaim as unknown as (...a: string[]) => Promise<void>)(first.row.id, "user_123", staleToken);
    assert(store.sessions.has(first.row.id), "stale release did not delete new claim"); assert(activeToken !== staleToken, "token rotated");
  });

  await test("foreign, expired, pending sessions are all concealed as 404", async () => {
    const store = reset(); const good = await seed(store);
    mockUserId = "other"; eq((await generate(generateReq(good.id, "x"))).status, 404, "foreign");
    mockUserId = "user_123"; good.expires_at = new Date(0).toISOString(); eq((await generate(generateReq(good.id, "y"))).status, 404, "expired");
    good.expires_at = new Date(Date.now() + 10000).toISOString(); good.status = "pending"; eq((await generate(generateReq(good.id, "z"))).status, 404, "pending");
  });

  await test("true concurrent generation has one provider spend; completed retry replays", async () => {
    const store = reset(); const session = await seed(store); let calls = 0;
    setProvider({ async generate() { calls++; await delay(40); return validOutput(); } });
    const [a, b] = await Promise.all([generate(generateReq(session.id, "race-gen")), generate(generateReq(session.id, "race-gen"))]);
    eq([a.status, b.status].sort().join(","), "200,409", "race statuses"); eq(calls, 1, "one provider");
    const replay = await generate(generateReq(session.id, "race-gen")); eq(replay.status, 200, "replay"); eq((await replay.json()).replayed, true, "marked replay");
    eq(session.generation_count, 1, "atomic count"); eq(store.generationClaims, 1, "one claim");
  });

  await test("expired generation lease has one stealer and stale owner cannot release", async () => {
    const store = memoryStore(); const session = await seed(store); const params = { sessionId: session.id, userId: "user_123", idempotencyKey: "lease-gen" };
    const first = await store.claimGeneration(params); const staleToken = (first.row as GenerationLedgerRow & { claim_token: string }).claim_token;
    (first.row as GenerationLedgerRow & { claim_expires_at: string }).claim_expires_at = new Date(0).toISOString();
    const [a, b] = await Promise.all([store.claimGeneration(params), store.claimGeneration(params)]);
    eq([a.state, b.state].sort().join(","), "claimed,pending", "one generation stealer");
    let staleFinalizeFailed = false;
    try { await store.completeGeneration({ generationId: first.row.id, sessionId: session.id, userId: "user_123", claimToken: staleToken, output: {} as never, validationReport: { valid: true, issues: [] } }); } catch { staleFinalizeFailed = true; }
    assert(staleFinalizeFailed, "stale generation finalizer rejected");
    await (store.releaseGenerationClaim as unknown as (...a: string[]) => Promise<void>)(first.row.id, session.id, "user_123", staleToken);
    assert(store.generations.size === 1, "stale generation release rejected");
  });

  await test("generation ledger supports A then B then replay A", async () => {
    const store = reset(); const session = await seed(store); let calls = 0;
    setProvider({ async generate() { calls++; return validOutput({ title: `Version ${calls}` }); } });
    const a = await generate(generateReq(session.id, "A")); const aJson = await a.json();
    const b = await generate(generateReq(session.id, "B")); const bJson = await b.json();
    const replayA = await generate(generateReq(session.id, "A")); const replayJson = await replayA.json();
    eq(a.status, 200, "A"); eq(b.status, 200, "B"); eq(replayA.status, 200, "replay A");
    eq(replayJson.result.generationId, aJson.result.generationId, "A replay identity"); assert(replayJson.result.generationId !== bJson.result.generationId, "B remains independent"); eq(calls, 2, "only A and B spent");
  });

  await test("provider failure is safe 502 and releases generation for retry", async () => {
    const store = reset(); const session = await seed(store); let first = true;
    setProvider({ async generate() { if (first) { first = false; throw new Error("secret upstream token"); } return validOutput(); } });
    const bad = await generate(generateReq(session.id, "retry-gen")); eq(bad.status, 502, "failure"); assert(!JSON.stringify(await bad.json()).includes("secret"), "no internal leak");
    eq((await generate(generateReq(session.id, "retry-gen"))).status, 200, "retry succeeds"); eq(store.generationClaims, 2, "claim released");
  });

  await test("provider claim detector failure is a closed 422 without a repair call", async () => {
    const store = reset(); const session = await seed(store); let calls = 0;
    setProvider({ async generate() { calls++; return { title: "Acrylic Shelf", description: "Lifetime guarantee", altText: "Carbon fiber shelf" } as ProviderCopyOutput; }, detectClaims: async () => { throw new Error("detector unavailable"); } });
    const response = await generate(generateReq(session.id, "missing-claims")); const json = await response.json(); eq(response.status, 422, "detector failure rejected"); assert(json.validationReport.issues.some((i: { code: string }) => i.code === "CLAIM_DETECTION_INCOMPLETE"), "incomplete issue"); eq(calls, 1, "one generation call");
  });

  await test("provider-detected unsupported arbitrary claims return 422 without repair", async () => {
    const store = reset(); const session = await seed(store); let repaired = 0;
    setProvider({ async generate() { return validOutput({ title: "Acrylic Shelf", detectedClaims: [] }); }, async detectClaims() { return { status: "completed", claims: [{ type: "material", value: "acrylic", field: "title" }] }; }, async repair() { repaired++; return validOutput(); } });
    eq((await generate(generateReq(session.id, "claim"))).status, 422, "unsupported"); eq(repaired, 0, "no invention repair");
  });

  await test("independent detector catches Damascus steel that generation did not self-report", async () => {
    const store = reset(); const session = await seed(store); let detectorCalls = 0;
    setProvider({
      async generate() { return validOutput({ title: "Damascus Steel Knife", description: "A hand-forged Damascus steel knife.", detectedClaims: [] }); },
      async detectClaims() { detectorCalls++; return { status: "completed", claims: [{ type: "material", value: "Damascus steel", field: "description" }] }; },
    });
    const response = await generate(generateReq(session.id, "damascus"));
    eq(response.status, 422, "independent detector blocks unsupported material"); eq(detectorCalls, 1, "detector called once");
    assert(!(await response.json()).result, "problem copy is not returned");
  });

  await test("detector failure and invalid schema fail closed as CLAIM_DETECTION_INCOMPLETE", async () => {
    const store = reset(); const session = await seed(store);
    setProvider({ async generate() { return validOutput(); }, async detectClaims() { throw new Error("detector secret"); } });
    const failed = await generate(generateReq(session.id, "detector-failed")); const failedJson = await failed.json();
    eq(failed.status, 422, "failure is validation 422"); assert(failedJson.validationReport.issues.some((i: { code: string }) => i.code === "CLAIM_DETECTION_INCOMPLETE"), "incomplete issue"); assert(!JSON.stringify(failedJson).includes("secret"), "safe response");
    setProvider({ async generate() { return validOutput(); }, async detectClaims() { return { claims: "bad" }; } });
    const invalid = await generate(generateReq(session.id, "detector-invalid")); const invalidJson = await invalid.json();
    eq(invalid.status, 422, "schema invalid is 422"); assert(invalidJson.validationReport.issues.some((i: { code: string }) => i.code === "CLAIM_DETECTION_INCOMPLETE"), "schema fail closed");
  });

  await test("repair output is independently detected again", async () => {
    const store = reset(); const session = await seed(store); let detectorCalls = 0;
    setProvider({
      async generate() { return validOutput({ title: "X".repeat(101) }); },
      async repair() { return validOutput({ title: "Repaired title" }); },
      async detectClaims() { detectorCalls++; return { status: "completed", claims: [] }; },
    });
    eq((await generate(generateReq(session.id, "repair-detect"))).status, 200, "repair succeeds"); eq(detectorCalls, 2, "both outputs detected");
  });

  await test("defense traps reject acrylic, carbon fiber, and lifetime guarantee even with empty detectedClaims", async () => {
    const store = reset(); const session = await seed(store);
    setProvider({ async generate() { return validOutput({ title: "Acrylic Shelf", description: "Carbon fiber strength with a lifetime guarantee.", detectedClaims: [] }); } });
    eq((await generate(generateReq(session.id, "trap-claims"))).status, 422, "traps reject unsupported claims");
  });

  await test("empty required fields repair once; second invalid is 422", async () => {
    const store = reset(); const session = await seed(store); let repairs = 0;
    setProvider({ async generate() { return validOutput({ title: "" }); }, async repair() { repairs++; return validOutput({ title: "" }); } });
    eq((await generate(generateReq(session.id, "empty"))).status, 422, "invalid"); eq(repairs, 1, "one repair");
  });

  await test("angle request is passed and only selected accepted max-five keywords appear", async () => {
    const store = reset(); const session = await seed(store);
    session.keyword_evidence = {
      keywordSetId: "ks", candidates: [
        { id: "ok", phrase: "reading corner", provenance: "official", relevanceEvidence: [], status: "accepted" },
        { id: "reject", phrase: "cheap tricks", provenance: "official", relevanceEvidence: [], status: "rejected", rejectionCode: "low_relevance" },
      ], selectedKeywordIds: ["ok", "reject", "ok", "ok", "ok", "ok"], degradedMode: "none",
    };
    let prompt = ""; setProvider({ async generate(p: string) { prompt = p; return validOutput({ title: "Reading Corner", description: "Reading corner inspiration." }); } });
    const response = await generate(generateReq(session.id, "angle", { angleId: "gift", angleRequest: "Focus on gifting" })); eq(response.status, 200, "status");
    assert(prompt.includes("Focus on gifting"), "angle passed"); assert(prompt.includes("reading corner"), "accepted selected passed"); assert(!prompt.includes("cheap tricks"), "rejected excluded");
    const json = await response.json(); assert(!json.result.usedKeywordIds.includes("reject"), "rejected never used");
  });

  await test("used keyword matching uses Unicode token sequences, not substrings", async () => {
    const store = reset(); const session = await seed(store);
    session.keyword_evidence = { keywordSetId: "ks", candidates: [
      { id: "art", phrase: "art", provenance: "official", relevanceEvidence: [], status: "accepted" },
      { id: "smart", phrase: "smart cart", provenance: "official", relevanceEvidence: [], status: "accepted" },
    ], selectedKeywordIds: ["art", "smart"], degradedMode: "none" };
    setProvider({ async generate() { return validOutput({ title: "Smart Cart Organizer", description: "Organize every shelf." }); } });
    const json = await (await generate(generateReq(session.id, "unicode-match"))).json();
    assert(!json.result.usedKeywordIds.includes("art"), "art does not match inside smart/cart"); assert(json.result.usedKeywordIds.includes("smart"), "full token phrase matches");
  });

  await test("invalid locale/country are rejected and lowercase country is canonicalized", async () => {
    reset(); let loads = 0; let observedRegion = ""; __setTrendKeywordLoaderForTests(async input => { loads++; observedRegion = input.region ?? ""; return []; });
    eq((await analyze(analyzeReq("bad-country", { country: "US),status.eq.anything" }))).status, 400, "country rejected");
    eq((await analyze(analyzeReq("bad-locale", { locale: "not_a_locale_%%%" }))).status, 400, "locale rejected"); eq(loads, 0, "no query attempted");
    eq((await analyze(analyzeReq("lower-country", { country: "us" }))).status, 200, "lowercase country accepted");
    eq(observedRegion, "US", "country canonicalized before keyword lookup");
  });

  await test("degraded prompt does not include demand wording", async () => {
    const req = { generationId: randomUUID(), sessionId: randomUUID(), draftId: "d", factCard: { version: "fact-card-v1" as const, sessionId: "s", draftId: "d", locale: "en", facts: [] }, keywordEvidence: { keywordSetId: "k", candidates: [], selectedKeywordIds: [], degradedMode: "no_keyword_demand_data" as const } };
    assert(buildPromptForSession(req).includes("No reliable keyword demand data"), "degraded notice");
    const result = await orchestrateCopyGeneration(req); eq(result.degradedMode, "no_keyword_demand_data", "degraded output");
  });

  await test("generation prompt enforces the requested output language", () => {
    const req = { generationId: randomUUID(), sessionId: randomUUID(), draftId: "d", factCard: { version: "fact-card-v1" as const, sessionId: "s", draftId: "d", locale: "zh-CN", facts: [] }, keywordEvidence: { keywordSetId: "k", candidates: [], selectedKeywordIds: [], degradedMode: "no_keyword_demand_data" as const } };
    const prompt = buildPromptForSession(req);
    assert(prompt.includes("Target output language: zh-CN"), "target locale is explicit");
    assert(prompt.includes("Translate or naturally paraphrase"), "source-language context may not leak into localized copy");
  });

  await test("production store filters owner+completed+expiry and uses atomic finalize RPC", async () => {
    const ops: Array<[string, ...unknown[]]> = [];
    const sessionRow = { id: randomUUID(), status: "completed" };
    const chain = {
      select(v: string) { ops.push(["select", v]); return this; }, eq(k: string, v: unknown) { ops.push(["eq", k, v]); return this; }, gt(k: string, v: unknown) { ops.push(["gt", k, v]); return this; },
      async maybeSingle() { return { data: sessionRow, error: null }; },
    };
    productionDb = { from(table: string) { ops.push(["from", table]); return chain; }, async rpc(name: string, args: unknown) { ops.push(["rpc", name, args]); return { data: [{ id: "g", status: "completed", output: {} }], error: null }; } };
    sessionModule.__setSessionStoreForTests(null); const prod = sessionModule.getSessionStore();
    await prod.getValidSession(sessionRow.id, "owner", new Date().toISOString());
    assert(ops.some(o => o[0] === "eq" && o[1] === "vibepin_user_id" && o[2] === "owner"), "owner filter");
    assert(ops.some(o => o[0] === "eq" && o[1] === "status" && o[2] === "completed"), "status filter"); assert(ops.some(o => o[0] === "gt" && o[1] === "expires_at"), "expiry filter");
    await prod.completeGeneration({ generationId: randomUUID(), sessionId: randomUUID(), userId: "owner", claimToken: randomUUID(), output: {} as never, validationReport: { valid: true, issues: [] } });
    assert(ops.some(o => o[0] === "rpc" && o[1] === "complete_ai_copy_v2_generation"), "real atomic RPC");
    const rpc = ops.find(o => o[0] === "rpc"); assert(Boolean((rpc?.[2] as { p_claim_token?: string })?.p_claim_token), "RPC receives claim token");
  });

  await test("production store steals only expired leases and token-binds finalization/release", async () => {
    const ops: Array<[string, ...unknown[]]> = []; let mode = "";
    const stolen = { id: randomUUID(), status: "pending", claim_token: randomUUID(), claim_expires_at: new Date(Date.now() + 60_000).toISOString() };
    const chain = {
      insert(v: unknown) { mode = "insert"; ops.push(["insert", v]); return this; },
      update(v: unknown) { mode = "update"; ops.push(["update", v]); return this; },
      delete() { mode = "delete"; ops.push(["delete"]); return this; },
      select(v: string) { ops.push(["select", v]); return this; },
      eq(k: string, v: unknown) { ops.push(["eq", k, v]); return this; },
      lt(k: string, v: unknown) { ops.push(["lt", k, v]); return this; },
      async single() { return mode === "insert" ? { data: null, error: { code: "23505" } } : { data: stolen, error: null }; },
      async maybeSingle() { return { data: mode === "update" ? stolen : null, error: null }; },
      then(resolveThen: (v: unknown) => void) { resolveThen({ error: null }); },
    };
    productionDb = { from(table: string) { ops.push(["from", table]); return chain; } };
    sessionModule.__setSessionStoreForTests(null); const prod = sessionModule.getSessionStore();
    const claim = await prod.claimSession({ userId: "owner", workspaceId: "owner", draftId: "d", analyzeIdempotencyKey: "lease", modelVersion: "m", promptVersion: "p" });
    eq(claim.state, "claimed", "expired lease stolen"); assert(ops.some(o => o[0] === "lt" && o[1] === "claim_expires_at"), "steal is conditional on expired lease");
    const stealUpdate = ops.find(o => o[0] === "update")?.[1] as { expires_at?: string } | undefined;
    assert(Boolean(stealUpdate?.expires_at), "session TTL refreshes when an expired lease is stolen");
    await prod.completeSession({ sessionId: stolen.id, userId: "owner", claimToken: stolen.claim_token, factCard: {} as never, keywordEvidence: {} as never });
    await prod.releaseSessionClaim(stolen.id, "owner", stolen.claim_token);
    const tokenFilters = ops.filter(o => o[0] === "eq" && o[1] === "claim_token" && o[2] === stolen.claim_token);
    assert(tokenFilters.length >= 2, "both finalize and release are token-bound");
  });

  await test("migration supports pending nullable outputs, owner uniqueness, RLS, and atomic RPC", () => {
    const sql = readFileSync(resolve(process.cwd(), "../backend/db/migrate_v70_ai_copy_v2_sessions.sql"), "utf8");
    assert(sql.includes("status in ('pending', 'completed'"), "pending/completed"); assert(!/output\s+jsonb\s+not null/i.test(sql), "pending output nullable");
    assert(sql.includes("unique (session_id, vibepin_user_id, idempotency_key)"), "owner ledger uniqueness"); assert((sql.match(/enable row level security/g) ?? []).length === 2, "RLS both tables");
    assert(sql.includes("complete_ai_copy_v2_generation") && sql.includes("generation_count = generation_count + 1"), "atomic finalize function");
  });

  await test("additive v71 migration upgrades old v70 claims with leases and owner tokens", () => {
    const sql = readFileSync(resolve(process.cwd(), "../backend/db/migrate_v71_ai_copy_v2_claim_leases.sql"), "utf8");
    assert(/alter table\s+ai_copy_v2_sessions[\s\S]*add column if not exists claim_token/i.test(sql), "session token additive alter");
    assert(/alter table\s+ai_copy_v2_generations[\s\S]*add column if not exists claim_expires_at/i.test(sql), "generation lease additive alter");
    assert(sql.includes("p_claim_token"), "RPC is token-bound"); assert(sql.includes("enable row level security"), "RLS preserved");
    assert(/alter table\s+ai_copy_v2_sessions\s+alter column status set default 'pending'/i.test(sql), "old status default upgraded");
  });

  sessionModule.__setSessionStoreForTests(null); __setTrendKeywordLoaderForTests(null); __setCopyProviderForTests(null);
  console.log(`\n${passed} passed, ${failed} failed`); if (failed) process.exit(1);
}

main().catch(error => { console.error(error); process.exit(1); });
