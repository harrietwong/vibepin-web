# Task 5 Brief — Honest AI Copy v2 Video-Cover Analysis

## Base And Boundaries

- Worktree: `D:/vp-tmp/wt-video-pin-p0-task5`
- Branch: `codex/video-pin-p0-task5`
- Base: `d7635c02` (reviewed video media contract + Pinterest adapter on official AI Copy Preview base `04b0ebe0`).
- Implement AI Copy v2 cover-only behavior and minimal evidence UI only. No upload APIs, Studio batch flow, renderer redesign, DB migration, Pinterest publish wiring, deploy/push/merge, or real model/Storage/database calls.

## Frozen Behavior

- Existing image draft and flag-off/legacy AI Copy behavior must remain unchanged.
- For `ContentMedia.kind === "video"`, analyze only the owner-authorized private poster/cover. Never send the video binary URL, video bytes, signed raw bucket URL, audio, or motion frames to the image-only vision provider.
- Resolve poster server-side from the authenticated owner and exact provenance/path. Client `userId` is never trusted. A private poster proxy/path from another owner must be concealed/rejected before provider work.
- Video-cover visual facts use source `image_observed`, trust `observed`, and descriptive-only claim policy.
- Explicitly forbid any inference about motion, sequence, actions not frozen in the cover, audio, speech, music, duration, performance, efficacy, material, brand, price, stock/inventory, quantities, or other numeric commercial claims from the cover.
- Add an explicit analysis/media evidence mode such as `video_cover` versus existing image mode. Do not invent demand/trend provenance.
- UI text must say `Based on the video cover frame` (localized through the project's normal i18n pattern if required) and retain existing facts/keyword/source labels.
- Missing/unreadable/unowned poster yields `video_cover_unavailable`. Analyze/generate may continue using asserted user/product text and honest keyword evidence, but emits no visual facts and never falls back to the video URL.
- The degradation code/evidence must survive session persistence and be returned in the existing safe AI Copy v2 response contract without exposing bucket paths/tokens.
- Existing unsupported-claim validation still applies to generated output and repair. A cover observation cannot authorize protected commercial claims.

## Required Design

- Prefer a narrow pure selector that chooses AI visual evidence from `ContentMedia`; make the video branch impossible to confuse with the binary URL.
- Server loader/provider dependencies remain injectable for route tests. Test owner checks before provider invocation.
- Do not add a second AI Copy pipeline or duplicate FactCard types. Extend the frozen v2 contract additively and version honestly if serialized shape changes.
- Keep `PinAICopyPanel.tsx` change minimal; no unrelated visual redesign.

## TDD And Verification

- Write RED tests first for: video poster-only provider input, no video URL dispatch, `image_observed` descriptive-only facts, motion/audio/material/brand/price/stock/numeric claim rejection, missing poster degradation, cross-owner concealment/no-provider-call, persisted evidence mode, and unchanged image + flag-off behavior.
- Route tests use mocks only; no real provider/Storage/DB calls.
- Panel/runtime tests assert exact cover-frame copy, degradation state, facts/source labels, and no silent overwrite regression.
- Run focused facts/routes/UI tests twice, AI Copy metering/context regressions, test registry, full typecheck, scoped lint/diff check, and `git diff --check`.
- Commit only Task 5 files plus report. Write `.superpowers/sdd/2026-09-16-video-pin-p0/task-5-implementer-report.md` with base/head, files, RED/GREEN evidence, risks, and external-call attestation.
