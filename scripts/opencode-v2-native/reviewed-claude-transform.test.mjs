import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {rewriteReviewedClaudeStartup,REVIEWED_CLAUDE_STARTUP} from '../../packages/web/server/lib/opencode/runtime-host/reviewed-claude-transform.js';
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

test('original health helper accepts only exact signed-out availability; draining and version failures remain negative',async()=>{
 const source=rewriteReviewedClaudeStartup(await fs.readFile(sourceFile,'utf8'));
 const helper=source.slice(source.indexOf('async function U('),source.indexOf('function M('));
 const run=new Function('fetch','R','oe','te','process','AbortSignal',helper+';return U;');
 const inspect=async(status,payload)=>run(async()=>({status,json:async()=>payload}),()=> 'http://fixture',()=>({}),()=>'',{env:{}},AbortSignal)(3456);
 assert.deepEqual(await inspect(503,{status:'unhealthy',version:'1.62.6',auth:{loggedIn:false}}),{ok:true,version:'1.62.6',availability:'credential-unavailable'});
 for(const [status,payload] of [[200,{status:'unhealthy',version:'1.62.6',auth:{loggedIn:false}}],[503,{status:'draining',version:'1.62.6',auth:{loggedIn:false}}],[503,{status:'unhealthy',version:'wrong',auth:{loggedIn:false}}],[503,{status:'unhealthy',version:'1.62.6',auth:{loggedIn:true}}]])assert.equal((await inspect(status,payload)).ok,false);
});
