# Product Opportunities v3.7 Completion Audit — 2026-08-26

Verdict: **APPROVE WITH CONDITIONS for the clean Product Opportunities release
candidate; BLOCK production v63/Web/admission/tracking claims until separately
authorized staged rollout and first automatic runs are proven.**

This audit uses the v3.7 execution PRD as the product contract. It does not
claim that the v63 schema, Web release, admission chain, or tracking timer is
already live. No production Product Opportunity row was created by this audit.

## Release-lineage truth

### Current authoritative local candidate

The current deployment-topology candidate is
`codex/product-v37-manifest-b229`. Its exact parent is production remote
`b22930ebe73847cf35bc44be789414902ae6b599`; its functional tip is
`5b5f98c0c6d1511a9a24a1695eccfa839e3c7e62`; and its exact Product boundary is
the 76-artifact
`backend/docs/product_opportunities_v37_release_manifest_58598b4.json`. This tip
inherits the reviewed Product implementation from `351e479`, the 17:15
Asia/Shanghai UTC-day-safe Tracking schedule from `01dcb53`, and restores the
`classify-chain` route required by the already-installed Crawl OnSuccess wrapper.
It also includes `c8f0d77`, which separates the PRD launch business taxonomy
from immutable acquisition source category and independently validated
Physical/Digital family. Wedding is therefore not collapsed into Physical.
Follow-up `5b5f98c` admits the real production `jewelry` source label as
physical provenance and normalizes it to the existing Jewelry & Accessories
business category without changing discovery quotas.
The read-only production evidence is archived at
`backend/docs/product_opportunities_v37_classify_chain_drift_20260827T131825Z.json`:
the automatic 2026-08-27 chain exited 2 because the deployed worker had zero
`classify-chain` routes. The repair is locally qualified but not deployed, so
same-day fresh classification remains unproven in production.
It changes 72 paths and all 72 belong to that manifest. The four remaining
manifest dependencies are byte-identical to the remote base. This eliminates
the Usage/Metering production files that a whole-tree deployment of the former
`99efabc` candidate would also have shipped.

The Product-only candidate was validated from its clean committed functional
and contract-test state: backend 890 passed with 2 live-only skips and 77
subtests; Web 132/132 passed; TypeScript passed; a clean `npm ci` installed 417
packages; `npm audit --audit-level=low` found zero vulnerabilities; the
production build generated 70/70 static pages; the built localhost site passed
the Product-truth render verifier; and the manifest/automation contract passed
22/22, while the focused worker, automation, and admission group passed 59/59.
ShellCheck also passed the exact `351e479` Git blobs for `cloud_lib.sh`,
Product Supply, Product Opportunity Admission and Product Tracking wrappers;
the intentional dynamic shared-library source warning was excluded explicitly,
while no other finding was suppressed. No environment file was created, no
production endpoint was used, and no push, deployment, database write or timer
mutation occurred.

The former `codex/product-v37-security-deps` pointer below remains historical
functional evidence, not the current whole-tree deployment candidate.

The historical integration candidate is
`codex/product-v37-security-deps`. Its prequalified integration base
is `64365494fea74cfaabcba43345794579eb652d68`; its functional tip is
`99efabcf8221141a470e73ae8e9765aad866a089`; and its exact Product boundary is
the 76-artifact
`backend/docs/product_opportunities_v37_release_manifest_99efabc.json`.
`origin/master=b22930ebe73847cf35bc44be789414902ae6b599` is a verified ancestor.
All historical candidate pointers below this section are chronological evidence
and must not replace the Product-only pointer in release automation.

The reconstruction replayed the later Supply receipt/origin/funnel gates,
tracking count bounds, explicit timer precision, reboot-safe cutover, partial
backup rollback safety and strict SSH host verification. A first TypeScript run
correctly rejected deletion of `generationModeration.ts`: unlike the later
`fec94a7` branch, this production lineage still imports that helper from the
generation route and four test locations. The deletion was reverted, the full
generation moderation gate passed 105/105, and full TypeScript then passed.
Studio's required `Suspense` boundary was also retained. The exact tree passed
881 backend tests with 2 live-credential skips, all focused Product contracts,
and the production build generated 70/70 static pages. No push, merge,
deployment, production schema/data or timer mutation occurred.

The same clean candidate then closed the Web dependency gate in the standalone
commit `c42f517bc87844c4a329444adbccde59a2bee07e`: Next.js 16.3.3,
eslint-config-next 16.3.3, Undici 8.9.0 and compatible transitive security
updates reduced `npm audit` from 8 known vulnerabilities (7 high, 1 low) to
zero. A clean `npm ci`, full TypeScript, all 134 Web tests then registered, the
focused Product/Create-Pin contracts and the 70/70-page production build passed.
After the browser-rendered Product-truth verifier joined the exact full
candidate, a fresh full `npm test` run on 2026-08-27 passed the expanded
registry at 135/135 with zero failures.
The first build attempt lacked build-only Supabase variables and failed before
page collection; the rerun used process-local non-secret placeholders and
passed without creating an env file.

Commit `f73d5df22659c5733cb8ea48f6037515e0497342` closes the corresponding
deployment gap: `web/vercel.json` now uses `npm ci`, so Vercel installs the
reviewed lockfile rather than re-resolving dependency ranges. The automation
contract, a dry-run clean install and the zero-vulnerability audit passed.
The repository does not contain linked `.vercel/project.json` metadata, so the
platform's Root Directory is not yet proven from local evidence. A read-only
Vercel CLI identity check failed inside CLI 58.4.0 with a ByteString character
conversion error and yielded no project settings; this is recorded as
`NEEDS VERCEL EVIDENCE`, not as a release failure or pass. Promotion must first
prove Root Directory `web` and show `npm ci` plus Next.js 16.3.3 in the candidate
build log.

A later direct read-only attempt made the remaining boundary more specific. The
local CLI credential expired at `2026-08-26T18:07:33Z`; an authenticated project
list request returned HTTP 403, the in-app browser could not attach its Vercel
page, and the connected Chrome path timed out. No credential refresh, project
change or deployment was attempted. Therefore the platform evidence remains a
hard stop rather than an inferred pass. The local candidate still proves only
its checked-in `web/vercel.json` (`npm ci`, `npm run build`, `.next`), clean
install, 135/135 Web tests and 70/70-page build. Evidence:
`backend/docs/product_opportunities_v37_vercel_evidence_gap_20260827T124031Z.json`.

Commit `99efabcf8221141a470e73ae8e9765aad866a089` adds the already-qualified
browser-rendered Product-truth verifier to the full v3.7 release line. Its pure
rule test, registry and full TypeScript gate pass, and the built full candidate
passes its localhost render scan. The same verifier blocks current production
with eleven explicit retired/fabricated claim IDs. Separately, rollback SHA
`d8cc0b869d871763ec8c2c549dd913494aa487b1` was rebuilt from a clean detached
worktree with deterministic install, zero vulnerabilities and 69/69 pages, then
passed the render scan. It is code-qualified but still needs an immutable Vercel
deployment artifact before it can serve as an operational rollback target.

The broad evidence tip `8e64b67fbf5aa5e15befb623877ad1ff71ddf72f`
remains unsuitable for deployment because it is 274 commits ahead of its old
base and includes unrelated product areas. Its reviewed Product artifacts were
therefore reconstructed on the exact clean integration base
`fec94a7f1faae15f0d340249a9243cff9edcebb7`.

The clean v3.7 implementation commit is
`a977a97a4abf2d248c213524beeeb000dc0a0004`, whose exact parent is
`fec94a7f1faae15f0d340249a9243cff9edcebb7`. A later hunk-level review found that
the base still carried old Product Supply runtime files, so deploying only that
line could overwrite the already canary-proven production cutover.

The corrected Product release line is
`codex/product-v37-supply-integrated@e501a1b`.
It changes 93 Product/Product-Supply files (`+20,696/-3,186`) and preserves the
same clean scope: no billing, moderation, social/Facebook/Instagram, Trends or
Pin Crawl files. Eight Product Supply runtime blobs are exactly equal to cutover
tip `5e93e7f`; shared core files retain only stricter v3.7 evidence checks.

The branch also contains independent Web build hardening at `1e6f60a`, the
Product Create Pin persistence fix at `e9263b3`, and release-manifest closures
through `1f1363d`. The build commit makes route-local moderation helpers private and
moves shared Shopify OAuth preparation into a normal server module; it does not
alter either feature's decisions. Each code change is deliberately separate so
it can be reviewed or cherry-picked independently. The whole branch now changes
98 files (`+20,940/-3,266`). It has not been pushed, merged, deployed or applied
to production.

## What the candidate now proves

| Requirement | Candidate evidence | Status |
|---|---|---|
| Stable Product identity | Canonical URL hash, one non-retired identity, history-preserving retirement | PASS |
| Real merchant product | Direct PDP, merchant-page image, non-Pinterest image, page hash and verifier are mandatory | PASS |
| Honest optional name | Missing name stays null; Python, RPC and DB reject an unproven non-null name | PASS |
| Honest finer Product Type | Merchant JSON-LD `Product.category` is the only current automatic source; missing values stay null; Python, RPC and DB reject unproven values | PASS |
| Pinterest Evidence | Product Pin and direct-link Source Pin remain distinct; Primary plus bounded Additional Evidence are persisted | PASS |
| Redirected PDP evidence | Only one or two continuous HTTP redirects with approved status codes and an exact chain hash are accepted | PASS |
| Lifecycle | Active, inactive and retired history remain separate; retired history is never overwritten | PASS |
| Daily observations | One canonical raw observation per unique Pinterest Pin and UTC day; shared Pins are fetched once | PASS |
| Metrics | G30 and current/previous G7 use one Primary Pin, enforce anchor/history rules and fail closed on counter regression | PASS |
| Physical/Digital policy | Separate calibration and release controls | PASS |
| Saved Products | Account-scoped relation, persistent history, Free access enforcement and no copied product truth | PASS |
| Save vs Create Pin | Independent actions and independent analytics; existing Create Pins handoff is reused | PASS |
| Free access | Stable reviewed ranks 1–10; direct URL, API, search and saved-history paths cannot widen access | PASS |
| Truthful UI | Missing title/metrics are omitted; real image, Product/Source Pin label and merchant URL remain distinct | PASS |
| Initial filters | Physical/Digital, Search, Category, Platform, Most Saved and Newest are server-backed | PASS |
| Legacy Product metrics | Product Picker no longer exposes old conclusions; the old `pin_products` detail intelligence API returns HTTP 410 and never reads or serializes retired Product scores | PASS |
| Create Pins Product Ideas truth | Legacy automatic ideas require `detail_fetch_status=available` plus a non-Pinterest merchant image; uploads, URL imports and the user's own library stay independent | PASS |
| Demand/Trend global controls | Implemented but hidden unless one selected family passes its persisted 70% coverage and quality gate, its exact metric version has an approved effective calibration, and the family publication flag is on | PASS — fail-closed and currently hidden |
| Automatic admission | Consumes one fresh complete 100-Pin Product Supply receipt, uses exact IDs, batches at most 20 and writes at most 50; missing legacy family is derived only from a reviewed source bucket and conflicts fail closed | PASS |
| Full active tracking | Candidate tracks every active unique Primary Pin, capped at 2,499 Pins and 5,000 Pinterest requests | PASS locally |

## Data capacity and current truth

- Product Supply inspects 100 Source Pins per scheduled run. It may retain at
  most 50 merchant-proven legacy discovery rows; each atomic write/readback/
  rollback batch remains at most 20.
- Automatic v3.7 admission can consume at most those exact 50 receipt IDs. It
  does not scan broad time windows and does not turn Pin-card fields into
  product truth.
- Product Tracking covers up to 2,499 unique active Primary Pins per daily run,
  with at most 5,000 Pinterest requests including bounded retries. The number
  20 is not a daily tracking limit.
- The latest reviewed production baseline has no live v3.7 Product Opportunity
  catalog and no complete G30 plus current/previous G7 coverage. Demand/Trend
  filters and Fastest Growing therefore must remain hidden.
- The latest GET-only production rerun at `2026-08-27T06:58:54Z` returned 4,115
  legacy products, 34,073 legacy snapshots, 123 broad technical migration
  candidates and 25 reviewed automatic-admission candidates. Relative to the
  `03:42:05Z` audit, snapshots increased by 552 and one new Physical/Home Decor
  candidate entered both the technical and reviewed automatic-admission scopes.
  All 25 reviewed candidates still have zero today/7d/14d/30d/full-metric
  coverage. This proves limited legacy data growth, not launch-ready v3.7 trend
  history. The complete immutable report is
  `backend/docs/product_opportunities_v37_production_audit_20260827T065854.041782Z.json`.
- A second GET-only pre-run baseline at `2026-08-27T10:22:33Z` was identical
  except for its audit timestamp: 4,115 legacy products, 34,073 snapshots, 123
  broad candidates, 25 reviewed automatic-admission candidates, and zero
  today/7d/14d/30d/full-metric coverage across those 25. This establishes a
  stable comparison point before the next permanent Product Supply trigger; it
  does not make the legacy rows user-visible v3.7 entities. Evidence:
  `backend/docs/product_opportunities_v37_production_audit_20260827T102233Z.json`.
- A third GET-only baseline at `2026-08-27T12:10:42Z`, before the permanent
  `23:03:44 Asia/Shanghai` Supply trigger, again produced identical inventory
  and coverage. Of 123 technical candidates, only 25 fit the reviewed automatic
  Admission categories/families (18 Physical / 7 Digital), and all 25 still have
  zero today, G7, G14, G30 and full-metric coverage. The 20-row constant is only
  an atomic write/readback/rollback cap; the candidate Supply run scans 100
  Source Pins and may write at most 50 legacy discovery rows, while v3.7 daily
  tracking is separately bounded at 2,499 unique active Primary Pins. Evidence:
  `backend/docs/product_opportunities_v37_pre_supply_data_quality_20260827T121042Z.json`.
- The `2026-08-27T14:02:31Z` GET-only taxonomy rerun did not change production
  data. It proved that adding the PRD Wedding acquisition source expands the
  reviewed source/family scope from 25 to 39 candidates: 31 Physical and 8
  Digital, including 13 Physical Wedding and 1 Digital Wedding candidate. All
  39 still have zero today/G7/G14/G30/full-metric coverage. This is exactly why
  acquisition category cannot decide Product family. Evidence:
  `backend/docs/product_opportunities_v37_launch_taxonomy_audit_20260827T140231Z.json`.
- A separate service-role GET of the production PostgREST OpenAPI schema at
  `2026-08-27T07:05:21Z` exposed 72 paths, including the legacy control paths
  `/pin_products` and `/pin_save_snapshots`, but zero path matching any v63
  Product Opportunity table or RPC family. Stage 0 therefore finds no deployed
  conflicting v63 API surface. This does not authorize applying the migration;
  the immutable evidence is
  `backend/docs/product_opportunities_v37_schema_presence_audit_20260827T070521Z.json`.
- A public rendered-text audit of `https://vibepin.co/` at
  `2026-08-27T07:11:09Z` found that the currently deployed homepage still shows
  fabricated or retired Product claims including `Opportunity score 94`,
  `+210% Demand vs last 30 days`, `Low Competition`, static inventory counts and
  fake `Live` weekly growth percentages. This is a P0 production Product-truth
  failure, even though the reviewed candidate no longer renders those panels and
  its marketing-truth contract passes. The current production Web deployment is
  therefore not an eligible rollback target. Promotion must be followed by a
  live rendered scan proving the forbidden claims absent. Evidence:
  `backend/docs/product_opportunities_v37_live_web_truth_audit_20260827T071109Z.json`.
- The 2026-08-26 merchant validation found one safe merchant-backed candidate
  among 54 attempts; the other 53 failed because a real merchant product image
  could not be proven. That is an honest supply-quality result, not permission
  to use Pinterest images.
- Current Product Supply rows deliberately omit the legacy `product_type` family
  field. Automatic admission maps only reviewed source buckets: `fashion`,
  `womens-fashion`, and `home-decor` to Physical, and `digital-products` to
  Digital. A declared family that conflicts with the source bucket is rejected.
  This broad family mapping never invents the finer merchant Product Type.
- Production's currently reviewed 100-Pin Product Supply receipt is still the
  Physical-only 36/28/36 mix. A local candidate now reallocates the same 100-Pin
  budget to 29 Fashion / 22 Women's Fashion / 29 Home Decor / 20 Digital
  Products, keeps the 50-per-run and 20-per-atomic-batch caps, and explicitly
  opts in only `digital-products` while Beauty remains excluded. Admission uses
  the same exact receipt mix. Production read-only inventory proves 4,724 recent
  Digital Source Pins with images and seed keywords. They are 4,724 distinct Pin
  IDs, all carry a real source keyword, and their save-count median is 300 (p90
  1,944). This proves source inventory, not merchant-product quality.
- A separate read-only audit of the legacy Digital product pool found 257 active
  rows and no active duplicate source URLs, but only 20 rows have an `available`
  merchant-page result, only 14 carry a non-Pinterest merchant image, and none
  were created in the last 30 days. All 257 have an external URL and source
  keyword, which is useful discovery evidence but is not enough for v3.7
  admission. Do not bulk-admit this legacy pool or claim a complete Digital
  launch until the exact 29/22/29/20 mix has passed a zero-write dry-run and
  exact-ID canary through the current merchant-evidence gate.
- A production read-only source-selection rehearsal then applied the real
  already-scraped exclusion set (492 Source Pin IDs) without opening Pinterest.
  It selected exactly 100 unique Pins at 29/22/29/20, with 100/100 source
  keywords and images and zero category shortfall. Digital had 303 candidates
  before exclusion and 297 after exclusion, so its 20-Pin quota did not depend
  on re-admitting a spent Pin; `repeatScrapeFallbackUsed=false`. This closes
  source-selection capacity only. It does not replace merchant-page dry-run or
  canary evidence.
- A read-only audit of the separate Create Pins Product Ideas compatibility pool
  found 3,198 otherwise eligible image-bearing legacy rows: 3,074 (96.12%) used
  `i.pinimg.com`, 123 used a non-Pinterest host, and only 24 of those 123 also had
  an `available` merchant-page result. The local candidate therefore fails
  closed on both conditions and intentionally reduces that automatic picker feed
  to the merchant-proven subset. It does not affect uploads, URL imports, or the
  user's own product library, and it does not treat a Pinterest Pin image as a
  product image merely to preserve inventory volume.

## Verification completed from the clean release candidate

- Full integrated backend suite collected 648 pytest items plus 38 subtests and
  exited 0. The first launch hit a Windows pytest capture cleanup error before
  collecting any test; the authoritative rerun disabled capture and completed.
- Product Supply plus v3.7 cross-suite: 368 passed plus 38 subtests.
- The Digital launch-mix focused suite passes 73/73. The broader Product Supply
  and Product Opportunity selection collected 294 tests and exited 0 with pytest
  capture disabled; the first launch hit the known Windows capture cleanup error
  before collection and is not counted as test evidence.
- The legacy-metric and Create Pins image-truth follow-ups pass the v3.7 UI
  contract, 24/24 Product Ideas tests, 9/9 release-manifest tests, dedicated and
  full TypeScript. A detached clean worktree at exact commit `18ad8c7` installed
  lockfile dependencies with `npm ci`; its production Next build compiled and
  generated all 73 pages. Two earlier build attempts from the integration
  worktree were rejected before source compilation because its `node_modules`
  junction crossed filesystem roots; they are infrastructure failures and are
  not counted as build evidence.
- The Product Card and detail modal now follow the PRD's evidence-first order:
  Pinterest evidence precedes the merchant Product Source, while Save and
  Create Pin remain separate actions. The contract includes explicit ordering
  assertions. At exact commit `24b19a7`, the Product-specific typecheck and
  contract passed, and a detached clean production build compiled TypeScript
  and generated all 73 pages.
- A clean-line regression scan then found that the older public landing and
  admin data surfaces still carried the previously fixed scraped-name fallback.
  Commit `41b8e17` faithfully reapplies the isolated four-file honesty change:
  landing tiles leave an unknown name empty, the admin console shows the
  explicit non-name message `Name not provided`, and neither promotes a source
  keyword into the product-name position. The 9-case honesty suite, registry,
  v3.7 UI contract, Product typecheck, diff check and exact-commit production
  build all pass; all 73 pages were generated.
- The same public landing still rendered static `Opportunity score`, commercial
  competition, fake `Live` weekly percentages and unproven inventory counts.
  Commit `4e091cf` removes those rendered panels rather than relabeling invented
  numbers. The hero now demonstrates the existing Product-to-Create-Pins flow;
  the execution, supported-niche, Pricing, FAQ and footer sections remain. The
  legacy score no longer crosses the landing Product API mapper. A dedicated
  marketing-truth contract, the 9-case name suite, registry, v3.7 contract and
  Product typecheck pass. An exact-commit production build generated 73/73 pages;
  local visual QA at 1268px found the required sections and zero rendered legacy
  score, competition or fake-Live text.
- Product Opportunity UI contract: passed.
- Product Ideas/Picker tests: 25 passed. Product Opportunity counts/legacy-output
  boundary: 8 passed. Access, metric-control and v3.7 UI contracts all passed.
- The Product Ideas API and its direct Supabase fallback no longer coerce an
  unknown Product-Pin or Source-Pin save count to zero. A genuine measured zero
  remains zero; when both measurements are absent the Create Pins picker omits
  the evidence line. Commit `e501a1b` adds the regression contract and the
  Product-only TypeScript check passes.
- The Product Opportunity `Create Pin` action now uses the existing authenticated
  composer-draft handoff instead of relying only on one-time session storage.
  The same URL carries both the persisted draft id and an immediate one-shot
  prefill key; after that key is consumed, refresh recovery uses the server
  draft. `draftToPrefill` now accepts the API's real `{ draft: {...} }` response
  envelope. Commit `e9263b3` passes the 22-case prefill suite, v3.7 contract,
  8-case compatibility suite, dedicated and full TypeScript, and the 73-page
  production build. It never calls the Saved Products API.
- Create Pin success is now emitted only after a usable handoff exists. When the
  durable composer draft succeeds but session storage is unavailable, navigation
  uses the durable draft alone. When both persistence paths fail, navigation is
  refused and the user receives a retryable error instead of an empty Studio.
  The two storage-failure branches pass in the 25-case prefill suite; full
  TypeScript and the 73-page production build also pass.
  The strict storage failure is scoped to this reviewed Product Opportunity
  handoff; legacy Workspace/Trends/Plan/Discover callers retain their existing
  shared-helper behavior rather than receiving a new unhandled exception.
- The catalog no longer treats a failed Saved Products read as an empty saved
  set. Commit `0cd9539` keeps the existing state unknown, pauses only Save/Remove
  mutations, gives the user a retry action, and leaves Create Pin independent.
  This prevents a transient API failure from painting previously saved records
  as unsaved. The v3.7 UI contract, full TypeScript check and 73-page production
  build pass.
- The final focused regression from the committed candidate passed 214 backend
  Product Supply/Opportunity tests with only the two credential-gated live
  PostgREST cases skipped, plus all 11 Product Web scripts: Create Pin prefill
  22/22, legacy tier compatibility 6/6, v3.7, metric controls, access and
  marketing contracts, compatibility 8/8, admin 7/7, name honesty 9/9, link
  display 11/11 and Product Ideas 25/25.
- Web registry contains 122 tracked scripts: 121 runnable and one documented
  exclusion. Three unrelated failures (Pinterest OAuth, Published Pin summary,
  and usage metering) were reproduced unchanged on clean base `fec94a7`; the one
  candidate-caused stale legacy test was rewritten for v3.7 and passes 8/8.
- Dedicated and full-repository TypeScript checks passed.
- The saved-history surface no longer promotes a merchant/domain fallback into
  the product-title position when Product Name is null. Its compatibility test
  passes 8/8 and the full TypeScript check passes.
- The remaining admin Product strip now uses the ordinary non-name message
  `Name not provided`; it no longer exposes `unavailable` wording. Commit
  `e3a1cc2` passes the 9-case name-honesty suite, v3.7 UI contract and full
  TypeScript check.
- An unnamed Product Opportunity no longer turns the generic phrase
  `the product` into a quoted pseudo-name inside the Create Pins prompt. Commit
  `31b421a` says `the selected product` without claiming a name; the real name
  path is unchanged. The prefill suite passes 23/23 and full TypeScript passes.
- The stable Product Opportunity handoff no longer reuses the legacy Product
  Signal adapter after `4442a1c`. That adapter promoted a reviewed source bucket
  such as `womens-fashion` into an opportunity title and keyword, which could
  expose an internal slug in Studio and falsely treat a category as a creative
  topic. The dedicated builder now carries only the exact merchant image, PDP,
  optional proven Product Name/domain and a natural category label. A missing
  name stays absent; no opportunity title/keyword is synthesized. The 25-case
  prefill suite, v3.7 contract, full TypeScript and exact 73/73-page production
  build pass.
- A fresh production Web build exposed two pre-existing Next route-contract
  violations outside Product: exported helper functions in `/api/generate` and
  a Shopify launch route importing a helper from another `route.ts`. Commit
  `1e6f60a` keeps the generation helpers private and moves the unchanged Shopify
  helper to `lib/server/shopify/connectPrep.ts`. Full TypeScript, the 13-case
  generation moderation gate and 40 Shopify OAuth/entitlement/HMAC cases pass.
  The production Web build then passed and generated all 73 pages. Existing
  metadata warnings remain unrelated.
- The rollout manifest now binds the composer-draft routes, Studio consumer,
  browser token helper and prefill builder together, and also includes the root
  landing, landing mapper, admin strip and `supabase.ts` metric type that earlier
  truth fixes changed. A changed-production-file reverse scan then found and
  added the bounded `t2_harvest.py` recovery tool plus the separate four-file
  route-module build unit. Commit `6be900d` additionally locks the v63 SQL,
  rollback, server/API, Product pages, Saved Products and Create Pin builder as
  one catalog-truth release unit; category search, rendered labels and Studio
  handoff labels cannot be partially selected without failing the contract.
  The automation contract passes 15/15. A fresh reverse scan of `fec94a7..HEAD`
  finds 98 changed files, of which 61 are production/release artifacts; all
  61/61 are represented in the manifest and zero are missing,
  preventing a
  partial cherry-pick from silently restoring session-only Create Pin recovery,
  fabricated names, retired marketing metrics, or unknown-save zero coercion.
- Complete v63 migration and schema rollback were rerun against this exact clean
  candidate in local PGlite with `pgcrypto`; three independent harnesses passed:
  lifecycle/streak/retired-current coexistence, provenance and redirect rejection
  plus object-clean rollback, and transactional admission plus metric controls.
- The current lifecycle guard was then exercised as real SQL in a fourth isolated
  PGlite transaction: `discovered -> active`, `active -> inactive`,
  `inactive -> active` and `active -> retired` succeeded with their timestamps;
  `active -> discovered`, `retired -> active`, and retired Evidence reactivation
  were rejected by the database trigger. The transaction was rolled back after
  the assertions, leaving no persisted test data.
- A follow-up exact migration-to-rollback run caught and fixed two lifecycle
  functions that the schema rollback did not yet remove. After `b422e92`, a
  catalog scan found zero remaining v63 relations and zero remaining v63
  functions after rollback, including both lifecycle guards.
- Direct INSERT was separately guarded after the update-state audit: every new
  Product Opportunity must enter as `discovered` with no lifecycle timestamps.
  Real PGlite transactions rejected direct `active` insertion and predated
  discovery timestamps, accepted a clean discovered row, and the revised schema
  still rolled back to zero v63 relations/functions.
- Saved Products now has a database-owned, idempotent state machine. A real
  PGlite migration transaction proved that forged client timestamps are
  normalized, a repeated Save preserves the first `saved_at`, a repeated Remove
  preserves the first `removed_at`, and a Save after removal starts a new saved
  interval while clearing `removed_at`. State/time CHECK constraints reject
  contradictory or out-of-order rows, and the exact schema rollback again left
  zero v63 relations/functions. This is local candidate evidence only; v63 is
  not deployed.
- A follow-up authorization audit found that the initial migration granted
  direct Saved Products INSERT/UPDATE privileges to `authenticated`. That would
  let a client bypass the Product API's plan check and create a relation to an
  arbitrary known Product Opportunity ID. Commit `8b61030` makes Saved Products
  mutations server-only while retaining RLS-scoped reads. Exact PGlite privilege
  checks returned authenticated SELECT=true, INSERT=false, UPDATE=false and
  service-role SELECT/INSERT/UPDATE=true. The Product Opportunity regression
  suite passed 163/163 and the exact committed-tip backend suite passed 806
  cases with zero failures/errors and two live-credential skips.
- The database identity audit then found that application admission normalized
  Product and Evidence URLs to one identity, but privileged direct writes could
  still pair a Product Opportunity with a different public `View Product` URL.
  Commit `9d0cc1b` binds canonical, external and Evidence URLs at the database
  layer. Exact PGlite transactions rejected mismatched Product URLs, rejected
  mismatched Evidence, accepted and activated a valid identity, and rejected an
  in-place URL substitution on an active Product. A different real product must
  use a new stable entity instead of rewriting history. The focused suite passed
  163/163 and the exact committed-tip backend suite passed 806 cases with zero
  failures/errors and two live-credential skips.
- The final stable-identity check found that the original schema validated only
  the shape of `canonical_url_hash`, not its derivation. Commit `38f6b1a`
  requires the stored value to equal the database-computed SHA-256 of the exact
  canonical URL. PGlite rejected a forged 64-character hash and accepted the
  exact digest. The focused suite passed 163/163; the exact committed-tip
  backend suite passed 806 cases with zero failures/errors and two
  live-credential skips.
- Merchant-name truth was not yet equivalent to Product Name truth: it was
  rendered to users but the admission validator accepted the candidate field
  without an exact merchant-page proof. Commit `91a1dea` makes merchant optional
  and fail-closed across the refetch manifest, Python validator, admission RPC
  and database CHECK. JSON-LD brand or `og:site_name` can supply an explicit
  `merchant:` field proof; otherwise the stored merchant is NULL and the real
  PDP domain remains the Platform label. PGlite rejected an unproven merchant,
  accepted NULL and accepted an exactly proven merchant. Focused regression
  passed 166/166; the exact backend suite passed 809 cases with zero
  failures/errors and two live-credential skips.
- Platform fallback truth is also database-owned after `683eb33`: `domain` is
  required to equal the lowercase hostname parsed from the canonical PDP URL,
  while a URL port is not presented as part of the Platform. PGlite rejected a
  missing domain and a forged trusted-looking domain, and accepted the exact PDP
  hostname. Focused regression passed 166/166; the exact backend suite passed
  809 cases with zero failures/errors and two live-credential skips.
- Category truth is database-owned after `bab1c5f`: only the reviewed launch
  buckets `fashion`, `womens-fashion`, `home-decor` and `digital-products` are
  admissible, and each must match its Physical/Digital family. Python and the
  manifest now share one mapping; the admission RPC and table CHECK independently
  fail closed. An exact PGlite transaction rejected missing, unknown and
  family-mismatched categories and accepted one matching Digital row. The UI
  keeps stable slugs only as query values and renders natural category labels.
  Focused backend checks passed 86/86, the UI contract and TypeScript passed,
  the exact backend suite passed 814 cases with zero failures/errors and two
  live-credential skips, and the production Web build generated all 73 pages.
- Merchant verification freshness is database-owned after `bda1eba`. The RPC
  rejects missing, older-than-24-hour and more-than-five-minutes-future merchant
  verification timestamps before insertion. Activation and direct updates of an
  Active row independently enforce the same window, while an already Active row
  is not retired merely because time passes. An exact PGlite run rejected stale
  and future RPC candidates, activated a current candidate, and rejected a direct
  future-timestamp update. Focused checks passed 88/88 and the exact backend
  suite passed 816 cases with zero failures/errors and two live-credential skips.
- Public URL safety is database-owned after `2bf0fa9`. Product PDPs, redirect
  provenance and merchant images reject URL credentials, localhost/internal
  names, loopback, link-local, private, shared-address and other non-public
  literal IP ranges. The manifest and admission validator share one literal-host
  authority; the database independently enforces the Product and image fields.
  Exact PGlite direct writes rejected loopback/private/internal and credentialed
  examples, accepted public merchant/CDN domains and public IPs, and the exact
  rollback left zero helper functions. Focused checks passed 96/96 and the exact
  backend suite passed 824 cases with zero failures/errors and two credential skips.
- Observation capture time is database-owned after `9809ab6`, and direct-write
  bypass is closed after `588494d`. The canonical UTC day must match the
  captured timestamp; observations older than 24 hours, more than five minutes
  in the future, or more than five minutes before their Evidence was created are
  rejected by both the reviewed RPC and a table trigger. The service role has
  SELECT only on raw snapshots and must use the security-definer RPC for writes;
  a migration rerun explicitly revokes older direct INSERT/UPDATE grants. An
  exact PGlite transaction rejected four RPC time attacks, four database-owner
  direct-table attacks and one service-role direct write, then wrote one current
  observation through the RPC. Rollback left zero snapshot/RPC/trigger-function
  objects. The migration contract passed 24/24 and the exact backend suite
  passed 824 cases with zero failures/errors and two live-credential skips.
- Optional user-facing labels are bounded without fabrication after `0680e68`.
  Product Name remains optional up to 500 characters, merchant up to 200 and
  finer Product Type up to 160. The manifest omits an overlong merchant value
  rather than truncating it into a different claim; the product may still qualify
  through its real PDP, merchant image and Pinterest Evidence. The admission
  validator and database independently reject blank, untrimmed or overlong
  direct values. Exact-limit values passed in Python and PGlite, all four invalid
  direct-write shapes were rejected by the named database constraint, focused
  regression passed 140/140, and the committed full-suite JUnit receipt contains
  832 cases, zero failures/errors and two live-credential skips.
- Saved Products client responses no longer transport internal access-state
  enums after `f656081`. A Free saved record outside the curated ten continues
  to expose only its relation ID and saved time—never Product URL, image,
  Pinterest Evidence or metrics—and now carries the user-intent boolean
  `requiresUpgrade`. Paid historical access remains unchanged. The UI contract,
  access tests, full TypeScript and the production Web build with 73/73 pages pass.
- Catalog search and empty-state truthfulness are closed after `f188f36`.
  Search text now carries user-facing aliases for Fashion, Women's Fashion
  (including the apostrophe-free spelling), Home Decor and Digital Products,
  while the stored category identity remains unchanged. A zero-row catalog says
  that qualified products appear after discovery and review; it no longer claims
  that trend tracking discovers products. Missing-name image/modal accessibility
  labels describe product details from the merchant/domain and never synthesize
  a product title. The migration contract passes 25/25, the dedicated UI
  contract passes, TypeScript passes, and the exact production Web build
  generated 73/73 pages.
- Filtered zero-results are separated from real emptiness after `0abffd0`.
  Catalog search/category/platform/family filters now say that no products match
  the filters and provide one clear reset. Saved Products with records in another
  family no longer says that the user has never saved anything; it names the
  product-type mismatch and offers All products. The dedicated UI contract,
  TypeScript and the exact production Web build with 73/73 pages pass.
- Valid direct and bounded-redirect Evidence admitted successfully.
- Direct database attempts to add an unproven Product Name or Product Type, omit
  merchant URL/image provenance, omit Pinterest/Source Pin identity, or omit a
  redirect-chain hash were rejected fail-closed; a merchant-proven Product Type
  survived the catalog view.
- Python compile, candidate contamination scan and `git diff --check`: passed.
- Committed LF blobs for the shared shell library and Product Supply, Admission
  and Tracking wrappers passed ShellCheck. The two source-using wrappers were
  checked with SC1091 excluded only because stdin has no path; their separately
  checked `cloud_lib.sh` blob passed with no exclusion.

## Product Supply cutover status

- The separately authorized production cutover is complete: 100 Source Pins are
  scanned per run, at most 50 merchant-proven rows may be retained per run, and
  every atomic write/readback/rollback batch remains capped at 20.
- Production dry-run, merchant validation and the exact one-row canary passed.
  The existing 23:00 Asia/Shanghai Product Supply timer was restored enabled and
  active. No other timer was enabled.
- The first true timer-originated attempt fired from the permanent timer at
  2026-08-26 23:14:21 Asia/Shanghai. It failed closed before worker launch or a
  new database write: the 21:43:03 canary activity left only 91.43 minutes before
  this trigger, below the mandatory 120-minute Pinterest cooldown. The service
  exited 10, both locks were free and no Product Supply process remained.
- The local cutover helper now refuses `enable` before any systemd mutation when
  the timer's next calendar base would violate the measured cooldown. It forces
  UTC while reading systemd time because `CST` is ambiguous between China and
  North America. The regression suite passes 51 tests with one platform skip;
  a VPS read-only check projects 1516.94 minutes before the next calendar base.
- Scheduled receipt verification no longer inherits the one-row canary ceiling
  after `b3d9c10`. The new mutually exclusive scheduled contract requires the
  currently deployed Physical-only 100-Pin 36/28/36 mix, a 50-row run cap,
  atomic cap at most 20, exact inserted-ID/readback accounting, zero failed
  rows/batches/render failures, a trusted authenticated run, and safe
  per-batch red-line/rollback receipts. It accepts a truthful natural zero and
  rejects 51 writes. Canary verification remains exactly one row. The focused
  original scheduled-contract cutover suite passed 35/35 and Python compilation.
- A read-only rehearsal against the trusted one-row report found 32 response
  parse errors alongside 4,569 successfully parsed product JSON responses, zero
  render failures and 16 Pins with no product JSON. The bounded samples were
  Playwright response-body-release protocol errors and non-JSON decode errors,
  not failed rows. The scheduled audit therefore keeps their count/samples and
  product-response totals visible, validates that accounting, and does not
  misclassify a measured parse diagnostic as a render or red-line failure.
  After this correction, the cutover suite passes 42/42 and the combined cutover
  plus automation-contract suite passes 57/57.
- Latest candidate `fb32d58` also completed the whole `backend/tests` suite with
  exit 0 under pytest's no-capture mode. The default Python 3.14 capture mode
  failed before collection with a closed pseudo-stream, so it is recorded as an
  environment-runner defect rather than misreported as a test result. The
  no-capture run completed normally and left the isolated worktree clean.
- A production GET-only inventory before the next automatic Supply run initially
  found 4,115 legacy rows, 33,521 legacy snapshots and 122 minimum-gate migration
  candidates (111 Physical, 11 Digital). The later `2026-08-27T06:58:54Z`
  rerun found 34,073 snapshots and 123 candidates (112 Physical, 11 Digital):
  111 still have zero observation days and 12 have only 1–9. Thirty-day anchor
  coverage and complete G30/current-G7/previous-G7 coverage remain zero. Digital
  has zero today, 7d, 14d, 30d and full-metric coverage. Commit `14e955a` makes every audited zero and
  both family rows explicit so a missing JSON key cannot be mistaken for an
  unmeasured or passing result; its focused suite passes 5/5.
- Receipt review found two further fail-open audit edges. A zero-write top-level
  report could previously bypass a false batch-receipt reconciliation result,
  and image readback only searched for the literal `pinimg.com`. Commit
  `a8079b4` now requires safe batch receipts even for natural zero, rejects the
  complete parsed `pinimg.*`/`pinterest.*` host families throughout the shared
  core and remote audit, and does not false-reject a merchant path containing
  those words. Focused shared-core/red-line/cutover/automation tests pass 111/111.
  A real GET-only audit against the current VPS report executed successfully
  without deploying the new core and still proved the one canary row safe.
- Commit `66a2d6a` closes the remaining receipt-accounting gap. The audit now
  validates every atomic receipt structurally: successful receipts must carry
  exact expected/actual ID readback, matching row counts, red-line success,
  created-at bounds and rollback evidence; zero-ID receipts must carry none of
  those write-only artifacts. Receipt count and receipt-ID count are explicit
  and the combined receipt IDs must equal the top-level inserted IDs. Focused
  cutover/automation tests pass 68/68 and the wider shared-core/red-line group
  passes 115/115. A real GET-only replay of the current VPS report passed with
  eight receipts, one exact inserted/read-back ID, and seven honest zero-write
  receipts; no service or database write was performed.
- The timer remains enabled and active. Its next actual randomized trigger is
  2026-08-27 23:03:44 Asia/Shanghai. That run still requires a complete receipt,
  exact inserted-ID readback, lock and orphan-process audit.
- That next production run still uses the already deployed Physical-only
  36/28/36 mix. The local 29/22/29/20 Digital candidate is not deployed and must
  receive its own dry-run/canary before it can replace production or feed v3.7
  Admission.
- Commit `b4403b9` makes that distinction explicit in the release runbook and
  locks it in the automation contract: the currently deployed 36/28/36
  Physical-only mix and the local, unauthorized 29/22/29/20 Digital candidate
  are not interchangeable deployment values. The Supply/runbook suites pass
  34/34.
- Commit `307cee3` closes the same contract in the PRD itself: automatic v3.7
  Admission requires the reviewed 29/22/29/20 Digital launch receipt, while the
  currently deployed 36/28/36 Physical-only receipt is explicitly ineligible.
  Admission/Supply/PRD contract tests pass 55/55.
- This cutover does not make v63, the Product Opportunities Web/API, automatic
  admission, or Product Tracking live.

## Production conditions still open

The latest read-only pre-trigger check found the permanent Supply timer enabled
and active with its next trigger at `2026-08-27T15:03:44Z`. The previous timer
run exited 10 before any write because only 91.43 of the required 120 cooldown
minutes had elapsed; its journal proves the intended fail-closed behavior. At
`10:35:49Z` the current cooldown was 328.52 minutes and projects to 596.38
minutes at tonight's trigger. Both real VPS locks were free, no matching process
was alive, the service itself was disabled as a boot target, and neither v3.7
admission nor tracking timer was installed. This makes tonight's scheduled run
ready to attempt; it is not evidence that the future run will pass. Immutable
evidence: `backend/docs/product_supply_pretrigger_readiness_20260827T103549Z.json`.

1. Verify the next Product Supply timer-originated run from its exact receipt;
   do not start a duplicate manual run while it is active or pending.
2. Obtain separate production authorization for the clean release candidate.
   Do not merge or deploy the 274-commit evidence branch wholesale, deploy from
   a dirty master, or combine unrelated incomplete work.
3. Back up and apply v63 with Product Opportunity timers and metric publication
   flags disabled; run the production schema/constraint audit.
4. Admit one reviewed Product Opportunity canary, prove exact Product and
   Evidence readback, then rehearse exact-ID history-preserving rollback.
5. Deploy the tracking service disabled; run preflight, dry-run and one bounded
   real tracking canary with lock, timeout, tree-kill and orphan evidence.
6. Deploy Web/API with Physical and Digital metric publication flags disabled.
   Verify the real catalog, Free ten, paid access, Saved Products and Create Pin.
7. Enable the admission and tracking timers only in the reviewed sequence and
   verify the first timer-originated runs. Product Supply, admission and tracking
   must keep both 120-minute Pinterest cooldowns.
8. Keep Demand/Trend global filters and growth sorting hidden until the matching
   family has at least 70% valid G30+G7 coverage, the persisted quality review is
   explicitly approved, and the exact family/version calibration is approved and
   already effective. Verify Physical and Digital separately.

Until those production conditions are complete, the accurate launch statement
is: **the integrated v3.7 plus safe Product Supply release line is locally
qualified and independently reproducible, Product Supply has completed its safe
cutover and proved fail-closed timer triggering but still awaits its first
successful timer-originated receipt, and the new Product
Opportunity v63/Web/admission/tracking data product is not yet live.**

The deployable-line reconstruction is now `27d4f02` on
`codex/product-v37-master-reintegrate`, whose parent is exactly the current local
`master@d3877a7`. The former evidence branch and master had 181/59 independent
commits and only 2 of 65 listed release artifacts were byte-identical, so the old
branch was not merged. Instead, the exact 98-file `fec94a7..ad43e98` Product
artifact delta was represented as one synthetic three-way patch and applied to
master. Seven Web conflicts were resolved by preserving both master behavior and
the v3.7 truth boundary: master per-field moderation and canonical plan config
remain, route-only helper exports moved to
`web/src/lib/server/generationModeration.ts`, Product access uses the canonical
server plan table, and retired Product scores/internal unavailable wording stay
removed. The new commit changes 99 files; all 61 changed production/release
files are present in the 66-entry release manifest, all manifest paths exist,
and the additional five entries are unchanged dependencies that must ship from
the same commit.

Verification on the clean reconstructed tree: full backend 827 passed, 2
live-only skipped, 77 subtests; conflict-related backend contracts 177/177;
generation moderation 105/105 after freezing its test clock inside one fixed
rate-limit window; canonical plan entitlements 12/12; Product Name honesty 9/9;
Product marketing, access, metric-control and v3.7 UI contracts passed; test
registry passed with 140 tracked scripts; full TypeScript passed. The exact
production Web build compiled, typechecked and generated 70/70 static pages,
including both Product Opportunity routes. Only the existing workspace-root,
NFT trace and metadataBase warnings remain. The candidate has not been pushed,
merged, deployed, or used for any production database/timer change.

The remote lineage was then refreshed rather than inferred from a stale tracking
ref. Local `master@d3877a7` was 3 commits ahead of and 25 commits behind
`origin/master@b22930e`; therefore `f3221f1` was locally clean but not directly
pushable. Merge commit `691b13f` combines both explicit parents with zero content
conflicts, and `origin/master` is now an ancestor of the candidate. The remote
merge changed no backend file, so the exact 827/2/77 backend result remains
applicable. Product Name, marketing truth, plan access, metric controls and v3.7
UI contracts passed again; the canonical entitlement suite passed 12/12, the
140-script registry passed, full TypeScript passed, and a second production Web
build compiled and generated 70/70 static pages. This closes local and remote
lineage simultaneously without rewriting local master or pushing any branch.

The resulting release boundary is frozen in historical manifest
`product_opportunities_v37_release_manifest_7d6601b.json`, archived at evidence
commit `2763cce`. It names
candidate `7d6601b51dc698f0d07de837f3582b3e39dcb5bf`, both reviewed bases and the
functional integration commit, and records the Git blob SHA-1, exact-byte SHA-256
and byte count for all 66 release artifacts. A clean-tree verifier parsed the
JSON, proved `artifactCount=66`, found no duplicate path, matched the exact
ordered runbook list, and recomputed every blob/hash/size directly from the named
Git commit with zero missing paths or mismatches. This manifest is release
evidence only: it does not authorize a push, deployment, database migration,
feature flag or timer change.

A subsequent PRD-by-PRD failure-propagation audit found one remaining local
Tracking gap: a due batch in which every final Pin result was 429, 5xx, timeout,
network failure or ambiguous provider payload could previously return exit zero
with zero observations. Tracking now counts final health at the unique-Pin level,
keeps partially successful batches as explicit degraded runs, and fails a
non-empty all-provider-failure batch before any snapshot or metric write while
retaining its diagnostics in the failed pipeline-run record. The focused
Tracking/automation suite passes 60/60 and the full backend suite passes 832
with 2 live-credential skips and 77 subtests. This change is local only and must
be included in a newly hashed candidate before any Tracking deployment.

That refreshed boundary is recorded in historical manifest
`product_opportunities_v37_release_manifest_12dc5fa.json`, archived at evidence
commit `2763cce`, whose
candidate and Tracking-hardening commit are both
`12dc5fa0abb6ca1a4414953adeb2f85e0b188164`. The previous `7d6601b` manifest is
retained as immutable evidence for its earlier candidate; it is not the deploy
manifest for the hardened Tracking candidate.

The same reverse audit found that the application required a replacement Primary
Pin to have a valid observation on the current UTC day, but the privileged switch
RPC had enforced only the old Primary's three-day not-found streak. The v63
transaction now independently requires a canonical current-day `valid` snapshot
for the replacement Pinterest Pin before changing either Evidence row. A direct
RPC call can no longer bypass the fetch proof. Migration/Tracking/automation
contracts pass 85/85 and the full backend suite remains 832 passed, 2 skipped,
77 subtests. Production v63 remains unapplied.

The historical functional deploy boundary was `99f3cb1`, frozen as 66 exact
artifacts in `product_opportunities_v37_release_manifest_99f3cb1.json`, archived
at evidence commit `2763cce`. The
manifest records both hardening commits and supersedes the earlier candidates
for any future v63/Tracking deployment review; the earlier manifests remain
historical evidence only.

Admission reverse review then found two host-boundary inconsistencies. The
database active-image check covered `pinimg.com` but not the full `pinimg.*`
family already rejected by Python, and the positive Pinterest Evidence host
test could accept a brand-token lookalike such as
`pinterest.com.evil.example`. The candidate now rejects the full Pinimg family,
accepts only canonical `pinterest.com` Evidence hosts, and requires the numeric
Pin id in the URL path to equal the persisted `pinterest_pin_id` at both Python
and database boundaries. Focused admission/manifest/migration contracts pass
106/106. No production data or schema was touched.

The historical functional candidate was `5be5fde`, frozen as 66 exact artifacts
in `product_opportunities_v37_release_manifest_5be5fde.json`, archived at
evidence commit `2763cce`. Full
backend regression after all three reverse-audit hardenings is 834 passed, 2
live-credential skips and 77 subtests. This manifest supersedes `99f3cb1` for a
future v63/Admission/Tracking deploy review.

A public-surface reverse audit then found that the rendered landing page and FAQ
still described Product Opportunities using unproven demand outcomes and the
retired competition/opportunity-score model. Functional candidate `8c2ad12`
replaces those claims with the actual boundary: a real merchant product page,
real product image and auditable Pinterest Evidence; recent Demand or Momentum
is described as conditional on enough valid save history. The FAQ explicitly
states that Product Opportunities do not use a competition badge or Opportunity
Score. The dedicated marketing-truth and public-compliance contracts passed,
the full 92-script Web core suite passed, TypeScript passed, the release-manifest
contract passed 15/15, and the production build compiled and generated 70/70
static pages. The historical 68-artifact boundary is frozen in
`product_opportunities_v37_release_manifest_8c2ad12.json`, archived at evidence
commit `2763cce`; direct
Git-object verification found zero order, duplicate, missing, blob, SHA-256 or
byte-count mismatch. This remains local evidence only and does not authorize a
push, deployment, database migration, feature flag or timer change.

A fresh read-only production inventory audit then separated the broad technical
migration gate from the currently reviewed automatic-Admission contract. The
legacy dataset contains 122 unique rows that pass the minimum URL, image-host,
Pin-id and product-family checks, but only 24 also match the four category-family
pairs currently implemented by automatic Admission: 17 Physical and 7 Digital,
split across Fashion 6, Women's Fashion 2, Home Decor 9 and Digital Products 7.
Of the other technical candidates, 91 use source categories that automatic
Admission has not reviewed and 7 have a category-family mismatch. The scoped 24
have zero current-day, 7-day, 14-day or 30-day anchors and zero full metrics, so
they cannot support a Product Demand/Trend launch claim.

Functional candidate `61a6080` makes this distinction explicit in the audit
output and adds a regression test proving unreviewed categories cannot inflate
the automatic-admission inventory. Focused audit and Admission/automation tests
passed 6/6 and 61/61; the full backend suite passed 835 with 2 live-credential
skips and 77 subtests. Its historical 68-artifact boundary is frozen in
`product_opportunities_v37_release_manifest_61a6080.json`, archived at evidence
commit `2763cce`; direct
Git-object verification found zero order, duplicate, missing, blob, SHA-256 or
byte-count mismatch. This audit correction changes no production data, runtime
budget, category allocation, service or timer.

The category-readiness audit was then expanded beyond aggregate exclusions.
Functional candidate `5990df0` records every technical candidate by exact
source-category and Product-family pair, plus exclusions by category and reason.
A fresh production GET-only run found Wedding 13 Physical / 1 Digital and
Digital Products 7 Digital / 7 Physical; it found no independent Gifts or
Jewelry/Accessories source bucket. This proves the current one-source-category
to-one-family rule is a reviewed allowlist for four pairs, not a general product
classifier. The PRD now explicitly keeps acquisition provenance separate from
user-facing business taxonomy and forbids deriving Wedding, Gifts or Jewelry
from Pin text or seed keywords. Focused category/admission/automation tests pass
67/67 and the full backend suite passes 835 with 2 skips and 77 subtests. No
production category allocation, source budget, data, service or timer changed.

A separate GET-only source-pool query covered the latest 720 hours and excluded
492 Source Pins already represented in `pin_products`. At least 100 unspent Pins
were selectable in each of Fashion, Women's Fashion, Home Decor, Digital
Products and Wedding; their measured available pools were 793, 552, 1,011,
1,458 and 565. Independent Gifts and Jewelry/Accessories source buckets each
contained zero. The next bounded dry-run proposal is therefore 23/18/24/15/20,
respectively, still exactly 100 total. This is planning evidence only: the
deployed 36/28/36 schedule and the local 29/22/29/20 candidate were not changed.
Gifts and Jewelry/Accessories remain evidence-backed merchant subtypes until a
real source bucket and a separately reviewed allocation exist; the UI must not
claim those filters are populated merely because the PRD names them.

Functional candidate `6eff0e4` closes the first taxonomy/provenance boundary
without choosing a user-facing single- versus multi-category model. Manifest
generation now stores the reviewed acquisition `source_category` independently
inside provenance; Python admission, the privileged database RPC and the table
constraint all reject a missing, unknown or Product-family-mismatched source
before a write. A Physical Product may keep a Fashion business category while
proving it was acquired from Women's Fashion, so future taxonomy changes cannot
rewrite its discovery history. Product Opportunity tests pass 199/199,
automation contracts 15/15, and the full backend passes 837 with 2 skips and 77
subtests. Production v63 remains unapplied.

The exact `6eff0e4` migration and rollback were then executed against a fresh,
ephemeral PostgreSQL-compatible PGlite instance with `pgcrypto`, never against
Supabase. A candidate missing `provenance.source_category` failed the table
constraint and left zero Product rows; a Digital-Products source paired with a
Physical family failed the privileged RPC and also left zero rows. An exact
Fashion/Physical candidate wrote one Active Product whose persisted provenance
still contained `source_category=fashion`. The complete rollback then removed
the Product table, Evidence table and admission RPC; all three registry checks
returned null. The temporary runtime database was in memory. Its downloaded
test dependency directory remains under the user's Local Temp because the host
policy rejected recursive cleanup; it is outside every Git worktree and contains
no project credentials or production data.

A reverse lifecycle audit then found that family compatibility alone did not
make acquisition provenance immutable: an existing Physical Product could still
change `source_category` from Fashion to Women's Fashion. Functional candidate
`ed28855` closes that gap in the database lifecycle trigger. It rejects any
change to the persisted acquisition source even when both categories belong to
the same Product family, while allowing unrelated provenance fields to receive
normal audit additions. The focused migration suite passed 108/108 and the full
backend suite passed 837 with 2 live-credential skips and 77 subtests.

The exact migration was re-executed against the fresh ephemeral PGlite/PostgreSQL
proof environment. A valid Fashion/Physical Product was admitted; a direct
Fashion-to-Women's-Fashion source rewrite failed with the database exception
`Product Opportunity acquisition source category is immutable`; the persisted
source remained Fashion. A separate update adding an unrelated provenance audit
note succeeded. Complete rollback again removed the Product table. The 68-file
historical release boundary is frozen in
`product_opportunities_v37_release_manifest_ed28855.json`, archived at evidence
commit `2763cce`, and no
production database, deployment, service or timer was changed.

A user-output reverse scan then found one remaining wording ambiguity rather
than a data leak: the Saved Products subtitle told users they could return to
products to “compare, track, or turn into a Pin”. Because all Active Products
are tracked independently of user saves, that wording could imply that Save
starts tracking. Functional commit `3fd6453` now describes Saved Products only
as a shortlist for comparison or Create Pin, and the v3.7 UI contract prevents
the tracking-trigger wording from returning. Full TypeScript and the production
Web build passed with 70/70 pages. The historical 68-file release boundary is
frozen in `product_opportunities_v37_release_manifest_3fd6453.json`, archived at
evidence commit `2763cce`; this
copy correction does not change tracking behavior, production data or timers.
