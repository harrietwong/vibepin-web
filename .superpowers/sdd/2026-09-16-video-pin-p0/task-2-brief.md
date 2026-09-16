# Task 2 Brief — Private Direct Video Upload And Finalization

## Base And Boundaries

- Worktree: `D:/vp-tmp/wt-video-pin-p0-0916-final`
- Branch: `codex/video-pin-p0-0916-final`
- Official integration base: `04b0ebe0b7b292d6fa2432f6a064740b30314447`
- Task start HEAD: `d7635c02` (reviewed Task 1 + Task 6 transplanted onto the official base).
- No deploy, push, real migration, real Supabase/Storage/Pinterest request, provider token, or Production action.
- Implement only Task 2. Do not change Studio UI, batch draft orchestration, AI Copy, Pinterest publish orchestration, or scheduler.

## Frozen API Contract

- Authenticated `POST /api/studio/video-upload/prepare`.
- Authenticated `POST /api/studio/video-upload/finalize`.
- Authenticated range-capable `GET /api/storage-media?path=...` for private finalized video reads.
- New server modules belong under `web/src/lib/server/media/`; new client upload helper belongs under `web/src/lib/studio/`.
- Prepare body has one batch `idempotencyKey` and 1–20 ordered file descriptors. Each descriptor has stable ordinal/item idempotency key, safe filename, declared MIME/bytes/checksum and observed dimensions/duration. Allow only MP4/M4V/MOV MIME contract and 1..100 MiB. Reject malformed/duplicate ordinals and conflicting replay.
- Authenticate before parsing/provider/database side effects. Owner comes only from verified bearer auth, never the body.
- Allocate a random owner-prefixed private path compatible with v77 (`<uid>/...`), call the v77 service-only prepare RPCs, then issue short-lived Supabase signed upload capabilities with `upsert:false`. Never persist/log signed tokens or URLs.
- Browser helper uploads bytes directly to private Storage; video bytes must never traverse a normal Next multipart handler. Keep concurrency policy outside this task.
- Finalize input identifies only batch + ordinal. Server loads the prepared exact owner/path/facts; it must not trust client-supplied verified facts.
- Finalize verifies exact object existence/path/owner, actual byte size, actual content type, declared equality, and ISO-BMFF `ftyp` in a bounded initial range before calling v77 finalize and registering ready provenance (`media_kind=video`, type, bytes, checksum when verified, dimensions/duration only as labelled facts).
- Empty, oversized, missing, expired, cross-owner, path mismatch, MIME mismatch, invalid `ftyp`, and replay conflict fail closed with stable codes and request id. Duplicate successful finalize returns the original safe result without repeating provider work.
- On failed finalization, remove the exact object. If removal fails, enqueue the v75/v76 durable cleanup outbox. Never log raw path/token/provider body in a client response.
- `GET /api/storage-media` authorizes exact owner+bucket+path via provenance, requires `media_kind=video`, finalized/allowed lifecycle, approved MIME and <=100 MiB. Reject `failed`/`unresolved`, unsafe paths, unknown/mismatched facts, and multi-range requests. Proxy only the requested single range (or safe full response), never expose raw bucket/signed URL.
- Safe response headers: approved `Content-Type`, exact `Content-Length`, optional valid `Content-Range`, `Accept-Ranges: bytes`, `Cache-Control: private, max-age=300`, `Vary: Authorization, Range`, `X-Content-Type-Options: nosniff`. Do not forward cookies/provider headers.

## Required Design

- Use dependency-injected pure handlers/services. Route files only wire auth, service client, Storage adapter, and fetch.
- Extend `mediaProvenance` additively without changing existing image serialization or weakening exact-owner lookup.
- Server stores/RPC wrappers must owner-filter every lookup/update and use v77 idempotency/lifecycle. No client table writes.
- Signed capability production, object stat/range read, delete, cleanup recording, and clock/path factory must be injectable in tests.
- Bound every response body/range read; do not buffer a full 100 MiB video in Next.
- Error bodies use stable `code` + safe `requestId`; never include exception/provider text, raw bucket path, token, signed URL, checksum, or user id.

## TDD And Verification

- Write and observe RED focused tests before production code.
- Cover 401 before body/DB/Storage; feature/config off; 1/20/21 bounds; MIME/size/ordinal/path validation; owner isolation; prepare and finalize idempotency/conflict; signed token redaction; `upsert:false`; actual stat mismatch; missing/empty/oversize; valid/invalid ISO-BMFF `ftyp`; cleanup success/outbox failure compensation; duplicate finalize no repeated reads; exact provenance registration.
- Storage media tests cover auth, exact provenance, cross-owner, lifecycle, MIME/size cap, no raw URL, 200/206, suffix/open ranges if supported, unsatisfiable 416, multi-range rejection, safe headers, upstream network/5xx redaction, and bounded streaming.
- No real service calls. Run focused tests twice, relevant v75/v77 suites, media privacy architecture, test registry, full typecheck, and `git diff --check`.
- Commit only Task 2 files and this brief/report. Write `task-2-implementer-report.md` under this SDD directory with base/head, RED/GREEN evidence, files, risks, and external-call attestation.
