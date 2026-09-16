# Task 2 Implementer Report — Atomic Finalization And Review Remediation

## Scope And Base

- Review baseline: `5f5fe502968f96effb7fc9be9b9fd372d6520512`.
- Atomic-state/fact-contract implementation commit: `d47f6bcddd9164b680fbdffae286adec387fda04`.
- Round-1 continuation base: `1c9f4615aa30e9b70b270b1d72b53b52e0e07a35`.
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
- GREEN: `verify-v77-video-media.mjs` reports `verdict: pass`, 116 assertions, no failures.
- GREEN: `test-video-upload-private.ts` reports 27 passed, 0 failed after the final production/client/cleanup tests.

## Verification

- v77 PGlite: 116/116, pass; additionally covers durable capability cleanup creation, delayed scheduling, atomic successful settlement, failure preservation, cleanup evidence across rollback/reapply, and rollback rejection of capability-expiry shape drift before privilege mutation.
- v76 PGlite: 280/280 across two rounds, pass.
- v75 PGlite: 65 assertions with no failures; expected pre-existing `deployment_blocked` result remains for the legacy broad Storage policy.
- Media privacy architecture: 16/16, pass.
- Pinterest video adapter: 16/16, pass.
- Focused private video upload: 27/27, pass after final production changes.
- Test registry: 239 tracked, 231 run by `npm test`, 8 documented exclusions.
- `npm run typecheck`: exit 0.
- `git diff --check`: exit 0 before the implementation commit; the follow-up report-only diff is also clean.

## Remaining Review Items

- None from the supplied C1/I1-I7 and Minor review list. The known v75 deployment blocker remains external to Task 2: a pre-existing broad permissive `storage.objects` policy must be audited before deployment.

## External-Call Attestation

All verification used local PGlite, injected adapters, and mocked `Response` objects. No real Supabase database, Storage, Pinterest, provider token, migration application, deployment, push, merge, or Production mutation occurred. Review package files and `node_modules` were not committed.
