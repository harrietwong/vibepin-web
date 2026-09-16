# Task 7 Independent Review — Round 2

Verdict: **CHANGES REQUIRED — NOT APPROVED**

- Reviewed base: `c449e73210872eb09362662b6c9b664c199aa66b`.
- Reviewed HEAD: `aead8d05ff3dfb35df6f7ec6fec4876c2778e9a1`.
- Official integration base used by the migration probe: `04b0ebe0b7b292d6fa2432f6a064740b30314447`.
- Critical: **0**. Important: **6**. Minor: **0**.
- Review date: 2026-09-16.
- Product files, index, HEAD and branch were not modified. Only this report and two review-probe artifacts were added; they are **uncommitted**. No push, merge, deployment, production database, real Storage, real Pinterest or token refresh occurred.

## What Improved

The registered recovery suite now executes production TypeScript inspection/orchestration against real v76/v77 SQL in local PGlite. The actual GET route is exercised for four scan-to-claim races, and the actual POST route rejects a mixed image/video legacy bypass. This is a substantial improvement over the earlier predefined-RPC-response harness.

I independently reproduced the safe single-request paths: same-intent success replay, unknown-parent retry rejection, one-time failed-parent entitlement, fresh started-attempt in-progress, stale-attempt anti-redispatch, serial ready/claimed recovery, same-pass sibling continuation, image hash compatibility, and empty optional-field equivalence. However, combinations of these transitions still fail, including a duplicate external-dispatch risk.

## Important Findings

### R2-I1 — P1: Concurrent claimed recovery sends twice through one durable provider attempt

Locations: [claim reuse](D:/vp-tmp/wt-video-pin-p0-task7/web/src/lib/server/publish/v76PinterestVideoPublish.ts:309), [attempt result handling](D:/vp-tmp/wt-video-pin-p0-task7/web/src/lib/server/publish/v76PinterestVideoPublish.ts:319), [attempt RPC replay](D:/vp-tmp/wt-video-pin-p0-task7/backend/db/migrate_v76_publish_asset_materializer.sql:1742).

The new `claimed` recovery state returns the original claim token to both concurrent callers. Both can call `publish_provider_attempt_start`; SQL correctly inserts one attempt and returns `replayed:true` for the second. The orchestrator checks only `status`, ignores `replayed`, and dispatches when both results say `started`.

Independent expected-safe probe: first create a ready/claimed destination with no provider attempt, let two real wrapper calls inspect that state, then synchronize them after the real SQL attempt-start RPC. SQL returned the **same attempt id**, first with `replayed:false`, second with `replayed:true`. **Provider invocation count was 2**; both callers returned published in the deterministic mock. The assertion `dispatched === 1` failed. This can duplicate real Pins; a durable row by itself is not an exclusive dispatch right.

Required correction: dispatch only on an atomically acquired new attempt/dispatch entitlement. A replayed started attempt must remain in-progress/unknown and must not send, even if both callers inspected `claimed` before either started. Preserve lost-start-response anti-retry. Add this concurrency case to the registered SQL-backed suite.

### R2-I2 — P1: An untouched sibling still fails on the next cron pass after operational timestamp updates

Locations: [remaining revision veto](D:/vp-tmp/wt-video-pin-p0-task7/web/src/lib/server/publish/v76PinterestVideoRuntime.ts:268), [due receipt rebuild](D:/vp-tmp/wt-video-pin-p0-task7/web/src/lib/server/publish/v76PinterestVideoBindings.ts:24), [incremental writer](D:/vp-tmp/wt-video-pin-p0-task7/web/src/app/api/cron/publish-due/persistRow.ts:165), [SQL immutable replay comparison](D:/vp-tmp/wt-video-pin-p0-task7/backend/db/migrate_v76_publish_asset_materializer.sql:953).

Moving revision validation after terminal/started inspection fixes recovery of an already-unknown destination. It does not fix an untouched, ready or claimed-without-attempt destination. When one destination publishes and the next is deferred by the cron deadline, persistence advances `updated_at`. The next run rebuilds the same schedule-derived intent id with the new timestamp/fingerprint. Inspection still throws `publish_source_revision_conflict` for the untouched destination. Even simply removing that check would then hit SQL's frozen fingerprint/receipt/revision comparison.

Independent probe: publish destination A, advance only the operational timestamp, rebuild the real `buildDueVideoReceipt` for the identical draft/schedule/media/destinations, then dispatch B. Intent id stays identical, but B throws **`publish_source_revision_conflict`** and never publishes. The existing R2 test reuses the original receipt in the same run; the newer-revision test checks only a terminal unknown leg, so neither covers this required continuation.

Required correction: resume the existing owner-bound frozen receipt/source identity for an existing scheduled action, while independently detecting substantive draft/media/destination edits. Exercise an actual incremental persist followed by a new due pass and an untouched sibling. Do not regenerate a new action or erase revision checks to bypass the ledger.

### R2-I3 — P1: Real narrowed partial retries are still rejected by the v76 receipt contract

Locations: [set equality](D:/vp-tmp/wt-video-pin-p0-task7/backend/db/migrate_v76_publish_asset_materializer.sql:804), [unadapted prepare RPC input](D:/vp-tmp/wt-video-pin-p0-task7/web/src/lib/server/publish/v76PinterestVideoPublish.ts:118), [new test labelled narrowed](D:/vp-tmp/wt-video-pin-p0-task7/.superpowers/sdd/2026-09-16-video-pin-p0/task-7-review-probes.ts:113).

Parent lineage checks now correctly reject unknown parents and consume a failed destination entitlement once. But `publish_intent_confirm_prepare` still requires `publishableDestinations.length === dispatchDestinationIds.length`. A valid UI partial retry keeps both original publishable destinations while dispatching only the failed one; the production binding passes that receipt unchanged.

Independent probe: parent A publishes, parent B fails; construct the valid child receipt with both publishable destinations, `onlyPending:true`, the parent id, and dispatch ids containing only B. The real immediate receipt validator accepts it. The real wrapper/SQL then rejects **`receipt_destination_set_invalid`**. The registered “narrowed child retry” fixture has only one destination from the outset, so it is not a 2-to-1 partial retry.

Required correction: explicitly adapt/extend the v76 authorized-subset contract atomically with parent lineage, preserving receipt membership, exact account/Board matching and one-time entitlement. Test real 2-to-1 and multi-failed narrowed retries, plus attempts to include a successful/unknown sibling.

### R2-I4 — P2: A video with nonempty per-media alt text generates an invalid confirmation fingerprint

Locations: [new fingerprint field](D:/vp-tmp/wt-video-pin-p0-task7/web/src/lib/studio/publishConfirmation.ts:201), [builder's media identity omits it](D:/vp-tmp/wt-video-pin-p0-task7/web/src/lib/studio/publishConfirmation.ts:301), [validator recomputation](D:/vp-tmp/wt-video-pin-p0-task7/web/src/lib/server/publish/confirmationReceipt.ts:232).

The fingerprint now includes video `media.altText`, but `buildPublishConfirmation` constructs its fingerprint input without `altText` and returns the original media with the nonempty value. Therefore a receipt produced by the real builder already differs from the validator's canonical hash, before any user edit. The new test checks only empty/missing values and manually changes a receipt to demonstrate tamper sensitivity; it does not build a valid nonempty receipt.

Independent probe: create video media with `altText:'A green bowl on a table'` and call the real due/confirmation builder. `receipt.fingerprint !== publishConfirmationFingerprint(receipt)`. The expected equality assertion fails. Immediate publishing rejects the resulting receipt as changed after review.

Required correction: use one canonical media-identity builder in both snapshot construction and verification, including the same optional video fields. Test legitimate nonempty, trimmed, empty and missing alt/poster values through real builder plus immediate/stored validators, then meaningful tampering separately.

### R2-I5 — P2: Ready/claimed recovery still depends on the original upload instead of the frozen publish asset

Locations: [unconditional rematerialization](D:/vp-tmp/wt-video-pin-p0-task7/web/src/lib/server/publish/v76PinterestVideoPublish.ts:295), [original upload download](D:/vp-tmp/wt-video-pin-p0-task7/web/src/lib/server/publish/v76PinterestVideoRuntime.ts:157), [publish-copy write](D:/vp-tmp/wt-video-pin-p0-task7/web/src/lib/server/publish/v76PinterestVideoRuntime.ts:165).

Ready/claimed replay skips the lease and item-settlement RPCs, but still runs the original-upload materializer. It never loads the ready owner-bound `publish_assets`/delivery-item locator/checksum. Thus recovery re-downloads and tries to re-create a copy that the ledger already proved ready. If the original upload is unavailable while the frozen copy exists, the intent cannot proceed. This also creates writes outside the materialization lease on every such replay.

Independent probe: finish real SQL item materialization, inject a crash before claim, then make the mocked Storage boundary reject only `/uploads/` reads while permitting frozen `/publish/` reads. Expected recovery fails with **`source object removed`** because the production implementation selects the original source path. The current serial recovery tests retain the original source and do not assert a frozen-asset read.

Required correction: add a read-only loader for the exact owner/intent/destination ready asset graph, verify its MIME/size/checksum, and use it for ready/claimed recovery without copying/upserting again. Continue to honor actual draft cancellation/deletion and explicit source-edit policy. Cover missing/corrupt/wrong-owner frozen assets and original-upload absence separately.

### R2-I6 — P1: Editing the installed v76 migration in place makes the supported base fail its own upgrade preflight

Locations: [new expected body hashes](D:/vp-tmp/wt-video-pin-p0-task7/backend/db/migrate_v76_publish_asset_materializer.sql:30), [hash rejection](D:/vp-tmp/wt-video-pin-p0-task7/backend/db/migrate_v76_publish_asset_materializer.sql:68).

This repair changes v76 function definitions and replaces their only accepted preflight hashes with the new definitions. An existing database at the official base has the old legitimate definitions, which the revised migration now calls tampering. A normal migration runner that records v76 as applied would instead skip this changed file, leaving the old behavior in place. Neither outcome installs the repair.

Independent local upgrade probe: install the exact v76 SQL from **`04b0ebe0`**, apply current v77, use the documented v77 rollback to restore image-only v76 MIME guards, then apply revised v76. Result: **`v76_definition_tamper`**, exit 1. The v76 SQL blob at `04b0ebe0` and review base `c449e732` is identical (`577f75625ff494a60caaec29491b792e07a26543`). This is not a production-state assertion; it proves the supplied known-base upgrade path is absent. Fresh-install/reapply-of-the-new-file tests do not test that path.

Required correction: ship a separately versioned, explicitly owned upgrade migration that accepts only the known old/new manifests and preserves historical rows/privileges, plus an explicit rollback policy. Keep unknown drift fail-closed. Test old-v76-to-upgrade, upgrade twice, rollback/reapply and old/new v77 interaction; do not merely loosen all body checks.

## Closure Of The Eight Original Findings

| Original finding | Round 2 assessment |
|---|---|
| I1 unknown retry-lineage bypass | Unknown-parent rejection and once-only failed entitlement pass; legitimate narrowed partial retry remains broken (R2-I3). |
| I2 operational timestamp/source identity | Same-pass sibling and terminal unknown replay pass; next-pass untouched sibling remains broken (R2-I2). |
| I3 active started-attempt replay | Fresh already-started replay no longer poisons success; claimed-to-start concurrent recovery still duplicates dispatch (R2-I1). Stale recovery remains non-retryable. |
| I4 ready-before-claim crash | Serial ready/claimed replay passes with original source available; concurrent ownership and frozen-source recovery remain incomplete (R2-I1, R2-I5). |
| I5 unknown sibling blocks untouched sibling | Fixed for same-run unknown-first, failed-first and success-first SQL-backed cases. Next-run continuation remains blocked by I2, not the aggregate-lifecycle rule. |
| I6 scan-to-claim race | Fixed for independently run real-GET reschedule, cancel, delete and media-change cases: zero claims/meters/provider/durable dispatch. |
| I7 legacy image fingerprint | Fixed. Pinned base hash `ffc2819b87d6225015c56d27af70f4b8c2883cf8c10f9fdd5757efee6da7e54d` passes. |
| I8 empty optional canonicalization | Empty/missing equivalence passes; nonempty alt-text builder path regressed (R2-I4). |

## Independent Verification

All commands were run against the reviewed HEAD, not taken from the implementer report. The cached runner was `D:/vp-tmp/npm-cache-video-pin-p0/_npx/fd45a72a545557e9/node_modules/tsx/dist/cli.mjs`.

| Command (web cwd unless stated) | Observed result |
|---|---|
| `node <runner> scripts/test-v76-pinterest-video-recovery.ts` | 18 expected-safe production-wrapper/PGlite probes passed. |
| `node <runner> scripts/test-publish-due-video-races.ts` | 4 actual GET races passed; each had 0 claim/meter/provider/durable reads. |
| `node <runner> scripts/test-pinterest-video-legacy-route.ts` | Actual mixed-video POST rejected with `materialization_required`; 0 legacy provider calls. This single case is not exhaustive legacy-path coverage. |
| `node <runner> scripts/test-v76-pinterest-video-publish.ts` | 17 passed, 0 failed. |
| `node <runner> scripts/test-publish-due-claim.ts` | 106 passed, 0 failed. |
| `node <runner> scripts/test-publish-durable-intent.ts` | 23 passed, 0 failed. |
| `node <runner> scripts/test-publish-confirmation.ts` | 16 passed, 0 failed. |
| `node <runner> scripts/test-pinterest-video-adapter.ts` | 16 passed, 0 failed. |
| `node backend/tests/pglite_v37/verify-v76-publish-assets.mjs` (repo cwd) | 280/280, 2 rounds, exit 0. |
| `node backend/tests/pglite_v37/verify-v77-video-media.mjs` (repo cwd) | 94 assertions, exit 0. |
| `npm run typecheck` | exit 0. |
| `npm run check:test-registry` | exit 0: 242 tracked, 234 run, 8 excluded with reasons. |
| `git diff --check c449e732 aead8d05` | exit 0. |
| New `task-7-review-round2-probes.ts` | **exit 1, 5 expected-safe assertions fail**, reproducing R2-I1 through R2-I5. |
| New `task-7-review-round2-upgrade.ts` | **exit 1**, reproducing R2-I6. |

The adversarial probes compile a copy of the existing SQL harness in memory and append independent checks. They never patch production code. They are deliberately expected-safe tests that turn red on this HEAD, not scripts that call the broken behavior a pass. Dependencies outside the reviewed application remain local mocks; SQL and the affected production wrapper functions are real.

Review artifacts:

- [Adversarial regression probes](D:/vp-tmp/wt-video-pin-p0-task7/.superpowers/sdd/2026-09-16-video-pin-p0/task-7-review-round2-probes.ts).
- [Known-base migration upgrade probe](D:/vp-tmp/wt-video-pin-p0-task7/.superpowers/sdd/2026-09-16-video-pin-p0/task-7-review-round2-upgrade.ts).

No full build or browser suite was rerun for this bounded review; they cannot negate the reproduced blocking failures. Full integration gates remain the parent task's responsibility after repair.

**Ready to integrate: No.** Resolve these six Important findings and rerun the independent failing scenarios alongside the registered suite before requesting acceptance.
