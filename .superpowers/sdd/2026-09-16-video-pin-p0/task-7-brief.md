# Task 7 Brief — Bind Video Publishing To v76

## Frozen Scope

- Base: `d7635c02b2bb010380c39d5c7777fbdadbcab8da` on `codex/video-pin-p0-task7`.
- Implement one server-side Pinterest video publish orchestrator shared by immediate and due execution.
- The orchestrator owns this exact order: owner/source validation, v76 confirm/prepare, destination materialization lease, item settlement, ready claim, durable provider-attempt start, Task 6 adapter dispatch, provider-attempt settlement.
- Pinterest registration is inside the adapter call and therefore cannot occur before a ready destination claim and durable attempt.
- Video delivery mode is `provider_bytes` from `generated-private`; no public copy or signed URL is returned or persisted.
- A pre-existing `started` provider attempt is recovered as `delivery_unknown` and is never dispatched again. A successful 201 result is settled as success; if persistence fails after adapter success, callers receive an explicit do-not-retry/reconcile result.
- Provider `unknown` settles v76 `unknown`; it is not retryable. Definite validation/rejection settles `failed`; sibling destination state is never rewritten.
- Immediate and scheduled callers provide the same frozen media/destination/source identity. Scheduled callers are rejected before prepare/claim when the schedule is in the future or the run cannot safely start another destination.
- Existing image publishing remains on its current path. The old image-only route returns `materialization_required` for video requests that cannot enter this orchestrator.
- The legacy Python publisher, if present, must reject video explicitly. No Python Pinterest publishing entry point exists under `backend/` on this base, so the guarded legacy boundary is the existing image-only `publishPinForUser` path.

## Contract Decisions

- Confirmation fingerprints include media kind and video identity fields; the server validator normalizes image and video separately and verifies the exact submitted media snapshot.
- The v76 receipt stored in Postgres remains bounded and secret-free: stable media id/kind/ordinal only. Private object location and verified facts come from owner-scoped v77 provenance/materialization, not caller-controlled locator fields.
- Source bytes are resolved through an injected materializer. Production uses owner-scoped draft plus `media_asset_provenance` and private Storage download; tests mock only this external DB/Storage boundary.
- The orchestrator speaks only existing v76 service-role RPCs: `publish_intent_confirm_prepare`, `publish_asset_lease_materialization`, `publish_asset_settle_item`, `publish_asset_claim_ready`, `publish_provider_attempt_start`, and `publish_provider_attempt_settle`.
- Due execution may derive a deterministic immediate-form v76 receipt only after the row-level due/CAS claim has won. Its identity is frozen from the scheduled row revision, schedule instant, exact media, and destinations; merely scheduling never calls Pinterest.
- Retry/replay first reads durable v76 state. `published` replays success, `delivery_unknown` blocks, and `started` is converted to unknown before any provider call.

## TDD Matrix

- Receipt: video normalization/fingerprint, source revision conflict, owner tampering, legacy image regression.
- Orchestrator: lease competition, all-items-ready gate, provider-attempt idempotency, ready-claim-before-register, adapter success, adapter definite failure, adapter unknown, settlement failure after create, process-loss recovery, unknown anti-retry, sibling isolation.
- Routes/due: immediate video uses shared orchestrator; due video uses the same function; future/out-of-window rows never prepare/claim/call provider; partial destinations persist independently; legacy video bypass returns `materialization_required`.
- Database: retain and rerun v76/v77 PGlite lease, item readiness, attempt, unknown and owner/revision assertions; add Task 7 assertions only where an RPC invariant is missing.
- No test may call real Pinterest, Storage, or a remote database.

## Baseline Evidence

- `test-publish-confirmation.ts`: 16 passed.
- `test-publish-durable-intent.ts`: 23 passed.
- `test-publish-due-claim.ts`: 105 passed.
- `test-pinterest-video-adapter.ts`: 16 passed.
- v76 PGlite: 280/280 assertions passed.
- v77 PGlite: 94 assertions passed.
- Dependencies are reused through junctions; no package installation or deletion is allowed.

## Explicit Non-Goals

- No upload/finalize API implementation, UI, renderer, AI Copy change, migration deployment, push, merge, production database/Storage access, token refresh, or real Pinterest request.
- No second publish ledger and no direct client writes to v76/v77 tables.
