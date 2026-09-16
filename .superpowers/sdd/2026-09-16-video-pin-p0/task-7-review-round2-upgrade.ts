// Exact-base v76 -> revised v76 migration probe, local PGlite only.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Module from "node:module";
import ts from "../../../web/node_modules/typescript";

const probePath = resolve(process.cwd(), "../.superpowers/sdd/2026-09-16-video-pin-p0/task-7-review-probes.ts");
const original = readFileSync(probePath, "utf8");
let setup = original.slice(0, original.indexOf(" await db.query(`insert into social_connections"));
setup = 'import { execFileSync } from "node:child_process";\n' + setup;
const before = "await db.exec(load(path).replace(/create extension if not exists \"uuid-ossp\";?/gi,''));";
const after = "await db.exec((path === 'backend/db/migrate_v76_publish_asset_materializer.sql' ? execFileSync('git',['show','04b0ebe0:'+path],{cwd:root,encoding:'utf8'}).replace(/\\r\\n?/g,'\\n') : load(path)).replace(/create extension if not exists \"uuid-ossp\";?/gi,''));";
if (!setup.includes(before)) throw new Error("Unexpected setup shape");
setup = setup.replace(before, after);
const tail = String.raw`
 try {
   await db.exec(load('backend/db/migrate_v78_video_publish_recovery.sql'));
   await db.exec(load('backend/db/migrate_v78_video_publish_recovery.sql'));
   await db.exec(load('backend/db/rollback_v77_video_media.sql'));
   await db.exec(load('backend/db/migrate_v77_video_media.sql'));
   await db.exec(load('backend/db/rollback_v78_video_publish_recovery.sql'));
   await db.exec(load('backend/db/migrate_v78_video_publish_recovery.sql'));
   await db.exec("create or replace function public.publish_asset_ready_sources_v78(p_user_id uuid,p_intent_id text,p_destination_id text) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$ begin return '[]'::jsonb; end $$");
   await db.exec("comment on function public.publish_asset_ready_sources_v78(uuid,text,text) is 'vibepin:v78:publish-asset-ready-sources'");
   let rejected=false;
   try { await db.exec(load('backend/db/migrate_v78_video_publish_recovery.sql')); }
   catch(error) { rejected=String(error).includes('v78_definition_tamper'); }
   if(!rejected) throw new Error('same-marker v78 body drift was not rejected');
   console.log('PASS: exact-base v76 upgrades to v78 idempotently across v77 rollback/reapply');
 } catch(error) {
   console.error('FAIL: exact-base v76 -> v78 additive upgrade',error instanceof Error ? error.message : error);
   process.exitCode=1;
 } finally { await db.close(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
`;
const compiled = ts.transpileModule(setup + tail, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
const harness = new (Module as any)(probePath, module);
harness.filename = probePath;
harness.paths = (Module as any)._nodeModulePaths(resolve(probePath, ".."));
harness._compile(compiled, probePath);
