// Focused independent NULL/missing-catalog mutations. Local ephemeral PGlite only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(process.cwd(), "..");
const load = (path: string) => readFileSync(resolve(root, path), "utf8").replace(/\r\n?/g, "\n");
const v80 = load("backend/db/migrate_v80_video_poster_operations.sql");
const verifier = load("backend/tests/pglite_v37/verify-v80-video-poster-operations.mjs");
const bootstrap = new Function("load", verifier.slice(verifier.indexOf("async function bootstrap("), verifier.indexOf("async function asRole(")) + "\nreturn bootstrap;")(load);
async function main() {
  const { PGlite } = createRequire(resolve(root, "backend/tests/pglite_v37/package.json"))("@electric-sql/pglite");
  const db = new PGlite(); let passed = 0; let failed = 0;
  try {
    await bootstrap(db); await db.exec(load("backend/db/migrate_v77_video_media.sql")); await db.exec(v80);
    const mutations = [
      { name: "missing path CHECK row", constraint: "video_poster_operations_path_check" },
      { name: "missing state CHECK row", constraint: "video_poster_operations_state_check" },
      { name: "missing primary-key row", constraint: "video_poster_operations_pkey" },
      { name: "missing default row", sql: "alter table public.video_poster_operations alter column state drop default" },
      { name: "explicit NULL default", sql: "alter table public.video_poster_operations alter column state set default null" },
    ];
    for (const mutation of mutations) {
      const original = mutation.constraint ? (await db.query("select pg_get_constraintdef(oid) as v from pg_constraint where conrelid='public.video_poster_operations'::regclass and conname=$1", [mutation.constraint])).rows[0].v : null;
      let rejected = "";
      try {
        await db.exec(mutation.sql ?? `alter table public.video_poster_operations drop constraint ${mutation.constraint}`);
        try { await db.exec(v80); } catch (error) { rejected = (error as Error).message; await db.exec("rollback"); }
      } finally {
        if (mutation.constraint) await db.exec(`alter table public.video_poster_operations add constraint ${mutation.constraint} ${original}`);
        else await db.exec("alter table public.video_poster_operations alter column state set default 'associated'");
      }
      try { assert.match(rejected, /v80_schema_collision/); passed++; console.log(`PASS ${mutation.name} fails closed`); }
      catch (error) { failed++; console.log(`FAIL ${mutation.name}: ${(error as Error).message}`); }
      await db.exec(v80); // Every mutation is restored and independently revalidated.
    }
    const defaults = (await db.query("select pg_get_expr(adbin,adrelid) as v from pg_attrdef where adrelid='public.video_poster_operations'::regclass and adnum=(select attnum from pg_attribute where attrelid='public.video_poster_operations'::regclass and attname='state')")).rows;
    assert.equal(defaults[0].v, "'associated'::text");
  } finally { await db.close(); }
  console.log(JSON.stringify({ passed, failed, restoredCleanReapply: true }));
  if (failed) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
