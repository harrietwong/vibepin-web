# Review package: c65e0f80..3b6b1123

## Commits
3b6b1123 fix(video): serialize cleanup and finalization

## Files changed
 .../task-2-implementer-report.md                   |  16 ++-
 backend/db/migrate_v77_video_media.sql             | 125 +++++++++++++++++++--
 backend/db/rollback_v77_video_media.sql            |  24 +++-
 .../tests/pglite_v37/verify-v77-video-media.mjs    | 101 ++++++++++++++++-
 web/scripts/test-video-upload-private.ts           |  82 ++++++++++++--
 web/src/lib/server/media/storageMediaHandler.ts    |  15 ++-
 web/src/lib/server/media/videoUploadHandler.ts     |  12 +-
 web/src/lib/server/media/videoUploadStore.ts       |   8 ++
 web/src/lib/videoUploadLimits.ts                   |   3 +
 9 files changed, 349 insertions(+), 37 deletions(-)

## Diff
diff --git a/.superpowers/sdd/2026-09-16-video-pin-p0/task-2-implementer-report.md b/.superpowers/sdd/2026-09-16-video-pin-p0/task-2-implementer-report.md
index 4745eb24..d0d51912 100644
--- a/.superpowers/sdd/2026-09-16-video-pin-p0/task-2-implementer-report.md
+++ b/.superpowers/sdd/2026-09-16-video-pin-p0/task-2-implementer-report.md
@@ -1,63 +1,71 @@
 # Task 2 Implementer Report — Atomic Finalization And Review Remediation

 ## Scope And Base

 - Review baseline: `5f5fe502968f96effb7fc9be9b9fd372d6520512`.
 - Atomic-state/fact-contract implementation commit: `d47f6bcddd9164b680fbdffae286adec387fda04`.
 - Round-1 continuation base: `1c9f4615aa30e9b70b270b1d72b53b52e0e07a35`.
+- Round-2 remediation base: `c65e0f802fb95bb972d8515229c391a43af29f7d`.
 - Branch/worktree: `codex/video-pin-p0-0916-final` / `D:/vp-tmp/wt-video-pin-p0-0916-final`.
 - This continuation closes the remaining review findings I3, I4, I5, I6, and I7, plus the stable-error and 100 MiB browser-digest minors. It preserves the earlier C1/I1/I2 atomic state/fact work.

 ## Implemented Contract

 - v77 now owns `finalize_claim_token` and `finalize_claim_expires_at`, plus service-only claim/finalize/fail RPCs with catalog hashes and explicit active/rollback privilege manifests.
 - Claim is owner/batch/ordinal scoped. One active claimant may inspect Storage; an expired lease can be taken over, and the stale claimant can no longer finalize, mark failure, or receive object-cleanup authority.
 - Failure and object deletion are coupled: the handler deletes only after the atomic fail RPC returns `cleanupAllowed=true` for the same live claim. A concurrent winner or lost claim therefore cannot have its object removed by a loser.
 - Final facts and ready video provenance are written in the same database transaction. A provenance collision rolls back the item lifecycle/facts; successful replay requires complete matching provenance and performs no Storage read.
 - Finalized upload rows require Storage-verified MIME/byte size, allow verified checksum to remain `NULL`, and require verified width/height/duration to remain `NULL`. Browser checksum/dimensions/duration stay in declared columns.
 - Video provenance records explicit trust labels: `storage_head_verified` for MIME/bytes, `storage_digest_verified` or `unavailable` for checksum, and `browser_declared` for dimensions/duration.
 - The production Supabase adapter ignores uploader-controlled `x-amz-meta-sha256`. It exposes no verified checksum until a genuinely trusted digest source exists.
 - Shared TypeScript limits enforce duration from 4,000 through 300,000 ms; v77 independently enforces the same database boundary.
 - Batch lifecycle supports partial outcomes: a failed item does not block an independently claimed sibling from finalizing; the batch settles to failed only after no prepared/finalizing items remain.
 - `/api/storage-media` now uses the existing verified bearer-or-cookie identity helper. Every private response, including errors and 416, varies on `Cookie, Authorization, Range`.
 - Playback validates the Storage response status, normalized MIME, exact `Content-Range` start/end/total, declared byte total, and body length. A no-Range client request may accept a full 200 only with no `Content-Range` and an exact `Content-Length`; short or oversized streams error closed.
 - Finalize requires a real 206 initial range whose status, MIME, `Content-Range`, total, and actual bytes match the request. ISO-BMFF validation now parses a complete `ftyp` box, including a present minor-version field and an allowed major/compatible brand; offset-four magic alone is rejected.
 - Supabase's fixed two-hour upload capability is reflected in the shared server ledger TTL. Before every capability issue/reissue, `video_upload_item_prepare` atomically extends `capability_expires_at` and upserts a delayed, deduplicated `media_cleanup_outbox` responsibility. Failure preserves that pending responsibility in the same transaction before granting cleanup authority; finalize atomically settles it `done`. Immediate deletion is best-effort and cannot erase delayed recheck responsibility.
+- Round 2 makes cleanup authority and finalization mutually exclusive. The generic v76 cleanup lease now passes through a v77 database trigger that locks the matching upload item before granting a lease. A live finalize claim or finalized item rejects cleanup; a successful cleanup lease atomically moves the item to the terminal, non-finalizable `cleaning` state before external deletion authority can escape. Claim, prepare/reissue, capability settlement, and finalize cannot revive that state.
+- The post-sign capability confirmation RPC is owner/batch/ordinal scoped and service-only. It moves the cleanup boundary from the actual provider issuance time, retains a five-minute settle grace beyond the two-hour capability, and refuses to reveal a signed token unless the pending cleanup responsibility was durably confirmed.
+- The provenance source constraint now wraps the complete video predicate in `IS TRUE`, so every required value/source `NULL` fails closed rather than passing through SQL `UNKNOWN`. Migration collision detection, rollback preflight, and function/trigger manifests enforce the exact contract. Playback independently rejects missing, unknown, or contradictory source labels.
+- The production store contract now observes the real Supabase query builder and requires the exact `owner_user_id`, `batch_id`, and `ordinal` predicates; database query errors propagate as the stable `video_upload_store_error`.
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
-- GREEN: `verify-v77-video-media.mjs` reports `verdict: pass`, 116 assertions, no failures.
-- GREEN: `test-video-upload-private.ts` reports 27 passed, 0 failed after the final production/client/cleanup tests.
+- RED (Round 2): focused tests failed with `store.confirmCapability is not a function` before post-sign settlement existed.
+- RED (Round 2): v77 stopped at assertion 65 because a video provenance insert with `NULL` fact values/sources still passed the database constraint.
+- RED (Round 2): production store query-shape tests exposed the absence of observable owner/batch/ordinal filtering and stable query-error propagation.
+- GREEN: `verify-v77-video-media.mjs` reports `verdict: pass`, 134 assertions, no failures.
+- GREEN: `test-video-upload-private.ts` reports 30 passed, 0 failed after the final production/store/cleanup tests.

 ## Verification

-- v77 PGlite: 116/116, pass; additionally covers durable capability cleanup creation, delayed scheduling, atomic successful settlement, failure preservation, cleanup evidence across rollback/reapply, and rollback rejection of capability-expiry shape drift before privilege mutation.
+- v77 PGlite: 134/134, pass; additionally covers durable capability cleanup creation, post-sign delayed scheduling, active-claim-versus-cleanup barriers in both acquisition orders, the terminal `cleaning` state, atomic successful settlement, failure preservation, fail-closed provenance `NULL`/source collisions, trigger/function privilege manifests, cleanup evidence across rollback/reapply, and rollback rejection of capability-expiry or provenance shape drift before mutation.
 - v76 PGlite: 280/280 across two rounds, pass.
 - v75 PGlite: 65 assertions with no failures; expected pre-existing `deployment_blocked` result remains for the legacy broad Storage policy.
 - Media privacy architecture: 16/16, pass.
 - Pinterest video adapter: 16/16, pass.
-- Focused private video upload: 27/27, pass after final production changes.
+- Focused private video upload: 30/30, pass after final production changes, including production store query shape/error behavior and playback source-label rejection.
 - Test registry: 239 tracked, 231 run by `npm test`, 8 documented exclusions.
 - `npm run typecheck`: exit 0.
 - `git diff --check`: exit 0 before the implementation commit; the follow-up report-only diff is also clean.

 ## Remaining Review Items

 - None from the supplied C1/I1-I7 and Minor review list. The known v75 deployment blocker remains external to Task 2: a pre-existing broad permissive `storage.objects` policy must be audited before deployment.

 ## External-Call Attestation

diff --git a/backend/db/migrate_v77_video_media.sql b/backend/db/migrate_v77_video_media.sql
index 136f5320..178a2239 100644
--- a/backend/db/migrate_v77_video_media.sql
+++ b/backend/db/migrate_v77_video_media.sql
@@ -97,34 +97,34 @@ begin
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
-      ('video_upload_items','video_upload_items_status_check','CHECK ((status = ANY (ARRAY[''prepared''::text, ''uploading''::text, ''finalizing''::text, ''finalized''::text, ''failed''::text, ''expired''::text, ''canceled''::text])))'),
+      ('video_upload_items','video_upload_items_status_check','CHECK ((status = ANY (ARRAY[''prepared''::text, ''uploading''::text, ''finalizing''::text, ''finalized''::text, ''failed''::text, ''expired''::text, ''canceled''::text, ''cleaning''::text])))'),
       ('video_upload_items','video_upload_items_claim_shape_check','CHECK (((status = ''finalizing''::text) = ((finalize_claim_token IS NOT NULL) AND (finalize_claim_expires_at IS NOT NULL))))'),
       ('video_upload_items','video_upload_items_finalized_facts_check','CHECK ((((status <> ''finalized''::text) OR ((verified_content_type = ANY (ARRAY[''video/mp4''::text, ''video/x-m4v''::text, ''video/quicktime''::text])) AND ((verified_byte_size >= 1) AND (verified_byte_size <= 104857600)) AND ((verified_checksum_sha256 IS NULL) OR (verified_checksum_sha256 ~ ''^[0-9a-f]{64}$''::text)) AND (verified_width IS NULL) AND (verified_height IS NULL) AND (verified_duration_ms IS NULL) AND (finalize_claim_token IS NULL) AND (finalize_claim_expires_at IS NULL))) IS TRUE))')
     ) expected(table_name,constraint_name,constraint_definition) loop
       select pg_get_constraintdef(p.oid) into v_default from pg_constraint p
         where p.conrelid=to_regclass('public.'||v_table) and p.conname=v_name;
       if not found or v_default is distinct from v_expected_definition then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
     end loop;
     if exists (select 1 from pg_constraint p where p.conrelid in ('public.video_upload_batches'::regclass,'public.video_upload_items'::regclass)
       and p.contype in ('p','u','f','c') and p.conname not in ('video_upload_batches_pkey','video_upload_batches_owner_user_id_idempotency_key_key','video_upload_batches_status_check','video_upload_items_pkey','video_upload_items_batch_id_fkey','video_upload_items_batch_id_ordinal_key','video_upload_items_batch_id_idempotency_key_key','video_upload_items_ordinal_check','video_upload_items_declared_content_type_check','video_upload_items_declared_byte_size_check','video_upload_items_declared_checksum_check','video_upload_items_declared_dimensions_check','video_upload_items_declared_duration_check','video_upload_items_verified_content_type_check','video_upload_items_status_check','video_upload_items_claim_shape_check','video_upload_items_finalized_facts_check')) then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
     select pg_get_constraintdef(oid) into v_default from pg_constraint where conrelid='public.media_asset_provenance'::regclass and conname='media_asset_provenance_media_kind_check';
     if not found or v_default is distinct from 'CHECK ((media_kind = ANY (ARRAY[''image''::text, ''video''::text])))' then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
     select pg_get_constraintdef(oid) into v_default from pg_constraint where conrelid='public.media_asset_provenance'::regclass and conname='media_asset_provenance_video_fact_sources_check';
-    if not found or v_default is distinct from 'CHECK (((media_kind <> ''video''::text) OR ((content_type_source = ''storage_head_verified''::text) AND (byte_size_source = ''storage_head_verified''::text) AND (checksum_source = ANY (ARRAY[''storage_digest_verified''::text, ''unavailable''::text])) AND (dimensions_source = ''browser_declared''::text) AND (duration_source = ''browser_declared''::text) AND (((checksum_source = ''unavailable''::text) AND (checksum_sha256 IS NULL)) OR ((checksum_source = ''storage_digest_verified''::text) AND (checksum_sha256 ~ ''^[0-9a-f]{64}$''::text))) AND (width > 0) AND (height > 0) AND ((duration_ms >= 4000) AND (duration_ms <= 300000)))))' then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
+    if not found or v_default is distinct from 'CHECK ((((media_kind <> ''video''::text) OR ((content_type_source = ''storage_head_verified''::text) AND (byte_size_source = ''storage_head_verified''::text) AND (checksum_source = ANY (ARRAY[''storage_digest_verified''::text, ''unavailable''::text])) AND (dimensions_source = ''browser_declared''::text) AND (duration_source = ''browser_declared''::text) AND (((checksum_source = ''unavailable''::text) AND (checksum_sha256 IS NULL)) OR ((checksum_source = ''storage_digest_verified''::text) AND (checksum_sha256 ~ ''^[0-9a-f]{64}$''::text))) AND (width > 0) AND (height > 0) AND ((duration_ms >= 4000) AND (duration_ms <= 300000)))) IS TRUE))' then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
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
@@ -148,22 +148,23 @@ begin
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
-    ('public.video_upload_item_prepare(uuid,uuid,integer,text,text,text,bigint,text,integer,integer,bigint)','vibepin:v77:video-upload-item-prepare','2ba41a1ad29086bdca6cfce6e25cafad'),
-    ('public.video_upload_item_claim(uuid,uuid,integer,uuid,timestamptz)','vibepin:v77:video-upload-item-claim','1e7a9a9f8cda0fecf9b121e83caec3e1'),
+    ('public.video_upload_item_prepare(uuid,uuid,integer,text,text,text,bigint,text,integer,integer,bigint)','vibepin:v77:video-upload-item-prepare','bd8226c8e828048103e9e1673a339000'),
+    ('public.video_upload_capability_confirm(uuid,uuid,integer,timestamptz)','vibepin:v77:video-upload-capability-confirm','26772e478b44998f677ca9f740a2fc79'),
+    ('public.video_upload_item_claim(uuid,uuid,integer,uuid,timestamptz)','vibepin:v77:video-upload-item-claim','84103643a001f04f0100afa60e2c8e75'),
     ('public.video_upload_item_finalize(uuid,uuid,integer,uuid,text,text,bigint,text)','vibepin:v77:video-upload-item-finalize','02f3e0537c0e882230e159243cb92bae'),
     ('public.video_upload_item_fail(uuid,uuid,integer,uuid,text)','vibepin:v77:video-upload-item-fail','71955fb29596ec65c0b9b8f4f2894f84')
   ) expected(signature,marker,body_hash) loop
     if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname=split_part(replace(v_signature,'public.',''),'(',1)
         and p.oid is distinct from to_regprocedure(v_signature)) then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
     if to_regprocedure(v_signature) is not null then
       select * into v_proc from pg_proc where oid=to_regprocedure(v_signature);
       if not v_installed or obj_description(v_proc.oid,'pg_proc') is distinct from v_marker
          or not v_proc.prosecdef or v_proc.prokind<>'f' or v_proc.prorettype<>to_regtype('jsonb')
@@ -171,42 +172,71 @@ begin
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
+      ('public.video_upload_capability_confirm(uuid,uuid,integer,timestamptz)'),
       ('public.video_upload_item_claim(uuid,uuid,integer,uuid,timestamptz)'),
       ('public.video_upload_item_finalize(uuid,uuid,integer,uuid,text,text,bigint,text)'),
       ('public.video_upload_item_fail(uuid,uuid,integer,uuid,text)')
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
+        to_regprocedure('public.video_upload_capability_confirm(uuid,uuid,integer,timestamptz)'),
         to_regprocedure('public.video_upload_item_claim(uuid,uuid,integer,uuid,timestamptz)'),
         to_regprocedure('public.video_upload_item_finalize(uuid,uuid,integer,uuid,text,text,bigint,text)'),
         to_regprocedure('public.video_upload_item_fail(uuid,uuid,integer,uuid,text)')
       ) and acl.is_grantable and (acl.grantee=0 or acl.grantee in (select oid from pg_roles where rolname in ('anon','authenticated','service_role')))) then
       v_active_privileges := false; v_rollback_privileges := false;
     end if;
     if not v_active_privileges and not v_rollback_privileges then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
   end if;
+
+  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
+    where n.nspname='public' and p.proname='v77_video_cleanup_guard'
+      and p.oid is distinct from to_regprocedure('public.v77_video_cleanup_guard()')) then
+    raise exception using errcode='P0001',message='v77_schema_collision';
+  end if;
+  if to_regprocedure('public.v77_video_cleanup_guard()') is not null then
+    select * into v_proc from pg_proc where oid=to_regprocedure('public.v77_video_cleanup_guard()');
+    if obj_description(v_proc.oid,'pg_proc') is distinct from 'vibepin:v77:video-cleanup-guard'
+       or not v_proc.prosecdef or v_proc.prorettype<>to_regtype('trigger') or v_proc.prolang<>(select oid from pg_language where lanname='plpgsql')
+       or v_proc.proconfig is distinct from array['search_path=public, pg_temp']::text[]
+       or md5(replace(replace(v_proc.prosrc,chr(13)||chr(10),chr(10)),chr(13),chr(10)))<>'a5c5b35925778b58bf7bdf3d89455d68' then
+      raise exception using errcode='P0001',message='v77_schema_collision';
+    end if;
+    foreach v_grantee in array array['anon','authenticated','service_role'] loop
+      if has_function_privilege(v_grantee,v_proc.oid,'execute') then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
+    end loop;
+  end if;
+  select count(*)=1 into v_actual from pg_trigger t where t.tgrelid=to_regclass('public.media_cleanup_outbox')
+    and t.tgname='v77_video_cleanup_guard' and not t.tgisinternal and t.tgfoid=to_regprocedure('public.v77_video_cleanup_guard()')
+    and t.tgenabled='O' and t.tgtype=19;
+  if v_installed and v_active_privileges and (to_regprocedure('public.v77_video_cleanup_guard()') is null or not v_actual) then
+    raise exception using errcode='P0001',message='v77_schema_collision';
+  end if;
+  if v_installed and v_rollback_privileges and (to_regprocedure('public.v77_video_cleanup_guard()') is not null or v_actual) then
+    raise exception using errcode='P0001',message='v77_schema_collision';
+  end if;
 end $v77_preflight$;

 create table if not exists public.video_upload_batches (
   id uuid primary key default gen_random_uuid(),
   owner_user_id uuid not null,
   idempotency_key text not null,
   status text not null default 'prepared'
     constraint video_upload_batches_status_check check (status in ('prepared','uploading','finalizing','finalized','failed','expired','canceled')),
   error_code text,
   prepared_at timestamptz not null default now(),
@@ -240,21 +270,21 @@ create table if not exists public.video_upload_items (
     constraint video_upload_items_verified_content_type_check check (verified_content_type is null or verified_content_type in ('video/mp4','video/x-m4v','video/quicktime')),
   verified_byte_size bigint,
   verified_checksum_sha256 text,
   verified_width integer,
   verified_height integer,
   verified_duration_ms bigint,
   finalize_claim_token uuid,
   finalize_claim_expires_at timestamptz,
   capability_expires_at timestamptz not null,
   status text not null default 'prepared'
-    constraint video_upload_items_status_check check (status in ('prepared','uploading','finalizing','finalized','failed','expired','canceled')),
+    constraint video_upload_items_status_check check (status in ('prepared','uploading','finalizing','finalized','failed','expired','canceled','cleaning')),
   constraint video_upload_items_claim_shape_check check (
     (status = 'finalizing') = (finalize_claim_token is not null and finalize_claim_expires_at is not null)
   ),
   constraint video_upload_items_finalized_facts_check check ((
     status <> 'finalized' or (
       verified_content_type in ('video/mp4','video/x-m4v','video/quicktime')
       and verified_byte_size between 1 and 104857600
       and (verified_checksum_sha256 is null or verified_checksum_sha256 ~ '^[0-9a-f]{64}$')
       and verified_width is null and verified_height is null and verified_duration_ms is null
       and finalize_claim_token is null and finalize_claim_expires_at is null
@@ -295,41 +325,73 @@ begin
   elsif not found then
     alter table public.media_asset_provenance add constraint media_asset_provenance_media_kind_check
       check (media_kind in ('image','video'));
   end if;
 end $v77_provenance_check$;
 do $v77_provenance_fact_sources$
 declare v_definition text;
 begin
   select pg_get_constraintdef(oid) into v_definition from pg_constraint
     where conrelid='public.media_asset_provenance'::regclass and conname='media_asset_provenance_video_fact_sources_check';
-  if found and v_definition <> 'CHECK (((media_kind <> ''video''::text) OR ((content_type_source = ''storage_head_verified''::text) AND (byte_size_source = ''storage_head_verified''::text) AND (checksum_source = ANY (ARRAY[''storage_digest_verified''::text, ''unavailable''::text])) AND (dimensions_source = ''browser_declared''::text) AND (duration_source = ''browser_declared''::text) AND (((checksum_source = ''unavailable''::text) AND (checksum_sha256 IS NULL)) OR ((checksum_source = ''storage_digest_verified''::text) AND (checksum_sha256 ~ ''^[0-9a-f]{64}$''::text))) AND (width > 0) AND (height > 0) AND ((duration_ms >= 4000) AND (duration_ms <= 300000)))))' then
+  if found and v_definition <> 'CHECK ((((media_kind <> ''video''::text) OR ((content_type_source = ''storage_head_verified''::text) AND (byte_size_source = ''storage_head_verified''::text) AND (checksum_source = ANY (ARRAY[''storage_digest_verified''::text, ''unavailable''::text])) AND (dimensions_source = ''browser_declared''::text) AND (duration_source = ''browser_declared''::text) AND (((checksum_source = ''unavailable''::text) AND (checksum_sha256 IS NULL)) OR ((checksum_source = ''storage_digest_verified''::text) AND (checksum_sha256 ~ ''^[0-9a-f]{64}$''::text))) AND (width > 0) AND (height > 0) AND ((duration_ms >= 4000) AND (duration_ms <= 300000)))) IS TRUE))' then
     raise exception using errcode='P0001',message='v77_schema_collision';
   elsif not found then
-    alter table public.media_asset_provenance add constraint media_asset_provenance_video_fact_sources_check check (
+    alter table public.media_asset_provenance add constraint media_asset_provenance_video_fact_sources_check check ((
       media_kind <> 'video' or (
         content_type_source='storage_head_verified' and byte_size_source='storage_head_verified'
         and checksum_source in ('storage_digest_verified','unavailable')
         and dimensions_source='browser_declared' and duration_source='browser_declared'
         and ((checksum_source='unavailable' and checksum_sha256 is null)
           or (checksum_source='storage_digest_verified' and checksum_sha256 ~ '^[0-9a-f]{64}$'))
         and width>0 and height>0 and duration_ms between 4000 and 300000
       )
-    );
+    ) is true);
   end if;
 end $v77_provenance_fact_sources$;

 alter table public.video_upload_batches enable row level security;
 alter table public.video_upload_items enable row level security;
 revoke all on public.video_upload_batches,public.video_upload_items from public,anon,authenticated,service_role;
 grant select,insert,update,delete on public.video_upload_batches,public.video_upload_items to service_role;

+-- Generic v76 cleanup workers acquire external deletion authority by moving an
+-- outbox row to processing. For video-upload rows, atomically move the item to
+-- a non-finalizable state first. An active finalize claim rejects that lease;
+-- whichever transaction locks the item first wins, so both rights cannot exist.
+create or replace function public.v77_video_cleanup_guard()
+returns trigger language plpgsql security definer set search_path=public,pg_temp as $fn$
+-- vibepin:v77:video-cleanup-guard
+declare v_item public.video_upload_items%rowtype;
+begin
+  if new.status='processing' and new.dedupe_key like 'video-upload:%'
+     and (old.status is distinct from 'processing' or old.lease_token is distinct from new.lease_token) then
+    select * into v_item from public.video_upload_items i
+      where new.dedupe_key='video-upload:'||i.id::text for update;
+    if not found or v_item.status='finalized'
+       or (v_item.status='finalizing' and v_item.finalize_claim_expires_at>now()) then
+      raise exception using errcode='40001',message='cleanup_item_unavailable';
+    end if;
+    update public.video_upload_items set status='cleaning',error_code=coalesce(error_code,'cleanup_leased'),
+      finalize_claim_token=null,finalize_claim_expires_at=null,updated_at=now()
+      where id=v_item.id and (status in ('prepared','failed','expired','canceled','cleaning')
+        or (status='finalizing' and finalize_claim_expires_at<=now()));
+    if not found then raise exception using errcode='40001',message='cleanup_item_unavailable'; end if;
+  end if;
+  return new;
+end $fn$;
+comment on function public.v77_video_cleanup_guard() is 'vibepin:v77:video-cleanup-guard';
+revoke all on function public.v77_video_cleanup_guard() from public,anon,authenticated,service_role;
+drop trigger if exists v77_video_cleanup_guard on public.media_cleanup_outbox;
+create trigger v77_video_cleanup_guard before update on public.media_cleanup_outbox
+  for each row execute function public.v77_video_cleanup_guard();
+comment on trigger v77_video_cleanup_guard on public.media_cleanup_outbox is 'vibepin:v77:video-cleanup-guard';
+
 -- Only server callers receive these RPCs. Their owner argument is server-derived
 -- from the authenticated request or parent intent; no browser role can call them.
 create or replace function public.video_upload_batch_prepare(
   p_owner_user_id uuid,p_idempotency_key text,p_expires_at timestamptz
 ) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $fn$
 -- vibepin:v77:video-upload-batch-prepare
 declare v_batch public.video_upload_batches%rowtype;
 begin
   if p_owner_user_id is null or nullif(btrim(p_idempotency_key),'') is null or p_expires_at is null or p_expires_at<=now() then
     raise exception using errcode='22023',message='invalid_video_upload_batch';
@@ -347,21 +409,23 @@ exception when others then
 end $fn$;
 comment on function public.video_upload_batch_prepare(uuid,text,timestamptz) is 'vibepin:v77:video-upload-batch-prepare';

 create or replace function public.video_upload_item_prepare(
   p_owner_user_id uuid,p_batch_id uuid,p_ordinal integer,p_idempotency_key text,p_private_path text,
   p_declared_content_type text,p_declared_byte_size bigint,p_declared_checksum_sha256 text,
   p_declared_width integer,p_declared_height integer,p_declared_duration_ms bigint
 ) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $fn$
 -- vibepin:v77:video-upload-item-prepare
 declare v_batch public.video_upload_batches%rowtype; v_item public.video_upload_items%rowtype;
-  v_capability_expires_at timestamptz := now()+interval '2 hours';
+  -- Reserve cleanup before issuing a token; post-sign confirmation moves this
+  -- boundary from the actual provider issuance time and retains a settle grace.
+  v_capability_expires_at timestamptz := now()+interval '2 hours 5 minutes';
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
@@ -371,20 +435,21 @@ begin
      or p_declared_width is null or p_declared_width<=0 or p_declared_height is null or p_declared_height<=0
      or p_declared_duration_ms is null or p_declared_duration_ms<4000 or p_declared_duration_ms>300000 then
     raise exception using errcode='22023',message='invalid_declared_video_facts';
   end if;
   select * into v_batch from public.video_upload_batches where id=p_batch_id and owner_user_id=p_owner_user_id for update;
   if not found then raise exception using errcode='P0002',message='video_upload_batch_not_found'; end if;
   if v_batch.expires_at<=now() then raise exception using errcode='55000',message='video_upload_batch_expired'; end if;
   if v_batch.status not in ('prepared','uploading') then raise exception using errcode='55000',message='video_upload_batch_not_preparable'; end if;
   select * into v_item from public.video_upload_items where batch_id=v_batch.id and ordinal=p_ordinal for update;
   if found then
+    if v_item.status<>'prepared' then raise exception using errcode='55000',message='video_upload_item_not_preparable'; end if;
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
@@ -419,44 +484,82 @@ begin
 exception when others then
   raise exception using errcode=sqlstate,message=case sqlerrm
     when 'video_upload_batch_limit_exceeded' then 'video_upload_batch_limit_exceeded'
     when 'invalid_video_upload_item' then 'invalid_video_upload_item'
     when 'invalid_video_content_type' then 'invalid_video_content_type'
     when 'video_upload_too_large' then 'video_upload_too_large'
     when 'invalid_declared_video_facts' then 'invalid_declared_video_facts'
     when 'video_upload_batch_not_found' then 'video_upload_batch_not_found'
     when 'video_upload_batch_expired' then 'video_upload_batch_expired'
     when 'video_upload_batch_not_preparable' then 'video_upload_batch_not_preparable'
+    when 'video_upload_item_not_preparable' then 'video_upload_item_not_preparable'
     when 'video_upload_item_idempotency_conflict' then 'video_upload_item_idempotency_conflict'
     else 'v77_video_upload_error' end;
 end $fn$;
 comment on function public.video_upload_item_prepare(uuid,uuid,integer,text,text,text,bigint,text,integer,integer,bigint) is 'vibepin:v77:video-upload-item-prepare';

+create or replace function public.video_upload_capability_confirm(
+  p_owner_user_id uuid,p_batch_id uuid,p_ordinal integer,p_capability_expires_at timestamptz
+) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $fn$
+-- vibepin:v77:video-upload-capability-confirm
+declare v_batch public.video_upload_batches%rowtype; v_item public.video_upload_items%rowtype; v_outbox public.media_cleanup_outbox%rowtype;
+begin
+  if p_owner_user_id is null or p_batch_id is null or p_ordinal is null or p_capability_expires_at is null
+     or p_capability_expires_at<now()+interval '2 hours'
+     or p_capability_expires_at>now()+interval '2 hours 10 minutes' then
+    raise exception using errcode='22023',message='invalid_video_capability_expiry';
+  end if;
+  select * into v_batch from public.video_upload_batches where id=p_batch_id and owner_user_id=p_owner_user_id for update;
+  if not found then raise exception using errcode='P0002',message='video_upload_batch_not_found'; end if;
+  select * into v_item from public.video_upload_items
+    where batch_id=v_batch.id and ordinal=p_ordinal and owner_user_id=p_owner_user_id for update;
+  if not found then raise exception using errcode='P0002',message='video_upload_item_not_found'; end if;
+  if v_batch.status<>'uploading' or v_batch.expires_at<=now() or v_item.status<>'prepared' then
+    raise exception using errcode='55000',message='video_upload_item_not_confirmable';
+  end if;
+  update public.video_upload_items set capability_expires_at=greatest(capability_expires_at,p_capability_expires_at),updated_at=now()
+    where id=v_item.id returning * into v_item;
+  update public.media_cleanup_outbox set status='pending',lease_token=null,lease_expires_at=null,
+    next_attempt_at=v_item.capability_expires_at,last_error_code=null,dead_lettered_at=null,completed_at=null,updated_at=now()
+    where dedupe_key='video-upload:'||v_item.id::text and status='pending' returning * into v_outbox;
+  if not found then raise exception using errcode='55000',message='video_cleanup_schedule_missing'; end if;
+  return jsonb_build_object('itemId',v_item.id,'status',v_item.status,'capabilityExpiresAt',v_item.capability_expires_at,'cleanupScheduled',true);
+exception when others then
+  raise exception using errcode=sqlstate,message=case sqlerrm
+    when 'invalid_video_capability_expiry' then 'invalid_video_capability_expiry'
+    when 'video_upload_batch_not_found' then 'video_upload_batch_not_found'
+    when 'video_upload_item_not_found' then 'video_upload_item_not_found'
+    when 'video_upload_item_not_confirmable' then 'video_upload_item_not_confirmable'
+    when 'video_cleanup_schedule_missing' then 'video_cleanup_schedule_missing'
+    else 'v77_video_upload_error' end;
+end $fn$;
+comment on function public.video_upload_capability_confirm(uuid,uuid,integer,timestamptz) is 'vibepin:v77:video-upload-capability-confirm';
+
 create or replace function public.video_upload_item_claim(
   p_owner_user_id uuid,p_batch_id uuid,p_ordinal integer,p_claim_token uuid,p_claim_expires_at timestamptz
 ) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $fn$
 -- vibepin:v77:video-upload-item-claim
 declare v_batch public.video_upload_batches%rowtype; v_item public.video_upload_items%rowtype; v_provenance_ready boolean;
 begin
   if p_owner_user_id is null or p_batch_id is null or p_ordinal is null or p_claim_token is null
      or p_claim_expires_at is null or p_claim_expires_at<=now() or p_claim_expires_at>now()+interval '5 minutes' then
     raise exception using errcode='22023',message='invalid_video_upload_claim';
   end if;
   select * into v_batch from public.video_upload_batches where id=p_batch_id and owner_user_id=p_owner_user_id for update;
   if not found then raise exception using errcode='P0002',message='video_upload_batch_not_found'; end if;
   select * into v_item from public.video_upload_items
     where batch_id=v_batch.id and ordinal=p_ordinal and owner_user_id=p_owner_user_id for update;
   if not found then raise exception using errcode='P0002',message='video_upload_item_not_found'; end if;
   if v_item.status='finalized' then
     select exists(select 1 from public.media_asset_provenance p
       where p.owner_user_id=p_owner_user_id and p.bucket_id='generated-private' and p.object_path=v_item.private_path
-        and p.source_type='upload' and p.lifecycle_state='draft' and p.media_kind='video'
+        and p.source_type='upload' and p.lifecycle_state in ('draft','publish_pending','published','retained') and p.media_kind='video'
         and p.content_type is not distinct from v_item.verified_content_type
         and p.byte_size is not distinct from v_item.verified_byte_size
         and p.checksum_sha256 is not distinct from v_item.verified_checksum_sha256
         and p.width is not distinct from v_item.declared_width and p.height is not distinct from v_item.declared_height
         and p.duration_ms is not distinct from v_item.declared_duration_ms
         and p.content_type_source='storage_head_verified' and p.byte_size_source='storage_head_verified'
         and p.checksum_source=case when v_item.verified_checksum_sha256 is null then 'unavailable' else 'storage_digest_verified' end
         and p.dimensions_source='browser_declared' and p.duration_source='browser_declared') into v_provenance_ready;
     if not v_provenance_ready then raise exception using errcode='55000',message='video_upload_provenance_incomplete'; end if;
     return jsonb_build_object('itemId',v_item.id,'status',v_item.status,'claimToken',null,'provenanceReady',true);
@@ -628,20 +731,22 @@ begin
       raise exception using errcode='P0001',message='v77_v76_function_collision';
     end if;
     if position(v_old in v_definition)>0 then v_definition := replace(v_definition,v_old,v_new);
     elsif position(v_new in v_definition)=0 then raise exception using errcode='P0001',message='v77_v76_function_collision'; end if;
     execute v_definition;
   end loop;
 end $v77_v76_video_mime$;

 revoke all on function public.video_upload_batch_prepare(uuid,text,timestamptz) from public,anon,authenticated;
 revoke all on function public.video_upload_item_prepare(uuid,uuid,integer,text,text,text,bigint,text,integer,integer,bigint) from public,anon,authenticated;
+revoke all on function public.video_upload_capability_confirm(uuid,uuid,integer,timestamptz) from public,anon,authenticated;
 revoke all on function public.video_upload_item_claim(uuid,uuid,integer,uuid,timestamptz) from public,anon,authenticated;
 revoke all on function public.video_upload_item_finalize(uuid,uuid,integer,uuid,text,text,bigint,text) from public,anon,authenticated;
 revoke all on function public.video_upload_item_fail(uuid,uuid,integer,uuid,text) from public,anon,authenticated;
 grant execute on function public.video_upload_batch_prepare(uuid,text,timestamptz) to service_role;
 grant execute on function public.video_upload_item_prepare(uuid,uuid,integer,text,text,text,bigint,text,integer,integer,bigint) to service_role;
+grant execute on function public.video_upload_capability_confirm(uuid,uuid,integer,timestamptz) to service_role;
 grant execute on function public.video_upload_item_claim(uuid,uuid,integer,uuid,timestamptz) to service_role;
 grant execute on function public.video_upload_item_finalize(uuid,uuid,integer,uuid,text,text,bigint,text) to service_role;
 grant execute on function public.video_upload_item_fail(uuid,uuid,integer,uuid,text) to service_role;
 notify pgrst,'reload schema';
 commit;
diff --git a/backend/db/rollback_v77_video_media.sql b/backend/db/rollback_v77_video_media.sql
index 95d1af96..6dd323c7 100644
--- a/backend/db/rollback_v77_video_media.sql
+++ b/backend/db/rollback_v77_video_media.sql
@@ -1,30 +1,49 @@
 -- Safe v77 rollback: retain private upload evidence and schema, revoke writes,
 -- and restore v76's original image-only MIME guard for a clean v76 reapply.
 begin;
 do $v77_rollback_preflight$
-declare v_name text; v_type text; v_not_null boolean;
+declare v_name text; v_type text; v_not_null boolean; v_actual boolean; v_definition text; v_proc pg_proc%rowtype;
 begin
   foreach v_name in array array['video_upload_batches','video_upload_items'] loop
     if to_regclass('public.' || v_name) is not null
        and obj_description(to_regclass('public.' || v_name), 'pg_class') is distinct from 'vibepin:v77:' || replace(v_name, '_', '-') then
       raise exception using errcode='P0001',message='v77_rollback_collision';
     end if;
   end loop;
   if to_regclass('public.video_upload_items') is not null then
     select format_type(a.atttypid,a.atttypmod),a.attnotnull into v_type,v_not_null
       from pg_attribute a where a.attrelid='public.video_upload_items'::regclass
         and a.attname='capability_expires_at' and a.attnum>0 and not a.attisdropped;
     if not found or v_type is distinct from 'timestamp with time zone' or not v_not_null then
       raise exception using errcode='P0001',message='v77_rollback_collision';
     end if;
   end if;
+  select pg_get_constraintdef(oid) into v_definition from pg_constraint
+    where conrelid=to_regclass('public.media_asset_provenance') and conname='media_asset_provenance_video_fact_sources_check';
+  if not found or v_definition is distinct from 'CHECK ((((media_kind <> ''video''::text) OR ((content_type_source = ''storage_head_verified''::text) AND (byte_size_source = ''storage_head_verified''::text) AND (checksum_source = ANY (ARRAY[''storage_digest_verified''::text, ''unavailable''::text])) AND (dimensions_source = ''browser_declared''::text) AND (duration_source = ''browser_declared''::text) AND (((checksum_source = ''unavailable''::text) AND (checksum_sha256 IS NULL)) OR ((checksum_source = ''storage_digest_verified''::text) AND (checksum_sha256 ~ ''^[0-9a-f]{64}$''::text))) AND (width > 0) AND (height > 0) AND ((duration_ms >= 4000) AND (duration_ms <= 300000)))) IS TRUE))' then
+    raise exception using errcode='P0001',message='v77_rollback_collision';
+  end if;
+  if to_regprocedure('public.v77_video_cleanup_guard()') is not null then
+    select * into v_proc from pg_proc where oid=to_regprocedure('public.v77_video_cleanup_guard()');
+    if obj_description(v_proc.oid,'pg_proc') is distinct from 'vibepin:v77:video-cleanup-guard'
+       or not v_proc.prosecdef or v_proc.prorettype<>to_regtype('trigger')
+       or md5(replace(replace(v_proc.prosrc,chr(13)||chr(10),chr(10)),chr(13),chr(10)))<>'a5c5b35925778b58bf7bdf3d89455d68' then
+      raise exception using errcode='P0001',message='v77_rollback_collision';
+    end if;
+  end if;
+  select count(*)=1 into v_actual from pg_trigger t where t.tgrelid=to_regclass('public.media_cleanup_outbox')
+    and t.tgname='v77_video_cleanup_guard' and not t.tgisinternal
+    and t.tgfoid=to_regprocedure('public.v77_video_cleanup_guard()') and t.tgenabled='O' and t.tgtype=19;
+  if (to_regprocedure('public.v77_video_cleanup_guard()') is null) is distinct from (not v_actual) then
+    raise exception using errcode='P0001',message='v77_rollback_collision';
+  end if;
 end $v77_rollback_preflight$;
 do $v77_restore_v76_mime$
 declare v_signature text; v_definition text; v_marker text; v_hash text; v_proc pg_proc%rowtype; v_old text := '(''image/png'',''image/jpeg'',''image/webp'',''video/mp4'',''video/x-m4v'',''video/quicktime'')'; v_new text := '(''image/png'',''image/jpeg'',''image/webp'')';
 begin
   for v_signature,v_marker,v_hash in select * from (values
     ('public.publish_asset_settle_materialization(uuid,text,text,uuid,text,text,text,text,bigint,text,text)','vibepin:v76:publish-asset-settle-materialization','05aeaf68837a95a5cdc6177383ee6092'),
     ('public.publish_asset_settle_item(uuid,text,text,uuid,text,integer,text,text,text,bigint,text)','vibepin:v76:publish-asset-settle-item','a05aef6619c3ec795b6ceee080e04843')
   ) expected(signature,marker,body_hash) loop
     if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname=split_part(replace(v_signature,'public.',''),'(',1)
@@ -35,19 +54,22 @@ begin
        or not v_proc.prosecdef or v_proc.prokind<>'f' or v_proc.prorettype<>to_regtype('jsonb')
        or v_proc.proretset or v_proc.provariadic<>0 or v_proc.prolang<>(select oid from pg_language where lanname='plpgsql')
        or v_proc.proconfig is distinct from array['search_path=public, pg_temp']::text[]
        or md5(replace(replace(replace(v_proc.prosrc,v_old,v_new),chr(13)||chr(10),chr(10)),chr(13),chr(10)))<>v_hash then
       raise exception using errcode='P0001',message='v77_rollback_collision';
     end if;
     if position(v_old in v_definition)>0 then execute replace(v_definition,v_old,v_new);
     elsif position(v_new in v_definition)=0 then raise exception using errcode='P0001',message='v77_rollback_collision'; end if;
   end loop;
 end $v77_restore_v76_mime$;
+drop trigger if exists v77_video_cleanup_guard on public.media_cleanup_outbox;
+drop function if exists public.v77_video_cleanup_guard();
 revoke all on public.video_upload_batches,public.video_upload_items from public,anon,authenticated,service_role;
 grant select on public.video_upload_batches,public.video_upload_items to service_role;
 revoke all on function public.video_upload_batch_prepare(uuid,text,timestamptz) from public,anon,authenticated,service_role;
 revoke all on function public.video_upload_item_prepare(uuid,uuid,integer,text,text,text,bigint,text,integer,integer,bigint) from public,anon,authenticated,service_role;
+revoke all on function public.video_upload_capability_confirm(uuid,uuid,integer,timestamptz) from public,anon,authenticated,service_role;
 revoke all on function public.video_upload_item_claim(uuid,uuid,integer,uuid,timestamptz) from public,anon,authenticated,service_role;
 revoke all on function public.video_upload_item_finalize(uuid,uuid,integer,uuid,text,text,bigint,text) from public,anon,authenticated,service_role;
 revoke all on function public.video_upload_item_fail(uuid,uuid,integer,uuid,text) from public,anon,authenticated,service_role;
 notify pgrst,'reload schema';
 commit;
diff --git a/backend/tests/pglite_v37/verify-v77-video-media.mjs b/backend/tests/pglite_v37/verify-v77-video-media.mjs
index 61aea006..4a13c440 100644
--- a/backend/tests/pglite_v37/verify-v77-video-media.mjs
+++ b/backend/tests/pglite_v37/verify-v77-video-media.mjs
@@ -65,20 +65,24 @@ async function asRole(db, role, action) {
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
+async function confirmCapability(db, owner, batchId, ordinal, seconds = 7560) {
+  return (await db.query(`select public.video_upload_capability_confirm(
+    $1,$2,$3,now()+($4::text || ' seconds')::interval) as value`, [owner, batchId, ordinal, seconds])).rows[0].value;
+}
 async function claimItem(db, owner, batchId, ordinal, token, leaseSeconds = 60) {
   return (await db.query(`select public.video_upload_item_claim(
     $1,$2,$3,$4,now()+($5::text || ' seconds')::interval) as value`, [
     owner, batchId, ordinal, token, leaseSeconds,
   ])).rows[0].value;
 }
 async function finalizeItem(db, owner, batchId, ordinal, token, checksum = null) {
   return (await db.query(`select public.video_upload_item_finalize(
     $1,$2,$3,$4,'generated-private','video/mp4',1024,$5) as value`, [
     owner, batchId, ordinal, token, checksum,
@@ -178,34 +182,46 @@ async function run() {

     const provenanceColumns = (await db.query(`select attname from pg_attribute
       where attrelid='public.media_asset_provenance'::regclass and not attisdropped`)).rows.map(row => row.attname);
     for (const column of ["media_kind", "content_type", "byte_size", "checksum_sha256", "width", "height", "duration_ms",
       "content_type_source", "byte_size_source", "checksum_source", "dimensions_source", "duration_source"]) {
       assert(provenanceColumns.includes(column), `v77 adds provenance ${column}`);
     }
     const legacy = await db.query("select media_kind,content_type,byte_size,duration_ms from public.media_asset_provenance where object_path=$1", [`${A}/legacy.png`]);
     assert(JSON.stringify(legacy.rows[0]) === JSON.stringify({ media_kind: "image", content_type: null, byte_size: null, duration_ms: null }),
       "old provenance rows remain valid images without historical data loss");
+    const nullSourceInsert = await rejected(() => db.query(`insert into public.media_asset_provenance(
+      owner_user_id,bucket_id,object_path,source_type,lifecycle_state,media_kind,content_type,byte_size)
+      values($1,'generated-private',$2,'upload','draft','video','video/mp4',20)`, [A, `${A}/null-sources.mp4`]));
+    assert(Boolean(nullSourceInsert), "a video provenance INSERT with NULL fact values/sources fails closed");

     const one = await asRole(db, "service_role", () => prepareBatch(db, A, "batch-key"));
     const again = await asRole(db, "service_role", () => prepareBatch(db, A, "batch-key"));
     const otherOwner = await asRole(db, "service_role", () => prepareBatch(db, B, "batch-key"));
     assert(one.batchId === again.batchId && one.batchId !== otherOwner.batchId, "batch idempotency is owner-scoped");
     const item = await asRole(db, "service_role", () => prepareItem(db, A, one.batchId, 0, "item-key"));
     const itemAgain = await asRole(db, "service_role", () => prepareItem(db, A, one.batchId, 0, "item-key"));
     assert(item.itemId === itemAgain.itemId && item.status === "prepared", "item prepare is idempotent and starts prepared");
     const capabilityGuard = (await db.query(`select i.capability_expires_at,o.status,o.next_attempt_at,o.dedupe_key
       from public.video_upload_items i join public.media_cleanup_outbox o
         on o.dedupe_key='video-upload:'||i.id::text where i.id=$1`, [item.itemId])).rows[0];
     assert(capabilityGuard?.status === "pending" && capabilityGuard.dedupe_key === `video-upload:${item.itemId}`
       && Date.parse(capabilityGuard.next_attempt_at) >= Date.parse(capabilityGuard.capability_expires_at),
       "prepare atomically persists delayed cleanup through the signed capability lifetime");
+    const confirmed = await asRole(db, "service_role", () => confirmCapability(db, A, one.batchId, 0));
+    const confirmedGuard = (await db.query(`select i.capability_expires_at,o.next_attempt_at
+      from public.video_upload_items i join public.media_cleanup_outbox o on o.dedupe_key='video-upload:'||i.id::text
+      where i.id=$1`, [item.itemId])).rows[0];
+    assert(confirmed.cleanupScheduled === true
+      && Date.parse(confirmedGuard.next_attempt_at) === Date.parse(confirmedGuard.capability_expires_at)
+      && Date.parse(confirmedGuard.capability_expires_at) > Date.parse(capabilityGuard.capability_expires_at),
+      "post-sign confirmation extends durable cleanup from the actual capability issuance boundary");
     const changedPrepare = await asRole(db, "service_role", () => rejected(() => db.query(`select public.video_upload_item_prepare(
       $1,$2,0,'item-key',$3,'video/mp4',1024,$4,720,1280,10_000)`,
       [A, one.batchId, `${A}/uploads/${one.batchId}/0.mp4`, "d".repeat(64)])));
     assert(changedPrepare?.message === "video_upload_item_idempotency_conflict", "replay conflicts whenever immutable declared facts differ");

     const claimToken = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
     const competingToken = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
     const claimed = await asRole(db, "service_role", () => claimItem(db, A, one.batchId, 0, claimToken));
     const competingClaim = await asRole(db, "service_role", () => rejected(() => claimItem(db, A, one.batchId, 0, competingToken)));
     assert(claimed.status === "finalizing" && claimed.claimToken === claimToken && competingClaim?.message === "video_upload_item_claimed",
@@ -222,20 +238,30 @@ async function run() {
       content_type_source,byte_size_source,checksum_source,dimensions_source,duration_source
       from public.media_asset_provenance where bucket_id='generated-private' and object_path=$1`, [`${A}/uploads/${one.batchId}/0.mp4`])).rows[0];
     assert(finalized.status === "finalized" && finalized.provenanceReady === true
       && JSON.stringify(finalizedFacts) === JSON.stringify({ status: "finalized", verified_content_type: "video/mp4", verified_byte_size: 1024,
         verified_checksum_sha256: null, verified_width: null, verified_height: null, verified_duration_ms: null, finalize_claim_token: null }),
       "atomic finalization records only storage-verified facts and clears the claim");
     assert(JSON.stringify(provenance) === JSON.stringify({ owner_user_id: A, media_kind: "video", content_type: "video/mp4", byte_size: 1024,
       checksum_sha256: null, width: 1080, height: 1920, duration_ms: 15_000, content_type_source: "storage_head_verified",
       byte_size_source: "storage_head_verified", checksum_source: "unavailable", dimensions_source: "browser_declared", duration_source: "browser_declared" }),
       "the same transaction registers provenance with explicit source/trust labels for observed facts");
+    for (const column of ["content_type_source","byte_size_source","checksum_source","dimensions_source","duration_source","width","height","duration_ms"]) {
+      const nullWrite = await rejected(() => db.query(`update public.media_asset_provenance set ${column}=null
+        where bucket_id='generated-private' and object_path=$1`, [`${A}/uploads/${one.batchId}/0.mp4`]));
+      assert(Boolean(nullWrite), `video provenance rejects NULL ${column}`);
+    }
+    const contradictoryChecksum = await rejected(() => db.query(`update public.media_asset_provenance
+      set checksum_source='storage_digest_verified',checksum_sha256=null where bucket_id='generated-private' and object_path=$1`, [`${A}/uploads/${one.batchId}/0.mp4`]));
+    const unknownSource = await rejected(() => db.query(`update public.media_asset_provenance
+      set content_type_source='unknown' where bucket_id='generated-private' and object_path=$1`, [`${A}/uploads/${one.batchId}/0.mp4`]));
+    assert(Boolean(contradictoryChecksum) && Boolean(unknownSource), "video provenance rejects contradictory or unknown trust sources");
     const finalizedCleanup = (await db.query("select status,completed_at from public.media_cleanup_outbox where dedupe_key=$1", [`video-upload:${item.itemId}`])).rows[0];
     assert(finalizedCleanup.status === "done" && finalizedCleanup.completed_at,
       "atomic finalization cancels the delayed capability cleanup responsibility");

     await db.query("delete from public.media_asset_provenance where bucket_id='generated-private' and object_path=$1", [`${A}/uploads/${one.batchId}/0.mp4`]);
     const incompleteReplay = await asRole(db, "service_role", () => rejected(() => claimItem(db, A, one.batchId, 0, competingToken)));
     assert(incompleteReplay?.message === "video_upload_provenance_incomplete", `finalized replay fails closed when complete provenance is missing: ${incompleteReplay?.message}`);
     await db.query(`insert into public.media_asset_provenance(owner_user_id,bucket_id,object_path,source_type,lifecycle_state,media_kind,
       content_type,byte_size,width,height,duration_ms,content_type_source,byte_size_source,checksum_source,dimensions_source,duration_source)
       values($1,'generated-private',$2,'upload','draft','video','video/mp4',1024,1080,1920,15000,
@@ -257,20 +283,44 @@ async function run() {
     const failed = await asRole(db, "service_role", () => failItem(db, A, failureBatch.batchId, 0, claimToken));
     const failedState = (await db.query("select status,finalize_claim_token from public.video_upload_items where id=$1", [failureItem.itemId])).rows[0];
     const failedCleanup = (await db.query(`select o.status,o.next_attempt_at,i.capability_expires_at
       from public.video_upload_items i join public.media_cleanup_outbox o on o.dedupe_key='video-upload:'||i.id::text
       where i.id=$1`, [failureItem.itemId])).rows[0];
     assert(failed.cleanupAllowed === true && failed.cleanupScheduled === true && failed.status === "failed"
       && failedState.status === "failed" && failedState.finalize_claim_token === null
       && failedCleanup.status === "pending" && Date.parse(failedCleanup.next_attempt_at) >= Date.parse(failedCleanup.capability_expires_at),
       "only the current claim owner receives cleanup authority after atomically preserving delayed cleanup");

+    const barrierBatch = await asRole(db, "service_role", () => prepareBatch(db, A, "cleanup-barrier-batch"));
+    const barrierItem = await asRole(db, "service_role", () => prepareItem(db, A, barrierBatch.batchId, 0, "cleanup-barrier-item"));
+    await asRole(db, "service_role", () => claimItem(db, A, barrierBatch.batchId, 0, claimToken, 120));
+    const barrierOutbox = (await db.query("update public.media_cleanup_outbox set next_attempt_at=now()-interval '1 second' where dedupe_key=$1 returning id", [`video-upload:${barrierItem.itemId}`])).rows[0];
+    const blockedCleanup = await asRole(db, "service_role", () => rejected(() => db.query(
+      "select public.publish_cleanup_lease($1,$2,60)", [barrierOutbox.id, competingToken],
+    )));
+    const barrierFinalize = await asRole(db, "service_role", () => finalizeItem(db, A, barrierBatch.batchId, 0, claimToken));
+    assert(Boolean(blockedCleanup) && barrierFinalize.status === "finalized",
+      "an active finalize claim excludes cleanup deletion authority until atomic finalization settles it");
+
+    const cleanupFirstBatch = await asRole(db, "service_role", () => prepareBatch(db, A, "cleanup-first-batch"));
+    const cleanupFirstItem = await asRole(db, "service_role", () => prepareItem(db, A, cleanupFirstBatch.batchId, 0, "cleanup-first-item"));
+    const cleanupFirstOutbox = (await db.query("update public.media_cleanup_outbox set next_attempt_at=now()-interval '1 second' where dedupe_key=$1 returning id", [`video-upload:${cleanupFirstItem.itemId}`])).rows[0];
+    const cleanupLease = await asRole(db, "service_role", () => db.query(
+      "select public.publish_cleanup_lease($1,$2,60) as value", [cleanupFirstOutbox.id, competingToken],
+    ));
+    const cleanupFirstClaim = await asRole(db, "service_role", () => rejected(() => claimItem(db, A, cleanupFirstBatch.batchId, 0, claimToken)));
+    const cleanupFirstPrepare = await asRole(db, "service_role", () => rejected(() => prepareItem(db, A, cleanupFirstBatch.batchId, 0, "cleanup-first-item")));
+    const cleanupFirstState = (await db.query("select status,finalize_claim_token from public.video_upload_items where id=$1", [cleanupFirstItem.itemId])).rows[0];
+    assert(cleanupLease.rows[0].value.leased === true && cleanupFirstState.status === "cleaning"
+      && cleanupFirstState.finalize_claim_token === null && Boolean(cleanupFirstClaim) && Boolean(cleanupFirstPrepare),
+      "a cleanup lease atomically acquires deletion authority and permanently excludes reissue/claim/finalize success");
+
     const partialBatch = await asRole(db, "service_role", () => prepareBatch(db, A, "partial-batch"));
     const partialFailed = await asRole(db, "service_role", () => prepareItem(db, A, partialBatch.batchId, 0, "partial-failed"));
     const partialWinner = await asRole(db, "service_role", () => prepareItem(db, A, partialBatch.batchId, 1, "partial-winner"));
     await asRole(db, "service_role", () => claimItem(db, A, partialBatch.batchId, 0, claimToken));
     await asRole(db, "service_role", () => failItem(db, A, partialBatch.batchId, 0, claimToken));
     await asRole(db, "service_role", () => claimItem(db, A, partialBatch.batchId, 1, competingToken));
     await asRole(db, "service_role", () => finalizeItem(db, A, partialBatch.batchId, 1, competingToken, null));
     const partialState = await db.query("select id,status from public.video_upload_items where id in ($1,$2) order by ordinal", [partialFailed.itemId, partialWinner.itemId]);
     const partialBatchState = (await db.query("select status from public.video_upload_batches where id=$1", [partialBatch.batchId])).rows[0];
     assert(partialState.rows[0].status === "failed" && partialState.rows[1].status === "finalized" && partialBatchState.status === "failed",
@@ -313,26 +363,27 @@ async function run() {
       $1,$2,1,'too-short',$3,'video/mp4',1024,$4,1080,1920,3999)`, [A, durationBatch.batchId, `${A}/short.mp4`, "a".repeat(64)])));
     const longDuration = await asRole(db, "service_role", () => rejected(() => db.query(`select public.video_upload_item_prepare(
       $1,$2,1,'too-long',$3,'video/mp4',1024,$4,1080,1920,300001)`, [A, durationBatch.batchId, `${A}/long.mp4`, "a".repeat(64)])));
     assert(shortDuration?.message === "invalid_declared_video_facts" && longDuration?.message === "invalid_declared_video_facts",
       "the database shares the 4-second through 5-minute declared duration boundary");

     await db.exec(`set role authenticated; set "request.jwt.claim.sub"='${A}';`);
     const directBatchWrite = await rejected(() => db.query("insert into public.video_upload_batches(owner_user_id,idempotency_key,expires_at) values($1,'client-write',now())", [A]));
     const directItemWrite = await rejected(() => db.query("insert into public.video_upload_items(batch_id,owner_user_id,ordinal,idempotency_key,private_path,declared_content_type,declared_byte_size) values($1,$2,1,'client-item','x','video/mp4',1)", [one.batchId, A]));
     const clientRpc = await rejected(() => db.query("select public.video_upload_batch_prepare($1,'client-rpc',now())", [A]));
+    const clientConfirmRpc = await rejected(() => db.query("select public.video_upload_capability_confirm($1,$2,0,now()+interval '2 hours 5 minutes')", [A, one.batchId]));
     const clientClaimRpc = await rejected(() => db.query("select public.video_upload_item_claim($1,$2,0,$3,now()+interval '1 minute')", [A, one.batchId, claimToken]));
     const clientFinalizeRpc = await rejected(() => db.query("select public.video_upload_item_finalize($1,$2,0,$3,'generated-private','video/mp4',1024,null)", [A, one.batchId, claimToken]));
     const clientFailRpc = await rejected(() => db.query("select public.video_upload_item_fail($1,$2,0,$3,'x')", [A, one.batchId, claimToken]));
     await db.exec("reset role; reset \"request.jwt.claim.sub\";");
-    assert(directBatchWrite && directItemWrite && clientRpc && clientClaimRpc && clientFinalizeRpc && clientFailRpc,
-      "clients have neither direct writes nor any claim/finalize/fail RPC write access");
+    assert(directBatchWrite && directItemWrite && clientRpc && clientConfirmRpc && clientClaimRpc && clientFinalizeRpc && clientFailRpc,
+      "clients have neither direct writes nor any capability/claim/finalize/fail RPC write access");

     for (const mime of ["video/mp4", "video/x-m4v", "video/quicktime"]) {
       const result = await asRole(db, "service_role", () => rejected(() => db.query(
         "select public.publish_asset_settle_item($1,'missing-intent','missing-destination',$2,'media-0',0,'generated-private',$3,$4,1,$5)",
         [A, "33333333-3333-4333-8333-333333333331", `${A}/missing.mp4`, mime, "b".repeat(64)],
       )));
       assert(result?.message === "publish_intent_not_found", `v76 settlement accepts ${mime} before enforcing its intent/lease chain`);
     }
     const v76Rejected = await asRole(db, "service_role", () => rejected(() => db.query(
       "select public.publish_asset_settle_item($1,'missing-intent','missing-destination',$2,'media-0',0,'generated-private',$3,'video/webm',1,$4)",
@@ -357,45 +408,57 @@ async function run() {
       'cleanup',(select coalesce(jsonb_agg(to_jsonb(o) order by o.id),'[]'::jsonb) from public.media_cleanup_outbox o)
     ) as state`);
     await db.exec(rollback); await db.exec(rollback);
     const rollbackTableWrite = await asRole(db, "service_role", () => rejected(() => db.query(
       "insert into public.video_upload_batches(owner_user_id,idempotency_key,expires_at) values($1,'rollback-write',now()+interval '1 hour')", [A],
     )));
     const rollbackRpc = await asRole(db, "service_role", () => rejected(() => db.query(
       "select public.video_upload_batch_prepare($1,'rollback-rpc',now()+interval '1 hour')", [A],
     )));
     const rollbackPrivileges = (await db.query(`select
+      has_function_privilege('service_role',to_regprocedure('public.video_upload_capability_confirm(uuid,uuid,integer,timestamptz)'),'execute') as confirm_execute,
       has_function_privilege('service_role',to_regprocedure('public.video_upload_item_claim(uuid,uuid,integer,uuid,timestamptz)'),'execute') as claim_execute,
       has_function_privilege('service_role',to_regprocedure('public.video_upload_item_finalize(uuid,uuid,integer,uuid,text,text,bigint,text)'),'execute') as finalize_execute,
       has_function_privilege('service_role',to_regprocedure('public.video_upload_item_fail(uuid,uuid,integer,uuid,text)'),'execute') as fail_execute`)).rows[0];
-    assert(rollbackTableWrite && rollbackRpc && !rollbackPrivileges.claim_execute && !rollbackPrivileges.finalize_execute && !rollbackPrivileges.fail_execute,
-      "rollback leaves service_role read-only and removes every v77 claim/finalize/fail execute grant");
+    const rollbackGuard = (await db.query(`select to_regprocedure('public.v77_video_cleanup_guard()') is null as function_removed,
+      not exists(select 1 from pg_trigger where tgrelid='public.media_cleanup_outbox'::regclass and tgname='v77_video_cleanup_guard') as trigger_removed`)).rows[0];
+    assert(rollbackTableWrite && rollbackRpc && !rollbackPrivileges.confirm_execute && !rollbackPrivileges.claim_execute
+      && !rollbackPrivileges.finalize_execute && !rollbackPrivileges.fail_execute && rollbackGuard.function_removed && rollbackGuard.trigger_removed,
+      "rollback leaves service_role read-only, removes the cleanup guard, and revokes every v77 execute grant");
     const v76Restored = (await db.query("select pg_get_functiondef(to_regprocedure($1)) as definition", [
       "public.publish_asset_settle_item(uuid,text,text,uuid,text,integer,text,text,text,bigint,text)",
     ])).rows[0].definition;
     await db.exec(migration);
     const activePrivileges = await db.query(`select
       has_table_privilege('service_role','public.video_upload_items','select') as service_select,
       has_table_privilege('service_role','public.video_upload_items','insert') as service_insert,
       has_table_privilege('service_role','public.video_upload_items','truncate') as service_truncate,
       has_table_privilege('authenticated','public.video_upload_items','select') as authenticated_select,
+      has_function_privilege('service_role',to_regprocedure('public.video_upload_capability_confirm(uuid,uuid,integer,timestamptz)'),'execute') as service_confirm,
       has_function_privilege('service_role',to_regprocedure('public.video_upload_item_claim(uuid,uuid,integer,uuid,timestamptz)'),'execute') as service_claim,
       has_function_privilege('service_role',to_regprocedure('public.video_upload_item_finalize(uuid,uuid,integer,uuid,text,text,bigint,text)'),'execute') as service_finalize,
       has_function_privilege('service_role',to_regprocedure('public.video_upload_item_fail(uuid,uuid,integer,uuid,text)'),'execute') as service_fail,
+      has_function_privilege('authenticated',to_regprocedure('public.video_upload_capability_confirm(uuid,uuid,integer,timestamptz)'),'execute') as authenticated_confirm,
       has_function_privilege('authenticated',to_regprocedure('public.video_upload_item_claim(uuid,uuid,integer,uuid,timestamptz)'),'execute') as authenticated_claim,
       has_function_privilege('authenticated',to_regprocedure('public.video_upload_item_finalize(uuid,uuid,integer,uuid,text,text,bigint,text)'),'execute') as authenticated_finalize,
       has_function_privilege('authenticated',to_regprocedure('public.video_upload_item_fail(uuid,uuid,integer,uuid,text)'),'execute') as authenticated_fail`);
+    const activeGuard = (await db.query(`select
+      not has_function_privilege('service_role',to_regprocedure('public.v77_video_cleanup_guard()'),'execute') as direct_execute_denied,
+      exists(select 1 from pg_trigger where tgrelid='public.media_cleanup_outbox'::regclass and tgname='v77_video_cleanup_guard'
+        and not tgisinternal and tgenabled='O') as trigger_active`)).rows[0];
     assert(activePrivileges.rows[0].service_select && activePrivileges.rows[0].service_insert
       && !activePrivileges.rows[0].service_truncate && !activePrivileges.rows[0].authenticated_select
-      && activePrivileges.rows[0].service_claim && activePrivileges.rows[0].service_finalize && activePrivileges.rows[0].service_fail
-      && !activePrivileges.rows[0].authenticated_claim && !activePrivileges.rows[0].authenticated_finalize && !activePrivileges.rows[0].authenticated_fail,
+      && activePrivileges.rows[0].service_confirm && activePrivileges.rows[0].service_claim && activePrivileges.rows[0].service_finalize && activePrivileges.rows[0].service_fail
+      && !activePrivileges.rows[0].authenticated_confirm && !activePrivileges.rows[0].authenticated_claim && !activePrivileges.rows[0].authenticated_finalize && !activePrivileges.rows[0].authenticated_fail,
     "ordered rollback/reapply restores exactly the active service-only privilege manifest");
+    assert(activeGuard.direct_execute_denied && activeGuard.trigger_active,
+      "cleanup guard is trigger-only and active after ordered reapply");
     const afterReapply = await db.query(`select jsonb_build_object(
       'batches',(select coalesce(jsonb_agg(to_jsonb(b) order by b.id),'[]'::jsonb) from public.video_upload_batches b),
       'items',(select coalesce(jsonb_agg(to_jsonb(i) order by i.id),'[]'::jsonb) from public.video_upload_items i),
       'provenance',(select coalesce(jsonb_agg(to_jsonb(p) order by p.object_path),'[]'::jsonb) from public.media_asset_provenance p),
       'cleanup',(select coalesce(jsonb_agg(to_jsonb(o) order by o.id),'[]'::jsonb) from public.media_cleanup_outbox o)
     ) as state`);
     const v76After = (await db.query("select pg_get_functiondef(to_regprocedure($1)) as definition", [
       "public.publish_asset_settle_item(uuid,text,text,uuid,text,integer,text,text,text,bigint,text)",
     ])).rows[0].definition;
     assert(JSON.stringify(beforeRollback.rows) === JSON.stringify(afterReapply.rows) && v76Restored === v76Before && v76After !== v76Before,
@@ -496,20 +559,32 @@ async function collisionRejections() {
       alter: db => db.exec("grant truncate on public.video_upload_items to authenticated"),
     },
     {
       name: "authenticated column update privilege drift",
       alter: db => db.exec("grant update(verified_content_type) on public.video_upload_items to authenticated"),
     },
     {
       name: "authenticated upload finalize execute drift",
       alter: db => db.exec("grant execute on function public.video_upload_item_finalize(uuid,uuid,integer,uuid,text,text,bigint,text) to authenticated"),
     },
+    {
+      name: "authenticated capability confirm execute drift",
+      alter: db => db.exec("grant execute on function public.video_upload_capability_confirm(uuid,uuid,integer,timestamptz) to authenticated"),
+    },
+    {
+      name: "dropped video cleanup guard trigger",
+      alter: db => db.exec("drop trigger v77_video_cleanup_guard on public.media_cleanup_outbox"),
+    },
+    {
+      name: "unmarked video cleanup guard function",
+      alter: db => db.exec("comment on function public.v77_video_cleanup_guard() is null"),
+    },
     {
       name: "service grant option drift",
       alter: db => db.exec("grant select on public.video_upload_items to service_role with grant option"),
     },
   ]) {
     const db = await dbWithV76();
     try {
       await db.exec(migration);
       await scenario.alter(db);
       const before = (await db.query("select count(*)::int as rows from public.video_upload_items")).rows[0];
@@ -539,20 +614,34 @@ async function collisionRejections() {
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
+      await db.exec(`alter table public.media_asset_provenance drop constraint media_asset_provenance_video_fact_sources_check;
+        alter table public.media_asset_provenance add constraint media_asset_provenance_video_fact_sources_check check (true)`);
+      const before = (await db.query("select has_table_privilege('service_role','public.video_upload_items','insert') as service_insert")).rows[0];
+      const rollbackError = await rejected(() => db.exec(rollback));
+      await db.exec("rollback");
+      const after = (await db.query("select has_table_privilege('service_role','public.video_upload_items','insert') as service_insert")).rows[0];
+      assert(rollbackError?.message === "v77_rollback_collision" && before.service_insert && after.service_insert,
+        "rollback rejects fail-open provenance-source drift before revoking service writes");
+    } finally { await db.close(); }
+  }
   {
     const db = await dbWithV76();
     try {
       await db.exec(migration);
       const signature = "public.publish_asset_settle_item(uuid,text,text,uuid,text,integer,text,text,text,bigint,text)";
       const before = (await db.query("select pg_get_functiondef(to_regprocedure($1)) as definition", [signature])).rows[0].definition;
       await db.exec(`comment on function ${signature} is null`);
       const migrateError = await rejected(() => db.exec(migration));
       await db.exec("rollback");
       const rollbackError = await rejected(() => db.exec(rollback));
diff --git a/web/scripts/test-video-upload-private.ts b/web/scripts/test-video-upload-private.ts
index 90b355e7..851f620b 100644
--- a/web/scripts/test-video-upload-private.ts
+++ b/web/scripts/test-video-upload-private.ts
@@ -22,25 +22,33 @@ function request(url: string, body?: unknown, headers: HeadersInit = {}) {
 }

 function descriptor(ordinal = 0, overrides: Record<string, unknown> = {}) {
   return { ordinal, idempotencyKey: `item_${ordinal}`, filename: "clip.mp4", contentType: "video/mp4", byteSize: MP4_FTYP.byteLength, checksumSha256: SHA, width: 1080, height: 1920, durationMs: 5_000, ...overrides };
 }

 function preparedItem(overrides: Record<string, unknown> = {}) {
   return { batchId: "11111111-1111-4111-8111-111111111111", ordinal: 0, status: "prepared", privatePath: `${OWNER}/video/a.mp4`, declaredContentType: "video/mp4", declaredByteSize: MP4_FTYP.byteLength, declaredChecksumSha256: SHA, declaredWidth: 1080, declaredHeight: 1920, declaredDurationMs: 5_000, expiresAt: "2099-01-01T00:00:00.000Z", ...overrides };
 }

+function readyProvenance(path: string, overrides: Record<string, unknown> = {}) {
+  return { owner_user_id: OWNER, bucket_id: "generated-private", object_path: path, source_type: "upload", intent_id: null,
+    lifecycle_state: "draft", media_kind: "video", content_type: "video/mp4", byte_size: 12, checksum_sha256: null,
+    width: 1080, height: 1920, duration_ms: 5_000, content_type_source: "storage_head_verified", byte_size_source: "storage_head_verified",
+    checksum_source: "unavailable", dimensions_source: "browser_declared", duration_source: "browser_declared", ...overrides };
+}
+
 function storeStub(overrides: Record<string, unknown> = {}) {
   const item = preparedItem();
   return {
     prepareBatch: async () => ({ batchId: item.batchId }),
     prepareItem: async () => ({ status: "prepared" }),
+    confirmCapability: async () => ({ status: "prepared", cleanupScheduled: true }),
     findItem: async () => item,
     claimItem: async (input: { claimToken: string }) => ({ status: "finalizing", claimToken: input.claimToken }),
     finalizeItem: async () => ({ status: "finalized", provenanceReady: true }),
     failItem: async () => ({ status: "failed", cleanupAllowed: true, cleanupScheduled: true }),
     ...overrides,
   };
 }

 async function main() {
   const { handleVideoUploadPrepare, handleVideoUploadFinalize } = await import("../src/lib/server/media/videoUploadHandler");
@@ -54,38 +62,40 @@ async function main() {
     const stat = await storage.stat({ bucket: "generated-private", path: `${OWNER}/video/a.mp4` });
     assert.equal("checksumSha256" in stat, false);
     assert.equal(stat.verifiedChecksumSha256, undefined);
   });

   await test("production store routes claim, atomic finalize, and failure through owner-scoped v77 RPCs", async () => {
     const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
     const db = {
       rpc: async (name: string, args: Record<string, unknown>) => {
         calls.push({ name, args });
+        if (name === "video_upload_capability_confirm") return { data: { status: "prepared", cleanupScheduled: true }, error: null };
         if (name === "video_upload_item_claim") return { data: { status: "finalizing", claimToken: args.p_claim_token }, error: null };
         if (name === "video_upload_item_finalize") return { data: { status: "finalized", provenanceReady: true }, error: null };
         if (name === "video_upload_item_fail") return { data: { status: "failed", cleanupAllowed: true, cleanupScheduled: true }, error: null };
         throw new Error(`unexpected RPC ${name}`);
       },
       from: () => { throw new Error("direct table write is forbidden for lifecycle transitions"); },
     };
     const store = createVideoUploadStore(db);
     const claimToken = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
+    await store.confirmCapability({ ownerUserId: OWNER, batchId: preparedItem().batchId, ordinal: 0, capabilityExpiresAt: "2099-01-01T00:00:00.000Z" });
     await store.claimItem({ ownerUserId: OWNER, batchId: preparedItem().batchId, ordinal: 0, claimToken, claimExpiresAt: "2099-01-01T00:00:00.000Z" });
     await store.finalizeItem({ ownerUserId: OWNER, batchId: preparedItem().batchId, ordinal: 0, claimToken,
       bucketId: "generated-private", contentType: "video/mp4", byteSize: 12, checksumSha256: null });
     const failed = await store.failItem({ ownerUserId: OWNER, batchId: preparedItem().batchId, ordinal: 0, claimToken, code: "invalid_video_container" });
-    assert.deepEqual(calls.map(call => call.name), ["video_upload_item_claim", "video_upload_item_finalize", "video_upload_item_fail"]);
-    assert.equal(calls[1].args.p_verified_checksum_sha256, null);
-    assert.equal("p_verified_width" in calls[1].args, false);
-    assert.equal("p_verified_duration_ms" in calls[1].args, false);
-    assert.equal(calls[2].args.p_claim_token, claimToken);
+    assert.deepEqual(calls.map(call => call.name), ["video_upload_capability_confirm", "video_upload_item_claim", "video_upload_item_finalize", "video_upload_item_fail"]);
+    assert.equal(calls[2].args.p_verified_checksum_sha256, null);
+    assert.equal("p_verified_width" in calls[2].args, false);
+    assert.equal("p_verified_duration_ms" in calls[2].args, false);
+    assert.equal(calls[3].args.p_claim_token, claimToken);
     assert(calls.every(call => call.args.p_owner_user_id === OWNER), "every lifecycle RPC must carry the verified owner");
     assert.equal(failed.cleanupScheduled, true);
   });

   await test("expired or terminal prepare replay never issues another signed capability", async () => {
     const existing = { ...preparedItem(), status: "failed", expiresAt: "2000-01-01T00:00:00.000Z" };
     let signed = 0;
     const response = await handleVideoUploadPrepare(request("https://app.test/prepare", { idempotencyKey: "batch_replay", files: [descriptor()] }), {
       getUserId: async () => OWNER, enabled: true, configured: true,
       store: storeStub({ prepareBatch: async () => ({ batchId: existing.batchId }), prepareItem: async () => ({ status: "failed" }), findItem: async () => existing }),
@@ -97,21 +107,31 @@ async function main() {

   await test("prepare ledger covers the fixed two-hour signed-upload capability", async () => {
     let expiresAt = "";
     const now = new Date("2030-01-01T00:00:00.000Z");
     const response = await handleVideoUploadPrepare(request("https://app.test/prepare", { idempotencyKey: "batch_ttl", files: [descriptor()] }), {
       getUserId: async () => OWNER, enabled: true, configured: true, now: () => now,
       store: storeStub({ prepareBatch: async (input: { expiresAt: string }) => { expiresAt = input.expiresAt; return { batchId: preparedItem().batchId }; }, findItem: async () => null }),
       createSignedUpload: async () => ({ token: "token", signedUrl: "https://storage.test/signed" }),
     });
     assert.equal(response.status, 200);
-    assert.equal(expiresAt, "2030-01-01T02:00:00.000Z");
+    assert.equal(expiresAt, "2030-01-01T02:05:00.000Z");
+  });
+
+  await test("prepare never reveals a signed token unless durable issuance confirmation succeeds", async () => {
+    const response = await handleVideoUploadPrepare(request("https://app.test/prepare", { idempotencyKey: "batch_confirm", files: [descriptor()] }), {
+      getUserId: async () => OWNER, enabled: true, configured: true,
+      store: storeStub({ findItem: async () => null, confirmCapability: async () => { throw new Error("video_upload_store_error"); } }),
+      createSignedUpload: async () => ({ token: "must-not-leak", signedUrl: "https://storage.test/must-not-leak" }),
+    });
+    assert.equal(response.status, 502);
+    assert.doesNotMatch(await response.text(), /must-not-leak/);
   });

   await test("a losing finalize race cannot delete an object finalized by the winner", async () => {
     const item = preparedItem();
     let statCalls = 0; let removed = 0; let claimed = false;
     const deps = {
       getUserId: async () => OWNER, enabled: true, configured: true,
       store: storeStub({
         findItem: async () => item,
         claimItem: async (input: { claimToken: string }) => {
@@ -240,21 +260,22 @@ async function main() {
     assert.equal(response.status, 409);
     assert.deepEqual(await response.json(), { code: "video_upload_conflict", requestId: "req_1" });
   });

   await test("finalize owns an atomic claim before any Storage read", async () => {
     const item = preparedItem();
     let claims = 0;
     const deps = {
       getUserId: async () => OWNER, enabled: true, configured: true,
       store: {
-        prepareBatch: async () => ({ batchId: item.batchId }), prepareItem: async () => ({ status: "prepared" }), findItem: async () => item,
+        prepareBatch: async () => ({ batchId: item.batchId }), prepareItem: async () => ({ status: "prepared" }),
+        confirmCapability: async () => ({ status: "prepared", cleanupScheduled: true }), findItem: async () => item,
         claimItem: async (input: { claimToken: string }) => { claims++; return { status: "finalizing", claimToken: input.claimToken }; },
         finalizeItem: async () => ({ status: "finalized", provenanceReady: true }), failItem: async () => ({ status: "failed", cleanupAllowed: true, cleanupScheduled: true }),
       },
       createSignedUpload: async () => ({ token: "unused", signedUrl: "https://storage.test/unused" }),
       storage: {
         stat: async () => { assert.equal(claims, 1); return { exists: true, contentType: "video/mp4", byteSize: MP4_FTYP.byteLength, verifiedChecksumSha256: SHA }; },
         readRange: async ({ start, end }: { start: number; end: number }) => new Response(MP4_FTYP.slice(start, end + 1), { status: 206, headers: { "content-range": `bytes ${start}-${end}/${MP4_FTYP.byteLength}`, "content-type": "video/mp4" } }), remove: async () => {},
       },
       recordCleanup: async () => {},
     };
@@ -392,89 +413,128 @@ async function main() {
       assert.equal(response.status, name === "upstream 500" || name === "wrong range" || name === "truncated box" ? 503 : 422, name);
       assert.equal(finalized, 0, `${name} must not finalize`);
     }
   });

   await test("video proxy enforces exact ready provenance and serves a single bounded range without provider leakage", async () => {
     let fetches = 0;
     const path = `${OWNER}/videos/a.mp4`;
     const response = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`, { headers: { range: "bytes=4-7" } }), {
       getUserId: async () => OWNER, configured: true,
-      findProvenance: async () => ({ owner_user_id: OWNER, bucket_id: "generated-private", object_path: path, source_type: "upload", intent_id: null, lifecycle_state: "draft", media_kind: "video", content_type: "video/mp4", byte_size: 12 }),
+      findProvenance: async () => readyProvenance(path),
       readRange: async input => { fetches++; assert.deepEqual(input, { bucket: "generated-private", path, start: 4, end: 7 }); return new Response(new Uint8Array([0x66, 0x74, 0x79, 0x70]), { status: 206, headers: { "content-range": "bytes 4-7/12", "content-type": "video/mp4" } }); },
     });
     assert.equal(response.status, 206);
     assert.equal(response.headers.get("content-range"), "bytes 4-7/12");
     assert.equal(response.headers.get("content-length"), "4");
     assert.equal(response.headers.get("vary"), "Cookie, Authorization, Range");
     assert.equal(await response.text(), "ftyp");
     assert.equal(fetches, 1);

     const denied = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`), {
       getUserId: async () => OTHER_OWNER, configured: true,
       findProvenance: async () => null,
       readRange: async () => { throw new Error("must not read"); },
     });
     assert.equal(denied.status, 403);
   });

   await test("video proxy rejects multi and unsatisfiable ranges and redacts upstream failures", async () => {
     const path = `${OWNER}/videos/a.mp4`;
-    const deps = { getUserId: async () => OWNER, configured: true, findProvenance: async () => ({ owner_user_id: OWNER, bucket_id: "generated-private", object_path: path, source_type: "upload", intent_id: null, lifecycle_state: "draft", media_kind: "video", content_type: "video/mp4", byte_size: 12 }), readRange: async () => { throw new Error("https://storage.test/raw?token=secret"); } };
+    const deps = { getUserId: async () => OWNER, configured: true, findProvenance: async () => readyProvenance(path), readRange: async () => { throw new Error("https://storage.test/raw?token=secret"); } };
     const multi = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`, { headers: { range: "bytes=0-1,3-4" } }), deps);
     assert.equal(multi.status, 416);
     const failed = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`), deps);
     assert.equal(failed.status, 502);
     assert.doesNotMatch(await failed.text(), /storage|secret|token/i);
   });

   await test("video proxy supports full, open, and suffix ranges, blocks unsafe lifecycle, and bounds an oversized upstream body", async () => {
     const path = `${OWNER}/videos/a.mp4`;
-    const provenance = { owner_user_id: OWNER, bucket_id: "generated-private", object_path: path, source_type: "upload", intent_id: null, lifecycle_state: "draft", media_kind: "video", content_type: "video/mp4", byte_size: 12 };
+    const provenance = readyProvenance(path);
     const calls: Array<{ start: number; end: number }> = [];
     const deps = { getUserId: async () => OWNER, configured: true, findProvenance: async () => provenance, readRange: async ({ start, end }: { start: number; end: number }) => { calls.push({ start, end }); return new Response(new Uint8Array(end - start + 1), { status: 206, headers: { "content-range": `bytes ${start}-${end}/12`, "content-type": "video/mp4" } }); } };
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
     const bounded = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`, { headers: { range: "bytes=0-3" } }), { ...deps, readRange: async () => new Response(new Uint8Array(9), { status: 206, headers: { "content-range": "bytes 0-3/12", "content-type": "video/mp4" } }) });
     await assert.rejects(() => bounded.arrayBuffer(), /range body exceeded/i, "the proxy must not expose bytes beyond the selected range");
   });

   await test("video proxy rejects upstream status, MIME, range, total, and short-body lies", async () => {
     const path = `${OWNER}/videos/a.mp4`;
-    const provenance = { owner_user_id: OWNER, bucket_id: "generated-private", object_path: path, source_type: "upload", intent_id: null, lifecycle_state: "draft", media_kind: "video", content_type: "video/mp4", byte_size: 12 };
+    const provenance = readyProvenance(path);
     const base = { getUserId: async () => OWNER, configured: true, findProvenance: async () => provenance };
     for (const [name, upstream] of [
       ["status", new Response(new Uint8Array(4), { status: 200, headers: { "content-type": "video/mp4" } })],
       ["mime", new Response(new Uint8Array(4), { status: 206, headers: { "content-range": "bytes 4-7/12", "content-type": "text/plain" } })],
       ["range", new Response(new Uint8Array(4), { status: 206, headers: { "content-range": "bytes 0-3/12", "content-type": "video/mp4" } })],
       ["total", new Response(new Uint8Array(4), { status: 206, headers: { "content-range": "bytes 4-7/99", "content-type": "video/mp4" } })],
     ] as const) {
       const response = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`, { headers: { range: "bytes=4-7" } }), { ...base, readRange: async () => upstream });
       assert.equal(response.status, 502, name);
     }
     const short = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`, { headers: { range: "bytes=4-7" } }), { ...base,
       readRange: async () => new Response(new Uint8Array(3), { status: 206, headers: { "content-range": "bytes 4-7/12", "content-type": "video/mp4" } }) });
     assert.equal(short.status, 206);
     await assert.rejects(() => short.arrayBuffer(), /range body incomplete/i);

     const full200 = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`), { ...base,
       readRange: async () => new Response(new Uint8Array(12), { status: 200, headers: { "content-length": "12", "content-type": "video/mp4" } }) });
     assert.equal(full200.status, 200, "an exact full-object 200 is allowed only for a no-Range request");
+    const malformedFull200 = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`), { ...base,
+      readRange: async () => new Response(new Uint8Array(12), { status: 200, headers: { "content-length": "12", "content-type": "video/mp4", "content-range": "malformed" } }) });
+    assert.equal(malformedFull200.status, 502, "full 200 requires Content-Range to be absent, not merely unparsable");
+  });
+
+  await test("video proxy rejects missing or contradictory provenance trust labels", async () => {
+    const path = `${OWNER}/videos/a.mp4`;
+    const ready = { owner_user_id: OWNER, bucket_id: "generated-private", object_path: path, source_type: "upload", intent_id: null,
+      lifecycle_state: "draft", media_kind: "video", content_type: "video/mp4", byte_size: 12, checksum_sha256: null,
+      width: 1080, height: 1920, duration_ms: 5_000, content_type_source: "storage_head_verified", byte_size_source: "storage_head_verified",
+      checksum_source: "unavailable", dimensions_source: "browser_declared", duration_source: "browser_declared" };
+    for (const provenance of [
+      { ...ready, content_type_source: null }, { ...ready, byte_size_source: "browser_declared" },
+      { ...ready, checksum_source: "storage_digest_verified" }, { ...ready, dimensions_source: null },
+      { ...ready, duration_source: "unknown" }, { ...ready, width: null }, { ...ready, duration_ms: null },
+    ]) {
+      let reads = 0;
+      const response = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`), {
+        getUserId: async () => OWNER, configured: true, findProvenance: async () => provenance,
+        readRange: async () => { reads++; return new Response(); },
+      });
+      assert.equal(response.status, 403);
+      assert.equal(reads, 0);
+    }
+  });
+
+  await test("production store findItem emits exact owner, batch, and ordinal predicates and surfaces query errors", async () => {
+    const predicates: Array<[string, unknown]> = [];
+    const row = { batch_id: preparedItem().batchId, ordinal: 0, status: "prepared", private_path: `${OWNER}/video/a.mp4`,
+      declared_content_type: "video/mp4", declared_byte_size: 20, declared_checksum_sha256: SHA,
+      declared_width: 1080, declared_height: 1920, declared_duration_ms: 5_000, expires_at: "2099-01-01T00:00:00.000Z" };
+    const builder = { select: (_shape: string) => builder, eq: (column: string, value: unknown) => { predicates.push([column, value]); return builder; }, maybeSingle: async () => ({ data: row, error: null }) };
+    const store = createVideoUploadStore({ rpc: async () => ({ data: {}, error: null }), from: (table: string) => { assert.equal(table, "video_upload_items"); return builder; } });
+    assert.equal((await store.findItem(OWNER, row.batch_id, 0))?.privatePath, row.private_path);
+    assert.deepEqual(predicates, [["owner_user_id", OWNER], ["batch_id", row.batch_id], ["ordinal", 0]]);
+    const failingBuilder = { select: (_shape: string) => failingBuilder, eq: (_column: string, _value: unknown) => failingBuilder,
+      maybeSingle: async () => ({ data: null, error: { message: "database unavailable" } }) };
+    const failing = createVideoUploadStore({ rpc: async () => ({ data: {}, error: null }), from: () => failingBuilder });
+    await assert.rejects(() => failing.findItem(OWNER, row.batch_id, 0), /video_upload_store_error/);
   });

   await test("production storage-media route wires verified bearer-or-cookie auth", async () => {
     let captured: Record<string, unknown> | null = null;
     const verified = async () => OWNER;
     const originalLoad = (Module as unknown as { _load: (...args: unknown[]) => unknown })._load;
     (Module as unknown as { _load: (...args: unknown[]) => unknown })._load = function(this: unknown, request: string, parent: unknown, isMain: boolean) {
       if (request.includes("server/authUser")) return { getUserIdFromBearer: async () => null, getUserIdFromBearerOrCookies: verified };
       if (request.includes("media/storageMediaHandler")) return { handleStorageMediaGet: async (_req: Request, deps: Record<string, unknown>) => { captured = deps; return new Response("wired"); } };
       if (request.includes("server/mediaProvenance")) return { createMediaProvenanceStore: () => ({ findExact: async () => null }) };
diff --git a/web/src/lib/server/media/storageMediaHandler.ts b/web/src/lib/server/media/storageMediaHandler.ts
index d621802a..a4c90e45 100644
--- a/web/src/lib/server/media/storageMediaHandler.ts
+++ b/web/src/lib/server/media/storageMediaHandler.ts
@@ -42,39 +42,48 @@ function boundedRangeBody(body: ReadableStream<Uint8Array>, expected: number): R
   }));
 }

 function normalizedType(value: string | null) { return value?.split(";", 1)[0]?.trim().toLowerCase() ?? ""; }
 function contentRange(value: string | null) {
   const match = value && /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value);
   if (!match) return null;
   const parsed = match.slice(1).map(Number);
   return parsed.every(Number.isSafeInteger) ? { start: parsed[0], end: parsed[1], total: parsed[2] } : null;
 }
+function readyVideoFacts(provenance: MediaProvenance) {
+  const checksumReady = provenance.checksum_source === "unavailable" ? provenance.checksum_sha256 == null
+    : provenance.checksum_source === "storage_digest_verified" && typeof provenance.checksum_sha256 === "string" && /^[a-f0-9]{64}$/.test(provenance.checksum_sha256);
+  return provenance.content_type_source === "storage_head_verified" && provenance.byte_size_source === "storage_head_verified"
+    && checksumReady && provenance.dimensions_source === "browser_declared" && provenance.duration_source === "browser_declared"
+    && Number.isSafeInteger(provenance.width) && provenance.width! > 0 && Number.isSafeInteger(provenance.height) && provenance.height! > 0
+    && Number.isSafeInteger(provenance.duration_ms) && provenance.duration_ms! >= 4_000 && provenance.duration_ms! <= 300_000;
+}

 export async function handleStorageMediaGet(req: Request, deps: StorageMediaDeps): Promise<Response> {
   const owner = await deps.getUserId(req).catch(() => null); if (!owner) return empty(401);
   if (!deps.configured) return empty(404);
   const url = new URL(req.url); if (url.searchParams.getAll("path").length !== 1 || [...url.searchParams.keys()].some(key => key !== "path")) return empty(400);
   const path = url.searchParams.get("path"); const unsafe = pathStatus(owner, path); if (unsafe) return empty(unsafe);
   const bucket = deps.bucket ?? VIDEO_UPLOAD_BUCKET;
   const provenance = await deps.findProvenance(owner, bucket, path!).catch(() => null);
-  if (!provenance || provenance.owner_user_id !== owner || provenance.bucket_id !== bucket || provenance.object_path !== path || provenance.media_kind !== "video" || !ALLOWED_VIDEO_LIFECYCLES.has(provenance.lifecycle_state) || !ALLOWED_VIDEO_TYPES.has(provenance.content_type ?? "") || !Number.isSafeInteger(provenance.byte_size) || provenance.byte_size! < 1 || provenance.byte_size! > MAX_VIDEO_UPLOAD_BYTES) return empty(403);
+  if (!provenance || provenance.owner_user_id !== owner || provenance.bucket_id !== bucket || provenance.object_path !== path || provenance.media_kind !== "video" || !ALLOWED_VIDEO_LIFECYCLES.has(provenance.lifecycle_state) || !ALLOWED_VIDEO_TYPES.has(provenance.content_type ?? "") || !Number.isSafeInteger(provenance.byte_size) || provenance.byte_size! < 1 || provenance.byte_size! > MAX_VIDEO_UPLOAD_BYTES || !readyVideoFacts(provenance)) return empty(403);
   const requested = range(req.headers.get("range"), provenance.byte_size!); if (!requested) return empty(416, { "Content-Range": `bytes */${provenance.byte_size}` });
   try {
     const upstream = await deps.readRange({ bucket, path: path!, start: requested.start, end: requested.end });
     const expected = requested.end - requested.start + 1;
     const contentLength = upstream.headers.get("content-length");
     const length = contentLength === null ? null : Number(contentLength);
     const upstreamType = normalizedType(upstream.headers.get("content-type"));
-    const upstreamRange = contentRange(upstream.headers.get("content-range"));
+    const rawContentRange = upstream.headers.get("content-range");
+    const upstreamRange = contentRange(rawContentRange);
     const exactPartial = upstream.status === 206 && upstreamRange?.start === requested.start
       && upstreamRange.end === requested.end && upstreamRange.total === provenance.byte_size;
-    const exactFull200 = !requested.partial && upstream.status === 200 && !upstreamRange && length === expected;
+    const exactFull200 = !requested.partial && upstream.status === 200 && rawContentRange === null && length === expected;
     if (!upstream.body || upstreamType !== provenance.content_type || (!exactPartial && !exactFull200)
       || (length !== null && (!Number.isSafeInteger(length) || length !== expected))) { await upstream.body?.cancel(); return empty(502); }
     return new Response(boundedRangeBody(upstream.body, expected), { status: requested.partial ? 206 : 200, headers: {
       "Content-Type": provenance.content_type!, "Content-Length": String(expected),
       ...(requested.partial ? { "Content-Range": `bytes ${requested.start}-${requested.end}/${provenance.byte_size}` } : {}),
       "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=300", Vary: PRIVATE_VARY, "X-Content-Type-Options": "nosniff",
     } });
   } catch { return empty(502); }
 }
diff --git a/web/src/lib/server/media/videoUploadHandler.ts b/web/src/lib/server/media/videoUploadHandler.ts
index e7d4ee81..5d173d6e 100644
--- a/web/src/lib/server/media/videoUploadHandler.ts
+++ b/web/src/lib/server/media/videoUploadHandler.ts
@@ -1,32 +1,35 @@
 import {
   MAX_VIDEO_DURATION_MS,
   MAX_VIDEO_UPLOAD_BYTES,
   MAX_VIDEO_UPLOAD_ITEMS,
   MIN_VIDEO_DURATION_MS,
   VIDEO_FINALIZE_CLAIM_MS,
   VIDEO_SIGNED_UPLOAD_CAPABILITY_MS,
+  VIDEO_UPLOAD_LEDGER_MS,
+  VIDEO_UPLOAD_SETTLE_GRACE_MS,
 } from "@/lib/videoUploadLimits";

 export const VIDEO_UPLOAD_BUCKET = "generated-private";
 export { MAX_VIDEO_UPLOAD_BYTES, MAX_VIDEO_UPLOAD_ITEMS, MIN_VIDEO_DURATION_MS, MAX_VIDEO_DURATION_MS };
 export const ALLOWED_VIDEO_TYPES = new Set(["video/mp4", "video/x-m4v", "video/quicktime"]);

 type PreparedItem = {
   batchId: string; ordinal: number; status: string; privatePath: string;
   declaredContentType: string; declaredByteSize: number; declaredChecksumSha256: string;
   declaredWidth: number; declaredHeight: number; declaredDurationMs: number; expiresAt: string;
 };

 export type VideoUploadStore = {
   prepareBatch(input: { ownerUserId: string; idempotencyKey: string; expiresAt: string }): Promise<{ batchId: string }>;
   prepareItem(input: { ownerUserId: string; batchId: string; ordinal: number; idempotencyKey: string; privatePath: string; contentType: string; byteSize: number; checksumSha256: string; width: number; height: number; durationMs: number }): Promise<{ status: string }>;
+  confirmCapability(input: { ownerUserId: string; batchId: string; ordinal: number; capabilityExpiresAt: string }): Promise<{ status: string; cleanupScheduled: boolean }>;
   findItem(ownerUserId: string, batchId: string, ordinal: number): Promise<PreparedItem | null>;
   claimItem(input: { ownerUserId: string; batchId: string; ordinal: number; claimToken: string; claimExpiresAt: string }): Promise<{ status: string; claimToken?: string | null; provenanceReady?: boolean }>;
   finalizeItem(input: { ownerUserId: string; batchId: string; ordinal: number; claimToken: string; bucketId: string; contentType: string; byteSize: number; checksumSha256: string | null }): Promise<{ status: string; provenanceReady: boolean }>;
   failItem(input: { ownerUserId: string; batchId: string; ordinal: number; claimToken: string; code: string }): Promise<{ status: string; cleanupAllowed: boolean; cleanupScheduled: boolean }>;
 };

 export type VideoObjectStorage = {
   stat(input: { bucket: string; path: string }): Promise<{ exists: boolean; contentType?: string; byteSize?: number; verifiedChecksumSha256?: string }>;
   readRange(input: { bucket: string; path: string; start: number; end: number }): Promise<Response>;
   remove(input: { bucket: string; path: string }): Promise<void>;
@@ -83,21 +86,21 @@ export async function handleVideoUploadPrepare(req: Request, deps: VideoUploadHa
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
-  try { batch = await deps.store.prepareBatch({ ownerUserId: owner, idempotencyKey: body.idempotencyKey, expiresAt: new Date(now.getTime() + (deps.expiresInMs ?? VIDEO_SIGNED_UPLOAD_CAPABILITY_MS)).toISOString() }); }
+  try { batch = await deps.store.prepareBatch({ ownerUserId: owner, idempotencyKey: body.idempotencyKey, expiresAt: new Date(now.getTime() + (deps.expiresInMs ?? VIDEO_UPLOAD_LEDGER_MS)).toISOString() }); }
   catch (cause) {
     const code = storeErrorCode(cause);
     if (code === "video_upload_batch_expired") return error("video_upload_expired", id, 422);
     if (code === "video_upload_batch_not_preparable") return error("video_upload_not_uploadable", id, 409);
     return error("video_upload_unavailable", id, 503);
   }
   const uploads: Array<{ ordinal: number; path: string; token: string; signedUrl: string; contentType: string; upsert: false }> = [];
   for (const file of descriptors) {
     // A batch replay must use the original random path. The exact item lookup is
     // owner-filtered by the store; its immutable-facts RPC below decides conflicts.
@@ -106,26 +109,30 @@ export async function handleVideoUploadPrepare(req: Request, deps: VideoUploadHa
     catch { return error("video_upload_unavailable", id, 503); }
     if (existing && (Date.parse(existing.expiresAt) <= now.getTime() || existing.status !== "prepared")) {
       return error("video_upload_not_uploadable", id, 409);
     }
     const path = existing?.privatePath ?? (deps.pathFactory ?? defaultPath)(owner, batch.batchId, file.ordinal, file.contentType);
     if (!ownerPath(owner, path)) return error("video_upload_unavailable", id, 503);
     try {
       await deps.store.prepareItem({ ownerUserId: owner, batchId: batch.batchId, ordinal: file.ordinal, idempotencyKey: file.idempotencyKey, privatePath: path, contentType: file.contentType, byteSize: file.byteSize, checksumSha256: file.checksumSha256, width: file.width, height: file.height, durationMs: file.durationMs });
       const signed = await deps.createSignedUpload({ bucket, path, contentType: file.contentType, upsert: false });
       if (!signed.token || !signed.signedUrl) throw new Error("capability unavailable");
+      const issuedAt = deps.now?.() ?? new Date();
+      const confirmation = await deps.store.confirmCapability({ ownerUserId: owner, batchId: batch.batchId, ordinal: file.ordinal,
+        capabilityExpiresAt: new Date(issuedAt.getTime() + VIDEO_SIGNED_UPLOAD_CAPABILITY_MS + VIDEO_UPLOAD_SETTLE_GRACE_MS).toISOString() });
+      if (confirmation.status !== "prepared" || !confirmation.cleanupScheduled) throw new Error("capability confirmation unavailable");
       uploads.push({ ordinal: file.ordinal, path, token: signed.token, signedUrl: signed.signedUrl, contentType: file.contentType, upsert: false });
     } catch (cause) {
       const code = storeErrorCode(cause);
       if (code === "video_upload_item_idempotency_conflict") return error("video_upload_conflict", id, 409);
       if (code === "video_upload_batch_expired") return error("video_upload_expired", id, 422);
-      if (code === "video_upload_batch_not_preparable") return error("video_upload_not_uploadable", id, 409);
+      if (code === "video_upload_batch_not_preparable" || code === "video_upload_item_not_preparable") return error("video_upload_not_uploadable", id, 409);
       return error("video_upload_capability_unavailable", id, 502);
     }
   }
   return Response.json({ ok: true, batchId: batch.batchId, uploads, requestId: id });
 }

 async function readBounded(response: Response, maximum = 64 * 1024): Promise<Uint8Array | null> {
   const reader = response.body?.getReader(); if (!reader) return null;
   const chunks: Uint8Array[] = []; let length = 0;
   try { while (true) { const { done, value } = await reader.read(); if (done) break; if (!value) continue; length += value.byteLength; if (length > maximum) { await reader.cancel(); return null; } chunks.push(value); } }
@@ -159,20 +166,21 @@ async function readInitialRange(response: Response, end: number, total: number,
   return bytes?.byteLength === expected ? bytes : null;
 }
 function safeResult(item: PreparedItem, id: string) { return { ok: true, batchId: item.batchId, ordinal: item.ordinal, proxyUrl: `/api/storage-media?path=${encodeURIComponent(item.privatePath)}`, requestId: id }; }
 function storeErrorCode(value: unknown) {
   const message = value instanceof Error ? value.message : "";
   return new Set([
     "video_upload_item_claimed", "video_upload_claim_lost", "video_upload_provenance_incomplete",
     "video_upload_batch_expired", "video_upload_item_not_finalizable", "video_upload_batch_not_finalizable",
     "video_upload_item_idempotency_conflict", "video_upload_batch_not_found", "video_upload_item_not_found",
     "video_upload_batch_not_preparable", "video_upload_batch_limit_exceeded", "video_upload_too_large",
+    "video_upload_item_not_preparable",
   ]).has(message) ? message : null;
 }

 export async function handleVideoUploadFinalize(req: Request, deps: VideoUploadHandlerDeps): Promise<Response> {
   const id = requestId(req);
   const owner = await deps.getUserId(req).catch(() => null);
   if (!owner) return error("unauthorized", id, 401);
   if (!deps.enabled) return error("video_upload_disabled", id, 404);
   if (!deps.configured || !deps.storage) return error("config_error", id, 503);
   const body = await json(req);
diff --git a/web/src/lib/server/media/videoUploadStore.ts b/web/src/lib/server/media/videoUploadStore.ts
index 6075fe09..cf56708b 100644
--- a/web/src/lib/server/media/videoUploadStore.ts
+++ b/web/src/lib/server/media/videoUploadStore.ts
@@ -6,20 +6,21 @@ type Db = {
 };

 function rpcData(value: unknown): Record<string, unknown> | null {
   return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
 }
 const STABLE_STORE_CODES = new Set([
   "video_upload_item_claimed", "video_upload_claim_lost", "video_upload_provenance_incomplete",
   "video_upload_batch_expired", "video_upload_item_not_finalizable", "video_upload_batch_not_finalizable",
   "video_upload_item_idempotency_conflict", "video_upload_batch_not_found", "video_upload_item_not_found",
   "video_upload_batch_not_preparable", "video_upload_batch_limit_exceeded", "video_upload_too_large",
+  "video_upload_item_not_preparable",
 ]);
 function storeFailure(value: unknown) {
   const message = value && typeof value === "object" && "message" in value ? String((value as { message: unknown }).message) : "";
   const stable = [...STABLE_STORE_CODES].find(code => message === code || message.includes(code));
   return new Error(stable ?? "video_upload_store_error");
 }
 function must<T>(result: { data: unknown; error: unknown }, map: (data: Record<string, unknown>) => T): T {
   const value = rpcData(result.data); if (result.error || !value) throw storeFailure(result.error); return map(value);
 }

@@ -43,20 +44,27 @@ export function createVideoUploadStore(db: Db): VideoUploadStore {
         .select("batch_id,ordinal,status,private_path,declared_content_type,declared_byte_size,declared_checksum_sha256,declared_width,declared_height,declared_duration_ms,expires_at")
         .eq("owner_user_id", ownerUserId).eq("batch_id", batchId).eq("ordinal", ordinal).maybeSingle();
       if (error) throw storeFailure(error);
       if (!data) return null;
       return {
         batchId: data.batch_id, ordinal: data.ordinal, status: data.status, privatePath: data.private_path,
         declaredContentType: data.declared_content_type, declaredByteSize: Number(data.declared_byte_size), declaredChecksumSha256: data.declared_checksum_sha256,
         declaredWidth: Number(data.declared_width), declaredHeight: Number(data.declared_height), declaredDurationMs: Number(data.declared_duration_ms), expiresAt: data.expires_at,
       };
     },
+    async confirmCapability(input) {
+      const result = await db.rpc("video_upload_capability_confirm", {
+        p_owner_user_id: input.ownerUserId, p_batch_id: input.batchId, p_ordinal: input.ordinal,
+        p_capability_expires_at: input.capabilityExpiresAt,
+      });
+      return must(result, data => ({ status: String(data.status ?? ""), cleanupScheduled: data.cleanupScheduled === true }));
+    },
     async finalizeItem(input) {
       const result = await db.rpc("video_upload_item_finalize", {
         p_owner_user_id: input.ownerUserId, p_batch_id: input.batchId, p_ordinal: input.ordinal,
         p_claim_token: input.claimToken, p_bucket_id: input.bucketId, p_verified_content_type: input.contentType,
         p_verified_byte_size: input.byteSize, p_verified_checksum_sha256: input.checksumSha256,
       });
       return must(result, data => ({ status: String(data.status ?? ""), provenanceReady: data.provenanceReady === true }));
     },
     async claimItem(input) {
       const result = await db.rpc("video_upload_item_claim", {
diff --git a/web/src/lib/videoUploadLimits.ts b/web/src/lib/videoUploadLimits.ts
index 42ffe505..9f3e1af2 100644
--- a/web/src/lib/videoUploadLimits.ts
+++ b/web/src/lib/videoUploadLimits.ts
@@ -1,7 +1,10 @@
 export const MAX_VIDEO_UPLOAD_BYTES = 100 * 1024 * 1024;
 export const MAX_VIDEO_UPLOAD_ITEMS = 20;
 export const MIN_VIDEO_DURATION_MS = 4_000;
 export const MAX_VIDEO_DURATION_MS = 5 * 60_000;
 export const VIDEO_FINALIZE_CLAIM_MS = 2 * 60_000;
 /** Supabase signed-upload capabilities are fixed at two hours by the provider. */
 export const VIDEO_SIGNED_UPLOAD_CAPABILITY_MS = 2 * 60 * 60_000;
+/** Covers a final in-flight upload plus the longest finalize claim after token expiry. */
+export const VIDEO_UPLOAD_SETTLE_GRACE_MS = 5 * 60_000;
+export const VIDEO_UPLOAD_LEDGER_MS = VIDEO_SIGNED_UPLOAD_CAPABILITY_MS + VIDEO_UPLOAD_SETTLE_GRACE_MS;
