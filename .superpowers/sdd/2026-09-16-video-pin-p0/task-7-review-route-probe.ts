// Execute actual cron GET with process-local module stubs; no remote calls.
import assert from 'node:assert/strict';
import Module from 'node:module';
import { dispatchV76PinterestVideo } from '../../../web/src/lib/server/publish/v76PinterestVideoPublish';

const C='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const A='11111111-1111-4111-8111-111111111111';
const past=new Date(Date.now()-60000).toISOString();
const future=new Date(Date.now()+3600000).toISOString();
let claims=0, meters=0, provider=0, durableReads=0;
const baseRow=()=>({vibepin_user_id:A,draft_id:'future-race',scheduled_at:past,updated_at:past,publish_claimed_at:null,deleted_at:null,archived_at:null,
 payload:{contentId:'future-race',title:'Video',media:[{id:'video1',kind:'video',source:'upload',url:`/api/storage-media?path=${A}%2Fuploads%2Fvideo.mp4`}],scheduledDestinations:[{provider:'pinterest',socialConnectionId:C,boardId:'board1'}]}});
let current:any=baseRow();
let scanned=false;
let mutateAfterScan=(row:any)=>{row.scheduled_at=future;};
const db:any={from(){
 let values:any=null;let single=false;const filters:any[]=[];
 const q:any={update(v:any){values=v;return q;},select(){return q;},eq(k:any,v:any){filters.push(['eq',k,v]);return q;},is(k:any,v:any){filters.push(['is',k,v]);return q;},lte(k:any,v:any){filters.push(['lte',k,v]);return q;},not(){return q;},or(){return q;},order(){return q;},limit(){return q;},maybeSingle(){single=true;return q;},then(resolve:any,reject:any){
  try {
   if (!scanned&&!values) {scanned=true;const candidate=structuredClone(current);mutateAfterScan(current);return Promise.resolve({data:[candidate],error:null}).then(resolve,reject);}
   let matches=true;
   for(const [op,k,v] of filters){if(op==='lte'&&current[k]>v) matches=false;if(op==='eq'&&current[k]!==v)matches=false;if(op==='is'&&current[k]!==v)matches=false;}
   if(values&&matches){if(values.publish_claimed_at)claims++;current={...current,...values};}
   const data=matches?(single?structuredClone(current):[structuredClone(current)]):(single?null:[]);
   return Promise.resolve({data,error:null}).then(resolve,reject);
  }catch(e){return Promise.reject(e).then(resolve,reject);}
 }};return q;
}};
const originalLoad=(Module as any)._load;
(Module as any)._load=function(id:string,...args:any[]){
 if(id==='@/lib/supabase')return {createServerClient:()=>db};
 if(id==='@/lib/server/usage/meterScheduledPost')return {consumeScheduledPost:async()=>{meters++;return {kind:'off'};},deriveScheduledPostKey:()=> 'test-meter',releaseScheduledPost:async()=>{},usageEnforceFor:()=>false};
 if(id==='@/lib/server/pinterest/publishPin')return {publishPinForUser:async()=>{provider++;throw new Error('forbidden provider');}};
 if(id==='@/lib/server/publish/v76PinterestVideoServer')return {dispatchSupabaseV76PinterestVideo:(_db:any,input:any)=>dispatchV76PinterestVideo(input,{inspect:async()=>{durableReads++;throw new Error('forbidden durable read');}} as any)};
 if(id==='@/lib/server/pinterest/service')return {NeedsReconnectError:class extends Error{},NotConnectedError:class extends Error{},PinterestTrialAccessError:class extends Error{}};
 if(id==='@/lib/social/publishFanout')return {
  createPublishJob:async()=>{throw new Error('forbidden job');},recordOutcomes:async()=>{},fanOutDestinations:async()=>{throw new Error('forbidden fanout');},
  hasTimeForDestination:(now:number,deadline:number)=>now<deadline,
  deferredOutcome:(d:any)=>({...d,status:'pending'}),pinterestOutcomeRow:(d:any,r:any)=>({...d,status:r.ok?'published':'failed',error:r.error}),trialAccessPendingOutcome:(d:any)=>({...d,status:'pending'})};
 if(id==='@/lib/server/publishEvents')return {recordPublishEvent:async()=>{},recordFailedPublishEvent:async()=>{},newPublishAttemptId:()=> 'review-attempt',PUBLISH_EVENT_ATTEMPTED:'attempted',PUBLISH_EVENT_SUCCEEDED:'succeeded'};
 return originalLoad.call(this,id,...args);
};
process.env.CRON_SECRET='local-review-only';
async function main(){
 const {GET}=require('../../../web/src/app/api/cron/publish-due/route');
 const scenarios:[string,(row:any)=>void][]=[
  ['reschedule',row=>{row.scheduled_at=future;}],
  ['cancel',row=>{row.scheduled_at=null;row.updated_at=new Date().toISOString();}],
  ['delete',row=>{row.deleted_at=new Date().toISOString();row.updated_at=new Date().toISOString();}],
  ['media change',row=>{row.payload.media[0].url=`/api/storage-media?path=${A}%2Fuploads%2Freplaced.mp4`;row.updated_at=new Date().toISOString();}],
 ];
 for(const [name,mutation] of scenarios){
  current=baseRow();scanned=false;claims=0;meters=0;provider=0;durableReads=0;mutateAfterScan=mutation;
  const response=await GET(new Request('https://vibepin.invalid/api/cron/publish-due',{headers:{authorization:'Bearer local-review-only'}}));
  const result=await response.json();
  assert.equal(response.status,200);assert.equal(claims,0);assert.equal(meters,0);assert.equal(provider,0);assert.equal(durableReads,0);
  console.log(`SAFE: actual cron GET rejects ${name} between scan and claim`,JSON.stringify({result,claims,meters,provider,durableReads}));
 }
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{(Module as any)._load=originalLoad;});
