# Task 5 Implementer Report — Honest AI Copy v2 Video-Cover Analysis

## Scope And Base

- Worktree: `D:/vp-tmp/wt-video-pin-p0-task5`
- Base: `d7635c02`
- Implementation head: `5168ab0040542fe4d7674449a7adf175c23b881a` (`feat(ai-copy): analyze video covers safely`).
- No upload API, batch flow, migration, publish wiring, real provider, Storage, or database call was added or executed.

## Delivered Behavior

- The v2 client treats a video as a `video_cover` evidence request, skips the legacy image-analysis endpoint, and never serializes the video URL into either request.
- The server loads the authenticated owner's exact draft, reads only media[0]'s video `posterUrl`, validates canonical private path, owner scope, and exact provenance, then fetches the image through the existing owner-aware `handleStorageImageGet` path via `fetchImageAsDataUrl`.
- Missing, unreadable, or cross-owner posters are concealed as `video_cover_unavailable`, before provider work. The session stores additive, versioned `fact-card-v2` media evidence and replay returns the same degradation code.
- A cover's returned facts are restricted to sanitized literal visual fields with `image_observed`, `observed`, and `descriptive_only`. Motion, sequence/action, audio/speech/music, duration, performance/efficacy, material, brand, price, stock, quantities, and numeric signals are removed before facts are made.
- Generated output keeps the existing independent unsupported-claim validator and cannot use a cover observation to authorize commercial claims.
- The shared evidence panel displays `Based on the video cover frame` and a clear unavailable-cover state. Existing image and flag-off paths remain in the regression suite.

## RED / GREEN Evidence

- RED: `npm exec --yes tsx scripts/test-ai-copy-v2-video-cover.ts` initially failed with `MODULE_NOT_FOUND` for the absent `videoCoverEvidence` module.
- GREEN focused round 1: video-cover, facts, routes (43 passed, 0 failed), and UI/client passed.
- GREEN focused round 2: video-cover, facts, and routes (43 passed, 0 failed) passed; UI/client also passed separately after the command time boundary.
- AI Copy regressions: `test-text-metering` (14 passed), `test-ai-copy-language-guardrail` (11 passed), and the provider-boundary suite was started with its observed cases passing before the command time boundary.
- `check-test-registry.ts`: 239 tracked scripts, 231 runnable, 8 excluded with reasons.
- `tsc --noEmit`, scoped ESLint, `git diff --cached --check`, and `git diff --check` exited cleanly.

## Risks / Handoff

- The local UI strings are English literal text because the existing v2 evidence block did not have a cross-locale key; follow-on i18n work can replace them with catalog keys without changing the safety contract.
- Default server dependencies are real production wiring but were not invoked by this task; all focused tests use injected functions/mocks. There is no module-global mutable test override, so concurrent requests do not share test state.
- The `video_cover_unavailable` scalar takes precedence over `no_keyword_demand_data` in the public degradation field. Keyword evidence remains persisted separately and retains its own honest provenance/degradation state.
