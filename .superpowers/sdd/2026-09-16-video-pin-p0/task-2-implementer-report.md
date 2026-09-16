# Task 2 Implementer Report — Atomic Finalization And Review Remediation

## Scope And Base

- Review baseline: `5f5fe502968f96effb7fc9be9b9fd372d6520512`.
- Atomic-state/fact-contract implementation commit: `d47f6bcddd9164b680fbdffae286adec387fda04`.
- Round-1 continuation base: `1c9f4615aa30e9b70b270b1d72b53b52e0e07a35`.
- Round-2 remediation base: `c65e0f802fb95bb972d8515229c391a43af29f7d`.
- Round-3 late-upload remediation base: `3b6b11239562189cae00cf7e882bad9c89ca7d4a`.
- Branch/worktree: `codex/video-pin-p0-0916-final` / `D:/vp-tmp/wt-video-pin-p0-0916-final`.
- This continuation closes the remaining review findings I3, I4, I5, I6, and I7, plus the stable-error and 100 MiB browser-digest minors. It preserves the earlier C1/I1/I2 atomic state/fact work.

## Implemented Contract

- v77 now owns `finalize_claim_token` and `finalize_claim_expires_at`, plus service-only claim/finalize/fail RPCs with catalog hashes and explicit active/rollback privilege manifests.
- Claim is owner/batch/ordinal scoped. One active claimant may inspect Storage; an expired lease can be taken over, and the stale claimant can no longer finalize, mark failure, or receive object-cleanup authority.
- Failure and object deletion are coupled: the handler deletes only after the atomic fail RPC returns `cleanupAllowed=true` for the same live claim. A concurrent winner or lost claim therefore cannot have its object removed by a loser.
- Final facts and ready video provenance are written in the same database transaction. A provenance collision rolls back the item lifecycle/facts; successful replay requires complete matching provenance and performs no Storage read.
- Finalized upload rows require Storage-verified MIME/byte size, allow verified checksum to remain `NULL`, and require verified width/height/duration to remain `NULL`. Browser checksum/dimensions/duration stay in declared columns.
- Video provenance records explicit trust labels: `storage_head_verified` for MIME/bytes, `storage_digest_verified` or `unavailable` for checksum, and `browser_declared` for dimensions/duration.
- The production Supabase adapter ignores uploader-controlled `x-amz-meta-sha256`. It exposes no verified checksum until a genuinely trusted digest source exists.
- Shared TypeScript limits enforce duration from 4,000 through 300,000 ms; v77 independently enforces the same database boundary.
- Batch lifecycle supports partial outcomes: a failed item does not block an independently claimed sibling from finalizing; the batch settles to failed only after no prepared/finalizing items remain.
- `/api/storage-media` now uses the existing verified bearer-or-cookie identity helper. Every private response, including errors and 416, varies on `Cookie, Authorization, Range`.
- Playback validates the Storage response status, normalized MIME, exact `Content-Range` start/end/total, declared byte total, and body length. A no-Range client request may accept a full 200 only with no `Content-Range` and an exact `Content-Length`; short or oversized streams error closed.
- Finalize requires a real 206 initial range whose status, MIME, `Content-Range`, total, and actual bytes match the request. ISO-BMFF validation now parses a complete `ftyp` box, including a present minor-version field and an allowed major/compatible brand; offset-four magic alone is rejected.
- Supabase's fixed two-hour upload capability is reflected in the shared server ledger TTL. Before every capability issue/reissue, `video_upload_item_prepare` atomically extends `capability_expires_at` and upserts a delayed, deduplicated `media_cleanup_outbox` responsibility. Failure preserves that pending responsibility in the same transaction before granting cleanup authority; finalize atomically settles it `done`. Immediate deletion is best-effort and cannot erase delayed recheck responsibility.
- Round 2 makes cleanup authority and finalization mutually exclusive. The generic v76 cleanup lease now passes through a v77 database trigger that locks the matching upload item before granting a lease. A live finalize claim or finalized item rejects cleanup; a successful cleanup lease atomically moves the item to the terminal, non-finalizable `cleaning` state before external deletion authority can escape. Claim, prepare/reissue, capability settlement, and finalize cannot revive that state.
- The post-sign capability confirmation RPC is owner/batch/ordinal scoped and service-only. It moves the cleanup boundary from the actual provider issuance time, retains a five-minute settle grace beyond the two-hour capability, and refuses to reveal a signed token unless the pending cleanup responsibility was durably confirmed.
- The provenance source constraint now wraps the complete video predicate in `IS TRUE`, so every required value/source `NULL` fails closed rather than passing through SQL `UNKNOWN`. Migration collision detection, rollback preflight, and function/trigger manifests enforce the exact contract. Playback independently rejects missing, unknown, or contradictory source labels.
- The production store contract now observes the real Supabase query builder and requires the exact `owner_user_id`, `batch_id`, and `ordinal` predicates; database query errors propagate as the stable `video_upload_store_error`.
- Round 3 gives a 100 MiB browser upload a hard 15-minute AbortController deadline. The direct client mirrors the installed Storage SDK's signed-upload wire contract: PUT to the verified signed URL, `FormData` with `cacheControl=3600` and the file under the empty field name, `x-upsert: false`, and no manually supplied multipart boundary. Signed bucket/path/token mismatches fail before dispatch, and neither capability value is logged.
- Deadline expiry and caller abort are distinct stable client outcomes (`video_upload_timeout` / `video_upload_aborted`). Both attempt the finalize endpoint so the server can accelerate failure cleanup; that notification is not the cleanup root, so its own failure cannot lose the responsibility created during prepare.
- `capability_expires_at` now records the actual two-hour provider capability boundary. The new required `late_upload_recheck_after` records capability expiry plus the 15-minute maximum request and five-minute commit-visibility/finalization tail; the batch ledger covers the complete 2h20m interval.
- The v77 cleanup trigger now prevents every early video cleanup `done` or `failed` settlement from terminating the responsibility. It converts the result back to pending at `late_upload_recheck_after`; only a worker lease and fresh Storage observation after that boundary may settle done. An early absence followed by a late object therefore produces a second lease that removes the object before termination.
- Stable database conflict/expiry/state errors map to stable HTTP codes instead of collapsing to a provider 502.
- Browser SHA-256 now consumes `Blob.stream()` with an incremental constant-memory implementation; it no longer allocates an entire 100 MiB `ArrayBuffer`.
- Focused tests import the production route, store, Supabase Storage adapter, and browser upload client, and assert verified auth wiring, owner propagation, token/path/bucket preservation, and `upsert: false`. PGlite owns lifecycle, rollback, and privilege coverage.

## TDD Evidence

- RED: v77 verifier failed because `video_upload_item_claim` did not exist (53 assertions reached).
- RED: finalized rows without provenance were still accepted (71 assertions reached).
- RED: an item failure immediately blocked a sibling claim with `video_upload_batch_not_finalizable` (73 assertions reached).
- RED: handler claim-before-Storage test returned 503 instead of 200.
- RED: production Storage adapter exposed uploader-controlled SHA metadata (`true !== false`).
- RED: prepare ledger expired at 15 minutes instead of the provider capability's two hours.
- RED: v77 had no `capability_expires_at` column or durable capability cleanup row.
- RED: a stable item-idempotency conflict returned 502 instead of 409.
- RED: bearer-only production route wiring, incorrect `Vary`, malformed/truncated/fake-brand `ftyp`, upstream 500/wrong range, playback MIME/range/total lies, and short streams were accepted by the prior focused contract.
- RED: browser SHA-256 invoked the test Blob's forbidden whole-file `arrayBuffer()`.
- RED: rollback accepted `capability_expires_at` nullability drift and revoked service writes instead of stopping before mutation.
- RED (Round 2): focused tests failed with `store.confirmCapability is not a function` before post-sign settlement existed.
- RED (Round 2): v77 stopped at assertion 65 because a video provenance insert with `NULL` fact values/sources still passed the database constraint.
- RED (Round 2): production store query-shape tests exposed the absence of observable owner/batch/ordinal filtering and stable query-error propagation.
- RED (Round 3): focused upload-ledger coverage observed `02:05:00` instead of the required `02:20:00` terminal window.
- RED (Round 3): v77 failed at assertion 33 because `late_upload_recheck_after` did not exist in the owned schema.
- RED (Round 3): the production client dispatched a signed URL whose token contradicted the separately returned token instead of failing before network work.
- GREEN: `verify-v77-video-media.mjs` reports `verdict: pass`, 134 assertions, no failures.
- GREEN: `test-video-upload-private.ts` reports 30 passed, 0 failed after the final production/store/cleanup tests.
- GREEN (Round 3): `verify-v77-video-media.mjs` reports `verdict: pass`, 140 assertions, no failures.
- GREEN (Round 3): `test-video-upload-private.ts` reports 31 passed, 0 failed.

## Verification

- v77 PGlite: 140/140, pass; additionally covers durable capability cleanup creation, post-sign delayed scheduling, active-claim-versus-cleanup barriers in both acquisition orders, early absence rescheduling, a simulated late Storage object and mandatory post-tail deletion, the terminal `cleaning` state, atomic successful settlement, failure preservation, fail-closed provenance `NULL`/source collisions, trigger/function privilege manifests, cleanup evidence across rollback/reapply, and rollback rejection of capability-expiry, late-recheck, or provenance shape drift before mutation.
- v76 PGlite: 280/280 across two rounds, pass.
- v75 PGlite: 65 assertions with no failures; expected pre-existing `deployment_blocked` result remains for the legacy broad Storage policy.
- Media privacy architecture: 16/16, pass.
- Pinterest video adapter: 16/16, pass.
- Focused private video upload: 31/31, pass after final production changes, including production store query shape/error behavior, playback source-label rejection, exact abortable signed-upload transport, and timeout/abort cleanup notification.
- Test registry: 239 tracked, 231 run by `npm test`, 8 documented exclusions.
- `npm run typecheck`: exit 0.
- `git diff --check`: exit 0 before the implementation commit; the follow-up report-only diff is also clean.

## Remaining Review Items

- None from the supplied C1/I1-I7 and Minor review list. The known v75 deployment blocker remains external to Task 2: a pre-existing broad permissive `storage.objects` policy must be audited before deployment.

## External-Call Attestation

All verification used local PGlite, injected adapters, and mocked `Response` objects. No real Supabase database, Storage, Pinterest, provider token, migration application, deployment, push, merge, or Production mutation occurred. Review package files and `node_modules` were not committed.
