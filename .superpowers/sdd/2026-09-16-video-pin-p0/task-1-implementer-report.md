# Task 1 Implementer Report — Video Media Contracts And v77

## Scope And Base

- Base required by handoff: `654cf4f5`.
- Implementation commit: `873a98db` (`feat(video): add v77 media upload contracts`).
- Worktree/branch: `D:/vp-tmp/wt-video-pin-p0-0916-integrated`, `codex/video-pin-p0-0916-integrated`.

## Changed Files

- `backend/db/migrate_v77_video_media.sql`
- `backend/db/rollback_v77_video_media.sql`
- `backend/tests/pglite_v37/verify-v77-video-media.mjs`
- `backend/tests/pglite_v37/package.json`
- `web/src/lib/contentDraftModel.ts`
- `web/scripts/test-content-media-model.ts`

## RED Evidence

1. Command: `node verify-v77-video-media.mjs` from `backend/tests/pglite_v37`.
   Expected and observed failure: `ENOENT` for `backend/db/migrate_v77_video_media.sql`; the v77 migration/rollback did not yet exist.
2. The video media contract test was added before the production discriminant. A full `npm run typecheck` RED attempt was interrupted by the parent task's tool interruption before it returned a compiler result, so no unobserved TypeScript failure is claimed here.

## GREEN Evidence

1. `npm run test:v77-video-media` — exit 0; `{ "verdict": "pass", "assertions": 24, "failures": [] }`.
2. `npx tsx scripts/test-content-media-model.ts` — exit 0; `20 passed, 0 failed`.
3. `npm run typecheck` — exit 0; `tsc --noEmit` completed without output/errors.
4. `npm run test:v76-publish-assets` — exit 0; 2 rounds, 280/280 assertions passed.
5. `npm run test:v75-media-provenance` — exit 0; 65 assertions, zero failures, and the expected `deployment_blocked` verdict for the pre-existing broad permissive `storage.objects` policy.

## Delivered Contract

- `ContentMedia` is an image/video discriminated union; image fields serialize unchanged, while video carries optional `durationMs`.
- v77 adds RLS-protected, service-role-only upload batch/item ledgers with owner-scoped idempotency, ordinal cap of 20, private paths, declared/verified facts, lifecycle/error/timestamp/expiry fields.
- v77 additively enriches `media_asset_provenance`; pre-v77 rows default to `media_kind='image'` with no invented facts.
- Service-only prepare/finalize RPCs enforce the frozen video MIME allowlist and 100 MiB bound. The parent batch owner is checked before an item can be prepared/finalized.
- v76 materialization settlement MIME guards accept exactly `video/mp4`, `video/x-m4v`, and `video/quicktime` in addition to existing image types; the existing private-bucket, provenance, owner, revision, checksum, lease, claim, and settlement code remains in place.
- Rollback is non-destructive: it retains rows/schema, revokes write access, restores v76's original image-only functions, and permits a safe v77 reapply.

## Out Of Scope

- No API route, browser uploader, Storage provider adapter, UI rendering, Pinterest adapter, real database/Storage/Pinterest calls, migration deployment, push, or merge.

## Known Risks

- The v75 broad legacy Storage policy remains a deliberate deployment blocker. This task preserves its verifier evidence and does not claim deployability.
- v77 updates the two v76 settlement function bodies to widen MIME validation. A direct re-run of the immutable v76 migration while v77 is installed is intentionally not supported; use the ordered rollback/reapply path so v77 rollback restores the exact v76 bodies first.
- Video dimensions, duration, MIME, checksum, and byte size are recorded as declared/verified contract fields. The actual upload/probe/provider adapters that supply verified facts are owned by later tasks.
