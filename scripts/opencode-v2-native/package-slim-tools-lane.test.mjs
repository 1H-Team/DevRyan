import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertCompiledAstReceipt,createCompiledSlimFetchFixture,runCompiledSlimTools} from './package-slim-tools-lane.mjs';
import {createOpenCodeAdmission} from '../../packages/web/server/lib/opencode/v2/admission.js';
import {createOpenCodeClient} from '../../packages/web/server/lib/opencode/opencode-client/index.js';

test('Slim permissions use actual private admission creation before enrollment and tool dispatch; public creation stays refused',async()=>{
 const repository=fileURLToPath(new URL('../..',import.meta.url));
 const directory=await fs.mkdtemp(path.join(repository,'.cache/v2-validation/slim-tool-admission-'));
 const permissions=['write','ast_grep_search','ast_grep_replace','webfetch'].map(action=>({action,resource:'*',effect:'allow'}));
 const input={title:'Compiled original Slim leaf tools',agent:'orchestrator',model:{providerID:'devryan-smoke',modelID:'smoke-write'},permissions};
 const calls=[];let authorized=false,enrolled=false;
 const deps={getRuntime:()=>({generation:2,baseUrl:'http://127.0.0.1:1'}),getAuthHeaders:()=>({}),
  withNativeWebOperation:async(spec,action)=>{
   assert.equal(spec.operation,'admission.create');assert.equal(spec.method,'POST');assert.equal(spec.path,'/api/session');assert.equal(spec.directory,directory);
   assert.deepEqual(spec.body.permissions,permissions);authorized=true;return action();
  },
  fetchImpl:async(url,init)=>{
   assert.equal(authorized,true,'Transport preceded original session authorization');assert.equal(new URL(url).pathname,'/api/session');assert.equal(init.method,'POST');
   const body=JSON.parse(init.body);assert.deepEqual(body.permissions,permissions);assert.deepEqual(body.location,{directory});
   assert.equal(body.agent,input.agent);assert.deepEqual(body.model,{providerID:input.model.providerID,id:input.model.modelID});calls.push(body);
   return Response.json({...body,time:{created:1,updated:1}});
  }};
 try{
  const client=createOpenCodeClient(deps),admission=createOpenCodeAdmission(deps);
  await assert.rejects(client.sessions.create(input,{directory}),cause=>cause.code==='opencode_privilege_required');assert.equal(calls.length,0);
  const stopped=new Error('Fixture reached the first real tool boundary');
  await assert.rejects(runCompiledSlimTools({directory,createSession:(body,options)=>admission.create(body,options),
   admitPrimary:async sessionID=>{assert.equal(calls.length,1);assert.equal(sessionID,calls[0].id);enrolled=true;},
   invoke:async(scenario,options)=>{assert.equal(enrolled,true);assert.equal(options.sessionID,calls[0].id);assert.equal(options.directory,directory);
    assert.equal(scenario.id,'compiled-slim-ast-setup');assert.equal(scenario.tool,'write');throw stopped;}}),cause=>cause===stopped);
  assert.equal(calls.length,1,'Permission configuration duplicated session creation');
  await assert.rejects(runCompiledSlimTools({directory,admitPrimary:()=>{throw Error('Missing owner enrolled a session');},invoke:()=>{throw Error('Missing owner dispatched');}}));
  assert.equal(calls.length,1,'Missing private owner fell back to public creation');
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});

test('webfetch fixture accepts real HTTP after an actual HTTPS handshake refusal, without transport rewriting',async()=>{
 const fixture=await createCompiledSlimFetchFixture();
 try{
  assert.equal(new URL(fixture.url('/text')).hostname,'devryan.localhost');
  assert.equal(new URL(fixture.url('/article')).hostname,'devryan.localhost');
  await assert.rejects(fetch(fixture.url('/text').replace('http:','https:'),{signal:AbortSignal.timeout(5000)}));
  const response=await fetch(fixture.url('/text'));assert.equal(response.status,200);assert.equal(await response.text(),fixture.text);
  const html=await fetch(fixture.url('/article'));assert.equal(html.headers.get('content-type'),'text/html; charset=utf-8');assert.ok((await html.text()).includes(fixture.articleText));
  assert.equal(fixture.tlsAttempts,1);assert.deepEqual(fixture.requests,['/text','/article']);fixture.check();
 }finally{await fixture.close();}
});

test('AST output cannot qualify without real termination before the exact process publication',async()=>{
 const call={callID:'native_ast',messageID:'msg_actual',state:{status:'completed',output:'Original formatter success'}};
 const lease={executionKind:'process',state:'published',result:{operationID:'actual-operation',sequence:1},scope:{sessionID:'ses_actual',messageID:'msg_actual',callID:'native_ast'}};
 const runtime={leaseForCall:async()=>lease},base={runtime,call,directory:'/owned/project',sessionID:'ses_actual'};
 await assert.rejects(assertCompiledAstReceipt({...base,observations:[]}),/Missing verified native termination/);
 const termination={callID:'native_ast',phase:'termination_verified',receipt:{terminated:true,confined:true,exitCode:0,cancelled:false}},publication={callID:'native_ast',phase:'published'};
 await assert.rejects(assertCompiledAstReceipt({...base,observations:[publication,termination]}),/preceded verified termination/);
 await assert.rejects(assertCompiledAstReceipt({...base,observations:[{...termination,receipt:{...termination.receipt,confined:false}},publication]}));
 await assert.rejects(assertCompiledAstReceipt({...base,observations:[{...termination,receipt:{...termination.receipt,exitCode:1}},publication]}));
 lease.scope.messageID='msg_foreign';await assert.rejects(assertCompiledAstReceipt({...base,observations:[termination,publication]}));
});

test('unexpected HTTP credentials/routes remain sticky through real fixture shutdown',async()=>{
 const fixture=await createCompiledSlimFetchFixture();
 const response=await fetch(fixture.url('/text'),{headers:{authorization:'Bearer synthetic-fixture-value'}});
 assert.equal(response.status,500);assert.throws(fixture.check);await assert.rejects(fixture.close());
 const other=await createCompiledSlimFetchFixture();
 const refused=await fetch(other.url('/text').replace('/text','/foreign'));assert.equal(refused.status,500);
 assert.throws(other.check,/Unexpected original webfetch route/);await assert.rejects(other.close(),/Unexpected original webfetch route/);
});
