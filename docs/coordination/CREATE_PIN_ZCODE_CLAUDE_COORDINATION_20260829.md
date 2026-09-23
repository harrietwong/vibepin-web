# Create Pin · Zcode / Claude Coordination — 2026-08-29

## Objective

Turn Zcode research session `sess_4a48bb8f-9a9d-4fe5-a77a-7da4a9b77177` into implementation-ready work without overwriting the existing Create Pins integration or the current main-worktree UI edits.

## Verified Inputs

- Zcode substantive model: `GLM-5.3`, reasoning `max`. Flash is allowed only for mechanical status collection.
- Zcode research artifacts are under `daily-content-curator/` and were independently parsed on 2026-08-29:
  - 171 unique videos / 116 channels scanned.
  - 19 new videos / 19 creators deeply read.
  - 996 comments captured.
  - 21 evidence needs and 20 scored candidate features.
  - No metadata, transcript, or comment failures.
- Zcode reported no product-code edit, push, merge, or deploy.
- Claude Create Pins session: `68ba9b2f-f1db-46ae-8e53-d117d5f47eaf`.
- Claude integration branch: `integrate/create-pins-on-fanout-0827@80631ec9` (clean and pushed).
- Claude QA worktree: `D:\wt\publish-qa-0827@2524ecae` (detached and clean).
- Claude's remaining gates: real-platform T0-T5 publishing, carousel capability, scheduled publishing after deployment, browser/end-to-end QA.

## Collision Gate

The current main worktree is not a safe implementation target. It is on `feat/pinterest-production-transition@fec94a7f` and has extensive unrelated and Create Pin changes. The current authoritative intersection is 52 paths across the repository: 32 under `web/` and 20 cross-domain backend/tool paths. The earlier count of 53 used a prior working-tree snapshot; use the current 52/32 split for dispatch decisions.

High-risk Create Pin collisions include:

- `web/src/components/studio/BatchEditDrawer.tsx`
- `web/src/components/studio/ContentMediaStrip.tsx`
- `web/src/components/studio/PinBoardCard.tsx`
- `web/src/components/studio/PinCardMedia.tsx`
- `web/src/components/studio/PinFallbackArtwork.tsx`
- `web/src/components/studio/ProductPickerModal.tsx`
- `web/src/components/studio/StudioBoard.tsx`
- `web/src/components/studio/StudioBoardFilters.tsx`
- `web/src/components/studio/StudioPlanSidebar.tsx`
- `web/src/components/pins/PinAICopyPanel.tsx`
- `web/src/hooks/usePinBoardDrafts.ts`
- `web/src/lib/contentDraftModel.ts`
- `web/src/lib/createPinsPrefill.ts`
- `web/src/lib/pinDraftStore.ts`
- `web/src/lib/studio/pinLifecycle.ts`
- `web/src/lib/studio/publishErrorDisplay.ts`
- Studio i18n messages and relevant Create Pin test scripts.

No worker may edit those paths from the main worktree. Any implementation must use a new isolated worktree with an explicit base ref and file allowlist. Workers may commit locally but may not push, merge, deploy, publish, or touch production.

The authoritative per-file disposition is recorded in `docs/coordination/CREATE_PIN_BASELINE_DISPOSITION_20260829.md`. The key result is that most current Studio UI intent is already present in `80631ec9` with stronger media, destination, lifecycle, accessibility, and retry behavior. Do not mechanically three-way merge the current Studio files.

## What Can Start Now

1. Existing-feature gap audit against `80631ec9`, read-only. URL-to-Pin, product URL extraction, product selection, canonical readiness, multi-destination publishing, Plan sidebar, batch editing, failure display, and media fallback already exist in some form; do not rebuild them from the research report.
2. A baseline P0 fix specification and orchestration test for AI generation. `StudioBoard.handleAiGenerate` currently calls the state-changing `enqueueGeneration()` as a mode probe, then executes/enqueues again. Inline mode can generate twice; worker mode can create a duplicate/orphan job or hit the active-generation lock. Existing helper tests do not exercise this orchestration layer.
3. Pure domain-contract packages, from an isolated worktree based on `80631ec9`, using new files only and without UI/store/API wiring:
   - Multi-direction batch planning that reuses existing creative-direction and output-variant types.
   - Versioned Brand Kit primitives and validation.
   - Versioned text-layer document and proofing-issue contracts.
4. A baseline-reconciliation work package: compare the current uncommitted Studio UI feedback implementation with `80631ec9`, preserve both sides, and produce a file-by-file integration decision before feature coding.

## Architecture Findings

### Multi-direction generation

- The current product supports one selected direction with multiple composition variants. It does not yet support one request spanning several distinct creative directions.
- `digitalCreativeModel.ts` defines three digital-product directions, but neither the current worktree nor `80631ec9` imports `deriveDigitalCreativeIntent()`. Treat this as an unconnected model, not a shipped feature.
- Do not introduce a second creative-direction type system. A future batch planner must reuse `CreativeDirectionRecommendation`, `DigitalDirectionDescriptor`, and `OutputVariant`.
- The safe first slice is a pure `directionBatchPlan` contract plus tests. UI, persistence, API, and worker/inline orchestration must wait for the baseline P0 fix.

### Brand Kit

- `brandProfileStore.ts` exists and is identical on both baselines, but it contains only website URL, brand voice, audience, product keywords, and personalization preferences. It has no product call sites beyond store/adapter tests.
- It is not the research-requested Logo/color/font/margin Brand Kit. A single-kit design may extend the singleton profile compatibly; multiple brands/workspaces require a separate collection and identity model.
- Logo ownership/storage, custom-font licensing, automatic application, and override precedence are unresolved product decisions.

### Editable text and proofing

- Current text-overlay behavior is only an AI prompt control and is effectively disabled. Provider output is a flat image URL; drafts/media have no versioned layer document, and card rendering is image-only.
- There is no explicit spell/grammar/proofing contract or dependency. Browser-native checking is not a reliable product implementation because app UI language and Pin content language can differ.
- A text-layer document should be owned by `mediaId`, use normalized coordinates, preserve z-order/style/safe-area metadata, and export to a public raster derivative before publish. A DOM-only overlay is not publishable.
- The safe first slice is pure contracts for layer documents and advisory proofing issues. Do not select a render engine or spell provider before product decisions and baseline reconciliation.

## Non-overlapping Work Packages

No implementation package has been dispatched yet. Package ownership becomes exclusive when dispatched: one worker, one isolated worktree, one explicit allowlist. Zcode uses `GLM-5.3` with reasoning `max` for product/architecture review; Claude workers implement only after the accepted baseline is named.

### WP-0 · Baseline reconciliation

- Owner profile: Advisor plus Claude Opus read-only review first; one implementation worker only after the file decision sheet is accepted.
- Base: `integrate/create-pins-on-fanout-0827@80631ec9` in a new isolated worktree.
- Inputs: the current main-worktree Create Pin diff and the 53-path collision inventory.
- Output: one file-by-file decision sheet marked `take 80631`, `port current UI intent`, `manual merge`, or `defer`.
- Prohibited: copying the main worktree wholesale, `git add -A`, overwriting untracked files, push, merge, deploy, or production actions.
- Acceptance: every colliding Create Pin path has an explicit disposition; the source worktrees remain unchanged; the new worktree is the only write target.

### WP-1 · Generation orchestration P0

- Owner profile: senior implementation worker after WP-0, reviewed by the Advisor.
- Allowlist: reconciled `web/src/components/studio/StudioBoard.tsx`; new `web/scripts/test-studio-generation-orchestration.ts`; `web/scripts/test-registry.ts` only to register the committed test.
- Required invariant: one user action causes exactly one inline execution or one worker enqueue, never a state-changing probe followed by a second call.
- Acceptance: inline, worker, enqueue failure, partial result, and retry paths are covered with counted call assertions; `test-ai-generation-run`, `test-generation-manifest`, the new orchestration test, Studio test suite, and typecheck pass.

### WP-2 · Direction batch contract

- Owner profile: Zcode `GLM-5.3/max` architecture review; bounded implementation can use a lower-cost worker only after the contract is accepted.
- Allowlist: new `web/src/lib/studio/directionBatchPlan.ts`; new `web/scripts/test-direction-batch-plan.ts`; `web/scripts/test-registry.ts` only to register the committed test.
- Dependencies: reuse `CreativeDirectionRecommendation`, `DigitalDirectionDescriptor`, and `OutputVariant`; do not add a competing direction model or default source.
- Acceptance: stable 1–3 direction groups, unique direction IDs/batch keys, explicit per-direction and total counts, no multiplicative count explosion, shared product manifest, single-direction backward compatibility, and no network/UI/store imports.

### WP-3 · Brand Kit domain contract

- Owner profile: product/data-model worker after the single-kit versus multi-kit decision.
- Allowlist: new `web/src/lib/studio/brandKitModel.ts`; new `web/scripts/test-brand-kit-model.ts`; `web/scripts/test-registry.ts` only to register the committed test.
- Dependencies: preserve compatibility with `brandProfileStore`; do not change its singleton storage until ownership/cardinality is decided.
- Acceptance: versioned and size-bounded logo/color/font/spacing primitives, deterministic normalize/validate/migrate behavior, no binary logo persistence, no UI/generation/store wiring, and no assumption that custom fonts are licensed.

### WP-4 · Text-layer and proofing contracts

- Owner profile: document/render-domain worker after per-media ownership and publish-export policy are decided.
- Allowlist: new `web/src/lib/studio/textLayerDocument.ts`; new `web/src/lib/studio/proofingIssue.ts`; new matching test scripts; `web/scripts/test-registry.ts` only to register committed tests.
- Dependencies: document ownership is by `mediaId`; coordinates are normalized; publication still requires a flattened public raster derivative.
- Acceptance: versioned migrations, stable z-order, safe-area and style metadata, document/field size limits, advisory proofing issue ranges/replacements/language, deterministic validation, and no DOM/canvas/provider dependency.

### Blocked UI and platform integration

- No owner until WP-0 and product decisions are complete.
- Blocked paths include `StudioBoard`, `PinBoardCard`, `PinCardMedia`, `BatchEditDrawer`, `AiVersionDrawer`, `pinDraftStore`, `contentDraftModel`, generation API/backend, `publishContent`, scheduling, and Studio i18n.
- Real-platform publishing, authentication workarounds, migrations, and production APIs remain outside the authorized scope.

## Independent Acceptance Commands

Run only inside the package's isolated worktree, never in the dirty main worktree:

```powershell
npm run check:test-registry
npx tsx scripts/test-studio-generation-orchestration.ts
npx tsx scripts/test-direction-batch-plan.ts
npx tsx scripts/test-brand-kit-model.ts
npx tsx scripts/test-text-layer-document.ts
npx tsx scripts/test-proofing-issue.ts
npm run test:studio
npm run typecheck
```

Only run commands for files that exist in that package. A green helper test does not prove the UI orchestration, browser workflow, or real-platform publishing gates.

## Feature Work That Must Wait For Baseline Reconciliation

- Any `StudioBoard`, card, Plan sidebar, Batch Edit, failure display, product picker, URL-import UI, pin draft store, publish, or scheduling change.
- Any real-platform publishing or authentication workaround.
- Any database migration or production-facing API change.

## Recommended Implementation Order

1. Freeze and inventory the current main-worktree Create Pin diff.
2. Reconcile that diff on top of `80631ec9` in an isolated integration worktree.
3. Remove the state-changing generation probe and add orchestration-level tests proving exactly one real execution/enqueue per user action.
4. Run focused Create Pin unit/source-contract tests, typecheck/build, then browser QA.
5. Start new feature branches from the accepted reconciled baseline.
6. Prefer the first bounded feature slices to be pure Brand Kit, text-layer/proofing, or direction-batch contracts. Do not wire them into Studio UI until the baseline is accepted.
7. Extend the existing canonical readiness and Pinterest server validators for publish preflight; do not add a second competing validation source.

## Product Decisions Still Needed Before Full Implementation

- Brand Kit: one kit per user versus multiple brands/workspaces; logo storage and ownership model.
- Variant generation: default number and whether scene/text/collage directions are fixed or selectable.
- Text editor: layer ownership per media versus cover only; normalized coordinates versus a fixed canvas; automatic flattening versus explicit export; first release limited to text/image/color/CTA replacement versus immediately supporting local AI repaint.
- Proofing: layers only versus title/description/alt text; supported languages; advisory versus publish-blocking; local versus server-side provider.
- Publish checks: current Pinterest field limits and AI-label policy require current official verification before blocking rules are shipped.

## Monitoring

Current-thread heartbeat: `monitor-create-pin-zcode-handoff`, every 20 minutes. It is read-only and reports only material progress, collisions, quota blockers, or verifiable delivery.

The Advisor handoff questions are persisted in the original Zcode session. The session configuration is `GLM-5.3` with default reasoning `max`, but the immediate turns did not run because the pure Node CLI entry could not access the desktop plan credential (`provider_not_configured: zai-start`). No lower-model downgrade was attempted and no duplicate implementation task was opened. The heartbeat must wait for or use the desktop-authenticated runtime, then read the next assistant response before changing this coordination state.

Claude was polled again after 19:20. The quota did not recover; the authoritative CLI response moved the next reset to 00:20 America/New_York. Its three known Create Pin worktrees remain clean. Do not retry repeatedly or start a new worker; perform one read-only poll after the new reset.

At 19:09, the ZCode desktop window was independently observed: the app is running, the original Create Pin research task is present in the Pinterest flow project, and the visible model controls show `GLM-5.3` with `Highest`. The Windows desktop was locked during observation, so computer-use stopped without clicking or typing. The existing handoff messages remain persisted in SQLite at sequences 115–116 with no assistant response after them. Do not resend them; resume the desktop-authenticated original session only after the user unlocks Windows.

The current-only URL Import delta has now been audited. It is not safe to port as a seven-file bundle: `/api/import/product-urls` is currently unauthenticated and rate-unbounded, and the existing hostname-only SSRF check does not revalidate DNS/connection IPs, IPv4-mapped or link-local IPv6, redirects, or streaming response size. An existing isolated security worktree `codex/fetch-og-ssrf-0829` contains an in-progress shared outbound guard; Create Pin must not implement a second guard or touch that worktree. URL Import security/auth/rate gates must be independently accepted before Etsy public-listing integration.

## Goal Completion Audit

| Requirement | Evidence | Status |
|---|---|---|
| Inventory Zcode research deliverables | Five artifacts parsed; 171 videos, 116 channels, 19 deep reads, 996 comments, 21 needs, 20 feature rows, zero collection failures | Complete |
| Use highest Zcode model for substantive handoff | Session configuration and desktop UI both show `GLM-5.3`; desktop shows `Highest`; Flash reserved for the completed historical research/status work | Complete |
| Deliver the handoff request into the original Zcode session | SQLite messages 115–116 contain the read-only Advisor request | Complete |
| Obtain the Zcode assistant's handoff response | Sequence 118 is a completed `GLM-5.3` / `builtin:zai-start-plan` assistant response; parts contain reasoning and text only, with no tool call | Complete |
| Verify Claude's completed Create Pin work | Session transcript, exact branch/HEAD, three clean worktrees, completed PRD/workflow inventory, and remaining T0–T5/browser gates were independently read | Complete |
| Reconcile Claude work with current dirty tree | Current authoritative intersection is 52 repository paths / 32 web paths; per-file decisions are in the baseline disposition sheet | Complete |
| Define non-overlapping implementation packages | WP-0 through WP-4 plus URL packages U1–U3 have exclusive owners, bases, allowlists, dependencies, and prohibited paths | Complete |
| Produce independently verifiable acceptance guidance | Package-specific invariants, commands, orchestration tests, security proofs, typecheck/Studio/browser boundaries are documented | Complete |
| Avoid overwriting or external/production actions | Main worktree was never used for product implementation; known Create Pin worktrees remain clean; no push, merge, deploy, publish, auth bypass, migration, or production write occurred | Complete |
| Continue monitoring until the final missing evidence arrives | The monitor detected sequence 118 and preserved all worktree guards; its reason for running is now complete | Complete |

At 21:55, the original Zcode session produced sequence 118: a completed `GLM-5.3` response to the read-only handoff request at sequence 117. It confirmed no tool use, no file modification, and no implementation. The three Create Pin/QA worktrees remained clean.

At 20:06, the reserved security worktree `codex/fetch-og-ssrf-0829` was clean at amended commit `44933a979bbf8162aadb5ea5506890e912e09432` (`fix(fetch-og): block SSRF and DNS rebinding`). It changes `fetch-og/route.ts`, adds `safeOutboundUrl.ts` plus its focused test, and now also modifies `web/scripts/test-product-url-import.ts`. This is a material upstream security delivery, but it is based on `fec94a7` and has not yet been independently accepted or extracted into a shared server-only module for URL Import. Because the amended commit now touches the shared URL Import test, that file is security-owner exclusive until review finishes; U1–U3 workers must not edit it concurrently. Create Pin remains prohibited from copying or reimplementing the guard.

## Final Advisor Reconciliation of Zcode Sequence 118

Zcode's research conclusions are accepted as product evidence, but its proposed implementation packages are not adopted verbatim because the response explicitly did not inspect `80631ec9`.

1. Zcode WP1, “new URL parser/image extraction backend,” is replaced by URL packages U1–U3. The repository already has a canonical URL Import chain; creating a new backend duplicates it. Authentication, per-user rate limiting, shared outbound-URL guarding, redirect revalidation, and streaming-size limits are gates before Etsy integration.
2. Zcode WP2, “new publish preflight rules engine,” must extend the existing canonical readiness, media rules, destination validation, and publish-error mapping. A second rules engine is prohibited.
3. Zcode WP3, Brand Kit table/CRUD, is narrowed to the pure versioned Brand Kit contract until the user decides single kit versus multiple brands/workspaces, logo ownership/storage, and font licensing. Database/CRUD and Settings UI are not immediate work.
4. Zcode WP4, text-layer separation spike, is accepted only as an isolated prototype or pure document/render contract. It may not touch Studio UI, draft persistence, generation, or publish paths until the baseline and export policy are accepted.
5. Zcode's ten product-decision items are retained. They align with the existing decision gates for text-overlay architecture, model/product fidelity and cost, URL-to-Pin scope, Etsy/Shopify integration mode, AI disclosure, variant directions, editor phasing, batch-source priority, and Brand Kit placement.

The final implementation order remains: reconcile on exact `80631ec9`; fix the `StudioBoard` double-execution P0 with orchestration tests; port only the two-selection Batch Edit visibility rule; independently accept and share the security guard; then start bounded pure contracts or URL packages under their exclusive allowlists. No product implementation begins from the dirty main worktree.

All five research artifacts were rehashed at completion, sequence 118 contained no tool-call part, and the three known Create Pin/QA worktrees were still clean. The handoff, research inventory, Claude/current-tree audit, collision disposition, non-overlapping work packages, and independent acceptance guidance are therefore complete.
