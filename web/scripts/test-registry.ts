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
  "test-analytics-events",
  // Pinterest
  "test-pinterest-oauth",
  "test-pinterest-integrations-repair",
  "test-pinterest-connection-consistency",
  "test-pinterest-client-dedupe",
  "test-published-pin-summary",
  "test-social-provider-status",
  // Admin operator console (derivation layer + UI i18n)
  "test-admin-action-center",
  "test-activation-funnel",
  "test-ai-adoption",
  "test-admin-today-i18n",
  "test-account-quota",
  "test-account-identity",
  "test-publish-capability",
  "test-publish-results",
  "test-per-account-disconnect",
  "test-settings-account-actions",
  // Facebook Page OAuth
  "test-facebook-pages",
  // AI copy / creative intelligence
  "test-ai-copy-keyword-context",
  "test-ai-copy-language-guardrail",
  "test-creative-direction-v2",
  "test-creative-controls",
  "test-creative-intelligence",
  "test-creative-intelligence-v1",
  "test-creative-recommendations",
  "test-creative-intelligence-metrics",
  "test-ai-provider-auth-boundary",
  "test-ai-provider-rate-limit",
  "test-ai-copy-provider-boundary",
  "test-judge-verdict",
  "test-ai-cost-log",
  "test-reference-scoring",
  "test-reference-basis",
  "test-product-evidence",
  "test-top-pick",
  // Products / opportunity
  "test-product-ideas-picker",
  "test-pin-ideas-picker",
  "test-product-preview-amazon",
  "test-product-link-display",
  "test-product-opportunity-counts",
  "test-product-opportunity-admin",
  "test-product-name-honesty",
  "test-product-top-tiers",
  "test-amazon-affiliate",
  "test-amazon-affiliate-wiring",
  // Billing (Creem)
  "test-plan-entitlements",
  "test-usage-period-math",
  "test-billing-usage-api",
  "test-entitlements-security",
  "test-usage-metering",
  "test-creem-checkout-api",
  "test-creem-webhook-ordering",
  "test-creem-billing-status",
  "test-predeploy-guard",
  "test-moderate-prompt",
  "test-generation-moderation-gate",
  "test-generation-metering",
  "test-text-metering",
  "test-scheduled-post-metering",
  "test-aup-compliance",
  "test-public-compliance-copy",
  // Settings / support
  "test-settings-p0",
  "test-support-ai-responder",
  "test-support-translator",
  "test-support-metrics",
  "test-support-chat",
  "test-support-inbox",
  // Sync / storage
  "test-pin-draft-sync",
  "test-pin-draft-promote",
  "test-schedule-timezone",
  "test-publish-due-claim",
  "test-expire-reservations-cron",
  "test-publish-events",
  "test-user-store-sync",
  "test-user-store-route",
  "test-user-store-adapters",
  "test-user-store-media-adapters",
  "test-media-offload",
  // Shopify
  "test-connection-limit",
  "test-settle-generation-job",
  "test-generation-job-route",
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
  "test-publishing-prefs",
  "test-studio-flow-regression",
  "test-studio-plan-match",
  "test-studio-generated-section",
  "test-asset-picker-ia",
  "test-create-pins-prefill",
  "test-batch-edit-planning",
  "test-batch-board-target",
  "test-batch-edit-back-close",
  "test-batch-edit-product-mapping",
  "test-edit-pin-composer",
  "test-pin-board-store",
  "test-shopify-product-selection",
  "test-create-pins-batch-edit-ui",
  "test-pin-details-drawer",
  "test-pin-details-persistence",
  "test-failure-banner",
  "test-publish-error-display",
  "test-publish-failure-consistency",
  // Multi-image publishing (WS-A 2026-08-27): per-platform media rules + the exact
  // Pinterest media_source a carousel produces.
  "test-media-rules",
  "test-pin-media-source",
  // WS-B2a 2026-08-27: cover ≡ media[0], load-time normalization of stale covers,
  // in-place media replacement, and the per-platform issue attribution.
  "test-content-media-model",
  // WS-C2 2026-08-27: the card's media compatibility notice (which platform refuses
  // this set, which thumbnails are at fault, and when to stay silent) and the
  // "Publish separately" split that is §13's answer while the crop tool is deferred.
  "test-media-notice",
  "test-split-content-media",
  // Create Pins card view model (WS-C1, PRD 0826 §3–§6, §20): variant per lifecycle,
  // the "1 / N" cover counter, per-destination result rows, and the partial-success
  // rule (posted + needs attention → Retry, not Publish).
  "test-card-lifecycle-view",
  // Bulk operations on the Create Pins board (WS-F, PRD 0826 §19/§30): the
  // publish partition (fully-published items must never be re-sent), the
  // per-lifecycle delete impact, and the result summary's reason contract.
  "test-bulk-actions",
  // Create Pins right-side Plan sidebar (WS-D, PRD 0826 §23–§24): week grouping,
  // future-before-history ordering, state classification, the "+N" trigger badge.
  "test-plan-sidebar-model",
  // Social accounts PRD 2026-08-05 (Phase A 4-state mapping; Phase B identity guard + store;
  // Phase C pinned publish targets).
  "test-account-ui-state",
  "test-pinterest-callback-identity",
  "test-social-connection-store",
  "test-publish-target",
  "test-pin-readiness",
  "test-pin-display-context",
  "test-pin-details-model",
  "test-pin-details-phase2",
  // Create Pin flow 2026-07-21 (selection/generation/URL/picker/recommendation).
  "test-selected-references",
  "test-reference-groups",
  "test-destination-url-derivation",
  "test-product-selection",
  "test-canonical-picker",
  "test-recommendation-request",
  "test-drawer-product-state",
  "test-generation-product-link",
  "test-ai-generation-run",
  "test-url-persistence",
  "test-pin-details-phase3",
  "test-pin-details-modal-compact",
  "test-optional-website-url",
  "test-schedule-publish-validation",
  "test-generation-jobs",
  "test-generation-recovery",
  "test-generation-failure-media",
];

/** Weekly Plan calendar + Smart Schedule. */
export const PLAN: string[] = [
  "test-weekly-plan-ui",
  "test-weekly-plan-handoff",
  "test-weekly-plan-multiselect",
  "test-weekly-plan-hover-images",
  "test-my-products-weekly-plan-ui",
  "test-plan-card-status",
  "test-unscheduled-lifecycle",
  "test-plan-tile-interactions",
  "test-plan-pinterest-connect",
  "test-plan-account-filter",
  "test-hover-preview-image",
  "test-smart-schedule",
  "test-smart-schedule-sync",
  "test-scheduling-consistency",
  "test-schedule-social-guard",
  "test-scheduled-destinations",
  "test-publish-fanout",
  "test-publish-content",
  "test-scheduled-account-identity",
  "test-publish-attempt-ordering",
  "test-publish-in-flight",
  "test-scheduled-image-url",
  "test-weekly-plan-slots",
  "test-plan-list-view",
  "test-smart-schedule-config",
  "test-smart-schedule-rebalance",
  "test-custom-time",
];

/**
 * Deliberately NOT in `npm test`. Each entry must carry a reason — an unexplained
 * exclusion is indistinguishable from a test somebody quietly disabled.
 */
export const EXCLUDED: Record<string, string> = {
  "test-ai-copy-context":
    "Real-browser Playwright test — drives a live dev server (E2E_TEST_MODE=true npm run dev). " +
    "`npm test` is the node-only gate; this runs via `npm run test:browser`.",
  "test-db-integration-rate-limit":
    "REAL-POSTGRES integration test — writes and deletes rows in the isolated Supabase " +
    "test project. `npm test` must stay a hermetic node-only gate that anyone can run " +
    "with no credentials and no network, so this runs via `npm run test:db` instead. " +
    "It does NOT skip when credentials are absent: test:db exits NON-ZERO with an " +
    "explanation, because a green run that connected to nothing is the exact failure " +
    "mode this channel exists to prevent. See scripts/lib/test-db-config.ts for how the " +
    "target is pinned to the test project and can never resolve to production.",
  "test-db-usage-lifecycle":
    "REAL-POSTGRES integration test for the v56 usage-account LIFECYCLE RPC " +
    "(usage_ensure_account: init / period rollover / plan change). Writes and deletes " +
    "rows in the isolated Supabase test project, so it runs via `npm run test:db` rather " +
    "than the hermetic `npm test` gate, for the same reasons as the rate-limit and " +
    "usage-ledger DB tests. It fails loudly rather than skipping when credentials are " +
    "absent. It proves the exactly-once guarantees the lifecycle lives on — a concurrent " +
    "double-ensure yields ONE account + ONE init event, and a replayed rollover does not " +
    "double-reset — which only real Postgres row locks + unique constraints can testify to.",
  "test-db-usage-metering":
    "REAL-POSTGRES integration test for Phase 4I image metering — writes and deletes " +
    "rows in the isolated Supabase test project, so it runs via `npm run test:db` " +
    "rather than the hermetic `npm test` gate. It drives the exact RPC cycle the route " +
    "and worker now depend on (usage_reserve_generation_job → the generation_jobs row " +
    "carries usage_reservation_id → per-slot settle with the ['s0','s1',...] keys the " +
    "TS module and worker both produce → reservation ends PARTIAL with counters exact), " +
    "which only real Postgres can testify to. Fails loudly rather than skipping when " +
    "credentials are absent, like the other test-db-* channels.",
  "test-db-text-metering":
    "REAL-POSTGRES integration test for Phase 4T TEXT metering — writes and deletes " +
    "rows in the isolated Supabase test project, so it runs via `npm run test:db` " +
    "rather than the hermetic `npm test` gate. It drives the exact RPC cycle /api/ai-copy " +
    "now depends on (usage_reserve with usage_type ai_text_generation + the single " +
    "['s0'] slot the TS module produces → settle s0 succeeded bills the account exactly " +
    "once → release returns capacity → a replayed settle bills exactly once), which only " +
    "real Postgres can testify to. Fails loudly rather than skipping when credentials " +
    "are absent, like the other test-db-* channels.",
  "test-db-post-metering":
    "REAL-POSTGRES integration test for Phase 5B SCHEDULED-POST metering — writes and " +
    "deletes rows in the isolated Supabase test project, so it runs via `npm run test:db` " +
    "rather than the hermetic `npm test` gate. usage_consume_scheduled_post is the only " +
    "single-call consume in the ledger (no reserve/settle), so its correctness rests " +
    "entirely on the database: the (user_id, idempotency_key) unique is what makes a cron " +
    "re-claim of the same draft+scheduled_at charge once instead of twice, and an " +
    "unlimited (NULL limit) plan must still write an event. It also pins a known v55 " +
    "defect — the mismatched-quantity guard is swallowed by the function's own " +
    "unique_violation handler — so a future fix is a visible change, not an accident. " +
    "Fails loudly rather than skipping when credentials are absent, like the other " +
    "test-db-* channels.",
  "test-usage-ledger-db":
    "REAL-POSTGRES integration test for the v55 usage-ledger primitives — writes and " +
    "deletes rows in the isolated Supabase test project, so it runs via `npm run test:db` " +
    "rather than the hermetic `npm test` gate, for the same reasons as the rate-limit " +
    "test above (and it likewise fails loudly rather than skipping when credentials are " +
    "absent). It is the ONLY caller of those RPCs: the v55 primitives are deliberately " +
    "DORMANT — no route, worker, webhook, publish path, Billing UI or cron touches them " +
    "until Phase 3 wires them up — so this suite is the sole evidence that reservation, " +
    "settlement, release and expiry behave correctly under real concurrency.",
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
export const DEFERRED: Record<string, string> = {};

export const ALL_REGISTERED = [...CORE, ...STUDIO, ...PLAN, ...Object.keys(EXCLUDED)];
export const RUNNABLE = [...CORE, ...STUDIO, ...PLAN];
