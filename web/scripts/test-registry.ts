/**
 * The single registry of web test scripts.
 *
 * Every `scripts/test-*.ts` must be listed here exactly once. `run-tests.ts` reads
 * this to decide what `npm test` runs, and `check-test-registry.ts` fails the build
 * when a script on disk is missing from it.
 *
 * Why a registry and not a glob: a glob silently absorbs whatever is on disk, so a
 * test can rot for months without anyone noticing. 48 of these scripts were never
 * wired into `npm test` at all — 40 of them passed, and the 8 that failed had been
 * failing unnoticed. An explicit list makes "this test does not run" a decision
 * somebody had to write down, with a reason, rather than an accident.
 *
 * Every GIT-TRACKED `scripts/test-*.ts` must appear in CORE, STUDIO, PLAN, or EXCLUDED
 * exactly once — check-test-registry.ts enforces this against `git ls-files` so a clean
 * checkout and the registry agree. A test that is only an untracked working-tree draft
 * is invisible to the gate; if it depends on feature source that is itself still
 * uncommitted, keep it that way and record it in DEFERRED (below) — do not commit the
 * test without its source, or a clean checkout breaks.
 *
 * To retire a test: move it to EXCLUDED with a reason. Never just delete the entry.
 */

/** Fast node-only unit/contract tests. `npm test` runs every one of these. */
export const CORE: string[] = [
  "test-i18n",
  "test-shared-pin-details",
  "test-freshness",
  "test-pin-metadata",
  "test-product-url-import",
  "test-generation-recovery-audit-language",
  "test-generation-manifest",
  "test-retry-scope",
  "test-regenerate-payload",
  "test-status-normalization",
  "test-asset-classification",
  "test-mvp-taxonomy",
  "test-model-label",
  "test-model-switch",
  "test-assistant-detectors",
  // Pinterest
  "test-pinterest-oauth",
  "test-pinterest-integrations-repair",
  "test-pinterest-connection-consistency",
  "test-pinterest-client-dedupe",
  "test-published-pin-summary",
  "test-social-provider-status",
  // AI copy / creative intelligence
  "test-ai-copy-keyword-context",
  "test-ai-copy-language-guardrail",
  "test-creative-direction-v2",
  "test-creative-controls",
  "test-creative-intelligence",
  "test-creative-intelligence-v1",
  "test-creative-recommendations",
  // Products / opportunity
  "test-product-ideas-picker",
  "test-pin-ideas-picker",
  "test-product-preview-amazon",
  "test-product-link-display",
  "test-product-opportunity-counts",
  "test-product-opportunity-admin",
  "test-product-top-tiers",
  "test-amazon-affiliate",
  "test-amazon-affiliate-wiring",
  // Settings / support
  "test-settings-p0",
  "test-support-ai-responder",
  "test-support-translator",
  "test-support-metrics",
  // Sync / storage
  "test-pin-draft-sync",
  "test-user-store-sync",
  "test-user-store-route",
  "test-user-store-adapters",
  "test-user-store-media-adapters",
  "test-media-offload",
  // Shopify
  "test-shopify-entitlements",
  "test-shopify-connection-store",
  "test-shopify-hmac",
  "test-shopify-oauth-state",
  "test-shopify-normalize",
  "test-shopify-sync-engine",
  "test-shopify-client",
  "test-shopify-ai-grounding",
  "test-shopify-linked-product-display",
];

/** Create Pins / Studio board + the Pin editing surfaces. */
export const STUDIO: string[] = [
  "test-studio-flow-regression",
  "test-studio-plan-match",
  "test-studio-generated-section",
  "test-asset-picker-ia",
  "test-create-pins-prefill",
  "test-batch-edit-planning",
  "test-batch-edit-back-close",
  "test-batch-edit-product-mapping",
  "test-edit-pin-composer",
  "test-pin-board-store",
  "test-reference-scoring",
  "test-failure-banner",
  "test-pin-readiness",
  "test-pin-display-context",
  "test-pin-details-model",
  "test-pin-details-phase2",
  "test-pin-details-phase3",
  "test-pin-details-modal-compact",
  "test-optional-website-url",
];

/** Weekly Plan calendar + Smart Schedule. */
export const PLAN: string[] = [
  "test-weekly-plan-ui",
  "test-weekly-plan-handoff",
  "test-weekly-plan-multiselect",
  "test-weekly-plan-hover-images",
  "test-my-products-weekly-plan-ui",
  "test-plan-tile-interactions",
  "test-plan-pinterest-connect",
  "test-hover-preview-image",
  "test-smart-schedule",
  "test-smart-schedule-sync",
  "test-scheduling-consistency",
];

/**
 * Deliberately NOT in `npm test`. Each entry must carry a reason — an unexplained
 * exclusion is indistinguishable from a test somebody quietly disabled.
 */
export const EXCLUDED: Record<string, string> = {
  "test-ai-copy-context":
    "Real-browser Playwright test — drives a live dev server (E2E_TEST_MODE=true npm run dev). " +
    "`npm test` is the node-only gate; this runs via `npm run test:browser`.",
  "test-shopify-product-selection":
    "Pre-existing clean-checkout failure: asserts uncommitted i18n-ification of ProductPickerModal.tsx (legacy Studio surface, zero-diff vs HEAD). " +
    "Re-add to CORE/STUDIO/PLAN when the legacy-Studio i18n cluster (or the pinReadiness decision) lands.",
  "test-create-pins-batch-edit-ui":
    "Pre-existing clean-checkout failure: asserts uncommitted i18n-ification of studio/page.tsx legacy PinCard + PinCardActions.tsx (BatchEditDrawer assertions pass; the failing ones target legacy surfaces). " +
    "Re-add to CORE/STUDIO/PLAN when the legacy-Studio i18n cluster (or the pinReadiness decision) lands.",
  "test-pin-details-drawer":
    "Pre-existing clean-checkout failure: asserts uncommitted i18n-ification of the LEGACY PinDetailsDrawer.tsx + studio/page.tsx (parallel to this cluster StudioBoard/PinBoardCard). " +
    "Re-add to CORE/STUDIO/PLAN when the legacy-Studio i18n cluster (or the pinReadiness decision) lands.",
  "test-pin-details-persistence":
    "Pre-existing clean-checkout failure: asserts uncommitted i18n-ification of SmartScheduleDrawer.tsx (legacy, zero-diff vs HEAD). " +
    "Re-add to CORE/STUDIO/PLAN when the legacy-Studio i18n cluster (or the pinReadiness decision) lands.",
  "test-weekly-plan-slots":
    "Pre-existing clean-checkout failure: asserts uncommitted i18n-ification of SmartScheduleConfigForm.tsx (legacy, zero-diff vs HEAD). " +
    "Re-add to CORE/STUDIO/PLAN when the legacy-Studio i18n cluster (or the pinReadiness decision) lands.",
  "test-plan-list-view":
    "Pre-existing clean-checkout failure: asserts uncommitted i18n-ification of PlanListView.tsx (legacy, zero-diff vs HEAD). " +
    "Re-add to CORE/STUDIO/PLAN when the legacy-Studio i18n cluster (or the pinReadiness decision) lands.",
  "test-smart-schedule-config":
    "Pre-existing clean-checkout failure: asserts uncommitted i18n-ification + centered-modal of SmartScheduleDrawer.tsx (legacy, zero-diff vs HEAD). " +
    "Re-add to CORE/STUDIO/PLAN when the legacy-Studio i18n cluster (or the pinReadiness decision) lands.",
  "test-smart-schedule-rebalance":
    "Pre-existing clean-checkout failure: asserts uncommitted i18n-ification of SmartScheduleConfigForm.tsx rebalance UI (legacy, zero-diff vs HEAD). " +
    "Re-add to CORE/STUDIO/PLAN when the legacy-Studio i18n cluster (or the pinReadiness decision) lands.",
};

/**
 * DEFERRED — real tests that exist as untracked drafts in the working tree but are NOT
 * committed, because each imports product source that is itself still an uncommitted,
 * in-progress feature. Committing the test without its source would break `tsc` and
 * `npm test` on a clean checkout (tsconfig compiles scripts/**), and committing the
 * source would drag an unfinished feature into a test-gate change. They are documented
 * here (NOT in ALL_REGISTERED, so the git-tracked gate ignores them) and must be
 * committed together with their feature source, then moved into CORE/STUDIO.
 */
export const DEFERRED: Record<string, string> = {
  "test-analytics-events":              "needs src/lib/analyticsIngest.ts (analytics ingest, untracked)",
  "test-publish-due-claim":             "needs api/cron/publish-due/publishDueLogic.ts + api/pin-drafts/promote.ts (auto-publish, untracked)",
  "test-pin-draft-promote":             "needs api/pin-drafts/promote.ts (auto-publish, untracked)",
  "test-judge-verdict":                 "needs src/lib/ai-copy/judgeVerdict.ts (quality judge, untracked)",
  "test-creative-intelligence-metrics": "needs src/lib/creativeIntelligenceMetrics.ts + judgeCalibration.ts (untracked)",
  "test-top-pick":                      "needs src/lib/studio/topPick.ts (untracked)",
  "test-support-chat":                  "needs src/lib/support/chatResponder.ts + escalationCore.ts (untracked)",
  "test-support-inbox":                 "needs src/lib/support/inboxCore.ts (untracked)",
};

export const ALL_REGISTERED = [...CORE, ...STUDIO, ...PLAN, ...Object.keys(EXCLUDED)];
export const RUNNABLE = [...CORE, ...STUDIO, ...PLAN];
