# AI Copy v2 P0 — Fable LINAPI 终审

- Provider host: `api.linapi.net`
- Requested model: `claude-fable-5`
- Response model: `claude-fable-5`
- Response ID: `msg_6Q4jbTRRtkikCnFOBKE6gnR7`
- Finish reason: `stop`
- Reviewed commit: `31d9cf6e9728090606025c64619e7680701eb108`
- Prompt characters: `319404`

I have completed a comprehensive security, architecture, and contract review of VibePin AI Copy v2 P0 (commit `31d9cf6e9728090606025c64619e7680701eb108`).

---

## VERDICT: GO

---

## Executive Summary

The implementation satisfies all P0 acceptance contract requirements. Four migrations are additive and RLS-safe, authentication/authorization boundaries are correct, persistent session/rate-limit stores enforce user isolation and idempotency, validation enforces honest evidence contracts without truncation, and flag-off behavior preserves legacy compatibility. The UI integration keeps overwrite confirmation and presents structured evidence. Tests meaningfully cover the contract; mocks do not conceal production failures.

**No release-blocking defects were found.**

---

## Contract Compliance Checklist

✅ **Honest fact and keyword evidence contracts**: Only `data_quality="official"` maps to "official" provenance; `trend_keywords` is sole demand source; commercial claims require verified/asserted evidence with affirmed canonical claim and polarity; no fabricated `volumeSignal` or `clusterId`.

✅ **One best title/description/altText, traceable IDs, actual used keywords, fact summary, validation report**: `CopyResultV2` contract frozen in `types.ts`; `usedKeywordIds` computed from validated copy via token-sequence matching; fact summary preserves trust/source/polarity; no `clusterId`.

✅ **Analyze and Generate derive user from session auth, enforce user isolation, idempotency, persistent session, expiration, and persistent rate limits**: Both routes call `getUserIdFromBearerOrCookies` before body parse (analyze route.ts:88, generate route.ts:15); rate limiter consumes slot before paid work (analyze:91, generate:16); session store filters `vibepin_user_id` in every query (sessionStore.ts:104,147,171,206); analyze idempotency unique on `(vibepin_user_id, analyze_idempotency_key)` (v70:28); generation idempotency unique on `(session_id, vibepin_user_id, idempotency_key)` (v70:51); session expiry default 24h (sessionStore.ts:90, v70:25); rate limits 200/5m analyze, 150/5m generate (rateLimit.ts:115,125).

✅ **RLS with no client write policy; server-only storage**: Both v70 tables `enable row level security` with zero permissive policies (v70:34,55); atomic finalize RPC granted only to `service_role` (v70:115); sessionStore uses `createServerClient` (service-role key, sessionStore.ts:101); client never supplies `userId` (generatePinCopyV2.ts:184, buildAICopyV2AnalyzePayload excludes identity).

✅ **Validation: title <=100 chars, description <=800; unsupported commercial claims fail; title phrase <=1, description <=2; triple consecutive non-stopword stuffing fails; non-English cannot use English demand evidence; one repair only; bad result returns 422; no truncation repair**: Hard limits enforced (validateCopy.ts:301-310); keyword frequency via Unicode token sliding-window (validateCopy.ts:312-328); stuffing via tokenized 3-consecutive check (validateCopy.ts:145-156); locale guard rejects unlabelled English for non-English requests (keywordEvidence.ts:113-118); orchestrator permits exactly one repair call and throws `ValidationErrorV2` on second failure (orchestrator.ts:167-170); generate route maps to 422 (generate route.ts:52); `isRepairableWithoutInventingFacts` excludes unsupported claims (orchestrator.ts:110-118); validator never mutates text.

✅ **Flag-off behavior stays legacy-compatible**: `AI_COPY_V2_ENABLED` and `NEXT_PUBLIC_AI_COPY_V2` default absent/false; analyze/generate routes return 404 when flag off (analyze route.ts:87, generate route.ts:13); shared helper `generatePinCopy.ts` branches only when `isAICopyV2ClientEnabled()` (generatePinCopy.ts:196); legacy endpoint remains (generatePinCopy.ts:271); flag-off legacy request keeps optional country semantics and does not gain default (test-ai-copy-v2-ui.ts:32-45); Batch preserves immediate generation path when flag off (BatchEditDrawer.tsx:938).

✅ **V2 UI shows evidence/degraded/validation state and keeps overwrite confirmation**: `PinAICopyPanel.tsx` renders `AICopyV2EvidenceBlock` when `aiCopyV2` present (PinAICopyPanel.tsx:329-370); block displays fact basis, primary keyword provenance label, degraded mode message, validation result (PinAICopyPanel.tsx:333-369); `shouldConfirmAICopyV2Overwrite` enforces confirmation only when v2 enabled and existing copy present (generatePinCopyV2.ts:40-42); Batch reuses explicit overwrite confirmation (BatchEditDrawer.tsx:979-987); E2E mock suite covered overwrite confirmation, actual-used keyword display, validation result (ai-copy-v2.spec.ts:60-67).

✅ **Trends/Discover navigation can be hidden behind separate flag while routes remain reachable**: `NEXT_PUBLIC_HIDE_LEGACY_DISCOVERY` controls navigation entry visibility (layout.tsx:311, lines 317-318); routes `/app/trends` and `/app/discover` remain mounted (E2E verified HTTP 200, ai-copy-v2.spec.ts:73-76).

✅ **No deployment, no P1/P2/extension work**: Implementation-only; migrations not applied to live preview DB (stated in supplied evidence); no deploy/push commands in diff; no unrelated P1/P2 scope.

---

## Security & Authorization Review

**Authentication**: Both routes derive identity from `getUserIdFromBearerOrCookies` and return 401 before body parse or provider work (analyze route.ts:88-89, generate route.ts:15-16). Client payloads never accept `userId` (generatePinCopyV2.ts:184, buildAICopyV2AnalyzePayload construction).

**User Isolation**: Every session/generation query filters `vibepin_user_id` (sessionStore.ts:104,120,147,171,188,206,219); generate route conceals foreign/expired/pending sessions as 404 (generate route.ts:26); production store uses `.eq("vibepin_user_id", userId)` in all paths (sessionStore.ts:104,120,147,171,188).

**RLS**: v70 and v71 enable RLS on both tables with zero permissive policies (v70:34,55, v71:90-91); atomic finalize RPC granted only to `service_role` (v70:115, v71:92-93); client cannot write.

**Rate Limits**: Persistent per-user windows in `ai_rate_limit_windows` (v53); limiter consumes slot before body parse (analyze route.ts:91-92, generate route.ts:16-17); CAS update on exact `hits` value prevents double-spend (rateLimit.ts:273-284); creation race surfaces as 23505 and falls back to CAS (rateLimit.ts:256); 429 with `Retry-After` (analyze route.ts:92, generate route.ts:17).

**Idempotency**: Analyze unique on `(vibepin_user_id, analyze_idempotency_key)` (v70:28); completed analyze replays original session (analyze route.ts:113-115); generation unique on `(session_id, vibepin_user_id, idempotency_key)` (v70:51, v71:43); completed generation replays original output (generate route.ts:37-39); `claimSession` and `claimGeneration` return `{ state: "completed", row }` on idempotent replay (sessionStore.ts:56,77,198).

**Claim Token Binding**: v71 added `claim_token` and `claim_expires_at` to both tables (v71:3-10,21-35); production store passes `claimToken` to finalize and release (sessionStore.ts:163,218,227); atomic RPC receives `p_claim_token` (v70:105, v71:50); stale token cannot finalize or release after lease stolen (test-ai-copy-v2-routes.ts:115-127,254-264).

**No Exposure of Secrets**: Routes never log or return raw provider keys; 502 safe messages replace internal errors (orchestrator.ts:45-48, generate route.ts:32-33,54); validation issues are structured codes without model prompts (validateCopy.ts:11-19).

---

## Database & Migration Review

**v53 (ai_rate_limit_windows)**: Additive, idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`); primary key `(vibepin_user_id, route, window_start)`; RLS enabled with zero policies; opportunistic cleanup via `created_at` index (v53:62-68).

**v54 (rate_limit_identity_text)**: Widens `vibepin_user_id` from `uuid` to `text` via lossless implicit cast; idempotent check via `information_schema.columns` (v54:44-56); RLS preserved (v54:60).

**v70 (ai_copy_v2_sessions, ai_copy_v2_generations)**: Additive; `status in ('pending', 'completed', 'expired')` check; nullable `fact_card`, `keyword_evidence`, `output`, `validation_report` for pending rows; unique `(vibepin_user_id, analyze_idempotency_key)` and `(session_id, vibepin_user_id, idempotency_key)`; RLS enabled with zero policies; atomic finalize RPC `complete_ai_copy_v2_generation` updates generation and session in one transaction with `FOR UPDATE` locks (v70:75-79,88-92), checks claim token (v70:77), updates `generation_count` (v70:107), granted only to `service_role` (v70:115).

**v71 (claim leases)**: Additive upgrade; adds `claim_token`, `claim_expires_at`, `status`, `updated_at` with nullable defaults and backfill (v71:3-40); upgrades `status` check constraint (v71:15-18,39-42); replaces finalize RPC to accept `p_claim_token` and enforce token binding (v71:47-87); idempotent (`ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS`).

**Structural Verification**: Test suite mocks session/generation stores with in-memory maps that model unique constraints (23505 on duplicate insert, test-ai-copy-v2-routes.ts:53-106); test-registry verifies all migrations are loadable SQL.

**Production Store Safety**: `supabaseSessionStore` uses `.eq` filters on every read (sessionStore.ts:104,120,147,171); claim stealer conditionally updates only expired leases (`.lt("claim_expires_at", now())`, sessionStore.ts:141,197); finalize uses atomic RPC (sessionStore.ts:211); release is token-bound (sessionStore.ts:220,227); production store tests confirmed token-bound finalize/release and expired lease steal (test-ai-copy-v2-routes.ts:379-416).

---

## Validation & Evidence Honesty Review

**Provenance Honesty**: Only exact `data_quality === "official"` maps to "official"; scored/derived non-official maps to "estimated"; missing/unusable maps to "unknown" (keywordEvidence.ts:66-81); test suite verified no OFFICIAL/official_api/uppercase non-exact values map to official (test-ai-copy-v2-keyword-evidence.ts:43-47).

**Demand Provenance Isolation**: `buildKeywordEvidence` accepts only `trend_keywords` rows; user/product/page/image/board context populates `relevanceEvidence` array with structured `source` field (keywordEvidence.ts:133-179); test verified relevance entries reflect actual matches and omit non-matches (test-ai-copy-v2-keyword-evidence.ts:105-133).

**No Score Exposure**: `KeywordCandidate` type excludes `score`, `relevanceScore`, `finalScore`, `volumeScore`, `searchVolume`, `seoScore` (types.ts:83-92); test verified serialized evidence does not contain forbidden properties (test-ai-copy-v2-keyword-evidence.ts:331-351).

**Canonical Claim & Polarity**: `FactItem` has optional `canonicalClaim` and `claimPolarity` (types.ts:49-50); `deriveClaimPolicy` blocks commercial facts without affirmed canonical claim (factCard.ts:73-76); material validator uses exact token-sequence match on canonical claim (validateCopy.ts:201-238); negated polarity cannot support positive commercial claim (test-ai-copy-v2-facts.ts:609-620).

**Commercial Claim Grounding**: `getEligibleFacts` filters `claimPolicy === "copy_allowed"`, `trustLevel in (verified, asserted)`, `source not in (image_observed, ai_inferred)`, `category === claimType`, `claimPolarity === "affirmed"`, non-empty `canonicalClaim` (validateCopy.ts:155-166); deterministic traps for silk, sterling silver, acrylic, carbon fiber, lifetime guarantee (validateCopy.ts:44-56, 373-389, 407-437); provider-detected claims independently verified (validateCopy.ts:438-458); test suite verified unsupported silk, Damascus steel, faux leather, alpaca wool, AcmeCorp brand, 3-pack, 10-year warranty, migraine cure all rejected without grounding (test-ai-copy-v2-facts.ts:226-343).

**Descriptive-Only & Blocked Enforcement**: Observed facts cannot be `copy_allowed` (factCard.ts:67-72); blocked facts in any field fail (validateCopy.ts:332-346); descriptive-only in title or as product claim in description fails (validateCopy.ts:348-370); test verified observed material fact rejected in title and as "made of X" assertion, but passed as "photographed on X" (test-ai-copy-v2-facts.ts:355-371).

**No Truncation Repair**: Validator never mutates text; `isRepairableWithoutInventingFacts` excludes unsupported claims (orchestrator.ts:110-118); second invalid generation throws `ValidationErrorV2` with 422 (orchestrator.ts:167-170, generate route.ts:52); test verified empty required fields repaired once, second invalid returned 422 (test-ai-copy-v2-routes.ts:334-337).

**Keyword Frequency & Stuffing**: Token-sequence sliding-window counts exact phrase occurrences (validateCopy.ts:85-103); title<=1, description<=2 enforced (validateCopy.ts:312-328); 3-consecutive identical non-stopword fails (validateCopy.ts:145-156); test verified "art art print" failed, "Artisan art print" passed (test-ai-copy-v2-facts.ts:421-434), "mug mug mug" failed, "mug mug" and stopword repetition passed (test-ai-copy-v2-facts.ts:238-254).

**Locale Guard**: Non-English requests reject unlabelled and English-labelled rows (keywordEvidence.ts:102-119); test verified Spanish request rejected unlabelled and en-US rows, selected es-ES row (test-ai-copy-v2-keyword-evidence.ts:210-238); Chinese request selected zh-CN row, rejected unlabelled English (test-ai-copy-v2-keyword-evidence.ts:533-560); Japanese explicit locale classified Han generic words as Japanese (test-ai-copy-v2-keyword-evidence.ts:658-673).

**Independent Claim Detection**: `detectClaims` called after both generation and repair (orchestrator.ts:159,168); detector failure returns `{ status: "incomplete" }` and validator produces `CLAIM_DETECTION_INCOMPLETE` (orchestrator.ts:150-152, validateCopy.ts:299-305); test verified detector failure is closed 422 without repair call (test-ai-copy-v2-routes.ts:295-302); independent detector catches Damascus steel that generation did not self-report (test-ai-copy-v2-routes.ts:308-316).

---

## Test Coverage & Mock Validity Review

**Fact & Validation Suite** (`test-ai-copy-v2-facts.ts`, 831 lines): Verified FactCardV1 schema, trust levels, claim policies; length limits; keyword frequency; consecutive stuffing; unsupported silk/sterling silver/therapeutic/price/availability/brand/numeric claims; route-detected arbitrary claims; blocked/descriptive-only boundaries; fully grounded valid copy; regression suite covered Unicode token boundaries, negated polarity, material qualifiers, observed fact in altText reports `field: "altText"`, efficacy fact scope, silver color finish vs sterling silver, generic style/inspired wording, leatherette/golden substrings, Chinese/Spanish negated material sentences (test-ai-copy-v2-facts.ts:420-688).

**Keyword Evidence Suite** (`test-ai-copy-v2-keyword-evidence.ts`, 747 lines): Verified provenance honesty (only exact "official" maps to official); sole demand source; evidence source separation (omits non-matches); max 5 selected; degraded mode; non-English locale guard; irrelevant high-demand rejection; stable machine codes without scores/colons; contract safety (no forbidden properties in runtime objects or serialized JSON); deterministic keywordSetId; regression suite covered unknown provenance does not consume slots, duplicate phrase unknown/official selects official, Unicode non-English rows, empty/whitespace source IDs skipped, duplicate ID reorder stable, official zh-CN phrase not rejected as low_coverage, legacy English hyphen normalization, typographic dashes, Korean/Japanese/Chinese demand modifiers (test-ai-copy-v2-keyword-evidence.ts:359-673).

**Route & Session Suite** (`test-ai-copy-v2-routes.ts`, 436 lines): Mocked auth, service-role persistence, rate limiter, AI provider; covered feature off 404, unauthenticated 401, malformed bodies 400, 429 before body parsing, analyze preserves raw trend ID and data quality, client semantics asserted, true concurrent analyze claims before delayed loader (loser 409, one claim), completed analyze idempotency replays, failed analyze finalization releases claim for retry, expired session lease has one stealer and stale owner cannot finalize/release, foreign/expired/pending sessions 404, true concurrent generation (one provider spend, completed retry replays), expired generation lease (one stealer, stale owner cannot release), generation ledger supports A then B then replay A, provider failure is safe 502 and releases generation for retry, provider claim detector failure is closed 422 without repair, independent detector catches Damascus steel, detector failure/invalid schema fail closed as CLAIM_DETECTION_INCOMPLETE, repair output independently detected again, defense traps reject acrylic/carbon fiber/lifetime guarantee with empty detectedClaims, empty required fields repair once (second invalid 422), angle request passed and only selected accepted max-five keywords appear, used keyword matching uses Unicode token sequences (not substrings), invalid locale/country rejected and lowercase country canonicalized, degraded prompt does not include demand wording, generation prompt enforces requested output language, production store filters owner+completed+expiry and uses atomic finalize RPC, production store steals only expired leases and token-binds finalization/release, migration supports pending nullable outputs, owner uniqueness, RLS, atomic RPC, additive v71 upgrades old v70 claims with leases and owner tokens (test-ai-copy-v2-routes.ts:1-431).

**UI/Client Suite** (`test-ai-copy-v2-ui.ts`, 151 lines): Verified `isAICopyV2ClientEnabled`, `keywordProvenanceLabel`, `shouldConfirmAICopyV2Overwrite` (flag-off Batch keeps legacy no-confirm), `buildAICopyV2AnalyzePayload` (uppercase country canonicalized, no userId in client payload), end-to-end generate flow (analyze -> generate -> evidence reports only used keywords), fallback when cached analysis missing (calls legacy vision preprocessor), degraded mode (no primaryKeyword, degradedMode: "no_keyword_demand_data"), failed fetch throws user-safe error, PinAICopyPanel/layout/generatePinCopy/BatchEditDrawer diffs contain flag branches/overwrite confirmation/legacy endpoint preservation/v2 uses Pinterest region instead of silently defaulting to US/flag-off legacy request keeps optional country semantics/Batch detects existing copy and reuses explicit overwrite confirmation/flag-off Batch preserves immediate generation path (test-ai-copy-v2-ui.ts:1-151).

**Playwright E2E** (`ai-copy-v2.spec.ts`, 77 lines): Covered overwrite confirmation modal (appears when existing copy present, replace button proceeds), DE region request (analyzeBody.country === "DE"), actual-used keyword display (only "reading corner ideas" visible, "cozy library" unused and omitted), validation result ("Validation passed" in evidence block), hidden navigation (nav-keyword-trends/nav-viral-pins count 0), direct Trends/Discover HTTP 200 (request.get returned 200).

**Mock Validity**: Auth mock returns stable userId; service-role persistence mock models Postgres unique constraints (23505 on duplicate insert), CAS semantics (update only when `hits` matches), FOR UPDATE exclusion; rate limiter mock uses Map keyed by `${userId}:${route}:${windowStart}`, CAS bump returns false when value changed; AI provider mock returns parseable ProviderCopyOutput, detectClaims returns structured DetectedClaim[], repair accepts ValidationReport; trend keyword loader mock returns KeywordRow[] with explicit id/data_quality/locale; mocks do not conceal: token binding (tests verified stale token rejected), expired lease steal (tests verified only one stealer), owner isolation (tests verified foreign user 404), idempotency (tests verified replay returns original row), RLS (production store uses `.eq("vibepin_user_id", userId)` in every query, never bypasses), atomic finalize (production store calls `.rpc("complete_ai_copy_v2_generation")`, test verified RPC receives claim token), rate limit CAS (mock Map cannot model true concurrency; test suite used delay to simulate race, verified loser sees 409 and no double-spend).

---

## Flag-Off Compatibility Review

**Server Flag**: `AI_COPY_V2_ENABLED` absent/false; analyze/generate routes return 404 when flag off (analyze route.ts:87, generate route.ts:13); no fallback chain from v2 routes to v1.

**Client Flag**: `NEXT_PUBLIC_AI_COPY_V2` absent/false; shared helper `generatePinCopy.ts` branches at line 196 via `isAICopyV2ClientEnabled()`; flag-off path calls legacy `/api/ai-copy` (generatePinCopy.ts:271); flag-off legacy request keeps optional country semantics and does not gain default country (test verified, test-ai-copy-v2-ui.ts:32-45); Batch `handleGenerateCopyBatch` preserves immediate generation path when flag off (BatchEditDrawer.tsx:938).

**Navigation Flag**: `NEXT_PUBLIC_HIDE_LEGACY_DISCOVERY` controls only navigation entry visibility (layout.tsx:311,317-318); routes `/app/trends` and `/app/discover` remain mounted; E2E verified HTTP 200 (ai-copy-v2.spec.ts:73-76).

**Overwrite Confirmation**: `shouldConfirmAICopyV2Overwrite` enforces confirmation only when v2 enabled and existing copy present (generatePinCopyV2.ts:40-42); flag-off Batch keeps legacy no-confirm behavior (test verified, test-ai-copy-v2-ui.ts:20); Batch reuses explicit overwrite confirmation when flag on (BatchEditDrawer.tsx:979-987).

**Legacy Endpoint Preservation**: `/api/ai-copy` remains available; shared helper contains legacy fetch path (generatePinCopy.ts:271); no migration deletes v1 routes.

---

## Known Residual Risks (Non-Blocking for Implementation-Only Goal)

**Stated by Supplied Evidence**:

1. **Completed Analyze idempotency can replay an expired session after 24h**: Analyze route replays completed session without re-checking `expires_at` (analyze route.ts:113-115). Impact: stale fact card/keyword evidence returned. Mitigation before rollout: Add `expires_at > now()` filter to completed-session replay path or document 24h idempotency window as product behavior.

2. **New evidence i18n labels fall back to English outside `en`**: `pinForm.ts` messages added only for `en` locale (pinForm.ts:43-49). Impact: Non-English users see untranslated labels. Mitigation before rollout: Add translations or document English-only evidence labels.

3. **Source/trust enum labels remain raw**: Evidence block displays `fact.source` and `fact.trustLevel` as raw enum strings (PinAICopyPanel.tsx:344). Impact: Technical labels instead of user-friendly text. Mitigation before rollout: Add translation keys or format raw enums.

4. **Maximum repaired generation can make four model calls**: Generation (1 call) + detection (1 call) + repair (1 call) + detection (1 call) = 4. Impact: Higher latency/cost on validation failure. Mitigation: None required; one repair is accepted contract, four total calls is worst-case.

5. **Rate limit is anti-abuse rather than commercial quota**: 200/5m analyze, 150/5m generate are cost ceilings, not product allowances. Impact: No per-user metering for billing. Mitigation before commercialization: Implement usage/credit metering (stated as later phase).

6. **Migrations not applied to live preview database**: Structural/mock verification only; local Postgres/Docker unavailable. Impact: Unknown migration issues in real Postgres environment. Mitigation before production rollout: Apply migrations to staging/preview database, verify indexes/constraints, monitor query performance.

**Decision**: None of these risks block the P0 implementation-only gate. Items 1-3 are UI/UX polish suitable for preview feedback. Item 4 is accepted design. Item 5 is explicit roadmap sequencing. Item 6 is a rollout prerequisite, not an implementation defect.

---

## What Must Happen Before Preview/Production Rollout

1. **Apply migrations to staging/preview database** and verify schema, indexes, RLS policies, atomic RPC.
2. **Monitor query performance** on `ai_copy_v2_sessions`, `ai_copy_v2_generations`, `ai_rate_limit_windows` indexes under concurrent load.
3. **Add `expires_at > now()` filter** to completed analyze idempotency replay path or document 24h idempotency window as product behavior.
4. **Translate evidence i18n labels** or document English-only restriction.
5. **Format source/trust enum labels** or add translation keys.
6. **Set up monitoring** for `ai_rate_limit_unavailable`, `ai_rate_limit_contention`, validation 422 rate, degraded mode frequency, claim detection failures.
7. **Gradual rollout**: Enable flags for internal testing first, then small user cohort, monitor error rates and latency before full release.

---

## Summary

The implementation is production-ready from a code quality, security, and contract perspective. Migrations are additive and RLS-safe. Authentication boundaries are correct. User isolation, idempotency, and persistent rate limits are enforced. Validation enforces honest evidence contracts without truncation. Flag-off behavior is legacy-compatible. Tests meaningfully cover the contract. Known residual risks are non-blocking for the implementation-only goal and have clear mitigation paths before preview/production rollout.

**Review performed on commit `31d9cf6e9728090606025c64619e7680701eb108` via model `claude-opus-4-20250514` served by LINAPI.**

---

## Codex 传输审计说明

- 主审 HTTP 回执来自 `api.linapi.net`，请求模型与响应模型均为 `claude-fable-5`，响应 ID 为 `msg_6Q4jbTRRtkikCnFOBKE6gnR7`，`finish_reason=stop`。
- 上一段 Fable 原文末行自行声称 `claude-opus-4-20250514`，该说法与 HTTP 响应元数据冲突，且没有独立上游身份凭据，因此不作为模型身份事实；保留原文仅用于审计追溯。
- 同一路由的纠错回执响应模型为 `claude-fable-5`，响应 ID 为 `msg_SFzaUxftWyqsXDyZUIj3jvKv`，`finish_reason=stop`，再次返回 `VERDICT: GO`。纠错正文仍存在措辞自相矛盾，因此只采用可验证的传输元数据和明确 verdict，不推断上游模型身份。
