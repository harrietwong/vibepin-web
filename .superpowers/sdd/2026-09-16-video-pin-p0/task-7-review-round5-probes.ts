// Independent review evidence. Local PGlite and mock Storage only; no production edits.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Module from "node:module";
import ts from "../../../web/node_modules/typescript";

const harnessPath = resolve(process.cwd(), "scripts/test-v79-video-provenance-materialization.ts");
const original = readFileSync(harnessPath, "utf8");
const prefix = original.slice(0, original.indexOf("let failures = 0;"));
const checks = String.raw`
import { createSupabasePrivateVideoMaterializationBoundary, materializePrivateVideoSources } from "../src/lib/server/publish/v76PinterestVideoRuntime";
async function main() {
 const db = await createDb();
 const upgrade = load('backend/db/migrate_v79_video_publish_provenance.sql');
 const rollback = load('backend/db/rollback_v79_video_publish_provenance.sql');
 const signature = 'public.publish_asset_settle_video_item_v79(uuid,text,text,uuid,text,integer,text,text,text,text,text)';
 const dependency = 'public.publish_asset_settle_item(uuid,text,text,uuid,text,integer,text,text,text,bigint,text)';
 const refuse = async(sql:string,marker:string) => {
   let rejected=false;
   try { await db.exec(sql); } catch(error) { rejected=String(error).includes(marker); await db.exec('rollback'); }
   assert.equal(rejected,true,'must reject '+marker);
 };
 const expectRed = async(name:string,fn:()=>Promise<void>) => {
   let red=false;
   try { await fn(); } catch(error) { if (!(error instanceof assert.AssertionError)) throw error; red=true; console.log('EXPECTED-SAFE RED '+name+': '+error.message); }
   assert.equal(red,true,name+' must expose missing assertion');
 };
 await insertVerifiedSource(db);

 // The full dependency body is actually pinned; a marker-preserving body edit is refused.
 const definition=(await db.query('select pg_get_functiondef($1::regprocedure) as definition',[dependency])).rows[0] as any;
 await db.exec(definition.definition.replace('-- vibepin:v76:publish-asset-settle-item','-- vibepin:v76:publish-asset-settle-item\n-- independent mutation'));
 await refuse(upgrade,'v79_v76_dependency_tamper');
 await db.exec(definition.definition);
 console.log('PASS same-marker v76 dependency body mutation rejected');

 // Exact/default/effective RPC ACL controls, including rollback preservation.
 for(const [name,change,restore] of [
  ['PUBLIC','grant execute on function '+signature+' to public','revoke execute on function '+signature+' from public'],
  ['authenticated','grant execute on function '+signature+' to authenticated','revoke execute on function '+signature+' from authenticated'],
  ['service grant option','grant execute on function '+signature+' to service_role with grant option','revoke grant option for execute on function '+signature+' from service_role'],
  ['missing service grant','revoke execute on function '+signature+' from service_role','grant execute on function '+signature+' to service_role'],
  ['unknown role','create role r5_rpc_extra nologin; grant execute on function '+signature+' to r5_rpc_extra','revoke execute on function '+signature+' from r5_rpc_extra; drop role r5_rpc_extra'],
 ]) {
  await db.exec(change);await refuse(upgrade,'v79_definition_tamper');await refuse(rollback,'v79_rollback_definition_tamper');await db.exec(restore);
  console.log('PASS v79 apply/rollback exact ACL '+name);
 }
 await db.exec(rollback);
 await db.exec('create role r5_default nologin; alter default privileges in schema public grant execute on functions to r5_default');
 await refuse(upgrade,'v79_definition_tamper');
 assert.equal((await db.query('select to_regprocedure($1) as value',[signature])).rows[0].value,null);
 await db.exec('alter default privileges in schema public revoke execute on functions from r5_default; drop role r5_default');
 await db.exec(upgrade);
 console.log('PASS unknown default EXECUTE atomically refused');

 // Remove only the v79 RPC ACL assertions IN MEMORY. The real regression must turn red.
 const mutant=upgrade
  .replace(/foreach v_grantee in array array\['anon','authenticated','service_role'\] loop\s+v_actual\s*:=\s*has_function_privilege[\s\S]*?end loop;/g,'')
  .replace(/if exists \(select 1 from aclexplode\(coalesce\(v_proc\.proacl[\s\S]*?end if;/g,'');
 assert.notEqual(mutant,upgrade);assert.equal((mutant.match(/aclexplode/g)||[]).length,0);
 await db.exec('create role r5_mutant nologin; grant execute on function '+signature+' to r5_mutant');
 await expectRed('disabled RPC ACL validation mutant',()=>refuse(mutant,'v79_definition_tamper'));
 await refuse(upgrade,'v79_definition_tamper');
 await db.exec('revoke execute on function '+signature+' from r5_mutant; drop role r5_mutant');
 console.log('PASS ACL mutation killed; production SQL rejects same drift');

 // Owner reads are denied by the baseline policy, not merely by RLS being enabled.
 const foreignCount=async()=>{
  await db.exec("set role authenticated; select set_config('request.jwt.claim.sub','"+OTHER_OWNER+"',false)");
  const rows=await db.query('select count(*)::integer as count from public.media_asset_provenance where owner_user_id=$1',[OWNER]);
  await db.exec('reset role');return rows.rows[0].count;
 };
 assert.equal(await foreignCount(),0);
 await db.exec('alter policy vibepin_v75_media_owner_select on public.media_asset_provenance using (true)');
 await expectRed('RLS predicate drift should block v79 apply',()=>refuse(upgrade,'v79_v77_dependency_tamper'));
 assert.equal(await foreignCount(),1);
 console.log('GAP v79 accepted RLS predicate drift; OTHER_OWNER reads OWNER private provenance');
 await db.exec("alter policy vibepin_v75_media_owner_select on public.media_asset_provenance using (owner_user_id=auth.uid() and lifecycle_state not in ('unresolved','failed'))");
 await db.exec('grant execute on function '+dependency+' to authenticated');
 await expectRed('v76 dependency ACL drift should block v79 apply',()=>refuse(upgrade,'v79_v76_dependency_tamper'));
 assert.equal((await db.query("select has_function_privilege('authenticated',$1,'EXECUTE') as allowed",[dependency])).rows[0].allowed,true);
 console.log('GAP v79 accepted authenticated EXECUTE on v76 service-only settlement dependency');
 await db.exec('revoke execute on function '+dependency+' from authenticated');
 await db.exec(upgrade);

 // Reject untrusted source, preserve source evidence, and roll target provenance back if v76 refuses.
 for(const state of ['failed','unresolved']) {
   await db.query('update media_asset_provenance set lifecycle_state=$1 where object_path=$2',[state,SOURCE_PATH]);
   await assert.rejects(settle(db,'bad-state-'+state),/video_source_provenance_required/);
 }
 await db.query("update media_asset_provenance set lifecycle_state='draft',source_type='generation' where object_path=$1",[SOURCE_PATH]);
 await assert.rejects(settle(db,'bad-source-type'),/video_source_provenance_required/);
 await db.query("update media_asset_provenance set source_type='upload' where object_path=$1",[SOURCE_PATH]);
 await assert.rejects(settle(db,'lost-lease',{p_lease_token:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'}),/materialization_lease_lost/);
 assert.equal((await db.query("select count(*)::integer as count from media_asset_provenance where source_type='publish_copy'")).rows[0].count,0);
 console.log('PASS invalid lifecycle/source_type and lost v76 lease leave no target provenance');
 for(const digest of [null,'','abcd','A'.repeat(64)]) await assert.rejects(settle(db,'bad-digest-'+String(digest).slice(0,4),{p_server_checksum_sha256:digest}),/invalid_server_checksum/);
 await settle(db,'copy-conflict');
 const path=OWNER+'/publish/copy-conflict/0-video.mp4';
 const first=(await db.query('select * from media_asset_provenance where object_path=$1',[path])).rows;
 await assert.rejects(settle(db,'copy-conflict-second',{p_target_object_path:path}),/materialized_asset_conflict/);
 assert.deepEqual((await db.query('select * from media_asset_provenance where object_path=$1',[path])).rows,first);
 await db.query("update media_asset_provenance set checksum_source='unavailable',checksum_sha256=null where object_path=$1",[SOURCE_PATH]);
 await settle(db,'promoted');
 assert.equal((await db.query('select checksum_source from media_asset_provenance where object_path=$1',[SOURCE_PATH])).rows[0].checksum_source,'unavailable');
 assert.equal((await db.query('select checksum_sha256 from media_asset_provenance where object_path=$1',[OWNER+'/publish/promoted/0-video.mp4'])).rows[0].checksum_sha256,CHECKSUM);
 console.log('PASS target conflict untouched and unavailable source history remains honest');

 // Actual storage boundary: same-length corrupted pre-existing target must not pass.
 const frozen=receipt('runtime');
 const input={uid:OWNER,receipt:frozen,destination:frozen.destinations[0],nowMs:Date.parse('2026-09-16T12:00:02.000Z')};
 let existing=new Blob(['video-data'],{type:'video/mp4'});
 let uploaded=0,dbWrites=0;
 const storageDb:any={from:()=>{dbWrites++;throw Error('unexpected direct provenance write');},storage:{from:(bucket:string)=>{
   assert.equal(bucket,'generated-private');return {
    upload:async(_path:string,_file:Blob,options:any)=>{assert.equal(options.upsert,false);uploaded++;return{error:{message:'already exists'}};},
    download:async()=>({data:existing,error:null}),
   };
 }}};
 const realStore=createSupabasePrivateVideoMaterializationBoundary(storageDb);
 const boundary:any={
  loadDraft:async()=>({updatedAt:frozen.sourceUpdatedAt,payload:{title:frozen.title,description:frozen.description,altText:frozen.altText,destinationUrl:frozen.destinationUrl,media:frozen.media}}),
  findProvenance:async()=>({ownerUserId:OWNER,bucketId:'generated-private',objectPath:SOURCE_PATH,mediaKind:'video',contentType:'video/mp4',byteSize:10,checksumSha256:null,width:1080,height:1920,durationMs:8000,contentTypeSource:'storage_head_verified',byteSizeSource:'storage_head_verified',checksumSource:'unavailable',dimensionsSource:'browser_declared',durationSource:'browser_declared',lifecycleState:'draft'}),
  download:async()=>new Blob(['video-data'],{type:'video/mp4'}),storePublishCopy:realStore.storePublishCopy,
 };
 const sources=await materializePrivateVideoSources(input,{leaseToken:'lease',deliveryId:'delivery'},boundary);
 assert.equal(sources[0].checksumSha256,CHECKSUM);assert.equal(dbWrites,0);
 existing=new Blob(['video-evil'],{type:'video/mp4'});
 await assert.rejects(materializePrivateVideoSources(input,{leaseToken:'lease',deliveryId:'delivery'},boundary));
 existing=new Blob(['short'],{type:'video/mp4'});
 await assert.rejects(materializePrivateVideoSources(input,{leaseToken:'lease',deliveryId:'delivery'},boundary));
 assert.equal(uploaded,3);assert.equal(dbWrites,0);
 console.log('PASS actual private storage boundary accepts exact replay, rejects wrong hash/size, and does not write provenance');
 await db.close();
 console.log('Round5 independent probes complete: 2 dependency authorization gaps reproduced; RPC ACL mutant killed.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
`;
const compiled = ts.transpileModule(prefix + checks, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
const harness = new (Module as any)(harnessPath, module);
harness.filename = harnessPath;
harness.paths = (Module as any)._nodeModulePaths(resolve(harnessPath, ".."));
harness._compile(compiled, harnessPath);
