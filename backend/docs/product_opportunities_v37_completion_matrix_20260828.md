# Product Opportunities v3.7 Completion Matrix — 2026-08-28

Authority: `docs/prd/0825数据功能修改-VibePin_Product_Opportunities_PRD_v3.7_—_产品与技术执行版.md`.

Candidate boundary: functional commit
`9a22c163cd08a4374d8aaaaf7ee6adf82ad849bc`, exact 81-artifact manifest
`backend/docs/product_opportunities_v37_release_manifest_9a22c16.json`.

This matrix separates implementation evidence from production truth. `PASS`
below never means that an unapplied schema, an unpromoted Web build, an empty
metric history or a disabled timer is live.

| PRD requirement | Current implementation evidence | Production truth | Verdict |
|---|---|---|---|
| Every Active Product is tracked independently of Save | `product_opportunity_tracking.load_targets()` pages the complete `product_opportunities` Active set, then selects persisted Primary Evidence; it never reads `saved_product_opportunities`. Budget overflow refuses the run instead of truncating the catalog. | v63 has not been applied and no Active v3.7 catalog exists. | Implementation PASS / Production NOT LIVE |
| Real direct PDP and real merchant image | Manifest construction re-fetches the Pin and merchant page; admission, RPC and table constraints reject missing/unsafe PDP identity, Pinterest-hosted images and unproven image provenance. | The latest reviewed permanent Supply receipt wrote zero eligible merchant-proven rows and was rejected for one render failure. | Implementation PASS / Data gate BLOCK |
| Product Pin is optional when a direct-link Source Pin is valid | Both Product Pin and `direct_outbound_link` Source Pin are admissible Evidence types; one persisted Primary and bounded Additional Evidence remain distinct. | No production v3.7 Evidence row exists yet. | Implementation PASS / Production NOT LIVE |
| Product name/title may be null and must never be fabricated | Admission accepts null, rejects unproven non-null names, API keeps null, cards omit the title and Create Pins receives no invented title/keyword. | Candidate Web is not promoted; current production homepage still contains older fabricated/retired claims. | Implementation PASS / Production UI BLOCK |
| Stable entity, lifecycle and history | Canonical URL/hash identity, partial current uniqueness, database-owned lifecycle transitions and history-preserving retirement are enforced. Exact PGlite transactions prove retired/current coexistence and complete schema rollback. Native PostgreSQL 17.11 and an isolated PostgreSQL 17.6 Supabase test project both passed the exact schema contract and two-session current-identity uniqueness. The Supabase run applied 158 catalog objects and rolled back to zero, with an independent final catalog SELECT confirming no v3.7 relation or advisory lock remained. | The test project lacks production's two legacy Product tables, so this proves Supabase multi-session/RLS/rollback behavior but not production legacy integrity. Production v63 remains absent. | Implementation + native PostgreSQL PASS / Test platform PASS / Production NOT LIVE |
| Daily idempotent snapshots and one-Primary metrics | Snapshot uniqueness is per canonical Pin/UTC day; shared Pins are fetched once. G30 and current/previous G7 bind one Primary Evidence and reject stale, incomplete or counter-regressed history. | Current reviewed automatic candidates have zero today/G7/G30/full-metric coverage; one Physical candidate has only a G14 anchor. | Implementation PASS / Metric launch BLOCK |
| Primary switch safety | Three distinct natural-day `not_found` observations are required; provider failures do not count. The replacement must itself have a valid current-day observation before the atomic switch. | No production switch history exists. | Implementation PASS / Production NOT LIVE |
| Physical and Digital calibration are separate | Persisted family/version calibration and release gates are independent. Demand/Trend/Fastest Growing remain hidden below 70% valid G30+G7 coverage, without an approved quality review, or without an effective approved calibration. | Both families currently lack launch-ready metric history; publication flags must remain false. | Implementation PASS / Metric launch BLOCK |
| Free fixed ten; paid full catalog; same facts per product | Free access is the persisted curated rank 1–10 at every list/detail/save path. Paid plans use the complete Active catalog. Both paths use the same `publicItem()` metric mapper; plan affects which products are accessible, not their facts. | No production v3.7 catalog exists, so entitlement behavior is not yet proven against live rows. | Implementation PASS / Live access NEEDS EVIDENCE |
| Saved Products is a record, not a tracking trigger | Saved Products is an account relation with database-owned idempotent state/history. UI copy describes a shortlist. Tracking has no Saved dependency. Native PostgreSQL and the isolated Supabase test project both proved two-user per-account reads, anonymous-read denial and server-only writes; the Supabase transaction returned the exact rollback sentinel and persisted zero Product/Saved rows. | Production relation is absent until Stage 1, so production entitlement behavior remains unproven. | Implementation + native PostgreSQL PASS / Test platform PASS / Production NOT LIVE |
| Save and Create Pin have no implicit side effects | Save calls only the Saved Products API. Create Pin uses the existing authenticated composer-draft plus one-shot fallback and never calls Save. Navigation occurs only after one handoff path succeeds. | Candidate interactive authenticated flow is not yet promoted or live-tested. | Implementation PASS / Live flow NEEDS EVIDENCE |
| No internal lifecycle vocabulary in Product UI | Product routes/components/API contract reject `retired`, `inactive`, `unavailable` and `insufficient_signal` as user copy; ordinary explanations and null omission are used instead. | Candidate is not promoted; current production truth scan must be repeated after promotion. | Implementation PASS / Production UI BLOCK |
| Retire percentile Demand, keyword Trend, Competition and Opportunity Score | Product Picker no longer exposes the old conclusions; the legacy product intelligence route returns HTTP 410; candidate landing removes fake/retired panels. | Current production homepage still exposes old/fabricated claims and is not a valid rollback target. | Candidate PASS / Production P0 BLOCK |
| Bounded automatic capacity | Supply scans exactly 100 Source Pins, can retain 0–50 merchant-proven legacy rows and uses atomic batches no larger than 20. Tracking separately allows up to 2,499 unique Primary Pins and 5,000 provider requests. | The accepted 29/22/29/20 Physical+Digital receipt has not yet completed as a trusted permanent-timer run. | Contract PASS / Automatic launch BLOCK |

## Current validation

- Backend: `1039 passed`, `2` credential-gated skips, `77` subtests passed, zero failures.
- Admission/migration focused group: `132/132`.
- Exact release automation contract: `30/30`.
- Product Web checks rerun from the current tree: v3.7 contract, access,
  metric controls, counts, admin, name honesty, marketing truth, link display and
  Create Pins prefill all passed; the counted suites contributed `8 + 7 + 9 +
  11 + 25 = 60` explicit cases in addition to four PASS-only contracts.
- ShellCheck 0.11.0: four exact `1946a684` LF Git blobs exited 0; only the
  intentional runtime-relative-source diagnostic SC1091 was excluded.
- Independent Claude Opus read-only review: `APPROVE`, no P0-P2 findings.
- Production catalog SELECT at `2026-08-28T05:05:05Z`: zero matching v63
  objects, mutation false.
- Stage 1 SQL proof is repository-replayable with lockfile-pinned PGlite 0.5.8:
  `cd backend/tests/pglite_v37 && npm ci && npm test` reproduced the exact
  10/18/9/3/4/91/44 contract, atomic Admission and zero-object rollback.
  It does not prove production PostgreSQL concurrency or live role isolation;
  those remain bounded production canary gates.
- Rollback-only PostgreSQL canary: local orchestration, fail-closed tests and an
  isolated native PostgreSQL 17.11 execution PASS. Its exact structured
  `P0001` sentinel prevents a SQL-echoing error response from becoming a false
  PASS. A production SELECT-only probe captured the real message-only API
  wrapper; `a299a17` now parses only that anchored format or an unambiguous
  structured pair and requires exact HTTP 400 / `55P03` for the lock challenger.
  The harness finished with zero rows, locks, sessions, v63 objects and fixture
  roles/tables; separately labelled operator evidence records database drop and
  server stop. Isolated Supabase test-project
  The isolated Supabase test-project Management API execution also passed:
  catalog `0 -> 158 -> 0`, exact `55P03` concurrent-duplicate block, exact
  `V37_ROLE_CANARY_PASS`, two-user/anonymous RLS checks, server-only writes and
  an independent final zero-object/zero-lock SELECT. This is platform evidence,
  not production legacy-integrity evidence. Receipt:
  `backend/docs/product_opportunities_v37_supabase_test_replay_20260829T021513Z.json`.
- A production GET-only pre-authorization snapshot bound to `9a22c163` found
  4,115 legacy Products, 35,521 snapshots and zero v63 objects. The latest
  completed physical backup was locatable, but PITR is disabled and no restore
  was tested. Both receipts are explicitly non-cutover evidence; the baseline
  must be recaptured within 900 seconds of an authorized migration. Evidence:
  `backend/docs/product_opportunities_v37_pre_authorization_baseline_20260829T024547Z.json`
  and
  `backend/docs/product_opportunities_v37_pre_authorization_backup_inventory_20260829T024627Z.json`.

## Data quality decision

The implementation is not the current business bottleneck. Production has
legacy discovery inventory but no stable v3.7 entities and no complete G30 plus
current/previous G7 history. Therefore real Product cards can be launched only
after staged admission, while Demand/Trend badges, filters and Fastest Growing
must remain hidden until each family independently passes its persisted 70%
coverage and quality/calibration gates.

## Remaining production sequence

1. Refresh the exact current-candidate six-unit/four-wrapper VPS `/tmp` hashes and
   `systemd-analyze verify`; the old `6839e760` receipt is historical only.
2. With separate production-write authorization, refresh Stage 0 catalog,
   backup inventory and a legacy baseline no older than 15 minutes.
3. Apply the exact canonical-LF v63 migration and immediately run the exact
   post-apply catalog/security/legacy-integrity verifier with all Product timers
   and metric publication flags disabled.
4. Run the rollback-only PostgreSQL concurrency/role canary first in the isolated
   test project and then, under separate authority, against the post-apply
   production schema. Require exact before/after equality and zero persisted rows.
5. Admit one reviewed Product, prove every Product/Evidence field, then rehearse
   the exact-ID history-preserving rollback. Only afterward admit one batch of at
   most 20.
6. Deploy Tracking disabled, run preflight/dry-run and one bounded real canary;
   prove lock, timeout, failure propagation, cleanup and metric writes.
7. Promote the unchanged qualified Web boundary only after truthful live rows
   exist; verify Free ten, paid catalog, Saved Products, Create Pin and removal of
   all retired/fabricated public claims on `vibepin.co`.
8. Enable Admission and Tracking timers in order only after their manual canaries
   pass; preserve Pinterest cooldowns and verify first permanent-timer origins.

## Rollback boundary

- Before the first admission, schema-only rollback is allowed only if every new
  v63 table is still empty and the legacy baseline remains identical.
- After the first retained admission, do not drop v63 history. Disable behavior,
  retire exact admitted IDs when required, keep Evidence/snapshots, and revert
  application/service bytes to a separately verified truthful candidate.
- The current production Web is not a valid rollback target because its public
  homepage still contains fabricated or retired Product claims.
