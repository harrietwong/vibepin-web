# Product Opportunities v3.7 Completion Matrix — 2026-08-29

Authority: `docs/prd/0825数据功能修改-VibePin_Product_Opportunities_PRD_v3.7_—_产品与技术执行版.md`.

Exact implementation boundary:

- Functional commit: `d2c13dd6a4d1e79d0d247fa6cd09d68c04a15b5d`
- Release manifest: `backend/docs/product_opportunities_v37_release_manifest_d2c13dd.json`
- Manifest artifacts: 81 unique paths
- Documentation/evidence parent before this matrix: `e13419ff59dc3b4cb90a0b0b24b0d227d9d82ddb`
- Production integration base: `b22930ebe73847cf35bc44be789414902ae6b599`

This matrix distinguishes implementation, data readiness and production truth.
`Implementation PASS` never means that an unapplied schema, disabled or absent
job, unpromoted Web build, or empty metric history is live.

## Requirement-by-requirement audit

| PRD requirement | Current authoritative evidence | Production truth | Verdict |
|---|---|---|---|
| Stable Product Opportunity identity and lifecycle | v63 defines a stable UUID entity, canonical URL/hash identity, a partial unique index for every non-retired current identity, database-owned lifecycle transitions and history-preserving retirement. Admission uses plain transactional inserts and exact-ID rollback. Native PostgreSQL, PGlite and isolated Supabase replay proved current-identity concurrency and zero-object rollback. | Fresh `2026-08-29T07:50:30Z` catalog baseline found zero v63 objects. | Implementation PASS / Production NOT LIVE |
| Retired history can coexist with a later current identity | Partial uniqueness excludes only `retired`; retired is terminal and immutable while the same canonical identity may later enter a new non-retired entity. Tests prove retired/current coexistence and block two current identities. | No production v3.7 entity exists. | Implementation PASS / Production NOT LIVE |
| Multiple Evidence Pins with one persisted Primary | Evidence identity, status transitions, one-active-Primary partial uniqueness, deferrable active-Evidence checks and a Primary-switch audit table are enforced by v63. Primary is read from persistence, never recalculated per API request. | No production v3.7 Evidence exists. | Implementation PASS / Production NOT LIVE |
| Direct Source Pin is allowed when no Product Pin exists | Manifest and admission preserve `product_pin` versus `source_pin`; a Source Pin must directly resolve to the same real merchant PDP. The UI labels Product Pin and Source Pin separately. | Existing reviewed legacy candidates are Source-Pin based, but none is admitted into v63 yet. | Implementation PASS / Data admission pending |
| Real PDP, merchant image and provenance; nullable name | Manifest construction re-fetches Pinterest and merchant evidence. Python, RPC and table constraints reject unsafe/non-PDP URLs, Pinterest-hosted product images, missing image provenance and fabricated non-null names. A null name remains null; a missing real image cannot become Active. | No merchant-proofed v3.7 Active row exists. The legacy pool is not sufficient evidence. | Implementation PASS / Production data gate BLOCK |
| All Active Products tracked, independent of Save | `product_opportunity_tracking.load_targets()` pages the complete Active catalog, selects persisted Primary Evidence and never reads Saved Products. More than 2,499 due unique Pins fails before provider access instead of silently truncating the visible catalog. | Active v3.7 catalog is empty because v63 is absent; Tracking service/timer is absent on VPS. | Implementation PASS / Production NOT LIVE |
| One canonical Pin snapshot per UTC day and idempotent retry | `UNIQUE(pinterest_pin_id,captured_on)`, UTC capture-day checks and server-only observation RPCs enforce one shared daily Pin fact. Shared Pins are fetched once and fanned out to Evidence health. A valid canonical row cannot be downgraded. | No v3.7 snapshot table or automatic receipt exists. | Implementation PASS / Production NOT LIVE |
| Raw observation honesty | Valid and counter-regression save facts persist with real capture time and value; provider errors/429/timeouts are never converted to zero or `not_found`. The same-day canonical row can upgrade a confirmed `not_found` placeholder to a valid save fact but cannot replace an existing valid save fact. This satisfies the one-canonical-daily contract, but it is not a full immutable per-attempt log. | No production attempt/snapshot history exists. | P0 canonical fact PASS / per-attempt history explicitly out of current schema |
| Counter regression does not become negative Demand or Cooling | Observation RPC marks a lower cumulative count `counter_regression`; metric construction cuts the old baseline, excludes the regressed point and requires a new valid history segment. UI receives no fabricated negative demand. | Zero production G30/G7 coverage. | Implementation PASS / Metric launch BLOCK |
| Primary switch requires three natural-day not-found confirmations | Evidence health increments only on distinct consecutive UTC dates. Provider/network failures do not count. A replacement must have a valid current-day observation; switch is atomic and audited. Metrics bind one Evidence and do not splice Pin histories. | No production switch history. | Implementation PASS / Production NOT LIVE |
| Honest G30 and current-versus-previous G7 | Versioned metric logic uses 7d/14d ±1-day anchors, 30d ±3-day anchor, minimum 10/20 valid days and maximum 3-day gaps. It records actual window days and refuses stale, incomplete or cross-Evidence history. | No production v3.7 metrics and no qualifying history. | Implementation PASS / Metric launch BLOCK |
| Physical and Digital calibration remain separate | Calibration and release-gate rows key on Product family plus metric version. High recent demand requires an effective approved family threshold. Demand/Trend controls and Fastest Growing remain closed until the family has at least 70% valid G30+G7 coverage plus approved quality/calibration. | Neither family has launch-ready metric history or an approved production calibration. | Implementation PASS / Publication BLOCK |
| High Demand wording is not a market-sales claim | UI uses `High recent demand` and `Based on Pinterest saves gained in the last 30 days`; it never converts Saves into sales or revenue. | Candidate Web is not promoted. | Implementation PASS / Production UI NOT LIVE |
| Free fixed ten; paid plans use the complete catalog and same facts | Database-managed stable ranks 1–10, audited rank changes and server-side list/detail/save access checks enforce the fixed Free set. Paid plans query the complete Active catalog. Both plans use the same public metric mapper. Direct URL/search/pagination cannot expand Free access. | v63 catalog is absent; live account behavior has not been proven against production rows. | Implementation PASS / Live entitlement NEEDS EVIDENCE |
| Saved Products is account-scoped history, not a tracking trigger | Unique user/Product relationship, RLS reads, server-only writes and idempotent state transitions preserve account isolation and save time. Tracking has no Saved dependency. Test PostgreSQL/Supabase executions proved two-user isolation and anonymous denial. | Saved relation is absent in production. | Implementation PASS / Production NOT LIVE |
| Save and Create Pin are independent | Save calls only the Saved Products API. Create Pin uses the existing composer handoff and never calls Save. Separate UI actions, icons, copy, analytics and tests prohibit either implicit side effect. | Authenticated Preview/live flow is unverified. | Implementation PASS / Browser QA NEEDS EVIDENCE |
| Truthful Product Card and Modal | Card and modal use real merchant image, omit null name, separate Pinterest and Product links, use Primary-only Total Saves and omit unavailable metrics/badges. Modal exposes user explanations, not SQL/enum/error text. No Drawer implementation is used. | Candidate Web is not promoted; authoritative Preview page state could not be read. | Implementation PASS / Production UI NOT LIVE |
| No internal status vocabulary in user UI | Product UI/API contract tests reject `retired`, `inactive`, `unavailable`, `evidence_status` and `insufficient_signal` as public copy. Saved history uses ordinary language. | Post-promotion production scan is still required. | Implementation PASS / Production verification pending |
| Search, family/category/platform filters and safe sorting | Server and UI implement Search, Physical/Digital, Category, Platform and Most Saved/Newest. Demand/Trend filters and growth sorting are gated by the persisted 70% family release gate, not mere renderability. | No production catalog or release gate is active. | Implementation PASS / Advanced controls BLOCKED by data |
| Retire percentile Demand, keyword Trend, Competition and Opportunity Score | v3.7 public mapper contains only saves-derived metrics. Legacy Product detail route returns HTTP 410; Product UI, picker and landing boundaries reject old score/competition/trend fields and fabricated claims. | Candidate has not been promoted; the prior production Web cannot be used as a truthful rollback target. | Candidate PASS / Production P0 BLOCK |
| Launch taxonomy supports Home, Wedding, Gifts, Jewelry, Fashion and Digital | Schema, admission, manifest and UI support every PRD business category. Wedding/Gifts may be Physical or Digital; Jewelry remains Physical; Product type can refine Fashion into Jewelry/Accessories. Production read-only taxonomy audit found 39 reviewable source/family candidates including 14 Wedding rows. | The automatic 100-source launch receipt is currently 29 Fashion / 22 Women's Fashion / 29 Home / 20 Digital. It proves the four acquisition buckets, not merchant-proofed volume for every business category. Wedding/Gifts/Jewelry coverage must be reported from admitted rows and must not be inferred from bucket labels. | Representation PASS / per-category launch data NEEDS EVIDENCE |
| Bounded Product Supply | Exact scheduled launch profile scans 100 Pins in 29/22/29/20, admits at most 50 merchant-proven legacy rows and writes atomic batches no larger than 20. Legacy 36/28/36 and v3.7 launch receipts cannot validate each other. | VPS currently runs the legacy Supply timer; the next old trigger is `2026-08-29 23:08:49 Asia/Shanghai`. No trusted permanent v3.7 launch-profile receipt exists. | Contract PASS / Automatic launch BLOCK |
| Bounded Tracking automation and health report | 2,499 unique-Pin ceiling, 5,000-request budget, per-request timeout, one retry, rate limiter, global lock, systemd timeout/tree kill, failure propagation, orphan check, UTC-day abort and complete health counters are implemented and tested. | Tracking unit is absent and no first automatic timer run exists. | Implementation PASS / Automatic launch BLOCK |
| Product analytics events without prompt/secret payloads | All ten P0 events are typed and emitted at list, modal, link, Save, Create Pin and filter surfaces. Payloads contain Product IDs/family/surface/state, not prompts or credentials. | Production event flow is not verified. | Implementation PASS / Live analytics NEEDS EVIDENCE |
| Rollback preserves truth and history | Additive v63 migration has an exact schema rollback while all new tables are empty. Admission rollback retires exact returned IDs and keeps historical Evidence semantics. VPS and Web rollback require exact stored bytes/deployment identities; no rollback restores fake titles/images or old metrics. | Production migration/deployment has not occurred. | Contract PASS / Production proof pending |
| Deployment lineage preserves the rest of VibePin | The v3.7 release manifest is pinned to integration base `b22930ebe73847cf35bc44be789414902ae6b599`, and that base is an ancestor of the functional commit. This proves the v3.7 candidate's own lineage, not equivalence with the current production Web tree or the later multichannel, admin-cockpit and reference-recommendation candidates. | A historical integrated branch `74be67da` contains the production lineage but not final v3.7 `d2c13dd6` or the three later candidates. Read-only pairwise merge-tree found 9–10 textual conflicts per selected line. No current merged deploy candidate exists; a standalone Vercel deployment would omit unrelated live/candidate work. See `product_opportunities_v37_integration_readiness_20260829.md`. | Candidate lineage PASS / Integrated deploy candidate BLOCK |

## PRD acceptance audit

### Data and algorithm

- Same Pin/day canonical uniqueness: implementation PASS; production not live.
- Retired/current coexistence: PostgreSQL test PASS; production not live.
- At most one Primary and complete switch audit: implementation PASS.
- No cross-Pin history splice: implementation/test PASS.
- Counter regression does not create negative Demand/Cooling: implementation/test PASS.
- G30 and G7 real anchor rules: implementation/test PASS.
- Thresholds unapproved means no High recent demand: implementation/test PASS;
  production calibration remains absent.
- Product name/image/price honesty: implementation/test PASS; no production v3.7
  Active rows yet.
- Old percentile/keyword/competition/score fields excluded: candidate PASS;
  production promotion still required.

### UI and access

- Null name never becomes `Product`: candidate PASS.
- Missing real merchant image cannot enter public API/UI: candidate PASS.
- Pinterest and Product links remain distinct: candidate PASS.
- No fake no-data/zero badge: candidate PASS.
- Card and modal share one public item: candidate PASS.
- Saved state persistence/account isolation: database and API tests PASS;
  production browser flow pending.
- Save/Create Pin independence: contract tests PASS; production browser flow pending.
- Free fixed ten and paid full catalog: contract tests PASS; production account
  evidence pending.

### Automation

- Timeout, locks, retries, failure propagation and exact rollback tests: PASS.
- 404/429/5xx/network/timeout tests: PASS.
- Total provider outage cannot be a successful run: PASS.
- Cross-UTC-day run refuses all writes: PASS.
- First timer-triggered v3.7 Admission/Tracking execution: NOT RUN.
- Orphan-free production execution: NOT RUN.
- VPS deployed SHA equals target candidate: NOT DEPLOYED.

## Current validation

- Full backend: `1054 passed`, `2` credential-only skips, `77` subtests.
- Focused Supply/Tracking/manifest/admission: `199 passed`.
- Current release/automation contract: `35 passed`.
- Exact Web candidate: registry `132/132`; TypeScript exit 0; i18n exit 0;
  production build generated `70/70` routes.
- Independent code/release review: `APPROVE WITH EXTERNAL GATES`, no P0/P1
  pointer, sequencing or rollback defect.
- The central deployment controller independently re-opened the exact functional
  and docs tips, corrected its stale three-defect assessment, and accepted the
  code as closed. It has not yet rerun the complete gate set on a merged deploy
  candidate.
- Candidate verification was run from a clean committed state. This matrix is a
  docs/test-only completion-audit addition; no production mutation was made.

## Current production data truth

Fresh read-only baseline at `2026-08-29T07:50:30.592347Z`, bound to the exact
functional commit:

```text
legacy pin_products = 4,115
legacy pin_save_snapshots = 36,672
v63 matching objects = 0
mutation = false
verdict = PASS
```

The baseline is not cutover-eligible and must be refreshed within 900 seconds of
an authorized migration. The enabled legacy Supply timer can continue changing
legacy rows, so an older count or checksum cannot be reused.

There are currently no production v3.7 Active Products, Evidence, snapshots,
metrics, Saved records or release gates. Consequently:

- Product facts and Evidence can launch only after staged admission.
- High recent demand, Rising/Stable/Cooling, Demand/Trend filters and Fastest
  Growing must remain hidden.
- No claim can be made yet about 70% Physical or Digital metric coverage.
- No claim can be made yet about per-category admitted coverage.

## Phase verdict

| PRD phase | Status | Reason |
|---|---|---|
| Phase 0 — read-only baseline | PARTIAL PASS | Code/data definitions and current legacy baseline exist. A completed backup is locatable, but the cutover baseline/backup must be refreshed immediately before migration; Preview platform evidence remains incomplete. |
| Phase 1 — data foundation | CODE READY / NOT LIVE | v63, Admission and Tracking are implemented and tested, but production has zero v63 objects and no first automatic run. |
| Phase 2 — Shadow Metrics | NOT STARTED IN PRODUCTION | No production Primary history or metrics exists. |
| Phase 3 — user UI | CANDIDATE READY / NOT LIVE | Candidate builds and contract tests pass; a production-lineage integrated candidate, Preview/browser proof and production promotion evidence are missing. |
| Phase 4 — P1 | OUT OF CURRENT P0 RELEASE | Timeline, alerts, emerging and benchmarks are not required to claim P0 completion. |

## Overall conclusion

```text
CODE: APPROVE
STAGED EXECUTION: READY AFTER EXTERNAL GATES
INTEGRATED DEPLOY CANDIDATE: NOT BUILT
PRODUCTION WORKFLOW: NOT LIVE
FULL PRD P0 OBJECTIVE: NOT COMPLETE
```

The v3.7 implementation is no longer the main blocker. Completion still requires:

1. A clean integrated deployment candidate that preserves current production
   plus the explicitly selected multichannel/admin/reference candidates, followed
   by independent TypeScript, test, i18n, production-build and contamination gates.
2. A fresh completed-backup inventory and <=900-second legacy baseline.
3. Exact v63 apply plus post-apply catalog/security/legacy-integrity proof.
4. Staged one-Product and <=20-row Admission canaries with exact rollback.
5. Immutable Preview and authoritative Free/paid/Save/Create Pin/truthful-render QA.
6. Exact VPS byte parity, expected-project environment binding and disabled
   preflight services.
7. Trusted 29/22/29/20 Supply dry-run/canary and first permanent receipt audited
   with explicit `--scheduled-profile launch-v37`.
8. Admission first automatic run, then all-Active Tracking first automatic run.
9. Real snapshot history, separate Physical/Digital calibration and persisted 70%
   quality gates before any Demand/Trend global controls are exposed.

Until those facts exist, the Product Opportunity code may be staged but the
business workflow must not be described as launched.
