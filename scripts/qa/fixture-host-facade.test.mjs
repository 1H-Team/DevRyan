import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createQaFixtureHostFacade } from './fixture-host-facade.mjs';
import { createLoopbackOpenCodeV2Fixture } from '../perf/loopback-opencode-v2-fixture.mjs';
import { createRequestSecurityRuntime } from '../../packages/web/server/lib/security/request-security.js';
import { isDirectLocalRequest } from '../../packages/web/server/lib/security/direct-local-request.js';
import { uiSessionCookieName } from '../../packages/web/server/lib/ui-auth/session-cookie.js';
import { PERF_PARENT_SESSION_ID } from '../perf/fixture-session-seeds.mjs';
import { gradeQaManualFixtureSubmission } from './fixture-scenarios.mjs';
import { isQaKnownSessionSettled } from './submitted-turn.mjs';
import { createDiagnosticSanitizer } from '../../packages/harness-runtime/lib/sanitizer.js';
import { registerQuotaRoutes } from '../../packages/web/server/lib/quota/routes.js';

const express = createRequire(new URL('../../packages/web/package.json', import.meta.url))('express');

async function setup({ contextUsage = false } = {}) {
  const cache=fileURLToPath(new URL('../../.cache/qa/',import.meta.url));await fs.mkdir(cache,{recursive:true});
  const root=await fs.mkdtemp(path.join(cache,'wire-facade-unit-'));
  const workspace=path.join(root,'project'),dataDirectory=path.join(root,'data'),config=path.join(root,'config');
  for(const dir of [workspace,dataDirectory,config])await fs.mkdir(dir);
  const userConfigPath=path.join(config,'opencode.json');await fs.writeFile(userConfigPath,'{}');
  const passed=[];
  const security=createRequestSecurityRuntime({readSettingsFromDiskMigrated:async()=>({})});
  let facade;
  const quota = express();
  if(contextUsage)registerQuotaRoutes(quota,{
    openCodeClient:()=>facade.client,
    resolveProjectDirectory:async()=>({directory:workspace}),
  });
  const real=createServer(async(req,res)=>{
    passed.push({method:req.method,path:req.url});res.setHeader('content-type','application/json');
    if(req.url==='/compressed'){
      const bytes=gzipSync('<!doctype html><title>Actual compressed feature</title>');
      res.setHeader('content-type','text/html; charset=utf-8');
      res.setHeader('content-encoding','gzip');res.setHeader('content-length',bytes.byteLength);
      res.setHeader('content-security-policy',"default-src 'self'");
      res.setHeader('x-content-type-options','nosniff');
      res.setHeader('set-cookie',['feature=bounded; HttpOnly; SameSite=Strict']);
      res.end(bytes);return;
    }
    for await(const chunk of req)assert.ok(chunk.byteLength<=1024);
    if(contextUsage && new URL(req.url,'http://localhost').pathname.endsWith('/context-usage')){
      if(!isDirectLocalRequest(req)||!await security.isRequestOriginAllowed(req)){res.statusCode=403;res.end('{}');return;}
      if(security.getUiSessionTokenFromRequest(req)!=='disposable-unit-token'){res.statusCode=401;res.end('{}');return;}
      quota(req,res);return;
    }
    if(req.method==='PUT'){
      if(!isDirectLocalRequest(req)||!await security.isRequestOriginAllowed(req)){res.statusCode=403;res.end('{}');return;}
      if(security.getUiSessionTokenFromRequest(req)!=='disposable-unit-token'){res.statusCode=401;res.end('{}');return;}
    }
    res.end(JSON.stringify({actualProductFeature:true,path:req.url,origin:req.headers.origin,referer:req.headers.referer}));
  });
  await new Promise(resolve=>real.listen(0,'127.0.0.1',resolve));
  const fixture=await createLoopbackOpenCodeV2Fixture({directory:workspace});
  facade=await createQaFixtureHostFacade({fixture,realOrigin:`http://127.0.0.1:${real.address().port}`,workspace,dataDirectory,userConfigPath});
  const request=async(route,body,method=body?'POST':'GET')=>{
    const response=await fetch(facade.origin+route,{method,headers:{'content-type':'application/json','x-opencode-directory':workspace},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,body:await response.json().catch(()=>null)};
  };
  return {root,workspace,fixture,facade,request,passed,realOrigin:`http://127.0.0.1:${real.address().port}`,
    cookie:`${uiSessionCookieName(real.address().port)}=disposable-unit-token`,
    close:async()=>{const results=await Promise.allSettled([facade.close(),fixture.close(),new Promise(resolve=>{real.close(resolve);real.closeAllConnections();})]);await fs.rm(root,{recursive:true,force:true});const errors=results.filter(row=>row.status==='rejected').map(row=>row.reason);if(errors.length)throw new AggregateError(errors);}};
}

test('QA facade uses original native client/proxy, passes product features and settles its projected SSE',async()=>{
  const f=await setup();
  try {
    const session=await f.request('/api/session',{title:'wire only'});assert.equal(session.status,200);
    const messageID='msg_wireunit001';
    const response=await fetch(f.facade.origin+'/api/global/event',{signal:AbortSignal.timeout(5000)});
    assert.equal(response.status,200);const reader=response.body.getReader();
    try {
      assert.equal((await f.request(`/api/session/${session.body.id}/prompt_async`,{messageID,agent:'build',model:{providerID:'fixture',modelID:'fixture-model'},parts:[{type:'text',text:'wire proof'}]})).status,204);
      let stream='';while(!stream.includes('QA response chunk 20.')){const chunk=await reader.read();assert.equal(chunk.done,false);stream+=new TextDecoder().decode(chunk.value);}
      assert.match(stream,/message\.part/);assert.match(stream,new RegExp(session.body.id));
    } finally {await reader.cancel();reader.releaseLock();}
    const history=await f.request(`/api/session/${session.body.id}/message`);assert.equal(history.status,200);assert.ok(history.body.some(row=>row.info.id===messageID));
    assert.equal((await f.request('/api/config/settings')).body.actualProductFeature,true);
    assert.equal((await f.request('/api/health')).body.actualProductFeature,true);
    for (const route of ['/api/provider/auth', '/api/provider/fixture/source']) {
      const read = await f.request(route);
      assert.equal(read.status, 200);
      assert.equal(read.body.actualProductFeature, true, 'Provider metadata stays owned by the actual isolated host');
      assert.equal(f.passed.at(-1).path, route);
    }
    const writeHeaders={origin:f.facade.origin,referer:f.facade.origin+'/chat?session=unit',cookie:f.cookie,'content-type':'application/json'};
    const write=await fetch(f.facade.origin+'/api/config/settings',{method:'PUT',headers:writeHeaders,body:'{}'});
    assert.equal(write.status,200);const written=await write.json();
    assert.equal(written.origin,f.realOrigin);assert.equal(written.referer,f.realOrigin+'/chat?session=unit');
    const unauthenticated=await fetch(f.facade.origin+'/api/config/settings',{method:'PUT',headers:{origin:f.facade.origin},body:'{}'});
    assert.equal(unauthenticated.status,401,await unauthenticated.text());
    assert.equal((await f.request(`/api/session/${session.body.id}/recovery`)).body.actualProductFeature,true);
    assert.ok(f.passed.every(row=>!row.path.endsWith('/prompt_async')));
    const settings=await f.request('/api/config/agent-runtime');assert.equal(settings.status,200);assert.equal(settings.body.runtimeMode,'external');
    assert.equal((await f.request('/api/config/agent-runtime',{lsp:true},'PUT')).body.lsp,true);
    assert.equal((await f.request('/api/config/agent-runtime',{lsp:'unsafe'},'PUT')).status,400);
    const source=history.body.find(row=>row.info.role==='assistant');
    const canonical=await f.facade.client.sessions.get(session.body.id,{directory:f.workspace});
    const query=new URLSearchParams({directory:f.workspace,sessionCreated:String(canonical.time.created),sessionSlug:canonical.slug});
    const planPath=`/api/session/${session.body.id}/plan-revisions/${source.info.id}`;
    const plan=await f.request(planPath,{directory:f.workspace,sessionCreated:canonical.time.created,sessionSlug:canonical.slug,markdown:'# Actual route test'});
    assert.equal(plan.status,200);assert.match((await f.request(planPath+'?'+query)).body.content,/Actual route test/);
    assert.equal((await f.request(planPath,{directory:f.workspace,sessionCreated:canonical.time.created,sessionSlug:'foreign',markdown:'no'})).status,409);
    assert.deepEqual(f.fixture.getState().unknownRoutes,[]);assert.deepEqual(f.facade.unexpected,[]);
  } finally {await f.close();}
});

test('mobile child preparation and interruption use the authenticated scoped facade',async()=>{
  const f=await setup();
  try{
    const raw=await fetch(f.fixture.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
    assert.equal(raw.status,401,'The synthetic native runtime must still refuse unauthenticated preparation');
    const api=async(route,body)=>{
      const response=await fetch(f.facade.origin+route,{method:'POST',headers:{
        'content-type':'application/json','x-opencode-directory':f.workspace,'X-DevRyan-CSRF':'1',
        origin:f.facade.origin,cookie:f.cookie,
      },body:JSON.stringify(body)});
      assert.ok(response.ok,`Scoped mobile API refused: ${response.status}`);
      return response.status===204?null:response.json();
    };
    const parent=await api('/api/session',{title:'mobile parent'});
    const child=await api('/api/session',{parentID:parent.id,title:'mobile held child'});
    assert.equal(child.parentID,parent.id);
    f.fixture.configureNextPrompt(child.id,{hold:true,reasoning:'text',reasoningText:'Finite child reasoning'});
    const messageID='msg_mobilefacadechild001';
    assert.equal(await api(`/api/session/${child.id}/prompt_async`,{messageID,agent:'build',variant:'',
      model:{providerID:'fixture',modelID:'fixture-model'},parts:[{type:'text',text:'Canonical mobile child'}]}),null);
    const rows=(await f.request(`/api/session/${child.id}/message`)).body;
    assert.equal(rows.filter(row=>row.info.id===messageID).length,1);
    assert.equal(rows.at(-1).info.parentID,messageID);
    assert.equal(await api(`/api/session/${child.id}/abort`,{}),true);
    assert.equal(await api(`/api/session/${parent.id}/abort`,{}),true);
    assert.equal(f.fixture.getState().activePrompts,0);
    assert.deepEqual(f.facade.unexpected,[]);assert.deepEqual(f.fixture.getState().unknownRoutes,[]);
  }finally{await f.close();}
});

test('context usage delegates to the original host quota owner without masking unknown native routes',async()=>{
  const f=await setup({contextUsage:true});
  try{
    const session=(await f.request('/api/session',{title:'context owner proof'})).body;
    const route=`/api/session/${session.id}/context-usage?directory=${encodeURIComponent(f.workspace)}&refreshSession=true`;
    const headers={origin:f.facade.origin,cookie:f.cookie};
    const response=await fetch(f.facade.origin+route,{headers});
    assert.equal(response.status,200);
    const usage=await response.json();
    assert.equal(Number.isFinite(usage.fetchedAt),true);
    assert.deepEqual({...usage,fetchedAt:0},{sessionID:session.id,status:'unavailable',source:'message-fallback',
      inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,activeInputTokens:0,lastOutputTokens:0,fetchedAt:0});
    assert.deepEqual(f.passed,[{method:'GET',path:route}]);
    assert.deepEqual(f.facade.unexpected,[]);assert.deepEqual(f.fixture.getState().unknownRoutes,[]);
    assert.equal((await fetch(f.facade.origin+route,{headers:{...headers,origin:'https://foreign.invalid'}})).status,403);
    assert.equal((await fetch(f.facade.origin+route.replace(encodeURIComponent(f.workspace),'%2Fforeign'),{headers})).status,403);
    assert.equal((await fetch(f.facade.origin+route,{headers:{origin:f.facade.origin}})).status,401);
    assert.equal((await f.request(`/api/session/${session.id}/not-a-route`)).status,404);
    assert.equal(f.facade.unexpected.length,1);
    assert.equal(f.facade.unexpected[0].routeShape,'unmatched-core-route');
    await assert.rejects(f.facade.close(),/Unexpected targeted wire facade routes/);
  }finally{await f.close();}
});

test('QA feature facade forwards decoded compressed bytes with valid framing and original security headers',async()=>{
  const f=await setup();
  try{
    const response=await fetch(f.facade.origin+'/compressed');
    assert.equal(response.status,200);
    assert.equal(await response.text(),'<!doctype html><title>Actual compressed feature</title>');
    assert.equal(response.headers.get('content-encoding'),null);
    assert.equal(response.headers.get('content-length'),null);
    assert.equal(response.headers.get('content-type'),'text/html; charset=utf-8');
    assert.equal(response.headers.get('content-security-policy'),"default-src 'self'");
    assert.equal(response.headers.get('x-content-type-options'),'nosniff');
    assert.deepEqual(response.headers.getSetCookie(),['feature=bounded; HttpOnly; SameSite=Strict']);
    assert.deepEqual(f.passed,[{method:'GET',path:'/compressed'}]);
  }finally{await f.close();}
});

test('native wire status omits a completed known turn and retains busy execution',async()=>{
  const f=await setup();
  try{
    const session=(await f.request('/api/session',{title:'native idle proof'})).body;
    f.fixture.configureNextPrompt(session.id,{hold:true,chunks:1,intervalMs:10});
    const messageID='msg_knownidle001';
    assert.equal((await f.request(`/api/session/${session.id}/prompt_async`,{messageID,agent:'build',model:{providerID:'fixture',modelID:'fixture-model'},parts:[{type:'text',text:'Canonical idle proof'}]})).status,204);
    const snapshot=async()=>({sessionID:session.id,session:(await f.request(`/api/session/${session.id}`)).body,
      rows:(await f.request(`/api/session/${session.id}/message`)).body,status:(await f.request('/api/session/status')).body});
    const busy=await snapshot();assert.equal(busy.status[session.id].type,'busy');assert.equal(isQaKnownSessionSettled(busy),false);
    f.fixture.releasePrompt(session.id);
    const deadline=Date.now()+5000;let settled;
    while(Date.now()<deadline){settled=await snapshot();if(isQaKnownSessionSettled(settled))break;await new Promise(resolve=>setTimeout(resolve,10));}
    assert.equal(isQaKnownSessionSettled(settled),true);
    assert.deepEqual(settled.status,{});assert.equal(settled.rows.at(-1).info.parentID,messageID);
    assert.equal(isQaKnownSessionSettled({...settled,session:{id:'ses_unknown'}}),false);
    assert.equal(isQaKnownSessionSettled({...settled,status:{[session.id]:{type:'failed'}}}),false);
  }finally{await f.close();}
});

test('QA facade rejects foreign directory/origin and records unknown targeted routes without falling through',async()=>{
  const f=await setup();
  try {
    assert.equal((await fetch(f.facade.origin+'/api/agent?directory=%2Fforeign')).status,403);
    assert.equal((await fetch(f.facade.origin+'/api/session',{headers:{origin:'https://foreign.invalid'}})).status,403);
    assert.equal((await fetch(f.facade.origin+'/api/config/settings',{method:'PUT',headers:{origin:'https://foreign.invalid',cookie:f.cookie},body:'{}'})).status,403);
    assert.equal((await fetch(f.facade.origin+'/api/health',{headers:{'x-forwarded-host':'127.0.0.1'}})).status,403);
    assert.equal((await fetch(f.facade.origin+'/api/health',{headers:{referer:'https://foreign.invalid/'}})).status,403);
    const sessionID='ses_0123456789abcdefAbCdEfGhIjKlMnOp';
    assert.equal((await f.request(`/api/session/${sessionID}/not-a-route?ignored=query`)).status,404);
    assert.deepEqual(f.passed,[]);assert.equal(f.facade.unexpected.length,1);
    assert.equal(f.facade.unexpected[0].routeShape,'unmatched-core-route');
    await assert.rejects(f.facade.close(),error=>{
      const sanitized=createDiagnosticSanitizer({homeDir:f.root}).sanitizeText(error.message);
      assert.match(sanitized,/Unexpected targeted wire facade routes/);
      assert.ok(sanitized.includes('not-a-route'));
      assert.equal(sanitized.includes(sessionID),false);
      assert.equal(sanitized.includes('ignored=query'),false);
      assert.match(sanitized,/REDACTED/);
      return true;
    });
  } finally {await f.close();}
});

test('failed wire cleanup retains a safe registered route shape through the original sanitizer',async()=>{
  const f=await setup();
  const sessionID='ses_0123456789abcdefAbCdEfGhIjKlMnOp';
  try{
    assert.equal((await f.request(`/api/session/${sessionID}/message`)).status,404);
    assert.deepEqual(f.facade.unexpected,[{method:'GET',path:`/session/${sessionID}/message`,
      pathSegments:['session',sessionID,'message'],routeShape:'/session/:sessionID/message'}]);
    await assert.rejects(f.facade.close(),error=>{
      const sanitized=createDiagnosticSanitizer({homeDir:f.root}).sanitizeText(error.message);
      assert.match(sanitized,/Unexpected targeted wire facade routes/);
      assert.ok(sanitized.includes('/session/:sessionID/message'));
      assert.equal(sanitized.includes(sessionID),false);
      assert.match(sanitized,/REDACTED/);
      return true;
    });
  }finally{await f.close();}
});

test('manual wire routing reaches native compact: idle completes one canonical fixture summary and busy refuses without abort',async()=>{
  const f=await setup();
  try {
    for(const busy of [false,true]){
      if(busy)f.fixture.startScenario('one-stream');else f.fixture.stopScenario();
      const before=f.fixture.getState(),beforeRows=f.fixture.wireMessages(PERF_PARENT_SESSION_ID);
      const response=await f.request(`/api/session/${PERF_PARENT_SESSION_ID}/summarize`,{});
      const submission={matchingRequestCount:1,requests:[{response:{status:response.status}}],...(busy?{failure:'summarize-http-rejected'}:{})};
      const after=f.fixture.getState(),afterRows=f.fixture.wireMessages(PERF_PARENT_SESSION_ID);
      const result=gradeQaManualFixtureSubmission({busy,submission,before,after,beforeRows,afterRows});
      if(!busy){
        assert.match(result.compactionID,/^msg_/);
        const history=await f.request(`/api/session/${PERF_PARENT_SESSION_ID}/message`);
        assert.ok(history.body.some(row=>row.info.id===result.compactionID&&row.parts.some(part=>part.type==='compaction')));
        assert.ok(history.body.some(row=>row.info.summary===true&&row.info.parentID===result.compactionID));
      }
      assert.throws(()=>gradeQaManualFixtureSubmission({busy,submission:{...submission,matchingRequestCount:2},before,after,beforeRows,afterRows}));
    }
    assert.deepEqual(f.passed,[]);assert.deepEqual(f.facade.unexpected,[]);
  }finally{f.fixture.stopScenario();await f.close();}
});

test('original wire hub projects busy then idle for the held Low parent after interruption and reload',async()=>{
  const f=await setup();let reader;
  try{
    const session=(await f.request('/api/session',{title:'queued thinking boundary'})).body;
    const events=[];let buffered='';
    const connect=async()=>{
      const response=await fetch(f.facade.origin+'/api/global/event',{signal:AbortSignal.timeout(10000)});
      assert.equal(response.status,200);reader=response.body.getReader();buffered='';
    };
    const until=async predicate=>{
      const deadline=Date.now()+5000;
      while(!predicate()){
        assert.ok(Date.now()<deadline,'Bounded projected SSE edge');
        const chunk=await reader.read();assert.equal(chunk.done,false);
        buffered+=new TextDecoder().decode(chunk.value);
        let index;
        while((index=buffered.indexOf('\n\n'))>=0){
          const frame=buffered.slice(0,index);buffered=buffered.slice(index+2);
          const data=frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim()).join('\n');
          if(data){const envelope=JSON.parse(data);if(envelope.payload?.properties?.sessionID===session.id)events.push(envelope.payload);}
        }
      }
    };
    await connect();
    for(const [index,behavior] of [{chunks:2,intervalMs:10},{reasoning:'empty',hold:true},
      {reasoning:'delayed',hold:true,chunks:2,intervalMs:10},{hold:true,chunks:2,intervalMs:10}].entries()){
      const offset=events.length,variant=index===3?'low':'high',messageID=`msg_wireedge00${index}`;
      f.fixture.configureNextPrompt(session.id,behavior);
      assert.equal((await f.request(`/api/session/${session.id}/prompt_async`,{messageID,agent:'build',variant,
        model:{providerID:'fixture',modelID:'fixture-model'},parts:[{type:'text',text:'Finite parent turn'}]})).status,204);
      await until(()=>events.slice(offset).some(event=>event.type==='session.status'&&event.properties.status.type==='busy'));
      if(index===1)assert.equal((await f.request(`/api/session/${session.id}/abort`,{})).status,200);
      else if(index===2){f.fixture.setPromptReasoning(session.id,'Finite reasoning');f.fixture.releasePrompt(session.id);}
      else if(index===3)f.fixture.releasePrompt(session.id);
      await until(()=>events.slice(offset).some(event=>event.type==='session.idle'));
      const edges=events.slice(offset).filter(event=>event.type==='session.status').map(event=>event.properties.status.type);
      assert.equal(edges[0],'busy');assert.equal(edges.at(-1),'idle');
      const status=(await f.request('/api/session/status')).body;assert.deepEqual(status,{});
      const rows=(await f.request(`/api/session/${session.id}/message`)).body;
      assert.equal(rows.at(-1).info.parentID,messageID);assert.ok(Number.isFinite(rows.at(-1).info.time.completed));
      if(index===2){await reader.cancel();reader.releaseLock();reader=null;await connect();}
    }
    assert.equal(f.fixture.getState().receivedPrompts.at(-1).variant,'low');
    assert.equal(f.fixture.getState().receivedPrompts.length,4);assert.equal(f.fixture.getState().activePrompts,0);
    assert.equal(f.fixture.getState().eventCounts['session.execution.succeeded'],3);
  }finally{if(reader){await reader.cancel();reader.releaseLock();}await f.close();}
});
