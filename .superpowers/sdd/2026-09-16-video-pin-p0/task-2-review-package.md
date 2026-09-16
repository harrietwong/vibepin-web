# Review package: d7635c02b2bb010380c39d5c7777fbdadbcab8da..5f5fe502968f96effb7fc9be9b9fd372d6520512

## Commits
5f5fe502 feat(video): add private direct upload finalization

## Files changed
 .../sdd/2026-09-16-video-pin-p0/progress.md        |   2 +-
 .../sdd/2026-09-16-video-pin-p0/task-2-brief.md    |  44 ++++
 .../task-2-implementer-report.md                   |  38 ++++
 web/scripts/test-registry.ts                       |   1 +
 web/scripts/test-video-upload-private.ts           | 243 +++++++++++++++++++++
 web/src/app/api/storage-media/route.ts             |  20 ++
 .../app/api/studio/video-upload/finalize/route.ts  |  25 +++
 .../app/api/studio/video-upload/prepare/route.ts   |  28 +++
 web/src/lib/server/media/storageMediaHandler.ts    |  62 ++++++
 web/src/lib/server/media/supabaseVideoStorage.ts   |  34 +++
 web/src/lib/server/media/videoUploadHandler.ts     | 152 +++++++++++++
 web/src/lib/server/media/videoUploadStore.ts       |  55 +++++
 web/src/lib/server/mediaProvenance.ts              |  12 +-
 web/src/lib/studio/videoDirectUpload.ts            |  36 +++
 14 files changed, 749 insertions(+), 3 deletions(-)

## Diff
diff --git a/.superpowers/sdd/2026-09-16-video-pin-p0/progress.md b/.superpowers/sdd/2026-09-16-video-pin-p0/progress.md
index a86a06be..730bdef0 100644
--- a/.superpowers/sdd/2026-09-16-video-pin-p0/progress.md
+++ b/.superpowers/sdd/2026-09-16-video-pin-p0/progress.md
@@ -68,17 +68,17 @@ Implement batch Video Pin P0 without deployment: one video per draft, secure pri
 - `test:v75-media-provenance`: exit 0 with expected `deployment_blocked`; 65 assertions, no failures; blocker is the known legacy broad Storage policy.
 - `test:studio`: first run completed 42/60 and the remaining 18 were blocked only by C-drive npm-cache ENOSPC. Re-run with task-scoped D-drive cache: `test-product-selection` 31/31 plus the other 17 previously blocked scripts all passed; no product assertion failure remained.
 - `npm run typecheck`: exit 0.
 - First `npm run build`: environment-only failure because the worktree has no secrets and C-drive npm cache was full (`supabaseUrl is required` after the ENOSPC was bypassed).
 - Safe-dummy build with `NEXT_PUBLIC_SUPABASE_URL=https://example.invalid`, non-secret dummy keys, and task-scoped D-drive cache/temp: compile, TypeScript, 73 static pages, and final optimization passed; exit 0.
 
 ## Task Status
 
 - Task 0: complete (base `3f74653c`; plan commits `1bb3780d..654cf4f5`; baseline evidence above).
 - Task 1: complete — `873a98db`, review fixes `644e4af1`, `b66746b5`, round-three hardening `f6a4f1f7`, and round-four privilege manifests `82584627`, implemented on `654cf4f5`. v77 now rejects drift in every owned ledger column/default/nullability/constraint, additive provenance column, standalone index, RLS/policy, table/column/function privilege, and client/server privilege boundary while accepting only the intentional active or rolled-back server manifests. PGlite (94 assertions), focused media-store coverage (23/23), and `tsc --noEmit` passed. Final integration must rebase/cherry-pick this reviewed Task 1 sequence onto official base `04b0ebe0`; this worktree has not been rebased. The v75 verifier still reports its pre-existing `deployment_blocked` broad Storage-policy evidence (65 assertions, no failures); Task 1 did not remove or mask it.
-- Task 2: not started.
+- Task 2: implemented locally pending final Task 2 verification/commit. Added injected prepare/finalize and storage-media handlers, service-only v77 RPC/store wiring, private direct-browser upload helper, additive v77 provenance fields, cleanup compensation, and focused contract coverage. No UI, AI Copy, scheduler, Pinterest, external database, Storage, migration, push, merge, or deploy action was taken. See `task-2-implementer-report.md` for TDD and verification evidence.
 - Task 3: not started.
 - Task 4: not started.
 - Task 5: not started.
 - Task 6: not started.
 - Task 7: not started.
 - Task 8: not started.
diff --git a/.superpowers/sdd/2026-09-16-video-pin-p0/task-2-brief.md b/.superpowers/sdd/2026-09-16-video-pin-p0/task-2-brief.md
new file mode 100644
index 00000000..d5786a5f
--- /dev/null
+++ b/.superpowers/sdd/2026-09-16-video-pin-p0/task-2-brief.md
@@ -0,0 +1,44 @@
+# Task 2 Brief — Private Direct Video Upload And Finalization
+
+## Base And Boundaries
+
+- Worktree: `D:/vp-tmp/wt-video-pin-p0-0916-final`
+- Branch: `codex/video-pin-p0-0916-final`
+- Official integration base: `04b0ebe0b7b292d6fa2432f6a064740b30314447`
+- Task start HEAD: `d7635c02` (reviewed Task 1 + Task 6 transplanted onto the official base).
+- No deploy, push, real migration, real Supabase/Storage/Pinterest request, provider token, or Production action.
+- Implement only Task 2. Do not change Studio UI, batch draft orchestration, AI Copy, Pinterest publish orchestration, or scheduler.
+
+## Frozen API Contract
+
+- Authenticated `POST /api/studio/video-upload/prepare`.
+- Authenticated `POST /api/studio/video-upload/finalize`.
+- Authenticated range-capable `GET /api/storage-media?path=...` for private finalized video reads.
+- New server modules belong under `web/src/lib/server/media/`; new client upload helper belongs under `web/src/lib/studio/`.
+- Prepare body has one batch `idempotencyKey` and 1–20 ordered file descriptors. Each descriptor has stable ordinal/item idempotency key, safe filename, declared MIME/bytes/checksum and observed dimensions/duration. Allow only MP4/M4V/MOV MIME contract and 1..100 MiB. Reject malformed/duplicate ordinals and conflicting replay.
+- Authenticate before parsing/provider/database side effects. Owner comes only from verified bearer auth, never the body.
+- Allocate a random owner-prefixed private path compatible with v77 (`<uid>/...`), call the v77 service-only prepare RPCs, then issue short-lived Supabase signed upload capabilities with `upsert:false`. Never persist/log signed tokens or URLs.
+- Browser helper uploads bytes directly to private Storage; video bytes must never traverse a normal Next multipart handler. Keep concurrency policy outside this task.
+- Finalize input identifies only batch + ordinal. Server loads the prepared exact owner/path/facts; it must not trust client-supplied verified facts.
+- Finalize verifies exact object existence/path/owner, actual byte size, actual content type, declared equality, and ISO-BMFF `ftyp` in a bounded initial range before calling v77 finalize and registering ready provenance (`media_kind=video`, type, bytes, checksum when verified, dimensions/duration only as labelled facts).
+- Empty, oversized, missing, expired, cross-owner, path mismatch, MIME mismatch, invalid `ftyp`, and replay conflict fail closed with stable codes and request id. Duplicate successful finalize returns the original safe result without repeating provider work.
+- On failed finalization, remove the exact object. If removal fails, enqueue the v75/v76 durable cleanup outbox. Never log raw path/token/provider body in a client response.
+- `GET /api/storage-media` authorizes exact owner+bucket+path via provenance, requires `media_kind=video`, finalized/allowed lifecycle, approved MIME and <=100 MiB. Reject `failed`/`unresolved`, unsafe paths, unknown/mismatched facts, and multi-range requests. Proxy only the requested single range (or safe full response), never expose raw bucket/signed URL.
+- Safe response headers: approved `Content-Type`, exact `Content-Length`, optional valid `Content-Range`, `Accept-Ranges: bytes`, `Cache-Control: private, max-age=300`, `Vary: Authorization, Range`, `X-Content-Type-Options: nosniff`. Do not forward cookies/provider headers.
+
+## Required Design
+
+- Use dependency-injected pure handlers/services. Route files only wire auth, service client, Storage adapter, and fetch.
+- Extend `mediaProvenance` additively without changing existing image serialization or weakening exact-owner lookup.
+- Server stores/RPC wrappers must owner-filter every lookup/update and use v77 idempotency/lifecycle. No client table writes.
+- Signed capability production, object stat/range read, delete, cleanup recording, and clock/path factory must be injectable in tests.
+- Bound every response body/range read; do not buffer a full 100 MiB video in Next.
+- Error bodies use stable `code` + safe `requestId`; never include exception/provider text, raw bucket path, token, signed URL, checksum, or user id.
+
+## TDD And Verification
+
+- Write and observe RED focused tests before production code.
+- Cover 401 before body/DB/Storage; feature/config off; 1/20/21 bounds; MIME/size/ordinal/path validation; owner isolation; prepare and finalize idempotency/conflict; signed token redaction; `upsert:false`; actual stat mismatch; missing/empty/oversize; valid/invalid ISO-BMFF `ftyp`; cleanup success/outbox failure compensation; duplicate finalize no repeated reads; exact provenance registration.
+- Storage media tests cover auth, exact provenance, cross-owner, lifecycle, MIME/size cap, no raw URL, 200/206, suffix/open ranges if supported, unsatisfiable 416, multi-range rejection, safe headers, upstream network/5xx redaction, and bounded streaming.
+- No real service calls. Run focused tests twice, relevant v75/v77 suites, media privacy architecture, test registry, full typecheck, and `git diff --check`.
+- Commit only Task 2 files and this brief/report. Write `task-2-implementer-report.md` under this SDD directory with base/head, RED/GREEN evidence, files, risks, and external-call attestation.
diff --git a/.superpowers/sdd/2026-09-16-video-pin-p0/task-2-implementer-report.md b/.superpowers/sdd/2026-09-16-video-pin-p0/task-2-implementer-report.md
new file mode 100644
index 00000000..cdbf5818
--- /dev/null
+++ b/.superpowers/sdd/2026-09-16-video-pin-p0/task-2-implementer-report.md
@@ -0,0 +1,38 @@
+# Task 2 Implementer Report — Private Direct Video Upload And Finalization
+
+## Scope And Base
+
+- Base: `d7635c02` (`04b0ebe0b7b292d6fa2432f6a064740b30314447` integration lineage).
+- Branch/worktree: `codex/video-pin-p0-0916-final` / `D:/vp-tmp/wt-video-pin-p0-0916-final`.
+- Head: recorded after the Task 2-only commit below.
+- Scope was limited to Task 2 server handlers, route wiring, private-provenance extension, direct browser helper, focused test registry entry, this brief, and Task 2 ledger/report evidence. No Studio UI, AI Copy, scheduler, draft orchestration, or Pinterest publish code changed.
+
+## Implementation
+
+- `POST /api/studio/video-upload/prepare` authenticates before JSON parsing or provider/database side effects, validates a 1–20 descriptor batch, persists via owner-filtered v77 RPCs, and creates short-lived direct-upload capabilities with `upsert:false`.
+- `POST /api/studio/video-upload/finalize` reads the exact server-owned item, validates object existence/type/size/checksum metadata and bounded ISO-BMFF `ftyp`, invokes v77 finalization, and registers owner-exact video provenance. Failure removes only the exact object and records the v75 cleanup outbox if deletion fails.
+- `GET /api/storage-media` requires bearer authentication and exact ready/allowed video provenance, accepts only one bounded range, returns fixed safe headers, proxies only that range, and neither forwards provider headers nor exposes provider URLs.
+- The browser helper sends bytes from `uploadToSignedUrl` directly to private Storage; it does not route a video multipart body through Next.
+
+## TDD Evidence
+
+- RED 1: missing pure handlers produced `ERR_MODULE_NOT_FOUND` before implementation.
+- RED 2: an injected upstream response longer than the requested range was exposed by the proxy; the new bounded range stream makes the focused test reject it.
+- RED 3: an unrecognised provenance lifecycle was served; the proxy now admits only explicit allowed lifecycle states.
+- RED 4: a matching prepare replay generated a new path; prepare now reuses the owner-filtered stored item path, preserving v77 immutable-fact conflict detection.
+- GREEN: `npx tsx scripts/test-video-upload-private.ts` reports 11/11 focused behaviours after the final replay/lifecycle fixes; the final verification section records the repeated run.
+
+## Required Behaviour Coverage
+
+- Authentication before parsing/DB/Storage, feature/config denial, 1/20/21 count and duplicate ordinal/key rejection, MIME/size/name/path validation, owner isolation, prepare conflict/replay, token/error redaction, and `upsert:false`.
+- Missing/empty/oversized/type-or-size-mismatched/expired/cross-owner finalization, valid and invalid `ftyp`, exact provenance, successful-finalize replay without another read, object removal, and cleanup-outbox compensation.
+- Storage-media auth/exact provenance/cross-owner/lifecycle/MIME/size gates; 200, 206, open/suffix and multi/unsatisfiable range handling; safe headers; provider failure redaction; and stream bounding.
+
+## External-Call Attestation
+
+All tests use injected local adapters and mocked `Response` objects. No real Supabase database, Storage, Pinterest, token refresh, migration, deployment, push, merge, or Production action was performed.
+
+## Risks / Follow-up Boundaries
+
+- Storage deployments which do not expose an authoritative SHA-256 metadata header retain the declared checksum as a labelled declared fact; the handler does not buffer a full video solely to hash it. A future storage checksum-verification contract can tighten this without changing the upload API.
+- Task 3 owns UI orchestration, per-item retry/cancellation, and direct helper invocation; those paths deliberately remain untouched here.
diff --git a/web/scripts/test-registry.ts b/web/scripts/test-registry.ts
index 0e3aef72..b72835da 100644
--- a/web/scripts/test-registry.ts
+++ b/web/scripts/test-registry.ts
@@ -153,20 +153,21 @@ export const CORE: string[] = [
   "test-publish-due-claim",
   "test-schedule-cancel-cas",
   "test-expire-reservations-cron",
   "test-publish-events",
   "test-user-store-sync",
   "test-user-store-route",
   "test-user-store-adapters",
   "test-user-store-media-adapters",
   "test-media-offload",
   "test-media-privacy-architecture",
+  "test-video-upload-private",
   // Shopify
   "test-connection-limit",
   "test-settle-generation-job",
   "test-generation-job-route",
   "test-shopify-entitlements",
   "test-shopify-connection-store",
   "test-shopify-hmac",
   "test-shopify-oauth-state",
   "test-shopify-callback-auth",
   "test-shopify-normalize",
diff --git a/web/scripts/test-video-upload-private.ts b/web/scripts/test-video-upload-private.ts
new file mode 100644
index 00000000..ed2735c1
--- /dev/null
+++ b/web/scripts/test-video-upload-private.ts
@@ -0,0 +1,243 @@
+import assert from "node:assert/strict";
+
+const OWNER = "00000000-0000-4000-8000-000000000001";
+const OTHER_OWNER = "00000000-0000-4000-8000-000000000002";
+const SHA = "a".repeat(64);
+const MP4_FTYP = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
+
+let passed = 0;
+async function test(name: string, fn: () => Promise<void> | void) {
+  await fn();
+  passed += 1;
+  console.log(`  OK ${name}`);
+}
+
+function request(url: string, body?: unknown, headers: HeadersInit = {}) {
+  return new Request(url, { method: "POST", headers: { "content-type": "application/json", "x-request-id": "req_1", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
+}
+
+function descriptor(ordinal = 0, overrides: Record<string, unknown> = {}) {
+  return { ordinal, idempotencyKey: `item_${ordinal}`, filename: "clip.mp4", contentType: "video/mp4", byteSize: 12, checksumSha256: SHA, width: 1080, height: 1920, durationMs: 5_000, ...overrides };
+}
+
+function preparedItem(overrides: Record<string, unknown> = {}) {
+  return { batchId: "11111111-1111-4111-8111-111111111111", ordinal: 0, status: "prepared", privatePath: `${OWNER}/video/a.mp4`, declaredContentType: "video/mp4", declaredByteSize: 12, declaredChecksumSha256: SHA, declaredWidth: 1080, declaredHeight: 1920, declaredDurationMs: 5_000, expiresAt: "2099-01-01T00:00:00.000Z", ...overrides };
+}
+
+async function main() {
+  const { handleVideoUploadPrepare, handleVideoUploadFinalize } = await import("../src/lib/server/media/videoUploadHandler");
+  const { handleStorageMediaGet } = await import("../src/lib/server/media/storageMediaHandler");
+
+  await test("prepare authenticates before parsing, storage, or database side effects", async () => {
+    let effects = 0;
+    const response = await handleVideoUploadPrepare(new Request("https://app.test/api/studio/video-upload/prepare", { method: "POST", body: "not json" }), {
+      getUserId: async () => null, enabled: true, configured: true,
+      store: { prepareBatch: async () => { effects++; throw new Error("unexpected"); }, prepareItem: async () => { effects++; throw new Error("unexpected"); }, findItem: async () => null, finalizeItem: async () => ({ status: "finalized" }), failItem: async () => {} },
+      createSignedUpload: async () => { effects++; throw new Error("unexpected"); },
+    });
+    assert.equal(response.status, 401);
+    assert.equal(effects, 0);
+    assert.deepEqual(await response.json(), { code: "unauthorized", requestId: "" });
+  });
+
+  await test("feature and configuration gates deny prepare before database or Storage work", async () => {
+    let effects = 0;
+    const base = { getUserId: async () => OWNER, store: { prepareBatch: async () => { effects++; return { batchId: "unexpected" }; }, prepareItem: async () => ({ status: "prepared" }), findItem: async () => null, finalizeItem: async () => ({ status: "finalized" }), failItem: async () => {} }, createSignedUpload: async () => { effects++; return { token: "unexpected", signedUrl: "https://storage.test/unexpected" }; } };
+    const disabled = await handleVideoUploadPrepare(request("https://app.test/prepare", { bad: "body" }), { ...base, enabled: false, configured: true });
+    const unconfigured = await handleVideoUploadPrepare(request("https://app.test/prepare", { bad: "body" }), { ...base, enabled: true, configured: false });
+    assert.equal(disabled.status, 404);
+    assert.equal(unconfigured.status, 503);
+    assert.equal(effects, 0);
+  });
+
+  await test("prepare bounds the batch and rejects unsafe facts before issuing capabilities", async () => {
+    let signed = 0;
+    const deps = {
+      getUserId: async () => OWNER, enabled: true, configured: true,
+      store: { prepareBatch: async () => ({ batchId: "11111111-1111-4111-8111-111111111111" }), prepareItem: async () => ({ status: "prepared" }), findItem: async () => null, finalizeItem: async () => ({ status: "finalized" }), failItem: async () => {} },
+      createSignedUpload: async () => { signed++; return { token: "secret-token", signedUrl: "https://storage.test/secret" }; },
+    };
+    for (const files of [[], Array.from({ length: 21 }, (_, ordinal) => descriptor(ordinal)), [descriptor(0, { contentType: "video/webm" })], [descriptor(0, { byteSize: 104857601 })], [descriptor(0), descriptor(0)]]) {
+      const response = await handleVideoUploadPrepare(request("https://app.test/prepare", { idempotencyKey: "batch_1", files }), deps);
+      assert.equal(response.status, files.length === 21 ? 413 : 400);
+      assert.equal((await response.json() as { code: string }).code, files.length === 21 ? "batch_limit_exceeded" : "invalid_video_upload");
+    }
+    assert.equal(signed, 0);
+  });
+
+  await test("prepare creates owner-scoped paths, uses upsert false, and never puts a token in an error", async () => {
+    const calls: unknown[] = [];
+    const response = await handleVideoUploadPrepare(request("https://app.test/prepare", { idempotencyKey: "batch_1", files: [descriptor()] }), {
+      getUserId: async () => OWNER, enabled: true, configured: true,
+      pathFactory: (owner, batch, ordinal) => `${owner}/videos/${batch}/${ordinal}.mp4`,
+      store: {
+        prepareBatch: async input => { calls.push(input); return { batchId: "11111111-1111-4111-8111-111111111111" }; },
+        prepareItem: async input => { calls.push(input); return { status: "prepared" }; }, findItem: async () => null, finalizeItem: async () => ({ status: "finalized" }), failItem: async () => {},
+      },
+      createSignedUpload: async input => { calls.push(input); return { token: "signed-token", signedUrl: "https://storage.test/signed" }; },
+    });
+    assert.equal(response.status, 200);
+    const body = await response.json() as { uploads: Array<{ token: string; path: string; upsert: boolean }> };
+    assert.equal(body.uploads[0].token, "signed-token");
+    assert.equal(body.uploads[0].path, `${OWNER}/videos/11111111-1111-4111-8111-111111111111/0.mp4`);
+    assert.deepEqual(calls.at(-1), { bucket: "generated-private", path: body.uploads[0].path, contentType: "video/mp4", upsert: false });
+  });
+
+  await test("prepare accepts exactly twenty ordered items but refuses unsafe paths and replay conflicts without leaking capabilities", async () => {
+    let signed = 0;
+    const base = {
+      getUserId: async () => OWNER, enabled: true, configured: true,
+      store: { prepareBatch: async () => ({ batchId: "11111111-1111-4111-8111-111111111111" }), prepareItem: async () => ({ status: "prepared" }), findItem: async () => null, finalizeItem: async () => ({ status: "finalized" }), failItem: async () => {} },
+      createSignedUpload: async () => { signed++; return { token: "capability-token", signedUrl: "https://storage.test/capability" }; },
+    };
+    const twenty = await handleVideoUploadPrepare(request("https://app.test/prepare", { idempotencyKey: "batch_twenty", files: Array.from({ length: 20 }, (_, ordinal) => descriptor(ordinal)) }), base);
+    assert.equal(twenty.status, 200);
+    assert.equal((await twenty.json() as { uploads: unknown[] }).uploads.length, 20);
+    const unsafe = await handleVideoUploadPrepare(request("https://app.test/prepare", { idempotencyKey: "batch_unsafe", files: [descriptor()] }), { ...base, pathFactory: () => `${OTHER_OWNER}/escape.mp4` });
+    assert.equal(unsafe.status, 503);
+    const conflict = await handleVideoUploadPrepare(request("https://app.test/prepare", { idempotencyKey: "batch_conflict", files: [descriptor()] }), { ...base, store: { ...base.store, prepareItem: async () => { throw new Error("provider says token=capability-token"); } } });
+    assert.equal(conflict.status, 502);
+    assert.doesNotMatch(await conflict.text(), /capability-token|provider/i);
+  });
+
+  await test("matching prepare replay reuses the server-owned path while conflicting declared facts stay closed", async () => {
+    const existing = preparedItem();
+    let preparedPath = "";
+    const response = await handleVideoUploadPrepare(request("https://app.test/prepare", { idempotencyKey: "batch_replay", files: [descriptor()] }), {
+      getUserId: async () => OWNER, enabled: true, configured: true,
+      store: { prepareBatch: async () => ({ batchId: existing.batchId }), prepareItem: async input => { preparedPath = input.privatePath; return { status: "prepared" }; }, findItem: async () => existing, finalizeItem: async () => ({ status: "finalized" }), failItem: async () => {} },
+      createSignedUpload: async () => ({ token: "fresh-capability", signedUrl: "https://storage.test/fresh" }),
+      pathFactory: () => `${OWNER}/should-not-be-used.mp4`,
+    });
+    assert.equal(response.status, 200);
+    assert.equal(preparedPath, existing.privatePath);
+    assert.equal((await response.json() as { uploads: Array<{ path: string }> }).uploads[0].path, existing.privatePath);
+  });
+
+  await test("finalize checks only server-loaded facts, validates ftyp, registers exact video provenance, and is idempotent", async () => {
+    let reads = 0;
+    let registered: unknown;
+    const item = preparedItem();
+    const deps = {
+      getUserId: async () => OWNER, enabled: true, configured: true,
+      store: { prepareBatch: async () => ({ batchId: item.batchId }), prepareItem: async () => ({ status: "prepared" }), findItem: async () => item, finalizeItem: async () => ({ status: "finalized" }), failItem: async () => {} },
+      createSignedUpload: async () => ({ token: "token", signedUrl: "https://storage.test/token" }),
+      storage: {
+        stat: async () => ({ exists: true, contentType: "video/mp4", byteSize: 12, checksumSha256: SHA }),
+        readRange: async () => { reads++; return new Response(MP4_FTYP); },
+        remove: async () => {},
+      },
+      registerProvenance: async (input: unknown) => { registered = input; return true; }, recordCleanup: async () => {},
+    };
+    const success = await handleVideoUploadFinalize(request("https://app.test/finalize", { batchId: item.batchId, ordinal: 0 }), deps);
+    assert.equal(success.status, 200);
+    assert.equal(reads, 1);
+    assert.deepEqual(registered, { owner_user_id: OWNER, bucket_id: "generated-private", object_path: item.privatePath, source_type: "upload", intent_id: null, lifecycle_state: "draft", media_kind: "video", content_type: "video/mp4", byte_size: 12, checksum_sha256: SHA, width: 1080, height: 1920, duration_ms: 5_000 });
+
+    const replay = await handleVideoUploadFinalize(request("https://app.test/finalize", { batchId: item.batchId, ordinal: 0 }), { ...deps, store: { ...deps.store, findItem: async () => ({ ...item, status: "finalized" }) } });
+    assert.equal(replay.status, 200);
+    assert.equal(reads, 1, "successful replay must not re-read Storage");
+  });
+
+  await test("finalize fails closed and compensates an invalid object through durable cleanup", async () => {
+    let removed = 0;
+    let cleanup: unknown;
+    const item = preparedItem();
+    const response = await handleVideoUploadFinalize(request("https://app.test/finalize", { batchId: item.batchId, ordinal: 0 }), {
+      getUserId: async () => OWNER, enabled: true, configured: true,
+      store: { prepareBatch: async () => ({ batchId: item.batchId }), prepareItem: async () => ({ status: "prepared" }), findItem: async () => item, finalizeItem: async () => ({ status: "finalized" }), failItem: async () => {} },
+      createSignedUpload: async () => ({ token: "token", signedUrl: "https://storage.test/token" }),
+      storage: { stat: async () => ({ exists: true, contentType: "video/mp4", byteSize: 12, checksumSha256: SHA }), readRange: async () => new Response(new Uint8Array([1, 2, 3])), remove: async () => { removed++; throw new Error("storage failure"); } },
+      registerProvenance: async () => true, recordCleanup: async input => { cleanup = input; },
+    });
+    assert.equal(response.status, 422);
+    assert.equal((await response.json() as { code: string }).code, "invalid_video_container");
+    assert.equal(removed, 1);
+    assert.deepEqual(cleanup, { owner_user_id: OWNER, bucket_id: "generated-private", object_path: item.privatePath, reason: "invalid_video_container" });
+  });
+
+  await test("finalize rejects missing, empty, mismatched, expired, and cross-owner objects before ready provenance", async () => {
+    const item = preparedItem();
+    for (const [name, stat, itemOverride, expected] of [
+      ["missing", { exists: false }, {}, 404],
+      ["empty", { exists: true, contentType: "video/mp4", byteSize: 0, checksumSha256: SHA }, {}, 422],
+      ["type", { exists: true, contentType: "video/quicktime", byteSize: 12, checksumSha256: SHA }, {}, 422],
+      ["size", { exists: true, contentType: "video/mp4", byteSize: 13, checksumSha256: SHA }, {}, 422],
+      ["expired", { exists: true, contentType: "video/mp4", byteSize: 12, checksumSha256: SHA }, { expiresAt: "2000-01-01T00:00:00.000Z" }, 422],
+    ] as const) {
+      let registered = 0; let reads = 0;
+      const result = await handleVideoUploadFinalize(request("https://app.test/finalize", { batchId: item.batchId, ordinal: 0 }), {
+        getUserId: async () => OWNER, enabled: true, configured: true,
+        store: { prepareBatch: async () => ({ batchId: item.batchId }), prepareItem: async () => ({ status: "prepared" }), findItem: async () => ({ ...item, ...itemOverride }), finalizeItem: async () => ({ status: "finalized" }), failItem: async () => {} },
+        createSignedUpload: async () => ({ token: "token", signedUrl: "https://storage.test/token" }),
+        storage: { stat: async () => stat, readRange: async () => { reads++; return new Response(MP4_FTYP); }, remove: async () => {} }, registerProvenance: async () => { registered++; return true; },
+      });
+      assert.equal(result.status, expected, name);
+      assert.equal(registered, 0, `${name} must not register ready provenance`);
+      if (name !== "expired") assert.equal(reads, 0, `${name} must fail before ftyp`);
+    }
+    const crossOwner = await handleVideoUploadFinalize(request("https://app.test/finalize", { batchId: item.batchId, ordinal: 0 }), {
+      getUserId: async () => OTHER_OWNER, enabled: true, configured: true,
+      store: { prepareBatch: async () => ({ batchId: item.batchId }), prepareItem: async () => ({ status: "prepared" }), findItem: async () => null, finalizeItem: async () => ({ status: "finalized" }), failItem: async () => {} }, createSignedUpload: async () => ({ token: "token", signedUrl: "https://storage.test/token" }),
+      storage: { stat: async () => { throw new Error("must not stat"); }, readRange: async () => { throw new Error("must not read"); }, remove: async () => {} }, registerProvenance: async () => true,
+    });
+    assert.equal(crossOwner.status, 404);
+  });
+
+  await test("video proxy enforces exact ready provenance and serves a single bounded range without provider leakage", async () => {
+    let fetches = 0;
+    const path = `${OWNER}/videos/a.mp4`;
+    const response = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`, { headers: { range: "bytes=4-7" } }), {
+      getUserId: async () => OWNER, configured: true,
+      findProvenance: async () => ({ owner_user_id: OWNER, bucket_id: "generated-private", object_path: path, source_type: "upload", intent_id: null, lifecycle_state: "draft", media_kind: "video", content_type: "video/mp4", byte_size: 12 }),
+      readRange: async input => { fetches++; assert.deepEqual(input, { bucket: "generated-private", path, start: 4, end: 7 }); return new Response(new Uint8Array([0x66, 0x74, 0x79, 0x70])); },
+    });
+    assert.equal(response.status, 206);
+    assert.equal(response.headers.get("content-range"), "bytes 4-7/12");
+    assert.equal(response.headers.get("content-length"), "4");
+    assert.equal(response.headers.get("vary"), "Authorization, Range");
+    assert.equal(await response.text(), "ftyp");
+    assert.equal(fetches, 1);
+
+    const denied = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`), {
+      getUserId: async () => OTHER_OWNER, configured: true,
+      findProvenance: async () => null,
+      readRange: async () => { throw new Error("must not read"); },
+    });
+    assert.equal(denied.status, 403);
+  });
+
+  await test("video proxy rejects multi and unsatisfiable ranges and redacts upstream failures", async () => {
+    const path = `${OWNER}/videos/a.mp4`;
+    const deps = { getUserId: async () => OWNER, configured: true, findProvenance: async () => ({ owner_user_id: OWNER, bucket_id: "generated-private", object_path: path, source_type: "upload", intent_id: null, lifecycle_state: "draft", media_kind: "video", content_type: "video/mp4", byte_size: 12 }), readRange: async () => { throw new Error("https://storage.test/raw?token=secret"); } };
+    const multi = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`, { headers: { range: "bytes=0-1,3-4" } }), deps);
+    assert.equal(multi.status, 416);
+    const failed = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`), deps);
+    assert.equal(failed.status, 502);
+    assert.doesNotMatch(await failed.text(), /storage|secret|token/i);
+  });
+
+  await test("video proxy supports full, open, and suffix ranges, blocks unsafe lifecycle, and bounds an oversized upstream body", async () => {
+    const path = `${OWNER}/videos/a.mp4`;
+    const provenance = { owner_user_id: OWNER, bucket_id: "generated-private", object_path: path, source_type: "upload", intent_id: null, lifecycle_state: "draft", media_kind: "video", content_type: "video/mp4", byte_size: 12 };
+    const calls: Array<{ start: number; end: number }> = [];
+    const deps = { getUserId: async () => OWNER, configured: true, findProvenance: async () => provenance, readRange: async ({ start, end }: { start: number; end: number }) => { calls.push({ start, end }); return new Response(new Uint8Array(end - start + 1)); } };
+    const full = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`), deps);
+    assert.equal(full.status, 200);
+    const open = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`, { headers: { range: "bytes=8-" } }), deps);
+    assert.equal(open.status, 206);
+    const suffix = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`, { headers: { range: "bytes=-3" } }), deps);
+    assert.equal(suffix.status, 206);
+    assert.deepEqual(calls, [{ start: 0, end: 11 }, { start: 8, end: 11 }, { start: 9, end: 11 }]);
+    const lifecycle = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`), { ...deps, findProvenance: async () => ({ ...provenance, lifecycle_state: "failed" }) });
+    assert.equal(lifecycle.status, 403);
+    const unknownLifecycle = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`), { ...deps, findProvenance: async () => ({ ...provenance, lifecycle_state: "finalizing" }) });
+    assert.equal(unknownLifecycle.status, 403, "only explicitly allowed video lifecycle states may be proxied");
+    const bounded = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`, { headers: { range: "bytes=0-3" } }), { ...deps, readRange: async () => new Response(new Uint8Array(9)) });
+    await assert.rejects(() => bounded.arrayBuffer(), /range body exceeded/i, "the proxy must not expose bytes beyond the selected range");
+  });
+
+  console.log(`\nPrivate video upload: ${passed} passed, 0 failed`);
+}
+
+main().catch(error => { console.error(error); process.exitCode = 1; });
diff --git a/web/src/app/api/storage-media/route.ts b/web/src/app/api/storage-media/route.ts
new file mode 100644
index 00000000..db767778
--- /dev/null
+++ b/web/src/app/api/storage-media/route.ts
@@ -0,0 +1,20 @@
+import { getUserIdFromBearer } from "@/lib/server/authUser";
+import { createMediaProvenanceStore } from "@/lib/server/mediaProvenance";
+import { createSupabaseVideoStorage } from "@/lib/server/media/supabaseVideoStorage";
+import { handleStorageMediaGet } from "@/lib/server/media/storageMediaHandler";
+import { VIDEO_UPLOAD_BUCKET } from "@/lib/server/media/videoUploadHandler";
+
+export const runtime = "nodejs";
+export const dynamic = "force-dynamic";
+
+export async function GET(req: Request) {
+  const bucket = process.env.VIBEPIN_DRAFT_BUCKET ?? VIDEO_UPLOAD_BUCKET;
+  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
+  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
+  const storage = createSupabaseVideoStorage({ supabaseUrl: url, serviceRoleKey: key });
+  return handleStorageMediaGet(req, {
+    getUserId: getUserIdFromBearer, configured: Boolean(url && key), bucket,
+    findProvenance: (owner, activeBucket, path) => createMediaProvenanceStore().findExact(owner, activeBucket, path),
+    readRange: storage.readRange,
+  });
+}
diff --git a/web/src/app/api/studio/video-upload/finalize/route.ts b/web/src/app/api/studio/video-upload/finalize/route.ts
new file mode 100644
index 00000000..90c969f4
--- /dev/null
+++ b/web/src/app/api/studio/video-upload/finalize/route.ts
@@ -0,0 +1,25 @@
+import { getUserIdFromBearer } from "@/lib/server/authUser";
+import { createMediaProvenanceStore } from "@/lib/server/mediaProvenance";
+import { createSupabaseVideoStorage } from "@/lib/server/media/supabaseVideoStorage";
+import { handleVideoUploadFinalize, VIDEO_UPLOAD_BUCKET } from "@/lib/server/media/videoUploadHandler";
+import { createVideoUploadStore } from "@/lib/server/media/videoUploadStore";
+import { createServerClient } from "@/lib/supabase";
+
+export const runtime = "nodejs";
+export const dynamic = "force-dynamic";
+
+export async function POST(req: Request) {
+  let db: ReturnType<typeof createServerClient> | null = null;
+  const client = () => (db ??= createServerClient());
+  const bucket = process.env.VIBEPIN_DRAFT_BUCKET ?? VIDEO_UPLOAD_BUCKET;
+  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
+  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
+  return handleVideoUploadFinalize(req, {
+    getUserId: getUserIdFromBearer, enabled: process.env.VIDEO_PIN_UPLOAD_ENABLED === "true", configured: Boolean(url && key), bucket,
+    store: createVideoUploadStore(client()),
+    createSignedUpload: async () => { throw new Error("unused"); },
+    storage: createSupabaseVideoStorage({ supabaseUrl: url, serviceRoleKey: key }),
+    registerProvenance: input => createMediaProvenanceStore(client()).register(input),
+    recordCleanup: input => createMediaProvenanceStore(client()).recordCleanup(input),
+  });
+}
diff --git a/web/src/app/api/studio/video-upload/prepare/route.ts b/web/src/app/api/studio/video-upload/prepare/route.ts
new file mode 100644
index 00000000..08ea2e5f
--- /dev/null
+++ b/web/src/app/api/studio/video-upload/prepare/route.ts
@@ -0,0 +1,28 @@
+import { getUserIdFromBearer } from "@/lib/server/authUser";
+import { createMediaProvenanceStore } from "@/lib/server/mediaProvenance";
+import { handleVideoUploadPrepare, VIDEO_UPLOAD_BUCKET } from "@/lib/server/media/videoUploadHandler";
+import { createVideoUploadStore } from "@/lib/server/media/videoUploadStore";
+import { createServerClient } from "@/lib/supabase";
+
+export const runtime = "nodejs";
+export const dynamic = "force-dynamic";
+
+export async function POST(req: Request) {
+  let db: ReturnType<typeof createServerClient> | null = null;
+  const client = () => (db ??= createServerClient());
+  const bucket = process.env.VIBEPIN_DRAFT_BUCKET ?? VIDEO_UPLOAD_BUCKET;
+  return handleVideoUploadPrepare(req, {
+    getUserId: getUserIdFromBearer,
+    enabled: process.env.VIDEO_PIN_UPLOAD_ENABLED === "true",
+    configured: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY), bucket,
+    store: createVideoUploadStore(client()),
+    createSignedUpload: async ({ path, contentType, upsert }) => {
+      const { data, error } = await client().storage.from(bucket).createSignedUploadUrl(path, { upsert });
+      if (error || !data?.token || !data.signedUrl) throw new Error("signed_upload_unavailable");
+      return { token: data.token, signedUrl: data.signedUrl };
+    },
+    // Kept here only to make the service dependency explicit for the route's
+    // compile-time wiring; prepare itself has no provenance write.
+    registerProvenance: input => createMediaProvenanceStore(client()).register(input),
+  });
+}
diff --git a/web/src/lib/server/media/storageMediaHandler.ts b/web/src/lib/server/media/storageMediaHandler.ts
new file mode 100644
index 00000000..5f101fee
--- /dev/null
+++ b/web/src/lib/server/media/storageMediaHandler.ts
@@ -0,0 +1,62 @@
+import type { MediaProvenance } from "@/lib/server/mediaProvenance";
+import { ALLOWED_VIDEO_TYPES, MAX_VIDEO_UPLOAD_BYTES, VIDEO_UPLOAD_BUCKET } from "./videoUploadHandler";
+
+export type StorageMediaDeps = {
+  getUserId(req: Request): Promise<string | null>; configured: boolean; bucket?: string;
+  findProvenance(ownerUserId: string, bucket: string, path: string): Promise<MediaProvenance | null>;
+  readRange(input: { bucket: string; path: string; start: number; end: number }): Promise<Response>;
+};
+const ALLOWED_VIDEO_LIFECYCLES = new Set(["draft", "publish_pending", "published", "retained"]);
+
+function pathStatus(owner: string, path: string | null): 0 | 400 | 403 {
+  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("..") || path.includes("//")) return 400;
+  return path.split("/")[0] === owner ? 0 : 403;
+}
+function empty(status: number) { return new Response(null, { status }); }
+function range(value: string | null, size: number): { start: number; end: number; partial: boolean } | null {
+  if (!value) return { start: 0, end: size - 1, partial: false };
+  if (value.includes(",") || !value.startsWith("bytes=")) return null;
+  const match = /^bytes=(\d*)-(\d*)$/.exec(value); if (!match || (!match[1] && !match[2])) return null;
+  let start: number; let end: number;
+  if (!match[1]) { const suffix = Number(match[2]); if (!Number.isSafeInteger(suffix) || suffix < 1) return null; start = Math.max(0, size - suffix); end = size - 1; }
+  else { start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1; if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return null; end = Math.min(end, size - 1); }
+  return { start, end, partial: true };
+}
+
+/** Reject a misbehaving upstream rather than streaming bytes past the authorized range. */
+function boundedRangeBody(body: ReadableStream<Uint8Array>, maximum: number): ReadableStream<Uint8Array> {
+  let received = 0;
+  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
+    transform(chunk, controller) {
+      received += chunk.byteLength;
+      if (received > maximum) {
+        controller.error(new Error("range body exceeded"));
+        return;
+      }
+      controller.enqueue(chunk);
+    },
+  }));
+}
+
+export async function handleStorageMediaGet(req: Request, deps: StorageMediaDeps): Promise<Response> {
+  const owner = await deps.getUserId(req).catch(() => null); if (!owner) return empty(401);
+  if (!deps.configured) return empty(404);
+  const url = new URL(req.url); if (url.searchParams.getAll("path").length !== 1 || [...url.searchParams.keys()].some(key => key !== "path")) return empty(400);
+  const path = url.searchParams.get("path"); const unsafe = pathStatus(owner, path); if (unsafe) return empty(unsafe);
+  const bucket = deps.bucket ?? VIDEO_UPLOAD_BUCKET;
+  const provenance = await deps.findProvenance(owner, bucket, path!).catch(() => null);
+  if (!provenance || provenance.owner_user_id !== owner || provenance.bucket_id !== bucket || provenance.object_path !== path || provenance.media_kind !== "video" || !ALLOWED_VIDEO_LIFECYCLES.has(provenance.lifecycle_state) || !ALLOWED_VIDEO_TYPES.has(provenance.content_type ?? "") || !Number.isSafeInteger(provenance.byte_size) || provenance.byte_size! < 1 || provenance.byte_size! > MAX_VIDEO_UPLOAD_BYTES) return empty(403);
+  const requested = range(req.headers.get("range"), provenance.byte_size!); if (!requested) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${provenance.byte_size}` } });
+  try {
+    const upstream = await deps.readRange({ bucket, path: path!, start: requested.start, end: requested.end });
+    const expected = requested.end - requested.start + 1;
+    const contentLength = upstream.headers.get("content-length");
+    const length = contentLength === null ? null : Number(contentLength);
+    if (!upstream.ok || !upstream.body || (length !== null && (!Number.isSafeInteger(length) || length !== expected))) { await upstream.body?.cancel(); return empty(502); }
+    return new Response(boundedRangeBody(upstream.body, expected), { status: requested.partial ? 206 : 200, headers: {
+      "Content-Type": provenance.content_type!, "Content-Length": String(expected),
+      ...(requested.partial ? { "Content-Range": `bytes ${requested.start}-${requested.end}/${provenance.byte_size}` } : {}),
+      "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=300", Vary: "Authorization, Range", "X-Content-Type-Options": "nosniff",
+    } });
+  } catch { return empty(502); }
+}
diff --git a/web/src/lib/server/media/supabaseVideoStorage.ts b/web/src/lib/server/media/supabaseVideoStorage.ts
new file mode 100644
index 00000000..5f56ee6d
--- /dev/null
+++ b/web/src/lib/server/media/supabaseVideoStorage.ts
@@ -0,0 +1,34 @@
+import type { VideoObjectStorage } from "./videoUploadHandler";
+
+function objectUrl(base: string, bucket: string, path: string) {
+  return `${base.replace(/\/$/, "")}/storage/v1/object/${encodeURIComponent(bucket)}/${path.split("/").map(encodeURIComponent).join("/")}`;
+}
+
+/** A narrow, injected service-role Storage adapter. It never creates public URLs. */
+export function createSupabaseVideoStorage(input: { supabaseUrl: string; serviceRoleKey: string; fetchImpl?: typeof fetch }): VideoObjectStorage {
+  const fetchImpl = input.fetchImpl ?? fetch;
+  const headers = { Authorization: `Bearer ${input.serviceRoleKey}`, apikey: input.serviceRoleKey };
+  return {
+    async stat({ bucket, path }) {
+      const response = await fetchImpl(objectUrl(input.supabaseUrl, bucket, path), { method: "HEAD", headers });
+      if (response.status === 404) return { exists: false };
+      if (!response.ok) throw new Error("storage_stat_failed");
+      const size = Number(response.headers.get("content-length"));
+      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
+      // Supabase-compatible object stores may expose an authoritative SHA-256
+      // as object metadata. When unavailable the v77 declared checksum is retained
+      // as an explicitly declared fact; bytes are never buffered to hash them here.
+      const checksumSha256 = response.headers.get("x-amz-meta-sha256") ?? undefined;
+      return { exists: true, contentType, byteSize: Number.isSafeInteger(size) ? size : undefined, checksumSha256 };
+    },
+    readRange({ bucket, path, start, end }) {
+      return fetchImpl(objectUrl(input.supabaseUrl, bucket, path), { headers: { ...headers, Range: `bytes=${start}-${end}` } });
+    },
+    async remove({ bucket, path }) {
+      const response = await fetchImpl(`${input.supabaseUrl.replace(/\/$/, "")}/storage/v1/object/${encodeURIComponent(bucket)}`, {
+        method: "DELETE", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ prefixes: [path] }),
+      });
+      if (!response.ok) throw new Error("storage_remove_failed");
+    },
+  };
+}
diff --git a/web/src/lib/server/media/videoUploadHandler.ts b/web/src/lib/server/media/videoUploadHandler.ts
new file mode 100644
index 00000000..9b35a5b9
--- /dev/null
+++ b/web/src/lib/server/media/videoUploadHandler.ts
@@ -0,0 +1,152 @@
+import type { MediaProvenance } from "@/lib/server/mediaProvenance";
+
+export const VIDEO_UPLOAD_BUCKET = "generated-private";
+export const MAX_VIDEO_UPLOAD_BYTES = 100 * 1024 * 1024;
+export const MAX_VIDEO_UPLOAD_ITEMS = 20;
+export const ALLOWED_VIDEO_TYPES = new Set(["video/mp4", "video/x-m4v", "video/quicktime"]);
+
+type PreparedItem = {
+  batchId: string; ordinal: number; status: string; privatePath: string;
+  declaredContentType: string; declaredByteSize: number; declaredChecksumSha256: string;
+  declaredWidth: number; declaredHeight: number; declaredDurationMs: number; expiresAt: string;
+};
+
+export type VideoUploadStore = {
+  prepareBatch(input: { ownerUserId: string; idempotencyKey: string; expiresAt: string }): Promise<{ batchId: string }>;
+  prepareItem(input: { ownerUserId: string; batchId: string; ordinal: number; idempotencyKey: string; privatePath: string; contentType: string; byteSize: number; checksumSha256: string; width: number; height: number; durationMs: number }): Promise<{ status: string }>;
+  findItem(ownerUserId: string, batchId: string, ordinal: number): Promise<PreparedItem | null>;
+  finalizeItem(input: { ownerUserId: string; batchId: string; ordinal: number; contentType: string; byteSize: number; checksumSha256: string; width: number; height: number; durationMs: number }): Promise<{ status: string }>;
+  failItem(input: { ownerUserId: string; batchId: string; ordinal: number; code: string }): Promise<void>;
+};
+
+export type VideoObjectStorage = {
+  stat(input: { bucket: string; path: string }): Promise<{ exists: boolean; contentType?: string; byteSize?: number; checksumSha256?: string }>;
+  readRange(input: { bucket: string; path: string; start: number; end: number }): Promise<Response>;
+  remove(input: { bucket: string; path: string }): Promise<void>;
+};
+
+export type VideoUploadHandlerDeps = {
+  getUserId(req: Request): Promise<string | null>;
+  enabled: boolean; configured: boolean; bucket?: string; expiresInMs?: number; now?: () => Date;
+  store: VideoUploadStore;
+  createSignedUpload(input: { bucket: string; path: string; contentType: string; upsert: false }): Promise<{ token: string; signedUrl: string }>;
+  pathFactory?: (ownerUserId: string, batchId: string, ordinal: number, contentType: string) => string;
+  storage?: VideoObjectStorage;
+  registerProvenance?: (input: Omit<MediaProvenance, "bucket_id"> & { bucket_id: string }) => Promise<boolean>;
+  recordCleanup?: (input: { owner_user_id: string; bucket_id: string; object_path: string; reason: string }) => Promise<void>;
+};
+
+type Descriptor = { ordinal: number; idempotencyKey: string; filename: string; contentType: string; byteSize: number; checksumSha256: string; width: number; height: number; durationMs: number };
+const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
+const SAFE_NAME = /^[^/\\\0-\x1f]{1,255}$/;
+
+function requestId(req: Request) { return (req.headers.get("x-request-id") ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 128); }
+function error(code: string, requestId: string, status: number) { return Response.json({ code, requestId }, { status }); }
+function ownerPath(owner: string, path: string) {
+  return Boolean(path) && !path.startsWith("/") && !path.includes("\\") && !path.includes("..") && !path.includes("//") && path.split("/")[0] === owner;
+}
+function extension(type: string) { return type === "video/mp4" ? "mp4" : type === "video/x-m4v" ? "m4v" : "mov"; }
+function defaultPath(owner: string, batch: string, ordinal: number, type: string) { return `${owner}/videos/${batch}/${ordinal}-${crypto.randomUUID()}.${extension(type)}`; }
+
+function descriptorFrom(value: unknown): Descriptor | null {
+  if (!value || typeof value !== "object") return null;
+  const item = value as Record<string, unknown>;
+  const number = (key: string) => typeof item[key] === "number" && Number.isSafeInteger(item[key]) ? item[key] as number : null;
+  const ordinal = number("ordinal"); const byteSize = number("byteSize"); const width = number("width"); const height = number("height"); const durationMs = number("durationMs");
+  if (ordinal === null || byteSize === null || width === null || height === null || durationMs === null
+    || typeof item.idempotencyKey !== "string" || !SAFE_ID.test(item.idempotencyKey)
+    || typeof item.filename !== "string" || !SAFE_NAME.test(item.filename)
+    || typeof item.contentType !== "string" || !ALLOWED_VIDEO_TYPES.has(item.contentType)
+    || typeof item.checksumSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(item.checksumSha256)
+    || byteSize < 1 || byteSize > MAX_VIDEO_UPLOAD_BYTES || width < 1 || height < 1 || durationMs < 1) return null;
+  return { ordinal, idempotencyKey: item.idempotencyKey, filename: item.filename, contentType: item.contentType, byteSize, checksumSha256: item.checksumSha256.toLowerCase(), width, height, durationMs };
+}
+
+async function json(req: Request): Promise<Record<string, unknown> | null> {
+  try { const value = await req.json(); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { return null; }
+}
+
+export async function handleVideoUploadPrepare(req: Request, deps: VideoUploadHandlerDeps): Promise<Response> {
+  const id = requestId(req);
+  const owner = await deps.getUserId(req).catch(() => null);
+  if (!owner) return error("unauthorized", id, 401);
+  if (!deps.enabled) return error("video_upload_disabled", id, 404);
+  if (!deps.configured) return error("config_error", id, 503);
+  const body = await json(req);
+  if (!body || typeof body.idempotencyKey !== "string" || !SAFE_ID.test(body.idempotencyKey) || !Array.isArray(body.files)) return error("invalid_video_upload", id, 400);
+  if (body.files.length === 0) return error("invalid_video_upload", id, 400);
+  if (body.files.length > MAX_VIDEO_UPLOAD_ITEMS) return error("batch_limit_exceeded", id, 413);
+  const files = body.files.map(descriptorFrom);
+  if (files.some((file): file is null => !file)) return error("invalid_video_upload", id, 400);
+  const descriptors = files as Descriptor[];
+  if (new Set(descriptors.map(file => file.ordinal)).size !== descriptors.length || new Set(descriptors.map(file => file.idempotencyKey)).size !== descriptors.length || descriptors.some(file => file.ordinal < 0 || file.ordinal >= MAX_VIDEO_UPLOAD_ITEMS)) return error("invalid_video_upload", id, 400);
+  const bucket = deps.bucket ?? VIDEO_UPLOAD_BUCKET;
+  const now = deps.now?.() ?? new Date();
+  let batch: { batchId: string };
+  try { batch = await deps.store.prepareBatch({ ownerUserId: owner, idempotencyKey: body.idempotencyKey, expiresAt: new Date(now.getTime() + (deps.expiresInMs ?? 15 * 60_000)).toISOString() }); }
+  catch { return error("video_upload_unavailable", id, 503); }
+  const uploads: Array<{ ordinal: number; path: string; token: string; signedUrl: string; contentType: string; upsert: false }> = [];
+  for (const file of descriptors) {
+    // A batch replay must use the original random path. The exact item lookup is
+    // owner-filtered by the store; its immutable-facts RPC below decides conflicts.
+    let existing: PreparedItem | null;
+    try { existing = await deps.store.findItem(owner, batch.batchId, file.ordinal); }
+    catch { return error("video_upload_unavailable", id, 503); }
+    const path = existing?.privatePath ?? (deps.pathFactory ?? defaultPath)(owner, batch.batchId, file.ordinal, file.contentType);
+    if (!ownerPath(owner, path)) return error("video_upload_unavailable", id, 503);
+    try {
+      await deps.store.prepareItem({ ownerUserId: owner, batchId: batch.batchId, ordinal: file.ordinal, idempotencyKey: file.idempotencyKey, privatePath: path, contentType: file.contentType, byteSize: file.byteSize, checksumSha256: file.checksumSha256, width: file.width, height: file.height, durationMs: file.durationMs });
+      const signed = await deps.createSignedUpload({ bucket, path, contentType: file.contentType, upsert: false });
+      if (!signed.token || !signed.signedUrl) throw new Error("capability unavailable");
+      uploads.push({ ordinal: file.ordinal, path, token: signed.token, signedUrl: signed.signedUrl, contentType: file.contentType, upsert: false });
+    } catch { return error("video_upload_capability_unavailable", id, 502); }
+  }
+  return Response.json({ ok: true, batchId: batch.batchId, uploads, requestId: id });
+}
+
+async function readBounded(response: Response, maximum = 64 * 1024): Promise<Uint8Array | null> {
+  const reader = response.body?.getReader(); if (!reader) return null;
+  const chunks: Uint8Array[] = []; let length = 0;
+  try { while (true) { const { done, value } = await reader.read(); if (done) break; if (!value) continue; length += value.byteLength; if (length > maximum) { await reader.cancel(); return null; } chunks.push(value); } }
+  finally { reader.releaseLock(); }
+  const result = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; } return result;
+}
+function hasFtyp(bytes: Uint8Array | null) { return Boolean(bytes && bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70); }
+function safeResult(item: PreparedItem, id: string) { return { ok: true, batchId: item.batchId, ordinal: item.ordinal, proxyUrl: `/api/storage-media?path=${encodeURIComponent(item.privatePath)}`, requestId: id }; }
+
+export async function handleVideoUploadFinalize(req: Request, deps: VideoUploadHandlerDeps): Promise<Response> {
+  const id = requestId(req);
+  const owner = await deps.getUserId(req).catch(() => null);
+  if (!owner) return error("unauthorized", id, 401);
+  if (!deps.enabled) return error("video_upload_disabled", id, 404);
+  if (!deps.configured || !deps.storage || !deps.registerProvenance) return error("config_error", id, 503);
+  const body = await json(req);
+  if (!body || typeof body.batchId !== "string" || !SAFE_ID.test(body.batchId) || typeof body.ordinal !== "number" || !Number.isInteger(body.ordinal) || body.ordinal < 0 || body.ordinal >= MAX_VIDEO_UPLOAD_ITEMS) return error("invalid_video_upload", id, 400);
+  let item: PreparedItem | null;
+  try { item = await deps.store.findItem(owner, body.batchId, body.ordinal); } catch { return error("video_upload_unavailable", id, 503); }
+  if (!item || !ownerPath(owner, item.privatePath)) return error("video_upload_not_found", id, 404);
+  if (item.status === "finalized") return Response.json(safeResult(item, id));
+  const cleanup = async (code: string) => {
+    try { await deps.store.failItem({ ownerUserId: owner, batchId: item!.batchId, ordinal: item!.ordinal, code }); } catch { /* failure state is best effort; cleanup remains mandatory */ }
+    try { await deps.storage!.remove({ bucket: deps.bucket ?? VIDEO_UPLOAD_BUCKET, path: item!.privatePath }); }
+    catch { try { await deps.recordCleanup?.({ owner_user_id: owner, bucket_id: deps.bucket ?? VIDEO_UPLOAD_BUCKET, object_path: item!.privatePath, reason: code }); } catch { /* safe failure response below */ } }
+    return error(code, id, code === "missing_video_object" ? 404 : code === "video_upload_unavailable" ? 503 : 422);
+  };
+  if (Date.parse(item.expiresAt) <= (deps.now?.() ?? new Date()).getTime()) return cleanup("video_upload_expired");
+  let stat: Awaited<ReturnType<VideoObjectStorage["stat"]>>;
+  try { stat = await deps.storage.stat({ bucket: deps.bucket ?? VIDEO_UPLOAD_BUCKET, path: item.privatePath }); } catch { return cleanup("video_upload_unavailable"); }
+  if (!stat.exists) return cleanup("missing_video_object");
+  if (!stat.byteSize || stat.byteSize > MAX_VIDEO_UPLOAD_BYTES) return cleanup("invalid_video_size");
+  if (stat.contentType !== item.declaredContentType || !ALLOWED_VIDEO_TYPES.has(stat.contentType)) return cleanup("video_content_type_mismatch");
+  if (stat.byteSize !== item.declaredByteSize || (stat.checksumSha256 && stat.checksumSha256.toLowerCase() !== item.declaredChecksumSha256)) return cleanup("video_facts_mismatch");
+  let header: Uint8Array | null;
+  try { header = await readBounded(await deps.storage.readRange({ bucket: deps.bucket ?? VIDEO_UPLOAD_BUCKET, path: item.privatePath, start: 0, end: Math.min(63, stat.byteSize - 1) })); } catch { return cleanup("video_upload_unavailable"); }
+  if (!hasFtyp(header)) return cleanup("invalid_video_container");
+  try {
+    const checksum = stat.checksumSha256?.toLowerCase() ?? item.declaredChecksumSha256;
+    await deps.store.finalizeItem({ ownerUserId: owner, batchId: item.batchId, ordinal: item.ordinal, contentType: stat.contentType, byteSize: stat.byteSize, checksumSha256: checksum, width: item.declaredWidth, height: item.declaredHeight, durationMs: item.declaredDurationMs });
+    const registered = await deps.registerProvenance({ owner_user_id: owner, bucket_id: deps.bucket ?? VIDEO_UPLOAD_BUCKET, object_path: item.privatePath, source_type: "upload", intent_id: null, lifecycle_state: "draft", media_kind: "video", content_type: stat.contentType, byte_size: stat.byteSize, checksum_sha256: checksum, width: item.declaredWidth, height: item.declaredHeight, duration_ms: item.declaredDurationMs });
+    if (!registered) return cleanup("provenance_unavailable");
+  } catch { return cleanup("video_upload_unavailable"); }
+  return Response.json(safeResult(item, id));
+}
diff --git a/web/src/lib/server/media/videoUploadStore.ts b/web/src/lib/server/media/videoUploadStore.ts
new file mode 100644
index 00000000..b4fc814d
--- /dev/null
+++ b/web/src/lib/server/media/videoUploadStore.ts
@@ -0,0 +1,55 @@
+import type { VideoUploadStore } from "./videoUploadHandler";
+
+type Db = {
+  rpc(name: string, args: Record<string, unknown>): any;
+  from(table: string): any;
+};
+
+function rpcData(value: unknown): Record<string, unknown> | null {
+  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
+}
+function must<T>(result: { data: unknown; error: unknown }, map: (data: Record<string, unknown>) => T): T {
+  const value = rpcData(result.data); if (result.error || !value) throw new Error("video_upload_store_error"); return map(value);
+}
+
+/** Service-only v77 boundary. Every direct query includes the verified owner. */
+export function createVideoUploadStore(db: Db): VideoUploadStore {
+  return {
+    async prepareBatch(input) {
+      const result = await db.rpc("video_upload_batch_prepare", { p_owner_user_id: input.ownerUserId, p_idempotency_key: input.idempotencyKey, p_expires_at: input.expiresAt });
+      return must(result, data => ({ batchId: String(data.batchId ?? "") }));
+    },
+    async prepareItem(input) {
+      const result = await db.rpc("video_upload_item_prepare", {
+        p_owner_user_id: input.ownerUserId, p_batch_id: input.batchId, p_ordinal: input.ordinal, p_idempotency_key: input.idempotencyKey,
+        p_private_path: input.privatePath, p_declared_content_type: input.contentType, p_declared_byte_size: input.byteSize,
+        p_declared_checksum_sha256: input.checksumSha256, p_declared_width: input.width, p_declared_height: input.height, p_declared_duration_ms: input.durationMs,
+      });
+      return must(result, data => ({ status: String(data.status ?? "") }));
+    },
+    async findItem(ownerUserId, batchId, ordinal) {
+      const { data, error } = await db.from("video_upload_items")
+        .select("batch_id,ordinal,status,private_path,declared_content_type,declared_byte_size,declared_checksum_sha256,declared_width,declared_height,declared_duration_ms,expires_at")
+        .eq("owner_user_id", ownerUserId).eq("batch_id", batchId).eq("ordinal", ordinal).maybeSingle();
+      if (error || !data) return null;
+      return {
+        batchId: data.batch_id, ordinal: data.ordinal, status: data.status, privatePath: data.private_path,
+        declaredContentType: data.declared_content_type, declaredByteSize: Number(data.declared_byte_size), declaredChecksumSha256: data.declared_checksum_sha256,
+        declaredWidth: Number(data.declared_width), declaredHeight: Number(data.declared_height), declaredDurationMs: Number(data.declared_duration_ms), expiresAt: data.expires_at,
+      };
+    },
+    async finalizeItem(input) {
+      const result = await db.rpc("video_upload_item_finalize", {
+        p_owner_user_id: input.ownerUserId, p_batch_id: input.batchId, p_ordinal: input.ordinal, p_verified_content_type: input.contentType,
+        p_verified_byte_size: input.byteSize, p_verified_checksum_sha256: input.checksumSha256, p_verified_width: input.width,
+        p_verified_height: input.height, p_verified_duration_ms: input.durationMs,
+      });
+      return must(result, data => ({ status: String(data.status ?? "") }));
+    },
+    async failItem(input) {
+      const { error } = await db.from("video_upload_items").update({ status: "failed", error_code: input.code, updated_at: new Date().toISOString() })
+        .eq("owner_user_id", input.ownerUserId).eq("batch_id", input.batchId).eq("ordinal", input.ordinal);
+      if (error) throw new Error("video_upload_store_error");
+    },
+  };
+}
diff --git a/web/src/lib/server/mediaProvenance.ts b/web/src/lib/server/mediaProvenance.ts
index 44b3f856..8f24418c 100644
--- a/web/src/lib/server/mediaProvenance.ts
+++ b/web/src/lib/server/mediaProvenance.ts
@@ -1,46 +1,54 @@
 import { createServerClient } from "@/lib/supabase";
 
 export type MediaProvenance = {
   owner_user_id: string;
   bucket_id?: string;
   object_path: string;
   source_type: string;
   intent_id: string | null;
   lifecycle_state: string;
+  /** v77 fields are optional so existing image rows retain their serialization. */
+  media_kind?: "image" | "video" | string;
+  content_type?: string | null;
+  byte_size?: number | null;
+  checksum_sha256?: string | null;
+  width?: number | null;
+  height?: number | null;
+  duration_ms?: number | null;
 };
 
 export type MediaProvenanceStore = {
   findExact(ownerUserId: string, bucketId: string, objectPath: string): Promise<MediaProvenance | null>;
   findExactMany(ownerUserId: string, bucketId: string, objectPaths: string[]): Promise<MediaProvenance[]>;
   register(input: Omit<MediaProvenance, "lifecycle_state" | "bucket_id"> & { bucket_id: string; lifecycle_state?: string }): Promise<boolean>;
   recordCleanup(input: { owner_user_id: string; bucket_id: string; object_path: string; reason: string }): Promise<void>;
 };
 
 export function createMediaProvenanceStore(db = createServerClient()): MediaProvenanceStore {
   return {
     async findExact(ownerUserId, bucketId, objectPath) {
       const { data, error } = await db
         .from("media_asset_provenance")
-        .select("owner_user_id,bucket_id,object_path,source_type,intent_id,lifecycle_state")
+        .select("owner_user_id,bucket_id,object_path,source_type,intent_id,lifecycle_state,media_kind,content_type,byte_size,checksum_sha256,width,height,duration_ms")
         .eq("owner_user_id", ownerUserId)
         .eq("bucket_id", bucketId)
         .eq("object_path", objectPath)
         .maybeSingle();
       if (error || !data) return null;
       return data as MediaProvenance;
     },
     async findExactMany(ownerUserId, bucketId, objectPaths) {
       if (!objectPaths.length) return [];
       const { data, error } = await db
         .from("media_asset_provenance")
-        .select("owner_user_id,bucket_id,object_path,source_type,intent_id,lifecycle_state")
+        .select("owner_user_id,bucket_id,object_path,source_type,intent_id,lifecycle_state,media_kind,content_type,byte_size,checksum_sha256,width,height,duration_ms")
         .eq("owner_user_id", ownerUserId)
         .eq("bucket_id", bucketId)
         .in("object_path", [...new Set(objectPaths)]);
       return error ? [] : (data ?? []) as MediaProvenance[];
     },
     async register(input) {
       const { error } = await db.from("media_asset_provenance").upsert({
         ...input,
         lifecycle_state: input.lifecycle_state ?? "draft",
         updated_at: new Date().toISOString(),
diff --git a/web/src/lib/studio/videoDirectUpload.ts b/web/src/lib/studio/videoDirectUpload.ts
new file mode 100644
index 00000000..aceb3fa4
--- /dev/null
+++ b/web/src/lib/studio/videoDirectUpload.ts
@@ -0,0 +1,36 @@
+"use client";
+
+import { createBrowserClient } from "@supabase/ssr";
+
+export type VideoUploadDescriptor = { ordinal: number; idempotencyKey: string; filename: string; contentType: "video/mp4" | "video/x-m4v" | "video/quicktime"; byteSize: number; checksumSha256: string; width: number; height: number; durationMs: number };
+export type SignedVideoUpload = { ordinal: number; path: string; token: string; signedUrl: string; contentType: string; upsert: false };
+type PrepareResponse = { batchId: string; uploads: SignedVideoUpload[]; requestId: string };
+
+let client: ReturnType<typeof createBrowserClient> | null = null;
+function browser() { return client ??= createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!); }
+async function authHeaders(): Promise<Record<string, string>> { const { data: { session } } = await browser().auth.getSession(); return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}; }
+function requestId() { return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
+
+export async function sha256(file: Blob): Promise<string> {
+  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
+  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
+}
+async function api<T>(url: string, body: unknown, id: string): Promise<T> {
+  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-request-id": id, ...(await authHeaders()) }, body: JSON.stringify(body) });
+  const payload = await response.json().catch(() => ({})) as T & { code?: string };
+  if (!response.ok) throw Object.assign(new Error(payload.code ?? "video_upload_failed"), { code: payload.code, requestId: id });
+  return payload;
+}
+
+/** Browser-to-private-Storage transfer; no video bytes enter a Next multipart route. */
+export async function prepareVideoDirectUpload(idempotencyKey: string, files: VideoUploadDescriptor[]): Promise<PrepareResponse> {
+  if (process.env.NEXT_PUBLIC_VIDEO_PIN_UPLOAD !== "true") throw Object.assign(new Error("video_upload_disabled"), { code: "video_upload_disabled" });
+  return api<PrepareResponse>("/api/studio/video-upload/prepare", { idempotencyKey, files }, requestId());
+}
+export async function uploadVideoToSignedStorage(upload: SignedVideoUpload, file: File): Promise<void> {
+  const { error } = await browser().storage.from("generated-private").uploadToSignedUrl(upload.path, upload.token, file, { contentType: upload.contentType, upsert: false });
+  if (error) throw Object.assign(new Error("video_upload_failed"), { code: "video_upload_failed" });
+}
+export async function finalizeVideoDirectUpload(batchId: string, ordinal: number) {
+  return api<{ ok: true; batchId: string; ordinal: number; proxyUrl: string; requestId: string }>("/api/studio/video-upload/finalize", { batchId, ordinal }, requestId());
+}
