// Round6 evidence: re-run every Round5 control, change the two historical bug
// expectations to safe rejections, then independently test first-install/reapply.
// Production source and the historical Round5 probe are never rewritten.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Module from "node:module";
import ts from "../../../web/node_modules/typescript";

const historicalPath = resolve(process.cwd(), "../.superpowers/sdd/2026-09-16-video-pin-p0/task-7-review-round5-probes.ts");
let historical = readFileSync(historicalPath, "utf8");
function replaceExact(from: string, to: string) {
  if (!historical.includes(from)) throw new Error("Historical probe anchor absent: " + from);
  historical = historical.replace(from, to);
}
replaceExact("assert.equal((mutant.match(/aclexplode/g)||[]).length,0);", "assert.ok((mutant.match(/aclexplode/g)||[]).length < (upgrade.match(/aclexplode/g)||[]).length);");
replaceExact("await expectRed('RLS predicate drift should block v79 apply',()=>refuse(upgrade,'v79_v77_dependency_tamper'));", "await refuse(upgrade,'v79_v77_dependency_tamper');");
replaceExact("GAP v79 accepted RLS predicate drift; OTHER_OWNER reads OWNER private provenance", "PASS Round5 RLS gap closed: migration rejects without silently rewriting preexisting drift");
replaceExact("await expectRed('v76 dependency ACL drift should block v79 apply',()=>refuse(upgrade,'v79_v76_dependency_tamper'));", "await refuse(upgrade,'v79_v76_dependency_tamper');");
replaceExact("GAP v79 accepted authenticated EXECUTE on v76 service-only settlement dependency", "PASS Round5 dependency EXECUTE gap closed: migration rejects and leaves evidence intact");
replaceExact("Round5 independent probes complete: 2 dependency authorization gaps reproduced; RPC ACL mutant killed.", "Round6 independent probes complete: Round5 gaps closed, first/reapply authorization drift rejected, and mutation killed.");

const extra = String.raw`
 const snapshot=async()=>JSON.stringify({
  functions:(await db.query("select p.oid::regprocedure::text as signature, pg_get_functiondef(p.oid) as definition,p.proacl::text as acl from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('publish_asset_settle_item','publish_asset_settle_video_item_v79') order by 1")).rows,
  policies:(await db.query("select p.polname,p.polroles,p.polcmd,p.polpermissive,pg_get_expr(p.polqual,p.polrelid) as qual,pg_get_expr(p.polwithcheck,p.polrelid) as withcheck,obj_description(p.oid,'pg_policy') as marker from pg_policy p where polrelid='public.media_asset_provenance'::regclass order by polname")).rows,
  rows:(await db.query('select * from media_asset_provenance order by object_path')).rows,
  flags:(await db.query("select relrowsecurity,relforcerowsecurity from pg_class where oid='public.media_asset_provenance'::regclass")).rows,
 });
 const driftCases=[
  ['RLS USING true','v79_v77_dependency_tamper','alter policy vibepin_v75_media_owner_select on media_asset_provenance using(true)',"alter policy vibepin_v75_media_owner_select on media_asset_provenance using(owner_user_id=auth.uid() and lifecycle_state not in ('unresolved','failed'))"],
  ['additional owner bypass policy','v79_v77_dependency_tamper','create policy r6_extra_read on media_asset_provenance for select to authenticated using(true)','drop policy r6_extra_read on media_asset_provenance'],
  ['RLS disabled','v79_v77_dependency_tamper','alter table media_asset_provenance disable row level security','alter table media_asset_provenance enable row level security'],
  ['force flag changed','v79_v77_dependency_tamper','alter table media_asset_provenance force row level security','alter table media_asset_provenance no force row level security'],
  ['anon EXECUTE','v79_v76_dependency_tamper','grant execute on function '+dependency+' to anon','revoke execute on function '+dependency+' from anon'],
  ['authenticated EXECUTE','v79_v76_dependency_tamper','grant execute on function '+dependency+' to authenticated','revoke execute on function '+dependency+' from authenticated'],
  ['PUBLIC EXECUTE','v79_v76_dependency_tamper','grant execute on function '+dependency+' to public','revoke execute on function '+dependency+' from public'],
  ['unknown direct role EXECUTE','v79_v76_dependency_tamper','create role r6_extra nologin;grant execute on function '+dependency+' to r6_extra','revoke execute on function '+dependency+' from r6_extra;drop role r6_extra'],
  ['service grant option','v79_v76_dependency_tamper','grant execute on function '+dependency+' to service_role with grant option','revoke grant option for execute on function '+dependency+' from service_role'],
  ['missing service EXECUTE','v79_v76_dependency_tamper','revoke execute on function '+dependency+' from service_role','grant execute on function '+dependency+' to service_role'],
  ['inherited authenticated via service role; unchanged raw ACL','v79_v76_dependency_tamper','grant service_role to authenticated','revoke service_role from authenticated'],
  ['inherited anon via service role; unchanged raw ACL','v79_v76_dependency_tamper','grant service_role to anon','revoke service_role from anon'],
 ];
 await db.exec(rollback);
 for(const mode of ['first apply','reapply']) {
  for(const [name,marker,change,restore] of driftCases) {
   await db.exec(change);const before=await snapshot();
   await refuse(upgrade,marker);
   assert.equal(await snapshot(),before,'rejection must not rewrite functions/policies/rows: '+mode+' '+name);
   await db.exec(restore);
   console.log('PASS '+mode+' rejects and preserves '+name);
  }
  await db.exec(upgrade);
 }
 assert.equal(await foreignCount(),0);
 const expectedHistory=JSON.stringify((await db.query('select * from media_asset_provenance order by object_path')).rows);
 await db.exec(upgrade);await db.exec(rollback);await db.exec(rollback);await db.exec(upgrade);
 assert.equal(JSON.stringify((await db.query('select * from media_asset_provenance order by object_path')).rows),expectedHistory);
 console.log('PASS restored owner isolation and apply twice/rollback twice/reapply preserve historical rows');

 // Independent new mutation: remove only the owner-policy/row-security sections,
 // retaining BOTH v76 dependency EXECUTE guards and all v79 function ACL checks.
 const policyOnlyMutant=upgrade.replace(/  if (?:to_regclass\('public\.media_asset_provenance'\)[\s\S]*?|not \(select relrowsecurity[\s\S]*?)  -- v79:dependency-auth-manifest:end/g,'  -- v79:dependency-auth-manifest:end');
 assert.notEqual(policyOnlyMutant,upgrade);
 assert.equal((policyOnlyMutant.match(/has_function_privilege/g)||[]).length,(upgrade.match(/has_function_privilege/g)||[]).length);
 await db.exec('alter policy vibepin_v75_media_owner_select on media_asset_provenance using(true)');
 await expectRed('policy-only manifest mutation',()=>refuse(policyOnlyMutant,'v79_v77_dependency_tamper'));
 await refuse(upgrade,'v79_v77_dependency_tamper');
 await db.exec("alter policy vibepin_v75_media_owner_select on media_asset_provenance using(owner_user_id=auth.uid() and lifecycle_state not in ('unresolved','failed'))");
 await db.exec(upgrade);
 console.log('PASS policy-only mutation killed while unchanged production manifest rejects the same drift');
`;
replaceExact(" await db.close();", extra + "\n await db.close();");
const compiled = ts.transpileModule(historical, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
const historicalModule = new (Module as any)(historicalPath, module);
historicalModule.filename = historicalPath;
historicalModule.paths = (Module as any)._nodeModulePaths(resolve(historicalPath, ".."));
historicalModule._compile(compiled, historicalPath);
