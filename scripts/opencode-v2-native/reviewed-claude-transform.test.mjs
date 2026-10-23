import {EventEmitter} from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {rewriteReviewedClaudeStartup,rewriteReviewedMeridianLibsql,rewriteReviewedMeridianStallRetry,rewriteReviewedClaudeSpawn,REVIEWED_CLAUDE_STARTUP} from '../../packages/web/server/lib/opencode/runtime-host/reviewed-claude-transform.js';
import {settlePassthroughQuery,upstreamIdleBudget} from '../../packages/web/server/lib/opencode/meridian-passthrough-handoff.js';
const repository=path.resolve(import.meta.dirname,'../..');
const sourceFile=path.join(repository,'scripts/opencode-v2-native/fixtures/reviewed-claude-1.8.0.txt');
test('reviewed Claude transform exposes exact original startup, health, profile and scrub functions',async()=>{
  const source=await fs.readFile(sourceFile,'utf8');
  const transformed=rewriteReviewedClaudeStartup(source);
  assert.equal(transformed.replace('if(r.status===503&&t.status==="unhealthy"&&t.auth?.loggedIn===false&&i==="1.62.6")return{ok:!0,version:i,availability:"credential-unavailable"};','').replace('fetch(R(e)+"/health",{headers:{authorization:"Bearer "+process.env.DEVRYAN_PROVIDER_AUTHORIZATION},signal:AbortSignal.timeout(5e3)})','fetch(R(e)+"/health",{signal:AbortSignal.timeout(5e3)})').replace('i=h(),d="1.62.6",s=console.error','i=h(),d=ee(),s=console.error').replace('export{we as ClaudeMaxPlugin,N as startReviewedProxy,U as checkReviewedProxy,F as resolveReviewedProfiles,R as reviewedProxyOrigin,ie as scrubReviewedSystem};','export{we as ClaudeMaxPlugin};'),source);
  assert.equal(REVIEWED_CLAUDE_STARTUP.meridianVersion,'1.62.6');
  assert.throws(()=>rewriteReviewedClaudeStartup(source+'\n'),/native_claude_source_unreviewed/);
  assert.throws(()=>rewriteReviewedClaudeStartup(source.replace('127.0.0.1','0.0.0.0')),/native_claude_source_unreviewed/);
});

test('sealed libsql resolves only the explicit reviewed native target',async()=>{
 const source=await fs.readFile(path.join(repository,'packages/web/runtime/reviewed-inputs/claude-1.8.0/node_modules/@rynfar/meridian/dist/cli-wxk8xvd3.js'));
 const mac=rewriteReviewedMeridianLibsql(source);
 for(const target of ['win32-x64','win32-arm64']){
  const windows=rewriteReviewedMeridianLibsql(source,{target});
  assert.equal(windows.replace(`target !== "${target}"`,'target !== "darwin-arm64"'),mac);
  assert.doesNotMatch(windows,/return __require\(`@libsql\/\$\{target\}`\)/);
 }
 assert.throws(()=>rewriteReviewedMeridianLibsql(source,{target:'win32-ia32'}),/target_unreviewed/);
 assert.throws(()=>rewriteReviewedMeridianLibsql(Buffer.concat([source,Buffer.from('\n')]),{target:'win32-x64'}),/source_unreviewed/);
});

test('original health helper accepts only exact signed-out availability; draining and version failures remain negative',async()=>{
 const source=rewriteReviewedClaudeStartup(await fs.readFile(sourceFile,'utf8'));
 const helper=source.slice(source.indexOf('async function U('),source.indexOf('function M('));
 const run=new Function('fetch','R','oe','te','process','AbortSignal',helper+';return U;');
 const inspect=async(status,payload)=>run(async()=>({status,json:async()=>payload}),()=> 'http://fixture',()=>({}),()=>'',{env:{}},AbortSignal)(3456);
 assert.deepEqual(await inspect(503,{status:'unhealthy',version:'1.62.6',auth:{loggedIn:false}}),{ok:true,version:'1.62.6',availability:'credential-unavailable'});
 for(const [status,payload] of [[200,{status:'unhealthy',version:'1.62.6',auth:{loggedIn:false}}],[503,{status:'draining',version:'1.62.6',auth:{loggedIn:false}}],[503,{status:'unhealthy',version:'wrong',auth:{loggedIn:false}}],[503,{status:'unhealthy',version:'1.62.6',auth:{loggedIn:true}}]])assert.equal((await inspect(status,payload)).ok,false);
});

test('reviewed confined spawn requires the exact host-owned transport hook and preserves SDK arguments',async()=>{
 const file=path.join(repository,'packages/web/runtime/reviewed-inputs/claude-1.8.0/node_modules/@rynfar/meridian/dist/devryan-session-provider-spawn.js');
 const transformed=rewriteReviewedClaudeSpawn(await fs.readFile(file));
 const child=new EventEmitter(),calls=[];
 const processFixture={env:{DEVRYAN_PROVIDER_TRANSPORT:JSON.stringify({protocol:1,asset:{path:'/fixture/claude'}})}};
 const globals={__DEVRYAN_CLAUDE_TRANSPORT_SPAWN:(options,scope)=>{calls.push([options,scope]);return child;}};
 const load=new Function('process','globalThis',transformed.replace("import { spawn } from 'node:child_process';",'').replace('export function','function')+';return spawnConfinedProvider;');
 const invoke=load(processFixture,globals),options={command:'/fixture/claude',args:['--print'],cwd:'/fixture/project',env:{DEVRYAN_CLAUDE_DIAGNOSTIC_SCOPE:'owned IDs'},signal:new AbortController().signal};
 assert.equal(invoke(options),child);assert.deepEqual(calls,[[options,'owned IDs']]);
 assert.throws(()=>invoke({...options,command:'/bin/sh'}),/transport_unverified/);
 assert.throws(()=>load(processFixture,{})(options),/transport_invalid/);
 assert.doesNotMatch(transformed,/spawn\(process.execPath|--claude-transport-worker/);
 assert.match(rewriteReviewedMeridianLibsql(await fs.readFile(path.join(path.dirname(file),'cli-wxk8xvd3.js'))),/profileID:profile.id/);
});

test('stalled retained stream steps retry once through the attempt guard; the response guard is only a backstop',async()=>{
 const source=(await fs.readFile(path.join(repository,'packages/web/runtime/reviewed-inputs/claude-1.8.0/node_modules/@rynfar/meridian/dist/cli-wxk8xvd3.js'),'utf8'));
 const meridian=rewriteReviewedMeridianLibsql(source);
 assert.match(meridian,/^import \{ retryStalledCheckpoint, settlePassthroughQuery, upstreamIdleBackstop, upstreamIdleBudget \} from "\.\/devryan-meridian-passthrough-handoff\.js";$/m);
 // Only the primary streamed attempt retries; non-stream, fresh-replay and silent recovery attempts do not.
 assert.equal(meridian.split('retryStalledCheckpoint(() => runSdkQueryAttempt(').length,2);
 assert.match(meridian,/retryStalledCheckpoint\(\(\) => runSdkQueryAttempt\(buildQueryOptions\(\{\n\s+prompt: makePrompt\(\),/);
 assert.match(meridian,/retained: Boolean\(requestMeta\.passthroughHandoff && resumeSessionId && passthroughToolCallAssistantUuid && !isUndo\)/);
 assert.match(meridian,/guardUpstreamIdle\(response, upstreamIdleBackstop\(UPSTREAM_IDLE_MS, effort\), /);
 assert.doesNotMatch(meridian,/guardUpstreamIdle\(settlePassthroughQuery\(/);
 assert.throws(()=>rewriteReviewedMeridianStallRetry(source.replace('const guardedResponse = guardUpstreamIdle(response, UPSTREAM_IDLE_MS, ','const guardedResponse = guardUpstreamIdle(response, 1, ')),/native_meridian_source_shape_changed/);
 assert.throws(()=>rewriteReviewedMeridianStallRetry(meridian),/native_meridian_source_shape_changed/);
 // Exercise the transformed attempt with the bundle's own guard: a stall is reported, not silently closed.
 const guard=meridian.slice(meridian.indexOf('// src/proxy/streamIdleGuard.ts'),meridian.indexOf('// src/proxy/requestAbort.ts'));
 const attempt=meridian.slice(meridian.indexOf('  async function* runSdkQueryAttempt('),meridian.indexOf('  const pluginDir = finalConfig.pluginDir'));
 const load=new Function('query','sdkSemaphore','settlePassthroughQuery','upstreamIdleBudget','UPSTREAM_IDLE_MS','claudeLog',`${guard}\n${attempt}\nreturn {runSdkQueryAttempt,UpstreamIdleError};`);
 const closed=[],budgets=[],logs=[],events=[];
 const fakeQuery=()=>{const iterator=(async function*(){yield {type:'stream_event',session_id:'sdk',event:{type:'message_start'}};await new Promise(()=>{});})();iterator.close=()=>closed.push(true);return iterator;};
 const {runSdkQueryAttempt,UpstreamIdleError}=load(fakeQuery,{acquire:async()=>({waitedMs:0,release(){}})},settlePassthroughQuery,(base,effort)=>{budgets.push(effort);return upstreamIdleBudget(base,effort)>base?40:20;},90_000,(event,detail)=>logs.push([event,detail.mode]));
 const requestMeta={sdkQueueWaitMs:0,sdkActiveDurationMs:0,passthroughHandoff:{checkpoint:()=>null,diagnostic:(event,detail)=>events.push([event,detail.reason])}};
 const started=Date.now();
 await assert.rejects((async()=>{for await(const message of runSdkQueryAttempt({options:{effort:'max'}},undefined,requestMeta,'stream'))void message;})(),error=>error instanceof UpstreamIdleError&&error.idleMs===40);
 assert.ok(Date.now()-started>=35);
 assert.deepEqual(budgets,['max']);assert.deepEqual(logs,[['upstream.stalled','stream']]);assert.equal(closed.length,1);
 assert.deepEqual(events,[['passthrough.checkpoint_aborted','upstream_idle']]);
});
