# Task 1 Implementer Report — Video Media Contracts And v77

## Scope And Base

- Base required by handoff/current implementation: `654cf4f5`.
- Official final integration base: `04b0ebe0`; this Task 1 worktree has not been rebased, so final integration must rebase or cherry-pick the reviewed Task 1 sequence onto that base.
- Implementation commits: `873a98db` (`feat(video): add v77 media upload contracts`), `644e4af1` (`fix(video): harden v77 contracts`), `b66746b5` (`fix(video): close v77 review gaps`), `f6a4f1f7` (`fix(video): verify complete v77 catalog`), and `82584627` (`fix(video): validate v77 privilege manifests`).
- Worktree/branch: `D:/vp-tmp/wt-video-pin-p0-0916-integrated`, `codex/video-pin-p0-0916-integrated`.

## Changed Files

- `backend/db/migrate_v77_video_media.sql`
- `backend/db/rollback_v77_video_media.sql`
- `backend/tests/pglite_v37/verify-v77-video-media.mjs`
- `backend/tests/pglite_v37/package.json`
- `web/src/lib/contentDraftModel.ts`
- `web/src/lib/pinDraftStore.ts`
- `web/scripts/test-content-media-model.ts`

## RED Evidence

1. Command: `node verify-v77-video-media.mjs` from `backend/tests/pglite_v37`.
   Expected and observed failure: `ENOENT` for `backend/db/migrate_v77_video_media.sql`; the v77 migration/rollback did not yet exist.
2. The video media contract test was added before the production discriminant. A full `npm run typecheck` RED attempt was interrupted by the parent task's tool interruption before it returned a compiler result, so no unobserved TypeScript failure is claimed here.
3. Review-fix RED runs: the actual store path aliased `imageUrl` to `private://binary.mp4`; PGlite reproduced changed-fact replay acceptance, terminal-batch revival, NULL verified MIME acceptance, and missing v77 collision checks. The new regressions failed before the corresponding fixes.
4. Round-2 RED runs: splitContentMedia and non-cover image generation bypassed the poster alias; PGlite accepted same-name `CHECK (true)`, default/nullability drift, a marked altered v77 RPC, and service-role direct finalized rows with missing facts.
5. Round-3 RED command: `node backend/tests/pglite_v37/verify-v77-video-media.mjs`. Expected and observed result: `{ "verdict": "fail", "assertions": 80 }`, first failure `batch owner nullability drift rejects a marked/same-name collision without row mutation`. This proved the former piecemeal preflight accepted the reviewed drift; the remaining table-driven scenarios were intentionally fail-fast behind it. The new media-store event/localStorage test was added before changing the split creation path.
6. Round-4 RED command: `node verify-v77-video-media.mjs` from `backend/tests/pglite_v37`. Expected and observed result: `{ "verdict": "fail", "assertions": 72 }`, `v77_schema_collision` at ordered apply → rollback → reapply. This reproduced the old active-only service DML inventory rejecting the rollback's documented SELECT-only state. New pre-fix collision regressions cover authenticated TRUNCATE, authenticated column UPDATE, authenticated finalize EXECUTE, and service grant-option drift.

## GREEN Evidence

1. Final independent long-timeout `node backend/tests/pglite_v37/verify-v77-video-media.mjs` — exit 0; `{ "verdict": "pass", "assertions": 94, "failures": [] }`.
2. Final `npx tsx scripts/test-content-media-model.ts` — exit 0; `23 passed, 0 failed`.
3. Final `web/node_modules/.bin/tsc.cmd --noEmit` — exit 0; completed without output/errors.
4. `npm run test:v76-publish-assets` — exit 0; 2 rounds, 280/280 assertions passed.
5. `npm run test:v75-media-provenance` — exit 0; 65 assertions, zero failures, and the expected `deployment_blocked` verdict for the pre-existing broad permissive `storage.objects` policy.

## Delivered Contract

- `ContentMedia` is an image/video discriminated union; image fields serialize unchanged, while video carries optional `durationMs` and a poster-only legacy-image alias.
- Store create/load/sync-normalization, splitContentMedia, completeGeneratedDraft, and media mutation write paths keep `PinDraft.imageUrl` on a video poster and never copy a video binary URL into it.
- v77 adds RLS-protected, service-role-only upload batch/item ledgers with owner-scoped idempotency, ordinal cap of 20, private paths, declared/verified facts, lifecycle/error/timestamp/expiry fields.
- v77 additively enriches `media_asset_provenance`; pre-v77 rows default to `media_kind='image'` with no invented facts.
- Service-only prepare/finalize RPCs enforce the frozen video MIME allowlist and 100 MiB bound. The parent batch owner is checked before an item can be prepared/finalized; terminal batches cannot be revived, matching prepare replays survive progress, and every declared/verified fact is replay-bound.
- v77 preflight rejects drifted provenance types/defaults, nullability, same-name altered constraints/indexes, and marked/unmarked RPC body/security/overload collisions. Reapply compares a complete explicit inventory of both ledger tables' columns/defaults/nullability, exact owned PK/UNIQUE/FK/CHECK definitions, standalone indexes, RLS/no-policy state, and server-only privileges; additive provenance fields and discriminator constraint are equally exact. Rollback performs the same exact v76 validation before restoring the original image-only definitions.
- The privilege inventory recognizes exactly two immutable ledger states: active v77 (service-role SELECT/INSERT/UPDATE/DELETE and v77 RPC EXECUTE only) and nondestructive rollback (service-role SELECT only, no v77 RPC EXECUTE). It rejects all other table privileges including TRUNCATE/REFERENCES/TRIGGER, direct column ACLs, grant options, public/client access, and function EXECUTE drift before any revoke/grant can conceal it.
- `splitContentMedia` now mints the child media id before its first persist/event, starts the child with the real video media discriminant, and uses only `posterUrl` for the legacy `imageUrl` alias. The regression captures every event/localStorage snapshot to prove no intermediate binary-as-image row exists.
- v76 materialization settlement MIME guards accept exactly `video/mp4`, `video/x-m4v`, and `video/quicktime` in addition to existing image types; the existing private-bucket, provenance, owner, revision, checksum, lease, claim, and settlement code remains in place.
- Rollback is non-destructive: it retains complete rows/schema facts, revokes write access, restores the exact original v76 image-only definitions, and permits a safe v77 reapply. The finalized-row CHECK is wrapped in `IS TRUE`, so even service-role direct INSERT/UPDATE cannot persist a finalized row missing any required verified fact. Expiry errors no longer claim a state mutation that the surrounding exception would roll back.

## Out Of Scope

- No API route, browser uploader, Storage provider adapter, UI rendering, Pinterest adapter, real database/Storage/Pinterest calls, migration deployment, push, or merge.

## Known Risks

- The v75 broad legacy Storage policy remains a deliberate deployment blocker. This task preserves its verifier evidence and does not claim deployability.
- v77 updates the two v76 settlement function bodies to widen MIME validation. A direct re-run of the immutable v76 migration while v77 is installed is intentionally not supported; use the ordered rollback/reapply path so v77 rollback restores the exact v76 bodies first.
- Video dimensions, duration, MIME, checksum, and byte size are recorded as declared/verified contract fields. The actual upload/probe/provider adapters that supply verified facts are owned by later tasks.
- Final integration must rebase or cherry-pick the reviewed Task 1 commits onto official base `04b0ebe0`; this report does not claim that integration has occurred.
