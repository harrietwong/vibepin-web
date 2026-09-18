# Task 4 — Title AI Shortcut

Implemented on accepted Task 3 base `9127d2b1` in `D:/vp-tmp/wt-video-pin-p0-0916-final`. No pushes, merges, deployments, API-schema changes, prompt changes, or live provider operations were performed.

## Behavior and invariants

- Studio Draft cards now keep the existing compact `PinAICopyPanel` action visible and add a second compact action beside the inline Title label. Scheduled/Posted cards expose the same Title action in their expanded `PinFieldsForm`.
- Both title actions call only `aiRef.current?.generate()`. `PinAICopyPanel` remains the sole owner of generation stage, overwrite confirmation, request state, quota/rate-limit behavior, evidence, and `onApplyCopy`; no parent AI state, route, hook, prompt, or result path was added.
- The shortcut reuses the existing localized `pinForm.generateCopy` key for visible text, `title`, and accessible name. Catalog validation confirms the key resolves rather than leaking a raw key. The control is a 24px-minimum compact button with the browser's normal keyboard focus treatment.
- Busy feedback remains authoritative in the visible shared panel action: it disables and shows the existing progress state. The title shortcut deliberately does not mirror panel state; activations during a request reach the panel handle and are rejected by its existing busy guard.
- The panel handle also exposes the panel's real synchronous busy state. Card Edit/Collapse transitions consult that handle and remain in their current compact/expanded shape until the request settles, so the conditionally rendered panel cannot remount mid-request. This adds no parent-owned request or result state.
- Image drafts still use the established image path. Video drafts still pass through `generatePinterestPinCopy`'s persisted-media boundary: a selected video cover resolves the durable poster, the client omits the video URL from v2 input, and the server analyzes only bounded owned poster bytes. A video without a usable poster degrades to `video_cover_unavailable` and makes zero image-provider calls.

## TDD evidence

### RED

With production files restored to `HEAD` and only the focused E2E contract changed, the isolated Chromium run reached the actual Studio card and failed at:

```text
Locator: ...getByTestId('title-ai-copy-generate')
Expected accessible name: "Generate copy"
Error: element(s) not found
```

An earlier attempt failed at an obsolete `card-edit` step because current Draft cards edit inline. That setup failure was not counted as RED; the test was corrected first and rerun until it failed specifically on the missing shortcut.

### GREEN

`tests/e2e/ai-copy-v2.spec.ts` now verifies the real compact Draft card:

- the title shortcut has the localized accessible name;
- the original `ai-copy-generate` action remains visible;
- existing title/description still open the shared overwrite confirmation;
- while the mocked generation response is held, the original action is visibly disabled;
- a rapid shortcut double-click during that busy window does not re-enter generation;
- analyze and generate each receive exactly one request;
- the generated title is applied through the existing path and existing evidence assertions still pass.

The first post-implementation run reached all Task 4 assertions but timed out compiling the unrelated legacy `/app/trends` route at the test's final check. A warmed rerun completed: `1 passed (24.2s)`.

### Fix round 1 — card-shape race

The review found that the compact and expanded panels live under different conditional parent trees. The focused scheduled-card E2E first held the generate response in flight, clicked Edit, and failed on the requested invariant:

```text
Expected data-active: "false"
Received: "true"
```

That was the real compact-to-expanded remount race. After adding the synchronous panel busy handle and guarding Edit, the test passed. The same test was then extended in strict RED/GREEN order for the reverse direction: after starting generation from the expanded Title shortcut, Collapse incorrectly changed `data-active` from `true` to `false`; adding the same guard to Collapse/Stop Editing made it pass.

The final browser contract covers both directions in one scheduled-card flow. While each response is held, a shape-change click cannot remount the panel and the analyze/generate counters remain exactly one per requested run. Once the response settles, the same shape transition succeeds. The original compact action and the expanded Title shortcut both remain present.

## Verification

All commands ran from `web/` unless noted.

```text
npx playwright test tests/e2e/ai-copy-v2.spec.ts --project=chromium --reporter=list
  2 passed (39.7s)

npx tsx scripts/test-ai-copy-v2-ui.ts
  AI Copy v2 UI/client tests passed

npx tsx scripts/test-studio-ui-feedback.ts
  7 passed, 0 failed

npx tsx scripts/test-video-cover-selection.ts
  passed — selected durable poster is authoritative

npx tsx scripts/test-ai-copy-v2-video-cover.ts
  passed — video evidence uses the owned poster path and never the raw video

npx tsx scripts/test-ai-copy-v2-video-cover-hardening.ts
  passed — missing/unusable poster degrades and makes zero provider calls

npx tsx scripts/test-ai-copy-v2-video-cover-production-boundaries.ts
  passed — production provider receives bounded poster data only

npm run check:test-registry
  OK — 258 tracked, 250 run, 8 excluded with reasons

npm run typecheck
  exit 0

npm run validate:i18n
  passed — 2932 English keys, 18 locale catalogs
```

Focused ESLint completed with zero errors and two existing hook warnings at unchanged `PinBoardCard.tsx` lines. `validate:i18n-coverage` remains red on the branch's broad pre-existing locale backlog (including many unrelated Studio/publish keys); this task adds no key and `validate:i18n` confirms catalog integrity.

## E2E environment and limitations

`npm run dev:testdb` could not start because this worktree has no `.env.test.local`. The browser test therefore reused the Task 3 isolated local server on port 3038 with loopback Supabase values, dummy local keys, `E2E_TEST_MODE=true`, and mocked app/API boundaries. It did not target production or claim real Supabase/Pinterest acceptance. The first warmed verification is the reported GREEN; the cold compile timeout is retained above as an environment limitation, not represented as a feature failure or success.

## Changed files

- `web/src/components/pins/PinFieldsForm.tsx`
- `web/src/components/pins/PinAICopyPanel.tsx`
- `web/src/components/studio/PinBoardCard.tsx`
- `web/tests/e2e/ai-copy-v2.spec.ts`
- `.superpowers/sdd/2026-09-17-video-upload-cover-ai-p0/task-4-report.md`

`web/AGENTS.md` was restored to `HEAD` and is not part of the task diff.
