# Task 2 Implementer Report — Atomic Finalization Remediation

## Scope And Base

- Review baseline: `5f5fe502968f96effb7fc9be9b9fd372d6520512`.
- Atomic-state/fact-contract implementation commit: `d47f6bcddd9164b680fbdffae286adec387fda04`.
- Branch/worktree: `codex/video-pin-p0-0916-final` / `D:/vp-tmp/wt-video-pin-p0-0916-final`.
- This remediation closes review findings C1, I1, and I2. It also retains the earlier terminal prepare replay guard from I4 and adds production store/Storage adapter coverage relevant to I7.

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

## TDD Evidence

- RED: v77 verifier failed because `video_upload_item_claim` did not exist (53 assertions reached).
- RED: finalized rows without provenance were still accepted (71 assertions reached).
- RED: an item failure immediately blocked a sibling claim with `video_upload_batch_not_finalizable` (73 assertions reached).
- RED: handler claim-before-Storage test returned 503 instead of 200.
- RED: production Storage adapter exposed uploader-controlled SHA metadata (`true !== false`).
- GREEN: `verify-v77-video-media.mjs` reports `verdict: pass`, 112 assertions, no failures.
- GREEN: `test-video-upload-private.ts` reports 18 passed, 0 failed on two final runs.

## Verification

- v77 PGlite: 112/112, pass; covers apply twice, owner isolation, active claim competition, lease takeover, stale-owner denial, partial sibling completion, atomic provenance rollback, fact labels, replay completeness, rollback/reapply, and active/rollback privilege manifests.
- v76 PGlite: 280/280 across two rounds, pass.
- v75 PGlite: 65 assertions with no failures; expected pre-existing `deployment_blocked` result remains for the legacy broad Storage policy.
- Media privacy architecture: 16/16, pass.
- Focused private video upload: 18/18, pass twice after final production changes.
- Test registry: 239 tracked, 231 run by `npm test`, 8 documented exclusions.
- `npm run typecheck`: exit 0.
- `git diff --check`: exit 0 before the implementation commit; the follow-up report-only diff is also clean.

## Remaining Review Items

- I3 remains: the production `/api/storage-media` route still authenticates bearer-only, so native cookie-authenticated `<video>` playback needs route wiring and tests.
- I4 remains partially open: terminal/expired replay no longer re-signs, but signed-capability lifetime reconciliation, delayed cleanup after successful removal, and the delete-plus-outbox double-failure contract still need design/implementation.
- I5 remains: initial Range status/Content-Range and a structurally valid ISO-BMFF `ftyp` box/brand still need stricter validation and fixtures.
- I6 remains: playback proxy must validate upstream MIME/status/Content-Range/total and detect short streams.
- I7 is improved through production store/Storage adapter tests and PGlite lifecycle tests, but production route wiring tests are still required with I3/I5/I6.
- Client-side full-file hashing/memory behavior remains a non-blocking follow-up.

## External-Call Attestation

All verification used local PGlite, injected adapters, and mocked `Response` objects. No real Supabase database, Storage, Pinterest, provider token, migration application, deployment, push, merge, or Production mutation occurred. Review package files and `node_modules` were not committed.
