# Task 5 Implementer Report — Honest AI Copy v2 Video-Cover Analysis

## Scope And Base

- Worktree: `D:/vp-tmp/wt-video-pin-p0-task5`
- Base: `d7635c02`
- Original implementation head: `c3bf41175548880322f7be0445410090e627d0f6` (`feat(ai-copy): analyze video covers safely`).
- No upload API, batch flow, migration, publish wiring, real provider, Storage, or database call was added or executed.

## Delivered Behavior

- The v2 client treats a video as a `video_cover` evidence request, skips the legacy image-analysis endpoint, and never serializes the video URL into either request.
- The server itself classifies the authenticated owner's persisted media kind before accepting visual evidence. A real video always takes the cover-only path regardless of a missing or forged client hint; actual images retain the legacy image-observation contract.
- The server reads only media[0]'s video `posterUrl`, validates canonical private path, owner scope, and exact provenance, then fetches the image through the existing owner-aware `handleStorageImageGet` path via `fetchImageAsDataUrl`. The handler's bounded stream limit and the vision byte limit both remain on this path.
- Missing, unreadable, or cross-owner posters are concealed as `video_cover_unavailable`, before provider work. The session stores additive, versioned `fact-card-v2` media evidence and replay returns the same degradation code.
- A cover's returned facts use a closed static taxonomy (objects, colors, composition, layout), with `image_observed`, `observed`, and `descriptive_only`. The protocol and parser cannot admit free-form motion, sequence/action, audio/speech/music, duration, performance/efficacy, material, brand, price, stock, quantities, or numeric signals.
- Generated output and the independent claim detector now identify unsupported video motion/audio/temporal inference. Those validation failures are unrepairable: a repair cannot invent a legitimate cover fact.
- A draft read is now tri-state: only an explicitly persisted `image` is treated as an image. Not-found, loader failure, malformed payload, and unknown media fail closed as `video_cover_unavailable` and discard client visual assertions.
- Empty, malformed, and fully rejected static-frame provider observations also degrade without invented composition/layout facts. Partially valid literal taxonomy fields are retained without defaults.
- A production-boundary test executes the default owner/draft/deleted selector and default provider-message construction with only DB, Storage, and provider transport I/O faked; it asserts the bounded poster data URL, strict protocol, and owner cost context.
- Existing image compatibility includes the persisted legacy `imageUrl`-only shape used by `contentMedia`. It is accepted only when the `media` field is absent; an explicit video (or malformed/unknown media field) always takes the safer video/unknown path, even if an `imageUrl` is also present.
- The shared evidence panel displays `Based on the video cover frame` and a clear unavailable-cover state. Existing image and flag-off paths remain in the regression suite.

## RED / GREEN Evidence

- Initial RED: `npm exec --yes tsx scripts/test-ai-copy-v2-video-cover.ts` failed with `MODULE_NOT_FOUND` for the absent module.
- Review-round RED: `scripts/test-ai-copy-v2-video-cover-hardening.ts` initially failed with `TypeError: resolveOwnedMediaEvidence is not a function`; it defines the owner selector, no raw-video dispatch, exact provenance, failed/unresolved provenance, missing poster, byte-limit, and static-claim counterexamples.
- GREEN: `test-ai-copy-v2-video-cover.ts`, `test-ai-copy-v2-video-cover-hardening.ts`, `test-ai-copy-v2-facts.ts`, and `test-ai-copy-v2-ui.ts` passed. `test-ai-copy-v2-routes.ts` passed 45/45, including omitted/forged hint, missing/cross-owner poster with zero provider calls, actual-image compatibility, persisted replay, and generation/repair guard coverage.
- Regressions: `test-ai-copy-language-guardrail.ts` passed 11/11 with inert local Supabase configuration; `test-usage-metering.ts` passed 15/15.
- `check-test-registry.ts`: 240 tracked scripts, 232 run by `npm test`, 8 excluded with a reason.
- `tsc --noEmit --incremental false`, scoped ESLint, `git diff --cached --check`, and `git diff --check` exited cleanly.
- Round 2 RED: hardening first failed because a loader exception resolved as `kind: "image"`. It now proves loader errors/null/malformed payloads are `unknown`, invalid/null/all-rejected provider observations are unavailable, and partial observations do not invent missing composition/layout.
- Round 2 GREEN: cover, hardening, production-boundary, facts, UI, language (11/11), metering (15/15), routes (46/46), registry (241 tracked / 233 runnable), scoped ESLint, independent typecheck, and diff checks passed.
- Round 3 RED/GREEN: the new route regression first showed `imageUrl`-only legacy drafts as video-cover unavailable; the route suite is now 47/47 and covers legacy imageUrl-only, explicit video with/without poster, null/throw, and a conflicting imageUrl plus video media entry.

## Risks / Handoff

- The local UI strings are English literal text because the existing v2 evidence block did not have a cross-locale key; follow-on i18n work can replace them with catalog keys without changing the safety contract.
- Default server dependencies are real production wiring but were not invoked by this task. Tests mock only database/Storage/provider I/O while executing the production media selector, authorization/provenance/path checks, bounded image handler, and prompt assembly. Video-cover dependencies are request-local; no module-global mutable override exists, and concurrent-request coverage verifies no shared test state.
- The original and Round 2 review records are preserved beside this report. No real provider, database, Storage, deployment, push, merge, migration, upload, batch, or Pinterest publish action occurred.
- The `video_cover_unavailable` scalar takes precedence over `no_keyword_demand_data` in the public degradation field. Keyword evidence remains persisted separately and retains its own honest provenance/degradation state.
