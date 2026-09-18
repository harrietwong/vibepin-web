# VibePin Video Upload, Cover, and AI Copy P0

## Objective

Ship a Preview-only Studio update that lets users keep selecting videos while earlier files are uploading, fixes the shared Supabase auth race, makes video cover selection meaningful, and adds an AI-copy shortcut beside Title. Production deployment is out of scope.

## Frozen Decisions

- Work only from branch `codex/video-pin-p0-0916-final` in this clean worktree.
- The upload picker stays enabled while video tasks are active.
- New selections append to one FIFO task queue. At most three tasks run from prepare through finalize at once.
- Each task owns its own abort controller, attempt receipt, progress, error, retry, and cancel state. One failure never blocks siblings.
- Retries reuse the logical draft idempotency key and create a fresh transfer attempt.
- Pending, checking, and transfer work can be cancelled. Finalization is allowed to settle to preserve server consistency.
- In-flight `File` bytes are not persisted across reload. Existing finalized-receipt recovery remains authoritative.
- Studio upload/auth helpers use the shared Supabase browser client. A 401 refreshes through `refreshSessionOnce()` and retries that internal API request once. Object-storage PUT is never replayed automatically.
- `coverFrameTimeMs` is the cover truth. The selected frame creates a browser-canvas poster only after confirmation; the poster is uploaded through the existing private poster path. Publish converts the value to the Pinterest cover-frame field.
- If a new poster cannot be created, retain the previous/default cover and show a retryable error. Do not silently claim the new cover was saved.
- Video AI copy analyzes the poster only. The Title shortcut calls the existing `PinAICopyPanelHandle.generate()` and does not create another AI state machine or prompt.
- Do not add ffmpeg.wasm or a new `video_drafts` database table for this P0.

## Task 1 — Shared Auth Contract

Write regression tests first, then migrate `videoDirectUpload.ts` and poster upload helpers away from extra browser-client creation. Add a narrow authenticated-fetch helper if needed. Verify one shared refresh across concurrent 401 responses and exactly one replay per API request.

## Task 2 — Appendable Upload Queue

Write queue and UI regression tests first. Replace the single-operation rejection and batch-overwrite behavior with appendable task state and a three-slot FIFO scheduler. Keep current per-item recovery/idempotency invariants. The upload picker must remain usable while work is active; retry and cancel are per task.

## Task 3 — Video Cover Frame Contract

Write model, UI, and Pinterest-adapter tests first. Extend the media/draft contract with `coverFrameTimeMs`; implement an accessible video player plus range selector; capture the confirmed frame via canvas; upload/retain the new poster; update the displayed poster and AI evidence; publish the selected timestamp. Preserve the existing default when no explicit selection exists.

## Task 4 — Title AI Shortcut

Write UI contract tests first. Put a compact AI action beside the Title label/input and call the existing panel imperative handle. Preserve overwrite confirmation and the panel's busy guard. For video drafts without a usable poster, show the existing unavailable-cover state instead of sending the MP4 to image analysis.

## Task 5 — Integration and Preview Gate

Run targeted tests, test-registry validation, Studio/core suites, typecheck, build, secret scan, and the relevant mock E2E. Review the complete diff, then send the final evidence to Fable over LINAPI. Only a Fable GO plus green verification permits coordination with the deployment task for Preview deployment. Do not deploy production.

## Acceptance Scenarios

- Select video A, immediately select B and C, then select D while the first three are active: the picker remains enabled and D queues.
- A failed item keeps its filename and actionable error and can retry without resetting completed siblings.
- Concurrent authenticated prepare/finalize/poster requests do not create multiple GoTrue clients or rotate the refresh token more than once per refresh event.
- Selecting a frame changes the card poster, persists the millisecond value, and produces the corresponding Pinterest payload value.
- The Title AI action and the panel action share one generate path and cannot issue duplicate requests while busy.
- Existing image upload, video recovery, old AI panel behavior, and default one-second cover remain compatible.
