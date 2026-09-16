# Task 2 Implementer Report — Private Direct Video Upload And Finalization

## Scope And Base

- Base: `d7635c02` (`04b0ebe0b7b292d6fa2432f6a064740b30314447` integration lineage).
- Branch/worktree: `codex/video-pin-p0-0916-final` / `D:/vp-tmp/wt-video-pin-p0-0916-final`.
- Head: recorded after the Task 2-only commit below.
- Scope was limited to Task 2 server handlers, route wiring, private-provenance extension, direct browser helper, focused test registry entry, this brief, and Task 2 ledger/report evidence. No Studio UI, AI Copy, scheduler, draft orchestration, or Pinterest publish code changed.

## Implementation

- `POST /api/studio/video-upload/prepare` authenticates before JSON parsing or provider/database side effects, validates a 1–20 descriptor batch, persists via owner-filtered v77 RPCs, and creates short-lived direct-upload capabilities with `upsert:false`.
- `POST /api/studio/video-upload/finalize` reads the exact server-owned item, validates object existence/type/size/checksum metadata and bounded ISO-BMFF `ftyp`, invokes v77 finalization, and registers owner-exact video provenance. Failure removes only the exact object and records the v75 cleanup outbox if deletion fails.
- `GET /api/storage-media` requires bearer authentication and exact ready/allowed video provenance, accepts only one bounded range, returns fixed safe headers, proxies only that range, and neither forwards provider headers nor exposes provider URLs.
- The browser helper sends bytes from `uploadToSignedUrl` directly to private Storage; it does not route a video multipart body through Next.

## TDD Evidence

- RED 1: missing pure handlers produced `ERR_MODULE_NOT_FOUND` before implementation.
- RED 2: an injected upstream response longer than the requested range was exposed by the proxy; the new bounded range stream makes the focused test reject it.
- RED 3: an unrecognised provenance lifecycle was served; the proxy now admits only explicit allowed lifecycle states.
- RED 4: a matching prepare replay generated a new path; prepare now reuses the owner-filtered stored item path, preserving v77 immutable-fact conflict detection.
- GREEN: `npx tsx scripts/test-video-upload-private.ts` reports 11/11 focused behaviours after the final replay/lifecycle fixes; the final verification section records the repeated run.

## Required Behaviour Coverage

- Authentication before parsing/DB/Storage, feature/config denial, 1/20/21 count and duplicate ordinal/key rejection, MIME/size/name/path validation, owner isolation, prepare conflict/replay, token/error redaction, and `upsert:false`.
- Missing/empty/oversized/type-or-size-mismatched/expired/cross-owner finalization, valid and invalid `ftyp`, exact provenance, successful-finalize replay without another read, object removal, and cleanup-outbox compensation.
- Storage-media auth/exact provenance/cross-owner/lifecycle/MIME/size gates; 200, 206, open/suffix and multi/unsatisfiable range handling; safe headers; provider failure redaction; and stream bounding.

## External-Call Attestation

All tests use injected local adapters and mocked `Response` objects. No real Supabase database, Storage, Pinterest, token refresh, migration, deployment, push, merge, or Production action was performed.

## Risks / Follow-up Boundaries

- Storage deployments which do not expose an authoritative SHA-256 metadata header retain the declared checksum as a labelled declared fact; the handler does not buffer a full video solely to hash it. A future storage checksum-verification contract can tighten this without changing the upload API.
- Task 3 owns UI orchestration, per-item retry/cancellation, and direct helper invocation; those paths deliberately remain untouched here.
