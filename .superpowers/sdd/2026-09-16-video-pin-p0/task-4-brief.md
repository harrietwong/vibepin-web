# Task 4 Brief — Shared Video Rendering In Studio, Plan, And Batch

## Base And Boundaries

- Worktree: `D:/vp-tmp/wt-video-pin-p0-task4`
- Branch: `codex/video-pin-p0-task4`
- Base: `d7635c02` (reviewed Task 1 + Task 6 on official `04b0ebe0`).
- Implement rendering/readiness/copy only. Do not implement upload APIs, batch upload orchestration, AI Copy, Pinterest adapter/orchestration, DB migrations, deploy, push, or real external calls.

## Contract

- Add one reusable, focused media renderer driven by the existing `ContentMedia.kind`; avoid page-local duplicated video branches.
- Image rendering must remain behaviorally and visually compatible.
- Video renders the protected media URL with `controls`, `muted`, `playsInline`, `preload="metadata"`, no autoplay, `poster` from `posterUrl`/poster alias when available, and a readable accessible load-error fallback.
- Never use a video binary URL as an `<img src>` or download-as-image target.
- Apply the shared renderer/selectors to Studio card/preview paths and existing Plan paths (`WeeklyPlanWorkspace`, `PlanListView`, `DraftDetailsDrawer`, `PinHoverPreview`) that currently assume `draft.imageUrl`.
- Plan remains `/app/studio?view=plan`; do not add a second model/page/store.
- One video draft remains one Pin row/card and preserves schedule/destination metadata.
- Replace image-only readiness predicates only where they incorrectly reject a valid finalized video; do not weaken destination/auth/provider readiness.
- Batch/selection labels and counts must say media/video accurately instead of unconditional image/images.
- Mobile actions must remain visible without hover; touch targets >=40px; video state/error announcements use `aria-live="polite"`; preserve existing focus, Escape, body scroll lock and drawer/modal contracts.
- Do not autoplay or play audio automatically. Do not fabricate captions or transcript claims.

## TDD And Verification

- Write RED component/runtime/contract tests first.
- Cover image regression, video attributes, poster and no-poster fallback, load error, protected URL, reload persistence, Studio/Plan/Batch consistency, readiness, keyboard path, mobile 390px/no-hover contract, labels/counts, and no binary URL in image-only operations.
- Prefer narrow components/selectors and direct imports; avoid growing a monolithic page component or adding broad client bundles.
- Run focused tests twice, all existing tests for each touched component/path, test registry, full typecheck, scoped lint/diff UI contract if available, and `git diff --check`.
- No real browser/server/database/provider calls unless an existing mock-only runtime test requires them.
- Commit only Task 4 files and report. Write `.superpowers/sdd/2026-09-16-video-pin-p0/task-4-implementer-report.md` with base/head, files, RED/GREEN evidence, risks, and external-call attestation.
