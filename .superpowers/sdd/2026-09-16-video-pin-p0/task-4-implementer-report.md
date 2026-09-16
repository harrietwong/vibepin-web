# Task 4 Implementer Report — Shared Video Rendering

## Scope

- Base: `d7635c02`.
- Added one `ContentMediaRenderer` boundary for image/video media and applied it to Studio card/strip and Plan list, workspace, drawer, and hover preview paths.
- Video uses controls, muted, playsInline, metadata preload, optional poster, no autoplay, and a polite error fallback.
- Readiness now evaluates discriminated media URLs, so a protected finalized video does not depend on a poster/image alias. Plan image download intentionally returns no URL for video.

## TDD Evidence

- RED: `npx tsx scripts/test-video-media-rendering.ts` — 0 passed, 4 failed (renderer absent, all consumers bypassed it, no media-aware readiness, unsafe Plan download).
- GREEN (twice): same command — 4 passed, 0 failed both times.
- Regression: `npx tsx scripts/test-plan-list-view.ts` — 15 passed, 0 failed.
- Runtime selector smoke: `isPublishableContentMedia` returned `true` for a protected HTTPS video-only draft.

## Verification Notes

- `git diff --check` passed (only CRLF conversion warnings).
- Full typecheck could not run in this worktree: its dependency directory was absent/partially installed, and cleanup of the generated partial dependency directory was blocked by the execution policy. `npx --package typescript tsc --noEmit` consequently reported missing project dependencies, not feature diagnostics.
- No real browser, server, database, storage, provider, upload, Pinterest, or other external service calls were made. npm package resolution was used solely to run the local node test harness.

## Risks

- Browser DOM behavior (native video error event and 390px visual layout) needs the final integration's installed-dependency/browser QA gate.
- Existing hover-image cache warming remains intentionally image-only; videos are never preloaded as images.

## Review Repair — 2026-09-16

- Base: `d7635c02`; prior Task 4 commits retained: `b34d9c6c`, `608bbcee`.
- Repaired the remaining I2/I3/I7/I8 and Minor review findings without discarding the existing worktree changes. Batch row projections now retain discriminated media; its thumbnail, detail preview, readiness, and labels render video correctly, including a no-poster video fallback.
- The shared renderer now resets errors by media identity, keeps visible 12px polite video-error text even with a caller fallback, and stops video-control pointer/click/keyboard bubbling. Studio cover selection gives video playback and cover selection separate controls; Plan hover targets and the View Pins lightbox retain media kind.
- Restored Plan/hover image behavior through `PinThumbnail`, preserving thumbnail URL warming, skeleton/error recovery, async decode, and dark hover treatment. Removed stale image-only imports/state.
- RED: the expanded `test-video-media-rendering.ts` failed for missing Batch row media, the Draft Details wrapper media contract, Plan thumbnail reuse, and video interaction isolation. GREEN: 9/9 passed after the repairs.
- Verification passed: focused video/hover/Plan/Batch/readiness/component-model scripts, `check-test-registry`, `npm run typecheck`, and `git diff --check`. The actual scoped ESLint result is qualified below. No external calls, deployment, push, merge, database, Storage, or provider operation occurred.

## Review Repair — Round 2 — 2026-09-16

- Retained implementation base `d7635c02` and the earlier Task 4 commits `b34d9c6c`, `608bbcee`, and `a7b20ee8`; this repair is the next reviewable commit on `codex/video-pin-p0-task4`.
- `ContentMediaRenderer` now stops propagation only for pointer clicks and the Enter/Space activation keys. Escape and Tab reach the existing Draft Details, Batch, and mobile-sidebar handlers. The handler is covered with a real event-shaped counterexample for click/Enter/Space versus Escape/Tab.
- A keyed resource child owns error state, so a failed A → successful B → A transition mounts A again and retries it rather than retaining the old failure. The regression test covers the distinct identities and keyed lifecycle boundary.
- Batch's accessible open-details button and the sidebar's accessible navigation Link now render `videoControls={false}` previews. The nested video is removed from the tab order and has no native controls; the surrounding button/Link remains the single operable detail/navigation trigger.
- Updated the two stale model/tile regressions to assert the intended discriminated `ContentMedia` projection and its `PinThumbnail` image delegation rather than the removed raw image-only representation. Video-cover control copy is now 12px.

### Round 2 Verification

- `npx tsx scripts/test-video-media-rendering.ts` — 12/12 pass (supersedes the previous 9/9: adds Escape/Tab propagation, noninteractive DOM composition, and A→B→A retry cases).
- `npx tsx scripts/test-plan-sidebar-model.ts` — 23/23 pass; `npx tsx scripts/test-plan-tile-interactions.ts` — 17/17 pass.
- `npx tsx scripts/test-hover-preview-image.ts` — 8/8; `npx tsx scripts/test-weekly-plan-hover-images.ts` — 11/11; `npx tsx scripts/test-pin-readiness.ts` — 21/21; `npx tsx scripts/test-batch-edit-planning.ts` — 39/39; `npx tsx scripts/test-create-pins-batch-edit-ui.ts` — 29/29.
- Supporting reviewed suites: Plan List 15/15, Pin Details Model 31/31, Content Media Model 23/23, Generation Failure Media 30/30, and test registry 239 tracked / 231 run / 8 explained exclusions.
- `npm run typecheck` — pass. `npx eslint src/components/media/ContentMediaRenderer.tsx` — pass. The wider changed-component ESLint scope has 0 errors and 7 pre-existing BatchEditDrawer unused-symbol/disable warnings; the repair removes the renderer's stale `KeyboardEvent` import and introduces no lint error.
- `git diff --check` — pass. No dependency, external service, deployment, push, or merge action was performed.
