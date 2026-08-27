# Product Opportunities v3.7 Rollout Runbook

Status: local release candidate only. This document does not authorize a push,
production database write, VPS deployment, timer enablement, or budget increase.

Current release pointer: branch `codex/product-v37-manifest-b229`, exact
production remote base `b22930ebe73847cf35bc44be789414902ae6b599`,
functional tip `351e47912ce44fc34728097041dbfdd95889081a`, and exact
76-artifact Product boundary
`backend/docs/product_opportunities_v37_release_manifest_351e479.json`.
Earlier branch pointers and manifests are chronological evidence only.

This candidate supersedes `99efabc` for deployment topology. That earlier tree
was functionally qualified but sat on a local integration base containing
Usage/Metering production changes not present in the production remote. Because
Vercel promotes a whole tree, its exact Product manifest could not prevent those
unrelated files from shipping. `351e479` reconstructs the same Product boundary
directly on `b22930e`: 72 paths differ and every one is listed in the 76-artifact
manifest; the remaining four manifest dependencies are already byte-identical
on the remote base. No Usage/Metering production file or migration is included.

This reconstruction preserves the Product release's required
`generationModeration.ts` dependency and Studio `Suspense` build boundary while
excluding the unrelated Usage/Metering implementation and tests. From the clean
committed Product-only state, the full backend suite passed 877 tests with 2
live-only skips and 77 subtests, the Web registry passed 132/132 with zero
failures, full TypeScript passed, and the production build generated 70/70
static pages. A clean `npm ci` installed 417 packages, `npm audit
--audit-level=low` reported zero known vulnerabilities, and the built localhost
site passed the executable Product-truth render verifier. The Product automation
contract for the new manifest passed 20/20. These local gates do not authorize
production rollout.

ShellCheck passed the exact functional-commit Git blobs for `cloud_lib.sh`,
Product Supply, Product Opportunity Admission and Product Tracking wrappers.
The only excluded diagnostic was SC1091 for the intentional runtime-relative
`cloud_lib.sh` source; no semantic, quoting, process, lock or pipeline warning
was suppressed. This closes local shell lint, but exact candidate systemd units
still require `systemd-analyze verify` on a Linux host before deployment.

The Web deployment config is part of this exact boundary and must use
`installCommand: npm ci`. Replacing it with `npm install`, omitting the lockfile,
or reusing an unverified `node_modules` tree invalidates the dependency-security
evidence and blocks promotion.

Before creating a Web candidate, read back the Vercel project settings and
prove that its Root Directory is `web`; otherwise `web/vercel.json` is not proven
to be the active deployment config. The candidate build log must show `npm ci`,
Next.js 16.3.3 and a successful production build before promotion. A different
root, `npm install`, an older Next.js version, or an unverifiable cached install
is a hard stop and requires discarding that candidate, not promoting it.
The `2026-08-27T10:44:29Z` read-only evidence attempt did not close this gate:
the local Vercel credential was expired, its project-list API returned 403, and
both available browser paths failed to attach. Do not reinterpret those access
failures as platform verification; use
`backend/docs/product_opportunities_v37_vercel_evidence_gap_20260827T124031Z.json`
as the exact open-evidence record.

The latest GET-only pre-Supply data-quality baseline is
`backend/docs/product_opportunities_v37_pre_supply_data_quality_20260827T121042Z.json`.
It proves 123 technical migration candidates and 25 reviewed automatic-Admission
candidates (18 Physical / 7 Digital), but zero current/G7/G14/G30/full-metric
coverage for all 25. Therefore Product discovery inventory exists, while v3.7
trend intelligence remains not launch-ready until Admission and daily tracking
are deployed and produce real persisted history. Do not confuse Supply's 20-row
atomic transaction cap with daily capacity: the candidate Supply run scans 100
Source Pins and may safely write 0-50 legacy rows, and the separate daily
tracking job covers up to 2,499 unique active Primary Pins.

The product contract is
`docs/prd/0825数据功能修改-VibePin_Product_Opportunities_PRD_v3.7_—_产品与技术执行版.md`.
When this runbook and the PRD differ, stop and resolve the difference before
changing production.

## Non-negotiable invariants

1. Active Product Opportunities require a real merchant product page, a real
   non-Pinterest product image, and one persisted auditable Primary Evidence Pin.
2. Product name is nullable. No layer may synthesize `Product` or use a Pin title
   as a merchant product name.
3. All active products are tracked independently of user saves.
4. Daily tracking is bounded by 2,499 unique due Primary Pins and 5,000 real
   provider attempts, including at most one retry per Pin and two reserved calls.
5. The 20-row cap is the atomic reviewed admission/rollback unit. Product Supply
   may admit at most 50 legacy discovery rows across multiple atomic writes in one
   run; neither number is the daily Product Opportunity tracking capacity.
6. Provider failures and rate limits belong to the run health report, not the
   canonical Pinterest snapshot table.
7. Free access is the persisted curated ranks 1–10. Paid plans access the full
   active catalog. Saving never bypasses this boundary.
8. Saved Products and Create Pin are independent actions. Saved Products copy
   must describe a shortlist and must never imply that saving starts tracking;
   all active products are already tracked independently under invariant 3.
9. Physical and Digital calibrations are independent. Existing valid single-card
   metrics may be shown, but Demand/Trend filters and Fastest Growing remain
   hidden until the persisted family release gate proves at least 70% valid
   G30+G7 coverage, the quality review is approved, and the same family/version
   has an approved calibration whose effective time has passed.
10. Rollback preserves retired history; it never deletes historical evidence or
    restores legacy/fabricated metrics.
11. Acquisition `source_category` is immutable provenance, not a user-facing
    business label. Admission must preserve it independently and reject a
    missing, unknown or Product-family-mismatched source before any write. After
    entity creation, the database must also reject changing it to another source,
    including a different category in the same Product family; unrelated audit
    provenance may still be appended.

## Capacity truth

The rows below distinguish what is running in production from what exists only
in the local release candidate. They are not interchangeable deployment values.

| Work | Current reviewed bound | Meaning |
|---|---:|---|
| Daily active-product tracking | 2,499 unique due Primary Pins | Up to 4,998 Pin requests plus two reserved calls |
| Product Supply source crawl — currently deployed | 100 source Pins per scheduled run | Physical-only legacy discovery intake, split 36 Fashion / 28 Women's Fashion / 36 Home Decor; this is the configuration of the next production timer run |
| Product Supply source crawl — local candidate, not authorized for deployment | 100 source Pins per scheduled run | Split 29 Fashion / 22 Women's Fashion / 29 Home Decor / 20 Digital Products; it requires its own zero-write dry-run, exact-ID canary readback, and explicit deployment authorization |
| Product Supply legacy admission | At most 50 rows per run, atomic batches at most 20 | Merchant-proof legacy `pin_products` intake |
| Stable Product Opportunity admission | At most 50 exact receipt rows per run, atomic batches at most 20 | Re-proves Pinterest direct-PDP evidence and merchant evidence; every batch has an independent receipt/readback |
| Free catalog | 10 persisted ranks | Stable curated records, not a dynamic top ten |
| Paid catalog | All active records | Same global metric facts for every paid plan |

Several products may share one Primary Pin. The tracker must load the complete
active catalog, deduplicate by Pin, persist exactly one canonical raw snapshot
per Pin/UTC-day, and fan that shared fact into each Evidence's health and metric
calculation without duplicating snapshot rows. It must refuse before network
access only when the unique due Pin count exceeds the reviewed bound or an active
product lacks Primary Evidence.

## Release artifacts

Before each stage, record the candidate commit from `git rev-parse HEAD` and hash
these exact files from that commit, not from a dirty working tree:

- `backend/db/migrate_v63_product_opportunities_v1.sql`
- `backend/db/rollback_v63_product_opportunities_v1.sql`
- `backend/.env.example`
- `backend/deploy/systemd/vibepin-product-supply.service`
- `backend/run_worker.py`
- `backend/shop_the_look_expand.py`
- `backend/product_opportunity_admission.py`
- `backend/product_opportunity_admission_pipeline.py`
- `backend/product_opportunity_manifest.py`
- `backend/product_opportunity_tracking.py`
- `backend/product_opportunity_metric_refresh.py`
- `backend/product_opportunity_metrics.py`
- `backend/pipeline_tracking.py`
- `backend/product_harvest.py`
- `backend/supply_core.py`
- `backend/tools/t2_harvest.py`
- `backend/scraper_v2.py`
- `backend/scripts/audit_product_opportunity_v37.py`
- `backend/scripts/cloud_run_product_supply.sh`
- `backend/scripts/run_bootstrap_product_supply.py`
- `backend/scripts/product_supply_cutover_v37.py`
- `backend/scripts/validate_product_supply_merchants.py`
- `backend/deploy/systemd/vibepin-product-opportunity-admission.service`
- `backend/deploy/systemd/vibepin-product-opportunity-admission.timer`
- `backend/deploy/systemd/vibepin-product-tracking.service`
- `backend/deploy/systemd/vibepin-product-tracking.timer`
- `backend/scripts/cloud_run_product_opportunity_admission.sh`
- `backend/scripts/cloud_run_product_tracking.sh`
- `backend/scripts/cloud_lib.sh`
- `backend/scripts/preflight_product_supply.py`
- `web/src/lib/server/productOpportunityMetricControls.ts`
- `web/.env.example`
- `web/src/lib/server/productOpportunities.ts`
- `web/src/lib/server/productOpportunityAccess.ts`
- `web/src/lib/server/planEntitlements.ts`
- `web/src/lib/productOpportunitiesClient.ts`
- `web/src/lib/productTitle.ts`
- `web/src/lib/productIdeas.ts`
- `web/src/lib/supabase.ts`
- `web/src/lib/productImageEvidence.ts`
- `web/src/lib/createPinsPrefill.ts`
- `web/src/lib/supabaseBrowser.ts`
- `web/src/lib/analytics.ts`
- `web/src/types/css-modules.d.ts`
- `web/src/components/products/ProductOpportunitiesV1.tsx`
- `web/src/components/products/ProductOpportunitiesV1.module.css`
- `web/src/components/products/ProductOpportunityPicker.tsx`
- `web/src/app/api/products/top/route.ts`
- `web/src/app/api/product/[id]/intelligence/route.ts`
- `web/src/app/api/product-opportunities/route.ts`
- `web/src/app/api/product-opportunities/[id]/route.ts`
- `web/src/app/api/saved-product-opportunities/route.ts`
- `web/src/app/api/composer-drafts/route.ts`
- `web/src/app/api/composer-drafts/[id]/route.ts`
- `web/src/app/app/studio/page.tsx`
- `web/src/app/app/products/page.tsx`
- `web/src/app/app/products/saved/page.tsx`
- `web/src/app/page.tsx`
- `web/src/lib/landingAssets.ts`
- `web/src/components/landing/ExecutionSystem.tsx`
- `web/src/lib/landing/conversionData.ts`
- `web/src/app/admin/data/page.tsx`
- `web/src/app/api/generate/route.ts`
- `web/src/lib/server/generationModeration.ts`
- `web/src/app/api/integrations/shopify/connect/route.ts`
- `web/src/app/api/integrations/shopify/launch/route.ts`
- `web/src/lib/server/shopify/connectPrep.ts`
- `web/tsconfig.product-opportunities.json`

The dependency files above are intentional. `product_opportunity_manifest.py`
imports the reviewed PDP gate, Pinterest direct-link extractor, and merchant-page
evidence core; omitting their exact blobs would silently change admission
semantics even if the Product Opportunity files themselves matched. The Product
Opportunity picker, title cleaner, and legacy Product Idea type are also one
compatibility unit: omitting any of the three leaves Create Pins on the old
non-null title contract and can reintroduce an invented or crashing title path.
The Product Ideas compatibility feed and `productImageEvidence.ts` are one truth
boundary: only rows with an available merchant-page result and a non-Pinterest
image may enter the Create Pins Product Ideas tab. User uploads, URL imports and
the user's own product library remain separate inputs.
The stable Product Opportunity Create Pin action also depends on the authenticated
composer-draft routes, the Studio draft consumer and the browser token helper.
These files must ship with `createPinsPrefill.ts`: the immediate handoff uses a
one-shot session copy, while the persisted draft id keeps the same truthful
merchant image and optional title recoverable after refresh. Saving remains a
separate API and is never called by this handoff.
The catalog view's category-search aliases, user-facing category labels and Create Pins handoff labels must be deployed as one truth boundary. The migration keeps
stable internal category identities searchable through natural language; the
Product UI renders only natural labels; and the handoff must not promote an
internal source bucket into a Studio title or keyword. Shipping only one layer
would make search, display and creation disagree even when each file passed in
isolation.
The public landing mapper, root landing route and admin data strip are part of
the same scraped-name/marketing-truth boundary. Omitting them would restore a
fabricated `Product` title or retired Product Opportunity score/competition
claims outside the authenticated catalog.
The bounded Product Supply toolchain also includes `backend/tools/t2_harvest.py`.
It carries the reviewed MAX_BATCH, timestamp encoding, exact rollback and shared
red-line behavior; leaving it behind would make the documented manual recovery
path differ from the automated supply core.

The full-Web integration branch includes one separate route-module build fix.
Next route files may only export supported HTTP/config symbols, so the generation
helpers stay private and shared Shopify OAuth preparation lives in
`connectPrep.ts` rather than another `route.ts`. The four listed files are one
build unit and must be included together when deploying that branch. This unit
does not change moderation decisions, Shopify entitlements, OAuth state, or any
Product Opportunity behavior and may be reviewed/cherry-picked independently.
The catalog access helper and plan entitlement table are one server-side access
unit. Both the legacy Product Picker endpoint and the old `pin_products` detail
intelligence endpoint must ship with the v3.7 catalog so percentile, keyword-growth,
Competition and Opportunity Score conclusions cannot remain exposed beside the new
metrics. The old detail endpoint returns an explicit HTTP 410 rather than guessing a
mapping from a legacy row id to a stable Product Opportunity.
The Product Supply service, wrapper, runner and Shop-the-Look worker are also one
compatibility unit. They must remain on the canary-proven 100-source/50-run/20-atomic
cutover implementation; deploying the older base copies would restore the automatic
cooldown waiver and discard exact per-flush receipts even if the v3.7 admission code
itself were unchanged. The two example environment files are release-control evidence,
not production secret files: their gates must stay blank/false until their own stage.
Canary and permanent-timer receipts use separate fail-closed audit contracts. Use
`product_supply_cutover_v37.py audit --require-canary-write` only for the frozen
one-row canary. Use
`product_supply_cutover_v37.py audit --require-scheduled-run` for the currently
deployed Physical-only permanent timer. The scheduled contract requires an
authenticated trusted 100-Pin 36/28/36 report, run cap 50, atomic cap no greater
than 20, zero failed rows/batches/render failures, exact inserted-ID readback,
and safe per-batch red-line/rollback receipts; zero eligible writes is allowed,
but unaccounted writes are not.
Response parse errors are mandatory measured diagnostics with bounded samples, not rows or render failures. Pinterest can
emit a non-JSON response on a resource/shop/product-like URL, and Playwright can
release an async response body before it is read. They do not independently fail a trusted authenticated run, but missing/invalid response accounting does. The
two audit authorities cannot be combined. The two flags are mutually exclusive.
Batch-receipt consistency is mandatory even when the top-level report claims zero
writes; a hidden receipt ID or pre-write violation cannot be waived by an empty
top-level ID list. Product-image readback uses parsed host families, including
regional `pinimg.*` and `pinterest.*` domains, rather than the narrower
`pinimg.com` substring. A merchant path containing those words is not rejected.
The scheduled contract intentionally does not accept the local 29/22/29/20
Digital candidate until that mix receives separate deployment authorization and
the audit authority is changed in the same reviewed release.

The deployment report must show candidate SHA, deployed SHA, per-file hashes,
test results, operator, timestamp, and rollback reference. A clean build from the
exact candidate is mandatory after the final integration with concurrent work.

## Stage 0 — Read-only gate

1. Re-run the production audit script without mutation and preserve its JSON
   report. Reconcile totals with the PRD baseline instead of assuming 122
   candidates still exist.
2. Confirm no v63 table, function, or view with incompatible definitions already
   exists. If one does, stop and produce a schema diff.
3. Confirm Product Supply, Product Tracking, and metric UI flags remain disabled.
4. Confirm the deployment candidate contains no unrelated billing, social
   publishing, or other unfinished work. If the full-Web integration branch is
   used, permit only the separately reviewed four-file route-module build unit
   listed above; any other moderation or Shopify diff is a stop condition.
   The 2026-08-26 evidence branch is intentionally not that candidate: tip
   `8e64b67` was 274 commits/574 files ahead of `master@d3877a7` and includes
   unrelated integration history. Reconstruct on the then-authoritative clean
   base; do not merge or deploy that evidence branch wholesale.
5. Run the full backend suite, Product Opportunity TypeScript contract, access
   contract, full typecheck, production build, ShellCheck, and systemd verify.

Exit condition: read-only evidence is archived and every artifact is tied to one
clean candidate SHA.

## Stage 1 — Additive database foundation

1. Take the normal production database backup and prove it can be located before
   applying SQL.
2. Apply `migrate_v63_product_opportunities_v1.sql` through the approved Supabase
   migration channel. The file is transactional and does not backfill, activate,
   retire, or delete existing `pin_products` rows.
3. Read back table constraints, partial unique indexes, RLS policies, grants,
   catalog view, admission RPC, observation RPC, Primary-switch RPC, and exact
   admission rollback RPC.
4. Verify all new tables are empty and existing legacy row counts are unchanged.
5. Keep both family metric UI flags false.

Exit condition: schema exists, legacy data is byte/logically unchanged, and no
Product Opportunity is user-visible.

Schema-only rollback is allowed only while the v63 tables contain no data that
must be retained. Use the reviewed
`backend/db/rollback_v63_product_opportunities_v1.sql`; its dependency order is
tested by a real migration-then-rollback exercise. After the first admission,
leave the additive schema in place and roll back behavior, not history.

## Stage 2 — Evidence-reviewed canary admission

1. Generate a read-only manifest from at most 20 legacy candidates:
   `python product_opportunity_manifest.py --limit 20 --scan-limit 100 --output <path>`.
   The builder performs database GETs, fresh bounded PinResource verification,
   and bounded merchant-page GETs; it has no database mutation path.
2. Require PDP proof, exact merchant-page and image provenance, a real non-
   Pinterest image, and a valid Product Pin or a Source Pin whose direct outbound
   URL equals the canonical product identity. A Shop-the-Look discovery relation
   is rejected unless the selected Pin independently proves that exact direct
   outbound URL. Domain-only Pin hints are never direct-link evidence.
   Candidates that resolve to the same canonical product identity are grouped into
   one Product Opportunity. Each Pinterest Pin is still fetched and verified
   independently; the merchant page is fetched once. Prefer a verified Product Pin
   as Primary Evidence, otherwise retain the first verified direct-link Source Pin.
   Persist at most 19 other verified Pins as Additional Evidence. Every Evidence row
   must carry its own verifier, Pin identity, and exact direct-PDP provenance. Its
   stored Pin link is canonicalized to a real `pinterest.com` host and the numeric
   `/pin/<id>` path must equal the persisted Pin id; brand-token lookalike hosts are
   rejected by both admission code and the database constraint.
   Evidence rows for one canonical product must agree on Physical versus Digital;
   a legacy family conflict is rejected and reported instead of accepting whichever
   row happened to be scanned first.
3. Run `product_opportunity_admission.py --manifest <path>` first. Any rejected
   row blocks that apply batch; do not skip rows merely to reach a quantity.
4. Start with one product, then at most one 20-row batch. Real apply additionally
   requires `VIBEPIN_PRODUCT_ADMISSION_MODE=production` and
   `VIBEPIN_PRODUCT_ADMISSION_CONFIRM=ADMIT_REVIEWED_PRODUCTS`.
5. Preserve the returned Product Opportunity IDs as the exact rollback receipt.
   The tool independently reads back the product, exactly one Primary Evidence,
   every expected Additional Evidence row, each row's provenance, and the exact
   Primary/Additional flags. Missing, duplicate, extra, or changed Evidence fails
   verification. It then calls the history-preserving rollback RPC and verifies the
   retired state.
6. Assign Free ranks only through `set_product_free_preview_rank`, with a written
   business reason. Do not derive ranks from daily Saves or request order.
7. Verify active/current uniqueness, retired/current coexistence, null product
   names, merchant images, Source/Product Pin labels, and all three external links.
8. Archive the builder report, manifest hash, admission dry-run report, exact apply
   receipt, readback, and rollback receipt together. A manifest is valid for at
   most 24 hours and cannot be reused after its merchant verification expires.

Exit condition: canary DB readback and UI review pass with zero fabricated fields.

## Stage 3 — Tracking deploy with timer still disabled

1. Deploy the exact candidate backend artifacts and verify their hashes.
2. Run ShellCheck on both wrappers and `systemd-analyze verify` on the service and
   timer. Confirm wrapper timeout 7,200 seconds is below systemd 7,800 seconds,
   `KillMode=control-group`, no overlap lock, and 17:15 Asia/Shanghai schedule.
   This time is based on the read-only live VPS schedule observed on 2026-08-27:
   Crawl 12:00 with 600-second jitter and 7,800-second outer bound, followed by
   Classify with a 2,700-second outer bound. Their latest combined finish is
   15:05:01; the 120-minute cooldown ends at 17:05:01. Tracking then starts no
   earlier than 17:15 and ends no later than 19:30:01. It therefore cannot cross
   the Shanghai 08:00 UTC-day boundary and still leaves more than 120 minutes
   before Product Supply at 23:00.
3. Install/reload units but keep `vibepin-product-tracking.timer` disabled.
4. Run wrapper `preflight`; then `dry-run`. Dry-run performs inventory and budget
   checks only: no Pinterest calls and no database writes.
5. Require `missingPrimaryEvidence=0`, `exceedsRunBudget=false`, and reconcile
   active products, eligible products, eligible unique Pins, due unique Pins, and
   already-observed Evidence rows.
6. Run one manual real tracking canary with all three gates:
   `VIBEPIN_TRACKING_RUN_MODE=track`,
   `VIBEPIN_PRODUCT_TRACKING_MODE=production`, and
   `VIBEPIN_PRODUCT_TRACKING_CONFIRM=TRACK_ACTIVE_PRODUCTS`.
7. Reconcile provider attempts, unique Pins, deduped fan-out rows, valid/not-found
   snapshots, provider failures, retries, counter regressions, metric writes,
   duration, lock release, and orphan count. Provider failures must not increase
   `snapshotWrites`. These health counts are unique-Pin outcomes, not duplicated
   Product/Evidence fan-out rows. A partial batch may finish as
   `degraded_partial_observations` while preserving its confirmed facts, but a
   non-empty due batch with no confirmed `valid` or `not_found` observation must
   report `failed_no_confirmed_observation` and exit non-zero before snapshot or
   metric writes; it must never appear as a successful zero-write tracking day.
8. When a Primary Evidence has three confirmed forward natural-day `not_found`
   observations, the same bounded tracking run may verify one replacement Pin.
   The current Primary remains in that day's tracking set until the replacement
   switch transaction succeeds; a failed replacement check must not create a gap
   in the still-authoritative Primary history.
   Product Pins are considered before direct-link Source Pins. A Source Pin whose
   relationship is not `direct_outbound_link` is never eligible to become Primary.
   The switch RPC may run only after the replacement has a real `valid` observation
   on that UTC day (including a shared canonical Pin/day fact already recorded by
   another Product), and the RPC independently rechecks that canonical current-day
   snapshot inside the switch transaction. Timeout, 429, HTTP 404, parse failure,
   `not_found`, or a privileged direct RPC call without that snapshot leaves the
   old Primary in place. Reconcile `primarySwitchCandidates`, `primarySwitches`,
   and `primarySwitchCandidatesUnverified`; every successful switch must have a
   `product_evidence_switches` audit row, and its metrics restart from the new Pin.
   If the old Primary itself returns a valid observation during that verification
   run, it has recovered: cancel the pending switch even when the candidate is also
   valid, keep the old Primary, and preserve its continuous metric history.
   A database tracking-lock collision is a failed/non-zero scheduled run, never a
   successful skip, because no complete-catalog tracking occurred.

Exit condition: one complete manual run succeeds from the deployed SHA, with
idempotent same-day rerun evidence and no orphan process.

## Stage 4 — Web/API release

Current production warning: the public homepage audited at
`2026-08-27T07:11:09Z` still renders retired/fabricated Product Opportunity
Score, Demand, Competition, static inventory and fake Live-growth claims. That
deployment is not a Product-truth-safe rollback target. Use the reviewed
candidate's marketing boundary and identify a rollback SHA that also lacks those
claims before promotion.

The independently rebuilt Product-truth-safe rollback code SHA is
`d8cc0b869d871763ec8c2c549dd913494aa487b1`: a clean `npm ci`, zero-vulnerability
audit, Next.js 16.3.3 production build with 69/69 pages, and browser-rendered
truth scan all passed. Promotion still requires an immutable Vercel deployment
artifact for that exact SHA; code qualification alone is not a rollback artifact.

1. Deploy Web only after Stage 2 has at least one truthful canary and Stage 3 has
   a successful observation path.
2. Keep Physical and Digital metric UI flags independently false until each
   family has enough individually valid history for product review. Enabling one
   family must not enable the other.
3. Test Free with ranks 1 and 10 plus a direct request for rank 11. Test one paid
   account against the full active catalog.
4. Test Save persistence, account isolation, paid saved history, Free downgrade,
   removal of historical saves, and no Save/Create Pin cross-effect.
5. Test cards, modal, filters, empty/error/loading states, missing names, broken
   image handling, Pinterest link, product link, and Create Pin handoff.
6. Scan rendered text and API payloads for legacy demand/trend/competition/score
   fields and internal lifecycle/evidence/tracking enum values.
7. Run `npm run verify:product-truth -- https://vibepin.co/` after promotion,
   then repeat the public rendered-text scan against `/`. Require zero
   `Opportunity score`, fabricated Demand/Competition, fake Live-growth and
   unproven inventory-count claims before declaring Web release success.

Exit condition: production UI is truthful and plan access cannot be bypassed by
search, pagination, direct ID, Saved Products, or client-side requests.

## Stage 5 — Enable automatic admission, then daily tracking

1. Keep both new timers disabled while applying v63 and completing the manual
   admission/tracking canaries. Installing units is not timer proof.
2. Enable only `vibepin-product-opportunity-admission.timer` first. Verify its
   first real 03:15 Asia/Shanghai trigger from journal, the immutable Product
   Supply report SHA, exact legacy inserted IDs, per-batch manifests, admission
   receipts, and exact-ID readback. Its wrapper must receive `SAFE_FOR_APPLY`;
   `SAFE_FOR_DRY_RUN` is never enough to start Pinterest proof requests.
3. The admission job consumes only one fresh successful Product Supply apply
   receipt. It requires all 100 unique completed Pin results in the exact
   29 Fashion / 22 Women's Fashion / 29 Home Decor / 20 Digital Products launch
   mix and explicit 50-per-run/20-per-atomic-batch receipts.
   It refuses dry-run/stale/partial/failed/mismatched reports, evaluates no more
   than 50 exact legacy IDs, and writes independent atomic batches of at most 20.
   Post-write mismatch rolls back only the exact returned IDs and verifies the
   history-preserving retirement before the run fails.
   A missing legacy broad family may be derived only from the reviewed source
   bucket mapping. A declared family/category conflict or an unknown bucket is
   rejected before provider access; this must not be replaced by Product Type
   guessing from Pin content.
   A merchant may move the same PDP through one or two bounded HTTP redirects.
   In that case the original Pin-direct URL, every approved 301/302/303/307/308
   hop, the final canonical PDP, and a deterministic chain hash must all be
   retained and validated by Python, the admission RPC, and the database check.
   JavaScript/meta refreshes, broken chains, unapproved statuses, more than two
   hops, and redirect guesses remain rejected.
4. After automatic admission passes, enable only
   `vibepin-product-tracking.timer` and verify the first real 17:15
   Asia/Shanghai trigger. The live 12:00 Crawl -> Classify chain can finish as
   late as 15:05:01; the mandatory 120-minute cooldown ends at 17:05:01, leaving
   9 minutes 59 seconds. With timer jitter and the 7,800-second outer bound,
   Tracking ends by 19:30:01, remains within one UTC day, and leaves 209 minutes
   59 seconds before the 23:00 Product Supply window. A manual start does not
   count as timer proof.
5. Product Supply has its own independent cutover gate. Its reviewed scheduled
   candidate configuration is 100 source Pins with the 29/22/29/20
   Fashion/Women's Fashion/Home/Digital split, at most 50 admitted rows per run,
   and no atomic write over 20 rows. `digital-products` is explicitly opted in;
   Beauty remains excluded. Restore its 23:00 timer only after this exact mix's
   zero-write dry-run and exact-ID canary readback pass; this does not authorize
   the Product Tracking timer. A successful receipt from the older Physical-only
   36/28/36 production mix does not qualify the Digital launch candidate and must
   be rejected by automatic v3.7 Admission.
   Every atomic batch receipt must also close independently. A receipt with
   inserted IDs must prove the same exact expected/actual IDs, matching readback
   count, all red lines, a concrete created-at window, and an exact rollback
   command. A receipt with no inserted IDs must not contain phantom write
   verification, created-at, or rollback evidence. Receipt IDs across the report
   must equal the top-level inserted IDs exactly, including natural-zero runs.
6. Product Supply still writes the legacy discovery/evidence pool; it does not
   directly mutate v63. The separate admission job is the only automatic bridge,
   and remains preflight-only until its production mode and confirm token are
   explicitly configured after the canary.
7. Keep the local fallback until at least three consecutive successful VPS runs,
   then retire it in a separately recorded step.

If Product Supply is interrupted after one of its safe incremental legacy
flushes but before a complete successful report is sealed, those legacy rows
remain preserved but are not automatically admitted to v3.7. Recovery is a
separate bounded reviewed-manifest operation (maximum 20 per atomic receipt);
the admission timer must never infer missing receipt IDs from a broad time
window or silently treat an interrupted run as complete.

Exit condition: the first admission and tracking timer runs both pass, followed
by three consecutive healthy daily chains with no overlap, false success, orphan
process, unexplained count drift, or receipt mismatch.

## Metric publication

1. Raw daily collection starts immediately for every active product.
2. A card may show an individually valid G30 or G7 result after its own history,
   calibration, freshness, gap, and regression gates pass.
   Approved High-demand, 14-day activity, and absolute-delta thresholds must be
   positive; zero is not a valid way to bypass low-activity truthfulness gates.
3. Missing or invalid metrics are omitted; no `No data`, zero, Low Demand, Stable,
   or decline statement is synthesized.
4. Demand/Trend filters and Fastest Growing remain hidden until the matching
   Physical or Digital release-gate row proves at least 70% combined G30+G7
   coverage plus approved quality checks, and the exact family/version has an
   approved calibration whose effective time has passed. The combined All view
   never receives one ambiguous cross-family control policy.

## Rollback order

1. Web problem: redeploy a separately verified Product-truth-safe Web SHA. The
   production deployment observed at `2026-08-27T07:11:09Z` is not known-good
   because it renders fabricated/retired Product metrics, so it must not be used
   as the rollback target. Do not restore fake titles, images, or legacy metrics.
   Leave additive v63 data intact.
2. Tracking problem: disable/stop only the Product Tracking timer/service. Raw
   history already recorded remains immutable.
3. Admission readback problem: use the exact returned IDs. The admission tool
   automatically retires and verifies that batch; never use a broad timestamp
   delete window.
4. Product Supply problem: disable its timer and use its own exact batch rollback
   evidence. Do not mix legacy Product Supply rollback with v63 admission rollback.
5. Schema problem before any retained data: use the migration's schema-only
   rollback after backup and dependency verification. After retained data exists,
   make a forward additive fix instead of dropping history.

Any rollback failure, SHA mismatch, incomplete receipt, ambiguous provider result,
or inability to prove exact affected rows is a stop condition.
