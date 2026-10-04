import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {assertWriterOutcome} from './assertions.mjs';
import {snapshotOwnedTree} from './package-rollback-lane.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const articleTitle='Compiled original Slim article';
const articleText='The isolated original parser preserves this article and its exact local evidence. '.repeat(20)+'Final compiled article marker.';
const article=`<!doctype html><html><head><title>${articleTitle}</title></head><body><main><article><h1>${articleTitle}</h1><p>${articleText}</p></article></main></body></html>`;
const text='Exact compiled original webfetch text\nNo external service or credential was used.\n';

/** A real HTTP server, without DNS rewriting or an injected fetch function.
 * Original Slim first attempts HTTPS for HTTP input; only a TLS ClientHello
 * on this HTTP socket is an expected parser refusal before its own fallback. */
export async function createCompiledSlimFetchFixture(){
 const requests=[],active=new Set(),sockets=new Set();let failure,closed=false,closing,tlsAttempts=0;
 const check=()=>{if(failure)throw failure;};
 const server=createServer((request,response)=>{
  const work=(async()=>{
   assert.equal(closed,false);assert.equal(request.method,'GET');
   assert.equal(request.headers.authorization,undefined);assert.equal(request.headers['x-api-key'],undefined);
   assert.ok(['/text','/article'].includes(request.url),'Unexpected original webfetch route');
   requests.push(request.url);const html=request.url==='/article';
   response.writeHead(200,{'content-type':html?'text/html; charset=utf-8':'text/plain; charset=utf-8','cache-control':'no-store'}).end(html?article:text);
  })().catch(cause=>{failure??=cause;if(!response.headersSent)response.writeHead(500);response.end('Owned webfetch fixture refused');})
   .finally(()=>active.delete(work));active.add(work);
 });
 server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
 server.on('clientError',(cause,socket)=>{
  if(cause.code==='HPE_INVALID_METHOD'&&cause.rawPacket?.[0]===22)tlsAttempts++;else failure??=cause;
  socket.destroy();
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
 return {url:suffix=>{assert.ok(['/text','/article'].includes(suffix));return `http://devryan.localhost:${server.address().port}${suffix}`;},
  requests,check,get tlsAttempts(){return tlsAttempts;},text,articleTitle,articleText,
  close:()=>closing??=(async()=>{
   closed=true;const stopped=new Promise((resolve,reject)=>server.close(cause=>cause?reject(cause):resolve()));
   for(const socket of sockets)socket.destroy();await stopped;await Promise.allSettled(active);check();
  })(),
 };
}
const workspace=async directory=>(await snapshotOwnedTree(directory)).filter(row=>row.path!=='.git'&&!row.path.startsWith('.git'+path.sep));

/** Refuse output-only success without the actual supervised worker and the
 * exact canonical call's existing published process lease. */
export async function assertCompiledAstReceipt({runtime,observations,directory,sessionID,call}){
 assert.equal(call.state.status,'completed');
 await assertWriterOutcome({runtime,observations,directory,sessionID,callID:call.callID,succeeded:true});
 const lease=await runtime.leaseForCall({directory,sessionID,callID:call.callID});
 assert.equal(lease.scope.sessionID,sessionID);assert.equal(lease.scope.messageID,call.messageID);assert.equal(lease.scope.callID,call.callID);
 const receipt=observations.find(row=>row.callID===call.callID&&row.phase==='termination_verified');
 assert.equal(receipt.receipt.exitCode,0);assert.equal(receipt.receipt.cancelled,false);return lease;
}

/** Production compiled original AST definitions/CLI/formatters and webfetch
 * parser over a real local transport. No tool execution is mocked here. */
export async function runCompiledSlimTools({invoke,createSession,directory,runtime,observations,admitPrimary}){
 assert.equal(await fs.realpath(directory),directory);assert.equal(typeof admitPrimary,'function');assert.equal(typeof createSession,'function');
 // Native permissions belong to the constructor-owned admission.create path;
 // the public session facade deliberately cannot configure this ruleset.
 const session=await createSession({title:'Compiled original Slim leaf tools',agent:'orchestrator',
  model:{providerID:'devryan-smoke',modelID:'smoke-write'},permissions:
   ['write','ast_grep_search','ast_grep_replace','webfetch'].map(action=>({action,resource:'*',effect:'allow'}))},{directory});
 await admitPrimary(session.id);const options={sessionID:session.id,directory},cases=[];
 const file='compiled-slim-ast.js',original="console.log('compiled original');\n",updated="logger.info('compiled original');\n";
 // Setup uses the same native writer/publication path, not a host shortcut.
 await invoke({id:'compiled-slim-ast-setup',tool:'write',input:{path:file,content:original}},options);
 const before=await workspace(directory);
 const input={pattern:'console.log($MSG)',lang:'javascript',paths:[path.join(directory,file)]};
 const search=await invoke({id:'compiled-slim-ast-search',tool:'ast_grep_search',input},options);
 await assertCompiledAstReceipt({runtime,observations,directory,sessionID:session.id,call:search});
 assert.ok(search.state.output.includes("console.log('compiled original')"));assert.match(search.state.output,/Found 1 matches in 1 files/);
 assert.deepEqual(await workspace(directory),before,'Original AST search published unexpected workspace changes');
 const dry=await invoke({id:'compiled-slim-ast-preview',tool:'ast_grep_replace',input:{...input,rewrite:'logger.info($MSG)'}},options);
 await assertCompiledAstReceipt({runtime,observations,directory,sessionID:session.id,call:dry});
 assert.match(dry.state.output,/\[DRY RUN\] 1 replacements in 1 files/);assert.ok(dry.state.output.includes("logger.info('compiled original')"));
 assert.deepEqual(await workspace(directory),before,'Original AST preview published changes');
 const replaced=await invoke({id:'compiled-slim-ast-replace',tool:'ast_grep_replace',input:{...input,rewrite:'logger.info($MSG)',dryRun:false}},options);
 const lease=await assertCompiledAstReceipt({runtime,observations,directory,sessionID:session.id,call:replaced});
 assert.match(replaced.state.output,/\[APPLIED\] 1 replacements in 1 files/);assert.equal(await fs.readFile(path.join(directory,file),'utf8'),updated);
 const after=await workspace(directory);assert.equal(after.length,before.length);
 assert.deepEqual(after.filter(row=>row.path!==file),before.filter(row=>row.path!==file),'Original AST replace modified another workspace path');
 const ast={id:'compiled-original-slim-ast',status:'passed',sessionID:session.id,callIDs:[search.callID,dry.callID,replaced.callID],
  publicationOperationID:lease.result.operationID,originalSha256:hash(original),publishedSha256:hash(updated),
  source:'compiled-original-ast-definitions-sealed-cli-supervised-private-view-real-receipts-and-publication'};cases.push(ast);
 const fixture=await createCompiledSlimFetchFixture();
 try{
  const unchanged=await workspace(directory);
  for(const [suffix,format]of [['/text','text'],['/article','markdown']]){
   const call=await invoke({id:suffix==='/text'?'compiled-slim-webfetch-text':'compiled-slim-webfetch-html',tool:'webfetch',control:true,
    input:{url:fixture.url(suffix),format,prefer_llms_txt:'never',include_metadata:true,extract_main:true,timeout:10}},options);
   fixture.check();assert.equal(call.state.status,'completed');
   if(suffix==='/text')assert.ok(call.state.output.includes(fixture.text.trim()));
   else{assert.ok(call.state.output.includes(fixture.articleTitle));assert.ok(call.state.output.includes('Final compiled article marker.'));}
   const control=await runtime.leaseForCall({directory,sessionID:session.id,callID:call.callID});
   assert.equal(control.executionKind,'control');assert.equal(control.state,'published');assert.equal(control.scope.messageID,call.messageID);
   const outcomes=await runtime.executionOutcomes({directory,sessionID:session.id,calls:[{callID:call.callID,messageID:call.messageID}]});
   assert.equal(outcomes.length,1);assert.equal(outcomes[0].outcome,'finished');
  }
  assert.deepEqual(fixture.requests,['/text','/article'],'Original webfetch omitted or repeated a physical HTTP request');
  assert.ok(fixture.tlsAttempts>=2,'Original HTTPS upgrade/fallback was bypassed');
  assert.deepEqual(await workspace(directory),unchanged,'Read-only original webfetch modified project bytes');
  cases.push({id:'compiled-original-slim-webfetch',status:'passed',sessionID:session.id,requests:fixture.requests.length,
   originalHttpsAttempts:fixture.tlsAttempts,textSha256:hash(fixture.text),source:'compiled-original-webfetch-https-upgrade-http-fallback-owned-control-and-sealed-original-jsdom-parser',
   secondaryModel:'not-requested'});
 }finally{await fixture.close();}
 assert.deepEqual(await runtime.activeLeases({directory,sessions:[session.id]}),[]);return cases;
}
