# Review package: 5f5fe502968f96effb7fc9be9b9fd372d6520512..ac860375a952d29fcfbd4b8fbba0861360757125

## Commits
ac860375 fix(video): close private upload review gaps
1c9f4615 docs(video): record atomic finalization evidence
d47f6bcd fix(video): make upload finalization atomic

## Files changed
 .../task-2-implementer-report.md                   |  81 +++--
 backend/db/migrate_v77_video_media.sql             | 314 ++++++++++++++----
 backend/db/rollback_v77_video_media.sql            |   4 +-
 .../tests/pglite_v37/verify-v77-video-media.mjs    | 185 +++++++++--
 web/scripts/test-video-upload-private.ts           | 365 ++++++++++++++++++---
 web/src/app/api/storage-media/route.ts             |   4 +-
 .../app/api/studio/video-upload/finalize/route.ts  |   1 -
 .../app/api/studio/video-upload/prepare/route.ts   |   4 -
 web/src/lib/server/media/storageMediaHandler.ts    |  30 +-
 web/src/lib/server/media/supabaseVideoStorage.ts   |   8 +-
 web/src/lib/server/media/videoUploadHandler.ts     | 129 ++++++--
 web/src/lib/server/media/videoUploadStore.ts       |  41 ++-
 web/src/lib/server/mediaProvenance.ts              |   9 +-
 web/src/lib/studio/incrementalSha256.ts            |  85 +++++
 web/src/lib/studio/videoDirectUpload.ts            |   4 +-
 web/src/lib/videoUploadLimits.ts                   |   7 +
 16 files changed, 1060 insertions(+), 211 deletions(-)

## Diff
diff --git a/.superpowers/sdd/2026-09-16-video-pin-p0/task-2-implementer-report.md b/.superpowers/sdd/2026-09-16-video-pin-p0/task-2-implementer-report.md
index cdbf5818..6f6f7f0d 100644
--- a/.superpowers/sdd/2026-09-16-video-pin-p0/task-2-implementer-report.md
+++ b/.superpowers/sdd/2026-09-16-video-pin-p0/task-2-implementer-report.md
@@ -1,38 +1,63 @@
-# Task 2 Implementer Report — Private Direct Video Upload And Finalization
+# Task 2 Implementer Report — Atomic Finalization And Review Remediation

 ## Scope And Base

-- Base: `d7635c02` (`04b0ebe0b7b292d6fa2432f6a064740b30314447` integration lineage).
+- Review baseline: `5f5fe502968f96effb7fc9be9b9fd372d6520512`.
+- Atomic-state/fact-contract implementation commit: `d47f6bcddd9164b680fbdffae286adec387fda04`.
+- Round-1 continuation base: `1c9f4615aa30e9b70b270b1d72b53b52e0e07a35`.
 - Branch/worktree: `codex/video-pin-p0-0916-final` / `D:/vp-tmp/wt-video-pin-p0-0916-final`.
-- Head: recorded after the Task 2-only commit below.
-- Scope was limited to Task 2 server handlers, route wiring, private-provenance extension, direct browser helper, focused test registry entry, this brief, and Task 2 ledger/report evidence. No Studio UI, AI Copy, scheduler, draft orchestration, or Pinterest publish code changed.
-
-## Implementation
-
-- `POST /api/studio/video-upload/prepare` authenticates before JSON parsing or provider/database side effects, validates a 1–20 descriptor batch, persists via owner-filtered v77 RPCs, and creates short-lived direct-upload capabilities with `upsert:false`.
-- `POST /api/studio/video-upload/finalize` reads the exact server-owned item, validates object existence/type/size/checksum metadata and bounded ISO-BMFF `ftyp`, invokes v77 finalization, and registers owner-exact video provenance. Failure removes only the exact object and records the v75 cleanup outbox if deletion fails.
-- `GET /api/storage-media` requires bearer authentication and exact ready/allowed video provenance, accepts only one bounded range, returns fixed safe headers, proxies only that range, and neither forwards provider headers nor exposes provider URLs.
-- The browser helper sends bytes from `uploadToSignedUrl` directly to private Storage; it does not route a video multipart body through Next.
+- This continuation closes the remaining review findings I3, I4, I5, I6, and I7, plus the stable-error and 100 MiB browser-digest minors. It preserves the earlier C1/I1/I2 atomic state/fact work.
+
+## Implemented Contract
+
+- v77 now owns `finalize_claim_token` and `finalize_claim_expires_at`, plus service-only claim/finalize/fail RPCs with catalog hashes and explicit active/rollback privilege manifests.
+- Claim is owner/batch/ordinal scoped. One active claimant may inspect Storage; an expired lease can be taken over, and the stale claimant can no longer finalize, mark failure, or receive object-cleanup authority.
+- Failure and object deletion are coupled: the handler deletes only after the atomic fail RPC returns `cleanupAllowed=true` for the same live claim. A concurrent winner or lost claim therefore cannot have its object removed by a loser.
+- Final facts and ready video provenance are written in the same database transaction. A provenance collision rolls back the item lifecycle/facts; successful replay requires complete matching provenance and performs no Storage read.
+- Finalized upload rows require Storage-verified MIME/byte size, allow verified checksum to remain `NULL`, and require verified width/height/duration to remain `NULL`. Browser checksum/dimensions/duration stay in declared columns.
+- Video provenance records explicit trust labels: `storage_head_verified` for MIME/bytes, `storage_digest_verified` or `unavailable` for checksum, and `browser_declared` for dimensions/duration.
+- The production Supabase adapter ignores uploader-controlled `x-amz-meta-sha256`. It exposes no verified checksum until a genuinely trusted digest source exists.
+- Shared TypeScript limits enforce duration from 4,000 through 300,000 ms; v77 independently enforces the same database boundary.
+- Batch lifecycle supports partial outcomes: a failed item does not block an independently claimed sibling from finalizing; the batch settles to failed only after no prepared/finalizing items remain.
+- `/api/storage-media` now uses the existing verified bearer-or-cookie identity helper. Every private response, including errors and 416, varies on `Cookie, Authorization, Range`.
+- Playback validates the Storage response status, normalized MIME, exact `Content-Range` start/end/total, declared byte total, and body length. A no-Range client request may accept a full 200 only with no `Content-Range` and an exact `Content-Length`; short or oversized streams error closed.
+- Finalize requires a real 206 initial range whose status, MIME, `Content-Range`, total, and actual bytes match the request. ISO-BMFF validation now parses a complete `ftyp` box, including a present minor-version field and an allowed major/compatible brand; offset-four magic alone is rejected.
+- Supabase's fixed two-hour upload capability is reflected in the shared server ledger TTL. Before every capability issue/reissue, `video_upload_item_prepare` atomically extends `capability_expires_at` and upserts a delayed, deduplicated `media_cleanup_outbox` responsibility. Failure preserves that pending responsibility in the same transaction before granting cleanup authority; finalize atomically settles it `done`. Immediate deletion is best-effort and cannot erase delayed recheck responsibility.
+- Stable database conflict/expiry/state errors map to stable HTTP codes instead of collapsing to a provider 502.
+- Browser SHA-256 now consumes `Blob.stream()` with an incremental constant-memory implementation; it no longer allocates an entire 100 MiB `ArrayBuffer`.
+- Focused tests import the production route, store, Supabase Storage adapter, and browser upload client, and assert verified auth wiring, owner propagation, token/path/bucket preservation, and `upsert: false`. PGlite owns lifecycle, rollback, and privilege coverage.

 ## TDD Evidence

-- RED 1: missing pure handlers produced `ERR_MODULE_NOT_FOUND` before implementation.
-- RED 2: an injected upstream response longer than the requested range was exposed by the proxy; the new bounded range stream makes the focused test reject it.
-- RED 3: an unrecognised provenance lifecycle was served; the proxy now admits only explicit allowed lifecycle states.
-- RED 4: a matching prepare replay generated a new path; prepare now reuses the owner-filtered stored item path, preserving v77 immutable-fact conflict detection.
-- GREEN: `npx tsx scripts/test-video-upload-private.ts` reports 11/11 focused behaviours after the final replay/lifecycle fixes; the final verification section records the repeated run.
-
-## Required Behaviour Coverage
-
-- Authentication before parsing/DB/Storage, feature/config denial, 1/20/21 count and duplicate ordinal/key rejection, MIME/size/name/path validation, owner isolation, prepare conflict/replay, token/error redaction, and `upsert:false`.
-- Missing/empty/oversized/type-or-size-mismatched/expired/cross-owner finalization, valid and invalid `ftyp`, exact provenance, successful-finalize replay without another read, object removal, and cleanup-outbox compensation.
-- Storage-media auth/exact provenance/cross-owner/lifecycle/MIME/size gates; 200, 206, open/suffix and multi/unsatisfiable range handling; safe headers; provider failure redaction; and stream bounding.
+- RED: v77 verifier failed because `video_upload_item_claim` did not exist (53 assertions reached).
+- RED: finalized rows without provenance were still accepted (71 assertions reached).
+- RED: an item failure immediately blocked a sibling claim with `video_upload_batch_not_finalizable` (73 assertions reached).
+- RED: handler claim-before-Storage test returned 503 instead of 200.
+- RED: production Storage adapter exposed uploader-controlled SHA metadata (`true !== false`).
+- RED: prepare ledger expired at 15 minutes instead of the provider capability's two hours.
+- RED: v77 had no `capability_expires_at` column or durable capability cleanup row.
+- RED: a stable item-idempotency conflict returned 502 instead of 409.
+- RED: bearer-only production route wiring, incorrect `Vary`, malformed/truncated/fake-brand `ftyp`, upstream 500/wrong range, playback MIME/range/total lies, and short streams were accepted by the prior focused contract.
+- RED: browser SHA-256 invoked the test Blob's forbidden whole-file `arrayBuffer()`.
+- GREEN: `verify-v77-video-media.mjs` reports `verdict: pass`, 115 assertions, no failures.
+- GREEN: `test-video-upload-private.ts` reports 27 passed, 0 failed after the final production/client/cleanup tests.
+
+## Verification
+
+- v77 PGlite: 115/115, pass; additionally covers durable capability cleanup creation, delayed scheduling, atomic successful settlement, failure preservation, and cleanup evidence across rollback/reapply.
+- v76 PGlite: 280/280 across two rounds, pass.
+- v75 PGlite: 65 assertions with no failures; expected pre-existing `deployment_blocked` result remains for the legacy broad Storage policy.
+- Media privacy architecture: 16/16, pass.
+- Pinterest video adapter: 16/16, pass.
+- Focused private video upload: 27/27, pass after final production changes.
+- Test registry: 239 tracked, 231 run by `npm test`, 8 documented exclusions.
+- `npm run typecheck`: exit 0.
+- `git diff --check`: exit 0 before the implementation commit; the follow-up report-only diff is also clean.
+
+## Remaining Review Items
+
+- None from the supplied C1/I1-I7 and Minor review list. The known v75 deployment blocker remains external to Task 2: a pre-existing broad permissive `storage.objects` policy must be audited before deployment.

 ## External-Call Attestation

-All tests use injected local adapters and mocked `Response` objects. No real Supabase database, Storage, Pinterest, token refresh, migration, deployment, push, merge, or Production action was performed.
-
-## Risks / Follow-up Boundaries
-
-- Storage deployments which do not expose an authoritative SHA-256 metadata header retain the declared checksum as a labelled declared fact; the handler does not buffer a full video solely to hash it. A future storage checksum-verification contract can tighten this without changing the upload API.
-- Task 3 owns UI orchestration, per-item retry/cancellation, and direct helper invocation; those paths deliberately remain untouched here.
+All verification used local PGlite, injected adapters, and mocked `Response` objects. No real Supabase database, Storage, Pinterest, provider token, migration application, deployment, push, merge, or Production mutation occurred. Review package files and `node_modules` were not committed.
diff --git a/backend/db/migrate_v77_video_media.sql b/backend/db/migrate_v77_video_media.sql
index 4032f445..136f5320 100644
--- a/backend/db/migrate_v77_video_media.sql
+++ b/backend/db/migrate_v77_video_media.sql
@@ -47,74 +47,84 @@ begin
       ('video_upload_batches','created_at','timestamp with time zone',true,'now()'),('video_upload_batches','updated_at','timestamp with time zone',true,'now()'),
       ('video_upload_items','id','uuid',true,'gen_random_uuid()'),('video_upload_items','batch_id','uuid',true,null),
       ('video_upload_items','owner_user_id','uuid',true,null),('video_upload_items','ordinal','integer',true,null),
       ('video_upload_items','idempotency_key','text',true,null),('video_upload_items','private_path','text',true,null),
       ('video_upload_items','declared_content_type','text',true,null),('video_upload_items','declared_byte_size','bigint',true,null),
       ('video_upload_items','declared_checksum_sha256','text',false,null),('video_upload_items','declared_width','integer',false,null),
       ('video_upload_items','declared_height','integer',false,null),('video_upload_items','declared_duration_ms','bigint',false,null),
       ('video_upload_items','verified_content_type','text',false,null),('video_upload_items','verified_byte_size','bigint',false,null),
       ('video_upload_items','verified_checksum_sha256','text',false,null),('video_upload_items','verified_width','integer',false,null),
       ('video_upload_items','verified_height','integer',false,null),('video_upload_items','verified_duration_ms','bigint',false,null),
+      ('video_upload_items','finalize_claim_token','uuid',false,null),('video_upload_items','finalize_claim_expires_at','timestamp with time zone',false,null),
+      ('video_upload_items','capability_expires_at','timestamp with time zone',true,null),
       ('video_upload_items','status','text',true,'''prepared''::text'),('video_upload_items','error_code','text',false,null),
       ('video_upload_items','prepared_at','timestamp with time zone',true,'now()'),('video_upload_items','finalized_at','timestamp with time zone',false,null),
       ('video_upload_items','expires_at','timestamp with time zone',true,null),('video_upload_items','created_at','timestamp with time zone',true,'now()'),
       ('video_upload_items','updated_at','timestamp with time zone',true,'now()')
     ) expected(table_name,column_name,type_name,not_null,default_expr) loop
       select format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid) into v_type,v_not_null,v_definition
         from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
         where a.attrelid=to_regclass('public.'||v_table) and a.attname=v_name and a.attnum>0 and not a.attisdropped;
       if not found or v_type is distinct from v_expected_type or v_not_null is distinct from v_expected_not_null
         or v_definition is distinct from v_expected_default then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
     end loop;
     if exists (select 1 from pg_attribute a join pg_class c on c.oid=a.attrelid
       where c.relnamespace='public'::regnamespace and c.relname in ('video_upload_batches','video_upload_items') and a.attnum>0 and not a.attisdropped
         and not exists (select 1 from (values
           ('video_upload_batches','id'),('video_upload_batches','owner_user_id'),('video_upload_batches','idempotency_key'),('video_upload_batches','status'),('video_upload_batches','error_code'),('video_upload_batches','prepared_at'),('video_upload_batches','finalized_at'),('video_upload_batches','expires_at'),('video_upload_batches','created_at'),('video_upload_batches','updated_at'),
-          ('video_upload_items','id'),('video_upload_items','batch_id'),('video_upload_items','owner_user_id'),('video_upload_items','ordinal'),('video_upload_items','idempotency_key'),('video_upload_items','private_path'),('video_upload_items','declared_content_type'),('video_upload_items','declared_byte_size'),('video_upload_items','declared_checksum_sha256'),('video_upload_items','declared_width'),('video_upload_items','declared_height'),('video_upload_items','declared_duration_ms'),('video_upload_items','verified_content_type'),('video_upload_items','verified_byte_size'),('video_upload_items','verified_checksum_sha256'),('video_upload_items','verified_width'),('video_upload_items','verified_height'),('video_upload_items','verified_duration_ms'),('video_upload_items','status'),('video_upload_items','error_code'),('video_upload_items','prepared_at'),('video_upload_items','finalized_at'),('video_upload_items','expires_at'),('video_upload_items','created_at'),('video_upload_items','updated_at')
+          ('video_upload_items','id'),('video_upload_items','batch_id'),('video_upload_items','owner_user_id'),('video_upload_items','ordinal'),('video_upload_items','idempotency_key'),('video_upload_items','private_path'),('video_upload_items','declared_content_type'),('video_upload_items','declared_byte_size'),('video_upload_items','declared_checksum_sha256'),('video_upload_items','declared_width'),('video_upload_items','declared_height'),('video_upload_items','declared_duration_ms'),('video_upload_items','verified_content_type'),('video_upload_items','verified_byte_size'),('video_upload_items','verified_checksum_sha256'),('video_upload_items','verified_width'),('video_upload_items','verified_height'),('video_upload_items','verified_duration_ms'),('video_upload_items','finalize_claim_token'),('video_upload_items','finalize_claim_expires_at'),('video_upload_items','capability_expires_at'),('video_upload_items','status'),('video_upload_items','error_code'),('video_upload_items','prepared_at'),('video_upload_items','finalized_at'),('video_upload_items','expires_at'),('video_upload_items','created_at'),('video_upload_items','updated_at')
         ) expected(table_name,column_name) where expected.table_name=c.relname and expected.column_name=a.attname)) then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
   end if;
   -- Provenance is additive: v77 owns these columns and its discriminator check,
   -- while v75 continues to own the rest of its legacy relation.
   for v_name,v_expected_type,v_expected_not_null,v_expected_default in select * from (values
     ('media_kind','text',true,'''image''::text'),('content_type','text',false,null),('byte_size','bigint',false,null),
-    ('checksum_sha256','text',false,null),('width','integer',false,null),('height','integer',false,null),('duration_ms','bigint',false,null)
+    ('checksum_sha256','text',false,null),('width','integer',false,null),('height','integer',false,null),('duration_ms','bigint',false,null),
+    ('content_type_source','text',false,null),('byte_size_source','text',false,null),('checksum_source','text',false,null),
+    ('dimensions_source','text',false,null),('duration_source','text',false,null)
   ) expected(column_name,type_name,not_null,default_expr) loop
     select format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid) into v_type,v_not_null,v_definition
       from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
       where a.attrelid='public.media_asset_provenance'::regclass and a.attname=v_name and not a.attisdropped;
     if (not found and v_installed) or (found and (v_type is distinct from v_expected_type or v_not_null is distinct from v_expected_not_null or v_definition is distinct from v_expected_default)) then
       raise exception using errcode='P0001',message='v77_schema_collision';
     end if;
   end loop;
-  if not v_installed and exists (select 1 from pg_attribute a where a.attrelid='public.media_asset_provenance'::regclass and a.attname in ('media_kind','content_type','byte_size','checksum_sha256','width','height','duration_ms') and not a.attisdropped) then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
+  if not v_installed and exists (select 1 from pg_attribute a where a.attrelid='public.media_asset_provenance'::regclass and a.attname in ('media_kind','content_type','byte_size','checksum_sha256','width','height','duration_ms','content_type_source','byte_size_source','checksum_source','dimensions_source','duration_source') and not a.attisdropped) then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
   if v_installed then
     for v_table,v_name,v_expected_definition in select * from (values
       ('video_upload_batches','video_upload_batches_pkey','PRIMARY KEY (id)'),
       ('video_upload_batches','video_upload_batches_owner_user_id_idempotency_key_key','UNIQUE (owner_user_id, idempotency_key)'),
       ('video_upload_batches','video_upload_batches_status_check','CHECK ((status = ANY (ARRAY[''prepared''::text, ''uploading''::text, ''finalizing''::text, ''finalized''::text, ''failed''::text, ''expired''::text, ''canceled''::text])))'),
       ('video_upload_items','video_upload_items_pkey','PRIMARY KEY (id)'),('video_upload_items','video_upload_items_batch_id_fkey','FOREIGN KEY (batch_id) REFERENCES video_upload_batches(id) ON DELETE RESTRICT'),
       ('video_upload_items','video_upload_items_batch_id_ordinal_key','UNIQUE (batch_id, ordinal)'),('video_upload_items','video_upload_items_batch_id_idempotency_key_key','UNIQUE (batch_id, idempotency_key)'),
       ('video_upload_items','video_upload_items_ordinal_check','CHECK (((ordinal >= 0) AND (ordinal <= 19)))'),
       ('video_upload_items','video_upload_items_declared_content_type_check','CHECK ((declared_content_type = ANY (ARRAY[''video/mp4''::text, ''video/x-m4v''::text, ''video/quicktime''::text])))'),
-      ('video_upload_items','video_upload_items_declared_byte_size_check','CHECK (((declared_byte_size >= 0) AND (declared_byte_size <= 104857600)))'),
+      ('video_upload_items','video_upload_items_declared_byte_size_check','CHECK (((declared_byte_size >= 1) AND (declared_byte_size <= 104857600)))'),
+      ('video_upload_items','video_upload_items_declared_checksum_check','CHECK (((declared_checksum_sha256 IS NULL) OR (declared_checksum_sha256 ~ ''^[0-9a-f]{64}$''::text)))'),
+      ('video_upload_items','video_upload_items_declared_dimensions_check','CHECK (((declared_width > 0) AND (declared_height > 0)))'),
+      ('video_upload_items','video_upload_items_declared_duration_check','CHECK (((declared_duration_ms >= 4000) AND (declared_duration_ms <= 300000)))'),
       ('video_upload_items','video_upload_items_verified_content_type_check','CHECK (((verified_content_type IS NULL) OR (verified_content_type = ANY (ARRAY[''video/mp4''::text, ''video/x-m4v''::text, ''video/quicktime''::text]))))'),
       ('video_upload_items','video_upload_items_status_check','CHECK ((status = ANY (ARRAY[''prepared''::text, ''uploading''::text, ''finalizing''::text, ''finalized''::text, ''failed''::text, ''expired''::text, ''canceled''::text])))'),
-      ('video_upload_items','video_upload_items_finalized_facts_check','CHECK ((((status <> ''finalized''::text) OR ((verified_content_type = ANY (ARRAY[''video/mp4''::text, ''video/x-m4v''::text, ''video/quicktime''::text])) AND ((verified_byte_size >= 0) AND (verified_byte_size <= 104857600)) AND (NULLIF(btrim(verified_checksum_sha256), ''''::text) IS NOT NULL) AND (verified_width > 0) AND (verified_height > 0) AND (verified_duration_ms > 0))) IS TRUE))')
+      ('video_upload_items','video_upload_items_claim_shape_check','CHECK (((status = ''finalizing''::text) = ((finalize_claim_token IS NOT NULL) AND (finalize_claim_expires_at IS NOT NULL))))'),
+      ('video_upload_items','video_upload_items_finalized_facts_check','CHECK ((((status <> ''finalized''::text) OR ((verified_content_type = ANY (ARRAY[''video/mp4''::text, ''video/x-m4v''::text, ''video/quicktime''::text])) AND ((verified_byte_size >= 1) AND (verified_byte_size <= 104857600)) AND ((verified_checksum_sha256 IS NULL) OR (verified_checksum_sha256 ~ ''^[0-9a-f]{64}$''::text)) AND (verified_width IS NULL) AND (verified_height IS NULL) AND (verified_duration_ms IS NULL) AND (finalize_claim_token IS NULL) AND (finalize_claim_expires_at IS NULL))) IS TRUE))')
     ) expected(table_name,constraint_name,constraint_definition) loop
       select pg_get_constraintdef(p.oid) into v_default from pg_constraint p
         where p.conrelid=to_regclass('public.'||v_table) and p.conname=v_name;
       if not found or v_default is distinct from v_expected_definition then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
     end loop;
     if exists (select 1 from pg_constraint p where p.conrelid in ('public.video_upload_batches'::regclass,'public.video_upload_items'::regclass)
-      and p.contype in ('p','u','f','c') and p.conname not in ('video_upload_batches_pkey','video_upload_batches_owner_user_id_idempotency_key_key','video_upload_batches_status_check','video_upload_items_pkey','video_upload_items_batch_id_fkey','video_upload_items_batch_id_ordinal_key','video_upload_items_batch_id_idempotency_key_key','video_upload_items_ordinal_check','video_upload_items_declared_content_type_check','video_upload_items_declared_byte_size_check','video_upload_items_verified_content_type_check','video_upload_items_status_check','video_upload_items_finalized_facts_check')) then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
+      and p.contype in ('p','u','f','c') and p.conname not in ('video_upload_batches_pkey','video_upload_batches_owner_user_id_idempotency_key_key','video_upload_batches_status_check','video_upload_items_pkey','video_upload_items_batch_id_fkey','video_upload_items_batch_id_ordinal_key','video_upload_items_batch_id_idempotency_key_key','video_upload_items_ordinal_check','video_upload_items_declared_content_type_check','video_upload_items_declared_byte_size_check','video_upload_items_declared_checksum_check','video_upload_items_declared_dimensions_check','video_upload_items_declared_duration_check','video_upload_items_verified_content_type_check','video_upload_items_status_check','video_upload_items_claim_shape_check','video_upload_items_finalized_facts_check')) then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
     select pg_get_constraintdef(oid) into v_default from pg_constraint where conrelid='public.media_asset_provenance'::regclass and conname='media_asset_provenance_media_kind_check';
     if not found or v_default is distinct from 'CHECK ((media_kind = ANY (ARRAY[''image''::text, ''video''::text])))' then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
+    select pg_get_constraintdef(oid) into v_default from pg_constraint where conrelid='public.media_asset_provenance'::regclass and conname='media_asset_provenance_video_fact_sources_check';
+    if not found or v_default is distinct from 'CHECK (((media_kind <> ''video''::text) OR ((content_type_source = ''storage_head_verified''::text) AND (byte_size_source = ''storage_head_verified''::text) AND (checksum_source = ANY (ARRAY[''storage_digest_verified''::text, ''unavailable''::text])) AND (dimensions_source = ''browser_declared''::text) AND (duration_source = ''browser_declared''::text) AND (((checksum_source = ''unavailable''::text) AND (checksum_sha256 IS NULL)) OR ((checksum_source = ''storage_digest_verified''::text) AND (checksum_sha256 ~ ''^[0-9a-f]{64}$''::text))) AND (width > 0) AND (height > 0) AND ((duration_ms >= 4000) AND (duration_ms <= 300000)))))' then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
     for v_name,v_expected_definition in select * from (values
       ('video_upload_batches_owner_status_idx','CREATE INDEX video_upload_batches_owner_status_idx ON public.video_upload_batches USING btree (owner_user_id, status, updated_at DESC)'),
       ('video_upload_items_owner_batch_idx','CREATE INDEX video_upload_items_owner_batch_idx ON public.video_upload_items USING btree (owner_user_id, batch_id, ordinal)')
     ) expected(index_name,index_definition) loop
       select pg_get_indexdef(indexrelid) into v_default from pg_index where indexrelid=to_regclass('public.'||v_name);
       if not found or v_default is distinct from v_expected_definition then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
     end loop;
     if exists (select 1 from pg_index i where i.indrelid in ('public.video_upload_batches'::regclass,'public.video_upload_items'::regclass)
       and not exists(select 1 from pg_constraint p where p.conindid=i.indexrelid)
       and i.indexrelid not in ('public.video_upload_batches_owner_status_idx'::regclass,'public.video_upload_items_owner_batch_idx'::regclass)) then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
@@ -138,54 +148,60 @@ begin
       end if;
     end loop;
     if exists(select 1 from pg_class c cross join lateral aclexplode(c.relacl) acl
       where c.oid in ('public.video_upload_batches'::regclass,'public.video_upload_items'::regclass) and acl.is_grantable
         and (acl.grantee=0 or acl.grantee in (select oid from pg_roles where rolname in ('anon','authenticated','service_role')))) then
       v_active_privileges := false; v_rollback_privileges := false;
     end if;
   end if;
   for v_signature,v_marker,v_hash in select * from (values
     ('public.video_upload_batch_prepare(uuid,text,timestamptz)','vibepin:v77:video-upload-batch-prepare','73821871844f2b858bfc441d80919bbc'),
-    ('public.video_upload_item_prepare(uuid,uuid,integer,text,text,text,bigint,text,integer,integer,bigint)','vibepin:v77:video-upload-item-prepare','56f6733502f5b8c6570581cfb981d558'),
-    ('public.video_upload_item_finalize(uuid,uuid,integer,text,bigint,text,integer,integer,bigint)','vibepin:v77:video-upload-item-finalize','c72ba5b25af6037114491ad89da675ce')
+    ('public.video_upload_item_prepare(uuid,uuid,integer,text,text,text,bigint,text,integer,integer,bigint)','vibepin:v77:video-upload-item-prepare','2ba41a1ad29086bdca6cfce6e25cafad'),
+    ('public.video_upload_item_claim(uuid,uuid,integer,uuid,timestamptz)','vibepin:v77:video-upload-item-claim','1e7a9a9f8cda0fecf9b121e83caec3e1'),
+    ('public.video_upload_item_finalize(uuid,uuid,integer,uuid,text,text,bigint,text)','vibepin:v77:video-upload-item-finalize','02f3e0537c0e882230e159243cb92bae'),
+    ('public.video_upload_item_fail(uuid,uuid,integer,uuid,text)','vibepin:v77:video-upload-item-fail','71955fb29596ec65c0b9b8f4f2894f84')
   ) expected(signature,marker,body_hash) loop
     if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname=split_part(replace(v_signature,'public.',''),'(',1)
         and p.oid is distinct from to_regprocedure(v_signature)) then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
     if to_regprocedure(v_signature) is not null then
       select * into v_proc from pg_proc where oid=to_regprocedure(v_signature);
       if not v_installed or obj_description(v_proc.oid,'pg_proc') is distinct from v_marker
          or not v_proc.prosecdef or v_proc.prokind<>'f' or v_proc.prorettype<>to_regtype('jsonb')
          or v_proc.proretset or v_proc.provariadic<>0 or v_proc.prolang<>(select oid from pg_language where lanname='plpgsql')
          or v_proc.proconfig is distinct from array['search_path=public, pg_temp']::text[]
          or md5(replace(replace(v_proc.prosrc,chr(13)||chr(10),chr(10)),chr(13),chr(10)))<>v_hash then
         raise exception using errcode='P0001',message='v77_schema_collision';
       end if;
     elsif v_installed then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
   end loop;
   if v_installed then
     for v_signature in select signature from (values
       ('public.video_upload_batch_prepare(uuid,text,timestamptz)'),
       ('public.video_upload_item_prepare(uuid,uuid,integer,text,text,text,bigint,text,integer,integer,bigint)'),
-      ('public.video_upload_item_finalize(uuid,uuid,integer,text,bigint,text,integer,integer,bigint)')
+      ('public.video_upload_item_claim(uuid,uuid,integer,uuid,timestamptz)'),
+      ('public.video_upload_item_finalize(uuid,uuid,integer,uuid,text,text,bigint,text)'),
+      ('public.video_upload_item_fail(uuid,uuid,integer,uuid,text)')
     ) expected(signature) loop
       foreach v_grantee in array array['anon','authenticated','service_role'] loop
         v_actual := has_function_privilege(v_grantee,to_regprocedure(v_signature),'execute');
         if v_actual is distinct from (v_grantee='service_role') then v_active_privileges := false; end if;
         if v_actual then v_rollback_privileges := false; end if;
       end loop;
     end loop;
     if exists(select 1 from pg_proc p cross join lateral aclexplode(p.proacl) acl
       where p.oid in (
         to_regprocedure('public.video_upload_batch_prepare(uuid,text,timestamptz)'),
         to_regprocedure('public.video_upload_item_prepare(uuid,uuid,integer,text,text,text,bigint,text,integer,integer,bigint)'),
-        to_regprocedure('public.video_upload_item_finalize(uuid,uuid,integer,text,bigint,text,integer,integer,bigint)')
+        to_regprocedure('public.video_upload_item_claim(uuid,uuid,integer,uuid,timestamptz)'),
+        to_regprocedure('public.video_upload_item_finalize(uuid,uuid,integer,uuid,text,text,bigint,text)'),
+        to_regprocedure('public.video_upload_item_fail(uuid,uuid,integer,uuid,text)')
       ) and acl.is_grantable and (acl.grantee=0 or acl.grantee in (select oid from pg_roles where rolname in ('anon','authenticated','service_role')))) then
       v_active_privileges := false; v_rollback_privileges := false;
     end if;
     if not v_active_privileges and not v_rollback_privileges then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
   end if;
 end $v77_preflight$;

 create table if not exists public.video_upload_batches (
   id uuid primary key default gen_random_uuid(),
   owner_user_id uuid not null,
@@ -205,40 +221,50 @@ comment on table public.video_upload_batches is 'vibepin:v77:video-upload-batche
 create table if not exists public.video_upload_items (
   id uuid primary key default gen_random_uuid(),
   batch_id uuid not null references public.video_upload_batches(id) on delete restrict,
   owner_user_id uuid not null,
   ordinal integer not null constraint video_upload_items_ordinal_check check (ordinal between 0 and 19),
   idempotency_key text not null,
   private_path text not null,
   declared_content_type text not null
     constraint video_upload_items_declared_content_type_check check (declared_content_type in ('video/mp4','video/x-m4v','video/quicktime')),
   declared_byte_size bigint not null
-    constraint video_upload_items_declared_byte_size_check check (declared_byte_size between 0 and 104857600),
-  declared_checksum_sha256 text,
+    constraint video_upload_items_declared_byte_size_check check (declared_byte_size between 1 and 104857600),
+  declared_checksum_sha256 text
+    constraint video_upload_items_declared_checksum_check check (declared_checksum_sha256 is null or declared_checksum_sha256 ~ '^[0-9a-f]{64}$'),
   declared_width integer,
   declared_height integer,
   declared_duration_ms bigint,
+  constraint video_upload_items_declared_dimensions_check check (declared_width > 0 and declared_height > 0),
+  constraint video_upload_items_declared_duration_check check (declared_duration_ms between 4000 and 300000),
   verified_content_type text
     constraint video_upload_items_verified_content_type_check check (verified_content_type is null or verified_content_type in ('video/mp4','video/x-m4v','video/quicktime')),
   verified_byte_size bigint,
   verified_checksum_sha256 text,
   verified_width integer,
   verified_height integer,
   verified_duration_ms bigint,
+  finalize_claim_token uuid,
+  finalize_claim_expires_at timestamptz,
+  capability_expires_at timestamptz not null,
   status text not null default 'prepared'
     constraint video_upload_items_status_check check (status in ('prepared','uploading','finalizing','finalized','failed','expired','canceled')),
+  constraint video_upload_items_claim_shape_check check (
+    (status = 'finalizing') = (finalize_claim_token is not null and finalize_claim_expires_at is not null)
+  ),
   constraint video_upload_items_finalized_facts_check check ((
     status <> 'finalized' or (
       verified_content_type in ('video/mp4','video/x-m4v','video/quicktime')
-      and verified_byte_size between 0 and 104857600
-      and nullif(btrim(verified_checksum_sha256),'') is not null
-      and verified_width > 0 and verified_height > 0 and verified_duration_ms > 0
+      and verified_byte_size between 1 and 104857600
+      and (verified_checksum_sha256 is null or verified_checksum_sha256 ~ '^[0-9a-f]{64}$')
+      and verified_width is null and verified_height is null and verified_duration_ms is null
+      and finalize_claim_token is null and finalize_claim_expires_at is null
     )
   ) is true),
   error_code text,
   prepared_at timestamptz not null default now(),
   finalized_at timestamptz,
   expires_at timestamptz not null,
   created_at timestamptz not null default now(),
   updated_at timestamptz not null default now(),
   unique (batch_id, ordinal),
   unique (batch_id, idempotency_key)
@@ -247,32 +273,57 @@ comment on table public.video_upload_items is 'vibepin:v77:video-upload-items';
 create index if not exists video_upload_batches_owner_status_idx on public.video_upload_batches(owner_user_id,status,updated_at desc);
 create index if not exists video_upload_items_owner_batch_idx on public.video_upload_items(owner_user_id,batch_id,ordinal);

 alter table public.media_asset_provenance add column if not exists media_kind text not null default 'image';
 alter table public.media_asset_provenance add column if not exists content_type text;
 alter table public.media_asset_provenance add column if not exists byte_size bigint;
 alter table public.media_asset_provenance add column if not exists checksum_sha256 text;
 alter table public.media_asset_provenance add column if not exists width integer;
 alter table public.media_asset_provenance add column if not exists height integer;
 alter table public.media_asset_provenance add column if not exists duration_ms bigint;
+alter table public.media_asset_provenance add column if not exists content_type_source text;
+alter table public.media_asset_provenance add column if not exists byte_size_source text;
+alter table public.media_asset_provenance add column if not exists checksum_source text;
+alter table public.media_asset_provenance add column if not exists dimensions_source text;
+alter table public.media_asset_provenance add column if not exists duration_source text;
 do $v77_provenance_check$
 declare v_definition text;
 begin
   select pg_get_constraintdef(oid) into v_definition from pg_constraint
     where conrelid='public.media_asset_provenance'::regclass and conname='media_asset_provenance_media_kind_check';
   if found and v_definition <> 'CHECK ((media_kind = ANY (ARRAY[''image''::text, ''video''::text])))' then
     raise exception using errcode='P0001',message='v77_schema_collision';
   elsif not found then
     alter table public.media_asset_provenance add constraint media_asset_provenance_media_kind_check
       check (media_kind in ('image','video'));
   end if;
 end $v77_provenance_check$;
+do $v77_provenance_fact_sources$
+declare v_definition text;
+begin
+  select pg_get_constraintdef(oid) into v_definition from pg_constraint
+    where conrelid='public.media_asset_provenance'::regclass and conname='media_asset_provenance_video_fact_sources_check';
+  if found and v_definition <> 'CHECK (((media_kind <> ''video''::text) OR ((content_type_source = ''storage_head_verified''::text) AND (byte_size_source = ''storage_head_verified''::text) AND (checksum_source = ANY (ARRAY[''storage_digest_verified''::text, ''unavailable''::text])) AND (dimensions_source = ''browser_declared''::text) AND (duration_source = ''browser_declared''::text) AND (((checksum_source = ''unavailable''::text) AND (checksum_sha256 IS NULL)) OR ((checksum_source = ''storage_digest_verified''::text) AND (checksum_sha256 ~ ''^[0-9a-f]{64}$''::text))) AND (width > 0) AND (height > 0) AND ((duration_ms >= 4000) AND (duration_ms <= 300000)))))' then
+    raise exception using errcode='P0001',message='v77_schema_collision';
+  elsif not found then
+    alter table public.media_asset_provenance add constraint media_asset_provenance_video_fact_sources_check check (
+      media_kind <> 'video' or (
+        content_type_source='storage_head_verified' and byte_size_source='storage_head_verified'
+        and checksum_source in ('storage_digest_verified','unavailable')
+        and dimensions_source='browser_declared' and duration_source='browser_declared'
+        and ((checksum_source='unavailable' and checksum_sha256 is null)
+          or (checksum_source='storage_digest_verified' and checksum_sha256 ~ '^[0-9a-f]{64}$'))
+        and width>0 and height>0 and duration_ms between 4000 and 300000
+      )
+    );
+  end if;
+end $v77_provenance_fact_sources$;

 alter table public.video_upload_batches enable row level security;
 alter table public.video_upload_items enable row level security;
 revoke all on public.video_upload_batches,public.video_upload_items from public,anon,authenticated,service_role;
 grant select,insert,update,delete on public.video_upload_batches,public.video_upload_items to service_role;

 -- Only server callers receive these RPCs. Their owner argument is server-derived
 -- from the authenticated request or parent intent; no browser role can call them.
 create or replace function public.video_upload_batch_prepare(
   p_owner_user_id uuid,p_idempotency_key text,p_expires_at timestamptz
@@ -296,128 +347,269 @@ exception when others then
 end $fn$;
 comment on function public.video_upload_batch_prepare(uuid,text,timestamptz) is 'vibepin:v77:video-upload-batch-prepare';

 create or replace function public.video_upload_item_prepare(
   p_owner_user_id uuid,p_batch_id uuid,p_ordinal integer,p_idempotency_key text,p_private_path text,
   p_declared_content_type text,p_declared_byte_size bigint,p_declared_checksum_sha256 text,
   p_declared_width integer,p_declared_height integer,p_declared_duration_ms bigint
 ) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $fn$
 -- vibepin:v77:video-upload-item-prepare
 declare v_batch public.video_upload_batches%rowtype; v_item public.video_upload_items%rowtype;
+  v_capability_expires_at timestamptz := now()+interval '2 hours';
 begin
   if p_owner_user_id is null or p_batch_id is null or p_ordinal is null or p_ordinal<0 or p_ordinal>=20
      or nullif(btrim(p_idempotency_key),'') is null or nullif(btrim(p_private_path),'') is null
      or p_private_path like '%..%' or split_part(p_private_path,'/',1) is distinct from p_owner_user_id::text then
     raise exception using errcode='22023',message=case when p_ordinal is null or p_ordinal<0 or p_ordinal>=20 then 'video_upload_batch_limit_exceeded' else 'invalid_video_upload_item' end;
   end if;
   if p_declared_content_type not in ('video/mp4','video/x-m4v','video/quicktime') then
     raise exception using errcode='22023',message='invalid_video_content_type';
   end if;
-  if p_declared_byte_size is null or p_declared_byte_size<0 or p_declared_byte_size>104857600 then
+  if p_declared_byte_size is null or p_declared_byte_size<1 or p_declared_byte_size>104857600 then
     raise exception using errcode='22023',message='video_upload_too_large';
   end if;
+  if p_declared_checksum_sha256 is null or btrim(p_declared_checksum_sha256) !~ '^[0-9a-fA-F]{64}$'
+     or p_declared_width is null or p_declared_width<=0 or p_declared_height is null or p_declared_height<=0
+     or p_declared_duration_ms is null or p_declared_duration_ms<4000 or p_declared_duration_ms>300000 then
+    raise exception using errcode='22023',message='invalid_declared_video_facts';
+  end if;
   select * into v_batch from public.video_upload_batches where id=p_batch_id and owner_user_id=p_owner_user_id for update;
   if not found then raise exception using errcode='P0002',message='video_upload_batch_not_found'; end if;
+  if v_batch.expires_at<=now() then raise exception using errcode='55000',message='video_upload_batch_expired'; end if;
+  if v_batch.status not in ('prepared','uploading') then raise exception using errcode='55000',message='video_upload_batch_not_preparable'; end if;
   select * into v_item from public.video_upload_items where batch_id=v_batch.id and ordinal=p_ordinal for update;
   if found then
     if v_item.idempotency_key is distinct from btrim(p_idempotency_key)
        or v_item.private_path is distinct from btrim(p_private_path)
        or v_item.declared_content_type is distinct from p_declared_content_type
        or v_item.declared_byte_size is distinct from p_declared_byte_size
        or v_item.declared_checksum_sha256 is distinct from nullif(btrim(coalesce(p_declared_checksum_sha256,'')), '')
        or v_item.declared_width is distinct from p_declared_width
        or v_item.declared_height is distinct from p_declared_height
        or v_item.declared_duration_ms is distinct from p_declared_duration_ms then
       raise exception using errcode='23505',message='video_upload_item_idempotency_conflict';
     end if;
-    return jsonb_build_object('itemId',v_item.id,'status',v_item.status,'batchId',v_batch.id);
+    update public.video_upload_items set capability_expires_at=v_capability_expires_at,updated_at=now()
+      where id=v_item.id returning * into v_item;
+    insert into public.media_cleanup_outbox(owner_user_id,bucket_id,object_path,reason,dedupe_key,next_attempt_at)
+      values(p_owner_user_id,'generated-private',v_item.private_path,'video_upload_capability_expired','video-upload:'||v_item.id::text,v_capability_expires_at)
+      on conflict(dedupe_key) where dedupe_key is not null do update set
+        owner_user_id=excluded.owner_user_id,bucket_id=excluded.bucket_id,object_path=excluded.object_path,
+        reason=excluded.reason,status='pending',lease_token=null,lease_expires_at=null,
+        next_attempt_at=excluded.next_attempt_at,last_error_code=null,dead_lettered_at=null,completed_at=null,updated_at=now();
+    return jsonb_build_object('itemId',v_item.id,'status',v_item.status,'batchId',v_batch.id,'capabilityExpiresAt',v_item.capability_expires_at);
   end if;
-  if v_batch.expires_at<=now() then raise exception using errcode='55000',message='video_upload_batch_expired'; end if;
-  if v_batch.status not in ('prepared','uploading') then raise exception using errcode='55000',message='video_upload_batch_not_preparable'; end if;
   if exists (select 1 from public.video_upload_items where batch_id=v_batch.id and idempotency_key=btrim(p_idempotency_key)) then
     raise exception using errcode='23505',message='video_upload_item_idempotency_conflict';
   end if;
   insert into public.video_upload_items(
     batch_id,owner_user_id,ordinal,idempotency_key,private_path,declared_content_type,declared_byte_size,
-    declared_checksum_sha256,declared_width,declared_height,declared_duration_ms,expires_at
+    declared_checksum_sha256,declared_width,declared_height,declared_duration_ms,capability_expires_at,expires_at
   ) values (
     v_batch.id,p_owner_user_id,p_ordinal,btrim(p_idempotency_key),btrim(p_private_path),p_declared_content_type,p_declared_byte_size,
-    nullif(btrim(coalesce(p_declared_checksum_sha256,'')),''),p_declared_width,p_declared_height,p_declared_duration_ms,v_batch.expires_at
+    nullif(btrim(coalesce(p_declared_checksum_sha256,'')),''),p_declared_width,p_declared_height,p_declared_duration_ms,v_capability_expires_at,v_batch.expires_at
   ) returning * into v_item;
+  insert into public.media_cleanup_outbox(owner_user_id,bucket_id,object_path,reason,dedupe_key,next_attempt_at)
+    values(p_owner_user_id,'generated-private',v_item.private_path,'video_upload_capability_expired','video-upload:'||v_item.id::text,v_capability_expires_at)
+    on conflict(dedupe_key) where dedupe_key is not null do update set
+      owner_user_id=excluded.owner_user_id,bucket_id=excluded.bucket_id,object_path=excluded.object_path,
+      reason=excluded.reason,status='pending',lease_token=null,lease_expires_at=null,
+      next_attempt_at=excluded.next_attempt_at,last_error_code=null,dead_lettered_at=null,completed_at=null,updated_at=now();
   update public.video_upload_batches set status='uploading',updated_at=now() where id=v_batch.id;
-  return jsonb_build_object('itemId',v_item.id,'status',v_item.status,'batchId',v_batch.id);
+  return jsonb_build_object('itemId',v_item.id,'status',v_item.status,'batchId',v_batch.id,'capabilityExpiresAt',v_item.capability_expires_at);
 exception when others then
   raise exception using errcode=sqlstate,message=case sqlerrm
     when 'video_upload_batch_limit_exceeded' then 'video_upload_batch_limit_exceeded'
     when 'invalid_video_upload_item' then 'invalid_video_upload_item'
     when 'invalid_video_content_type' then 'invalid_video_content_type'
     when 'video_upload_too_large' then 'video_upload_too_large'
+    when 'invalid_declared_video_facts' then 'invalid_declared_video_facts'
     when 'video_upload_batch_not_found' then 'video_upload_batch_not_found'
     when 'video_upload_batch_expired' then 'video_upload_batch_expired'
     when 'video_upload_batch_not_preparable' then 'video_upload_batch_not_preparable'
     when 'video_upload_item_idempotency_conflict' then 'video_upload_item_idempotency_conflict'
     else 'v77_video_upload_error' end;
 end $fn$;
 comment on function public.video_upload_item_prepare(uuid,uuid,integer,text,text,text,bigint,text,integer,integer,bigint) is 'vibepin:v77:video-upload-item-prepare';

+create or replace function public.video_upload_item_claim(
+  p_owner_user_id uuid,p_batch_id uuid,p_ordinal integer,p_claim_token uuid,p_claim_expires_at timestamptz
+) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $fn$
+-- vibepin:v77:video-upload-item-claim
+declare v_batch public.video_upload_batches%rowtype; v_item public.video_upload_items%rowtype; v_provenance_ready boolean;
+begin
+  if p_owner_user_id is null or p_batch_id is null or p_ordinal is null or p_claim_token is null
+     or p_claim_expires_at is null or p_claim_expires_at<=now() or p_claim_expires_at>now()+interval '5 minutes' then
+    raise exception using errcode='22023',message='invalid_video_upload_claim';
+  end if;
+  select * into v_batch from public.video_upload_batches where id=p_batch_id and owner_user_id=p_owner_user_id for update;
+  if not found then raise exception using errcode='P0002',message='video_upload_batch_not_found'; end if;
+  select * into v_item from public.video_upload_items
+    where batch_id=v_batch.id and ordinal=p_ordinal and owner_user_id=p_owner_user_id for update;
+  if not found then raise exception using errcode='P0002',message='video_upload_item_not_found'; end if;
+  if v_item.status='finalized' then
+    select exists(select 1 from public.media_asset_provenance p
+      where p.owner_user_id=p_owner_user_id and p.bucket_id='generated-private' and p.object_path=v_item.private_path
+        and p.source_type='upload' and p.lifecycle_state='draft' and p.media_kind='video'
+        and p.content_type is not distinct from v_item.verified_content_type
+        and p.byte_size is not distinct from v_item.verified_byte_size
+        and p.checksum_sha256 is not distinct from v_item.verified_checksum_sha256
+        and p.width is not distinct from v_item.declared_width and p.height is not distinct from v_item.declared_height
+        and p.duration_ms is not distinct from v_item.declared_duration_ms
+        and p.content_type_source='storage_head_verified' and p.byte_size_source='storage_head_verified'
+        and p.checksum_source=case when v_item.verified_checksum_sha256 is null then 'unavailable' else 'storage_digest_verified' end
+        and p.dimensions_source='browser_declared' and p.duration_source='browser_declared') into v_provenance_ready;
+    if not v_provenance_ready then raise exception using errcode='55000',message='video_upload_provenance_incomplete'; end if;
+    return jsonb_build_object('itemId',v_item.id,'status',v_item.status,'claimToken',null,'provenanceReady',true);
+  end if;
+  if v_batch.expires_at<=now() then raise exception using errcode='55000',message='video_upload_batch_expired'; end if;
+  if v_batch.status not in ('uploading','finalizing') then raise exception using errcode='55000',message='video_upload_batch_not_finalizable'; end if;
+  if v_item.status='prepared' or (v_item.status='finalizing' and v_item.finalize_claim_expires_at<=now()) then
+    update public.video_upload_items set status='finalizing',finalize_claim_token=p_claim_token,
+      finalize_claim_expires_at=p_claim_expires_at,error_code=null,updated_at=now()
+      where id=v_item.id returning * into v_item;
+  elsif v_item.status='finalizing' and v_item.finalize_claim_token=p_claim_token and v_item.finalize_claim_expires_at>now() then
+    null;
+  elsif v_item.status='finalizing' then
+    raise exception using errcode='55000',message='video_upload_item_claimed';
+  else
+    raise exception using errcode='55000',message='video_upload_item_not_finalizable';
+  end if;
+  update public.video_upload_batches set status='finalizing',updated_at=now() where id=v_batch.id;
+  return jsonb_build_object('itemId',v_item.id,'status',v_item.status,'claimToken',v_item.finalize_claim_token,
+    'claimExpiresAt',v_item.finalize_claim_expires_at);
+exception when others then
+  raise exception using errcode=sqlstate,message=case sqlerrm
+    when 'invalid_video_upload_claim' then 'invalid_video_upload_claim'
+    when 'video_upload_batch_not_found' then 'video_upload_batch_not_found'
+    when 'video_upload_batch_expired' then 'video_upload_batch_expired'
+    when 'video_upload_batch_not_finalizable' then 'video_upload_batch_not_finalizable'
+    when 'video_upload_item_not_found' then 'video_upload_item_not_found'
+    when 'video_upload_provenance_incomplete' then 'video_upload_provenance_incomplete'
+    when 'video_upload_item_claimed' then 'video_upload_item_claimed'
+    when 'video_upload_item_not_finalizable' then 'video_upload_item_not_finalizable'
+    else 'v77_video_upload_error' end;
+end $fn$;
+comment on function public.video_upload_item_claim(uuid,uuid,integer,uuid,timestamptz) is 'vibepin:v77:video-upload-item-claim';
+
 create or replace function public.video_upload_item_finalize(
-  p_owner_user_id uuid,p_batch_id uuid,p_ordinal integer,p_verified_content_type text,p_verified_byte_size bigint,
-  p_verified_checksum_sha256 text,p_verified_width integer,p_verified_height integer,p_verified_duration_ms bigint
+  p_owner_user_id uuid,p_batch_id uuid,p_ordinal integer,p_claim_token uuid,p_bucket_id text,
+  p_verified_content_type text,p_verified_byte_size bigint,p_verified_checksum_sha256 text
 ) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $fn$
 -- vibepin:v77:video-upload-item-finalize
-declare v_batch public.video_upload_batches%rowtype; v_item public.video_upload_items%rowtype; v_done boolean;
+declare v_batch public.video_upload_batches%rowtype; v_item public.video_upload_items%rowtype; v_done boolean; v_has_nonfinal boolean; v_written boolean;
 begin
+  if p_owner_user_id is null or p_batch_id is null or p_ordinal is null or p_claim_token is null
+     or p_bucket_id is distinct from 'generated-private' then raise exception using errcode='22023',message='invalid_video_finalize_identity'; end if;
   if nullif(btrim(coalesce(p_verified_content_type,'')),'') is null
      or p_verified_content_type not in ('video/mp4','video/x-m4v','video/quicktime') then raise exception using errcode='22023',message='invalid_video_content_type'; end if;
-  if p_verified_byte_size is null or p_verified_byte_size<0 or p_verified_byte_size>104857600 then raise exception using errcode='22023',message='video_upload_too_large'; end if;
-  if nullif(btrim(coalesce(p_verified_checksum_sha256,'')),'') is null
-     or p_verified_width is null or p_verified_width<=0 or p_verified_height is null or p_verified_height<=0
-     or p_verified_duration_ms is null or p_verified_duration_ms<=0 then raise exception using errcode='22023',message='invalid_verified_video_facts'; end if;
+  if p_verified_byte_size is null or p_verified_byte_size<1 or p_verified_byte_size>104857600 then raise exception using errcode='22023',message='video_upload_too_large'; end if;
+  if p_verified_checksum_sha256 is not null and btrim(p_verified_checksum_sha256) !~ '^[0-9a-fA-F]{64}$' then
+    raise exception using errcode='22023',message='invalid_verified_video_checksum';
+  end if;
   select * into v_batch from public.video_upload_batches where id=p_batch_id and owner_user_id=p_owner_user_id for update;
   if not found then raise exception using errcode='P0002',message='video_upload_batch_not_found'; end if;
-  if v_batch.expires_at<=now() then raise exception using errcode='55000',message='video_upload_batch_expired'; end if;
-  select * into v_item from public.video_upload_items where batch_id=v_batch.id and ordinal=p_ordinal and owner_user_id=p_owner_user_id for update;
+  select * into v_item from public.video_upload_items
+    where batch_id=v_batch.id and ordinal=p_ordinal and owner_user_id=p_owner_user_id for update;
   if not found then raise exception using errcode='P0002',message='video_upload_item_not_found'; end if;
-  if v_item.status='finalized' then
-    if v_item.verified_content_type is distinct from p_verified_content_type or v_item.verified_byte_size is distinct from p_verified_byte_size
-       or v_item.verified_checksum_sha256 is distinct from nullif(btrim(coalesce(p_verified_checksum_sha256,'')), '')
-       or v_item.verified_width is distinct from p_verified_width or v_item.verified_height is distinct from p_verified_height
-       or v_item.verified_duration_ms is distinct from p_verified_duration_ms then
-      raise exception using errcode='23505',message='video_upload_finalize_conflict';
-    end if;
-    return jsonb_build_object('itemId',v_item.id,'status',v_item.status,'batchStatus',v_batch.status);
-  elsif v_batch.status not in ('uploading','finalizing') then raise exception using errcode='55000',message='video_upload_batch_not_finalizable';
-  elsif v_item.status<>'prepared' then raise exception using errcode='55000',message='video_upload_item_not_finalizable';
-  else
-    update public.video_upload_items set verified_content_type=p_verified_content_type,verified_byte_size=p_verified_byte_size,
-      verified_checksum_sha256=nullif(btrim(coalesce(p_verified_checksum_sha256,'')),''),verified_width=p_verified_width,
-      verified_height=p_verified_height,verified_duration_ms=p_verified_duration_ms,status='finalized',finalized_at=now(),updated_at=now()
-      where id=v_item.id returning * into v_item;
-  end if;
-  select not exists(select 1 from public.video_upload_items where batch_id=v_batch.id and status<>'finalized') into v_done;
-  update public.video_upload_batches set status=case when v_done then 'finalized' else 'finalizing' end,
-    finalized_at=case when v_done then coalesce(finalized_at,now()) else null end,updated_at=now() where id=v_batch.id returning * into v_batch;
-  return jsonb_build_object('itemId',v_item.id,'status',v_item.status,'batchStatus',v_batch.status);
+  if v_item.status<>'finalizing' or v_item.finalize_claim_token is distinct from p_claim_token
+     or v_item.finalize_claim_expires_at<=now() then raise exception using errcode='55000',message='video_upload_claim_lost'; end if;
+  insert into public.media_asset_provenance(
+    owner_user_id,bucket_id,object_path,source_type,intent_id,lifecycle_state,media_kind,
+    content_type,byte_size,checksum_sha256,width,height,duration_ms,
+    content_type_source,byte_size_source,checksum_source,dimensions_source,duration_source,updated_at
+  ) values (
+    p_owner_user_id,p_bucket_id,v_item.private_path,'upload',null,'draft','video',
+    p_verified_content_type,p_verified_byte_size,nullif(lower(btrim(coalesce(p_verified_checksum_sha256,''))),''),
+    v_item.declared_width,v_item.declared_height,v_item.declared_duration_ms,
+    'storage_head_verified','storage_head_verified',case when p_verified_checksum_sha256 is null then 'unavailable' else 'storage_digest_verified' end,
+    'browser_declared','browser_declared',now()
+  ) on conflict(bucket_id,object_path) do update set
+    owner_user_id=excluded.owner_user_id,source_type=excluded.source_type,intent_id=excluded.intent_id,
+    lifecycle_state=excluded.lifecycle_state,media_kind=excluded.media_kind,content_type=excluded.content_type,
+    byte_size=excluded.byte_size,checksum_sha256=excluded.checksum_sha256,width=excluded.width,height=excluded.height,
+    duration_ms=excluded.duration_ms,content_type_source=excluded.content_type_source,byte_size_source=excluded.byte_size_source,
+    checksum_source=excluded.checksum_source,dimensions_source=excluded.dimensions_source,duration_source=excluded.duration_source,
+    updated_at=now()
+    where media_asset_provenance.owner_user_id=excluded.owner_user_id
+      and media_asset_provenance.source_type='upload'
+    returning true into v_written;
+  if not coalesce(v_written,false) then raise exception using errcode='23505',message='video_provenance_conflict'; end if;
+  update public.video_upload_items set verified_content_type=p_verified_content_type,verified_byte_size=p_verified_byte_size,
+    verified_checksum_sha256=nullif(lower(btrim(coalesce(p_verified_checksum_sha256,''))),''),
+    verified_width=null,verified_height=null,verified_duration_ms=null,status='finalized',finalized_at=now(),
+    finalize_claim_token=null,finalize_claim_expires_at=null,updated_at=now()
+    where id=v_item.id returning * into v_item;
+  update public.media_cleanup_outbox set status='done',completed_at=now(),lease_token=null,lease_expires_at=null,
+    next_attempt_at=null,last_error_code=null,dead_lettered_at=null,updated_at=now()
+    where dedupe_key='video-upload:'||v_item.id::text;
+  if not found then raise exception using errcode='55000',message='video_cleanup_schedule_missing'; end if;
+  select not exists(select 1 from public.video_upload_items where batch_id=v_batch.id and status in ('prepared','finalizing')),
+    exists(select 1 from public.video_upload_items where batch_id=v_batch.id and status<>'finalized')
+    into v_done,v_has_nonfinal;
+  update public.video_upload_batches set status=case when not v_done then 'finalizing' when v_has_nonfinal then 'failed' else 'finalized' end,
+    finalized_at=case when v_done and not v_has_nonfinal then coalesce(finalized_at,now()) else null end,updated_at=now()
+    where id=v_batch.id returning * into v_batch;
+  return jsonb_build_object('itemId',v_item.id,'status',v_item.status,'batchStatus',v_batch.status,'provenanceReady',true);
 exception when others then
   raise exception using errcode=sqlstate,message=case sqlerrm
+    when 'invalid_video_finalize_identity' then 'invalid_video_finalize_identity'
     when 'invalid_video_content_type' then 'invalid_video_content_type'
     when 'video_upload_too_large' then 'video_upload_too_large'
+    when 'invalid_verified_video_checksum' then 'invalid_verified_video_checksum'
     when 'video_upload_batch_not_found' then 'video_upload_batch_not_found'
-    when 'video_upload_batch_expired' then 'video_upload_batch_expired'
     when 'video_upload_item_not_found' then 'video_upload_item_not_found'
-    when 'video_upload_batch_not_finalizable' then 'video_upload_batch_not_finalizable'
-    when 'video_upload_item_not_finalizable' then 'video_upload_item_not_finalizable'
-    when 'video_upload_finalize_conflict' then 'video_upload_finalize_conflict'
-    when 'invalid_verified_video_facts' then 'invalid_verified_video_facts'
+    when 'video_upload_claim_lost' then 'video_upload_claim_lost'
+    when 'video_provenance_conflict' then 'video_provenance_conflict'
+    when 'video_cleanup_schedule_missing' then 'video_cleanup_schedule_missing'
+    else 'v77_video_upload_error' end;
+end $fn$;
+comment on function public.video_upload_item_finalize(uuid,uuid,integer,uuid,text,text,bigint,text) is 'vibepin:v77:video-upload-item-finalize';
+
+create or replace function public.video_upload_item_fail(
+  p_owner_user_id uuid,p_batch_id uuid,p_ordinal integer,p_claim_token uuid,p_error_code text
+) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $fn$
+-- vibepin:v77:video-upload-item-fail
+declare v_batch public.video_upload_batches%rowtype; v_item public.video_upload_items%rowtype; v_done boolean;
+begin
+  if p_owner_user_id is null or p_batch_id is null or p_ordinal is null or p_claim_token is null
+     or nullif(btrim(coalesce(p_error_code,'')),'') is null then raise exception using errcode='22023',message='invalid_video_upload_failure'; end if;
+  select * into v_batch from public.video_upload_batches where id=p_batch_id and owner_user_id=p_owner_user_id for update;
+  if not found then raise exception using errcode='P0002',message='video_upload_batch_not_found'; end if;
+  select * into v_item from public.video_upload_items
+    where batch_id=v_batch.id and ordinal=p_ordinal and owner_user_id=p_owner_user_id for update;
+  if not found then raise exception using errcode='P0002',message='video_upload_item_not_found'; end if;
+  if v_item.status<>'finalizing' or v_item.finalize_claim_token is distinct from p_claim_token
+     or v_item.finalize_claim_expires_at<=now() then raise exception using errcode='55000',message='video_upload_claim_lost'; end if;
+  update public.video_upload_items set status='failed',error_code=btrim(p_error_code),
+    finalize_claim_token=null,finalize_claim_expires_at=null,updated_at=now()
+    where id=v_item.id returning * into v_item;
+  insert into public.media_cleanup_outbox(owner_user_id,bucket_id,object_path,reason,dedupe_key,next_attempt_at)
+    values(p_owner_user_id,'generated-private',v_item.private_path,btrim(p_error_code),'video-upload:'||v_item.id::text,v_item.capability_expires_at)
+    on conflict(dedupe_key) where dedupe_key is not null do update set
+      owner_user_id=excluded.owner_user_id,bucket_id=excluded.bucket_id,object_path=excluded.object_path,
+      reason=excluded.reason,status='pending',lease_token=null,lease_expires_at=null,
+      next_attempt_at=greatest(public.media_cleanup_outbox.next_attempt_at,excluded.next_attempt_at),
+      last_error_code=null,dead_lettered_at=null,completed_at=null,updated_at=now();
+  select not exists(select 1 from public.video_upload_items where batch_id=v_batch.id and status in ('prepared','finalizing')) into v_done;
+  update public.video_upload_batches set status=case when v_done then 'failed' else 'finalizing' end,
+    error_code=case when v_done then btrim(p_error_code) else null end,updated_at=now() where id=v_batch.id;
+  return jsonb_build_object('itemId',v_item.id,'status',v_item.status,'cleanupAllowed',true,'cleanupScheduled',true,'privatePath',v_item.private_path);
+exception when others then
+  raise exception using errcode=sqlstate,message=case sqlerrm
+    when 'invalid_video_upload_failure' then 'invalid_video_upload_failure'
+    when 'video_upload_batch_not_found' then 'video_upload_batch_not_found'
+    when 'video_upload_item_not_found' then 'video_upload_item_not_found'
+    when 'video_upload_claim_lost' then 'video_upload_claim_lost'
     else 'v77_video_upload_error' end;
 end $fn$;
-comment on function public.video_upload_item_finalize(uuid,uuid,integer,text,bigint,text,integer,integer,bigint) is 'vibepin:v77:video-upload-item-finalize';
+comment on function public.video_upload_item_fail(uuid,uuid,integer,uuid,text) is 'vibepin:v77:video-upload-item-fail';

 -- v76 remains the provider settlement boundary. Replace only its MIME literals;
 -- all private-bucket, owner, checksum, revision, lease, claim and settlement code stays byte-for-byte intact.
 do $v77_v76_video_mime$
 declare v_signature text; v_definition text; v_marker text; v_hash text; v_proc pg_proc%rowtype; v_old text := '(''image/png'',''image/jpeg'',''image/webp'')'; v_new text := '(''image/png'',''image/jpeg'',''image/webp'',''video/mp4'',''video/x-m4v'',''video/quicktime'')';
 begin
   for v_signature,v_marker,v_hash in select * from (values
     ('public.publish_asset_settle_materialization(uuid,text,text,uuid,text,text,text,text,bigint,text,text)','vibepin:v76:publish-asset-settle-materialization','05aeaf68837a95a5cdc6177383ee6092'),
     ('public.publish_asset_settle_item(uuid,text,text,uuid,text,integer,text,text,text,bigint,text)','vibepin:v76:publish-asset-settle-item','a05aef6619c3ec795b6ceee080e04843')
   ) expected(signature,marker,body_hash) loop
@@ -436,16 +628,20 @@ begin
       raise exception using errcode='P0001',message='v77_v76_function_collision';
     end if;
     if position(v_old in v_definition)>0 then v_definition := replace(v_definition,v_old,v_new);
     elsif position(v_new in v_definition)=0 then raise exception using errcode='P0001',message='v77_v76_function_collision'; end if;
     execute v_definition;
   end loop;
 end $v77_v76_video_mime$;

 revoke all on function public.video_upload_batch_prepare(uuid,text,timestamptz) from public,anon,authenticated;
 revoke all on function public.video_upload_item_prepare(uuid,uuid,integer,text,text,text,bigint,text,integer,integer,bigint) from public,anon,authenticated;
-revoke all on function public.video_upload_item_finalize(uuid,uuid,integer,text,bigint,text,integer,integer,bigint) from public,anon,authenticated;
+revoke all on function public.video_upload_item_claim(uuid,uuid,integer,uuid,timestamptz) from public,anon,authenticated;
+revoke all on function public.video_upload_item_finalize(uuid,uuid,integer,uuid,text,text,bigint,text) from public,anon,authenticated;
+revoke all on function public.video_upload_item_fail(uuid,uuid,integer,uuid,text) from public,anon,authenticated;
 grant execute on function public.video_upload_batch_prepare(uuid,text,timestamptz) to service_role;
 grant execute on function public.video_upload_item_prepare(uuid,uuid,integer,text,text,text,bigint,text,integer,integer,bigint) to service_role;
-grant execute on function public.video_upload_item_finalize(uuid,uuid,integer,text,bigint,text,integer,integer,bigint) to service_role;
+grant execute on function public.video_upload_item_claim(uuid,uuid,integer,uuid,timestamptz) to service_role;
+grant execute on function public.video_upload_item_finalize(uuid,uuid,integer,uuid,text,text,bigint,text) to service_role;
+grant execute on function public.video_upload_item_fail(uuid,uuid,integer,uuid,text) to service_role;
 notify pgrst,'reload schema';
 commit;
diff --git a/backend/db/rollback_v77_video_media.sql b/backend/db/rollback_v77_video_media.sql
index 69937db6..c9c87636 100644
--- a/backend/db/rollback_v77_video_media.sql
+++ b/backend/db/rollback_v77_video_media.sql
@@ -31,13 +31,15 @@ begin
       raise exception using errcode='P0001',message='v77_rollback_collision';
     end if;
     if position(v_old in v_definition)>0 then execute replace(v_definition,v_old,v_new);
     elsif position(v_new in v_definition)=0 then raise exception using errcode='P0001',message='v77_rollback_collision'; end if;
   end loop;
 end $v77_restore_v76_mime$;
 revoke all on public.video_upload_batches,public.video_upload_items from public,anon,authenticated,service_role;
 grant select on public.video_upload_batches,public.video_upload_items to service_role;
 revoke all on function public.video_upload_batch_prepare(uuid,text,timestamptz) from public,anon,authenticated,service_role;
 revoke all on function public.video_upload_item_prepare(uuid,uuid,integer,text,text,text,bigint,text,integer,integer,bigint) from public,anon,authenticated,service_role;
-revoke all on function public.video_upload_item_finalize(uuid,uuid,integer,text,bigint,text,integer,integer,bigint) from public,anon,authenticated,service_role;
+revoke all on function public.video_upload_item_claim(uuid,uuid,integer,uuid,timestamptz) from public,anon,authenticated,service_role;
+revoke all on function public.video_upload_item_finalize(uuid,uuid,integer,uuid,text,text,bigint,text) from public,anon,authenticated,service_role;
+revoke all on function public.video_upload_item_fail(uuid,uuid,integer,uuid,text) from public,anon,authenticated,service_role;
 notify pgrst,'reload schema';
 commit;
diff --git a/backend/tests/pglite_v37/verify-v77-video-media.mjs b/backend/tests/pglite_v37/verify-v77-video-media.mjs
index 21444846..0a531e2b 100644
--- a/backend/tests/pglite_v37/verify-v77-video-media.mjs
+++ b/backend/tests/pglite_v37/verify-v77-video-media.mjs
@@ -65,20 +65,37 @@ async function asRole(db, role, action) {
 async function prepareBatch(db, owner, key) {
   return (await db.query("select public.video_upload_batch_prepare($1,$2,now()+interval '1 hour') as value", [owner, key])).rows[0].value;
 }
 async function prepareItem(db, owner, batchId, ordinal, key, mime = "video/mp4", bytes = 1024) {
   return (await db.query(`select public.video_upload_item_prepare(
     $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) as value`, [
     owner, batchId, ordinal, key, `${owner}/uploads/${batchId}/${ordinal}.mp4`, mime, bytes,
     "a".repeat(64), 1080, 1920, 15_000,
   ])).rows[0].value;
 }
+async function claimItem(db, owner, batchId, ordinal, token, leaseSeconds = 60) {
+  return (await db.query(`select public.video_upload_item_claim(
+    $1,$2,$3,$4,now()+($5::text || ' seconds')::interval) as value`, [
+    owner, batchId, ordinal, token, leaseSeconds,
+  ])).rows[0].value;
+}
+async function finalizeItem(db, owner, batchId, ordinal, token, checksum = null) {
+  return (await db.query(`select public.video_upload_item_finalize(
+    $1,$2,$3,$4,'generated-private','video/mp4',1024,$5) as value`, [
+    owner, batchId, ordinal, token, checksum,
+  ])).rows[0].value;
+}
+async function failItem(db, owner, batchId, ordinal, token, code = "invalid_video_container") {
+  return (await db.query(`select public.video_upload_item_fail($1,$2,$3,$4,$5) as value`, [
+    owner, batchId, ordinal, token, code,
+  ])).rows[0].value;
+}
 async function run() {
   const db = await dbWithV76();
   try {
     await db.query(`insert into public.media_asset_provenance(
       owner_user_id,bucket_id,object_path,source_type,lifecycle_state)
       values($1,'generated-private','${A}/legacy.png','legacy','draft')`, [A]);
     const v76Before = (await db.query("select pg_get_functiondef(to_regprocedure($1)) as definition", [
       "public.publish_asset_settle_item(uuid,text,text,uuid,text,integer,text,text,text,bigint,text)",
     ])).rows[0].definition;
     await db.exec(migration);
@@ -115,109 +132,207 @@ async function run() {
       ["video_upload_items", "declared_checksum_sha256", "text", false, null],
       ["video_upload_items", "declared_width", "integer", false, null],
       ["video_upload_items", "declared_height", "integer", false, null],
       ["video_upload_items", "declared_duration_ms", "bigint", false, null],
       ["video_upload_items", "verified_content_type", "text", false, null],
       ["video_upload_items", "verified_byte_size", "bigint", false, null],
       ["video_upload_items", "verified_checksum_sha256", "text", false, null],
       ["video_upload_items", "verified_width", "integer", false, null],
       ["video_upload_items", "verified_height", "integer", false, null],
       ["video_upload_items", "verified_duration_ms", "bigint", false, null],
+      ["video_upload_items", "finalize_claim_token", "uuid", false, null],
+      ["video_upload_items", "finalize_claim_expires_at", "timestamp with time zone", false, null],
+      ["video_upload_items", "capability_expires_at", "timestamp with time zone", true, null],
       ["video_upload_items", "status", "text", true, "'prepared'::text"],
       ["video_upload_items", "error_code", "text", false, null],
       ["video_upload_items", "prepared_at", "timestamp with time zone", true, "now()"],
       ["video_upload_items", "finalized_at", "timestamp with time zone", false, null],
       ["video_upload_items", "expires_at", "timestamp with time zone", true, null],
       ["video_upload_items", "created_at", "timestamp with time zone", true, "now()"],
       ["video_upload_items", "updated_at", "timestamp with time zone", true, "now()"],
       ["media_asset_provenance", "media_kind", "text", true, "'image'::text"],
       ["media_asset_provenance", "content_type", "text", false, null],
       ["media_asset_provenance", "byte_size", "bigint", false, null],
       ["media_asset_provenance", "checksum_sha256", "text", false, null],
       ["media_asset_provenance", "width", "integer", false, null],
       ["media_asset_provenance", "height", "integer", false, null],
       ["media_asset_provenance", "duration_ms", "bigint", false, null],
+      ["media_asset_provenance", "content_type_source", "text", false, null],
+      ["media_asset_provenance", "byte_size_source", "text", false, null],
+      ["media_asset_provenance", "checksum_source", "text", false, null],
+      ["media_asset_provenance", "dimensions_source", "text", false, null],
+      ["media_asset_provenance", "duration_source", "text", false, null],
     ];
     const actualColumns = await db.query(`select c.relname as table_name,a.attname,
       format_type(a.atttypid,a.atttypmod) as type,a.attnotnull,
       pg_get_expr(d.adbin,d.adrelid) as default_value
       from pg_attribute a join pg_class c on c.oid=a.attrelid
       left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
       where c.relnamespace='public'::regnamespace and c.relname in
         ('video_upload_batches','video_upload_items','media_asset_provenance')
         and not a.attisdropped and a.attnum>0 order by c.relname,a.attnum`);
     for (const [table, column, type, required, defaultValue] of expectedColumns) {
       assert(actualColumns.rows.some(row => row.table_name === table && row.attname === column
         && row.type === type && row.attnotnull === required && row.default_value === defaultValue),
       `schema inventory owns ${table}.${column} type/nullability/default`);
     }

     const provenanceColumns = (await db.query(`select attname from pg_attribute
       where attrelid='public.media_asset_provenance'::regclass and not attisdropped`)).rows.map(row => row.attname);
-    for (const column of ["media_kind", "content_type", "byte_size", "checksum_sha256", "width", "height", "duration_ms"]) {
+    for (const column of ["media_kind", "content_type", "byte_size", "checksum_sha256", "width", "height", "duration_ms",
+      "content_type_source", "byte_size_source", "checksum_source", "dimensions_source", "duration_source"]) {
       assert(provenanceColumns.includes(column), `v77 adds provenance ${column}`);
     }
     const legacy = await db.query("select media_kind,content_type,byte_size,duration_ms from public.media_asset_provenance where object_path=$1", [`${A}/legacy.png`]);
     assert(JSON.stringify(legacy.rows[0]) === JSON.stringify({ media_kind: "image", content_type: null, byte_size: null, duration_ms: null }),
       "old provenance rows remain valid images without historical data loss");

     const one = await asRole(db, "service_role", () => prepareBatch(db, A, "batch-key"));
     const again = await asRole(db, "service_role", () => prepareBatch(db, A, "batch-key"));
     const otherOwner = await asRole(db, "service_role", () => prepareBatch(db, B, "batch-key"));
     assert(one.batchId === again.batchId && one.batchId !== otherOwner.batchId, "batch idempotency is owner-scoped");
     const item = await asRole(db, "service_role", () => prepareItem(db, A, one.batchId, 0, "item-key"));
     const itemAgain = await asRole(db, "service_role", () => prepareItem(db, A, one.batchId, 0, "item-key"));
     assert(item.itemId === itemAgain.itemId && item.status === "prepared", "item prepare is idempotent and starts prepared");
-    const finalized = await asRole(db, "service_role", async () => (await db.query(`select public.video_upload_item_finalize(
-      $1,$2,$3,$4,$5,$6,$7,$8,$9) as value`, [A, one.batchId, 0, "video/mp4", 1024, "a".repeat(64), 1080, 1920, 15_000])).rows[0].value);
-    assert(finalized.status === "finalized" && finalized.batchStatus === "finalized", "finalize records verified facts and advances the batch lifecycle");
-    const changedFinalize = await asRole(db, "service_role", () => rejected(() => db.query(`select public.video_upload_item_finalize(
-      $1,$2,$3,$4,$5,$6,$7,$8,$9)`, [A, one.batchId, 0, "video/mp4", 1024, "a".repeat(64), 720, 1280, 10_000])));
-    assert(changedFinalize?.message === "video_upload_finalize_conflict", "finalize replay binds dimensions and duration as immutable verified facts");
-    const replayAfterProgress = await asRole(db, "service_role", () => prepareItem(db, A, one.batchId, 0, "item-key"));
-    assert(replayAfterProgress.itemId === item.itemId && replayAfterProgress.status === "finalized", "matching prepare replay remains idempotent after terminal progress");
-    const nullVerified = await asRole(db, "service_role", () => rejected(() => db.query(`select public.video_upload_item_finalize(
-      $1,$2,$3,$4,$5,$6,$7,$8,$9)`, [A, otherOwner.batchId, 0, null, 1, "b".repeat(64), 1, 1, 1])));
-    assert(nullVerified?.message === "invalid_video_content_type", "finalization explicitly rejects missing verified MIME");
+    const capabilityGuard = (await db.query(`select i.capability_expires_at,o.status,o.next_attempt_at,o.dedupe_key
+      from public.video_upload_items i join public.media_cleanup_outbox o
+        on o.dedupe_key='video-upload:'||i.id::text where i.id=$1`, [item.itemId])).rows[0];
+    assert(capabilityGuard?.status === "pending" && capabilityGuard.dedupe_key === `video-upload:${item.itemId}`
+      && Date.parse(capabilityGuard.next_attempt_at) >= Date.parse(capabilityGuard.capability_expires_at),
+      "prepare atomically persists delayed cleanup through the signed capability lifetime");
+    const changedPrepare = await asRole(db, "service_role", () => rejected(() => db.query(`select public.video_upload_item_prepare(
+      $1,$2,0,'item-key',$3,'video/mp4',1024,$4,720,1280,10_000)`,
+      [A, one.batchId, `${A}/uploads/${one.batchId}/0.mp4`, "d".repeat(64)])));
+    assert(changedPrepare?.message === "video_upload_item_idempotency_conflict", "replay conflicts whenever immutable declared facts differ");
+
+    const claimToken = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
+    const competingToken = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
+    const claimed = await asRole(db, "service_role", () => claimItem(db, A, one.batchId, 0, claimToken));
+    const competingClaim = await asRole(db, "service_role", () => rejected(() => claimItem(db, A, one.batchId, 0, competingToken)));
+    assert(claimed.status === "finalizing" && claimed.claimToken === claimToken && competingClaim?.message === "video_upload_item_claimed",
+      "an owner-scoped atomic claim admits one finalizer and rejects a concurrent claimant");
+    const wrongClaimFailure = await asRole(db, "service_role", () => rejected(() => failItem(db, A, one.batchId, 0, competingToken)));
+    const stillClaimed = (await db.query("select status,finalize_claim_token from public.video_upload_items where id=$1", [item.itemId])).rows[0];
+    assert(wrongClaimFailure?.message === "video_upload_claim_lost" && stillClaimed.status === "finalizing" && stillClaimed.finalize_claim_token === claimToken,
+      "a losing claimant cannot mark or clean up the winner's item");
+
+    const finalized = await asRole(db, "service_role", () => finalizeItem(db, A, one.batchId, 0, claimToken, null));
+    const finalizedFacts = (await db.query(`select status,verified_content_type,verified_byte_size,verified_checksum_sha256,
+      verified_width,verified_height,verified_duration_ms,finalize_claim_token from public.video_upload_items where id=$1`, [item.itemId])).rows[0];
+    const provenance = (await db.query(`select owner_user_id,media_kind,content_type,byte_size,checksum_sha256,width,height,duration_ms,
+      content_type_source,byte_size_source,checksum_source,dimensions_source,duration_source
+      from public.media_asset_provenance where bucket_id='generated-private' and object_path=$1`, [`${A}/uploads/${one.batchId}/0.mp4`])).rows[0];
+    assert(finalized.status === "finalized" && finalized.provenanceReady === true
+      && JSON.stringify(finalizedFacts) === JSON.stringify({ status: "finalized", verified_content_type: "video/mp4", verified_byte_size: 1024,
+        verified_checksum_sha256: null, verified_width: null, verified_height: null, verified_duration_ms: null, finalize_claim_token: null }),
+      "atomic finalization records only storage-verified facts and clears the claim");
+    assert(JSON.stringify(provenance) === JSON.stringify({ owner_user_id: A, media_kind: "video", content_type: "video/mp4", byte_size: 1024,
+      checksum_sha256: null, width: 1080, height: 1920, duration_ms: 15_000, content_type_source: "storage_head_verified",
+      byte_size_source: "storage_head_verified", checksum_source: "unavailable", dimensions_source: "browser_declared", duration_source: "browser_declared" }),
+      "the same transaction registers provenance with explicit source/trust labels for observed facts");
+    const finalizedCleanup = (await db.query("select status,completed_at from public.media_cleanup_outbox where dedupe_key=$1", [`video-upload:${item.itemId}`])).rows[0];
+    assert(finalizedCleanup.status === "done" && finalizedCleanup.completed_at,
+      "atomic finalization cancels the delayed capability cleanup responsibility");
+
+    await db.query("delete from public.media_asset_provenance where bucket_id='generated-private' and object_path=$1", [`${A}/uploads/${one.batchId}/0.mp4`]);
+    const incompleteReplay = await asRole(db, "service_role", () => rejected(() => claimItem(db, A, one.batchId, 0, competingToken)));
+    assert(incompleteReplay?.message === "video_upload_provenance_incomplete", `finalized replay fails closed when complete provenance is missing: ${incompleteReplay?.message}`);
+    await db.query(`insert into public.media_asset_provenance(owner_user_id,bucket_id,object_path,source_type,lifecycle_state,media_kind,
+      content_type,byte_size,width,height,duration_ms,content_type_source,byte_size_source,checksum_source,dimensions_source,duration_source)
+      values($1,'generated-private',$2,'upload','draft','video','video/mp4',1024,1080,1920,15000,
+      'storage_head_verified','storage_head_verified','unavailable','browser_declared','browser_declared')`, [A, `${A}/uploads/${one.batchId}/0.mp4`]);
+
+    const conflictBatch = await asRole(db, "service_role", () => prepareBatch(db, A, "conflict-batch"));
+    const conflictItem = await asRole(db, "service_role", () => prepareItem(db, A, conflictBatch.batchId, 0, "conflict-item"));
+    await db.query(`insert into public.media_asset_provenance(owner_user_id,bucket_id,object_path,source_type,lifecycle_state)
+      values($1,'generated-private',$2,'legacy','draft')`, [B, `${A}/uploads/${conflictBatch.batchId}/0.mp4`]);
+    await asRole(db, "service_role", () => claimItem(db, A, conflictBatch.batchId, 0, competingToken));
+    const atomicConflict = await asRole(db, "service_role", () => rejected(() => finalizeItem(db, A, conflictBatch.batchId, 0, competingToken, "a".repeat(64))));
+    const conflictState = (await db.query("select status,verified_content_type from public.video_upload_items where id=$1", [conflictItem.itemId])).rows[0];
+    assert(atomicConflict?.message === "video_provenance_conflict" && conflictState.status === "finalizing" && conflictState.verified_content_type === null,
+      "provenance conflict rolls back final facts and lifecycle in the same database transaction");
+
+    const failureBatch = await asRole(db, "service_role", () => prepareBatch(db, A, "failure-batch"));
+    const failureItem = await asRole(db, "service_role", () => prepareItem(db, A, failureBatch.batchId, 0, "failure-item"));
+    await asRole(db, "service_role", () => claimItem(db, A, failureBatch.batchId, 0, claimToken));
+    const failed = await asRole(db, "service_role", () => failItem(db, A, failureBatch.batchId, 0, claimToken));
+    const failedState = (await db.query("select status,finalize_claim_token from public.video_upload_items where id=$1", [failureItem.itemId])).rows[0];
+    const failedCleanup = (await db.query(`select o.status,o.next_attempt_at,i.capability_expires_at
+      from public.video_upload_items i join public.media_cleanup_outbox o on o.dedupe_key='video-upload:'||i.id::text
+      where i.id=$1`, [failureItem.itemId])).rows[0];
+    assert(failed.cleanupAllowed === true && failed.cleanupScheduled === true && failed.status === "failed"
+      && failedState.status === "failed" && failedState.finalize_claim_token === null
+      && failedCleanup.status === "pending" && Date.parse(failedCleanup.next_attempt_at) >= Date.parse(failedCleanup.capability_expires_at),
+      "only the current claim owner receives cleanup authority after atomically preserving delayed cleanup");
+
+    const partialBatch = await asRole(db, "service_role", () => prepareBatch(db, A, "partial-batch"));
+    const partialFailed = await asRole(db, "service_role", () => prepareItem(db, A, partialBatch.batchId, 0, "partial-failed"));
+    const partialWinner = await asRole(db, "service_role", () => prepareItem(db, A, partialBatch.batchId, 1, "partial-winner"));
+    await asRole(db, "service_role", () => claimItem(db, A, partialBatch.batchId, 0, claimToken));
+    await asRole(db, "service_role", () => failItem(db, A, partialBatch.batchId, 0, claimToken));
+    await asRole(db, "service_role", () => claimItem(db, A, partialBatch.batchId, 1, competingToken));
+    await asRole(db, "service_role", () => finalizeItem(db, A, partialBatch.batchId, 1, competingToken, null));
+    const partialState = await db.query("select id,status from public.video_upload_items where id in ($1,$2) order by ordinal", [partialFailed.itemId, partialWinner.itemId]);
+    const partialBatchState = (await db.query("select status from public.video_upload_batches where id=$1", [partialBatch.batchId])).rows[0];
+    assert(partialState.rows[0].status === "failed" && partialState.rows[1].status === "finalized" && partialBatchState.status === "failed",
+      "one failed item does not block an independently claimed sibling from atomically finalizing");
+
+    const takeoverBatch = await asRole(db, "service_role", () => prepareBatch(db, A, "takeover-batch"));
+    const takeoverItem = await asRole(db, "service_role", () => prepareItem(db, A, takeoverBatch.batchId, 0, "takeover-item"));
+    await asRole(db, "service_role", () => claimItem(db, A, takeoverBatch.batchId, 0, claimToken));
+    await db.query("update public.video_upload_items set finalize_claim_expires_at=now()-interval '1 second' where id=$1", [takeoverItem.itemId]);
+    const takeover = await asRole(db, "service_role", () => claimItem(db, A, takeoverBatch.batchId, 0, competingToken));
+    const staleCleanup = await asRole(db, "service_role", () => rejected(() => failItem(db, A, takeoverBatch.batchId, 0, claimToken)));
+    const takeoverCleanup = await asRole(db, "service_role", () => failItem(db, A, takeoverBatch.batchId, 0, competingToken));
+    assert(takeover.claimToken === competingToken && staleCleanup?.message === "video_upload_claim_lost" && takeoverCleanup.cleanupAllowed === true,
+      "an expired lease can be recovered while the stale owner permanently loses cleanup authority");
+
     const terminalBatch = await asRole(db, "service_role", () => prepareBatch(db, A, "terminal-batch"));
     const terminalItem = await asRole(db, "service_role", () => prepareItem(db, A, terminalBatch.batchId, 0, "terminal-item"));
     const directFinalizedUpdate = await asRole(db, "service_role", () => rejected(() => db.query(
       "update public.video_upload_items set status='finalized',verified_checksum_sha256='direct' where id=$1", [terminalItem.itemId],
     )));
     const directFinalizedInsert = await asRole(db, "service_role", () => rejected(() => db.query(`insert into public.video_upload_items(
-      batch_id,owner_user_id,ordinal,idempotency_key,private_path,declared_content_type,declared_byte_size,status,expires_at
-    ) values($1,$2,1,'direct-final','${A}/direct.mp4','video/mp4',1,'finalized',now()+interval '1 hour')`, [terminalBatch.batchId, A])));
+      batch_id,owner_user_id,ordinal,idempotency_key,private_path,declared_content_type,declared_byte_size,
+      declared_width,declared_height,declared_duration_ms,status,expires_at
+    ) values($1,$2,1,'direct-final','${A}/direct.mp4','video/mp4',1,1,1,4000,'finalized',now()+interval '1 hour')`, [terminalBatch.batchId, A])));
     assert(directFinalizedUpdate && directFinalizedInsert, "service-role direct INSERT/UPDATE cannot create a finalized item with NULL verified facts");
     await db.query("update public.video_upload_batches set status='canceled' where id=$1", [terminalBatch.batchId]);
-    const canceledFinalize = await asRole(db, "service_role", () => rejected(() => db.query(`select public.video_upload_item_finalize(
-      $1,$2,$3,$4,$5,$6,$7,$8,$9)`, [A, terminalBatch.batchId, 0, "video/mp4", 1, "c".repeat(64), 1, 1, 1])));
-    assert(canceledFinalize?.message === "video_upload_batch_not_finalizable", "finalize cannot revive a canceled batch");
-    const changedPrepare = await asRole(db, "service_role", () => rejected(() => db.query(`select public.video_upload_item_prepare(
-      $1,$2,0,'item-key',$3,'video/mp4',1024,$4,720,1280,10_000)`,
-      [A, one.batchId, `${A}/uploads/${one.batchId}/0.mp4`, "d".repeat(64)])));
-    assert(changedPrepare?.message === "video_upload_item_idempotency_conflict", "replay conflicts whenever immutable declared facts differ");
+    const canceledClaim = await asRole(db, "service_role", () => rejected(() => claimItem(db, A, terminalBatch.batchId, 0, claimToken)));
+    assert(canceledClaim?.message === "video_upload_batch_not_finalizable", "claim cannot revive a canceled batch");

     const crossOwner = await asRole(db, "service_role", () => rejected(() => prepareItem(db, B, one.batchId, 1, "foreign-item")));
     assert(crossOwner?.message === "video_upload_batch_not_found", "a service parent cannot write another owner's batch");
     const tooMany = await asRole(db, "service_role", () => rejected(() => prepareItem(db, A, one.batchId, 20, "ordinal-20")));
     assert(tooMany?.message === "video_upload_batch_limit_exceeded", "a batch permits no more than twenty videos");
     const oversize = await asRole(db, "service_role", () => rejected(() => prepareItem(db, A, one.batchId, 1, "oversize", "video/mp4", 104857601)));
     assert(oversize?.message === "video_upload_too_large", "a video declaration over 100 MiB is rejected with a stable code");
     const badMime = await asRole(db, "service_role", () => rejected(() => prepareItem(db, A, one.batchId, 1, "bad-mime", "video/webm")));
     assert(badMime?.message === "invalid_video_content_type", "only the frozen video MIME allowlist is accepted");
+    const durationBatch = await asRole(db, "service_role", () => prepareBatch(db, A, "duration-batch"));
+    const shortDuration = await asRole(db, "service_role", () => rejected(() => db.query(`select public.video_upload_item_prepare(
+      $1,$2,1,'too-short',$3,'video/mp4',1024,$4,1080,1920,3999)`, [A, durationBatch.batchId, `${A}/short.mp4`, "a".repeat(64)])));
+    const longDuration = await asRole(db, "service_role", () => rejected(() => db.query(`select public.video_upload_item_prepare(
+      $1,$2,1,'too-long',$3,'video/mp4',1024,$4,1080,1920,300001)`, [A, durationBatch.batchId, `${A}/long.mp4`, "a".repeat(64)])));
+    assert(shortDuration?.message === "invalid_declared_video_facts" && longDuration?.message === "invalid_declared_video_facts",
+      "the database shares the 4-second through 5-minute declared duration boundary");

     await db.exec(`set role authenticated; set "request.jwt.claim.sub"='${A}';`);
     const directBatchWrite = await rejected(() => db.query("insert into public.video_upload_batches(owner_user_id,idempotency_key,expires_at) values($1,'client-write',now())", [A]));
     const directItemWrite = await rejected(() => db.query("insert into public.video_upload_items(batch_id,owner_user_id,ordinal,idempotency_key,private_path,declared_content_type,declared_byte_size) values($1,$2,1,'client-item','x','video/mp4',1)", [one.batchId, A]));
     const clientRpc = await rejected(() => db.query("select public.video_upload_batch_prepare($1,'client-rpc',now())", [A]));
+    const clientClaimRpc = await rejected(() => db.query("select public.video_upload_item_claim($1,$2,0,$3,now()+interval '1 minute')", [A, one.batchId, claimToken]));
+    const clientFinalizeRpc = await rejected(() => db.query("select public.video_upload_item_finalize($1,$2,0,$3,'generated-private','video/mp4',1024,null)", [A, one.batchId, claimToken]));
+    const clientFailRpc = await rejected(() => db.query("select public.video_upload_item_fail($1,$2,0,$3,'x')", [A, one.batchId, claimToken]));
     await db.exec("reset role; reset \"request.jwt.claim.sub\";");
-    assert(directBatchWrite && directItemWrite && clientRpc, "clients have neither direct writes nor RPC write access");
+    assert(directBatchWrite && directItemWrite && clientRpc && clientClaimRpc && clientFinalizeRpc && clientFailRpc,
+      "clients have neither direct writes nor any claim/finalize/fail RPC write access");

     for (const mime of ["video/mp4", "video/x-m4v", "video/quicktime"]) {
       const result = await asRole(db, "service_role", () => rejected(() => db.query(
         "select public.publish_asset_settle_item($1,'missing-intent','missing-destination',$2,'media-0',0,'generated-private',$3,$4,1,$5)",
         [A, "33333333-3333-4333-8333-333333333331", `${A}/missing.mp4`, mime, "b".repeat(64)],
       )));
       assert(result?.message === "publish_intent_not_found", `v76 settlement accepts ${mime} before enforcing its intent/lease chain`);
     }
     const v76Rejected = await asRole(db, "service_role", () => rejected(() => db.query(
       "select public.publish_asset_settle_item($1,'missing-intent','missing-destination',$2,'media-0',0,'generated-private',$3,'video/webm',1,$4)",
@@ -231,49 +346,61 @@ async function run() {
     assert(materializationVideo?.message === "materialization_lease_lost", "the legacy single-item settlement also accepts approved video MIME before enforcing its lease");
     const materializationRejected = await asRole(db, "service_role", () => rejected(() => db.query(
       "select public.publish_asset_settle_materialization($1,'missing-intent','missing-destination',$2,'ready','generated-private',$3,'video/webm',1,$4,null)",
       [A, "33333333-3333-4333-8333-333333333331", `${A}/missing.webm`, "b".repeat(64)],
     )));
     assert(materializationRejected?.message === "invalid_content_type", "the legacy single-item settlement rejects unapproved video MIME before the lease check");

     const beforeRollback = await db.query(`select jsonb_build_object(
       'batches',(select coalesce(jsonb_agg(to_jsonb(b) order by b.id),'[]'::jsonb) from public.video_upload_batches b),
       'items',(select coalesce(jsonb_agg(to_jsonb(i) order by i.id),'[]'::jsonb) from public.video_upload_items i),
-      'provenance',(select coalesce(jsonb_agg(to_jsonb(p) order by p.object_path),'[]'::jsonb) from public.media_asset_provenance p)
+      'provenance',(select coalesce(jsonb_agg(to_jsonb(p) order by p.object_path),'[]'::jsonb) from public.media_asset_provenance p),
+      'cleanup',(select coalesce(jsonb_agg(to_jsonb(o) order by o.id),'[]'::jsonb) from public.media_cleanup_outbox o)
     ) as state`);
     await db.exec(rollback); await db.exec(rollback);
     const rollbackTableWrite = await asRole(db, "service_role", () => rejected(() => db.query(
       "insert into public.video_upload_batches(owner_user_id,idempotency_key,expires_at) values($1,'rollback-write',now()+interval '1 hour')", [A],
     )));
     const rollbackRpc = await asRole(db, "service_role", () => rejected(() => db.query(
       "select public.video_upload_batch_prepare($1,'rollback-rpc',now()+interval '1 hour')", [A],
     )));
-    assert(rollbackTableWrite && rollbackRpc, "rollback leaves service_role read-only and removes every v77 RPC execute grant");
+    const rollbackPrivileges = (await db.query(`select
+      has_function_privilege('service_role',to_regprocedure('public.video_upload_item_claim(uuid,uuid,integer,uuid,timestamptz)'),'execute') as claim_execute,
+      has_function_privilege('service_role',to_regprocedure('public.video_upload_item_finalize(uuid,uuid,integer,uuid,text,text,bigint,text)'),'execute') as finalize_execute,
+      has_function_privilege('service_role',to_regprocedure('public.video_upload_item_fail(uuid,uuid,integer,uuid,text)'),'execute') as fail_execute`)).rows[0];
+    assert(rollbackTableWrite && rollbackRpc && !rollbackPrivileges.claim_execute && !rollbackPrivileges.finalize_execute && !rollbackPrivileges.fail_execute,
+      "rollback leaves service_role read-only and removes every v77 claim/finalize/fail execute grant");
     const v76Restored = (await db.query("select pg_get_functiondef(to_regprocedure($1)) as definition", [
       "public.publish_asset_settle_item(uuid,text,text,uuid,text,integer,text,text,text,bigint,text)",
     ])).rows[0].definition;
     await db.exec(migration);
     const activePrivileges = await db.query(`select
       has_table_privilege('service_role','public.video_upload_items','select') as service_select,
       has_table_privilege('service_role','public.video_upload_items','insert') as service_insert,
       has_table_privilege('service_role','public.video_upload_items','truncate') as service_truncate,
       has_table_privilege('authenticated','public.video_upload_items','select') as authenticated_select,
-      has_function_privilege('service_role',to_regprocedure('public.video_upload_item_finalize(uuid,uuid,integer,text,bigint,text,integer,integer,bigint)'),'execute') as service_finalize,
-      has_function_privilege('authenticated',to_regprocedure('public.video_upload_item_finalize(uuid,uuid,integer,text,bigint,text,integer,integer,bigint)'),'execute') as authenticated_finalize`);
+      has_function_privilege('service_role',to_regprocedure('public.video_upload_item_claim(uuid,uuid,integer,uuid,timestamptz)'),'execute') as service_claim,
+      has_function_privilege('service_role',to_regprocedure('public.video_upload_item_finalize(uuid,uuid,integer,uuid,text,text,bigint,text)'),'execute') as service_finalize,
+      has_function_privilege('service_role',to_regprocedure('public.video_upload_item_fail(uuid,uuid,integer,uuid,text)'),'execute') as service_fail,
+      has_function_privilege('authenticated',to_regprocedure('public.video_upload_item_claim(uuid,uuid,integer,uuid,timestamptz)'),'execute') as authenticated_claim,
+      has_function_privilege('authenticated',to_regprocedure('public.video_upload_item_finalize(uuid,uuid,integer,uuid,text,text,bigint,text)'),'execute') as authenticated_finalize,
+      has_function_privilege('authenticated',to_regprocedure('public.video_upload_item_fail(uuid,uuid,integer,uuid,text)'),'execute') as authenticated_fail`);
     assert(activePrivileges.rows[0].service_select && activePrivileges.rows[0].service_insert
       && !activePrivileges.rows[0].service_truncate && !activePrivileges.rows[0].authenticated_select
-      && activePrivileges.rows[0].service_finalize && !activePrivileges.rows[0].authenticated_finalize,
+      && activePrivileges.rows[0].service_claim && activePrivileges.rows[0].service_finalize && activePrivileges.rows[0].service_fail
+      && !activePrivileges.rows[0].authenticated_claim && !activePrivileges.rows[0].authenticated_finalize && !activePrivileges.rows[0].authenticated_fail,
     "ordered rollback/reapply restores exactly the active service-only privilege manifest");
     const afterReapply = await db.query(`select jsonb_build_object(
       'batches',(select coalesce(jsonb_agg(to_jsonb(b) order by b.id),'[]'::jsonb) from public.video_upload_batches b),
       'items',(select coalesce(jsonb_agg(to_jsonb(i) order by i.id),'[]'::jsonb) from public.video_upload_items i),
-      'provenance',(select coalesce(jsonb_agg(to_jsonb(p) order by p.object_path),'[]'::jsonb) from public.media_asset_provenance p)
+      'provenance',(select coalesce(jsonb_agg(to_jsonb(p) order by p.object_path),'[]'::jsonb) from public.media_asset_provenance p),
+      'cleanup',(select coalesce(jsonb_agg(to_jsonb(o) order by o.id),'[]'::jsonb) from public.media_cleanup_outbox o)
     ) as state`);
     const v76After = (await db.query("select pg_get_functiondef(to_regprocedure($1)) as definition", [
       "public.publish_asset_settle_item(uuid,text,text,uuid,text,integer,text,text,text,bigint,text)",
     ])).rows[0].definition;
     assert(JSON.stringify(beforeRollback.rows) === JSON.stringify(afterReapply.rows) && v76Restored === v76Before && v76After !== v76Before,
       "rollback exactly restores v76 and reapply preserves complete evidence with the v77 video guard");
   } finally { await db.close(); }
 }
 async function collisionRejections() {
   const cases = [
@@ -367,21 +494,21 @@ async function collisionRejections() {
     {
       name: "authenticated truncate privilege drift",
       alter: db => db.exec("grant truncate on public.video_upload_items to authenticated"),
     },
     {
       name: "authenticated column update privilege drift",
       alter: db => db.exec("grant update(verified_content_type) on public.video_upload_items to authenticated"),
     },
     {
       name: "authenticated upload finalize execute drift",
-      alter: db => db.exec("grant execute on function public.video_upload_item_finalize(uuid,uuid,integer,text,bigint,text,integer,integer,bigint) to authenticated"),
+      alter: db => db.exec("grant execute on function public.video_upload_item_finalize(uuid,uuid,integer,uuid,text,text,bigint,text) to authenticated"),
     },
     {
       name: "service grant option drift",
       alter: db => db.exec("grant select on public.video_upload_items to service_role with grant option"),
     },
   ]) {
     const db = await dbWithV76();
     try {
       await db.exec(migration);
       await scenario.alter(db);
diff --git a/web/scripts/test-video-upload-private.ts b/web/scripts/test-video-upload-private.ts
index ed2735c1..90b355e7 100644
--- a/web/scripts/test-video-upload-private.ts
+++ b/web/scripts/test-video-upload-private.ts
@@ -1,208 +1,418 @@
 import assert from "node:assert/strict";
+import Module from "node:module";

 const OWNER = "00000000-0000-4000-8000-000000000001";
 const OTHER_OWNER = "00000000-0000-4000-8000-000000000002";
 const SHA = "a".repeat(64);
-const MP4_FTYP = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
+const MP4_FTYP = new Uint8Array([
+  0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70,
+  0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0,
+  0x69, 0x73, 0x6f, 0x32,
+]);

 let passed = 0;
 async function test(name: string, fn: () => Promise<void> | void) {
   await fn();
   passed += 1;
   console.log(`  OK ${name}`);
 }

 function request(url: string, body?: unknown, headers: HeadersInit = {}) {
   return new Request(url, { method: "POST", headers: { "content-type": "application/json", "x-request-id": "req_1", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
 }

 function descriptor(ordinal = 0, overrides: Record<string, unknown> = {}) {
-  return { ordinal, idempotencyKey: `item_${ordinal}`, filename: "clip.mp4", contentType: "video/mp4", byteSize: 12, checksumSha256: SHA, width: 1080, height: 1920, durationMs: 5_000, ...overrides };
+  return { ordinal, idempotencyKey: `item_${ordinal}`, filename: "clip.mp4", contentType: "video/mp4", byteSize: MP4_FTYP.byteLength, checksumSha256: SHA, width: 1080, height: 1920, durationMs: 5_000, ...overrides };
 }

 function preparedItem(overrides: Record<string, unknown> = {}) {
-  return { batchId: "11111111-1111-4111-8111-111111111111", ordinal: 0, status: "prepared", privatePath: `${OWNER}/video/a.mp4`, declaredContentType: "video/mp4", declaredByteSize: 12, declaredChecksumSha256: SHA, declaredWidth: 1080, declaredHeight: 1920, declaredDurationMs: 5_000, expiresAt: "2099-01-01T00:00:00.000Z", ...overrides };
+  return { batchId: "11111111-1111-4111-8111-111111111111", ordinal: 0, status: "prepared", privatePath: `${OWNER}/video/a.mp4`, declaredContentType: "video/mp4", declaredByteSize: MP4_FTYP.byteLength, declaredChecksumSha256: SHA, declaredWidth: 1080, declaredHeight: 1920, declaredDurationMs: 5_000, expiresAt: "2099-01-01T00:00:00.000Z", ...overrides };
+}
+
+function storeStub(overrides: Record<string, unknown> = {}) {
+  const item = preparedItem();
+  return {
+    prepareBatch: async () => ({ batchId: item.batchId }),
+    prepareItem: async () => ({ status: "prepared" }),
+    findItem: async () => item,
+    claimItem: async (input: { claimToken: string }) => ({ status: "finalizing", claimToken: input.claimToken }),
+    finalizeItem: async () => ({ status: "finalized", provenanceReady: true }),
+    failItem: async () => ({ status: "failed", cleanupAllowed: true, cleanupScheduled: true }),
+    ...overrides,
+  };
 }

 async function main() {
   const { handleVideoUploadPrepare, handleVideoUploadFinalize } = await import("../src/lib/server/media/videoUploadHandler");
+  const { createVideoUploadStore } = await import("../src/lib/server/media/videoUploadStore");
+  const { createSupabaseVideoStorage } = await import("../src/lib/server/media/supabaseVideoStorage");
   const { handleStorageMediaGet } = await import("../src/lib/server/media/storageMediaHandler");

+  await test("production Storage adapter never promotes uploader-controlled SHA metadata", async () => {
+    const storage = createSupabaseVideoStorage({ supabaseUrl: "https://storage.invalid", serviceRoleKey: "test-key",
+      fetchImpl: async () => new Response(null, { status: 200, headers: { "content-length": "12", "content-type": "video/mp4", "x-amz-meta-sha256": SHA } }) });
+    const stat = await storage.stat({ bucket: "generated-private", path: `${OWNER}/video/a.mp4` });
+    assert.equal("checksumSha256" in stat, false);
+    assert.equal(stat.verifiedChecksumSha256, undefined);
+  });
+
+  await test("production store routes claim, atomic finalize, and failure through owner-scoped v77 RPCs", async () => {
+    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
+    const db = {
+      rpc: async (name: string, args: Record<string, unknown>) => {
+        calls.push({ name, args });
+        if (name === "video_upload_item_claim") return { data: { status: "finalizing", claimToken: args.p_claim_token }, error: null };
+        if (name === "video_upload_item_finalize") return { data: { status: "finalized", provenanceReady: true }, error: null };
+        if (name === "video_upload_item_fail") return { data: { status: "failed", cleanupAllowed: true, cleanupScheduled: true }, error: null };
+        throw new Error(`unexpected RPC ${name}`);
+      },
+      from: () => { throw new Error("direct table write is forbidden for lifecycle transitions"); },
+    };
+    const store = createVideoUploadStore(db);
+    const claimToken = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
+    await store.claimItem({ ownerUserId: OWNER, batchId: preparedItem().batchId, ordinal: 0, claimToken, claimExpiresAt: "2099-01-01T00:00:00.000Z" });
+    await store.finalizeItem({ ownerUserId: OWNER, batchId: preparedItem().batchId, ordinal: 0, claimToken,
+      bucketId: "generated-private", contentType: "video/mp4", byteSize: 12, checksumSha256: null });
+    const failed = await store.failItem({ ownerUserId: OWNER, batchId: preparedItem().batchId, ordinal: 0, claimToken, code: "invalid_video_container" });
+    assert.deepEqual(calls.map(call => call.name), ["video_upload_item_claim", "video_upload_item_finalize", "video_upload_item_fail"]);
+    assert.equal(calls[1].args.p_verified_checksum_sha256, null);
+    assert.equal("p_verified_width" in calls[1].args, false);
+    assert.equal("p_verified_duration_ms" in calls[1].args, false);
+    assert.equal(calls[2].args.p_claim_token, claimToken);
+    assert(calls.every(call => call.args.p_owner_user_id === OWNER), "every lifecycle RPC must carry the verified owner");
+    assert.equal(failed.cleanupScheduled, true);
+  });
+
+  await test("expired or terminal prepare replay never issues another signed capability", async () => {
+    const existing = { ...preparedItem(), status: "failed", expiresAt: "2000-01-01T00:00:00.000Z" };
+    let signed = 0;
+    const response = await handleVideoUploadPrepare(request("https://app.test/prepare", { idempotencyKey: "batch_replay", files: [descriptor()] }), {
+      getUserId: async () => OWNER, enabled: true, configured: true,
+      store: storeStub({ prepareBatch: async () => ({ batchId: existing.batchId }), prepareItem: async () => ({ status: "failed" }), findItem: async () => existing }),
+      createSignedUpload: async () => { signed++; return { token: "must-not-issue", signedUrl: "https://storage.test/must-not-issue" }; },
+    });
+    assert.equal(response.status, 409);
+    assert.equal(signed, 0);
+  });
+
+  await test("prepare ledger covers the fixed two-hour signed-upload capability", async () => {
+    let expiresAt = "";
+    const now = new Date("2030-01-01T00:00:00.000Z");
+    const response = await handleVideoUploadPrepare(request("https://app.test/prepare", { idempotencyKey: "batch_ttl", files: [descriptor()] }), {
+      getUserId: async () => OWNER, enabled: true, configured: true, now: () => now,
+      store: storeStub({ prepareBatch: async (input: { expiresAt: string }) => { expiresAt = input.expiresAt; return { batchId: preparedItem().batchId }; }, findItem: async () => null }),
+      createSignedUpload: async () => ({ token: "token", signedUrl: "https://storage.test/signed" }),
+    });
+    assert.equal(response.status, 200);
+    assert.equal(expiresAt, "2030-01-01T02:00:00.000Z");
+  });
+
+  await test("a losing finalize race cannot delete an object finalized by the winner", async () => {
+    const item = preparedItem();
+    let statCalls = 0; let removed = 0; let claimed = false;
+    const deps = {
+      getUserId: async () => OWNER, enabled: true, configured: true,
+      store: storeStub({
+        findItem: async () => item,
+        claimItem: async (input: { claimToken: string }) => {
+          if (claimed) throw new Error("video_upload_item_claimed");
+          claimed = true;
+          return { status: "finalizing", claimToken: input.claimToken };
+        },
+      }),
+      createSignedUpload: async () => ({ token: "unused", signedUrl: "https://storage.test/unused" }),
+      storage: { stat: async () => { statCalls++; return { exists: true, contentType: "video/mp4", byteSize: MP4_FTYP.byteLength, verifiedChecksumSha256: SHA }; }, readRange: async ({ start, end }: { start: number; end: number }) => new Response(MP4_FTYP.slice(start, end + 1), { status: 206, headers: { "content-range": `bytes ${start}-${end}/${MP4_FTYP.byteLength}`, "content-type": "video/mp4" } }), remove: async () => { removed++; } },
+      recordCleanup: async () => {},
+    };
+    const winner = handleVideoUploadFinalize(request("https://app.test/finalize", { batchId: item.batchId, ordinal: 0 }), deps);
+    const loser = handleVideoUploadFinalize(request("https://app.test/finalize", { batchId: item.batchId, ordinal: 0 }), deps);
+    assert.equal((await winner).status, 200);
+    assert.equal((await loser).status, 409);
+    assert.equal(removed, 0);
+    assert.equal(statCalls, 1);
+  });
+
+  await test("finalized replay fails closed when atomic provenance is incomplete", async () => {
+    const item = { ...preparedItem(), status: "finalized" };
+    const response = await handleVideoUploadFinalize(request("https://app.test/finalize", { batchId: item.batchId, ordinal: 0 }), {
+      getUserId: async () => OWNER, enabled: true, configured: true,
+      store: storeStub({ findItem: async () => item, claimItem: async () => { throw new Error("video_upload_provenance_incomplete"); } }),
+      createSignedUpload: async () => ({ token: "unused", signedUrl: "https://storage.test/unused" }), storage: { stat: async () => { throw new Error("must not stat"); }, readRange: async () => { throw new Error("must not read"); }, remove: async () => {} },
+      recordCleanup: async () => {},
+    });
+    assert.equal(response.status, 503);
+    assert.equal((await response.json() as { code: string }).code, "provenance_unavailable");
+  });
+
   await test("prepare authenticates before parsing, storage, or database side effects", async () => {
     let effects = 0;
     const response = await handleVideoUploadPrepare(new Request("https://app.test/api/studio/video-upload/prepare", { method: "POST", body: "not json" }), {
       getUserId: async () => null, enabled: true, configured: true,
-      store: { prepareBatch: async () => { effects++; throw new Error("unexpected"); }, prepareItem: async () => { effects++; throw new Error("unexpected"); }, findItem: async () => null, finalizeItem: async () => ({ status: "finalized" }), failItem: async () => {} },
+      store: storeStub({ prepareBatch: async () => { effects++; throw new Error("unexpected"); }, prepareItem: async () => { effects++; throw new Error("unexpected"); }, findItem: async () => null }),
       createSignedUpload: async () => { effects++; throw new Error("unexpected"); },
     });
     assert.equal(response.status, 401);
     assert.equal(effects, 0);
     assert.deepEqual(await response.json(), { code: "unauthorized", requestId: "" });
   });

   await test("feature and configuration gates deny prepare before database or Storage work", async () => {
     let effects = 0;
-    const base = { getUserId: async () => OWNER, store: { prepareBatch: async () => { effects++; return { batchId: "unexpected" }; }, prepareItem: async () => ({ status: "prepared" }), findItem: async () => null, finalizeItem: async () => ({ status: "finalized" }), failItem: async () => {} }, createSignedUpload: async () => { effects++; return { token: "unexpected", signedUrl: "https://storage.test/unexpected" }; } };
+    const base = { getUserId: async () => OWNER, store: storeStub({ prepareBatch: async () => { effects++; return { batchId: "unexpected" }; }, findItem: async () => null }), createSignedUpload: async () => { effects++; return { token: "unexpected", signedUrl: "https://storage.test/unexpected" }; } };
     const disabled = await handleVideoUploadPrepare(request("https://app.test/prepare", { bad: "body" }), { ...base, enabled: false, configured: true });
     const unconfigured = await handleVideoUploadPrepare(request("https://app.test/prepare", { bad: "body" }), { ...base, enabled: true, configured: false });
     assert.equal(disabled.status, 404);
     assert.equal(unconfigured.status, 503);
     assert.equal(effects, 0);
   });

   await test("prepare bounds the batch and rejects unsafe facts before issuing capabilities", async () => {
     let signed = 0;
     const deps = {
       getUserId: async () => OWNER, enabled: true, configured: true,
-      store: { prepareBatch: async () => ({ batchId: "11111111-1111-4111-8111-111111111111" }), prepareItem: async () => ({ status: "prepared" }), findItem: async () => null, finalizeItem: async () => ({ status: "finalized" }), failItem: async () => {} },
+      store: storeStub({ prepareBatch: async () => ({ batchId: "11111111-1111-4111-8111-111111111111" }), findItem: async () => null }),
       createSignedUpload: async () => { signed++; return { token: "secret-token", signedUrl: "https://storage.test/secret" }; },
     };
-    for (const files of [[], Array.from({ length: 21 }, (_, ordinal) => descriptor(ordinal)), [descriptor(0, { contentType: "video/webm" })], [descriptor(0, { byteSize: 104857601 })], [descriptor(0), descriptor(0)]]) {
+    for (const files of [[], Array.from({ length: 21 }, (_, ordinal) => descriptor(ordinal)), [descriptor(0, { contentType: "video/webm" })],
+      [descriptor(0, { byteSize: 104857601 })], [descriptor(0, { durationMs: 3_999 })], [descriptor(0, { durationMs: 300_001 })], [descriptor(0), descriptor(0)]]) {
       const response = await handleVideoUploadPrepare(request("https://app.test/prepare", { idempotencyKey: "batch_1", files }), deps);
       assert.equal(response.status, files.length === 21 ? 413 : 400);
       assert.equal((await response.json() as { code: string }).code, files.length === 21 ? "batch_limit_exceeded" : "invalid_video_upload");
     }
     assert.equal(signed, 0);
   });

   await test("prepare creates owner-scoped paths, uses upsert false, and never puts a token in an error", async () => {
     const calls: unknown[] = [];
     const response = await handleVideoUploadPrepare(request("https://app.test/prepare", { idempotencyKey: "batch_1", files: [descriptor()] }), {
       getUserId: async () => OWNER, enabled: true, configured: true,
       pathFactory: (owner, batch, ordinal) => `${owner}/videos/${batch}/${ordinal}.mp4`,
-      store: {
-        prepareBatch: async input => { calls.push(input); return { batchId: "11111111-1111-4111-8111-111111111111" }; },
-        prepareItem: async input => { calls.push(input); return { status: "prepared" }; }, findItem: async () => null, finalizeItem: async () => ({ status: "finalized" }), failItem: async () => {},
-      },
+      store: storeStub({
+        prepareBatch: async (input: unknown) => { calls.push(input); return { batchId: "11111111-1111-4111-8111-111111111111" }; },
+        prepareItem: async (input: unknown) => { calls.push(input); return { status: "prepared" }; }, findItem: async () => null,
+      }),
       createSignedUpload: async input => { calls.push(input); return { token: "signed-token", signedUrl: "https://storage.test/signed" }; },
     });
     assert.equal(response.status, 200);
     const body = await response.json() as { uploads: Array<{ token: string; path: string; upsert: boolean }> };
     assert.equal(body.uploads[0].token, "signed-token");
     assert.equal(body.uploads[0].path, `${OWNER}/videos/11111111-1111-4111-8111-111111111111/0.mp4`);
     assert.deepEqual(calls.at(-1), { bucket: "generated-private", path: body.uploads[0].path, contentType: "video/mp4", upsert: false });
   });

   await test("prepare accepts exactly twenty ordered items but refuses unsafe paths and replay conflicts without leaking capabilities", async () => {
     let signed = 0;
     const base = {
       getUserId: async () => OWNER, enabled: true, configured: true,
-      store: { prepareBatch: async () => ({ batchId: "11111111-1111-4111-8111-111111111111" }), prepareItem: async () => ({ status: "prepared" }), findItem: async () => null, finalizeItem: async () => ({ status: "finalized" }), failItem: async () => {} },
+      store: storeStub({ prepareBatch: async () => ({ batchId: "11111111-1111-4111-8111-111111111111" }), findItem: async () => null }),
       createSignedUpload: async () => { signed++; return { token: "capability-token", signedUrl: "https://storage.test/capability" }; },
     };
     const twenty = await handleVideoUploadPrepare(request("https://app.test/prepare", { idempotencyKey: "batch_twenty", files: Array.from({ length: 20 }, (_, ordinal) => descriptor(ordinal)) }), base);
     assert.equal(twenty.status, 200);
     assert.equal((await twenty.json() as { uploads: unknown[] }).uploads.length, 20);
     const unsafe = await handleVideoUploadPrepare(request("https://app.test/prepare", { idempotencyKey: "batch_unsafe", files: [descriptor()] }), { ...base, pathFactory: () => `${OTHER_OWNER}/escape.mp4` });
     assert.equal(unsafe.status, 503);
     const conflict = await handleVideoUploadPrepare(request("https://app.test/prepare", { idempotencyKey: "batch_conflict", files: [descriptor()] }), { ...base, store: { ...base.store, prepareItem: async () => { throw new Error("provider says token=capability-token"); } } });
     assert.equal(conflict.status, 502);
     assert.doesNotMatch(await conflict.text(), /capability-token|provider/i);
   });

   await test("matching prepare replay reuses the server-owned path while conflicting declared facts stay closed", async () => {
     const existing = preparedItem();
     let preparedPath = "";
     const response = await handleVideoUploadPrepare(request("https://app.test/prepare", { idempotencyKey: "batch_replay", files: [descriptor()] }), {
       getUserId: async () => OWNER, enabled: true, configured: true,
-      store: { prepareBatch: async () => ({ batchId: existing.batchId }), prepareItem: async input => { preparedPath = input.privatePath; return { status: "prepared" }; }, findItem: async () => existing, finalizeItem: async () => ({ status: "finalized" }), failItem: async () => {} },
+      store: storeStub({ prepareBatch: async () => ({ batchId: existing.batchId }), prepareItem: async (input: { privatePath: string }) => { preparedPath = input.privatePath; return { status: "prepared" }; }, findItem: async () => existing }),
       createSignedUpload: async () => ({ token: "fresh-capability", signedUrl: "https://storage.test/fresh" }),
       pathFactory: () => `${OWNER}/should-not-be-used.mp4`,
     });
     assert.equal(response.status, 200);
     assert.equal(preparedPath, existing.privatePath);
     assert.equal((await response.json() as { uploads: Array<{ path: string }> }).uploads[0].path, existing.privatePath);
   });

-  await test("finalize checks only server-loaded facts, validates ftyp, registers exact video provenance, and is idempotent", async () => {
+  await test("prepare maps stable idempotency conflicts without provider leakage", async () => {
+    const response = await handleVideoUploadPrepare(request("https://app.test/prepare", { idempotencyKey: "batch_conflict", files: [descriptor()] }), {
+      getUserId: async () => OWNER, enabled: true, configured: true,
+      store: storeStub({ findItem: async () => null, prepareItem: async () => { throw new Error("video_upload_item_idempotency_conflict"); } }),
+      createSignedUpload: async () => { throw new Error("must not sign"); },
+    });
+    assert.equal(response.status, 409);
+    assert.deepEqual(await response.json(), { code: "video_upload_conflict", requestId: "req_1" });
+  });
+
+  await test("finalize owns an atomic claim before any Storage read", async () => {
+    const item = preparedItem();
+    let claims = 0;
+    const deps = {
+      getUserId: async () => OWNER, enabled: true, configured: true,
+      store: {
+        prepareBatch: async () => ({ batchId: item.batchId }), prepareItem: async () => ({ status: "prepared" }), findItem: async () => item,
+        claimItem: async (input: { claimToken: string }) => { claims++; return { status: "finalizing", claimToken: input.claimToken }; },
+        finalizeItem: async () => ({ status: "finalized", provenanceReady: true }), failItem: async () => ({ status: "failed", cleanupAllowed: true, cleanupScheduled: true }),
+      },
+      createSignedUpload: async () => ({ token: "unused", signedUrl: "https://storage.test/unused" }),
+      storage: {
+        stat: async () => { assert.equal(claims, 1); return { exists: true, contentType: "video/mp4", byteSize: MP4_FTYP.byteLength, verifiedChecksumSha256: SHA }; },
+        readRange: async ({ start, end }: { start: number; end: number }) => new Response(MP4_FTYP.slice(start, end + 1), { status: 206, headers: { "content-range": `bytes ${start}-${end}/${MP4_FTYP.byteLength}`, "content-type": "video/mp4" } }), remove: async () => {},
+      },
+      recordCleanup: async () => {},
+    };
+    const response = await handleVideoUploadFinalize(request("https://app.test/finalize", { batchId: item.batchId, ordinal: 0 }), deps);
+    assert.equal(response.status, 200);
+    assert.equal(claims, 1);
+  });
+
+  await test("finalize passes only server-verified facts to atomic settlement and complete replay skips Storage", async () => {
     let reads = 0;
-    let registered: unknown;
+    let finalizedInput: Record<string, unknown> = {};
+    let replay = false;
     const item = preparedItem();
     const deps = {
       getUserId: async () => OWNER, enabled: true, configured: true,
-      store: { prepareBatch: async () => ({ batchId: item.batchId }), prepareItem: async () => ({ status: "prepared" }), findItem: async () => item, finalizeItem: async () => ({ status: "finalized" }), failItem: async () => {} },
+      store: storeStub({
+        findItem: async () => ({ ...item, status: replay ? "finalized" : "prepared" }),
+        claimItem: async (input: { claimToken: string }) => replay
+          ? { status: "finalized", claimToken: null, provenanceReady: true }
+          : { status: "finalizing", claimToken: input.claimToken },
+        finalizeItem: async (input: Record<string, unknown>) => { finalizedInput = input; return { status: "finalized", provenanceReady: true }; },
+      }),
       createSignedUpload: async () => ({ token: "token", signedUrl: "https://storage.test/token" }),
       storage: {
-        stat: async () => ({ exists: true, contentType: "video/mp4", byteSize: 12, checksumSha256: SHA }),
-        readRange: async () => { reads++; return new Response(MP4_FTYP); },
+        stat: async () => ({ exists: true, contentType: "video/mp4", byteSize: MP4_FTYP.byteLength }),
+        readRange: async ({ start, end }: { start: number; end: number }) => { reads++; return new Response(MP4_FTYP.slice(start, end + 1), { status: 206, headers: { "content-range": `bytes ${start}-${end}/${MP4_FTYP.byteLength}`, "content-type": "video/mp4" } }); },
         remove: async () => {},
       },
-      registerProvenance: async (input: unknown) => { registered = input; return true; }, recordCleanup: async () => {},
+      recordCleanup: async () => {},
     };
     const success = await handleVideoUploadFinalize(request("https://app.test/finalize", { batchId: item.batchId, ordinal: 0 }), deps);
     assert.equal(success.status, 200);
     assert.equal(reads, 1);
-    assert.deepEqual(registered, { owner_user_id: OWNER, bucket_id: "generated-private", object_path: item.privatePath, source_type: "upload", intent_id: null, lifecycle_state: "draft", media_kind: "video", content_type: "video/mp4", byte_size: 12, checksum_sha256: SHA, width: 1080, height: 1920, duration_ms: 5_000 });
+    assert.equal(finalizedInput?.checksumSha256, null, "a browser declaration must not become a verified checksum");
+    assert.equal("width" in (finalizedInput ?? {}), false);
+    assert.equal("height" in (finalizedInput ?? {}), false);
+    assert.equal("durationMs" in (finalizedInput ?? {}), false);

-    const replay = await handleVideoUploadFinalize(request("https://app.test/finalize", { batchId: item.batchId, ordinal: 0 }), { ...deps, store: { ...deps.store, findItem: async () => ({ ...item, status: "finalized" }) } });
-    assert.equal(replay.status, 200);
+    replay = true;
+    const replayResponse = await handleVideoUploadFinalize(request("https://app.test/finalize", { batchId: item.batchId, ordinal: 0 }), deps);
+    assert.equal(replayResponse.status, 200);
     assert.equal(reads, 1, "successful replay must not re-read Storage");
   });

   await test("finalize fails closed and compensates an invalid object through durable cleanup", async () => {
     let removed = 0;
     let cleanup: unknown;
     const item = preparedItem();
     const response = await handleVideoUploadFinalize(request("https://app.test/finalize", { batchId: item.batchId, ordinal: 0 }), {
       getUserId: async () => OWNER, enabled: true, configured: true,
-      store: { prepareBatch: async () => ({ batchId: item.batchId }), prepareItem: async () => ({ status: "prepared" }), findItem: async () => item, finalizeItem: async () => ({ status: "finalized" }), failItem: async () => {} },
+      store: storeStub({ findItem: async () => item }),
       createSignedUpload: async () => ({ token: "token", signedUrl: "https://storage.test/token" }),
-      storage: { stat: async () => ({ exists: true, contentType: "video/mp4", byteSize: 12, checksumSha256: SHA }), readRange: async () => new Response(new Uint8Array([1, 2, 3])), remove: async () => { removed++; throw new Error("storage failure"); } },
-      registerProvenance: async () => true, recordCleanup: async input => { cleanup = input; },
+      storage: { stat: async () => ({ exists: true, contentType: "video/mp4", byteSize: MP4_FTYP.byteLength, verifiedChecksumSha256: SHA }), readRange: async ({ start, end }) => new Response(new Uint8Array(end - start + 1), { status: 206, headers: { "content-range": `bytes ${start}-${end}/${MP4_FTYP.byteLength}`, "content-type": "video/mp4" } }), remove: async () => { removed++; throw new Error("storage failure"); } },
+      recordCleanup: async input => { cleanup = input; },
     });
     assert.equal(response.status, 422);
     assert.equal((await response.json() as { code: string }).code, "invalid_video_container");
     assert.equal(removed, 1);
-    assert.deepEqual(cleanup, { owner_user_id: OWNER, bucket_id: "generated-private", object_path: item.privatePath, reason: "invalid_video_container" });
+    assert.equal(cleanup, undefined, "the atomic fail RPC owns durable delayed cleanup before best-effort delete");
+  });
+
+  await test("finalize never deletes unless the atomic fail transition confirms durable cleanup", async () => {
+    let removed = 0;
+    const item = preparedItem();
+    const response = await handleVideoUploadFinalize(request("https://app.test/finalize", { batchId: item.batchId, ordinal: 0 }), {
+      getUserId: async () => OWNER, enabled: true, configured: true,
+      store: storeStub({ findItem: async () => item, failItem: async () => ({ status: "failed", cleanupAllowed: true, cleanupScheduled: false }) }),
+      createSignedUpload: async () => ({ token: "unused", signedUrl: "https://storage.test/unused" }),
+      storage: { stat: async () => ({ exists: true, contentType: "video/mp4", byteSize: MP4_FTYP.byteLength }), readRange: async () => new Response(new Uint8Array(3)), remove: async () => { removed++; } },
+    });
+    assert.equal(response.status, 503);
+    assert.equal((await response.json() as { code: string }).code, "cleanup_not_scheduled");
+    assert.equal(removed, 0);
+  });
+
+  await test("cleanup scheduling failure cannot be hidden by a delete attempt", async () => {
+    let removed = 0;
+    const item = preparedItem();
+    const response = await handleVideoUploadFinalize(request("https://app.test/finalize", { batchId: item.batchId, ordinal: 0 }), {
+      getUserId: async () => OWNER, enabled: true, configured: true,
+      store: storeStub({ findItem: async () => item, failItem: async () => { throw new Error("video_upload_store_error"); } }),
+      createSignedUpload: async () => ({ token: "unused", signedUrl: "https://storage.test/unused" }),
+      storage: { stat: async () => ({ exists: true, contentType: "video/mp4", byteSize: MP4_FTYP.byteLength }), readRange: async () => new Response(new Uint8Array(3)), remove: async () => { removed++; } },
+    });
+    assert.equal(response.status, 503);
+    assert.equal((await response.json() as { code: string }).code, "video_upload_unavailable");
+    assert.equal(removed, 0, "an unscheduled cleanup must never become a destructive best-effort delete");
   });

   await test("finalize rejects missing, empty, mismatched, expired, and cross-owner objects before ready provenance", async () => {
     const item = preparedItem();
     for (const [name, stat, itemOverride, expected] of [
       ["missing", { exists: false }, {}, 404],
-      ["empty", { exists: true, contentType: "video/mp4", byteSize: 0, checksumSha256: SHA }, {}, 422],
-      ["type", { exists: true, contentType: "video/quicktime", byteSize: 12, checksumSha256: SHA }, {}, 422],
-      ["size", { exists: true, contentType: "video/mp4", byteSize: 13, checksumSha256: SHA }, {}, 422],
-      ["expired", { exists: true, contentType: "video/mp4", byteSize: 12, checksumSha256: SHA }, { expiresAt: "2000-01-01T00:00:00.000Z" }, 422],
+      ["empty", { exists: true, contentType: "video/mp4", byteSize: 0, verifiedChecksumSha256: SHA }, {}, 422],
+      ["type", { exists: true, contentType: "video/quicktime", byteSize: MP4_FTYP.byteLength, verifiedChecksumSha256: SHA }, {}, 422],
+      ["size", { exists: true, contentType: "video/mp4", byteSize: MP4_FTYP.byteLength + 1, verifiedChecksumSha256: SHA }, {}, 422],
+      ["expired", { exists: true, contentType: "video/mp4", byteSize: MP4_FTYP.byteLength, verifiedChecksumSha256: SHA }, { expiresAt: "2000-01-01T00:00:00.000Z" }, 422],
     ] as const) {
-      let registered = 0; let reads = 0;
+      let finalized = 0; let reads = 0;
       const result = await handleVideoUploadFinalize(request("https://app.test/finalize", { batchId: item.batchId, ordinal: 0 }), {
         getUserId: async () => OWNER, enabled: true, configured: true,
-        store: { prepareBatch: async () => ({ batchId: item.batchId }), prepareItem: async () => ({ status: "prepared" }), findItem: async () => ({ ...item, ...itemOverride }), finalizeItem: async () => ({ status: "finalized" }), failItem: async () => {} },
+        store: storeStub({ findItem: async () => ({ ...item, ...itemOverride }), finalizeItem: async () => { finalized++; return { status: "finalized", provenanceReady: true }; } }),
         createSignedUpload: async () => ({ token: "token", signedUrl: "https://storage.test/token" }),
-        storage: { stat: async () => stat, readRange: async () => { reads++; return new Response(MP4_FTYP); }, remove: async () => {} }, registerProvenance: async () => { registered++; return true; },
+        storage: { stat: async () => stat, readRange: async ({ start, end }) => { reads++; return new Response(MP4_FTYP.slice(start, end + 1), { status: 206, headers: { "content-range": `bytes ${start}-${end}/${MP4_FTYP.byteLength}`, "content-type": "video/mp4" } }); }, remove: async () => {} },
       });
       assert.equal(result.status, expected, name);
-      assert.equal(registered, 0, `${name} must not register ready provenance`);
+      assert.equal(finalized, 0, `${name} must not atomically register ready provenance`);
       if (name !== "expired") assert.equal(reads, 0, `${name} must fail before ftyp`);
     }
     const crossOwner = await handleVideoUploadFinalize(request("https://app.test/finalize", { batchId: item.batchId, ordinal: 0 }), {
       getUserId: async () => OTHER_OWNER, enabled: true, configured: true,
-      store: { prepareBatch: async () => ({ batchId: item.batchId }), prepareItem: async () => ({ status: "prepared" }), findItem: async () => null, finalizeItem: async () => ({ status: "finalized" }), failItem: async () => {} }, createSignedUpload: async () => ({ token: "token", signedUrl: "https://storage.test/token" }),
-      storage: { stat: async () => { throw new Error("must not stat"); }, readRange: async () => { throw new Error("must not read"); }, remove: async () => {} }, registerProvenance: async () => true,
+      store: storeStub({ findItem: async () => null }), createSignedUpload: async () => ({ token: "token", signedUrl: "https://storage.test/token" }),
+      storage: { stat: async () => { throw new Error("must not stat"); }, readRange: async () => { throw new Error("must not read"); }, remove: async () => {} },
     });
     assert.equal(crossOwner.status, 404);
   });

+  await test("finalize validates the real initial range and a complete allowed ftyp box", async () => {
+    const item = preparedItem();
+    const cases: Array<[string, () => Response]> = [
+      ["upstream 500", () => new Response(MP4_FTYP, { status: 500 })],
+      ["wrong range", () => new Response(MP4_FTYP, { status: 206, headers: { "content-range": `bytes 1-${MP4_FTYP.byteLength}/${MP4_FTYP.byteLength}`, "content-type": "video/mp4" } })],
+      ["truncated box", () => new Response(MP4_FTYP.slice(0, 15), { status: 206, headers: { "content-range": `bytes 0-14/${MP4_FTYP.byteLength}`, "content-type": "video/mp4" } })],
+      ["fake magic", () => new Response(new Uint8Array([0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, ...new Uint8Array(8)]), { status: 206, headers: { "content-range": `bytes 0-19/${MP4_FTYP.byteLength}`, "content-type": "video/mp4" } })],
+      ["disallowed brand", () => new Response(new Uint8Array([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x62, 0x61, 0x64, 0x21, 0, 0, 0, 0, 0x62, 0x61, 0x64, 0x21]), { status: 206, headers: { "content-range": `bytes 0-19/${MP4_FTYP.byteLength}`, "content-type": "video/mp4" } })],
+    ];
+    for (const [name, responseFactory] of cases) {
+      let finalized = 0;
+      const response = await handleVideoUploadFinalize(request("https://app.test/finalize", { batchId: item.batchId, ordinal: 0 }), {
+        getUserId: async () => OWNER, enabled: true, configured: true,
+        store: storeStub({ findItem: async () => item, finalizeItem: async () => { finalized++; return { status: "finalized", provenanceReady: true }; } }),
+        createSignedUpload: async () => ({ token: "unused", signedUrl: "https://storage.test/unused" }),
+        storage: { stat: async () => ({ exists: true, contentType: "video/mp4", byteSize: MP4_FTYP.byteLength }), readRange: async () => responseFactory(), remove: async () => {} },
+      });
+      assert.equal(response.status, name === "upstream 500" || name === "wrong range" || name === "truncated box" ? 503 : 422, name);
+      assert.equal(finalized, 0, `${name} must not finalize`);
+    }
+  });
+
   await test("video proxy enforces exact ready provenance and serves a single bounded range without provider leakage", async () => {
     let fetches = 0;
     const path = `${OWNER}/videos/a.mp4`;
     const response = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`, { headers: { range: "bytes=4-7" } }), {
       getUserId: async () => OWNER, configured: true,
       findProvenance: async () => ({ owner_user_id: OWNER, bucket_id: "generated-private", object_path: path, source_type: "upload", intent_id: null, lifecycle_state: "draft", media_kind: "video", content_type: "video/mp4", byte_size: 12 }),
-      readRange: async input => { fetches++; assert.deepEqual(input, { bucket: "generated-private", path, start: 4, end: 7 }); return new Response(new Uint8Array([0x66, 0x74, 0x79, 0x70])); },
+      readRange: async input => { fetches++; assert.deepEqual(input, { bucket: "generated-private", path, start: 4, end: 7 }); return new Response(new Uint8Array([0x66, 0x74, 0x79, 0x70]), { status: 206, headers: { "content-range": "bytes 4-7/12", "content-type": "video/mp4" } }); },
     });
     assert.equal(response.status, 206);
     assert.equal(response.headers.get("content-range"), "bytes 4-7/12");
     assert.equal(response.headers.get("content-length"), "4");
-    assert.equal(response.headers.get("vary"), "Authorization, Range");
+    assert.equal(response.headers.get("vary"), "Cookie, Authorization, Range");
     assert.equal(await response.text(), "ftyp");
     assert.equal(fetches, 1);

     const denied = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`), {
       getUserId: async () => OTHER_OWNER, configured: true,
       findProvenance: async () => null,
       readRange: async () => { throw new Error("must not read"); },
     });
     assert.equal(denied.status, 403);
   });
@@ -214,30 +424,105 @@ async function main() {
     assert.equal(multi.status, 416);
     const failed = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`), deps);
     assert.equal(failed.status, 502);
     assert.doesNotMatch(await failed.text(), /storage|secret|token/i);
   });

   await test("video proxy supports full, open, and suffix ranges, blocks unsafe lifecycle, and bounds an oversized upstream body", async () => {
     const path = `${OWNER}/videos/a.mp4`;
     const provenance = { owner_user_id: OWNER, bucket_id: "generated-private", object_path: path, source_type: "upload", intent_id: null, lifecycle_state: "draft", media_kind: "video", content_type: "video/mp4", byte_size: 12 };
     const calls: Array<{ start: number; end: number }> = [];
-    const deps = { getUserId: async () => OWNER, configured: true, findProvenance: async () => provenance, readRange: async ({ start, end }: { start: number; end: number }) => { calls.push({ start, end }); return new Response(new Uint8Array(end - start + 1)); } };
+    const deps = { getUserId: async () => OWNER, configured: true, findProvenance: async () => provenance, readRange: async ({ start, end }: { start: number; end: number }) => { calls.push({ start, end }); return new Response(new Uint8Array(end - start + 1), { status: 206, headers: { "content-range": `bytes ${start}-${end}/12`, "content-type": "video/mp4" } }); } };
     const full = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`), deps);
     assert.equal(full.status, 200);
     const open = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`, { headers: { range: "bytes=8-" } }), deps);
     assert.equal(open.status, 206);
     const suffix = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`, { headers: { range: "bytes=-3" } }), deps);
     assert.equal(suffix.status, 206);
     assert.deepEqual(calls, [{ start: 0, end: 11 }, { start: 8, end: 11 }, { start: 9, end: 11 }]);
     const lifecycle = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`), { ...deps, findProvenance: async () => ({ ...provenance, lifecycle_state: "failed" }) });
     assert.equal(lifecycle.status, 403);
     const unknownLifecycle = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`), { ...deps, findProvenance: async () => ({ ...provenance, lifecycle_state: "finalizing" }) });
     assert.equal(unknownLifecycle.status, 403, "only explicitly allowed video lifecycle states may be proxied");
-    const bounded = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`, { headers: { range: "bytes=0-3" } }), { ...deps, readRange: async () => new Response(new Uint8Array(9)) });
+    const bounded = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`, { headers: { range: "bytes=0-3" } }), { ...deps, readRange: async () => new Response(new Uint8Array(9), { status: 206, headers: { "content-range": "bytes 0-3/12", "content-type": "video/mp4" } }) });
     await assert.rejects(() => bounded.arrayBuffer(), /range body exceeded/i, "the proxy must not expose bytes beyond the selected range");
   });

+  await test("video proxy rejects upstream status, MIME, range, total, and short-body lies", async () => {
+    const path = `${OWNER}/videos/a.mp4`;
+    const provenance = { owner_user_id: OWNER, bucket_id: "generated-private", object_path: path, source_type: "upload", intent_id: null, lifecycle_state: "draft", media_kind: "video", content_type: "video/mp4", byte_size: 12 };
+    const base = { getUserId: async () => OWNER, configured: true, findProvenance: async () => provenance };
+    for (const [name, upstream] of [
+      ["status", new Response(new Uint8Array(4), { status: 200, headers: { "content-type": "video/mp4" } })],
+      ["mime", new Response(new Uint8Array(4), { status: 206, headers: { "content-range": "bytes 4-7/12", "content-type": "text/plain" } })],
+      ["range", new Response(new Uint8Array(4), { status: 206, headers: { "content-range": "bytes 0-3/12", "content-type": "video/mp4" } })],
+      ["total", new Response(new Uint8Array(4), { status: 206, headers: { "content-range": "bytes 4-7/99", "content-type": "video/mp4" } })],
+    ] as const) {
+      const response = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`, { headers: { range: "bytes=4-7" } }), { ...base, readRange: async () => upstream });
+      assert.equal(response.status, 502, name);
+    }
+    const short = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`, { headers: { range: "bytes=4-7" } }), { ...base,
+      readRange: async () => new Response(new Uint8Array(3), { status: 206, headers: { "content-range": "bytes 4-7/12", "content-type": "video/mp4" } }) });
+    assert.equal(short.status, 206);
+    await assert.rejects(() => short.arrayBuffer(), /range body incomplete/i);
+
+    const full200 = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`), { ...base,
+      readRange: async () => new Response(new Uint8Array(12), { status: 200, headers: { "content-length": "12", "content-type": "video/mp4" } }) });
+    assert.equal(full200.status, 200, "an exact full-object 200 is allowed only for a no-Range request");
+  });
+
+  await test("production storage-media route wires verified bearer-or-cookie auth", async () => {
+    let captured: Record<string, unknown> | null = null;
+    const verified = async () => OWNER;
+    const originalLoad = (Module as unknown as { _load: (...args: unknown[]) => unknown })._load;
+    (Module as unknown as { _load: (...args: unknown[]) => unknown })._load = function(this: unknown, request: string, parent: unknown, isMain: boolean) {
+      if (request.includes("server/authUser")) return { getUserIdFromBearer: async () => null, getUserIdFromBearerOrCookies: verified };
+      if (request.includes("media/storageMediaHandler")) return { handleStorageMediaGet: async (_req: Request, deps: Record<string, unknown>) => { captured = deps; return new Response("wired"); } };
+      if (request.includes("server/mediaProvenance")) return { createMediaProvenanceStore: () => ({ findExact: async () => null }) };
+      if (request.includes("media/supabaseVideoStorage")) return { createSupabaseVideoStorage: () => ({ readRange: async () => new Response() }) };
+      if (request.includes("media/videoUploadHandler")) return { VIDEO_UPLOAD_BUCKET: "generated-private" };
+      return originalLoad.call(this, request, parent, isMain);
+    } as never;
+    try {
+      const route = await import("../src/app/api/storage-media/route");
+      const response = await route.GET(new Request("https://app.test/api/storage-media?path=x"));
+      assert.equal(await response.text(), "wired");
+      assert.equal((captured as Record<string, unknown> | null)?.["getUserId"], verified);
+    } finally {
+      (Module as unknown as { _load: (...args: unknown[]) => unknown })._load = originalLoad;
+    }
+  });
+
+  await test("production browser client preserves private bucket, token, path, and upsert=false", async () => {
+    const calls: unknown[] = [];
+    const fakeClient = {
+      auth: { getSession: async () => ({ data: { session: { access_token: "access-token" } } }) },
+      storage: { from: (bucket: string) => ({ uploadToSignedUrl: async (path: string, token: string, file: File, options: unknown) => {
+        calls.push({ bucket, path, token, file, options }); return { error: null };
+      } }) },
+    };
+    const originalLoad = (Module as unknown as { _load: (...args: unknown[]) => unknown })._load;
+    (Module as unknown as { _load: (...args: unknown[]) => unknown })._load = function(this: unknown, request: string, parent: unknown, isMain: boolean) {
+      if (request === "@supabase/ssr") return { createBrowserClient: () => fakeClient };
+      return originalLoad.call(this, request, parent, isMain);
+    } as never;
+    try {
+      const { uploadVideoToSignedStorage } = await import("../src/lib/studio/videoDirectUpload");
+      const file = new File([MP4_FTYP], "clip.mp4", { type: "video/mp4" });
+      await uploadVideoToSignedStorage({ ordinal: 0, path: `${OWNER}/videos/a.mp4`, token: "signed-token", signedUrl: "https://storage.test/signed", contentType: "video/mp4", upsert: false }, file);
+      assert.deepEqual(calls, [{ bucket: "generated-private", path: `${OWNER}/videos/a.mp4`, token: "signed-token", file, options: { contentType: "video/mp4", upsert: false } }]);
+    } finally {
+      (Module as unknown as { _load: (...args: unknown[]) => unknown })._load = originalLoad;
+    }
+  });
+
+  await test("browser SHA-256 is incremental and does not allocate the entire video", async () => {
+    const { sha256 } = await import("../src/lib/studio/videoDirectUpload");
+    const source = new Blob([new TextEncoder().encode("abc")]);
+    Object.defineProperty(source, "arrayBuffer", { value: () => { throw new Error("whole-file allocation forbidden"); } });
+    assert.equal(await sha256(source), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
+  });
+
   console.log(`\nPrivate video upload: ${passed} passed, 0 failed`);
 }

 main().catch(error => { console.error(error); process.exitCode = 1; });
diff --git a/web/src/app/api/storage-media/route.ts b/web/src/app/api/storage-media/route.ts
index db767778..5c1ebcc5 100644
--- a/web/src/app/api/storage-media/route.ts
+++ b/web/src/app/api/storage-media/route.ts
@@ -1,20 +1,20 @@
-import { getUserIdFromBearer } from "@/lib/server/authUser";
+import { getUserIdFromBearerOrCookies } from "@/lib/server/authUser";
 import { createMediaProvenanceStore } from "@/lib/server/mediaProvenance";
 import { createSupabaseVideoStorage } from "@/lib/server/media/supabaseVideoStorage";
 import { handleStorageMediaGet } from "@/lib/server/media/storageMediaHandler";
 import { VIDEO_UPLOAD_BUCKET } from "@/lib/server/media/videoUploadHandler";

 export const runtime = "nodejs";
 export const dynamic = "force-dynamic";

 export async function GET(req: Request) {
   const bucket = process.env.VIBEPIN_DRAFT_BUCKET ?? VIDEO_UPLOAD_BUCKET;
   const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
   const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
   const storage = createSupabaseVideoStorage({ supabaseUrl: url, serviceRoleKey: key });
   return handleStorageMediaGet(req, {
-    getUserId: getUserIdFromBearer, configured: Boolean(url && key), bucket,
+    getUserId: getUserIdFromBearerOrCookies, configured: Boolean(url && key), bucket,
     findProvenance: (owner, activeBucket, path) => createMediaProvenanceStore().findExact(owner, activeBucket, path),
     readRange: storage.readRange,
   });
 }
diff --git a/web/src/app/api/studio/video-upload/finalize/route.ts b/web/src/app/api/studio/video-upload/finalize/route.ts
index 90c969f4..f8c98847 100644
--- a/web/src/app/api/studio/video-upload/finalize/route.ts
+++ b/web/src/app/api/studio/video-upload/finalize/route.ts
@@ -12,14 +12,13 @@ export async function POST(req: Request) {
   let db: ReturnType<typeof createServerClient> | null = null;
   const client = () => (db ??= createServerClient());
   const bucket = process.env.VIBEPIN_DRAFT_BUCKET ?? VIDEO_UPLOAD_BUCKET;
   const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
   const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
   return handleVideoUploadFinalize(req, {
     getUserId: getUserIdFromBearer, enabled: process.env.VIDEO_PIN_UPLOAD_ENABLED === "true", configured: Boolean(url && key), bucket,
     store: createVideoUploadStore(client()),
     createSignedUpload: async () => { throw new Error("unused"); },
     storage: createSupabaseVideoStorage({ supabaseUrl: url, serviceRoleKey: key }),
-    registerProvenance: input => createMediaProvenanceStore(client()).register(input),
     recordCleanup: input => createMediaProvenanceStore(client()).recordCleanup(input),
   });
 }
diff --git a/web/src/app/api/studio/video-upload/prepare/route.ts b/web/src/app/api/studio/video-upload/prepare/route.ts
index 08ea2e5f..588e3aae 100644
--- a/web/src/app/api/studio/video-upload/prepare/route.ts
+++ b/web/src/app/api/studio/video-upload/prepare/route.ts
@@ -1,12 +1,11 @@
 import { getUserIdFromBearer } from "@/lib/server/authUser";
-import { createMediaProvenanceStore } from "@/lib/server/mediaProvenance";
 import { handleVideoUploadPrepare, VIDEO_UPLOAD_BUCKET } from "@/lib/server/media/videoUploadHandler";
 import { createVideoUploadStore } from "@/lib/server/media/videoUploadStore";
 import { createServerClient } from "@/lib/supabase";

 export const runtime = "nodejs";
 export const dynamic = "force-dynamic";

 export async function POST(req: Request) {
   let db: ReturnType<typeof createServerClient> | null = null;
   const client = () => (db ??= createServerClient());
@@ -14,15 +13,12 @@ export async function POST(req: Request) {
   return handleVideoUploadPrepare(req, {
     getUserId: getUserIdFromBearer,
     enabled: process.env.VIDEO_PIN_UPLOAD_ENABLED === "true",
     configured: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY), bucket,
     store: createVideoUploadStore(client()),
     createSignedUpload: async ({ path, contentType, upsert }) => {
       const { data, error } = await client().storage.from(bucket).createSignedUploadUrl(path, { upsert });
       if (error || !data?.token || !data.signedUrl) throw new Error("signed_upload_unavailable");
       return { token: data.token, signedUrl: data.signedUrl };
     },
-    // Kept here only to make the service dependency explicit for the route's
-    // compile-time wiring; prepare itself has no provenance write.
-    registerProvenance: input => createMediaProvenanceStore(client()).register(input),
   });
 }
diff --git a/web/src/lib/server/media/storageMediaHandler.ts b/web/src/lib/server/media/storageMediaHandler.ts
index 5f101fee..d621802a 100644
--- a/web/src/lib/server/media/storageMediaHandler.ts
+++ b/web/src/lib/server/media/storageMediaHandler.ts
@@ -5,58 +5,76 @@ export type StorageMediaDeps = {
   getUserId(req: Request): Promise<string | null>; configured: boolean; bucket?: string;
   findProvenance(ownerUserId: string, bucket: string, path: string): Promise<MediaProvenance | null>;
   readRange(input: { bucket: string; path: string; start: number; end: number }): Promise<Response>;
 };
 const ALLOWED_VIDEO_LIFECYCLES = new Set(["draft", "publish_pending", "published", "retained"]);

 function pathStatus(owner: string, path: string | null): 0 | 400 | 403 {
   if (!path || path.startsWith("/") || path.includes("\\") || path.includes("..") || path.includes("//")) return 400;
   return path.split("/")[0] === owner ? 0 : 403;
 }
-function empty(status: number) { return new Response(null, { status }); }
+const PRIVATE_VARY = "Cookie, Authorization, Range";
+function empty(status: number, headers: HeadersInit = {}) { return new Response(null, { status, headers: { Vary: PRIVATE_VARY, ...headers } }); }
 function range(value: string | null, size: number): { start: number; end: number; partial: boolean } | null {
   if (!value) return { start: 0, end: size - 1, partial: false };
   if (value.includes(",") || !value.startsWith("bytes=")) return null;
   const match = /^bytes=(\d*)-(\d*)$/.exec(value); if (!match || (!match[1] && !match[2])) return null;
   let start: number; let end: number;
   if (!match[1]) { const suffix = Number(match[2]); if (!Number.isSafeInteger(suffix) || suffix < 1) return null; start = Math.max(0, size - suffix); end = size - 1; }
   else { start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1; if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return null; end = Math.min(end, size - 1); }
   return { start, end, partial: true };
 }

 /** Reject a misbehaving upstream rather than streaming bytes past the authorized range. */
-function boundedRangeBody(body: ReadableStream<Uint8Array>, maximum: number): ReadableStream<Uint8Array> {
+function boundedRangeBody(body: ReadableStream<Uint8Array>, expected: number): ReadableStream<Uint8Array> {
   let received = 0;
   return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
     transform(chunk, controller) {
       received += chunk.byteLength;
-      if (received > maximum) {
+      if (received > expected) {
         controller.error(new Error("range body exceeded"));
         return;
       }
       controller.enqueue(chunk);
     },
+    flush(controller) {
+      if (received !== expected) controller.error(new Error("range body incomplete"));
+    },
   }));
 }

+function normalizedType(value: string | null) { return value?.split(";", 1)[0]?.trim().toLowerCase() ?? ""; }
+function contentRange(value: string | null) {
+  const match = value && /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value);
+  if (!match) return null;
+  const parsed = match.slice(1).map(Number);
+  return parsed.every(Number.isSafeInteger) ? { start: parsed[0], end: parsed[1], total: parsed[2] } : null;
+}
+
 export async function handleStorageMediaGet(req: Request, deps: StorageMediaDeps): Promise<Response> {
   const owner = await deps.getUserId(req).catch(() => null); if (!owner) return empty(401);
   if (!deps.configured) return empty(404);
   const url = new URL(req.url); if (url.searchParams.getAll("path").length !== 1 || [...url.searchParams.keys()].some(key => key !== "path")) return empty(400);
   const path = url.searchParams.get("path"); const unsafe = pathStatus(owner, path); if (unsafe) return empty(unsafe);
   const bucket = deps.bucket ?? VIDEO_UPLOAD_BUCKET;
   const provenance = await deps.findProvenance(owner, bucket, path!).catch(() => null);
   if (!provenance || provenance.owner_user_id !== owner || provenance.bucket_id !== bucket || provenance.object_path !== path || provenance.media_kind !== "video" || !ALLOWED_VIDEO_LIFECYCLES.has(provenance.lifecycle_state) || !ALLOWED_VIDEO_TYPES.has(provenance.content_type ?? "") || !Number.isSafeInteger(provenance.byte_size) || provenance.byte_size! < 1 || provenance.byte_size! > MAX_VIDEO_UPLOAD_BYTES) return empty(403);
-  const requested = range(req.headers.get("range"), provenance.byte_size!); if (!requested) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${provenance.byte_size}` } });
+  const requested = range(req.headers.get("range"), provenance.byte_size!); if (!requested) return empty(416, { "Content-Range": `bytes */${provenance.byte_size}` });
   try {
     const upstream = await deps.readRange({ bucket, path: path!, start: requested.start, end: requested.end });
     const expected = requested.end - requested.start + 1;
     const contentLength = upstream.headers.get("content-length");
     const length = contentLength === null ? null : Number(contentLength);
-    if (!upstream.ok || !upstream.body || (length !== null && (!Number.isSafeInteger(length) || length !== expected))) { await upstream.body?.cancel(); return empty(502); }
+    const upstreamType = normalizedType(upstream.headers.get("content-type"));
+    const upstreamRange = contentRange(upstream.headers.get("content-range"));
+    const exactPartial = upstream.status === 206 && upstreamRange?.start === requested.start
+      && upstreamRange.end === requested.end && upstreamRange.total === provenance.byte_size;
+    const exactFull200 = !requested.partial && upstream.status === 200 && !upstreamRange && length === expected;
+    if (!upstream.body || upstreamType !== provenance.content_type || (!exactPartial && !exactFull200)
+      || (length !== null && (!Number.isSafeInteger(length) || length !== expected))) { await upstream.body?.cancel(); return empty(502); }
     return new Response(boundedRangeBody(upstream.body, expected), { status: requested.partial ? 206 : 200, headers: {
       "Content-Type": provenance.content_type!, "Content-Length": String(expected),
       ...(requested.partial ? { "Content-Range": `bytes ${requested.start}-${requested.end}/${provenance.byte_size}` } : {}),
-      "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=300", Vary: "Authorization, Range", "X-Content-Type-Options": "nosniff",
+      "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=300", Vary: PRIVATE_VARY, "X-Content-Type-Options": "nosniff",
     } });
   } catch { return empty(502); }
 }
diff --git a/web/src/lib/server/media/supabaseVideoStorage.ts b/web/src/lib/server/media/supabaseVideoStorage.ts
index 5f56ee6d..37b3e394 100644
--- a/web/src/lib/server/media/supabaseVideoStorage.ts
+++ b/web/src/lib/server/media/supabaseVideoStorage.ts
@@ -8,25 +8,23 @@ function objectUrl(base: string, bucket: string, path: string) {
 export function createSupabaseVideoStorage(input: { supabaseUrl: string; serviceRoleKey: string; fetchImpl?: typeof fetch }): VideoObjectStorage {
   const fetchImpl = input.fetchImpl ?? fetch;
   const headers = { Authorization: `Bearer ${input.serviceRoleKey}`, apikey: input.serviceRoleKey };
   return {
     async stat({ bucket, path }) {
       const response = await fetchImpl(objectUrl(input.supabaseUrl, bucket, path), { method: "HEAD", headers });
       if (response.status === 404) return { exists: false };
       if (!response.ok) throw new Error("storage_stat_failed");
       const size = Number(response.headers.get("content-length"));
       const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
-      // Supabase-compatible object stores may expose an authoritative SHA-256
-      // as object metadata. When unavailable the v77 declared checksum is retained
-      // as an explicitly declared fact; bytes are never buffered to hash them here.
-      const checksumSha256 = response.headers.get("x-amz-meta-sha256") ?? undefined;
-      return { exists: true, contentType, byteSize: Number.isSafeInteger(size) ? size : undefined, checksumSha256 };
+      // x-amz-meta-* is uploader-controlled metadata, not a Storage-computed
+      // digest. This adapter intentionally exposes no verified checksum.
+      return { exists: true, contentType, byteSize: Number.isSafeInteger(size) ? size : undefined };
     },
     readRange({ bucket, path, start, end }) {
       return fetchImpl(objectUrl(input.supabaseUrl, bucket, path), { headers: { ...headers, Range: `bytes=${start}-${end}` } });
     },
     async remove({ bucket, path }) {
       const response = await fetchImpl(`${input.supabaseUrl.replace(/\/$/, "")}/storage/v1/object/${encodeURIComponent(bucket)}`, {
         method: "DELETE", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ prefixes: [path] }),
       });
       if (!response.ok) throw new Error("storage_remove_failed");
     },
diff --git a/web/src/lib/server/media/videoUploadHandler.ts b/web/src/lib/server/media/videoUploadHandler.ts
index 9b35a5b9..e7d4ee81 100644
--- a/web/src/lib/server/media/videoUploadHandler.ts
+++ b/web/src/lib/server/media/videoUploadHandler.ts
@@ -1,45 +1,51 @@
-import type { MediaProvenance } from "@/lib/server/mediaProvenance";
+import {
+  MAX_VIDEO_DURATION_MS,
+  MAX_VIDEO_UPLOAD_BYTES,
+  MAX_VIDEO_UPLOAD_ITEMS,
+  MIN_VIDEO_DURATION_MS,
+  VIDEO_FINALIZE_CLAIM_MS,
+  VIDEO_SIGNED_UPLOAD_CAPABILITY_MS,
+} from "@/lib/videoUploadLimits";

 export const VIDEO_UPLOAD_BUCKET = "generated-private";
-export const MAX_VIDEO_UPLOAD_BYTES = 100 * 1024 * 1024;
-export const MAX_VIDEO_UPLOAD_ITEMS = 20;
+export { MAX_VIDEO_UPLOAD_BYTES, MAX_VIDEO_UPLOAD_ITEMS, MIN_VIDEO_DURATION_MS, MAX_VIDEO_DURATION_MS };
 export const ALLOWED_VIDEO_TYPES = new Set(["video/mp4", "video/x-m4v", "video/quicktime"]);

 type PreparedItem = {
   batchId: string; ordinal: number; status: string; privatePath: string;
   declaredContentType: string; declaredByteSize: number; declaredChecksumSha256: string;
   declaredWidth: number; declaredHeight: number; declaredDurationMs: number; expiresAt: string;
 };

 export type VideoUploadStore = {
   prepareBatch(input: { ownerUserId: string; idempotencyKey: string; expiresAt: string }): Promise<{ batchId: string }>;
   prepareItem(input: { ownerUserId: string; batchId: string; ordinal: number; idempotencyKey: string; privatePath: string; contentType: string; byteSize: number; checksumSha256: string; width: number; height: number; durationMs: number }): Promise<{ status: string }>;
   findItem(ownerUserId: string, batchId: string, ordinal: number): Promise<PreparedItem | null>;
-  finalizeItem(input: { ownerUserId: string; batchId: string; ordinal: number; contentType: string; byteSize: number; checksumSha256: string; width: number; height: number; durationMs: number }): Promise<{ status: string }>;
-  failItem(input: { ownerUserId: string; batchId: string; ordinal: number; code: string }): Promise<void>;
+  claimItem(input: { ownerUserId: string; batchId: string; ordinal: number; claimToken: string; claimExpiresAt: string }): Promise<{ status: string; claimToken?: string | null; provenanceReady?: boolean }>;
+  finalizeItem(input: { ownerUserId: string; batchId: string; ordinal: number; claimToken: string; bucketId: string; contentType: string; byteSize: number; checksumSha256: string | null }): Promise<{ status: string; provenanceReady: boolean }>;
+  failItem(input: { ownerUserId: string; batchId: string; ordinal: number; claimToken: string; code: string }): Promise<{ status: string; cleanupAllowed: boolean; cleanupScheduled: boolean }>;
 };

 export type VideoObjectStorage = {
-  stat(input: { bucket: string; path: string }): Promise<{ exists: boolean; contentType?: string; byteSize?: number; checksumSha256?: string }>;
+  stat(input: { bucket: string; path: string }): Promise<{ exists: boolean; contentType?: string; byteSize?: number; verifiedChecksumSha256?: string }>;
   readRange(input: { bucket: string; path: string; start: number; end: number }): Promise<Response>;
   remove(input: { bucket: string; path: string }): Promise<void>;
 };

 export type VideoUploadHandlerDeps = {
   getUserId(req: Request): Promise<string | null>;
   enabled: boolean; configured: boolean; bucket?: string; expiresInMs?: number; now?: () => Date;
   store: VideoUploadStore;
   createSignedUpload(input: { bucket: string; path: string; contentType: string; upsert: false }): Promise<{ token: string; signedUrl: string }>;
   pathFactory?: (ownerUserId: string, batchId: string, ordinal: number, contentType: string) => string;
   storage?: VideoObjectStorage;
-  registerProvenance?: (input: Omit<MediaProvenance, "bucket_id"> & { bucket_id: string }) => Promise<boolean>;
   recordCleanup?: (input: { owner_user_id: string; bucket_id: string; object_path: string; reason: string }) => Promise<void>;
 };

 type Descriptor = { ordinal: number; idempotencyKey: string; filename: string; contentType: string; byteSize: number; checksumSha256: string; width: number; height: number; durationMs: number };
 const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
 const SAFE_NAME = /^[^/\\\0-\x1f]{1,255}$/;

 function requestId(req: Request) { return (req.headers.get("x-request-id") ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 128); }
 function error(code: string, requestId: string, status: number) { return Response.json({ code, requestId }, { status }); }
 function ownerPath(owner: string, path: string) {
@@ -51,21 +57,22 @@ function defaultPath(owner: string, batch: string, ordinal: number, type: string
 function descriptorFrom(value: unknown): Descriptor | null {
   if (!value || typeof value !== "object") return null;
   const item = value as Record<string, unknown>;
   const number = (key: string) => typeof item[key] === "number" && Number.isSafeInteger(item[key]) ? item[key] as number : null;
   const ordinal = number("ordinal"); const byteSize = number("byteSize"); const width = number("width"); const height = number("height"); const durationMs = number("durationMs");
   if (ordinal === null || byteSize === null || width === null || height === null || durationMs === null
     || typeof item.idempotencyKey !== "string" || !SAFE_ID.test(item.idempotencyKey)
     || typeof item.filename !== "string" || !SAFE_NAME.test(item.filename)
     || typeof item.contentType !== "string" || !ALLOWED_VIDEO_TYPES.has(item.contentType)
     || typeof item.checksumSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(item.checksumSha256)
-    || byteSize < 1 || byteSize > MAX_VIDEO_UPLOAD_BYTES || width < 1 || height < 1 || durationMs < 1) return null;
+    || byteSize < 1 || byteSize > MAX_VIDEO_UPLOAD_BYTES || width < 1 || height < 1
+    || durationMs < MIN_VIDEO_DURATION_MS || durationMs > MAX_VIDEO_DURATION_MS) return null;
   return { ordinal, idempotencyKey: item.idempotencyKey, filename: item.filename, contentType: item.contentType, byteSize, checksumSha256: item.checksumSha256.toLowerCase(), width, height, durationMs };
 }

 async function json(req: Request): Promise<Record<string, unknown> | null> {
   try { const value = await req.json(); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { return null; }
 }

 export async function handleVideoUploadPrepare(req: Request, deps: VideoUploadHandlerDeps): Promise<Response> {
   const id = requestId(req);
   const owner = await deps.getUserId(req).catch(() => null);
@@ -76,77 +83,153 @@ export async function handleVideoUploadPrepare(req: Request, deps: VideoUploadHa
   if (!body || typeof body.idempotencyKey !== "string" || !SAFE_ID.test(body.idempotencyKey) || !Array.isArray(body.files)) return error("invalid_video_upload", id, 400);
   if (body.files.length === 0) return error("invalid_video_upload", id, 400);
   if (body.files.length > MAX_VIDEO_UPLOAD_ITEMS) return error("batch_limit_exceeded", id, 413);
   const files = body.files.map(descriptorFrom);
   if (files.some((file): file is null => !file)) return error("invalid_video_upload", id, 400);
   const descriptors = files as Descriptor[];
   if (new Set(descriptors.map(file => file.ordinal)).size !== descriptors.length || new Set(descriptors.map(file => file.idempotencyKey)).size !== descriptors.length || descriptors.some(file => file.ordinal < 0 || file.ordinal >= MAX_VIDEO_UPLOAD_ITEMS)) return error("invalid_video_upload", id, 400);
   const bucket = deps.bucket ?? VIDEO_UPLOAD_BUCKET;
   const now = deps.now?.() ?? new Date();
   let batch: { batchId: string };
-  try { batch = await deps.store.prepareBatch({ ownerUserId: owner, idempotencyKey: body.idempotencyKey, expiresAt: new Date(now.getTime() + (deps.expiresInMs ?? 15 * 60_000)).toISOString() }); }
-  catch { return error("video_upload_unavailable", id, 503); }
+  try { batch = await deps.store.prepareBatch({ ownerUserId: owner, idempotencyKey: body.idempotencyKey, expiresAt: new Date(now.getTime() + (deps.expiresInMs ?? VIDEO_SIGNED_UPLOAD_CAPABILITY_MS)).toISOString() }); }
+  catch (cause) {
+    const code = storeErrorCode(cause);
+    if (code === "video_upload_batch_expired") return error("video_upload_expired", id, 422);
+    if (code === "video_upload_batch_not_preparable") return error("video_upload_not_uploadable", id, 409);
+    return error("video_upload_unavailable", id, 503);
+  }
   const uploads: Array<{ ordinal: number; path: string; token: string; signedUrl: string; contentType: string; upsert: false }> = [];
   for (const file of descriptors) {
     // A batch replay must use the original random path. The exact item lookup is
     // owner-filtered by the store; its immutable-facts RPC below decides conflicts.
     let existing: PreparedItem | null;
     try { existing = await deps.store.findItem(owner, batch.batchId, file.ordinal); }
     catch { return error("video_upload_unavailable", id, 503); }
+    if (existing && (Date.parse(existing.expiresAt) <= now.getTime() || existing.status !== "prepared")) {
+      return error("video_upload_not_uploadable", id, 409);
+    }
     const path = existing?.privatePath ?? (deps.pathFactory ?? defaultPath)(owner, batch.batchId, file.ordinal, file.contentType);
     if (!ownerPath(owner, path)) return error("video_upload_unavailable", id, 503);
     try {
       await deps.store.prepareItem({ ownerUserId: owner, batchId: batch.batchId, ordinal: file.ordinal, idempotencyKey: file.idempotencyKey, privatePath: path, contentType: file.contentType, byteSize: file.byteSize, checksumSha256: file.checksumSha256, width: file.width, height: file.height, durationMs: file.durationMs });
       const signed = await deps.createSignedUpload({ bucket, path, contentType: file.contentType, upsert: false });
       if (!signed.token || !signed.signedUrl) throw new Error("capability unavailable");
       uploads.push({ ordinal: file.ordinal, path, token: signed.token, signedUrl: signed.signedUrl, contentType: file.contentType, upsert: false });
-    } catch { return error("video_upload_capability_unavailable", id, 502); }
+    } catch (cause) {
+      const code = storeErrorCode(cause);
+      if (code === "video_upload_item_idempotency_conflict") return error("video_upload_conflict", id, 409);
+      if (code === "video_upload_batch_expired") return error("video_upload_expired", id, 422);
+      if (code === "video_upload_batch_not_preparable") return error("video_upload_not_uploadable", id, 409);
+      return error("video_upload_capability_unavailable", id, 502);
+    }
   }
   return Response.json({ ok: true, batchId: batch.batchId, uploads, requestId: id });
 }

 async function readBounded(response: Response, maximum = 64 * 1024): Promise<Uint8Array | null> {
   const reader = response.body?.getReader(); if (!reader) return null;
   const chunks: Uint8Array[] = []; let length = 0;
   try { while (true) { const { done, value } = await reader.read(); if (done) break; if (!value) continue; length += value.byteLength; if (length > maximum) { await reader.cancel(); return null; } chunks.push(value); } }
   finally { reader.releaseLock(); }
   const result = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; } return result;
 }
-function hasFtyp(bytes: Uint8Array | null) { return Boolean(bytes && bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70); }
+const ALLOWED_FTYP_BRANDS = new Set(["isom", "iso2", "avc1", "mp41", "mp42", "M4V ", "qt  "]);
+function brand(bytes: Uint8Array, offset: number) { return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]); }
+function hasFtyp(bytes: Uint8Array | null) {
+  if (!bytes || bytes.length < 16 || brand(bytes, 4) !== "ftyp") return false;
+  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
+  if (size < 16 || size > bytes.length || (size - 16) % 4 !== 0) return false;
+  // Bytes 12..15 are the mandatory minor_version uint32. A permitted major or
+  // compatible brand is required; offset-four magic alone is not a container.
+  if (ALLOWED_FTYP_BRANDS.has(brand(bytes, 8))) return true;
+  for (let offset = 16; offset + 4 <= size; offset += 4) if (ALLOWED_FTYP_BRANDS.has(brand(bytes, offset))) return true;
+  return false;
+}
+async function readInitialRange(response: Response, end: number, total: number, contentType: string) {
+  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
+  const responseType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
+  const expected = end + 1;
+  const length = response.headers.get("content-length");
+  if (response.status !== 206 || responseType !== contentType || !match
+    || Number(match[1]) !== 0 || Number(match[2]) !== end || Number(match[3]) !== total
+    || (length !== null && Number(length) !== expected)) {
+    await response.body?.cancel();
+    return null;
+  }
+  const bytes = await readBounded(response, expected);
+  return bytes?.byteLength === expected ? bytes : null;
+}
 function safeResult(item: PreparedItem, id: string) { return { ok: true, batchId: item.batchId, ordinal: item.ordinal, proxyUrl: `/api/storage-media?path=${encodeURIComponent(item.privatePath)}`, requestId: id }; }
+function storeErrorCode(value: unknown) {
+  const message = value instanceof Error ? value.message : "";
+  return new Set([
+    "video_upload_item_claimed", "video_upload_claim_lost", "video_upload_provenance_incomplete",
+    "video_upload_batch_expired", "video_upload_item_not_finalizable", "video_upload_batch_not_finalizable",
+    "video_upload_item_idempotency_conflict", "video_upload_batch_not_found", "video_upload_item_not_found",
+    "video_upload_batch_not_preparable", "video_upload_batch_limit_exceeded", "video_upload_too_large",
+  ]).has(message) ? message : null;
+}

 export async function handleVideoUploadFinalize(req: Request, deps: VideoUploadHandlerDeps): Promise<Response> {
   const id = requestId(req);
   const owner = await deps.getUserId(req).catch(() => null);
   if (!owner) return error("unauthorized", id, 401);
   if (!deps.enabled) return error("video_upload_disabled", id, 404);
-  if (!deps.configured || !deps.storage || !deps.registerProvenance) return error("config_error", id, 503);
+  if (!deps.configured || !deps.storage) return error("config_error", id, 503);
   const body = await json(req);
   if (!body || typeof body.batchId !== "string" || !SAFE_ID.test(body.batchId) || typeof body.ordinal !== "number" || !Number.isInteger(body.ordinal) || body.ordinal < 0 || body.ordinal >= MAX_VIDEO_UPLOAD_ITEMS) return error("invalid_video_upload", id, 400);
   let item: PreparedItem | null;
   try { item = await deps.store.findItem(owner, body.batchId, body.ordinal); } catch { return error("video_upload_unavailable", id, 503); }
   if (!item || !ownerPath(owner, item.privatePath)) return error("video_upload_not_found", id, 404);
-  if (item.status === "finalized") return Response.json(safeResult(item, id));
+  const now = deps.now?.() ?? new Date();
+  const claimToken = crypto.randomUUID();
+  let claim: Awaited<ReturnType<VideoUploadStore["claimItem"]>>;
+  try {
+    claim = await deps.store.claimItem({ ownerUserId: owner, batchId: item.batchId, ordinal: item.ordinal, claimToken, claimExpiresAt: new Date(now.getTime() + VIDEO_FINALIZE_CLAIM_MS).toISOString() });
+  } catch (cause) {
+    const code = storeErrorCode(cause);
+    if (code === "video_upload_item_claimed" || code === "video_upload_claim_lost") return error("video_upload_in_progress", id, 409);
+    if (code === "video_upload_provenance_incomplete") return error("provenance_unavailable", id, 503);
+    if (code === "video_upload_batch_expired") return error("video_upload_expired", id, 422);
+    if (code === "video_upload_item_not_finalizable" || code === "video_upload_batch_not_finalizable") return error("video_upload_not_finalizable", id, 409);
+    return error("video_upload_unavailable", id, 503);
+  }
+  if (claim.status === "finalized") {
+    return claim.provenanceReady ? Response.json(safeResult(item, id)) : error("provenance_unavailable", id, 503);
+  }
+  if (claim.status !== "finalizing" || claim.claimToken !== claimToken) return error("video_upload_in_progress", id, 409);
   const cleanup = async (code: string) => {
-    try { await deps.store.failItem({ ownerUserId: owner, batchId: item!.batchId, ordinal: item!.ordinal, code }); } catch { /* failure state is best effort; cleanup remains mandatory */ }
+    let failure: Awaited<ReturnType<VideoUploadStore["failItem"]>>;
+    try { failure = await deps.store.failItem({ ownerUserId: owner, batchId: item!.batchId, ordinal: item!.ordinal, claimToken, code }); }
+    catch (cause) {
+      const lost = storeErrorCode(cause) === "video_upload_claim_lost";
+      return error(lost ? "video_upload_in_progress" : "video_upload_unavailable", id, lost ? 409 : 503);
+    }
+    if (!failure.cleanupAllowed || failure.status !== "failed") return error("video_upload_in_progress", id, 409);
+    if (!failure.cleanupScheduled) return error("cleanup_not_scheduled", id, 503);
+    // The fail RPC already persisted a delayed recheck beyond the capability's
+    // lifetime. Immediate deletion is best-effort; a still-valid token can write
+    // again, so successful deletion must not settle that durable responsibility.
     try { await deps.storage!.remove({ bucket: deps.bucket ?? VIDEO_UPLOAD_BUCKET, path: item!.privatePath }); }
-    catch { try { await deps.recordCleanup?.({ owner_user_id: owner, bucket_id: deps.bucket ?? VIDEO_UPLOAD_BUCKET, object_path: item!.privatePath, reason: code }); } catch { /* safe failure response below */ } }
+    catch { /* delayed cleanup is already durable */ }
     return error(code, id, code === "missing_video_object" ? 404 : code === "video_upload_unavailable" ? 503 : 422);
   };
-  if (Date.parse(item.expiresAt) <= (deps.now?.() ?? new Date()).getTime()) return cleanup("video_upload_expired");
+  if (Date.parse(item.expiresAt) <= now.getTime()) return cleanup("video_upload_expired");
   let stat: Awaited<ReturnType<VideoObjectStorage["stat"]>>;
   try { stat = await deps.storage.stat({ bucket: deps.bucket ?? VIDEO_UPLOAD_BUCKET, path: item.privatePath }); } catch { return cleanup("video_upload_unavailable"); }
   if (!stat.exists) return cleanup("missing_video_object");
   if (!stat.byteSize || stat.byteSize > MAX_VIDEO_UPLOAD_BYTES) return cleanup("invalid_video_size");
   if (stat.contentType !== item.declaredContentType || !ALLOWED_VIDEO_TYPES.has(stat.contentType)) return cleanup("video_content_type_mismatch");
-  if (stat.byteSize !== item.declaredByteSize || (stat.checksumSha256 && stat.checksumSha256.toLowerCase() !== item.declaredChecksumSha256)) return cleanup("video_facts_mismatch");
+  if (stat.byteSize !== item.declaredByteSize || (stat.verifiedChecksumSha256 && stat.verifiedChecksumSha256.toLowerCase() !== item.declaredChecksumSha256)) return cleanup("video_facts_mismatch");
   let header: Uint8Array | null;
-  try { header = await readBounded(await deps.storage.readRange({ bucket: deps.bucket ?? VIDEO_UPLOAD_BUCKET, path: item.privatePath, start: 0, end: Math.min(63, stat.byteSize - 1) })); } catch { return cleanup("video_upload_unavailable"); }
+  const headerEnd = Math.min(63, stat.byteSize - 1);
+  try { header = await readInitialRange(await deps.storage.readRange({ bucket: deps.bucket ?? VIDEO_UPLOAD_BUCKET, path: item.privatePath, start: 0, end: headerEnd }), headerEnd, stat.byteSize, stat.contentType); } catch { return cleanup("video_upload_unavailable"); }
+  if (!header) return cleanup("video_upload_unavailable");
   if (!hasFtyp(header)) return cleanup("invalid_video_container");
   try {
-    const checksum = stat.checksumSha256?.toLowerCase() ?? item.declaredChecksumSha256;
-    await deps.store.finalizeItem({ ownerUserId: owner, batchId: item.batchId, ordinal: item.ordinal, contentType: stat.contentType, byteSize: stat.byteSize, checksumSha256: checksum, width: item.declaredWidth, height: item.declaredHeight, durationMs: item.declaredDurationMs });
-    const registered = await deps.registerProvenance({ owner_user_id: owner, bucket_id: deps.bucket ?? VIDEO_UPLOAD_BUCKET, object_path: item.privatePath, source_type: "upload", intent_id: null, lifecycle_state: "draft", media_kind: "video", content_type: stat.contentType, byte_size: stat.byteSize, checksum_sha256: checksum, width: item.declaredWidth, height: item.declaredHeight, duration_ms: item.declaredDurationMs });
-    if (!registered) return cleanup("provenance_unavailable");
+    const finalized = await deps.store.finalizeItem({ ownerUserId: owner, batchId: item.batchId, ordinal: item.ordinal, claimToken,
+      bucketId: deps.bucket ?? VIDEO_UPLOAD_BUCKET, contentType: stat.contentType, byteSize: stat.byteSize,
+      checksumSha256: stat.verifiedChecksumSha256?.toLowerCase() ?? null });
+    if (finalized.status !== "finalized" || !finalized.provenanceReady) return cleanup("provenance_unavailable");
   } catch { return cleanup("video_upload_unavailable"); }
   return Response.json(safeResult(item, id));
 }
diff --git a/web/src/lib/server/media/videoUploadStore.ts b/web/src/lib/server/media/videoUploadStore.ts
index b4fc814d..6075fe09 100644
--- a/web/src/lib/server/media/videoUploadStore.ts
+++ b/web/src/lib/server/media/videoUploadStore.ts
@@ -1,22 +1,33 @@
 import type { VideoUploadStore } from "./videoUploadHandler";

 type Db = {
   rpc(name: string, args: Record<string, unknown>): any;
   from(table: string): any;
 };

 function rpcData(value: unknown): Record<string, unknown> | null {
   return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
 }
+const STABLE_STORE_CODES = new Set([
+  "video_upload_item_claimed", "video_upload_claim_lost", "video_upload_provenance_incomplete",
+  "video_upload_batch_expired", "video_upload_item_not_finalizable", "video_upload_batch_not_finalizable",
+  "video_upload_item_idempotency_conflict", "video_upload_batch_not_found", "video_upload_item_not_found",
+  "video_upload_batch_not_preparable", "video_upload_batch_limit_exceeded", "video_upload_too_large",
+]);
+function storeFailure(value: unknown) {
+  const message = value && typeof value === "object" && "message" in value ? String((value as { message: unknown }).message) : "";
+  const stable = [...STABLE_STORE_CODES].find(code => message === code || message.includes(code));
+  return new Error(stable ?? "video_upload_store_error");
+}
 function must<T>(result: { data: unknown; error: unknown }, map: (data: Record<string, unknown>) => T): T {
-  const value = rpcData(result.data); if (result.error || !value) throw new Error("video_upload_store_error"); return map(value);
+  const value = rpcData(result.data); if (result.error || !value) throw storeFailure(result.error); return map(value);
 }

 /** Service-only v77 boundary. Every direct query includes the verified owner. */
 export function createVideoUploadStore(db: Db): VideoUploadStore {
   return {
     async prepareBatch(input) {
       const result = await db.rpc("video_upload_batch_prepare", { p_owner_user_id: input.ownerUserId, p_idempotency_key: input.idempotencyKey, p_expires_at: input.expiresAt });
       return must(result, data => ({ batchId: String(data.batchId ?? "") }));
     },
     async prepareItem(input) {
@@ -24,32 +35,44 @@ export function createVideoUploadStore(db: Db): VideoUploadStore {
         p_owner_user_id: input.ownerUserId, p_batch_id: input.batchId, p_ordinal: input.ordinal, p_idempotency_key: input.idempotencyKey,
         p_private_path: input.privatePath, p_declared_content_type: input.contentType, p_declared_byte_size: input.byteSize,
         p_declared_checksum_sha256: input.checksumSha256, p_declared_width: input.width, p_declared_height: input.height, p_declared_duration_ms: input.durationMs,
       });
       return must(result, data => ({ status: String(data.status ?? "") }));
     },
     async findItem(ownerUserId, batchId, ordinal) {
       const { data, error } = await db.from("video_upload_items")
         .select("batch_id,ordinal,status,private_path,declared_content_type,declared_byte_size,declared_checksum_sha256,declared_width,declared_height,declared_duration_ms,expires_at")
         .eq("owner_user_id", ownerUserId).eq("batch_id", batchId).eq("ordinal", ordinal).maybeSingle();
-      if (error || !data) return null;
+      if (error) throw storeFailure(error);
+      if (!data) return null;
       return {
         batchId: data.batch_id, ordinal: data.ordinal, status: data.status, privatePath: data.private_path,
         declaredContentType: data.declared_content_type, declaredByteSize: Number(data.declared_byte_size), declaredChecksumSha256: data.declared_checksum_sha256,
         declaredWidth: Number(data.declared_width), declaredHeight: Number(data.declared_height), declaredDurationMs: Number(data.declared_duration_ms), expiresAt: data.expires_at,
       };
     },
     async finalizeItem(input) {
       const result = await db.rpc("video_upload_item_finalize", {
-        p_owner_user_id: input.ownerUserId, p_batch_id: input.batchId, p_ordinal: input.ordinal, p_verified_content_type: input.contentType,
-        p_verified_byte_size: input.byteSize, p_verified_checksum_sha256: input.checksumSha256, p_verified_width: input.width,
-        p_verified_height: input.height, p_verified_duration_ms: input.durationMs,
+        p_owner_user_id: input.ownerUserId, p_batch_id: input.batchId, p_ordinal: input.ordinal,
+        p_claim_token: input.claimToken, p_bucket_id: input.bucketId, p_verified_content_type: input.contentType,
+        p_verified_byte_size: input.byteSize, p_verified_checksum_sha256: input.checksumSha256,
       });
-      return must(result, data => ({ status: String(data.status ?? "") }));
+      return must(result, data => ({ status: String(data.status ?? ""), provenanceReady: data.provenanceReady === true }));
+    },
+    async claimItem(input) {
+      const result = await db.rpc("video_upload_item_claim", {
+        p_owner_user_id: input.ownerUserId, p_batch_id: input.batchId, p_ordinal: input.ordinal,
+        p_claim_token: input.claimToken, p_claim_expires_at: input.claimExpiresAt,
+      });
+      return must(result, data => ({ status: String(data.status ?? ""),
+        claimToken: data.claimToken == null ? null : String(data.claimToken), provenanceReady: data.provenanceReady === true }));
     },
     async failItem(input) {
-      const { error } = await db.from("video_upload_items").update({ status: "failed", error_code: input.code, updated_at: new Date().toISOString() })
-        .eq("owner_user_id", input.ownerUserId).eq("batch_id", input.batchId).eq("ordinal", input.ordinal);
-      if (error) throw new Error("video_upload_store_error");
+      const result = await db.rpc("video_upload_item_fail", {
+        p_owner_user_id: input.ownerUserId, p_batch_id: input.batchId, p_ordinal: input.ordinal,
+        p_claim_token: input.claimToken, p_error_code: input.code,
+      });
+      return must(result, data => ({ status: String(data.status ?? ""), cleanupAllowed: data.cleanupAllowed === true,
+        cleanupScheduled: data.cleanupScheduled === true }));
     },
   };
 }
diff --git a/web/src/lib/server/mediaProvenance.ts b/web/src/lib/server/mediaProvenance.ts
index 8f24418c..da4397db 100644
--- a/web/src/lib/server/mediaProvenance.ts
+++ b/web/src/lib/server/mediaProvenance.ts
@@ -8,47 +8,52 @@ export type MediaProvenance = {
   intent_id: string | null;
   lifecycle_state: string;
   /** v77 fields are optional so existing image rows retain their serialization. */
   media_kind?: "image" | "video" | string;
   content_type?: string | null;
   byte_size?: number | null;
   checksum_sha256?: string | null;
   width?: number | null;
   height?: number | null;
   duration_ms?: number | null;
+  content_type_source?: string | null;
+  byte_size_source?: string | null;
+  checksum_source?: string | null;
+  dimensions_source?: string | null;
+  duration_source?: string | null;
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
-        .select("owner_user_id,bucket_id,object_path,source_type,intent_id,lifecycle_state,media_kind,content_type,byte_size,checksum_sha256,width,height,duration_ms")
+        .select("owner_user_id,bucket_id,object_path,source_type,intent_id,lifecycle_state,media_kind,content_type,byte_size,checksum_sha256,width,height,duration_ms,content_type_source,byte_size_source,checksum_source,dimensions_source,duration_source")
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
-        .select("owner_user_id,bucket_id,object_path,source_type,intent_id,lifecycle_state,media_kind,content_type,byte_size,checksum_sha256,width,height,duration_ms")
+        .select("owner_user_id,bucket_id,object_path,source_type,intent_id,lifecycle_state,media_kind,content_type,byte_size,checksum_sha256,width,height,duration_ms,content_type_source,byte_size_source,checksum_source,dimensions_source,duration_source")
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
diff --git a/web/src/lib/studio/incrementalSha256.ts b/web/src/lib/studio/incrementalSha256.ts
new file mode 100644
index 00000000..8c3b809b
--- /dev/null
+++ b/web/src/lib/studio/incrementalSha256.ts
@@ -0,0 +1,85 @@
+const K = new Uint32Array([
+  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
+  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
+  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
+  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
+  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
+  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
+  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
+  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
+]);
+
+const rotate = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits));
+
+class Sha256 {
+  private state = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
+  private block = new Uint8Array(64);
+  private used = 0;
+  private bytes = 0;
+
+  update(chunk: Uint8Array) {
+    this.bytes += chunk.byteLength;
+    let offset = 0;
+    while (offset < chunk.byteLength) {
+      const copied = Math.min(64 - this.used, chunk.byteLength - offset);
+      this.block.set(chunk.subarray(offset, offset + copied), this.used);
+      this.used += copied;
+      offset += copied;
+      if (this.used === 64) { this.compress(this.block); this.used = 0; }
+    }
+  }
+
+  digestHex() {
+    const bitLength = this.bytes * 8;
+    this.block[this.used++] = 0x80;
+    if (this.used > 56) { this.block.fill(0, this.used); this.compress(this.block); this.used = 0; }
+    this.block.fill(0, this.used, 56);
+    const view = new DataView(this.block.buffer);
+    view.setUint32(56, Math.floor(bitLength / 0x100000000));
+    view.setUint32(60, bitLength >>> 0);
+    this.compress(this.block);
+    return [...this.state].map(word => word.toString(16).padStart(8, "0")).join("");
+  }
+
+  private compress(block: Uint8Array) {
+    const words = new Uint32Array(64);
+    const view = new DataView(block.buffer, block.byteOffset, 64);
+    for (let index = 0; index < 16; index++) words[index] = view.getUint32(index * 4);
+    for (let index = 16; index < 64; index++) {
+      const a = words[index - 15], b = words[index - 2];
+      const s0 = rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3);
+      const s1 = rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10);
+      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
+    }
+    let [a,b,c,d,e,f,g,h] = this.state;
+    for (let index = 0; index < 64; index++) {
+      const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
+      const choice = (e & f) ^ (~e & g);
+      const t1 = (h + s1 + choice + K[index] + words[index]) >>> 0;
+      const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
+      const majority = (a & b) ^ (a & c) ^ (b & c);
+      const t2 = (s0 + majority) >>> 0;
+      h=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
+    }
+    this.state[0]=(this.state[0]+a)>>>0; this.state[1]=(this.state[1]+b)>>>0;
+    this.state[2]=(this.state[2]+c)>>>0; this.state[3]=(this.state[3]+d)>>>0;
+    this.state[4]=(this.state[4]+e)>>>0; this.state[5]=(this.state[5]+f)>>>0;
+    this.state[6]=(this.state[6]+g)>>>0; this.state[7]=(this.state[7]+h)>>>0;
+  }
+}
+
+/** Incremental browser digest; memory stays bounded to the stream chunk plus 64 bytes. */
+export async function sha256Blob(blob: Blob) {
+  const hash = new Sha256();
+  const reader = blob.stream().getReader();
+  try {
+    while (true) {
+      const { done, value } = await reader.read();
+      if (done) break;
+      if (value) hash.update(value);
+    }
+  } finally {
+    reader.releaseLock();
+  }
+  return hash.digestHex();
+}
diff --git a/web/src/lib/studio/videoDirectUpload.ts b/web/src/lib/studio/videoDirectUpload.ts
index aceb3fa4..95274c34 100644
--- a/web/src/lib/studio/videoDirectUpload.ts
+++ b/web/src/lib/studio/videoDirectUpload.ts
@@ -1,26 +1,26 @@
 "use client";

 import { createBrowserClient } from "@supabase/ssr";
+import { sha256Blob } from "./incrementalSha256";

 export type VideoUploadDescriptor = { ordinal: number; idempotencyKey: string; filename: string; contentType: "video/mp4" | "video/x-m4v" | "video/quicktime"; byteSize: number; checksumSha256: string; width: number; height: number; durationMs: number };
 export type SignedVideoUpload = { ordinal: number; path: string; token: string; signedUrl: string; contentType: string; upsert: false };
 type PrepareResponse = { batchId: string; uploads: SignedVideoUpload[]; requestId: string };

 let client: ReturnType<typeof createBrowserClient> | null = null;
 function browser() { return client ??= createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!); }
 async function authHeaders(): Promise<Record<string, string>> { const { data: { session } } = await browser().auth.getSession(); return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}; }
 function requestId() { return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`; }

 export async function sha256(file: Blob): Promise<string> {
-  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
-  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
+  return sha256Blob(file);
 }
 async function api<T>(url: string, body: unknown, id: string): Promise<T> {
   const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-request-id": id, ...(await authHeaders()) }, body: JSON.stringify(body) });
   const payload = await response.json().catch(() => ({})) as T & { code?: string };
   if (!response.ok) throw Object.assign(new Error(payload.code ?? "video_upload_failed"), { code: payload.code, requestId: id });
   return payload;
 }

 /** Browser-to-private-Storage transfer; no video bytes enter a Next multipart route. */
 export async function prepareVideoDirectUpload(idempotencyKey: string, files: VideoUploadDescriptor[]): Promise<PrepareResponse> {
diff --git a/web/src/lib/videoUploadLimits.ts b/web/src/lib/videoUploadLimits.ts
new file mode 100644
index 00000000..42ffe505
--- /dev/null
+++ b/web/src/lib/videoUploadLimits.ts
@@ -0,0 +1,7 @@
+export const MAX_VIDEO_UPLOAD_BYTES = 100 * 1024 * 1024;
+export const MAX_VIDEO_UPLOAD_ITEMS = 20;
+export const MIN_VIDEO_DURATION_MS = 4_000;
+export const MAX_VIDEO_DURATION_MS = 5 * 60_000;
+export const VIDEO_FINALIZE_CLAIM_MS = 2 * 60_000;
+/** Supabase signed-upload capabilities are fixed at two hours by the provider. */
+export const VIDEO_SIGNED_UPLOAD_CAPABILITY_MS = 2 * 60 * 60_000;
