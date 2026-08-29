# Product Opportunities v3.7 Rollout Runbook

Status: exact local candidate plus non-production Preview qualified. Production
rollout is not authorized, the additive v63 schema is not installed, and real
Admission/Tracking history does not yet exist. This document does not authorize
a push, production database write, VPS deployment, Vercel promotion, timer
enablement, or budget increase.

Current decision: code, manifest, local ShellCheck and the unchanged Web Preview
are PASS; exact current VPS staging/systemd verification remains pending. Product
launch remains NOT LIVE. Stage 0 data and exact PostgreSQL catalog
items are current and clean; production flags, candidate contamination and full
test/build state must still be refreshed immediately before any Stage 1 apply.
The next privileged sequence is
Stage 1 additive schema -> Stage 2 one-product and <=20-row
canaries -> Stage 3 backend/manual Tracking canary -> Stage 4 Web promotion ->
Stage 5 Admission first, then Tracking timers. A later-stage PASS must never be
used to skip an earlier stage or its rollback receipt.

Current release pointer: branch `codex/product-v37-manifest-b229`, exact
production remote base `b22930ebe73847cf35bc44be789414902ae6b599`,
functional tip `8caad7764f0f1c136ffe1d1e69d5a468a9d3593f`, and exact
81-artifact Product boundary
`backend/docs/product_opportunities_v37_release_manifest_8caad77.json`.
Earlier branch pointers and manifests are chronological evidence only.

The current tip closes two deployment-review findings without changing Product
eligibility or volume. Metric rows convert every timezone-aware anchor timestamp
to ISO 8601 before the PostgREST JSON boundary, so a non-empty refresh cannot
fail local JSON encoding. Supply, Tracking and standalone metric apply paths now
bind `SUPABASE_URL` to an explicit expected project before database reads,
Pinterest access or writes; direct core calls cannot bypass that check. The
reviewed environment keys must be configured during staging and are not inferred
from a service-role key.

The first permanent-timer receipt exposed one whole-Pin timeout at Pin 79. The
current tip does not raise the 120-second safety wall or weaken the zero-render-
failure gate. It bounds optional Playwright DOM probes to 5-8 seconds, limits
generic tab probing to four tabs, and persists the exact timeout stage in the
report. A subsequent automatic run is still required before the receipt can be
accepted for Admission.

The same receipt exposed a separate yield problem: all 13 merchant-page
candidates failed the required merchant-image gate. Five were honest 403 blocks;
eight Amazon PDPs returned 200, and seven of those had page-proven names, but the
old extractor did not read Amazon's literal primary-image element. Candidate
`6839e76` adds only that conservative page-evidence path; it does not accept
arbitrary page images or any Pinterest/card image. Evidence:
`backend/docs/product_supply_merchant_image_gap_20260828T003013+0800.json`.

This candidate supersedes `99efabc` for deployment topology. That earlier tree
was functionally qualified but sat on a local integration base containing
Usage/Metering production changes not present in the production remote. Because
Vercel promotes a whole tree, its exact Product manifest could not prevent those
unrelated files from shipping. `58598b4` reconstructed the same Product boundary
directly on `b22930e`: it inherits the Product implementation from `351e479` and
the Tracking schedule hardening from `01dcb53`. It also restores the
`classify-chain` worker route required by the already-installed Crawl OnSuccess
wrapper, fixing the production version mismatch observed on 2026-08-27 without
changing its unit, timer, or wrapper. Exactly 71 production paths differ from
the remote base and every one is listed in the 81-artifact manifest. The other
entries are versioned SQL/operator dependencies, including four files already
byte-identical on the remote base. No provider/write budget changed. No
Usage/Metering production file or migration is included.

`c8f0d77` then separates user-facing launch taxonomy from immutable acquisition
provenance. It adds Wedding & Celebrations, Gifts, and Jewelry & Accessories,
normalizes Women's Fashion acquisition evidence into the Fashion catalog, and
allows Wedding to be independently Physical or Digital. The exact GET-only
evidence is `backend/docs/product_opportunities_v37_launch_taxonomy_audit_20260827T140231Z.json`.
`5b5f98c` additionally recognizes the production `jewelry` source bucket as
physical provenance while keeping the user-facing category normalized to
Jewelry & Accessories. It does not change the Supply budget or category mix.

The immutable read-only production drift receipt is
`backend/docs/product_opportunities_v37_classify_chain_drift_20260827T131825Z.json`.
It proves the installed wrapper invokes `--job classify-chain`, the deployed
worker contains zero such routes, and the automatic 2026-08-27 chain exited 2
before any classification stage. Until the repaired worker is deployed and an
automatic Crawl -> Classify run passes, no same-day fresh-classification claim is
allowed for Product Supply output.

This reconstruction preserves the Product release's required
`generationModeration.ts` dependency and Studio `Suspense` build boundary while
excluding the unrelated Usage/Metering implementation and tests. From the clean
committed Product-only state, the full backend suite passed 1039 tests with 2
live-only skips, the Web registry passed 132/132 with zero
failures, full TypeScript passed, and the production build generated 70/70
static pages. A clean `npm ci` installed 417 packages, `npm audit
--audit-level=low` reported zero known vulnerabilities, and the built localhost
site passed the executable Product-truth render verifier. The Product automation
contract for the current manifest passed 30/30; the focused Admission and
migration-contract group passed 132/132. These local gates do not authorize
production rollout.

ShellCheck passed the exact functional-commit Git blobs for `cloud_lib.sh`,
Product Supply, Product Opportunity Admission and Product Tracking wrappers.
The only excluded diagnostic was SC1091 for the intentional runtime-relative
`cloud_lib.sh` source; no semantic, quoting, process, lock or pipeline warning
was suppressed. This closes local shell lint, but exact candidate systemd units
still require `systemd-analyze verify` on a Linux host before deployment.

After Admission hardening, the same four exact `1946a684` LF Git blobs were
rechecked with ShellCheck 0.11.0 and all exited 0. The backend suite passed
966/966 with two credential-gated skips, the focused Admission/migration group
passed 132/132, and the exact release contract passed 30/30. Evidence:
`backend/docs/product_opportunities_v37_admission_hardening_validation_20260828T055033Z.json`.
Because the Admission wrapper is one of four artifacts changed after the earlier
VPS `/tmp` preflight, that host receipt must be refreshed against `1946a684`
before installation; it is not silently relabelled as current.

The latest VPS read-only check at `2026-08-27T17:10:44Z` makes that boundary
exact. The installed Supply service/timer parse successfully, but their hashes
(`09d8f2ad...` / `4dfd713b...`) differ from the candidate (`51f78a4e...` /
`9b046ec9...`); all four Admission/Tracking units are absent. Therefore the
installed-unit PASS cannot be reused for the candidate. Evidence:
`backend/docs/product_opportunities_v37_systemd_evidence_gap_20260827T171044Z.json`.

The earlier `6839e760` committed candidate was rechecked locally at
`2026-08-27T17:40:00Z`: all six unit blobs and four wrapper blobs match the
release-manifest SHA-256 values, ShellCheck 0.11.0 passed all four exact LF Git
blobs (only intentional SC1091 excluded), and the focused automation group
passed 156/156. This qualifies the local bytes but does not replace Linux-host
verification. The exact six unit blobs must still be staged read-only on the VPS
and pass SHA-256 plus `systemd-analyze verify` before installation. Evidence:
`backend/docs/product_opportunities_v37_local_systemd_gate_20260827T174000Z.json`.

The authorized host preflight closed the `6839e760` gate at
`2026-08-27T23:45:11Z` without
installing anything. The VPS received the six exact candidate units under a
random `/tmp` directory; every SHA-256 matched the manifest. A direct host verify
parsed the units and failed only because the not-yet-deployed Admission/Tracking
wrappers do not exist under `/opt`. An isolated `/tmp` alternate root containing
the exact four candidate wrappers plus minimal target stubs then passed systemd
255 verification with exit 0 and empty output. Cleanup was verified. This is
historical pre-install evidence for unchanged units, not a current `1946a684`
wrapper hash receipt; it does not authorize copying to `/etc` or `/opt`,
daemon-reload, starting services or changing timers. Evidence:
`backend/docs/product_opportunities_v37_platform_preflight_20260827T234511Z.json`.

The Web deployment config is part of this exact boundary and must use
`installCommand: npm ci`. Replacing it with `npm install`, omitting the lockfile,
or reusing an unverified `node_modules` tree invalidates the dependency-security
evidence and blocks promotion.

Before creating a Web candidate, determine the actual deployment mode. For the
current CLI-upload mode, `web` is the upload working directory and Vercel
correctly reports that uploaded directory as Root Directory `.`. A Git-integrated
monorepo deployment would instead require repository Root Directory `web`.
Never change this setting merely to make a report string match: doing so under
CLI-upload mode can produce an invalid `web/web` boundary. In either mode, the
candidate build log must show `npm ci`, Next.js 16.3.3 and a successful build
before promotion. `npm install`, an older Next.js version, or an unverifiable
cached install in the candidate build is a hard stop.
The `2026-08-27T10:44:29Z` read-only evidence attempt did not close this gate:
the local Vercel credential was expired, its project-list API returned 403, and
both available browser paths failed to attach. Do not reinterpret those access
failures as platform verification; use
`backend/docs/product_opportunities_v37_vercel_evidence_gap_20260827T124031Z.json`
as the exact open-evidence record.

The current candidate was retried read-only at `2026-08-27T17:05:44Z`. Chrome
again proved the signed-in project page and exact settings URL exist, but two
tab claims and a fresh-tab DOM read timed out before Root Directory or build-log
values could be read. The updated gap is
`backend/docs/product_opportunities_v37_vercel_evidence_gap_20260827T170544Z.json`;
the promotion stop remains unchanged.

The platform values were finally read back with authenticated Vercel CLI 58.4.0
at `2026-08-27T17:36:28Z`. The latest Ready deployment reports entrypoint `.`,
contains no Git/source metadata, and embeds a Vercel config that exactly matches
the historical `web/vercel.json` at `096d921` (`npm install`, Next.js 16.2.6).
This is strong evidence that production is uploaded from the `web` directory,
so Root Directory `.` is expected and must not be changed to `web` without
contrary authoritative source metadata. The earlier configuration-mismatch
interpretation is superseded by
`backend/docs/product_opportunities_v37_vercel_deployment_mode_20260827T175000Z.json`.
At that checkpoint promotion remained blocked because no immutable deployment or
build log existed for functional candidate `6839e760`, whose checked-in config
requires `npm ci` and Next.js 16.3.3. The Preview evidence below supersedes that
specific build-evidence gap; it does not authorize production rollout.

The authorized non-production Preview closed that build gate at
`2026-08-27T23:45:11Z`. Deployment `dpl_CAungjKNgdCrcHnxXtPuTeFbtQvV` is READY
with target `preview`; it was sourced from an exact `6839e760:web` Git archive,
used `npm ci`, found zero vulnerabilities, built Next.js 16.3.3, completed
TypeScript and generated 70/70 pages including the Product Opportunity APIs,
`/app/products` and `/app/products/saved`. Vercel Protection redirects anonymous
requests to SSO, so the direct truth verifier was not authoritative; the same
Preview root HTML fetched through authenticated `vercel curl` had SHA-256
`3d007093...a2159`; those bytes were replayed unchanged from a local HTTP server
through the Product-truth verifier but were not retained after the run. This
proves only the captured root HTML shell and its rendered truth-text rules. It
does not prove authenticated Preview API/middleware behavior, live server-side
rendering, interactive Product/Saved workflows or origin asset delivery.
`vibepin.co` still points to production deployment `dpl_GdtGTzX3FW9dGP1uE3UtgoWgApAn`.
Do not promote the Preview without separate production-rollout authorization.
Evidence: `backend/docs/product_opportunities_v37_platform_preflight_20260827T234511Z.json`.

The latest GET-only Stage 0 data-quality baseline is
`backend/docs/product_opportunities_v37_stage0_data_quality_20260828T000146Z.json`.
It proves 4,115 legacy Products, 34,073 legacy snapshots, 123 technical migration
candidates and 39 reviewed automatic-Admission candidates (31 Physical / 8
Digital). All 39 lack today's observation, G7, G30 and full-metric coverage; one
Physical candidate has only a G14 anchor. The 39 include 14 Wedding candidates
(13 Physical / 1 Digital). The `eligible_categories` object is explicitly a
Top-20 view: it reports 118 rows and omits five one-row categories; it must not be
summed as the complete 123-row category distribution. Therefore Product discovery inventory exists, while v3.7
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
- `backend/scripts/run_migration.py`
- `backend/scripts/audit_product_opportunity_schema_v37.py`
- `backend/docs/product_opportunities_v37_stage1_baseline_query_v1.sql`
- `backend/docs/product_opportunities_v37_stage1_post_apply_query_v1.sql`
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
The historical scheduled contract remains available as the default
`--scheduled-profile physical-legacy`. The v3.7 Digital launch must be audited with
`--require-scheduled-run --scheduled-profile launch-v37`; this requires the exact
29/22/29/20 mix and cannot accept a historical 36/28/36 receipt. The two profiles
are explicit so neither production generation can be mistaken for the other.

The deployment report must show candidate SHA, deployed SHA, per-file hashes,
test results, operator, timestamp, and rollback reference. A clean build from the
exact candidate is mandatory after the final integration with concurrent work.

## Stage 0 — Read-only gate

Current read-only evidence: the `2026-08-28T00:08:33Z` service-role OpenAPI GET
returned HTTP 200, retained both legacy control paths and exposed zero v63 path.
This is not a complete PostgreSQL catalog proof: non-exposed tables, views,
functions, triggers, policies and indexes are outside OpenAPI. Preserve
`backend/docs/product_opportunities_v37_schema_presence_audit_20260828T000833Z.json`
and complete the catalog query through the approved migration channel before
Stage 1 apply.

The reproducible catalog query is now complete. At `2026-08-28T05:05:05Z`, the
versioned SQL `backend/docs/product_opportunities_v37_catalog_query_v1.sql` ran as
a read-only Management API `SELECT` over `pg_class`, `pg_proc`, `pg_trigger`,
`pg_policies` and `pg_constraint`. Its seven recorded patterns cover the v63
tables, view, functions, triggers, policies, indexes, identity sequences and
constraints—including the free-preview and active/Primary names missed by the
earlier evidence format. It returned HTTP 201 and zero matches in `public`.
The receipt binds the query SHA-256, canonical LF migration Git-blob SHA-256,
production project ref and functional candidate SHA. No SQL mutation was executed. Evidence:
`backend/docs/product_opportunities_v37_catalog_audit_20260828T050505Z.json`.

1. Re-run the production audit script without mutation and preserve its JSON
   report. Reconcile totals with the PRD baseline instead of assuming 123
   candidates still exist.
2. Query PostgreSQL catalogs—not only PostgREST OpenAPI—and confirm no v63 table,
   view, function, trigger, policy or index with incompatible definitions already
   exists. If one does, stop and produce a schema diff.
3. Read back Product Supply, Admission and Tracking unit state; do not assume all
   Product timers are disabled. The current legacy Product Supply timer is
   enabled and may continue its separately reviewed discovery schedule until a
   specifically authorized cutover window. Before capturing the <=900-second
   Stage 1 baseline, require the Product Supply service to be inactive and its
   next timer trigger to be at least 30 minutes in the future. If either check
   fails, do not capture/reuse a baseline and do not apply v63. Any authorized
   temporary timer stop must preserve and later restore its exact prior state;
   installing v3.7 must not silently retire legacy intake. Admission, Tracking
   and both metric UI flags must remain absent/disabled at this stage.
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

Current Stage 0 data/catalog result: PASS. Production remains unchanged. Items
3-5 (flags, contamination and full gates) retain earlier evidence but must be
refreshed at the actual cutover checkpoint, so this result permits Stage 1
authorization review and does not authorize applying the migration.

The latest read-only VPS parity audit is intentionally a deployment BLOCK, not
a missing-evidence placeholder. Of 11 candidate-critical runtime/unit files,
only the existing Product Supply wrapper matches `9a22c163`; four installed
files differ and six Admission/Tracking files do not exist. The legacy Product
Supply timer is already enabled/active and waiting for its next scheduled run,
while Admission and Tracking units are absent and the standalone classify timer
remains absent. No file, unit or timer was changed. Before any v3.7 install,
stage the exact candidate bytes separately, run hash readback and
`systemd-analyze verify`, and keep every new timer disabled. Evidence:
`backend/docs/product_opportunities_v37_vps_readonly_parity_20260829T025149Z.json`.

The enabled legacy Supply timer creates a real cutover race: its write path can
change `pin_products` or `pin_save_snapshots` after a baseline is captured. The
post-apply checksum verifier will fail closed if that happens, but the operator
must prevent the overlap rather than relying on a failed migration window.
Immediately before the baseline, use read-only `systemctl show` to prove the
Supply service is inactive and the next trigger is at least 30 minutes away.
This check does not authorize stopping or changing the timer.

## Stage 1 — Additive database foundation

Authorization-review evidence is now closed locally but production execution is
still not authorized. A GET-only Management API inventory at
`2026-08-28T03:18:21Z` located seven completed physical backups; the latest was
backup `1497305229` from `2026-08-27T13:55:45.333Z`. WAL-G is enabled, PITR is
not enabled, and no restore was attempted. Refresh this inventory immediately
before the actual apply; an old inventory is not a backup-at-cutover claim.
Evidence:
`backend/docs/product_opportunities_v37_stage1_backup_inventory_20260828T031821Z.json`.

The exact migration and rollback were also rerun in a fresh in-memory
PGlite/PostgreSQL-compatible runtime with `pgcrypto`. PGlite reported 238
matching catalog-query rows and zero new data rows; complete rollback left zero
matching objects. Real transactions additionally prove empty admission rejection,
multi-row atomic failure, valid one-row admission, history-preserving retirement,
and retired/current identity coexistence. This did not access production. Evidence:
`backend/docs/product_opportunities_v37_stage1_migration_rollback_pglite_20260828T050657Z.json`.
The exact run is now reproducible from the repository rather than depending on a
temporary operator script: `cd backend/tests/pglite_v37 && npm ci && npm test`.
The dependency is lockfile-pinned to PGlite 0.5.8; the harness binds all five SQL
SHA-256 identities and reruns baseline, post-apply, admission and complete
rollback assertions. Latest replay evidence:
`backend/docs/product_opportunities_v37_stage1_pglite_replay_20260828T061320Z.json`.
This is deliberately not concurrency or role-isolation evidence: PGlite runs in
one process, and this harness inspects RLS policy/grant definitions rather than
executing authenticated and anonymous sessions. The exact production post-apply
verifier plus bounded concurrency/role canaries remain mandatory before rollout.
The raw 238 count is PGlite-specific and is not a cross-engine release
invariant; the versioned 10/18/9/3/4/91/44 post-apply contract is authoritative.

The same exact migration/canary/rollback path was then executed against an
isolated native PostgreSQL 17.11 server bound only to `127.0.0.1:55437`. A
production SELECT-only version probe confirmed PostgreSQL 17.6, so the replay
uses the same major version without reading any business row. Two independent
native sessions proved the active-identity partial unique lock; two fixed fake
auth users proved per-user RLS, direct authenticated-write denial and anon-read
denial; the exact `P0001` sentinel rolled back every Product/Evidence/Saved row.
Before/after counts were identical, advisory locks and extra sessions were zero,
exact schema rollback left zero v63 objects, legacy fixtures were unchanged and
the harness removed its fixture roles/tables. Separate operator lifecycle
commands then dropped the fixed replay database, stopped the temporary server
and verified `pg_isready` exit 2. Native
PostgreSQL returned 158 broad catalog-query rows rather than PGlite's 238 while
both passed the authoritative 10/18/9/3/4/91/44 contract; no production gate
may assert the simulator-specific 238 count. Evidence:
`backend/docs/product_opportunities_v37_local_postgres_replay_20260828T084744Z.json`
and
`backend/docs/product_opportunities_v37_production_postgres_version_probe_20260828T083053Z.json`.
This closes native PostgreSQL concurrency/RLS semantics locally, not the
Supabase Management API multi-session platform path.

The database replay command is repository-contained and accepts only literal
loopback IPs. It requires a fresh PostgreSQL 17 database and an already-started
local server; it never reads Supabase credentials. Download/init/start and the
post-replay database drop/server stop are operator lifecycle actions outside the
harness and are explicitly labelled as such in the receipt:

```powershell
py backend/tests/postgres_v37/replay_product_opportunity_postgres_v37.py `
  --execute-local `
  --psql <portable-pg17>/bin/psql.exe `
  --host 127.0.0.1 --port <local-port> `
  --user <local-superuser> --database vibepin_v37_replay `
  --confirm "LOCAL-V37-ROLLBACK-ONLY:127.0.0.1:<local-port>:vibepin_v37_replay" `
  --report-out <local-replay-receipt.json>
```

Commits `08c22a5` and `a299a17` add and harden the missing real-PostgreSQL gate
without silently treating
catalog definitions as runtime proof. The default command is a zero-network plan.
Execution requires one reviewed Admission row plus exact project, manifest and
migration SHA-256 bindings, and `VIBEPIN_PRODUCT_STAGE2_CANARY_MODE=production`.
It opens independent sessions: one holds an uncommitted Active identity, the
second must time out on the partial unique index, and both transactions roll
back. A separate statement temporarily creates two Saved Products rows for two
existing auth users, switches to `authenticated` and `anon`, and accepts success
only when the normalized PostgreSQL error is exactly `P0001` /
`V37_ROLE_CANARY_PASS`; that deliberate exception rolls back Product, Evidence
and Saved rows. Exact Product/Saved counts must equal the pre-run baseline.
The production read-only probe
`backend/docs/product_opportunities_v37_management_api_error_shape_probe_20260828T073558Z.json`
proved that the current Management API returns a message-only wrapper with the
SQLSTATE embedded in its exact prefix. `a299a17` parses only that anchored shape
or an unambiguous structured code/message pair, rejects SQL echoes and extra
fields, and also requires the challenger to return exact HTTP 400 / `55P03` /
`canceling statement due to lock timeout` rather than a substring match. The
probe read no business row and performed no mutation; it is not concurrency or
RLS execution evidence.
The probe temporarily touches two existing user IDs inside the transaction but
never returns those IDs and persists no row. Unit orchestration and native
PostgreSQL 17 replay are PASS. The separately authorized isolated Supabase test
project replay is also PASS: exact migration, two-session lock/RLS canary and
finally rollback completed with catalog `0 -> 158 -> 0`; an independent final
SELECT found zero v3.7 relations and zero advisory locks. This closes the
Supabase platform gate only. Because that project has no production legacy
Product tables, the production legacy-integrity gate remains mandatory. Receipt:
`backend/docs/product_opportunities_v37_supabase_test_replay_20260829T021513Z.json`.

```powershell
$env:VIBEPIN_PRODUCT_STAGE2_CANARY_MODE = "production"
py backend/scripts/canary_product_opportunity_postgres_v37.py `
  --manifest <exact-one-row-reviewed-manifest.json> `
  --execute `
  --project-ref <project-ref> `
  --expected-project-ref <same-project-ref> `
  --expected-migration-sha256 6de95674b286b71ce299eb298e28312a2a632e4e1d312cd3752e005ee6d8d3d1 `
  --confirm "CANARY:<project-ref>:<manifest-sha256>:6de95674b286b71ce299eb298e28312a2a632e4e1d312cd3752e005ee6d8d3d1" `
  --report-out <local-receipt.json>
```

The Stage 1 baseline and post-apply verifier were executed against the exact
migration in PGlite and repeated in native PostgreSQL 17. The post-apply
contract proves 10 relations, 18 exact RPC/
trigger functions, 9 enabled triggers, 3 Saved Products RLS policies, 4 unique
indexes, 91 returned constraint facts (including the 28 named critical
constraints checked by the verifier), 44 grant facts, empty new tables, and unchanged
legacy row counts plus stable whole-table content checksums. Evidence:
`backend/docs/product_opportunities_v37_stage1_verifier_pglite_20260828T050657Z.json`.

A production GET-only baseline performance run at `2026-08-28T04:12:48Z`
returned 4,115 legacy Products, 34,213 snapshots, stable content checksums and
zero v63 matches in 8.2 seconds. The earlier Stage 0 baseline had 34,073
snapshots, so this 140-row increase proves that an old count cannot be reused at
cutover. This receipt is demonstration evidence only and will be stale by the
actual apply. Evidence:
`backend/docs/product_opportunities_v37_stage1_legacy_baseline_20260828T041242Z.json`.

A newer pre-authorization GET-only snapshot at `2026-08-29T02:45:47Z`, bound
to functional candidate `9a22c163`, still found zero v63 objects and 4,115
legacy Products. Legacy snapshots increased from 34,213 to 35,521, so the
content checksum also changed as expected; this is direct evidence that no old
baseline can be reused for cutover. A separate Management API GET located the
latest completed physical backup `1507104432` from `2026-08-28T14:01:57Z`.
WAL-G remains enabled, PITR remains disabled and no restore was tested. Both
receipts explicitly set `cutover_eligible=false`: refresh the backup inventory
and capture a new baseline no older than 900 seconds immediately before any
authorized migration. Evidence:
`backend/docs/product_opportunities_v37_pre_authorization_baseline_20260829T024547Z.json`
and
`backend/docs/product_opportunities_v37_pre_authorization_backup_inventory_20260829T024627Z.json`.

`run_migration.py`, the verifier and the rollback-only PostgreSQL canary are part
of the 81-artifact boundary. Apply now fails before
the Management API unless the operator explicitly supplies the target project,
the same expected target, the canonical Git-blob SQL SHA-256, and a confirmation
string binding both. CRLF/CR checkouts are normalized to repository LF before
hashing and submission, so Windows checkout bytes cannot silently create a
different evidence identity. Immediately before an authorized apply, first
capture a fresh baseline and bind its exact receipt bytes:

```powershell
$baseline = "docs/product_opportunities_v37_stage1_legacy_baseline_cutover.json"
py scripts/audit_product_opportunity_schema_v37.py baseline `
  --project-ref jaxteelkecvlozdrdoog `
  --expected-project-ref jaxteelkecvlozdrdoog `
  --expected-query-sha256 3243cc589731051f173153ff5ef68dc6ffd82af20d2b722cef19d9b4b30f3f5c `
  --candidate-sha 9a22c163cd08a4374d8aaaaf7ee6adf82ad849bc `
  --output $baseline
$baselineSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $baseline).Hash.ToLower()
```

The reviewed future migration command is:

```powershell
py scripts/run_migration.py --apply `
  --sql db/migrate_v63_product_opportunities_v1.sql `
  --project-ref jaxteelkecvlozdrdoog `
  --expected-project-ref jaxteelkecvlozdrdoog `
  --expected-sql-sha256 6de95674b286b71ce299eb298e28312a2a632e4e1d312cd3752e005ee6d8d3d1 `
  --confirm APPLY:jaxteelkecvlozdrdoog:6de95674b286b71ce299eb298e28312a2a632e4e1d312cd3752e005ee6d8d3d1
```

Do not run that command until the user separately authorizes the production
schema write and the immediately-preceding Stage 0/backup refresh is green.
After the migration transaction returns success, run the read-only verifier
before any admission, Web promotion or timer change:

```powershell
py scripts/audit_product_opportunity_schema_v37.py post-apply `
  --project-ref jaxteelkecvlozdrdoog `
  --expected-project-ref jaxteelkecvlozdrdoog `
  --expected-query-sha256 2c482caca84b779dd60d94be8f0f7010162701fea5d0abfa3d773328d69c8b43 `
  --candidate-sha 9a22c163cd08a4374d8aaaaf7ee6adf82ad849bc `
  --baseline-receipt $baseline `
  --expected-baseline-sha256 $baselineSha `
  --max-baseline-age-seconds 900 `
  --output docs/product_opportunities_v37_stage1_post_apply_cutover.json
```

Any catalog, grant, RPC signature, RLS, new-table emptiness, legacy count or
legacy content-checksum difference is `BLOCK`. The verifier preserves its raw
catalog/security contract in the receipt instead of reporting only a green flag.

1. Take the normal production database backup and prove it can be located before
   applying SQL.
2. Apply `migrate_v63_product_opportunities_v1.sql` through the approved Supabase
   migration channel. The file is transactional and does not backfill, activate,
   retire, or delete existing `pin_products` rows.
3. Read back table constraints, partial unique indexes, RLS policies, grants,
   catalog view, admission RPC, observation RPC, Primary-switch RPC, and exact
   admission rollback RPC.
4. Verify all new tables are empty and existing legacy row counts and stable
   whole-table content checksums are unchanged from a receipt no older than 15
   minutes.
5. Keep both family metric UI flags false.

Exit condition: schema exists, legacy data is byte/logically unchanged, and no
Product Opportunity is user-visible.

Schema-only rollback is allowed only while the v63 tables contain no data that
must be retained. Use the reviewed
`backend/db/rollback_v63_product_opportunities_v1.sql`; its dependency order is
tested by a real migration-then-rollback exercise. After the first admission,
leave the additive schema in place and roll back behavior, not history.

If schema-only rollback is still allowed, its separately bound command is:

```powershell
py scripts/run_migration.py --apply `
  --sql db/rollback_v63_product_opportunities_v1.sql `
  --project-ref jaxteelkecvlozdrdoog `
  --expected-project-ref jaxteelkecvlozdrdoog `
  --expected-sql-sha256 bba932a49e65b7f7f9cf2c38ebaa89a751eab7719c9e17a923abd853acdb9e3c `
  --confirm APPLY:jaxteelkecvlozdrdoog:bba932a49e65b7f7f9cf2c38ebaa89a751eab7719c9e17a923abd853acdb9e3c
```

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
4. Start with one product, then at most one 20-row batch. Compute SHA-256 over the
   exact manifest bytes and bind a manual apply to both that receipt and the exact
   project. The manual command must include
   `--expected-project-ref jaxteelkecvlozdrdoog` and
   `--confirm ADMIT:jaxteelkecvlozdrdoog:<manifest_sha256>`, in addition to
   `VIBEPIN_PRODUCT_ADMISSION_MODE=production`. A missing, malformed, stale or
   different manifest/project binding fails before database contact. The automatic
   pipeline retains its separate scheduled-run confirmation
   `VIBEPIN_PRODUCT_ADMISSION_CONFIRM=ADMIT_REVIEWED_PRODUCTS` and also requires
   `VIBEPIN_PRODUCT_ADMISSION_EXPECTED_PROJECT_REF=jaxteelkecvlozdrdoog`; its timer
   origin and exact Supply report SHA provide the source-receipt binding.
   A manual apply therefore has this exact shape (replace only the reviewed path
   and the calculated hash; do not normalize or rewrite the manifest bytes):

   ```powershell
   $manifest = "<reviewed-manifest.json>"
   $manifestSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $manifest).Hash.ToLower()
   $env:VIBEPIN_PRODUCT_ADMISSION_MODE = "production"
   py product_opportunity_admission.py --manifest $manifest --apply `
     --expected-project-ref jaxteelkecvlozdrdoog `
     --confirm "ADMIT:jaxteelkecvlozdrdoog:$manifestSha"
   ```
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
   `VIBEPIN_PRODUCT_TRACKING_CONFIRM=TRACK_ACTIVE_PRODUCTS`, plus the independent
   target binding `VIBEPIN_PRODUCT_TRACKING_EXPECTED_PROJECT_REF=<exact-project-ref>`.
   The wrapper and Python entry point must reject a missing or mismatched binding
   before inventory reads or Pinterest requests.
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
   Audit the first permanent v3.7 run with
   `product_supply_cutover_v37.py audit --require-scheduled-run --scheduled-profile launch-v37`.
   Before any apply preflight, configure
   `VIBEPIN_PRODUCT_SUPPLY_EXPECTED_PROJECT_REF=<exact-project-ref>`; both the
   wrapper and the direct Python write core fail closed when it is absent or does
   not match `SUPABASE_URL`.
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
