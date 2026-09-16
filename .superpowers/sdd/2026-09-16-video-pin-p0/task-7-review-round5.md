# Task 7 Round 5 — Integration Fix Independent Review

**Verdict: CHANGES REQUIRED — 0 Critical / 1 Important / 0 Minor.**

Reviewed commit: `2ff6748d4c02a8874de0b8d3148d4ce617183ff1`, compared with parent `6e849139`, in `D:/vp-tmp/wt-video-pin-p0-integration-fix`. Review date: 2026-09-16. This is an independent local review, not the implementer's report or a deployment authorization.

The normal upload-to-publish implementation and every requested formal regression passed. However, the new migration's dependency authorization checks accept two independently reproduced unsafe dependency states. These are one incomplete dependency-manifest finding, not two separate product bugs. No unauthenticated/client bypass was reproduced on the clean official schema; changing these policies/grants first requires privileged database drift.

## Important I1 — v79 accepts unsafe authorization on its existing dependencies

Location: [migrate_v79_video_publish_provenance.sql, line 20](D:/vp-tmp/wt-video-pin-p0-integration-fix/backend/db/migrate_v79_video_publish_provenance.sql:20), especially lines 24–35 and 68–76.

The v76 settlement dependency is pinned by marker, function shape, security-definer configuration, and body hash, but not its execute ACL. Provenance is checked for `relrowsecurity=true`, column/constraint shape, and selected effective table grants, but the policy that actually enforces owner isolation is not checked. An enabled RLS flag does not imply an owner-scoped policy.

Reproduction A, with the real migrations applied to a fresh PGlite database and an OWNER upload row:

```sql
alter policy vibepin_v75_media_owner_select
  on public.media_asset_provenance using (true);
-- Execute the unmodified v79 migration: it succeeds.
set role authenticated;
select set_config('request.jwt.claim.sub', '<OTHER_OWNER_UUID>', false);
select count(*) from public.media_asset_provenance
  where owner_user_id = '<OWNER_UUID>';
-- count = 1; before the policy mutation count = 0.
```

The expected-safe assertion that the migration reject this drift turned red. A different authenticated user could read the source's owner, private path and metadata, even though v79 reported a successful security preflight. The policy change does not alter any checked column, table grant, body hash or RLS-enabled flag.

Reproduction B, independently restoring the original policy first:

```sql
grant execute on function public.publish_asset_settle_item(
  uuid,text,text,uuid,text,integer,text,text,text,bigint,text
) to authenticated;
-- Execute the unmodified v79 migration: it again succeeds.
select has_function_privilege(
  'authenticated',
  'public.publish_asset_settle_item(uuid,text,text,uuid,text,integer,text,text,text,bigint,text)',
  'EXECUTE'
);
-- true remains true after v79 apply.
```

The expected-safe migration rejection assertion also turned red. The v76 `SECURITY DEFINER` settlement entry point remains client-callable despite being an explicitly service-only dependency of v79. This review did not claim a clean-schema exploit or that this grant alone bypasses all of v76's item/lease checks; the demonstrated problem is accepting and retaining a violated execution-authority contract while certifying the dependency.

Recommended fix: extend only the additive v79 preflight. Check the exact/effective/inherited execution permissions of the referenced v76 settlement signature, with service-role execution and no client/public/unknown-role or grant-option expansion. Pin the existing provenance owner-read policy's roles, command, permissiveness and predicate, and reject additional client-readable permissive policies that can OR around owner isolation. Do not silently rewrite a drifted dependency or change v76/v77/v78 migration files.

Acceptance: first apply and reapply both reject each of the above mutations atomically. Add cases for an extra permissive authenticated SELECT policy and inherited dependency EXECUTE. Confirm unchanged dependency definitions, grants, policy and durable rows after rejection, then restore the valid schema and run apply twice / rollback / reapply. Keep clean-schema cross-owner SELECT denied and v79 RPC client execution denied. All currently passing suites must remain green.

## What Passed Independent Inspection And Execution

- v76/v77/v78 migration files are byte-identical to the integrated parent. Git blob IDs: v76 `577f75625ff494a60caaec29491b792e07a26543`; v77 `82a3b1affca1a60a3dc0dc5dc9404eccdd906642`; v78 `3e608406fe1fe8d2eeb04e9dcdb791b722441e2b`. No old migration is modified by this integration fix.
- The new v79 RPC itself has a strict exact-overload, marker, body, signature/configuration and ACL manifest. Apply twice, rollback twice, reapply, body drift, overload drift, inherited execute, direct PUBLIC/authenticated/unknown-role execute, service grant-option, missing service execute, and an unknown default execute grant were exercised. The relevant unsafe states were refused; a failed initial creation left no v79 function behind.
- A marker-preserving mutation of the actual v76 settlement dependency body was refused as `v79_v76_dependency_tamper`.
- v79 requires owner-matching generated-private source and target paths, a private bucket, `source_type=upload`, acceptable lifecycle, video MIME/size, required dimensions/duration and their honest provenance labels. Invalid owner/path/type/lifecycle/source labels and malformed digests are rejected before ready settlement.
- `checksum_source=unavailable` remains null on the historical source row. The production runtime downloads private source bytes, computes SHA-256, checks size/MIME and passes the computed digest to the service-only settlement boundary. A stored `storage_digest_verified` digest must match those bytes. Browser metadata is not promoted into this authority.
- The actual production Storage boundary uses `upsert:false`. An already-existing target is accepted only if size and SHA-256 match. Independent same-length wrong-content and wrong-size targets were rejected. The boundary no longer directly inserts/upserts provenance.
- SQL copies content type, byte size, dimensions, duration and every source label from the authorized source into the publish copy, promotes only the digest label, checks an existing target's exact metadata and intent, then calls the original v76 settlement in the same transaction. A losing/lost v76 lease left zero publish-copy provenance rows; an existing conflicting target row remained unchanged.
- The production settlement adapter passes owner, intent, destination, lease, media key/ordinal and server-resolved source/target locators plus the server digest; it does not accept content/size/dimension/source-label authority from client input. A ready-copy replay still does not reread or re-settle the original upload.
- Round 2–4 regressions remain green: concurrent claimed recovery invokes the provider once; an untouched sibling proceeds on its next pass; a genuine 2-to-1 retry narrows correctly; nonempty media alt text fingerprints; frozen-copy recovery works after original upload loss; legacy image fingerprint and blank optional canonicalization remain stable; actual cron GET scan-to-claim races and legacy POST video bypass remain closed.

## Fresh Formal Test Evidence

All commands below were executed in this worktree; no worker claim was accepted as proof. TS suites used the already installed local runner `D:/vp-tmp/npm-cache-video-pin-p0/_npx/fd45a72a545557e9/node_modules/tsx/dist/cli.mjs`, from the worktree's `web` directory. No package installation was performed.

| Command / suite | Result |
| --- | --- |
| `scripts/test-v79-video-provenance-materialization.ts` | 8 groups passed, 0 expected-safe failures |
| `backend/tests/pglite_v37/verify-v76-publish-assets.mjs` | 280/280 assertions, 2 rounds |
| `backend/tests/pglite_v37/verify-v77-video-media.mjs` | 140 assertions, 0 failures |
| `scripts/test-video-upload-private.ts` | 31 passed, 0 failed |
| `scripts/test-v76-pinterest-video-publish.ts` | 19 passed, 0 failed |
| `scripts/test-v76-pinterest-video-recovery.ts` | 18 production-wrapper/real-SQL probes completed |
| `scripts/test-v78-pinterest-video-manifest.ts` | 10 groups passed; 0 expected-safe failures |
| `scripts/test-v78-pinterest-video-recovery.ts` | 5 groups passed; provider count 1 under concurrency |
| `scripts/test-v78-pinterest-video-upgrade.ts` | Passed official v76 additive upgrade/idempotency checks |
| `scripts/test-publish-due-video-races.ts` | 4 real GET races, provider/durable dispatch count 0 |
| `scripts/test-pinterest-video-legacy-route.ts` | Actual POST video/mixed bypass rejected before provider |
| `scripts/test-pinterest-video-adapter.ts` | 16 passed, 0 failed |
| `npm run typecheck` | Exit 0 |
| `npm run check:test-registry` | 251 tracked; 243 run; 8 reasoned exclusions |
| Scoped ESLint on both changed production modules, both changed/new TS suites and registry | Exit 0; no output |
| `git diff --check 6e849139 2ff6748d` | Exit 0 |

## Independent Mutation / Adversarial Evidence

Probe file retained locally: [task-7-review-round5-probes.ts](D:/vp-tmp/wt-video-pin-p0-integration-fix/.superpowers/sdd/2026-09-16-video-pin-p0/task-7-review-round5-probes.ts). It reuses only the setup/helpers of the formal v79 harness, compiles its independent assertions in memory, and runs against ephemeral PGlite plus the real production Storage wrapper with mocked I/O.

```powershell
# Workdir: D:/vp-tmp/wt-video-pin-p0-integration-fix/web
node D:/vp-tmp/npm-cache-video-pin-p0/_npx/fd45a72a545557e9/node_modules/tsx/dist/cli.mjs ../.superpowers/sdd/2026-09-16-video-pin-p0/task-7-review-round5-probes.ts
```

The probe exited 0 because it explicitly expects and records the two reproduced missing-safety assertions; that exit is not an all-safe verdict. It printed:

```text
EXPECTED-SAFE RED RLS predicate drift should block v79 apply
GAP v79 accepted RLS predicate drift; OTHER_OWNER reads OWNER private provenance
EXPECTED-SAFE RED v76 dependency ACL drift should block v79 apply
GAP v79 accepted authenticated EXECUTE on v76 service-only settlement dependency
```

For a separate sensitivity control, the probe removed only v79's RPC ACL checks from an in-memory copy of the migration. The safe-rejection assertion failed against that mutant, while the unmodified migration rejected the identical unknown-role execute grant. Thus the ACL regression can genuinely detect a weakened implementation. No production file or migration was edited for the mutation.

## Boundaries And Handoff

Only this evidence report is submitted for commit. The executable probe is left untracked for local reproduction per the report-only scope. Production code and migrations are unchanged. No merge, push, deployment, remote database/Storage, real Pinterest/provider call, token refresh, or external model call occurred.

The requested focused tests are green, but I1 prevents approval. Full Web test/build/browser E2E and live migration execution were not requested or rerun in this review and are not claimed. Return for a bounded follow-up after the dependency authorization gate and formal regressions are added.
