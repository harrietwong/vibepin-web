# Task 3 — Video Cover Frame Contract

Implemented on accepted base `6c8589f3` in `D:/vp-tmp/wt-video-pin-p0-0916-final`. No migrations, dependencies, pushes, merges, deployment, or live provider operations.

## Behavior and invariants

- `ContentVideoMedia.coverFrameTimeMs` is optional and is the only cover timestamp. Absence preserves Pinterest's numeric `1` second default and the existing fingerprint shape. Explicit zero, 1000, fractional milliseconds, and exact duration are preserved; negative, nonfinite, nonnumeric, unknown-duration explicit selections, and values beyond duration fail closed.
- The actual single-video strip action is now **Choose cover frame**. A native modal dialog contains a real private video player, labelled range bounded by media duration, readable millisecond-precision time, Cancel, Confirm, loading state, and retryable error. Native modal focus confinement and restoration are used; Escape is cancelled while committing. Scrubbing and Cancel never upload or mutate the draft.
- Confirm pauses/seeks the video and waits for seek/decode before canvas capture. The JPEG is capped to a 2048-pixel longest side and uploaded using generic `uploadPinImage(file)` with exactly one argument. The finalized v80 batch/ordinal association is never reused and the replacement path never calls v80 cleanup.
- Capture/upload failure leaves both prior poster and time intact. The commit checks original owner/workspace and current video URL, poster, time, and duration after asynchronous work, so a newer edit/owner switch cannot be overwritten.
- `replaceVideoPoster` performs one media-store write, updates `imageUrl`, and preserves media id/order, cover identity, video URL, width, height, duration, source, alt text, and unrelated fields. Its revision advances monotonically even when the local clock is behind, ensuring the write-through engine notices the edit.
- The timestamp flows through confirmation fingerprints, server receipt validation, v76 source fingerprint and exact runtime identity, the production Pinterest binding, and the adapter. Pinterest receives validated milliseconds divided by 1000, without integer rounding. Old confirmations fail after a cover change even when the operational revision is held constant.
- The card's existing shared renderer receives the new poster. The existing AI-copy generator waits for the selected media to be acknowledged durably before continuing, and uses the selected poster input. A local-only state, deferred write, rejected write, stale receipt, stopped/changed owner, or legacy ambiguous 200 response cannot establish readiness. Only startup server reads and explicit per-draft `applied` acknowledgements do so.
- The server AI evidence test loads the actual payload persisted by the sync test server and resolves only the new private poster path; no video bytes/URL are sent to image analysis.

## RED / GREEN evidence

1. `npx tsx scripts/test-video-cover-frame.ts`: RED reported missing dedicated mutation and identical cover-change fingerprints. GREEN covers field preservation, persisted reload, valid/invalid times, client/server receipt behavior, and durable source fingerprints.
2. `npx tsx scripts/test-pinterest-video-adapter.ts`: after correcting the new fixture to use the adapter's established `201`/`succeeded` protocol, RED was the real `1 !== 0` timestamp defect. GREEN: 17 tests, including explicit zero/fractional/end values and no provider dispatch for invalid input.
3. `npx tsx scripts/test-video-cover-selection.ts`: RED reported missing confirmation transaction. GREEN exercises capture/upload failures, generic single-argument replacement, successful atomic commit, stale concurrent edit rejection, real seek/canvas orchestration with browser API boundaries injected, and the AI generator refusing a merely local cover.
4. The same selection test renders the real `ContentMediaStrip` through React server rendering. RED showed the old `Use video 1 as cover`/`Video cover` action; GREEN observes the accessible `Choose cover frame` action.
5. `npx tsx scripts/test-pin-draft-sync.ts`: RED first showed missing durable media acknowledgement. GREEN demonstrates that deferred writes cannot authorize AI, a successful server write can, and durable AI evidence resolves the new poster. A later RED (`true == false`) caught an ambiguous legacy stale success being counted as persisted; GREEN rejects it. Final result: 39 passed.
6. Focused real Chromium interaction initially hit a first-build Studio navigation timeout (environment, not feature evidence). The warmed browser run caught a real asynchronous `timeupdate` race: expected `1250`, received `0`. Keeping the range selection authoritative fixed it. GREEN: one real dialog interaction test, 34.1 seconds, including cancel/focus restoration, upload error/retry, multipart association exclusion, updated rendered poster, and zero cleanup calls.
7. Added a focused monotonic-revision regression: RED showed a cover edit moving backwards behind its stored revision; GREEN passes after advancing only the cover mutation's revision.

During combined sync/AI testing, the old test window shim incorrectly dispatched every event to every listener. Loading the real server evidence module exposed its erroneous dispatch of a draft event to Supabase's visibility listener. The test shim now dispatches by event type; production behavior was not changed for this harness issue.

## Verification commands

All commands run from `D:/vp-tmp/wt-video-pin-p0-0916-final/web`; external boundaries are mocked/local.

```powershell
npx tsx scripts/test-video-cover-frame.ts
npx tsx scripts/test-video-cover-selection.ts
npx tsx scripts/test-content-media-model.ts
npx tsx scripts/test-pin-draft-sync.ts
npx tsx scripts/test-pinterest-video-adapter.ts
npx tsx scripts/test-v76-pinterest-video-publish.ts
npx tsx scripts/test-v76-pinterest-video-recovery.ts
npx tsx scripts/test-video-upload-private.ts
npx tsx scripts/test-video-media-rendering.ts
npx tsx scripts/test-ai-copy-v2-video-cover.ts
npx tsx scripts/test-ai-copy-v2-video-cover-hardening.ts
npx tsx scripts/test-ai-copy-v2-video-cover-production-boundaries.ts
npx tsx scripts/test-publish-confirmation.ts
npx tsx scripts/test-video-batch-safety.ts
npx tsx scripts/test-video-batch-safety-round3.ts
npx tsx scripts/test-video-batch-runtime.ts
npx tsx scripts/test-pin-draft-promote.ts
npx tsx scripts/test-pin-draft-conditional-write.ts
npm run typecheck
```

Browser command:

```powershell
$env:NEXT_PUBLIC_SUPABASE_URL='http://127.0.0.1:54321'
$env:PLAYWRIGHT_TEST_BASE_URL='http://localhost:3037'
npx playwright test tests/e2e/video-batch-upload.spec.ts --project=chromium --grep 'cover frame dialog' --reporter=list
```

The local app was started on port 3037 with `E2E_TEST_MODE=true`, `NEXT_PUBLIC_VIDEO_PIN_UPLOAD=true`, the same loopback Supabase URL, and dummy local keys. The existing Task 2 mock isolation harness fences all external requests and intercepts app APIs. This is a UI integration test, not a claim of real Supabase/Pinterest acceptance. Relevant local Next 16 `use-client` docs and the E2E testing guide were read. Next's automatic `web/AGENTS.md` rewrite was restored and excluded from the task changes.

## Changed files

- `web/src/lib/contentDraftModel.ts`, `web/src/lib/videoCoverFrame.ts`: field and shared validation/default.
- `web/src/lib/pinDraftStore.ts`: atomic poster-only mutation and cover revision.
- `web/src/lib/studio/videoBrowserMedia.ts`: explicit capture and replacement transaction.
- `web/src/components/studio/VideoCoverFrameDialog.tsx`, `web/src/components/studio/ContentMediaStrip.tsx`: actual modal and action.
- `web/src/lib/pinDraftSync.ts`, `web/src/lib/ai-copy/generatePinCopy.ts`: durable media acknowledgement and AI gate.
- `web/src/lib/studio/publishConfirmation.ts`, `web/src/lib/server/publish/confirmationReceipt.ts`: timestamp identity and validation.
- `web/src/lib/server/publish/v76PinterestVideoPublish.ts`, `web/src/lib/server/publish/v76PinterestVideoRuntime.ts`, `web/src/lib/server/publish/v76PinterestVideoServer.ts`, `web/src/lib/server/pinterest/videoPinAdapter.ts`: durable identity, production forwarding, precise seconds.
- `web/scripts/test-video-cover-frame.ts`, `web/scripts/test-video-cover-selection.ts`, `web/scripts/test-pin-draft-sync.ts`, `web/scripts/test-pinterest-video-adapter.ts`, `web/scripts/test-v76-pinterest-video-publish.ts`, `web/scripts/test-registry.ts`, `web/tests/e2e/video-batch-upload.spec.ts`: behavior regressions and registry.

## Storage retention and limitations

P0 deliberately retains old poster objects. Each accepted replacement adds one JPEG (longest side at most 2048 pixels, and subject to the existing 12 MiB upload cap); a successfully uploaded object abandoned by a concurrent edit is retained too. This bounds the cost per replacement, not the lifetime number of replacements. There is no new delete capability, lifecycle migration, or background cleanup. Future reclamation must verify draft references and owner authority before deletion.

The selector requires the video's known persisted duration and browser decode support. Unsupported video decode/canvas failures surface as retryable errors. Frame choice is subject to browser codec/frame-seek precision; the requested milliseconds remain authoritative for Pinterest. The legacy server response shape without explicit per-draft outcomes intentionally cannot authorize a new cover for AI until a server read confirms it (normally a reload); the current route supplies explicit outcomes. No live provider publication was performed.

## Self-review

Checked optional timestamp compatibility (no added null field in old fingerprints), exact zero handling, subsecond units, inclusive duration, invalid-value rejection, server validation, image receipt compatibility, identity preservation, no upload on scrub/cancel, no finalized association reuse, no replacement cleanup, no private capability in user errors, durable AI evidence, owner/concurrent-edit checks, and test registration. Existing upload/auth/queue code was not refactored. No known blocker remains in the implemented scope.

## Fix round 1 — authoritative slider and component lifetime

Reviewer found that native play/seek controls could display a different frame while the saved selection still came from the range value. Removed native controls from the real preview video and excluded it from keyboard focus; the labelled, keyboard-operable range is now the sole frame-selection control. Preview and capture both seek from that same range value.

The dialog now owns an AbortController for its mount lifetime. Unmount aborts pending capture waits and revokes the transaction's right to upload/commit. A generic upload already in flight may finish, but its result cannot mutate the draft after unmount; error/loading state and the close callback are not updated after cancellation. The established P0 retention policy applies to any already-uploaded abandoned image. No new upload/delete capability was added.

RED evidence:

- The real Chromium test expected preview `controls === false` and received `true`.
- The focused transaction test aborted its component-lifetime signal during capture and reported `Missing expected rejection: unmount during capture must not commit`.

Expanded coverage:

- The real browser test checks absence of native controls, verifies clicking the video does not play it, uses ArrowRight/ArrowLeft on the slider, asserts the actual video `currentTime` follows 1.251 then 1.250 seconds, and observes the real canvas `drawImage` capture times (1.25 seconds for both the failed-upload attempt and successful retry). Scrub/cancel, failure preservation, generic multipart replacement, and updated rendered poster remain covered.
- Four focused transaction races cover cancellation during capture, cancellation during upload, owner switch during capture, and owner switch during upload. Every case preserves the original media/poster; capture-side cancellation prevents an upload; owner switching cannot create a replacement draft in the other owner's store.
- A second real browser test holds the replacement upload in flight, navigates through the app's own link so React unmounts the dialog while keeping the JS runtime/request alive, releases the response, and verifies unchanged persisted draft and no late cover error.

The stronger preview assertion exposed a fixture problem: the older E2E video route returned HTTP 200 for Range requests, causing the browser's remote preview seek to remain at zero. The mock now mirrors the production byte-range contract with 206/Content-Range/Accept-Ranges. The real preview and captured timestamps then agree. The navigation test's generic `role=alert` assertion was narrowed to cover errors because Next's normal route announcer also uses that role.

Round verification passed: `npx tsx scripts/test-video-cover-selection.ts`, the two Chromium tests selected by `--grep 'cover frame dialog'` (2 passed in 1.1 minutes), and `npm run typecheck`. The earlier broad Task 3 tests remain documented above; this round changes only preview controls, cancellation lifetime, and focused tests.
