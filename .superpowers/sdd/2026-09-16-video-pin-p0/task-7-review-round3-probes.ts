// Independent v78 ownership/ACL/rollback probes using local PGlite only.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Module from "node:module";
import ts from "../../../web/node_modules/typescript";

const probePath = resolve(process.cwd(), "../.superpowers/sdd/2026-09-16-video-pin-p0/task-7-review-probes.ts");
const original = readFileSync(probePath, "utf8");
const prefix = original.slice(0, original.indexOf(" const check=async"));
const checks = String.raw`
 let failures=0;
 const safe=async(name:string,fn:()=>Promise<void>)=>{try{await fn();console.log('PASS '+name);}catch(error){failures++;console.error('FAIL '+name,error instanceof Error?error.message:error);}};
 const upgrade=load('backend/db/migrate_v78_video_publish_recovery.sql');
 const rollback=load('backend/db/rollback_v78_video_publish_recovery.sql');
 const sig='public.publish_asset_ready_sources_v78(uuid,text,text)';
 await safe('fresh install RPCs deny anon/authenticated and allow service only',async()=>{
   const r=await db.query("select p.oid::regprocedure::text as sig,has_function_privilege('anon',p.oid,'EXECUTE') as anon,has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated,has_function_privilege('service_role',p.oid,'EXECUTE') as service from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like '%_v78'");
   assert.equal(r.rows.length,4);for(const row of r.rows as any[]){assert.equal(row.anon,false);assert.equal(row.authenticated,false);assert.equal(row.service,true);}
 });
 await safe('v78 apply twice and rollback twice preserve source identity and reapply',async()=>{
   const i=makeInput(makeReceipt('r3-history'));await deps.confirmPrepare(i);
   const prior=await db.query('select source_identity_fingerprint from publish_intents where intent_id=$1',[i.receipt.intentId]);
   await db.exec(upgrade);await db.exec(upgrade);await db.exec(rollback);await db.exec(rollback);
   const absent=await db.query("select count(*)::int as n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like '%_v78'");assert.equal((absent.rows[0] as any).n,0);
   const after=await db.query('select source_identity_fingerprint from publish_intents where intent_id=$1',[i.receipt.intentId]);assert.deepEqual(after.rows,prior.rows);
   await db.exec(upgrade);
 });
 await safe('migration and rollback reject same-marker body drift',async()=>{
   const before=await db.query('select pg_get_functiondef($1::regprocedure) as definition',[sig]);
   await db.exec("create or replace function public.publish_asset_ready_sources_v78(p_user_id uuid,p_intent_id text,p_destination_id text) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$ begin return '[]'::jsonb; end $$");
   let applyRejected=false,rollbackRejected=false;
   try{await db.exec(upgrade);}catch(e){applyRejected=String(e).includes('v78_definition_tamper');await db.exec('rollback');}
   try{await db.exec(rollback);}catch(e){rollbackRejected=String(e).includes('v78_rollback_definition_tamper');await db.exec('rollback');}
   await db.exec((before.rows[0] as any).definition);
   assert.equal(applyRejected,true);assert.equal(rollbackRejected,true);
 });
 await safe('migration rejects unexpected overload',async()=>{
   await db.exec("create function public.publish_asset_ready_sources_v78(text) returns jsonb language sql security definer as $$ select '{}'::jsonb $$");
   let rejected=false;try{await db.exec(upgrade);}catch(e){rejected=String(e).includes('v78_definition_tamper');await db.exec('rollback');}
   await db.exec('drop function public.publish_asset_ready_sources_v78(text)');assert.equal(rejected,true);
 });
 await safe('rollback rejects unexpected overload instead of leaving an exposed RPC',async()=>{
   await db.exec("create function public.publish_asset_ready_sources_v78(text) returns jsonb language sql security definer as $$ select '{}'::jsonb $$");
   let rejected=false;try{await db.exec(rollback);}catch(e){rejected=String(e).includes('tamper');await db.exec('rollback');}
   const remains=await db.query("select to_regprocedure('public.publish_asset_ready_sources_v78(text)')::text as overload,has_function_privilege('authenticated','public.publish_asset_ready_sources_v78(text)','EXECUTE') as client_callable");
   console.log('rollback overload result',JSON.stringify(remains.rows));
   await db.exec('drop function public.publish_asset_ready_sources_v78(text)');await db.exec(upgrade);
   assert.equal(rejected,true,'rollback must fail closed before touching recognized RPCs when an overload exists');
 });
 await safe('same-marker identity column type drift is rejected',async()=>{
   await db.exec('alter table publish_intents alter column source_identity_fingerprint type varchar(64)');
   let rejected=false;try{await db.exec(upgrade);}catch(e){rejected=String(e).includes('tamper');await db.exec('rollback');}
   const shape=await db.query("select format_type(atttypid,atttypmod) as type from pg_attribute where attrelid='public.publish_intents'::regclass and attname='source_identity_fingerprint'");
   console.log('accepted identity column shape',JSON.stringify(shape.rows));
   await db.exec('alter table publish_intents alter column source_identity_fingerprint type text');
   assert.equal(rejected,true,'marker alone must not bless an unexpected column definition');
 });
 await safe('identity column nullability, default, and client grant drift are rejected',async()=>{
   await db.exec('alter table publish_intents alter column source_identity_fingerprint set not null');
   let nullabilityRejected=false;try{await db.exec(upgrade);}catch(e){nullabilityRejected=String(e).includes('tamper');await db.exec('rollback');}
   await db.exec('alter table publish_intents alter column source_identity_fingerprint drop not null');
   await db.exec("alter table publish_intents alter column source_identity_fingerprint set default '0'");
   let defaultRejected=false;try{await db.exec(upgrade);}catch(e){defaultRejected=String(e).includes('tamper');await db.exec('rollback');}
   await db.exec('alter table publish_intents alter column source_identity_fingerprint drop default');
   await db.exec('grant select(source_identity_fingerprint) on publish_intents to authenticated');
   let applyGrantRejected=false,rollbackGrantRejected=false;
   try{await db.exec(upgrade);}catch(e){applyGrantRejected=String(e).includes('tamper');await db.exec('rollback');}
   try{await db.exec(rollback);}catch(e){rollbackGrantRejected=String(e).includes('tamper');await db.exec('rollback');}
   await db.exec('revoke select(source_identity_fingerprint) on publish_intents from authenticated');
   assert.equal(nullabilityRejected,true);assert.equal(defaultRejected,true);assert.equal(applyGrantRejected,true);assert.equal(rollbackGrantRejected,true);
 });
 await safe('reapply refuses inherited client execute privilege drift',async()=>{
   const i=makeInput(makeReceipt('r3-client-grant'));await deps.confirmPrepare(i);const lease=await deps.leaseMaterialization(i);
   for(const source of await deps.materializeSources(i,lease))await deps.settleItem(i,lease,source);
   await db.exec('create role v78_probe_reader nologin; grant v78_probe_reader to authenticated; grant execute on function public.publish_asset_ready_sources_v78(uuid,text,text) to v78_probe_reader');
   let rejected=false,rollbackRejected=false;try{await db.exec(upgrade);}catch(e){rejected=String(e).includes('tamper');await db.exec('rollback');}
   try{await db.exec(rollback);}catch(e){rollbackRejected=String(e).includes('tamper');await db.exec('rollback');}
   const r=await db.query('select has_function_privilege($1,$2,$3) as client_callable',['authenticated',sig,'EXECUTE']);
   console.log('reapply after privilege drift',JSON.stringify({rejected,rows:r.rows}));
   await db.exec("set role authenticated; set request.jwt.claim.sub='22222222-2222-4222-8222-222222222222'");
   let leakedAssetCount=0;
   try{const result=await db.query('select publish_asset_ready_sources_v78($1,$2,$3) as value',[A,i.receipt.intentId,i.destination.id]);leakedAssetCount=(result.rows[0] as any).value.length;}finally{await db.exec('reset role');}
   console.log('cross-owner ready-asset metadata exposed to authenticated role',leakedAssetCount);
   await db.exec('revoke execute on function public.publish_asset_ready_sources_v78(uuid,text,text) from v78_probe_reader; revoke v78_probe_reader from authenticated; drop role v78_probe_reader');
   assert.equal(rejected,true,'server-only RPC privilege drift must be rejected, not retained');assert.equal(rollbackRejected,true);
 });
 await safe('post-create validation rejects default EXECUTE granted to an unowned role',async()=>{
   await db.exec(rollback);await db.exec('create role v78_probe_default nologin');
   await db.exec('alter default privileges grant execute on functions to v78_probe_default');
   let rejected=false;try{await db.exec(upgrade);}catch(e){rejected=String(e).includes('tamper');await db.exec('rollback');}
   const absent=await db.query("select count(*)::int as n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('publish_intent_confirm_prepare_v78','publish_asset_claim_ready_v78','publish_asset_ready_sources_v78','publish_provider_attempt_settle_v78')");
   await db.exec('alter default privileges revoke execute on functions from v78_probe_default');await db.exec('drop role v78_probe_default');await db.exec(upgrade);
   assert.equal(rejected,true);assert.equal((absent.rows[0] as any).n,0);
 });
 await safe('NULL, blank, and malformed source fingerprints reject atomically before graph creation',async()=>{
   for(const [suffix,fingerprint] of [['null',null],['blank',''],['short','a'.repeat(63)]]){
     const r=makeReceipt('r3-'+suffix+'-identity');let rejected=false;
     try{await db.query('select publish_intent_confirm_prepare_v78($1,$2,$3)',[A,JSON.stringify(r),fingerprint]);}catch(e){rejected=String(e).includes('invalid_source_identity_fingerprint');}
     const count=await db.query('select count(*)::int as n from publish_intents where intent_id=$1',[r.intentId]);
     assert.equal(rejected,true);assert.equal((count.rows[0] as any).n,0);
   }
 });
 await db.close();console.log('Round3 expected-safe failures:',failures);if(failures)process.exitCode=1;
}
main().catch(error=>{console.error(error);process.exitCode=1;});
`;
const compiled=ts.transpileModule(prefix+checks,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
const harness=new (Module as any)(probePath,module);
harness.filename=probePath;harness.paths=(Module as any)._nodeModulePaths(resolve(probePath,".."));
harness._compile(compiled,probePath);
