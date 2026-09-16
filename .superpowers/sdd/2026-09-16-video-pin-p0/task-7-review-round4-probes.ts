// Independent exact-ACL regression controls plus an in-memory ACL-check mutant.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Module from "node:module";
import ts from "../../../web/node_modules/typescript";

const probePath=resolve(process.cwd(),"../.superpowers/sdd/2026-09-16-video-pin-p0/task-7-review-probes.ts");
const original=readFileSync(probePath,"utf8");
const prefix=original.slice(0,original.indexOf(" const check=async"));
const checks=String.raw`
 const upgrade=load('backend/db/migrate_v78_video_publish_recovery.sql');
 const rollback=load('backend/db/rollback_v78_video_publish_recovery.sql');
 const signature='public.publish_asset_ready_sources_v78(uuid,text,text)';
 const snapshot=async()=>JSON.stringify((await db.query("select p.oid::regprocedure::text as signature,pg_get_functiondef(p.oid) as definition,p.proacl::text as acl from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('publish_intent_confirm_prepare_v78','publish_asset_claim_ready_v78','publish_asset_ready_sources_v78','publish_provider_attempt_settle_v78') order by 1")).rows);
 const assertRefusedUnchanged=async(sql:string,marker:string)=>{
   const before=await snapshot();let rejected=false;
   try{await db.exec(sql);}catch(error){rejected=String(error).includes(marker);await db.exec('rollback');}
   assert.equal(rejected,true);assert.equal(await snapshot(),before);
 };
 const exactAclCases=[
   ['PUBLIC execute','grant execute on function '+signature+' to public','revoke execute on function '+signature+' from public'],
   ['authenticated execute','grant execute on function '+signature+' to authenticated','revoke execute on function '+signature+' from authenticated'],
   ['service grant option','grant execute on function '+signature+' to service_role with grant option','revoke grant option for execute on function '+signature+' from service_role'],
   ['service execute revoked','revoke execute on function '+signature+' from service_role','grant execute on function '+signature+' to service_role'],
   ['unknown direct role','create role r4_extra_acl nologin; grant execute on function '+signature+' to r4_extra_acl','revoke execute on function '+signature+' from r4_extra_acl; drop role r4_extra_acl'],
 ];
 for(const [name,mutate,restore] of exactAclCases){
   await db.exec(mutate);
   await assertRefusedUnchanged(upgrade,'v78_definition_tamper');
   await assertRefusedUnchanged(rollback,'v78_rollback_definition_tamper');
   await db.exec(restore);console.log('PASS exact ACL reject-and-preserve: '+name);
 }
 const definition=(await db.query('select pg_get_functiondef($1::regprocedure) as definition',[signature])).rows[0] as any;
 await db.exec('drop function '+signature);
 await assertRefusedUnchanged(upgrade,'v78_definition_tamper');
 await assertRefusedUnchanged(rollback,'v78_rollback_definition_tamper');
 await db.exec(definition.definition);
 await db.exec("comment on function "+signature+" is 'vibepin:v78:publish-asset-ready-sources'; revoke all on function "+signature+" from public,anon,authenticated; grant execute on function "+signature+" to service_role");
 console.log('PASS partial RPC manifest rejected atomically');
 const i=makeInput(makeReceipt('r4-preserved'));await deps.confirmPrepare(i);
 const history=(await db.query('select source_identity_fingerprint from publish_intents where intent_id=$1',[i.receipt.intentId])).rows;
 await db.exec('grant update(source_identity_fingerprint) on publish_intents to authenticated');
 await assertRefusedUnchanged(upgrade,'v78_definition_tamper');
 await assertRefusedUnchanged(rollback,'v78_rollback_definition_tamper');
 assert.deepEqual((await db.query('select source_identity_fingerprint from publish_intents where intent_id=$1',[i.receipt.intentId])).rows,history);
 await db.exec('revoke update(source_identity_fingerprint) on publish_intents from authenticated');
 console.log('PASS rejected migration/rollback preserve historical identity and function manifests');

 // Remove only the function ACL checks from an in-memory copy of the migration.
 // The real repository file and owned SQL function bodies remain unchanged.
 const mutant=upgrade
   .replace(/foreach v_grantee in array array\['anon','authenticated','service_role'\] loop\s+v_actual\s*:=\s*has_function_privilege[\s\S]*?end loop;/g,'')
   .replace(/if exists \(select 1 from aclexplode\(coalesce\(v_proc\.proacl[\s\S]*?end if;/g,'');
 assert.notEqual(mutant,upgrade);
 assert.equal((upgrade.match(/aclexplode/g)||[]).length,2);
 assert.equal((mutant.match(/aclexplode/g)||[]).length,0);
 await db.exec('create role r4_mutant_acl nologin; grant execute on function '+signature+' to r4_mutant_acl');
 let caughtExpectedRed=false;
 try{await assertRefusedUnchanged(mutant,'v78_definition_tamper');}catch(error){caughtExpectedRed=error instanceof assert.AssertionError;console.log('EXPECTED RED with ACL checks disabled: '+(error instanceof Error?error.message:String(error)));}
 assert.equal(caughtExpectedRed,true,'the ACL regression assertion must fail against the weakened migration');
 await assertRefusedUnchanged(upgrade,'v78_definition_tamper');
 await db.exec('revoke execute on function '+signature+' from r4_mutant_acl; drop role r4_mutant_acl');
 await db.exec(upgrade);
 console.log('PASS restored production migration rejects the same drift and then reapplies cleanly');
 await db.close();
 console.log('Round4 independent controls: 8 groups passed; ACL mutation killed.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
`;
const compiled=ts.transpileModule(prefix+checks,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
const harness=new (Module as any)(probePath,module);
harness.filename=probePath;harness.paths=(Module as any)._nodeModulePaths(resolve(probePath,".."));
harness._compile(compiled,probePath);
