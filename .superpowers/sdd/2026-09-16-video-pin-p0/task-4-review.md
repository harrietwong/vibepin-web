# Task 4 Independent Review

Decision: **REQUEST CHANGES — NOT APPROVED**

Reviewed base `d7635c02`, implementation `b34d9c6c`, on 2026-09-16. No Critical findings; eight Important findings and one Minor finding. The requested renderer/readiness coverage and image compatibility are incomplete.

## Scope and evidence

Read the Task 4 brief, implementer report, review package, actual `git diff d7635c02 HEAD`, Task 4 in the implementation plan, and relevant unchanged consumers. Consulted the main checkout's `docs/design/AGENT_UI_CHECKLIST.md`, `VIBEPIN_DESIGN_SYSTEM.md`, and UI audit because those design documents are absent from this worktree. No application code was edited. This review file is the only review-authored change.

## Important findings

### I1. Studio Plan sidebar still sends the video binary to an image element

- Evidence: [planSidebarModel.ts:120](D:/vp-tmp/wt-video-pin-p0-task4/web/src/lib/studio/planSidebarModel.ts:120) returns `contentMedia(draft)[0]?.url` without preserving its kind; [StudioPlanSidebar.tsx:475](D:/vp-tmp/wt-video-pin-p0-task4/web/src/components/studio/StudioPlanSidebar.tsx:475) renders that value as `<img src={toProxyUrl(item.cover)}>`. Neither consumer was migrated.
- A scheduled video reaches this path even if it has a poster, because the selector prefers the video binary. A local pure runtime probe confirmed that its resulting image source is the protected `/api/storage-media?...mp4` video URL. This directly violates the no-video-binary-in-img contract.
- Preserve the discriminated media in the sidebar model and use the shared renderer, or provide an explicitly image-only poster selector for a thumbnail mode. Add a consumer regression that follows the value all the way to its rendering boundary.

### I2. Valid no-poster videos remain invisible in Studio cards, and Batch is still image-only

- Evidence: [PinBoardCard.tsx:964](D:/vp-tmp/wt-video-pin-p0-task4/web/src/components/studio/PinBoardCard.tsx:964) and [PinBoardCard.tsx:1319](D:/vp-tmp/wt-video-pin-p0-task4/web/src/components/studio/PinBoardCard.tsx:1319) only mount the newly video-aware `PinCardMedia` when `resolveInitialFailureMediaUrl(draft)` succeeds. That helper delegates to [failureMedia.ts:73](D:/vp-tmp/wt-video-pin-p0-task4/web/src/lib/studio/failureMedia.ts:73), which only inspects image/source/reference/parent image fields. A healthy uploaded video with no poster therefore renders `PinFallbackArtwork` instead of the video. The pure probe returned `null` for this guard while the draft had a valid video media item.
- Batch projections at [StudioBoard.tsx:493](D:/vp-tmp/wt-video-pin-p0-task4/web/src/components/studio/StudioBoard.tsx:493) omit media kind and URL. [BatchEditDrawer.tsx:770](D:/vp-tmp/wt-video-pin-p0-task4/web/src/components/studio/BatchEditDrawer.tsx:770), [BatchEditDrawer.tsx:1687](D:/vp-tmp/wt-video-pin-p0-task4/web/src/components/studio/BatchEditDrawer.tsx:1687), and [BatchEditDrawer.tsx:2056](D:/vp-tmp/wt-video-pin-p0-task4/web/src/components/studio/BatchEditDrawer.tsx:2056) still render only `imageUrl`; line 1696 still calls every item `image/images`. Video rows consequently show a still poster or missing image and a false media label.
- Migrate the actual card gates and Batch row/projection/render/copy consumers. `SelectedAssetPreview` also remains image-only, although the repository search found no active component call site; do not count its migration as active runtime coverage without identifying its caller.

### I3. Readiness migration drops media at existing Studio, Batch, and drawer projections

- Evidence: [weeklyPlanStats.ts:12](D:/vp-tmp/wt-video-pin-p0-task4/web/src/lib/weeklyPlanStats.ts:12) projects only `imageUrl`, omitting `media`; Studio Schedule/Add-to-Plan still passes that projection into `isPinReady` at [StudioBoard.tsx:745](D:/vp-tmp/wt-video-pin-p0-task4/web/src/components/studio/StudioBoard.tsx:745) and line 847. The immediate-publish entry still directly checks `isPublishableImage(draft.imageUrl)` at line 784.
- [BatchEditDrawer.tsx:209](D:/vp-tmp/wt-video-pin-p0-task4/web/src/components/studio/BatchEditDrawer.tsx:209) also drops media in `pubReadinessInput`, and its publish loop skips the draft at line 1454. [DraftDetailsDrawer.tsx:1392](D:/vp-tmp/wt-video-pin-p0-task4/web/src/components/plan/DraftDetailsDrawer.tsx:1392) builds another image-only readiness input despite its new direct `hasValidImage` check.
- A pure runtime probe with the same HTTPS protected video and selected board produced `isPinReady(draft) === true` but `isPinReady(draftReadiness(draft)) === false`. The new helper therefore does not resolve the user's actual Studio/Batch paths or their ready counts.
- Pass discriminated media through every readiness projection and replace the remaining inappropriate direct image predicate, preserving existing asset-error, board, destination, authorization, and provider gates. Test entry points and projected counts, not just the helper name.

### I4. PinCardMedia violates Hook ordering when the displayed media kind changes

- Evidence: [PinCardMedia.tsx:109](D:/vp-tmp/wt-video-pin-p0-task4/web/src/components/studio/PinCardMedia.tsx:109) returns for video before `useMemo` at line 112 and `useState` at line 119. Both calls are conditional. An in-place cover/media replacement from image to video or back changes the hook sequence of the existing component and can throw a rendered-more/fewer-hooks error.
- Independently executing the installed React Hooks ESLint rule against the actual worktree source reported both violations (112:17 and 119:31).
- Split the image-specific implementation into its own component or keep all hooks unconditional. Add a same-instance media-kind transition regression.

### I5. A single load error permanently poisons a renderer instance across media changes

- Evidence: [ContentMediaRenderer.tsx:19](D:/vp-tmp/wt-video-pin-p0-task4/web/src/components/media/ContentMediaRenderer.tsx:19) stores one boolean `failed`; line 20 returns a fallback forever after an error. There is no source/id keyed reset. Consumers, including [DraftDetailsDrawer.tsx:1627](D:/vp-tmp/wt-video-pin-p0-task4/web/src/components/plan/DraftDetailsDrawer.tsx:1627), do not key the component by source either.
- After a failed image/video, changing the cover URL or switching drafts while the drawer stays mounted still shows the old failure and never attempts the new resource. The previous `PinThumbnail` reset its status when `src` changed, so this is also an image recovery regression.
- Key load state to the actual media identity/source and verify error -> new source -> successful render without remounting the whole page.

### I6. Custom fallbacks suppress the required video error message and live announcement

- Evidence: [ContentMediaRenderer.tsx:21](D:/vp-tmp/wt-video-pin-p0-task4/web/src/components/media/ContentMediaRenderer.tsx:21) returns a caller fallback before its `role=status` / polite error UI. [PlanListView.tsx:290](D:/vp-tmp/wt-video-pin-p0-task4/web/src/components/plan/PlanListView.tsx:290) supplies an ImageOff placeholder labelled as an unavailable image; [ContentMediaStrip.tsx:35](D:/vp-tmp/wt-video-pin-p0-task4/web/src/components/studio/ContentMediaStrip.tsx:35) supplies artwork. Neither contains a readable video-load error or a polite live region.
- The separate live span at renderer line 34 cannot announce the failure: the `failed` branch returns earlier, so that span is unmounted rather than updated with the failure text. The default fallback is only used in consumers that supplied no fallback.
- Keep the video error contract owned by the shared renderer even when an image/artwork fallback is supplied. Verify a dispatched video error on Plan List and the strip, including the accessible output and an available recovery path.

### I7. Replacing PinThumbnail regresses existing image loading and hover behavior

- Evidence: [PinHoverPreview.tsx:229](D:/vp-tmp/wt-video-pin-p0-task4/web/src/components/plan/PinHoverPreview.tsx:229) replaces `PinThumbnail(... dark)` with a raw image branch through the new renderer; [ContentMediaRenderer.tsx:40](D:/vp-tmp/wt-video-pin-p0-task4/web/src/components/media/ContentMediaRenderer.tsx:40) has no skeleton/loading fade, async decoding, or `draggable={false}`. Every previous Weekly Plan `PinThumbnail` consumer was replaced similarly.
- The hover warmup still downloads `toThumbUrl(media.url)` at [PinHoverPreview.tsx:618](D:/vp-tmp/wt-video-pin-p0-task4/web/src/components/plan/PinHoverPreview.tsx:618), while actual rendering now requests `toProxyUrl(media.url)`. For Pinterest originals this warms the smaller `736x` asset but renders the full original, defeating the existing preload behavior and potentially downloading both. The always-dark loading/fallback contract is also lost in the dark hover card under light theme.
- Independent regressions: `test-hover-preview-image` failed 4 of 8 assertions; `test-weekly-plan-hover-images` failed 1 of 11. Some assertions name the old component, but the removed loading/error/URL behaviors are confirmed in the actual implementation, not inferred solely from those names.
- Reuse the existing image thumbnail behavior behind the shared boundary, with the correct per-consumer thumbnail URL/dark mode. Update tests only if equivalent behavior remains explicitly tested.

### I8. Native video controls were inserted into click/keyboard surfaces without interaction isolation

- Evidence: [ContentMediaStrip.tsx:128](D:/vp-tmp/wt-video-pin-p0-task4/web/src/components/studio/ContentMediaStrip.tsx:128) now nests a `video controls` element inside the cover-selection button. This is nested interactive content, and it conflates selecting a cover with operating the player. Small existing 54x66 media cells also leave no verified accessible control layout.
- [WeeklyPlanWorkspace.tsx:1073](D:/vp-tmp/wt-video-pin-p0-task4/web/src/components/plan/WeeklyPlanWorkspace.tsx:1073) puts the player inside a `PinHoverTarget` that opens details; [PlanListView.tsx:274](D:/vp-tmp/wt-video-pin-p0-task4/web/src/components/plan/PlanListView.tsx:274) similarly wraps it in an open-details click handler. [PinHoverPreview.tsx:652](D:/vp-tmp/wt-video-pin-p0-task4/web/src/components/plan/PinHoverPreview.tsx:652) does not exclude media controls, and lines 698-704 can prevent Space/Enter on bubbling child keyboard events on touch/non-fine-pointer layouts. The renderer has no event boundary.
- The View Pins card still opens an image-only lightbox using `draft.imageUrl` at [WeeklyPlanWorkspace.tsx:511](D:/vp-tmp/wt-video-pin-p0-task4/web/src/components/plan/WeeklyPlanWorkspace.tsx:511), with the image element at line 565. A video card's preview therefore cannot open a playable video (and opens no lightbox at all without a poster).
- Give thumbnail selection/details triggers and playback controls separate semantics, or intentionally use a poster thumbnail with a separate accessible video preview action. Cover keyboard Space/Enter, pointer interaction, focus return, and 390px touch operation with runtime tests. No browser was run, so exact native-control click behavior across engines is unverified; the nested interactive markup and bubbling keyboard interception are code-level evidence.

## Minor finding

- [ContentMediaRenderer.tsx:23](D:/vp-tmp/wt-video-pin-p0-task4/web/src/components/media/ContentMediaRenderer.tsx:23) adds 11px functional error copy with hard-coded English and literal fallback colors. The relevant design checklist requires at least 12px functional text and localized user-facing copy. Use existing semantic tokens and translations. Stale unused imports (`PinThumbnail`, `toProxyUrl`) and dead thumbnail-error tracking should also be removed during repair.

## Independent verification

Used the already-cached local `tsx` runner directly; no npm installation or network resolution was performed. All tests below ran from the reviewed worktree's `web` directory.

| Check | Result |
|---|---|
| `test-video-media-rendering.ts` | 4 passed / 0 failed; source-text checks only |
| `test-plan-list-view.ts` | 15 passed / 0 failed |
| `test-hover-preview-image.ts` | 4 passed / 4 failed |
| `test-weekly-plan-hover-images.ts` | 10 passed / 1 failed |
| `test-generation-failure-media.ts` | 30 passed / 0 failed |
| `test-content-media-model.ts` | 23 passed / 0 failed, including video alias/persistence coverage from Task 1 |
| `test-pin-details-modal-compact.ts` | 12 passed / 0 failed |
| `check-test-registry.ts` | Passed: 239 tracked, 231 included, 8 explained exclusions |
| `git diff d7635c02 HEAD --check` | Passed |
| Isolated installed React Hooks lint rule | Two conditional-hook violations at PinCardMedia 112 and 119; isolated harness additionally noted the unavailable Next inline-disable rule |
| Local pure readiness/card/sidebar probe | Direct readiness true; projected readiness false; card image guard null; sidebar img source equals binary video URL |

The full-config ESLint attempt via the main checkout's dependencies produced no output and was interrupted; its result is not counted as a pass. Full typecheck, full component suites, UI contract, DOM interaction, visual, and 390px verification remain unproven. This worktree has no complete project dependencies, and its package scripts do not expose the design checklist's UI-contract command.

The added four tests look for attribute/helper/import strings. They do not mount the renderer, switch media, dispatch load errors, traverse the actual Studio/Batch/sidebar consumers, exercise modal focus or native controls, or validate mobile layout. Their consumer list omits StudioPlanSidebar, PinBoardCard's rendering guard, and Batch entirely. These test gaps explain why the significant failures above were not caught and must be addressed in the repair.

## Boundaries that do hold

- The shared renderer's direct video branch uses the protected URL unchanged, `controls`, `muted`, `playsInline`, metadata preload, optional poster, and no autoplay. It makes no transcript/caption claims.
- The new Plan image-download selector returns no URL for video and avoids a binary-video download through that image-only action.
- No second Plan route/store/model was introduced, and no schedule/destination persistence fields were mutated by this change. Task 1 media persistence tests remain green.
- Actual changed readiness code retains the previous board and destination checks; no direct authorization/provider bypass was found in this Task 4 diff. The failure is inconsistent/incomplete media readiness wiring, not evidence of removed backend authorization.
- No browser, server, database, storage, provider, publish, push, deploy, external calls, or subagents were used. Only local reads, local tests/diagnostics, and this requested review report were performed.

## Acceptance decision

Do not integrate Task 4 as complete. Resolve I1-I8 and rerun the touched-path regressions, runtime component/interaction coverage, scoped lint and full typecheck on an installed dependency tree before requesting another review.
