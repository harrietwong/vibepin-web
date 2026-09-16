# SDD ledger — plan: D:/vp-tmp/wt-video-pin-p0-0916-integrated/docs/superpowers/plans/2026-09-16-video-pin-p0.md

## Goal

Implement batch Video Pin P0 without deployment: one video per draft, secure private upload, honest cover-only AI Copy, Studio/Plan/Batch rendering, and durable Pinterest immediate/scheduled publishing.

## Base And Workspace

- Frozen Preview ancestor: `f585e17f3ddd2f331a79271095a9758f30d94761`.
- Deployment AI Copy integration base: `3f74653c7d747b5a0889bf8457b3842bb3c71b90` (clean when branched).
- Branch: `codex/video-pin-p0-0916-integrated`.
- Worktree: `D:/vp-tmp/wt-video-pin-p0-0916-integrated`.
- Plan commits: `1bb3780d`, `654cf4f5`.
- Deployment, push, real migrations, real Storage, token refresh, and real Pinterest calls are forbidden.

## Preflight Rulings

- Ruling: batch upload means N selected videos create N independent Pin drafts — Pinterest organic video Pins are single-video entities and this preserves item-level retry — if wrong, the batch UX would need a different content model.
- Ruling: cap a batch at 20 files and each video at 100 MiB, with 4 seconds through 5 minutes duration — this bounds browser/storage/provider cost and follows current Pinterest web guidance — if wrong, limits can be raised centrally without schema redesign.
- Ruling: use private direct-to-Storage upload plus server finalize instead of proxying video bytes through a normal Next multipart route — serverless request limits make large proxy uploads unreliable — if wrong, the upload transport can change while keeping the intent/provenance contract.
- Ruling: browser duration/dimensions and extracted poster are labelled observed UX evidence, while server finalize verifies stored size/MIME/container — P0 avoids an undeclared ffmpeg runtime dependency — if wrong, server media probing must be added before rollout.
- Ruling: `PinDraft.imageUrl` may alias the private poster only, never the video binary — legacy image consumers otherwise try to render/download video as an image — if wrong, every legacy consumer would require an atomic migration.
- Ruling: Pinterest video creation defaults to `cover_image_key_frame_time=1` and does not implement `cover_image_url` — VibePin has a production-verified success record for the key-frame path while URL covers produced misleading failures — if wrong, a controlled Base64 cover strategy can be added later.
- Ruling: schedule preparation never registers Pinterest media; due execution uses v76 materialization/claim/provider-attempt ledgers — presigned upload URLs are short-lived and the security PRD forbids early schedule materialization — if wrong, provider media retention must be formally verified before changing this.
- Ruling: the existing v75 PGlite `deployment_blocked` verdict caused by a deliberately broad legacy Storage policy is a known base blocker, not a Task 1 regression; v77 must preserve the proof and may not claim deployability — if wrong, deployment must remain blocked until the policy audit is redone.
- Ruling: begin from clean integration SHA `3f74653c` while the deployment task completes its independent checks; only reviewed follow-up commits may be synced later — this prevents idle work while preserving integration safety — if wrong, Task 0 changes may need a bounded rebase.

## Interface And Task Conflict Scan

| Producer task | Consumer task | Shared file/interface | Finding and ruling |
|---|---|---|---|
| Task 1 | Task 2 | v77 upload rows, provenance media fields, video MIME guards | Task 2 may import only committed Task 1 contracts; no duplicate schema/types. |
| Task 1 | Task 3 | `ContentMediaKind`, `VideoContentMedia`, draft normalization | Task 3 must use the discriminated contract and retain legacy image behavior. |
| Task 1 | Task 4 | content media selectors and normalization | Task 4 renders through shared selectors; it may not add page-local video detection. |
| Task 1 | Task 6 | v76 video content-type guards and media identity | Task 6 builds provider shapes only; it does not weaken database owner/intent rules. |
| Task 1 | Task 7 | v76/v77 RPCs, upload/provenance identity | Task 7 uses server wrappers/RPCs and never direct client writes. |
| Task 2 | Task 3 | prepare/upload/finalize client and item states | Task 3 orchestrates the API; it does not recreate Storage authorization. |
| Task 2 | Task 4 | `/api/storage-media`, poster proxy | Task 4 receives protected app URLs only; raw bucket URLs are out of contract. |
| Task 2 | Task 5 | private poster path/owner authorization | Task 5 loads the poster server-side with the authenticated owner; no public URL fallback. |
| Task 2 | Task 7 | private video object, byte size, provenance | Task 7 claims/materializes the finalized exact object; pending/failed uploads cannot publish. |
| Task 3 | Task 4 | Studio card/draft state and shared upload progress | Task 3 owns upload behavior; Task 4 owns rendering, with narrow non-overlapping patches. |
| Task 3 | Task 5 | poster availability and degraded mode | Task 3 records poster evidence; Task 5 decides only the AI Copy evidence policy. |
| Task 3 | Task 7 | idempotency key, source revision, destination snapshot | Task 7 trusts the stored server-confirmed revision, not local batch state. |
| Task 4 | Task 7 | video readiness and schedule UI | Task 4 removes image-only false blockers; Task 7 remains authoritative for provider readiness. |
| Task 5 | Task 7 | AI-generated title/description on video draft | Copy is editable draft metadata and never changes immutable media identity/revision without reconfirmation. |
| Task 6 | Task 7 | Pinterest video adapter and provider evidence | Task 6 is pure/injectable; Task 7 owns durable ordering, claims, and settlement. |

| Task | Internal consistency check | Result |
|---|---|---|
| Task 0 | Clean base, baseline suites, ledger precede implementation | Consistent; baseline in progress. |
| Task 1 | Tests require additive schema and image compatibility that implementation specifies | Consistent. |
| Task 2 | Direct upload still requires server finalization/provenance before readiness | Consistent. |
| Task 3 | N-to-N drafts, partial success, retry, cancel all share item-level state | Consistent. |
| Task 4 | Shared renderer prevents Studio/Plan/Batch divergence | Consistent. |
| Task 5 | Poster-only input matches existing image vision boundary and honest fact policy | Consistent. |
| Task 6 | Adapter tests cover exact protocol and forbid real provider calls | Consistent. |
| Task 7 | Immediate and scheduled paths share v76 ordering and unknown semantics | Consistent. |
| Task 8 | Verification, high-capability review, Fable, and deployment coordination remain separate | Consistent. |

## Baseline Evidence

- Dependency install: Web `npm ci` added 417 packages, 0 vulnerabilities.
- PGlite dependency install: 1 package, 0 vulnerabilities.
- `test:media-privacy-architecture`: 16 passed, 0 failed.
- `test:ai-copy-v2-facts`: passed.
- `test:ai-copy-v2-routes`: 30 passed, 0 failed.
- `test:v76-publish-assets`: 280/280 assertions, two rounds, pass.
- `test:v75-media-provenance`: exit 0 with expected `deployment_blocked`; 65 assertions, no failures; blocker is the known legacy broad Storage policy.
- `test:studio`: first run completed 42/60 and the remaining 18 were blocked only by C-drive npm-cache ENOSPC. Re-run with task-scoped D-drive cache: `test-product-selection` 31/31 plus the other 17 previously blocked scripts all passed; no product assertion failure remained.
- `npm run typecheck`: exit 0.
- First `npm run build`: environment-only failure because the worktree has no secrets and C-drive npm cache was full (`supabaseUrl is required` after the ENOSPC was bypassed).
- Safe-dummy build with `NEXT_PUBLIC_SUPABASE_URL=https://example.invalid`, non-secret dummy keys, and task-scoped D-drive cache/temp: compile, TypeScript, 73 static pages, and final optimization passed; exit 0.

## Task Status

- Task 0: complete (base `3f74653c`; plan commits `1bb3780d..654cf4f5`; baseline evidence above).
- Task 1: complete — `873a98db`, review fixes `644e4af1`, `b66746b5`, round-three hardening `f6a4f1f7`, and round-four privilege manifests `82584627`, implemented on `654cf4f5`. v77 now rejects drift in every owned ledger column/default/nullability/constraint, additive provenance column, standalone index, RLS/policy, table/column/function privilege, and client/server privilege boundary while accepting only the intentional active or rolled-back server manifests. PGlite (94 assertions), focused media-store coverage (23/23), and `tsc --noEmit` passed. Final integration must rebase/cherry-pick this reviewed Task 1 sequence onto official base `04b0ebe0`; this worktree has not been rebased. The v75 verifier still reports its pre-existing `deployment_blocked` broad Storage-policy evidence (65 assertions, no failures); Task 1 did not remove or mask it.
- Task 2: not started.
- Task 3: not started.
- Task 4: not started.
- Task 5: not started.
- Task 6: not started.
- Task 7: not started.
- Task 8: not started.
