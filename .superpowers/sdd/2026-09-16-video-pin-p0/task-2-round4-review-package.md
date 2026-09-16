# Review package: 3b6b1123..1da8c3cd

## Commits
1da8c3cd fix(video): retain late upload cleanup

## Files changed
 .../task-2-implementer-report.md                   | 14 +++-
 backend/db/migrate_v77_video_media.sql             | 73 +++++++++++++-------
 backend/db/rollback_v77_video_media.sql            | 17 +++--
 .../tests/pglite_v37/verify-v77-video-media.mjs    | 56 ++++++++++++++-
 web/scripts/test-video-upload-private.ts           | 79 +++++++++++++++++++---
 web/src/lib/server/media/videoUploadHandler.ts     |  3 +-
 web/src/lib/studio/videoDirectUpload.ts            | 63 +++++++++++++++--
 web/src/lib/videoUploadLimits.ts                   |  9 ++-
 8 files changed, 259 insertions(+), 55 deletions(-)

## Diff
diff --git a/.superpowers/sdd/2026-09-16-video-pin-p0/task-2-implementer-report.md b/.superpowers/sdd/2026-09-16-video-pin-p0/task-2-implementer-report.md
index d0d51912..58faa4e7 100644
--- a/.superpowers/sdd/2026-09-16-video-pin-p0/task-2-implementer-report.md
+++ b/.superpowers/sdd/2026-09-16-video-pin-p0/task-2-implementer-report.md
@@ -1,18 +1,19 @@
 # Task 2 Implementer Report — Atomic Finalization And Review Remediation
 
 ## Scope And Base
 
 - Review baseline: `5f5fe502968f96effb7fc9be9b9fd372d6520512`.
 - Atomic-state/fact-contract implementation commit: `d47f6bcddd9164b680fbdffae286adec387fda04`.
 - Round-1 continuation base: `1c9f4615aa30e9b70b270b1d72b53b52e0e07a35`.
 - Round-2 remediation base: `c65e0f802fb95bb972d8515229c391a43af29f7d`.
+- Round-3 late-upload remediation base: `3b6b11239562189cae00cf7e882bad9c89ca7d4a`.
 - Branch/worktree: `codex/video-pin-p0-0916-final` / `D:/vp-tmp/wt-video-pin-p0-0916-final`.
 - This continuation closes the remaining review findings I3, I4, I5, I6, and I7, plus the stable-error and 100 MiB browser-digest minors. It preserves the earlier C1/I1/I2 atomic state/fact work.
 
 ## Implemented Contract
 
 - v77 now owns `finalize_claim_token` and `finalize_claim_expires_at`, plus service-only claim/finalize/fail RPCs with catalog hashes and explicit active/rollback privilege manifests.
 - Claim is owner/batch/ordinal scoped. One active claimant may inspect Storage; an expired lease can be taken over, and the stale claimant can no longer finalize, mark failure, or receive object-cleanup authority.
 - Failure and object deletion are coupled: the handler deletes only after the atomic fail RPC returns `cleanupAllowed=true` for the same live claim. A concurrent winner or lost claim therefore cannot have its object removed by a loser.
 - Final facts and ready video provenance are written in the same database transaction. A provenance collision rolls back the item lifecycle/facts; successful replay requires complete matching provenance and performs no Storage read.
 - Finalized upload rows require Storage-verified MIME/byte size, allow verified checksum to remain `NULL`, and require verified width/height/duration to remain `NULL`. Browser checksum/dimensions/duration stay in declared columns.
@@ -21,51 +22,60 @@
 - Shared TypeScript limits enforce duration from 4,000 through 300,000 ms; v77 independently enforces the same database boundary.
 - Batch lifecycle supports partial outcomes: a failed item does not block an independently claimed sibling from finalizing; the batch settles to failed only after no prepared/finalizing items remain.
 - `/api/storage-media` now uses the existing verified bearer-or-cookie identity helper. Every private response, including errors and 416, varies on `Cookie, Authorization, Range`.
 - Playback validates the Storage response status, normalized MIME, exact `Content-Range` start/end/total, declared byte total, and body length. A no-Range client request may accept a full 200 only with no `Content-Range` and an exact `Content-Length`; short or oversized streams error closed.
 - Finalize requires a real 206 initial range whose status, MIME, `Content-Range`, total, and actual bytes match the request. ISO-BMFF validation now parses a complete `ftyp` box, including a present minor-version field and an allowed major/compatible brand; offset-four magic alone is rejected.
 - Supabase's fixed two-hour upload capability is reflected in the shared server ledger TTL. Before every capability issue/reissue, `video_upload_item_prepare` atomically extends `capability_expires_at` and upserts a delayed, deduplicated `media_cleanup_outbox` responsibility. Failure preserves that pending responsibility in the same transaction before granting cleanup authority; finalize atomically settles it `done`. Immediate deletion is best-effort and cannot erase delayed recheck responsibility.
 - Round 2 makes cleanup authority and finalization mutually exclusive. The generic v76 cleanup lease now passes through a v77 database trigger that locks the matching upload item before granting a lease. A live finalize claim or finalized item rejects cleanup; a successful cleanup lease atomically moves the item to the terminal, non-finalizable `cleaning` state before external deletion authority can escape. Claim, prepare/reissue, capability settlement, and finalize cannot revive that state.
 - The post-sign capability confirmation RPC is owner/batch/ordinal scoped and service-only. It moves the cleanup boundary from the actual provider issuance time, retains a five-minute settle grace beyond the two-hour capability, and refuses to reveal a signed token unless the pending cleanup responsibility was durably confirmed.
 - The provenance source constraint now wraps the complete video predicate in `IS TRUE`, so every required value/source `NULL` fails closed rather than passing through SQL `UNKNOWN`. Migration collision detection, rollback preflight, and function/trigger manifests enforce the exact contract. Playback independently rejects missing, unknown, or contradictory source labels.
 - The production store contract now observes the real Supabase query builder and requires the exact `owner_user_id`, `batch_id`, and `ordinal` predicates; database query errors propagate as the stable `video_upload_store_error`.
+- Round 3 gives a 100 MiB browser upload a hard 15-minute AbortController deadline. The direct client mirrors the installed Storage SDK's signed-upload wire contract: PUT to the verified signed URL, `FormData` with `cacheControl=3600` and the file under the empty field name, `x-upsert: false`, and no manually supplied multipart boundary. Signed bucket/path/token mismatches fail before dispatch, and neither capability value is logged.
+- Deadline expiry and caller abort are distinct stable client outcomes (`video_upload_timeout` / `video_upload_aborted`). Both attempt the finalize endpoint so the server can accelerate failure cleanup; that notification is not the cleanup root, so its own failure cannot lose the responsibility created during prepare.
+- `capability_expires_at` now records the actual two-hour provider capability boundary. The new required `late_upload_recheck_after` records capability expiry plus the 15-minute maximum request and five-minute commit-visibility/finalization tail; the batch ledger covers the complete 2h20m interval.
+- The v77 cleanup trigger now prevents every early video cleanup `done` or `failed` settlement from terminating the responsibility. It converts the result back to pending at `late_upload_recheck_after`; only a worker lease and fresh Storage observation after that boundary may settle done. An early absence followed by a late object therefore produces a second lease that removes the object before termination.
 - Stable database conflict/expiry/state errors map to stable HTTP codes instead of collapsing to a provider 502.
 - Browser SHA-256 now consumes `Blob.stream()` with an incremental constant-memory implementation; it no longer allocates an entire 100 MiB `ArrayBuffer`.
 - Focused tests import the production route, store, Supabase Storage adapter, and browser upload client, and assert verified auth wiring, owner propagation, token/path/bucket preservation, and `upsert: false`. PGlite owns lifecycle, rollback, and privilege coverage.
 
 ## TDD Evidence
 
 - RED: v77 verifier failed because `video_upload_item_claim` did not exist (53 assertions reached).
 - RED: finalized rows without provenance were still accepted (71 assertions reached).
 - RED: an item failure immediately blocked a sibling claim with `video_upload_batch_not_finalizable` (73 assertions reached).
 - RED: handler claim-before-Storage test returned 503 instead of 200.
 - RED: production Storage adapter exposed uploader-controlled SHA metadata (`true !== false`).
 - RED: prepare ledger expired at 15 minutes instead of the provider capability's two hours.
 - RED: v77 had no `capability_expires_at` column or durable capability cleanup row.
 - RED: a stable item-idempotency conflict returned 502 instead of 409.
 - RED: bearer-only production route wiring, incorrect `Vary`, malformed/truncated/fake-brand `ftyp`, upstream 500/wrong range, playback MIME/range/total lies, and short streams were accepted by the prior focused contract.
 - RED: browser SHA-256 invoked the test Blob's forbidden whole-file `arrayBuffer()`.
 - RED: rollback accepted `capability_expires_at` nullability drift and revoked service writes instead of stopping before mutation.
 - RED (Round 2): focused tests failed with `store.confirmCapability is not a function` before post-sign settlement existed.
 - RED (Round 2): v77 stopped at assertion 65 because a video provenance insert with `NULL` fact values/sources still passed the database constraint.
 - RED (Round 2): production store query-shape tests exposed the absence of observable owner/batch/ordinal filtering and stable query-error propagation.
+- RED (Round 3): focused upload-ledger coverage observed `02:05:00` instead of the required `02:20:00` terminal window.
+- RED (Round 3): v77 failed at assertion 33 because `late_upload_recheck_after` did not exist in the owned schema.
+- RED (Round 3): the production client dispatched a signed URL whose token contradicted the separately returned token instead of failing before network work.
 - GREEN: `verify-v77-video-media.mjs` reports `verdict: pass`, 134 assertions, no failures.
 - GREEN: `test-video-upload-private.ts` reports 30 passed, 0 failed after the final production/store/cleanup tests.
+- GREEN (Round 3): `verify-v77-video-media.mjs` reports `verdict: pass`, 140 assertions, no failures.
+- GREEN (Round 3): `test-video-upload-private.ts` reports 31 passed, 0 failed.
 
 ## Verification
 
-- v77 PGlite: 134/134, pass; additionally covers durable capability cleanup creation, post-sign delayed scheduling, active-claim-versus-cleanup barriers in both acquisition orders, the terminal `cleaning` state, atomic successful settlement, failure preservation, fail-closed provenance `NULL`/source collisions, trigger/function privilege manifests, cleanup evidence across rollback/reapply, and rollback rejection of capability-expiry or provenance shape drift before mutation.
+- v77 PGlite: 140/140, pass; additionally covers durable capability cleanup creation, post-sign delayed scheduling, active-claim-versus-cleanup barriers in both acquisition orders, early absence rescheduling, a simulated late Storage object and mandatory post-tail deletion, the terminal `cleaning` state, atomic successful settlement, failure preservation, fail-closed provenance `NULL`/source collisions, trigger/function privilege manifests, cleanup evidence across rollback/reapply, and rollback rejection of capability-expiry, late-recheck, or provenance shape drift before mutation.
 - v76 PGlite: 280/280 across two rounds, pass.
 - v75 PGlite: 65 assertions with no failures; expected pre-existing `deployment_blocked` result remains for the legacy broad Storage policy.
 - Media privacy architecture: 16/16, pass.
 - Pinterest video adapter: 16/16, pass.
-- Focused private video upload: 30/30, pass after final production changes, including production store query shape/error behavior and playback source-label rejection.
+- Focused private video upload: 31/31, pass after final production changes, including production store query shape/error behavior, playback source-label rejection, exact abortable signed-upload transport, and timeout/abort cleanup notification.
 - Test registry: 239 tracked, 231 run by `npm test`, 8 documented exclusions.
 - `npm run typecheck`: exit 0.
 - `git diff --check`: exit 0 before the implementation commit; the follow-up report-only diff is also clean.
 
 ## Remaining Review Items
 
 - None from the supplied C1/I1-I7 and Minor review list. The known v75 deployment blocker remains external to Task 2: a pre-existing broad permissive `storage.objects` policy must be audited before deployment.
 
 ## External-Call Attestation
 
diff --git a/backend/db/migrate_v77_video_media.sql b/backend/db/migrate_v77_video_media.sql
index 178a2239..4c37ea3d 100644
--- a/backend/db/migrate_v77_video_media.sql
+++ b/backend/db/migrate_v77_video_media.sql
@@ -49,36 +49,37 @@ begin
       ('video_upload_items','owner_user_id','uuid',true,null),('video_upload_items','ordinal','integer',true,null),
       ('video_upload_items','idempotency_key','text',true,null),('video_upload_items','private_path','text',true,null),
       ('video_upload_items','declared_content_type','text',true,null),('video_upload_items','declared_byte_size','bigint',true,null),
       ('video_upload_items','declared_checksum_sha256','text',false,null),('video_upload_items','declared_width','integer',false,null),
       ('video_upload_items','declared_height','integer',false,null),('video_upload_items','declared_duration_ms','bigint',false,null),
       ('video_upload_items','verified_content_type','text',false,null),('video_upload_items','verified_byte_size','bigint',false,null),
       ('video_upload_items','verified_checksum_sha256','text',false,null),('video_upload_items','verified_width','integer',false,null),
       ('video_upload_items','verified_height','integer',false,null),('video_upload_items','verified_duration_ms','bigint',false,null),
       ('video_upload_items','finalize_claim_token','uuid',false,null),('video_upload_items','finalize_claim_expires_at','timestamp with time zone',false,null),
       ('video_upload_items','capability_expires_at','timestamp with time zone',true,null),
+      ('video_upload_items','late_upload_recheck_after','timestamp with time zone',true,null),
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
-          ('video_upload_items','id'),('video_upload_items','batch_id'),('video_upload_items','owner_user_id'),('video_upload_items','ordinal'),('video_upload_items','idempotency_key'),('video_upload_items','private_path'),('video_upload_items','declared_content_type'),('video_upload_items','declared_byte_size'),('video_upload_items','declared_checksum_sha256'),('video_upload_items','declared_width'),('video_upload_items','declared_height'),('video_upload_items','declared_duration_ms'),('video_upload_items','verified_content_type'),('video_upload_items','verified_byte_size'),('video_upload_items','verified_checksum_sha256'),('video_upload_items','verified_width'),('video_upload_items','verified_height'),('video_upload_items','verified_duration_ms'),('video_upload_items','finalize_claim_token'),('video_upload_items','finalize_claim_expires_at'),('video_upload_items','capability_expires_at'),('video_upload_items','status'),('video_upload_items','error_code'),('video_upload_items','prepared_at'),('video_upload_items','finalized_at'),('video_upload_items','expires_at'),('video_upload_items','created_at'),('video_upload_items','updated_at')
+          ('video_upload_items','id'),('video_upload_items','batch_id'),('video_upload_items','owner_user_id'),('video_upload_items','ordinal'),('video_upload_items','idempotency_key'),('video_upload_items','private_path'),('video_upload_items','declared_content_type'),('video_upload_items','declared_byte_size'),('video_upload_items','declared_checksum_sha256'),('video_upload_items','declared_width'),('video_upload_items','declared_height'),('video_upload_items','declared_duration_ms'),('video_upload_items','verified_content_type'),('video_upload_items','verified_byte_size'),('video_upload_items','verified_checksum_sha256'),('video_upload_items','verified_width'),('video_upload_items','verified_height'),('video_upload_items','verified_duration_ms'),('video_upload_items','finalize_claim_token'),('video_upload_items','finalize_claim_expires_at'),('video_upload_items','capability_expires_at'),('video_upload_items','late_upload_recheck_after'),('video_upload_items','status'),('video_upload_items','error_code'),('video_upload_items','prepared_at'),('video_upload_items','finalized_at'),('video_upload_items','expires_at'),('video_upload_items','created_at'),('video_upload_items','updated_at')
         ) expected(table_name,column_name) where expected.table_name=c.relname and expected.column_name=a.attname)) then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
   end if;
   -- Provenance is additive: v77 owns these columns and its discriminator check,
   -- while v75 continues to own the rest of its legacy relation.
   for v_name,v_expected_type,v_expected_not_null,v_expected_default in select * from (values
     ('media_kind','text',true,'''image''::text'),('content_type','text',false,null),('byte_size','bigint',false,null),
     ('checksum_sha256','text',false,null),('width','integer',false,null),('height','integer',false,null),('duration_ms','bigint',false,null),
     ('content_type_source','text',false,null),('byte_size_source','text',false,null),('checksum_source','text',false,null),
     ('dimensions_source','text',false,null),('duration_source','text',false,null)
   ) expected(column_name,type_name,not_null,default_expr) loop
@@ -97,30 +98,31 @@ begin
       ('video_upload_batches','video_upload_batches_status_check','CHECK ((status = ANY (ARRAY[''prepared''::text, ''uploading''::text, ''finalizing''::text, ''finalized''::text, ''failed''::text, ''expired''::text, ''canceled''::text])))'),
       ('video_upload_items','video_upload_items_pkey','PRIMARY KEY (id)'),('video_upload_items','video_upload_items_batch_id_fkey','FOREIGN KEY (batch_id) REFERENCES video_upload_batches(id) ON DELETE RESTRICT'),
       ('video_upload_items','video_upload_items_batch_id_ordinal_key','UNIQUE (batch_id, ordinal)'),('video_upload_items','video_upload_items_batch_id_idempotency_key_key','UNIQUE (batch_id, idempotency_key)'),
       ('video_upload_items','video_upload_items_ordinal_check','CHECK (((ordinal >= 0) AND (ordinal <= 19)))'),
       ('video_upload_items','video_upload_items_declared_content_type_check','CHECK ((declared_content_type = ANY (ARRAY[''video/mp4''::text, ''video/x-m4v''::text, ''video/quicktime''::text])))'),
       ('video_upload_items','video_upload_items_declared_byte_size_check','CHECK (((declared_byte_size >= 1) AND (declared_byte_size <= 104857600)))'),
       ('video_upload_items','video_upload_items_declared_checksum_check','CHECK (((declared_checksum_sha256 IS NULL) OR (declared_checksum_sha256 ~ ''^[0-9a-f]{64}$''::text)))'),
       ('video_upload_items','video_upload_items_declared_dimensions_check','CHECK (((declared_width > 0) AND (declared_height > 0)))'),
       ('video_upload_items','video_upload_items_declared_duration_check','CHECK (((declared_duration_ms >= 4000) AND (declared_duration_ms <= 300000)))'),
       ('video_upload_items','video_upload_items_verified_content_type_check','CHECK (((verified_content_type IS NULL) OR (verified_content_type = ANY (ARRAY[''video/mp4''::text, ''video/x-m4v''::text, ''video/quicktime''::text]))))'),
+      ('video_upload_items','video_upload_items_late_recheck_check','CHECK ((late_upload_recheck_after = (capability_expires_at + ''00:20:00''::interval)))'),
       ('video_upload_items','video_upload_items_status_check','CHECK ((status = ANY (ARRAY[''prepared''::text, ''uploading''::text, ''finalizing''::text, ''finalized''::text, ''failed''::text, ''expired''::text, ''canceled''::text, ''cleaning''::text])))'),
       ('video_upload_items','video_upload_items_claim_shape_check','CHECK (((status = ''finalizing''::text) = ((finalize_claim_token IS NOT NULL) AND (finalize_claim_expires_at IS NOT NULL))))'),
       ('video_upload_items','video_upload_items_finalized_facts_check','CHECK ((((status <> ''finalized''::text) OR ((verified_content_type = ANY (ARRAY[''video/mp4''::text, ''video/x-m4v''::text, ''video/quicktime''::text])) AND ((verified_byte_size >= 1) AND (verified_byte_size <= 104857600)) AND ((verified_checksum_sha256 IS NULL) OR (verified_checksum_sha256 ~ ''^[0-9a-f]{64}$''::text)) AND (verified_width IS NULL) AND (verified_height IS NULL) AND (verified_duration_ms IS NULL) AND (finalize_claim_token IS NULL) AND (finalize_claim_expires_at IS NULL))) IS TRUE))')
     ) expected(table_name,constraint_name,constraint_definition) loop
       select pg_get_constraintdef(p.oid) into v_default from pg_constraint p
         where p.conrelid=to_regclass('public.'||v_table) and p.conname=v_name;
       if not found or v_default is distinct from v_expected_definition then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
     end loop;
     if exists (select 1 from pg_constraint p where p.conrelid in ('public.video_upload_batches'::regclass,'public.video_upload_items'::regclass)
-      and p.contype in ('p','u','f','c') and p.conname not in ('video_upload_batches_pkey','video_upload_batches_owner_user_id_idempotency_key_key','video_upload_batches_status_check','video_upload_items_pkey','video_upload_items_batch_id_fkey','video_upload_items_batch_id_ordinal_key','video_upload_items_batch_id_idempotency_key_key','video_upload_items_ordinal_check','video_upload_items_declared_content_type_check','video_upload_items_declared_byte_size_check','video_upload_items_declared_checksum_check','video_upload_items_declared_dimensions_check','video_upload_items_declared_duration_check','video_upload_items_verified_content_type_check','video_upload_items_status_check','video_upload_items_claim_shape_check','video_upload_items_finalized_facts_check')) then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
+      and p.contype in ('p','u','f','c') and p.conname not in ('video_upload_batches_pkey','video_upload_batches_owner_user_id_idempotency_key_key','video_upload_batches_status_check','video_upload_items_pkey','video_upload_items_batch_id_fkey','video_upload_items_batch_id_ordinal_key','video_upload_items_batch_id_idempotency_key_key','video_upload_items_ordinal_check','video_upload_items_declared_content_type_check','video_upload_items_declared_byte_size_check','video_upload_items_declared_checksum_check','video_upload_items_declared_dimensions_check','video_upload_items_declared_duration_check','video_upload_items_verified_content_type_check','video_upload_items_late_recheck_check','video_upload_items_status_check','video_upload_items_claim_shape_check','video_upload_items_finalized_facts_check')) then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
     select pg_get_constraintdef(oid) into v_default from pg_constraint where conrelid='public.media_asset_provenance'::regclass and conname='media_asset_provenance_media_kind_check';
     if not found or v_default is distinct from 'CHECK ((media_kind = ANY (ARRAY[''image''::text, ''video''::text])))' then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
     select pg_get_constraintdef(oid) into v_default from pg_constraint where conrelid='public.media_asset_provenance'::regclass and conname='media_asset_provenance_video_fact_sources_check';
     if not found or v_default is distinct from 'CHECK ((((media_kind <> ''video''::text) OR ((content_type_source = ''storage_head_verified''::text) AND (byte_size_source = ''storage_head_verified''::text) AND (checksum_source = ANY (ARRAY[''storage_digest_verified''::text, ''unavailable''::text])) AND (dimensions_source = ''browser_declared''::text) AND (duration_source = ''browser_declared''::text) AND (((checksum_source = ''unavailable''::text) AND (checksum_sha256 IS NULL)) OR ((checksum_source = ''storage_digest_verified''::text) AND (checksum_sha256 ~ ''^[0-9a-f]{64}$''::text))) AND (width > 0) AND (height > 0) AND ((duration_ms >= 4000) AND (duration_ms <= 300000)))) IS TRUE))' then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
     for v_name,v_expected_definition in select * from (values
       ('video_upload_batches_owner_status_idx','CREATE INDEX video_upload_batches_owner_status_idx ON public.video_upload_batches USING btree (owner_user_id, status, updated_at DESC)'),
       ('video_upload_items_owner_batch_idx','CREATE INDEX video_upload_items_owner_batch_idx ON public.video_upload_items USING btree (owner_user_id, batch_id, ordinal)')
     ) expected(index_name,index_definition) loop
       select pg_get_indexdef(indexrelid) into v_default from pg_index where indexrelid=to_regclass('public.'||v_name);
       if not found or v_default is distinct from v_expected_definition then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
@@ -148,22 +150,22 @@ begin
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
-    ('public.video_upload_item_prepare(uuid,uuid,integer,text,text,text,bigint,text,integer,integer,bigint)','vibepin:v77:video-upload-item-prepare','bd8226c8e828048103e9e1673a339000'),
-    ('public.video_upload_capability_confirm(uuid,uuid,integer,timestamptz)','vibepin:v77:video-upload-capability-confirm','26772e478b44998f677ca9f740a2fc79'),
+    ('public.video_upload_item_prepare(uuid,uuid,integer,text,text,text,bigint,text,integer,integer,bigint)','vibepin:v77:video-upload-item-prepare','c1a93a8c1e811c2db64c18a1f4dc2a3a'),
+    ('public.video_upload_capability_confirm(uuid,uuid,integer,timestamptz)','vibepin:v77:video-upload-capability-confirm','2f24e5948edb58ee41a249bf3f1cbfe2'),
     ('public.video_upload_item_claim(uuid,uuid,integer,uuid,timestamptz)','vibepin:v77:video-upload-item-claim','84103643a001f04f0100afa60e2c8e75'),
     ('public.video_upload_item_finalize(uuid,uuid,integer,uuid,text,text,bigint,text)','vibepin:v77:video-upload-item-finalize','02f3e0537c0e882230e159243cb92bae'),
     ('public.video_upload_item_fail(uuid,uuid,integer,uuid,text)','vibepin:v77:video-upload-item-fail','71955fb29596ec65c0b9b8f4f2894f84')
   ) expected(signature,marker,body_hash) loop
     if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname=split_part(replace(v_signature,'public.',''),'(',1)
         and p.oid is distinct from to_regprocedure(v_signature)) then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
     if to_regprocedure(v_signature) is not null then
       select * into v_proc from pg_proc where oid=to_regprocedure(v_signature);
       if not v_installed or obj_description(v_proc.oid,'pg_proc') is distinct from v_marker
@@ -207,21 +209,21 @@ begin
   if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname='v77_video_cleanup_guard'
       and p.oid is distinct from to_regprocedure('public.v77_video_cleanup_guard()')) then
     raise exception using errcode='P0001',message='v77_schema_collision';
   end if;
   if to_regprocedure('public.v77_video_cleanup_guard()') is not null then
     select * into v_proc from pg_proc where oid=to_regprocedure('public.v77_video_cleanup_guard()');
     if obj_description(v_proc.oid,'pg_proc') is distinct from 'vibepin:v77:video-cleanup-guard'
        or not v_proc.prosecdef or v_proc.prorettype<>to_regtype('trigger') or v_proc.prolang<>(select oid from pg_language where lanname='plpgsql')
        or v_proc.proconfig is distinct from array['search_path=public, pg_temp']::text[]
-       or md5(replace(replace(v_proc.prosrc,chr(13)||chr(10),chr(10)),chr(13),chr(10)))<>'a5c5b35925778b58bf7bdf3d89455d68' then
+       or md5(replace(replace(v_proc.prosrc,chr(13)||chr(10),chr(10)),chr(13),chr(10)))<>'5c44133337a597110e4c44a6d4c729fa' then
       raise exception using errcode='P0001',message='v77_schema_collision';
     end if;
     foreach v_grantee in array array['anon','authenticated','service_role'] loop
       if has_function_privilege(v_grantee,v_proc.oid,'execute') then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
     end loop;
   end if;
   select count(*)=1 into v_actual from pg_trigger t where t.tgrelid=to_regclass('public.media_cleanup_outbox')
     and t.tgname='v77_video_cleanup_guard' and not t.tgisinternal and t.tgfoid=to_regprocedure('public.v77_video_cleanup_guard()')
     and t.tgenabled='O' and t.tgtype=19;
   if v_installed and v_active_privileges and (to_regprocedure('public.v77_video_cleanup_guard()') is null or not v_actual) then
@@ -269,20 +271,22 @@ create table if not exists public.video_upload_items (
   verified_content_type text
     constraint video_upload_items_verified_content_type_check check (verified_content_type is null or verified_content_type in ('video/mp4','video/x-m4v','video/quicktime')),
   verified_byte_size bigint,
   verified_checksum_sha256 text,
   verified_width integer,
   verified_height integer,
   verified_duration_ms bigint,
   finalize_claim_token uuid,
   finalize_claim_expires_at timestamptz,
   capability_expires_at timestamptz not null,
+  late_upload_recheck_after timestamptz not null
+    constraint video_upload_items_late_recheck_check check (late_upload_recheck_after = capability_expires_at + interval '20 minutes'),
   status text not null default 'prepared'
     constraint video_upload_items_status_check check (status in ('prepared','uploading','finalizing','finalized','failed','expired','canceled','cleaning')),
   constraint video_upload_items_claim_shape_check check (
     (status = 'finalizing') = (finalize_claim_token is not null and finalize_claim_expires_at is not null)
   ),
   constraint video_upload_items_finalized_facts_check check ((
     status <> 'finalized' or (
       verified_content_type in ('video/mp4','video/x-m4v','video/quicktime')
       and verified_byte_size between 1 and 104857600
       and (verified_checksum_sha256 is null or verified_checksum_sha256 ~ '^[0-9a-f]{64}$')
@@ -355,33 +359,47 @@ grant select,insert,update,delete on public.video_upload_batches,public.video_up
 
 -- Generic v76 cleanup workers acquire external deletion authority by moving an
 -- outbox row to processing. For video-upload rows, atomically move the item to
 -- a non-finalizable state first. An active finalize claim rejects that lease;
 -- whichever transaction locks the item first wins, so both rights cannot exist.
 create or replace function public.v77_video_cleanup_guard()
 returns trigger language plpgsql security definer set search_path=public,pg_temp as $fn$
 -- vibepin:v77:video-cleanup-guard
 declare v_item public.video_upload_items%rowtype;
 begin
-  if new.status='processing' and new.dedupe_key like 'video-upload:%'
-     and (old.status is distinct from 'processing' or old.lease_token is distinct from new.lease_token) then
+  if new.dedupe_key like 'video-upload:%' and (
+       (new.status='processing' and (old.status is distinct from 'processing' or old.lease_token is distinct from new.lease_token))
+       or (old.status='processing' and new.status in ('done','failed'))
+     ) then
     select * into v_item from public.video_upload_items i
       where new.dedupe_key='video-upload:'||i.id::text for update;
-    if not found or v_item.status='finalized'
-       or (v_item.status='finalizing' and v_item.finalize_claim_expires_at>now()) then
-      raise exception using errcode='40001',message='cleanup_item_unavailable';
+    if new.status='processing' then
+      if not found or v_item.status='finalized'
+         or (v_item.status='finalizing' and v_item.finalize_claim_expires_at>now()) then
+        raise exception using errcode='40001',message='cleanup_item_unavailable';
+      end if;
+      update public.video_upload_items set status='cleaning',error_code=coalesce(error_code,'cleanup_leased'),
+        finalize_claim_token=null,finalize_claim_expires_at=null,updated_at=now()
+        where id=v_item.id and (status in ('prepared','failed','expired','canceled','cleaning')
+          or (status='finalizing' and finalize_claim_expires_at<=now()));
+      if not found then raise exception using errcode='40001',message='cleanup_item_unavailable'; end if;
+    elsif found and v_item.status='cleaning' and now()<v_item.late_upload_recheck_after then
+      -- A request admitted before capability expiry may still commit after an
+      -- early absence/delete result. Preserve exactly one mandatory post-tail
+      -- observation rather than letting v76 terminate the responsibility.
+      new.status := 'pending';
+      new.completed_at := null;
+      new.dead_lettered_at := null;
+      new.lease_token := null;
+      new.lease_expires_at := null;
+      new.next_attempt_at := v_item.late_upload_recheck_after;
     end if;
-    update public.video_upload_items set status='cleaning',error_code=coalesce(error_code,'cleanup_leased'),
-      finalize_claim_token=null,finalize_claim_expires_at=null,updated_at=now()
-      where id=v_item.id and (status in ('prepared','failed','expired','canceled','cleaning')
-        or (status='finalizing' and finalize_claim_expires_at<=now()));
-    if not found then raise exception using errcode='40001',message='cleanup_item_unavailable'; end if;
   end if;
   return new;
 end $fn$;
 comment on function public.v77_video_cleanup_guard() is 'vibepin:v77:video-cleanup-guard';
 revoke all on function public.v77_video_cleanup_guard() from public,anon,authenticated,service_role;
 drop trigger if exists v77_video_cleanup_guard on public.media_cleanup_outbox;
 create trigger v77_video_cleanup_guard before update on public.media_cleanup_outbox
   for each row execute function public.v77_video_cleanup_guard();
 comment on trigger v77_video_cleanup_guard on public.media_cleanup_outbox is 'vibepin:v77:video-cleanup-guard';
 
@@ -411,21 +429,22 @@ comment on function public.video_upload_batch_prepare(uuid,text,timestamptz) is
 
 create or replace function public.video_upload_item_prepare(
   p_owner_user_id uuid,p_batch_id uuid,p_ordinal integer,p_idempotency_key text,p_private_path text,
   p_declared_content_type text,p_declared_byte_size bigint,p_declared_checksum_sha256 text,
   p_declared_width integer,p_declared_height integer,p_declared_duration_ms bigint
 ) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $fn$
 -- vibepin:v77:video-upload-item-prepare
 declare v_batch public.video_upload_batches%rowtype; v_item public.video_upload_items%rowtype;
   -- Reserve cleanup before issuing a token; post-sign confirmation moves this
   -- boundary from the actual provider issuance time and retains a settle grace.
-  v_capability_expires_at timestamptz := now()+interval '2 hours 5 minutes';
+  v_capability_expires_at timestamptz := now()+interval '2 hours';
+  v_late_upload_recheck_after timestamptz := v_capability_expires_at+interval '20 minutes';
 begin
   if p_owner_user_id is null or p_batch_id is null or p_ordinal is null or p_ordinal<0 or p_ordinal>=20
      or nullif(btrim(p_idempotency_key),'') is null or nullif(btrim(p_private_path),'') is null
      or p_private_path like '%..%' or split_part(p_private_path,'/',1) is distinct from p_owner_user_id::text then
     raise exception using errcode='22023',message=case when p_ordinal is null or p_ordinal<0 or p_ordinal>=20 then 'video_upload_batch_limit_exceeded' else 'invalid_video_upload_item' end;
   end if;
   if p_declared_content_type not in ('video/mp4','video/x-m4v','video/quicktime') then
     raise exception using errcode='22023',message='invalid_video_content_type';
   end if;
   if p_declared_byte_size is null or p_declared_byte_size<1 or p_declared_byte_size>104857600 then
@@ -446,42 +465,44 @@ begin
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
-    update public.video_upload_items set capability_expires_at=v_capability_expires_at,updated_at=now()
+    update public.video_upload_items set capability_expires_at=v_capability_expires_at,
+      late_upload_recheck_after=v_late_upload_recheck_after,updated_at=now()
       where id=v_item.id returning * into v_item;
     insert into public.media_cleanup_outbox(owner_user_id,bucket_id,object_path,reason,dedupe_key,next_attempt_at)
-      values(p_owner_user_id,'generated-private',v_item.private_path,'video_upload_capability_expired','video-upload:'||v_item.id::text,v_capability_expires_at)
+      values(p_owner_user_id,'generated-private',v_item.private_path,'video_upload_capability_expired','video-upload:'||v_item.id::text,v_capability_expires_at+interval '5 minutes')
       on conflict(dedupe_key) where dedupe_key is not null do update set
         owner_user_id=excluded.owner_user_id,bucket_id=excluded.bucket_id,object_path=excluded.object_path,
         reason=excluded.reason,status='pending',lease_token=null,lease_expires_at=null,
         next_attempt_at=excluded.next_attempt_at,last_error_code=null,dead_lettered_at=null,completed_at=null,updated_at=now();
     return jsonb_build_object('itemId',v_item.id,'status',v_item.status,'batchId',v_batch.id,'capabilityExpiresAt',v_item.capability_expires_at);
   end if;
   if exists (select 1 from public.video_upload_items where batch_id=v_batch.id and idempotency_key=btrim(p_idempotency_key)) then
     raise exception using errcode='23505',message='video_upload_item_idempotency_conflict';
   end if;
   insert into public.video_upload_items(
     batch_id,owner_user_id,ordinal,idempotency_key,private_path,declared_content_type,declared_byte_size,
-    declared_checksum_sha256,declared_width,declared_height,declared_duration_ms,capability_expires_at,expires_at
+    declared_checksum_sha256,declared_width,declared_height,declared_duration_ms,capability_expires_at,late_upload_recheck_after,expires_at
   ) values (
     v_batch.id,p_owner_user_id,p_ordinal,btrim(p_idempotency_key),btrim(p_private_path),p_declared_content_type,p_declared_byte_size,
-    nullif(btrim(coalesce(p_declared_checksum_sha256,'')),''),p_declared_width,p_declared_height,p_declared_duration_ms,v_capability_expires_at,v_batch.expires_at
+    nullif(btrim(coalesce(p_declared_checksum_sha256,'')),''),p_declared_width,p_declared_height,p_declared_duration_ms,
+    v_capability_expires_at,v_late_upload_recheck_after,v_batch.expires_at
   ) returning * into v_item;
   insert into public.media_cleanup_outbox(owner_user_id,bucket_id,object_path,reason,dedupe_key,next_attempt_at)
-    values(p_owner_user_id,'generated-private',v_item.private_path,'video_upload_capability_expired','video-upload:'||v_item.id::text,v_capability_expires_at)
+    values(p_owner_user_id,'generated-private',v_item.private_path,'video_upload_capability_expired','video-upload:'||v_item.id::text,v_capability_expires_at+interval '5 minutes')
     on conflict(dedupe_key) where dedupe_key is not null do update set
       owner_user_id=excluded.owner_user_id,bucket_id=excluded.bucket_id,object_path=excluded.object_path,
       reason=excluded.reason,status='pending',lease_token=null,lease_expires_at=null,
       next_attempt_at=excluded.next_attempt_at,last_error_code=null,dead_lettered_at=null,completed_at=null,updated_at=now();
   update public.video_upload_batches set status='uploading',updated_at=now() where id=v_batch.id;
   return jsonb_build_object('itemId',v_item.id,'status',v_item.status,'batchId',v_batch.id,'capabilityExpiresAt',v_item.capability_expires_at);
 exception when others then
   raise exception using errcode=sqlstate,message=case sqlerrm
     when 'video_upload_batch_limit_exceeded' then 'video_upload_batch_limit_exceeded'
     when 'invalid_video_upload_item' then 'invalid_video_upload_item'
@@ -497,39 +518,41 @@ exception when others then
 end $fn$;
 comment on function public.video_upload_item_prepare(uuid,uuid,integer,text,text,text,bigint,text,integer,integer,bigint) is 'vibepin:v77:video-upload-item-prepare';
 
 create or replace function public.video_upload_capability_confirm(
   p_owner_user_id uuid,p_batch_id uuid,p_ordinal integer,p_capability_expires_at timestamptz
 ) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $fn$
 -- vibepin:v77:video-upload-capability-confirm
 declare v_batch public.video_upload_batches%rowtype; v_item public.video_upload_items%rowtype; v_outbox public.media_cleanup_outbox%rowtype;
 begin
   if p_owner_user_id is null or p_batch_id is null or p_ordinal is null or p_capability_expires_at is null
-     or p_capability_expires_at<now()+interval '2 hours'
+     or p_capability_expires_at<now()+interval '1 hour 55 minutes'
      or p_capability_expires_at>now()+interval '2 hours 10 minutes' then
     raise exception using errcode='22023',message='invalid_video_capability_expiry';
   end if;
   select * into v_batch from public.video_upload_batches where id=p_batch_id and owner_user_id=p_owner_user_id for update;
   if not found then raise exception using errcode='P0002',message='video_upload_batch_not_found'; end if;
   select * into v_item from public.video_upload_items
     where batch_id=v_batch.id and ordinal=p_ordinal and owner_user_id=p_owner_user_id for update;
   if not found then raise exception using errcode='P0002',message='video_upload_item_not_found'; end if;
   if v_batch.status<>'uploading' or v_batch.expires_at<=now() or v_item.status<>'prepared' then
     raise exception using errcode='55000',message='video_upload_item_not_confirmable';
   end if;
-  update public.video_upload_items set capability_expires_at=greatest(capability_expires_at,p_capability_expires_at),updated_at=now()
+  update public.video_upload_items set capability_expires_at=greatest(capability_expires_at,p_capability_expires_at),
+    late_upload_recheck_after=greatest(capability_expires_at,p_capability_expires_at)+interval '20 minutes',updated_at=now()
     where id=v_item.id returning * into v_item;
   update public.media_cleanup_outbox set status='pending',lease_token=null,lease_expires_at=null,
-    next_attempt_at=v_item.capability_expires_at,last_error_code=null,dead_lettered_at=null,completed_at=null,updated_at=now()
+    next_attempt_at=v_item.capability_expires_at+interval '5 minutes',last_error_code=null,dead_lettered_at=null,completed_at=null,updated_at=now()
     where dedupe_key='video-upload:'||v_item.id::text and status='pending' returning * into v_outbox;
   if not found then raise exception using errcode='55000',message='video_cleanup_schedule_missing'; end if;
-  return jsonb_build_object('itemId',v_item.id,'status',v_item.status,'capabilityExpiresAt',v_item.capability_expires_at,'cleanupScheduled',true);
+  return jsonb_build_object('itemId',v_item.id,'status',v_item.status,'capabilityExpiresAt',v_item.capability_expires_at,
+    'lateUploadRecheckAfter',v_item.late_upload_recheck_after,'cleanupScheduled',true);
 exception when others then
   raise exception using errcode=sqlstate,message=case sqlerrm
     when 'invalid_video_capability_expiry' then 'invalid_video_capability_expiry'
     when 'video_upload_batch_not_found' then 'video_upload_batch_not_found'
     when 'video_upload_item_not_found' then 'video_upload_item_not_found'
     when 'video_upload_item_not_confirmable' then 'video_upload_item_not_confirmable'
     when 'video_cleanup_schedule_missing' then 'video_cleanup_schedule_missing'
     else 'v77_video_upload_error' end;
 end $fn$;
 comment on function public.video_upload_capability_confirm(uuid,uuid,integer,timestamptz) is 'vibepin:v77:video-upload-capability-confirm';
diff --git a/backend/db/rollback_v77_video_media.sql b/backend/db/rollback_v77_video_media.sql
index 6dd323c7..5573853c 100644
--- a/backend/db/rollback_v77_video_media.sql
+++ b/backend/db/rollback_v77_video_media.sql
@@ -4,37 +4,44 @@ begin;
 do $v77_rollback_preflight$
 declare v_name text; v_type text; v_not_null boolean; v_actual boolean; v_definition text; v_proc pg_proc%rowtype;
 begin
   foreach v_name in array array['video_upload_batches','video_upload_items'] loop
     if to_regclass('public.' || v_name) is not null
        and obj_description(to_regclass('public.' || v_name), 'pg_class') is distinct from 'vibepin:v77:' || replace(v_name, '_', '-') then
       raise exception using errcode='P0001',message='v77_rollback_collision';
     end if;
   end loop;
   if to_regclass('public.video_upload_items') is not null then
-    select format_type(a.atttypid,a.atttypmod),a.attnotnull into v_type,v_not_null
-      from pg_attribute a where a.attrelid='public.video_upload_items'::regclass
-        and a.attname='capability_expires_at' and a.attnum>0 and not a.attisdropped;
-    if not found or v_type is distinct from 'timestamp with time zone' or not v_not_null then
+    foreach v_name in array array['capability_expires_at','late_upload_recheck_after'] loop
+      select format_type(a.atttypid,a.atttypmod),a.attnotnull into v_type,v_not_null
+        from pg_attribute a where a.attrelid='public.video_upload_items'::regclass
+          and a.attname=v_name and a.attnum>0 and not a.attisdropped;
+      if not found or v_type is distinct from 'timestamp with time zone' or not v_not_null then
+        raise exception using errcode='P0001',message='v77_rollback_collision';
+      end if;
+    end loop;
+    select pg_get_constraintdef(oid) into v_definition from pg_constraint
+      where conrelid='public.video_upload_items'::regclass and conname='video_upload_items_late_recheck_check';
+    if not found or v_definition is distinct from 'CHECK ((late_upload_recheck_after = (capability_expires_at + ''00:20:00''::interval)))' then
       raise exception using errcode='P0001',message='v77_rollback_collision';
     end if;
   end if;
   select pg_get_constraintdef(oid) into v_definition from pg_constraint
     where conrelid=to_regclass('public.media_asset_provenance') and conname='media_asset_provenance_video_fact_sources_check';
   if not found or v_definition is distinct from 'CHECK ((((media_kind <> ''video''::text) OR ((content_type_source = ''storage_head_verified''::text) AND (byte_size_source = ''storage_head_verified''::text) AND (checksum_source = ANY (ARRAY[''storage_digest_verified''::text, ''unavailable''::text])) AND (dimensions_source = ''browser_declared''::text) AND (duration_source = ''browser_declared''::text) AND (((checksum_source = ''unavailable''::text) AND (checksum_sha256 IS NULL)) OR ((checksum_source = ''storage_digest_verified''::text) AND (checksum_sha256 ~ ''^[0-9a-f]{64}$''::text))) AND (width > 0) AND (height > 0) AND ((duration_ms >= 4000) AND (duration_ms <= 300000)))) IS TRUE))' then
     raise exception using errcode='P0001',message='v77_rollback_collision';
   end if;
   if to_regprocedure('public.v77_video_cleanup_guard()') is not null then
     select * into v_proc from pg_proc where oid=to_regprocedure('public.v77_video_cleanup_guard()');
     if obj_description(v_proc.oid,'pg_proc') is distinct from 'vibepin:v77:video-cleanup-guard'
        or not v_proc.prosecdef or v_proc.prorettype<>to_regtype('trigger')
-       or md5(replace(replace(v_proc.prosrc,chr(13)||chr(10),chr(10)),chr(13),chr(10)))<>'a5c5b35925778b58bf7bdf3d89455d68' then
+       or md5(replace(replace(v_proc.prosrc,chr(13)||chr(10),chr(10)),chr(13),chr(10)))<>'5c44133337a597110e4c44a6d4c729fa' then
       raise exception using errcode='P0001',message='v77_rollback_collision';
     end if;
   end if;
   select count(*)=1 into v_actual from pg_trigger t where t.tgrelid=to_regclass('public.media_cleanup_outbox')
     and t.tgname='v77_video_cleanup_guard' and not t.tgisinternal
     and t.tgfoid=to_regprocedure('public.v77_video_cleanup_guard()') and t.tgenabled='O' and t.tgtype=19;
   if (to_regprocedure('public.v77_video_cleanup_guard()') is null) is distinct from (not v_actual) then
     raise exception using errcode='P0001',message='v77_rollback_collision';
   end if;
 end $v77_rollback_preflight$;
diff --git a/backend/tests/pglite_v37/verify-v77-video-media.mjs b/backend/tests/pglite_v37/verify-v77-video-media.mjs
index 4a13c440..53d01523 100644
--- a/backend/tests/pglite_v37/verify-v77-video-media.mjs
+++ b/backend/tests/pglite_v37/verify-v77-video-media.mjs
@@ -139,20 +139,21 @@ async function run() {
       ["video_upload_items", "declared_duration_ms", "bigint", false, null],
       ["video_upload_items", "verified_content_type", "text", false, null],
       ["video_upload_items", "verified_byte_size", "bigint", false, null],
       ["video_upload_items", "verified_checksum_sha256", "text", false, null],
       ["video_upload_items", "verified_width", "integer", false, null],
       ["video_upload_items", "verified_height", "integer", false, null],
       ["video_upload_items", "verified_duration_ms", "bigint", false, null],
       ["video_upload_items", "finalize_claim_token", "uuid", false, null],
       ["video_upload_items", "finalize_claim_expires_at", "timestamp with time zone", false, null],
       ["video_upload_items", "capability_expires_at", "timestamp with time zone", true, null],
+      ["video_upload_items", "late_upload_recheck_after", "timestamp with time zone", true, null],
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
@@ -194,32 +195,33 @@ async function run() {
       values($1,'generated-private',$2,'upload','draft','video','video/mp4',20)`, [A, `${A}/null-sources.mp4`]));
     assert(Boolean(nullSourceInsert), "a video provenance INSERT with NULL fact values/sources fails closed");
 
     const one = await asRole(db, "service_role", () => prepareBatch(db, A, "batch-key"));
     const again = await asRole(db, "service_role", () => prepareBatch(db, A, "batch-key"));
     const otherOwner = await asRole(db, "service_role", () => prepareBatch(db, B, "batch-key"));
     assert(one.batchId === again.batchId && one.batchId !== otherOwner.batchId, "batch idempotency is owner-scoped");
     const item = await asRole(db, "service_role", () => prepareItem(db, A, one.batchId, 0, "item-key"));
     const itemAgain = await asRole(db, "service_role", () => prepareItem(db, A, one.batchId, 0, "item-key"));
     assert(item.itemId === itemAgain.itemId && item.status === "prepared", "item prepare is idempotent and starts prepared");
-    const capabilityGuard = (await db.query(`select i.capability_expires_at,o.status,o.next_attempt_at,o.dedupe_key
+    const capabilityGuard = (await db.query(`select i.capability_expires_at,i.late_upload_recheck_after,o.status,o.next_attempt_at,o.dedupe_key
       from public.video_upload_items i join public.media_cleanup_outbox o
         on o.dedupe_key='video-upload:'||i.id::text where i.id=$1`, [item.itemId])).rows[0];
     assert(capabilityGuard?.status === "pending" && capabilityGuard.dedupe_key === `video-upload:${item.itemId}`
       && Date.parse(capabilityGuard.next_attempt_at) >= Date.parse(capabilityGuard.capability_expires_at),
       "prepare atomically persists delayed cleanup through the signed capability lifetime");
     const confirmed = await asRole(db, "service_role", () => confirmCapability(db, A, one.batchId, 0));
-    const confirmedGuard = (await db.query(`select i.capability_expires_at,o.next_attempt_at
+    const confirmedGuard = (await db.query(`select i.capability_expires_at,i.late_upload_recheck_after,o.next_attempt_at
       from public.video_upload_items i join public.media_cleanup_outbox o on o.dedupe_key='video-upload:'||i.id::text
       where i.id=$1`, [item.itemId])).rows[0];
     assert(confirmed.cleanupScheduled === true
-      && Date.parse(confirmedGuard.next_attempt_at) === Date.parse(confirmedGuard.capability_expires_at)
+      && Date.parse(confirmedGuard.next_attempt_at) === Date.parse(confirmedGuard.capability_expires_at) + 5 * 60_000
+      && Date.parse(confirmedGuard.late_upload_recheck_after) === Date.parse(confirmedGuard.capability_expires_at) + 20 * 60_000
       && Date.parse(confirmedGuard.capability_expires_at) > Date.parse(capabilityGuard.capability_expires_at),
       "post-sign confirmation extends durable cleanup from the actual capability issuance boundary");
     const changedPrepare = await asRole(db, "service_role", () => rejected(() => db.query(`select public.video_upload_item_prepare(
       $1,$2,0,'item-key',$3,'video/mp4',1024,$4,720,1280,10_000)`,
       [A, one.batchId, `${A}/uploads/${one.batchId}/0.mp4`, "d".repeat(64)])));
     assert(changedPrepare?.message === "video_upload_item_idempotency_conflict", "replay conflicts whenever immutable declared facts differ");
 
     const claimToken = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
     const competingToken = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
     const claimed = await asRole(db, "service_role", () => claimItem(db, A, one.batchId, 0, claimToken));
@@ -306,20 +308,47 @@ async function run() {
     const cleanupFirstOutbox = (await db.query("update public.media_cleanup_outbox set next_attempt_at=now()-interval '1 second' where dedupe_key=$1 returning id", [`video-upload:${cleanupFirstItem.itemId}`])).rows[0];
     const cleanupLease = await asRole(db, "service_role", () => db.query(
       "select public.publish_cleanup_lease($1,$2,60) as value", [cleanupFirstOutbox.id, competingToken],
     ));
     const cleanupFirstClaim = await asRole(db, "service_role", () => rejected(() => claimItem(db, A, cleanupFirstBatch.batchId, 0, claimToken)));
     const cleanupFirstPrepare = await asRole(db, "service_role", () => rejected(() => prepareItem(db, A, cleanupFirstBatch.batchId, 0, "cleanup-first-item")));
     const cleanupFirstState = (await db.query("select status,finalize_claim_token from public.video_upload_items where id=$1", [cleanupFirstItem.itemId])).rows[0];
     assert(cleanupLease.rows[0].value.leased === true && cleanupFirstState.status === "cleaning"
       && cleanupFirstState.finalize_claim_token === null && Boolean(cleanupFirstClaim) && Boolean(cleanupFirstPrepare),
       "a cleanup lease atomically acquires deletion authority and permanently excludes reissue/claim/finalize success");
+    await asRole(db, "service_role", () => db.query(
+      "select public.publish_cleanup_settle($1,$2,'done','object_not_found')", [cleanupFirstOutbox.id, competingToken],
+    ));
+    const earlyMissing = (await db.query(`select o.status,o.completed_at,o.next_attempt_at,i.late_upload_recheck_after
+      from public.media_cleanup_outbox o join public.video_upload_items i on o.dedupe_key='video-upload:'||i.id::text
+      where o.id=$1`, [cleanupFirstOutbox.id])).rows[0];
+    assert(earlyMissing.status === "pending" && earlyMissing.completed_at === null
+      && Date.parse(earlyMissing.next_attempt_at) === Date.parse(earlyMissing.late_upload_recheck_after),
+      "object_not_found before the maximum in-flight tail remains a durable final-recheck responsibility");
+    await db.query("insert into storage.objects(id,bucket_id,name,owner_id) values(gen_random_uuid(),'generated-private',$1,$2)", [
+      `${A}/uploads/${cleanupFirstBatch.batchId}/0.mp4`, A,
+    ]);
+    await db.query(`update public.video_upload_items set capability_expires_at=now()-interval '20 minutes 1 second',
+      late_upload_recheck_after=now()-interval '1 second' where id=$1`, [cleanupFirstItem.itemId]);
+    await db.query("update public.media_cleanup_outbox set next_attempt_at=now()-interval '1 second' where id=$1", [cleanupFirstOutbox.id]);
+    await asRole(db, "service_role", () => db.query(
+      "select public.publish_cleanup_lease($1,$2,60)", [cleanupFirstOutbox.id, claimToken],
+    ));
+    await db.query("delete from storage.objects where bucket_id='generated-private' and name=$1", [`${A}/uploads/${cleanupFirstBatch.batchId}/0.mp4`]);
+    await asRole(db, "service_role", () => db.query(
+      "select public.publish_cleanup_settle($1,$2,'done',null)", [cleanupFirstOutbox.id, claimToken],
+    ));
+    const finalRecheck = (await db.query(`select o.status,o.completed_at,
+      exists(select 1 from storage.objects s where s.bucket_id=o.bucket_id and s.name=o.object_path) as object_exists
+      from public.media_cleanup_outbox o where o.id=$1`, [cleanupFirstOutbox.id])).rows[0];
+    assert(finalRecheck.status === "done" && Boolean(finalRecheck.completed_at) && !finalRecheck.object_exists,
+      "a late object is removed by the mandatory post-tail recheck before cleanup can terminate");
 
     const partialBatch = await asRole(db, "service_role", () => prepareBatch(db, A, "partial-batch"));
     const partialFailed = await asRole(db, "service_role", () => prepareItem(db, A, partialBatch.batchId, 0, "partial-failed"));
     const partialWinner = await asRole(db, "service_role", () => prepareItem(db, A, partialBatch.batchId, 1, "partial-winner"));
     await asRole(db, "service_role", () => claimItem(db, A, partialBatch.batchId, 0, claimToken));
     await asRole(db, "service_role", () => failItem(db, A, partialBatch.batchId, 0, claimToken));
     await asRole(db, "service_role", () => claimItem(db, A, partialBatch.batchId, 1, competingToken));
     await asRole(db, "service_role", () => finalizeItem(db, A, partialBatch.batchId, 1, competingToken, null));
     const partialState = await db.query("select id,status from public.video_upload_items where id in ($1,$2) order by ordinal", [partialFailed.itemId, partialWinner.itemId]);
     const partialBatchState = (await db.query("select status from public.video_upload_batches where id=$1", [partialBatch.batchId])).rows[0];
@@ -510,20 +539,24 @@ async function collisionRejections() {
       alter: db => db.exec("alter table public.video_upload_items drop constraint video_upload_items_ordinal_check; alter table public.video_upload_items add constraint video_upload_items_ordinal_check check (true)"),
     },
     {
       name: "media kind default drift",
       alter: db => db.exec("alter table public.media_asset_provenance alter column media_kind set default 'video'"),
     },
     {
       name: "item owner nullability drift",
       alter: db => db.exec("alter table public.video_upload_items alter column owner_user_id drop not null"),
     },
+    {
+      name: "late upload recheck nullability drift",
+      alter: db => db.exec("alter table public.video_upload_items alter column late_upload_recheck_after drop not null"),
+    },
     {
       name: "marked modified v77 RPC",
       alter: async db => {
         const definition = (await db.query("select pg_get_functiondef(to_regprocedure($1)) as definition", [
           "public.video_upload_batch_prepare(uuid,text,timestamptz)",
         ])).rows[0].definition;
         await db.exec(definition.replace("if p_owner_user_id is null", "if false and p_owner_user_id is null"));
       },
     },
     {
@@ -543,20 +576,24 @@ async function collisionRejections() {
       alter: db => db.exec("alter table public.video_upload_items alter column declared_byte_size type numeric"),
     },
     {
       name: "same-name altered finalized facts constraint",
       alter: db => db.exec("alter table public.video_upload_items drop constraint video_upload_items_finalized_facts_check; alter table public.video_upload_items add constraint video_upload_items_finalized_facts_check check (true)"),
     },
     {
       name: "same-name altered item status constraint",
       alter: db => db.exec("alter table public.video_upload_items drop constraint video_upload_items_status_check; alter table public.video_upload_items add constraint video_upload_items_status_check check (true)"),
     },
+    {
+      name: "same-name altered late recheck constraint",
+      alter: db => db.exec("alter table public.video_upload_items drop constraint video_upload_items_late_recheck_check; alter table public.video_upload_items add constraint video_upload_items_late_recheck_check check (true)"),
+    },
     {
       name: "client upload privilege drift",
       alter: db => db.exec("grant insert on public.video_upload_items to authenticated"),
     },
     {
       name: "authenticated truncate privilege drift",
       alter: db => db.exec("grant truncate on public.video_upload_items to authenticated"),
     },
     {
       name: "authenticated column update privilege drift",
@@ -614,20 +651,33 @@ async function collisionRejections() {
       await db.exec(migration);
       await db.exec("alter table public.video_upload_items alter column capability_expires_at drop not null");
       const before = (await db.query("select has_table_privilege('service_role','public.video_upload_items','insert') as service_insert")).rows[0];
       const rollbackError = await rejected(() => db.exec(rollback));
       await db.exec("rollback");
       const after = (await db.query("select has_table_privilege('service_role','public.video_upload_items','insert') as service_insert")).rows[0];
       assert(rollbackError?.message === "v77_rollback_collision" && before.service_insert && after.service_insert,
         "rollback rejects capability-expiry shape drift before revoking service writes");
     } finally { await db.close(); }
   }
+  {
+    const db = await dbWithV76();
+    try {
+      await db.exec(migration);
+      await db.exec("alter table public.video_upload_items alter column late_upload_recheck_after drop not null");
+      const before = (await db.query("select has_table_privilege('service_role','public.video_upload_items','insert') as service_insert")).rows[0];
+      const rollbackError = await rejected(() => db.exec(rollback));
+      await db.exec("rollback");
+      const after = (await db.query("select has_table_privilege('service_role','public.video_upload_items','insert') as service_insert")).rows[0];
+      assert(rollbackError?.message === "v77_rollback_collision" && before.service_insert && after.service_insert,
+        "rollback rejects late-upload recheck shape drift before revoking service writes");
+    } finally { await db.close(); }
+  }
   {
     const db = await dbWithV76();
     try {
       await db.exec(migration);
       await db.exec(`alter table public.media_asset_provenance drop constraint media_asset_provenance_video_fact_sources_check;
         alter table public.media_asset_provenance add constraint media_asset_provenance_video_fact_sources_check check (true)`);
       const before = (await db.query("select has_table_privilege('service_role','public.video_upload_items','insert') as service_insert")).rows[0];
       const rollbackError = await rejected(() => db.exec(rollback));
       await db.exec("rollback");
       const after = (await db.query("select has_table_privilege('service_role','public.video_upload_items','insert') as service_insert")).rows[0];
diff --git a/web/scripts/test-video-upload-private.ts b/web/scripts/test-video-upload-private.ts
index 851f620b..c368ffe2 100644
--- a/web/scripts/test-video-upload-private.ts
+++ b/web/scripts/test-video-upload-private.ts
@@ -99,29 +99,34 @@ async function main() {
     const response = await handleVideoUploadPrepare(request("https://app.test/prepare", { idempotencyKey: "batch_replay", files: [descriptor()] }), {
       getUserId: async () => OWNER, enabled: true, configured: true,
       store: storeStub({ prepareBatch: async () => ({ batchId: existing.batchId }), prepareItem: async () => ({ status: "failed" }), findItem: async () => existing }),
       createSignedUpload: async () => { signed++; return { token: "must-not-issue", signedUrl: "https://storage.test/must-not-issue" }; },
     });
     assert.equal(response.status, 409);
     assert.equal(signed, 0);
   });
 
   await test("prepare ledger covers the fixed two-hour signed-upload capability", async () => {
-    let expiresAt = "";
+    let expiresAt = ""; let capabilityExpiresAt = "";
     const now = new Date("2030-01-01T00:00:00.000Z");
     const response = await handleVideoUploadPrepare(request("https://app.test/prepare", { idempotencyKey: "batch_ttl", files: [descriptor()] }), {
       getUserId: async () => OWNER, enabled: true, configured: true, now: () => now,
-      store: storeStub({ prepareBatch: async (input: { expiresAt: string }) => { expiresAt = input.expiresAt; return { batchId: preparedItem().batchId }; }, findItem: async () => null }),
+      store: storeStub({
+        prepareBatch: async (input: { expiresAt: string }) => { expiresAt = input.expiresAt; return { batchId: preparedItem().batchId }; },
+        findItem: async () => null,
+        confirmCapability: async (input: { capabilityExpiresAt: string }) => { capabilityExpiresAt = input.capabilityExpiresAt; return { status: "prepared", cleanupScheduled: true }; },
+      }),
       createSignedUpload: async () => ({ token: "token", signedUrl: "https://storage.test/signed" }),
     });
     assert.equal(response.status, 200);
-    assert.equal(expiresAt, "2030-01-01T02:05:00.000Z");
+    assert.equal(expiresAt, "2030-01-01T02:20:00.000Z");
+    assert.equal(capabilityExpiresAt, "2030-01-01T02:00:00.000Z");
   });
 
   await test("prepare never reveals a signed token unless durable issuance confirmation succeeds", async () => {
     const response = await handleVideoUploadPrepare(request("https://app.test/prepare", { idempotencyKey: "batch_confirm", files: [descriptor()] }), {
       getUserId: async () => OWNER, enabled: true, configured: true,
       store: storeStub({ findItem: async () => null, confirmCapability: async () => { throw new Error("video_upload_store_error"); } }),
       createSignedUpload: async () => ({ token: "must-not-leak", signedUrl: "https://storage.test/must-not-leak" }),
     });
     assert.equal(response.status, 502);
     assert.doesNotMatch(await response.text(), /must-not-leak/);
@@ -545,43 +550,95 @@ async function main() {
     try {
       const route = await import("../src/app/api/storage-media/route");
       const response = await route.GET(new Request("https://app.test/api/storage-media?path=x"));
       assert.equal(await response.text(), "wired");
       assert.equal((captured as Record<string, unknown> | null)?.["getUserId"], verified);
     } finally {
       (Module as unknown as { _load: (...args: unknown[]) => unknown })._load = originalLoad;
     }
   });
 
-  await test("production browser client preserves private bucket, token, path, and upsert=false", async () => {
-    const calls: unknown[] = [];
+  await test("production browser client mirrors signed upload protocol with an abortable deadline", async () => {
+    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
     const fakeClient = {
       auth: { getSession: async () => ({ data: { session: { access_token: "access-token" } } }) },
-      storage: { from: (bucket: string) => ({ uploadToSignedUrl: async (path: string, token: string, file: File, options: unknown) => {
-        calls.push({ bucket, path, token, file, options }); return { error: null };
-      } }) },
     };
     const originalLoad = (Module as unknown as { _load: (...args: unknown[]) => unknown })._load;
     (Module as unknown as { _load: (...args: unknown[]) => unknown })._load = function(this: unknown, request: string, parent: unknown, isMain: boolean) {
       if (request === "@supabase/ssr") return { createBrowserClient: () => fakeClient };
       return originalLoad.call(this, request, parent, isMain);
     } as never;
     try {
-      const { uploadVideoToSignedStorage } = await import("../src/lib/studio/videoDirectUpload");
+      const { uploadVideoToSignedStorage, VIDEO_UPLOAD_MAX_IN_FLIGHT_MS } = await import("../src/lib/studio/videoDirectUpload");
       const file = new File([MP4_FTYP], "clip.mp4", { type: "video/mp4" });
-      await uploadVideoToSignedStorage({ ordinal: 0, path: `${OWNER}/videos/a.mp4`, token: "signed-token", signedUrl: "https://storage.test/signed", contentType: "video/mp4", upsert: false }, file);
-      assert.deepEqual(calls, [{ bucket: "generated-private", path: `${OWNER}/videos/a.mp4`, token: "signed-token", file, options: { contentType: "video/mp4", upsert: false } }]);
+      let timeoutMs = 0; let cleared = false;
+      const signedUrl = `https://storage.test/object/upload/sign/generated-private/${OWNER}/videos/a.mp4?token=signed-token`;
+      await uploadVideoToSignedStorage({ ordinal: 0, path: `${OWNER}/videos/a.mp4`, token: "signed-token", signedUrl, contentType: "video/mp4", upsert: false }, file, {
+        batchId: preparedItem().batchId,
+        fetchImpl: async (input, init) => { calls.push({ input, init }); return new Response(JSON.stringify({ Key: "private.mp4" }), { status: 200 }); },
+        setTimeoutImpl: ((_callback: () => void, delay: number) => { timeoutMs = delay; return 7; }) as typeof setTimeout,
+        clearTimeoutImpl: ((_timer: ReturnType<typeof setTimeout>) => { cleared = true; }) as typeof clearTimeout,
+      });
+      assert.equal(calls.length, 1);
+      assert.equal(calls[0].input, signedUrl);
+      assert.equal(calls[0].init?.method, "PUT");
+      assert.equal(new Headers(calls[0].init?.headers).get("x-upsert"), "false");
+      assert.equal(new Headers(calls[0].init?.headers).has("content-type"), false, "browser must generate the multipart boundary");
+      assert(calls[0].init?.body instanceof FormData);
+      assert.equal((calls[0].init?.body as FormData).get("cacheControl"), "3600");
+      assert.equal((calls[0].init?.body as FormData).get(""), file);
+      assert(calls[0].init?.signal instanceof AbortSignal && !calls[0].init.signal.aborted);
+      assert.equal(timeoutMs, VIDEO_UPLOAD_MAX_IN_FLIGHT_MS);
+      assert.equal(cleared, true);
+      await assert.rejects(() => uploadVideoToSignedStorage({ ordinal: 0, path: `${OWNER}/videos/a.mp4`, token: "other-token", signedUrl, contentType: "video/mp4", upsert: false }, file, {
+        batchId: preparedItem().batchId, fetchImpl: async () => { throw new Error("must not dispatch"); },
+      }), (error: unknown) => (error as { code?: string }).code === "video_upload_invalid_capability");
+      assert.equal(calls.length, 1, "a mismatched path/token capability never dispatches");
     } finally {
       (Module as unknown as { _load: (...args: unknown[]) => unknown })._load = originalLoad;
     }
   });
 
+  await test("browser upload deadline and caller abort have distinct stable codes and notify finalize cleanup", async () => {
+    const { uploadVideoToSignedStorage, VIDEO_UPLOAD_MAX_IN_FLIGHT_MS } = await import("../src/lib/studio/videoDirectUpload");
+    const file = new File([MP4_FTYP], "clip.mp4", { type: "video/mp4" });
+    const upload = { ordinal: 3, path: `${OWNER}/videos/late.mp4`, token: "secret-token",
+      signedUrl: `https://storage.test/object/upload/sign/generated-private/${OWNER}/videos/late.mp4?token=secret-token`, contentType: "video/mp4", upsert: false as const };
+    const run = async (externalSignal?: AbortSignal) => {
+      let deadline: (() => void) | null = null; const finalized: unknown[] = [];
+      const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
+        if (String(input).startsWith("https://storage.test/")) {
+          queueMicrotask(() => externalSignal ? (externalSignal as AbortSignal & { throwIfAborted?: () => void }).throwIfAborted?.() : deadline?.());
+          return await new Promise<Response>((_resolve, reject) => {
+            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
+            if (init?.signal?.aborted) reject(new DOMException("aborted", "AbortError"));
+          });
+        }
+        finalized.push(JSON.parse(String(init?.body)));
+        return new Response(JSON.stringify({ code: "missing_video_object" }), { status: 404, headers: { "content-type": "application/json" } });
+      };
+      const promise = uploadVideoToSignedStorage(upload, file, {
+        batchId: preparedItem().batchId, signal: externalSignal, fetchImpl,
+        setTimeoutImpl: ((callback: () => void, delay: number) => { assert.equal(delay, VIDEO_UPLOAD_MAX_IN_FLIGHT_MS); deadline = callback; return 9; }) as typeof setTimeout,
+        clearTimeoutImpl: (() => undefined) as typeof clearTimeout,
+      });
+      return { promise, finalized, fireDeadline: () => deadline?.() };
+    };
+    const timed = await run(); timed.fireDeadline();
+    await assert.rejects(timed.promise, (error: unknown) => (error as { code?: string }).code === "video_upload_timeout");
+    assert.deepEqual(timed.finalized, [{ batchId: preparedItem().batchId, ordinal: 3 }]);
+
+    const caller = new AbortController(); const aborted = await run(caller.signal); caller.abort();
+    await assert.rejects(aborted.promise, (error: unknown) => (error as { code?: string }).code === "video_upload_aborted");
+    assert.deepEqual(aborted.finalized, [{ batchId: preparedItem().batchId, ordinal: 3 }]);
+  });
+
   await test("browser SHA-256 is incremental and does not allocate the entire video", async () => {
     const { sha256 } = await import("../src/lib/studio/videoDirectUpload");
     const source = new Blob([new TextEncoder().encode("abc")]);
     Object.defineProperty(source, "arrayBuffer", { value: () => { throw new Error("whole-file allocation forbidden"); } });
     assert.equal(await sha256(source), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
   });
 
   console.log(`\nPrivate video upload: ${passed} passed, 0 failed`);
 }
 
diff --git a/web/src/lib/server/media/videoUploadHandler.ts b/web/src/lib/server/media/videoUploadHandler.ts
index 5d173d6e..f6e30dd2 100644
--- a/web/src/lib/server/media/videoUploadHandler.ts
+++ b/web/src/lib/server/media/videoUploadHandler.ts
@@ -1,19 +1,18 @@
 import {
   MAX_VIDEO_DURATION_MS,
   MAX_VIDEO_UPLOAD_BYTES,
   MAX_VIDEO_UPLOAD_ITEMS,
   MIN_VIDEO_DURATION_MS,
   VIDEO_FINALIZE_CLAIM_MS,
   VIDEO_SIGNED_UPLOAD_CAPABILITY_MS,
   VIDEO_UPLOAD_LEDGER_MS,
-  VIDEO_UPLOAD_SETTLE_GRACE_MS,
 } from "@/lib/videoUploadLimits";
 
 export const VIDEO_UPLOAD_BUCKET = "generated-private";
 export { MAX_VIDEO_UPLOAD_BYTES, MAX_VIDEO_UPLOAD_ITEMS, MIN_VIDEO_DURATION_MS, MAX_VIDEO_DURATION_MS };
 export const ALLOWED_VIDEO_TYPES = new Set(["video/mp4", "video/x-m4v", "video/quicktime"]);
 
 type PreparedItem = {
   batchId: string; ordinal: number; status: string; privatePath: string;
   declaredContentType: string; declaredByteSize: number; declaredChecksumSha256: string;
   declaredWidth: number; declaredHeight: number; declaredDurationMs: number; expiresAt: string;
@@ -111,21 +110,21 @@ export async function handleVideoUploadPrepare(req: Request, deps: VideoUploadHa
       return error("video_upload_not_uploadable", id, 409);
     }
     const path = existing?.privatePath ?? (deps.pathFactory ?? defaultPath)(owner, batch.batchId, file.ordinal, file.contentType);
     if (!ownerPath(owner, path)) return error("video_upload_unavailable", id, 503);
     try {
       await deps.store.prepareItem({ ownerUserId: owner, batchId: batch.batchId, ordinal: file.ordinal, idempotencyKey: file.idempotencyKey, privatePath: path, contentType: file.contentType, byteSize: file.byteSize, checksumSha256: file.checksumSha256, width: file.width, height: file.height, durationMs: file.durationMs });
       const signed = await deps.createSignedUpload({ bucket, path, contentType: file.contentType, upsert: false });
       if (!signed.token || !signed.signedUrl) throw new Error("capability unavailable");
       const issuedAt = deps.now?.() ?? new Date();
       const confirmation = await deps.store.confirmCapability({ ownerUserId: owner, batchId: batch.batchId, ordinal: file.ordinal,
-        capabilityExpiresAt: new Date(issuedAt.getTime() + VIDEO_SIGNED_UPLOAD_CAPABILITY_MS + VIDEO_UPLOAD_SETTLE_GRACE_MS).toISOString() });
+        capabilityExpiresAt: new Date(issuedAt.getTime() + VIDEO_SIGNED_UPLOAD_CAPABILITY_MS).toISOString() });
       if (confirmation.status !== "prepared" || !confirmation.cleanupScheduled) throw new Error("capability confirmation unavailable");
       uploads.push({ ordinal: file.ordinal, path, token: signed.token, signedUrl: signed.signedUrl, contentType: file.contentType, upsert: false });
     } catch (cause) {
       const code = storeErrorCode(cause);
       if (code === "video_upload_item_idempotency_conflict") return error("video_upload_conflict", id, 409);
       if (code === "video_upload_batch_expired") return error("video_upload_expired", id, 422);
       if (code === "video_upload_batch_not_preparable" || code === "video_upload_item_not_preparable") return error("video_upload_not_uploadable", id, 409);
       return error("video_upload_capability_unavailable", id, 502);
     }
   }
diff --git a/web/src/lib/studio/videoDirectUpload.ts b/web/src/lib/studio/videoDirectUpload.ts
index 95274c34..430d187a 100644
--- a/web/src/lib/studio/videoDirectUpload.ts
+++ b/web/src/lib/studio/videoDirectUpload.ts
@@ -1,36 +1,89 @@
 "use client";
 
 import { createBrowserClient } from "@supabase/ssr";
 import { sha256Blob } from "./incrementalSha256";
+import { VIDEO_UPLOAD_MAX_IN_FLIGHT_MS } from "@/lib/videoUploadLimits";
+
+export { VIDEO_UPLOAD_MAX_IN_FLIGHT_MS } from "@/lib/videoUploadLimits";
 
 export type VideoUploadDescriptor = { ordinal: number; idempotencyKey: string; filename: string; contentType: "video/mp4" | "video/x-m4v" | "video/quicktime"; byteSize: number; checksumSha256: string; width: number; height: number; durationMs: number };
 export type SignedVideoUpload = { ordinal: number; path: string; token: string; signedUrl: string; contentType: string; upsert: false };
 type PrepareResponse = { batchId: string; uploads: SignedVideoUpload[]; requestId: string };
 
 let client: ReturnType<typeof createBrowserClient> | null = null;
 function browser() { return client ??= createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!); }
 async function authHeaders(): Promise<Record<string, string>> { const { data: { session } } = await browser().auth.getSession(); return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}; }
 function requestId() { return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
 
 export async function sha256(file: Blob): Promise<string> {
   return sha256Blob(file);
 }
-async function api<T>(url: string, body: unknown, id: string): Promise<T> {
-  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-request-id": id, ...(await authHeaders()) }, body: JSON.stringify(body) });
+async function api<T>(url: string, body: unknown, id: string, fetchImpl: typeof fetch = fetch): Promise<T> {
+  const response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", "x-request-id": id, ...(await authHeaders()) }, body: JSON.stringify(body) });
   const payload = await response.json().catch(() => ({})) as T & { code?: string };
   if (!response.ok) throw Object.assign(new Error(payload.code ?? "video_upload_failed"), { code: payload.code, requestId: id });
   return payload;
 }
 
 /** Browser-to-private-Storage transfer; no video bytes enter a Next multipart route. */
 export async function prepareVideoDirectUpload(idempotencyKey: string, files: VideoUploadDescriptor[]): Promise<PrepareResponse> {
   if (process.env.NEXT_PUBLIC_VIDEO_PIN_UPLOAD !== "true") throw Object.assign(new Error("video_upload_disabled"), { code: "video_upload_disabled" });
   return api<PrepareResponse>("/api/studio/video-upload/prepare", { idempotencyKey, files }, requestId());
 }
-export async function uploadVideoToSignedStorage(upload: SignedVideoUpload, file: File): Promise<void> {
-  const { error } = await browser().storage.from("generated-private").uploadToSignedUrl(upload.path, upload.token, file, { contentType: upload.contentType, upsert: false });
-  if (error) throw Object.assign(new Error("video_upload_failed"), { code: "video_upload_failed" });
+export type DirectUploadOptions = {
+  batchId: string;
+  signal?: AbortSignal;
+  fetchImpl?: typeof fetch;
+  setTimeoutImpl?: typeof setTimeout;
+  clearTimeoutImpl?: typeof clearTimeout;
+};
+
+function verifiedSignedUploadUrl(upload: SignedVideoUpload) {
+  try {
+    const url = new URL(upload.signedUrl);
+    const marker = "/object/upload/sign/";
+    const markerAt = url.pathname.indexOf(marker);
+    const signedPath = markerAt < 0 ? "" : decodeURIComponent(url.pathname.slice(markerAt + marker.length));
+    if (url.protocol !== "https:" || signedPath !== `generated-private/${upload.path}`
+      || url.searchParams.get("token") !== upload.token || upload.upsert !== false) throw new Error("mismatch");
+    return url.toString();
+  } catch {
+    throw Object.assign(new Error("video_upload_invalid_capability"), { code: "video_upload_invalid_capability" });
+  }
+}
+
+export async function uploadVideoToSignedStorage(upload: SignedVideoUpload, file: File, options: DirectUploadOptions): Promise<void> {
+  const signedUrl = verifiedSignedUploadUrl(upload);
+  const fetchImpl = options.fetchImpl ?? fetch;
+  const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
+  const clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
+  const controller = new AbortController();
+  let timedOut = false;
+  const callerAbort = () => controller.abort(options.signal?.reason);
+  if (options.signal?.aborted) callerAbort();
+  else options.signal?.addEventListener("abort", callerAbort, { once: true });
+  const timer = setTimeoutImpl(() => { timedOut = true; controller.abort(); }, VIDEO_UPLOAD_MAX_IN_FLIGHT_MS);
+  try {
+    const body = new FormData();
+    body.append("cacheControl", "3600");
+    body.append("", file);
+    const response = await fetchImpl(signedUrl, {
+      method: "PUT", headers: { "x-upsert": "false" }, body, signal: controller.signal,
+    });
+    if (!response.ok) throw Object.assign(new Error("video_upload_failed"), { code: "video_upload_failed" });
+  } catch (cause) {
+    if (!controller.signal.aborted) throw cause;
+    const code = timedOut ? "video_upload_timeout" : "video_upload_aborted";
+    // The prepare transaction already owns the durable late-object recheck. This
+    // notification accelerates the item into failed/cleanup state but is not the
+    // sole cleanup guarantee, so a failed notification cannot lose responsibility.
+    await api("/api/studio/video-upload/finalize", { batchId: options.batchId, ordinal: upload.ordinal }, requestId(), fetchImpl).catch(() => undefined);
+    throw Object.assign(new Error(code), { code });
+  } finally {
+    clearTimeoutImpl(timer);
+    options.signal?.removeEventListener("abort", callerAbort);
+  }
 }
 export async function finalizeVideoDirectUpload(batchId: string, ordinal: number) {
   return api<{ ok: true; batchId: string; ordinal: number; proxyUrl: string; requestId: string }>("/api/studio/video-upload/finalize", { batchId, ordinal }, requestId());
 }
diff --git a/web/src/lib/videoUploadLimits.ts b/web/src/lib/videoUploadLimits.ts
index 9f3e1af2..62a99c23 100644
--- a/web/src/lib/videoUploadLimits.ts
+++ b/web/src/lib/videoUploadLimits.ts
@@ -1,10 +1,15 @@
 export const MAX_VIDEO_UPLOAD_BYTES = 100 * 1024 * 1024;
 export const MAX_VIDEO_UPLOAD_ITEMS = 20;
 export const MIN_VIDEO_DURATION_MS = 4_000;
 export const MAX_VIDEO_DURATION_MS = 5 * 60_000;
 export const VIDEO_FINALIZE_CLAIM_MS = 2 * 60_000;
 /** Supabase signed-upload capabilities are fixed at two hours by the provider. */
 export const VIDEO_SIGNED_UPLOAD_CAPABILITY_MS = 2 * 60 * 60_000;
-/** Covers a final in-flight upload plus the longest finalize claim after token expiry. */
+/** First cleanup observation after the signed capability expires. */
 export const VIDEO_UPLOAD_SETTLE_GRACE_MS = 5 * 60_000;
-export const VIDEO_UPLOAD_LEDGER_MS = VIDEO_SIGNED_UPLOAD_CAPABILITY_MS + VIDEO_UPLOAD_SETTLE_GRACE_MS;
+/** Maximum time allowed for one 100 MiB browser-to-Storage request. */
+export const VIDEO_UPLOAD_MAX_IN_FLIGHT_MS = 15 * 60_000;
+/** Final Storage visibility/deletion check after the last permitted in-flight request. */
+export const VIDEO_UPLOAD_LATE_COMMIT_VISIBILITY_MS = 5 * 60_000;
+export const VIDEO_UPLOAD_LEDGER_MS = VIDEO_SIGNED_UPLOAD_CAPABILITY_MS
+  + VIDEO_UPLOAD_MAX_IN_FLIGHT_MS + VIDEO_UPLOAD_LATE_COMMIT_VISIBILITY_MS;
