// Independent review probes. Local PGlite + production TS; no external I/O.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '../../../backend/tests/pglite_v37/node_modules/@electric-sql/pglite';
import { createV76RpcVideoPublishDependencies, dispatchV76PinterestVideo } from '../../../web/src/lib/server/publish/v76PinterestVideoPublish';
import { inspectV76VideoPublishState, materializePrivateVideoSources } from '../../../web/src/lib/server/publish/v76PinterestVideoRuntime';
import { buildDueVideoReceipt } from '../../../web/src/lib/server/publish/v76PinterestVideoBindings';
import { publishConfirmationFingerprint, stablePublishString, sha256Hex } from '../../../web/src/lib/studio/publishConfirmation';
import { validateImmediatePublishReceipt } from '../../../web/src/lib/server/publish/confirmationReceipt';

const root = resolve(process.cwd(), '..');
const load = (path: string) => readFileSync(resolve(root, path), 'utf8').replace(/\r\n?/g, '\n');
const A = '11111111-1111-4111-8111-111111111111';
const C1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const C2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const ds = [C1,C2].map((id, i) => ({id:`pinterest:${id}`,provider:'pinterest',socialConnectionId:id,boardId:`board-${i}`}));
const revision = '2026-09-16T12:00:00.000Z';
const file = new Blob(['video-data'], {type:'video/mp4'});
const media = [{id:'video-1',kind:'video',url:`/api/storage-media?path=${encodeURIComponent(`${A}/uploads/video.mp4`)}`,source:'upload',durationMs:8000}];

async function main() {
 const db = new PGlite();
 await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
 create schema auth; create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 create schema storage; create table storage.buckets(id text primary key,name text not null,public boolean not null);
 create table storage.objects(id uuid primary key,bucket_id text not null,name text not null,owner_id uuid);
 grant usage on schema storage to authenticated,service_role;
 grant select on storage.buckets,storage.objects to authenticated; grant select,insert,update,delete on storage.buckets,storage.objects to service_role;
 alter table storage.objects enable row level security; alter table storage.objects force row level security;
 create function public.uuid_generate_v4() returns uuid language sql volatile as $$ select gen_random_uuid() $$;
 alter default privileges in schema public grant execute on functions to service_role;`);
 for (const path of ['api/migrations/001_pinterest_connections.sql','backend/db/migrate_v49_pinterest_token_version.sql',
 'backend/db/migrate_v32_social_connections.sql','backend/db/migrate_v59_social_pinterest_unify.sql',
 'backend/db/migrate_v72_publish_intent_idempotency.sql','backend/db/migrate_v73_publish_intent_retry_lineage.sql',
 'backend/db/migrate_v75_media_provenance.sql','backend/db/migrate_v76_publish_asset_materializer.sql','backend/db/migrate_v77_video_media.sql']) {
  await db.exec(load(path).replace(/create extension if not exists "uuid-ossp";?/gi,''));
 }
 await db.query(`insert into social_connections(id,user_id,provider,provider_account_id,connection_status,auth_provider) values ($1,$3,'pinterest','a1','connected','official'),($2,$3,'pinterest','a2','connected','official')`,[C1,C2,A]);
 await db.query(`insert into storage.buckets values('generated-private','generated-private',false) on conflict(id) do nothing`);
 const readDb:any = {from(table:string) {
   let columns='*'; const filters:any[]=[]; let order=''; let limit='';
   const q:any={select(v:string){columns=v;return q;},eq(k:string,v:any){filters.push([k,v]);return q;},order(k:string,o:any){order=` order by ${k} ${o.ascending?'asc':'desc'}`;return q;},limit(n:number){limit=` limit ${n}`;return q;},async maybeSingle(){
     const r=await db.query(`select ${columns} from ${table} where ${filters.map(([k],i)=>`${k}=$${i+1}`).join(' and ')}${order}${limit}`,filters.map(([,v])=>v));return {data:r.rows[0]??null,error:null};
   }};return q;
 }};
 let currentRevision=revision;
 let currentMedia:any=media;
 let currentTitle='Video';
 let calls=0;
 const materializer:any={
  loadDraft:async()=>({updatedAt:currentRevision,payload:{title:currentTitle,description:'',altText:'',destinationUrl:'',media:currentMedia}}),
  findProvenance:async(_uid:any,bucket:any,path:any)=>({ownerUserId:A,bucketId:bucket,objectPath:path,mediaKind:'video',contentType:'video/mp4',byteSize:10,checksumSha256:sha256Hex('video-data'),width:null,height:null,durationMs:8000,lifecycleState:'draft'}),
  download:async()=>file,
  storePublishCopy:async(c:any)=>{await db.query(`insert into media_asset_provenance(owner_user_id,bucket_id,object_path,source_type,intent_id,lifecycle_state,media_kind,content_type,byte_size,checksum_sha256) values($1,'generated-private',$2,'publish_copy',$3,'publish_pending','video','video/mp4',10,$4) on conflict(bucket_id,object_path) do nothing`,[A,c.targetPath,c.intentId,c.checksumSha256]);}
 };
 const makeReceipt=(name:string,destinations=ds.slice(0,1))=>({...buildDueVideoReceipt({draftId:name,updatedAt:revision,scheduledAt:revision,payload:{contentId:name,title:'Video',media,imageUrl:media[0].url,scheduledDestinations:destinations}})});
 const makeInput=(receipt:any,index=0)=>({uid:A,receipt,destination:receipt.destinations[index]});
 const success=()=>({outcome:'succeeded' as const,evidence:{stage:'created' as const,classification:'succeeded' as const,pinId:'12345',pinUrl:'https://www.pinterest.com/pin/12345/'}});
 const deps:any=createV76RpcVideoPublishDependencies({
  inspect:input=>inspectV76VideoPublishState(readDb,input),
  materializeSources:(input,lease)=>materializePrivateVideoSources(input,lease,materializer),
  publishVideo:async()=>{calls++;return success();},
  rpc:async(name,args)=>{const entries=Object.entries(args);const r=await db.query(`select public.${name}(${entries.map(([key],i)=>`${key} => $${i+1}`).join(',')}) as value`,entries.map(([,v])=>typeof v==='object'&&v!==null?JSON.stringify(v):v));return (r.rows[0] as {value:unknown}).value;}
 });
 const check=async(name:string,fn:()=>Promise<void>)=>{await fn();console.log('REPRODUCED '+name);};
 await check('normal production wrappers and v76/v77 SQL publish and replay without duplicate',async()=>{
  const i=makeInput(makeReceipt('normal'));assert.equal((await dispatchV76PinterestVideo(i,deps)).outcome,'published');const n=calls;assert.equal((await dispatchV76PinterestVideo(i,deps)).replayed,true);assert.equal(calls,n);
 });
 await check('R2/I2: operational updated_at writes do not invalidate a frozen sibling',async()=>{
  const r=makeReceipt('siblings',ds);assert.equal((await dispatchV76PinterestVideo(makeInput(r),deps)).outcome,'published');
  currentRevision='2026-09-16T12:00:05.000Z';const n=calls;assert.equal((await dispatchV76PinterestVideo(makeInput(r,1),deps)).outcome,'published');assert.equal(calls,n+1);currentRevision=revision;
 });
 await check('R3: active attempt remains in progress and original 201 settles',async()=>{
  const i=makeInput(makeReceipt('live-race'));let release:any;let signal:any;const entered=new Promise(r=>signal=r);const wait=new Promise(r=>release=r);
  const first=dispatchV76PinterestVideo(i,{...deps,publishVideo:async()=>{calls++;signal();await wait;return success();}});
  await entered;const second=await dispatchV76PinterestVideo(i,deps);assert.equal(second.outcome,'in_progress');release();const original=await first;assert.equal(original.outcome,'published');
  assert.equal((await deps.inspect(i)).kind,'published');
 });
 await check('R3: a database-stale started attempt transitions to unknown without provider redispatch',async()=>{
  const i=makeInput(makeReceipt('stale-attempt'));await deps.confirmPrepare(i);const lease=await deps.leaseMaterialization(i);const sources=await deps.materializeSources(i,lease);
  for(const source of sources)await deps.settleItem(i,lease,source);const claim=await deps.claimReady(i,lease);await deps.startAttempt(i,claim);
  await db.query(`update provider_publish_attempts set started_at=now()-interval '11 minutes' where destination_id=$1 and status='started'`,[i.destination.id]);
  const n=calls;assert.equal((await dispatchV76PinterestVideo(i,deps)).outcome,'delivery_unknown');assert.equal(calls,n);assert.equal((await deps.inspect(i)).kind,'delivery_unknown');
 });
 await check('R4: ready-before-claim crash resumes without a second lease',async()=>{
  const i=makeInput(makeReceipt('ready-crash'));await assert.rejects(dispatchV76PinterestVideo(i,{...deps,claimReady:async()=>{throw new Error('injected process loss');}}),/injected process loss/);
  const n=calls;assert.equal((await dispatchV76PinterestVideo(i,deps)).outcome,'published');assert.equal(calls,n+1);
 });
 await check('R4: claimed-before-attempt crash resumes the same claim without redispatch ambiguity',async()=>{
  const i=makeInput(makeReceipt('claimed-crash'));
  await assert.rejects(dispatchV76PinterestVideo(i,{...deps,claimReady:async(input,lease)=>{await deps.claimReady(input,lease);throw new Error('injected claim response loss');}}),/injected claim response loss/);
  const n=calls;assert.equal((await dispatchV76PinterestVideo(i,deps)).outcome,'published');assert.equal(calls,n+1);
 });
 await check('201 then settlement loss preserves started; replay settles unknown and never redispatches',async()=>{
  const i=makeInput(makeReceipt('settle-crash'));const lost=await dispatchV76PinterestVideo(i,{...deps,settleAttempt:async()=>{throw new Error('lost');}});assert.equal(lost.outcome,'delivery_unknown');const n=calls;assert.equal((await dispatchV76PinterestVideo(i,deps)).outcome,'in_progress');assert.equal(calls,n);
 });
 await check('R7: image fingerprint remains byte-exact with the pinned base algorithm',async()=>{
  const i=makeReceipt('imagehash') as any;i.media=[{id:'img1',kind:'image',url:'https://image.invalid/a.png'}];
  const old = sha256Hex(stablePublishString({contentId:i.contentId,draftId:i.draftId,priorIntentId:i.priorIntentId,sourceUpdatedAt:i.sourceUpdatedAt,mode:i.mode,title:i.title,description:i.description,altText:i.altText,destinationUrl:i.destinationUrl,media:i.media.map((m:any)=>({id:m.id,url:m.url,width:m.width??null,height:m.height??null})),destinations:i.destinations.map((d:any)=>({id:d.id,provider:d.provider,socialConnectionId:d.socialConnectionId,accountLabel:d.accountLabel??null,boardId:d.boardId??null,boardName:d.boardName??null})),dispatchDestinationIds:[...i.dispatchDestinationIds].sort(),blockers:i.blockers.map((b:any)=>({code:b.code,destinationId:b.destinationId??null})),onlyPending:i.onlyPending}));
  assert.equal(old,'ffc2819b87d6225015c56d27af70f4b8c2883cf8c10f9fdd5757efee6da7e54d');assert.equal(publishConfirmationFingerprint(i),old);
 });
 await check('R2/R5: durable unknown is inspected before an operational revision change',async()=>{
  const r=makeReceipt('due-unknown');const i=makeInput(r);await dispatchV76PinterestVideo(i,{...deps,publishVideo:async()=>({outcome:'unknown',evidence:{stage:'registered',classification:'unknown'}})});
  const r2=buildDueVideoReceipt({draftId:'due-unknown',updatedAt:'2026-09-16T12:00:05.000Z',scheduledAt:revision,payload:{contentId:'due-unknown',title:'Video',media,imageUrl:media[0].url,scheduledDestinations:ds.slice(0,1)}});
  assert.equal(r.intentId,r2.intentId);assert.equal((await dispatchV76PinterestVideo(makeInput(r2),deps)).outcome,'delivery_unknown');
 });
 await check('R1: a prior delivery_unknown cannot authorize a child redispatch',async()=>{
  const r=makeReceipt('lineage');const i=makeInput(r);await dispatchV76PinterestVideo(i,{...deps,publishVideo:async()=>({outcome:'unknown',evidence:{stage:'created',classification:'unknown'}})});
  const child={...r,intentId:r.intentId+'child',priorIntentId:r.intentId,onlyPending:true};child.fingerprint=publishConfirmationFingerprint(child as any);
  const n=calls;await assert.rejects(dispatchV76PinterestVideo(makeInput(child),deps),/retry_not_allowed/);assert.equal(calls,n);
 });
 await check('R1: one failed destination authorizes exactly one narrowed child retry',async()=>{
  const r=makeReceipt('failed-lineage');
  assert.equal((await dispatchV76PinterestVideo(makeInput(r),{...deps,publishVideo:async()=>({outcome:'failed',evidence:{stage:'registered',classification:'failed',error:'rejected'}})})).outcome,'failed');
  const child={...r,intentId:r.intentId+'retrya',priorIntentId:r.intentId,onlyPending:true};child.fingerprint=publishConfirmationFingerprint(child as any);
  const n=calls;assert.equal((await dispatchV76PinterestVideo(makeInput(child),deps)).outcome,'published');assert.equal(calls,n+1);
  const duplicate={...r,intentId:r.intentId+'retryb',priorIntentId:r.intentId,onlyPending:true};duplicate.fingerprint=publishConfirmationFingerprint(duplicate as any);
  await assert.rejects(dispatchV76PinterestVideo(makeInput(duplicate),deps),/retry_not_allowed/);assert.equal(calls,n+1);
 });
 await check('R5: first unknown does not block an untouched sibling',async()=>{
  const r=makeReceipt('unknown-siblings',ds);await dispatchV76PinterestVideo(makeInput(r),{...deps,publishVideo:async()=>({outcome:'unknown',evidence:{stage:'registered',classification:'unknown'}})});
  assert.equal((await dispatchV76PinterestVideo(makeInput(r,1),deps)).outcome,'published');
 });
 await check('R5: first failure does not block an untouched sibling',async()=>{
  const r=makeReceipt('failed-siblings',ds);assert.equal((await dispatchV76PinterestVideo(makeInput(r),{...deps,publishVideo:async()=>({outcome:'failed',evidence:{stage:'registered',classification:'failed',error:'rejected'}})})).outcome,'failed');
  assert.equal((await dispatchV76PinterestVideo(makeInput(r,1),deps)).outcome,'published');
 });
 await check('R2: a substantive media mutation still fails closed before provider',async()=>{
  const r=makeReceipt('media-conflict',ds.slice(0,1));const n=calls;
  currentMedia=media.map(item=>({...item,url:`/api/storage-media?path=${encodeURIComponent(`${A}/uploads/replaced.mp4`)}`}));
  await assert.rejects(dispatchV76PinterestVideo(makeInput(r),deps),/publish_source_media_conflict/);assert.equal(calls,n);currentMedia=media;
 });
 await check('R2: a substantive content mutation still fails closed before provider',async()=>{
  const r=makeReceipt('content-conflict',ds.slice(0,1));const n=calls;currentTitle='Changed title';
  await assert.rejects(dispatchV76PinterestVideo(makeInput(r),deps),/publish_source_media_conflict/);assert.equal(calls,n);currentTitle='Video';
 });
 await check('materialization lease competition uses real SQL and returns in_progress',async()=>{
  const i=makeInput(makeReceipt('lease-race'));await deps.confirmPrepare(i);await deps.leaseMaterialization(i);const n=calls;assert.equal((await dispatchV76PinterestVideo(i,deps)).outcome,'in_progress');assert.equal(calls,n);
 });
 await check('future and initially expired deadline perform zero durable reads',async()=>{
  const i=makeInput(makeReceipt('future'));let reads=0;const forbidden={...deps,inspect:async()=>{reads++;throw new Error('should never run');}};
  assert.equal((await dispatchV76PinterestVideo({...i,scheduleAt:'2999-01-01T00:00:00Z'},forbidden)).outcome,'not_due');assert.equal((await dispatchV76PinterestVideo({...i,latestStartMs:0},forbidden)).outcome,'not_due');assert.equal(reads,0);
 });
 await check('R8: empty and missing optional media fields share one canonical representation',async()=>{
  const r:any=makeReceipt('empty-alt');const missingFingerprint=publishConfirmationFingerprint(r);r.media=r.media.map((m:any)=>({...m,altText:'',posterUrl:'  '}));r.confirmedAt=new Date().toISOString();r.fingerprint=publishConfirmationFingerprint(r);assert.equal(r.fingerprint,missingFingerprint);
  const validated=validateImmediatePublishReceipt(r,{draftId:r.draftId,title:r.title,description:r.description,altText:r.altText,destinationUrl:r.destinationUrl,imageUrls:r.media.map((m:any)=>m.url)},r.dispatchDestinationIds);
  assert.equal(validated.ok,true);if(!validated.ok)throw new Error('unexpected validation');
  currentMedia=r.media;assert.equal((await materializePrivateVideoSources(makeInput(validated.receipt),{} as any,materializer)).length,1);currentMedia=media;
  const tampered={...r,media:r.media.map((m:any)=>({...m,altText:'changed'}))};assert.notEqual(publishConfirmationFingerprint(tampered),r.fingerprint);
 });
 await db.close();console.log('All local review probes completed.');
}
main().catch(e=>{console.error(e);process.exit(1);});
