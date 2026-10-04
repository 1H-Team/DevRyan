import test from 'node:test';
import assert from 'node:assert/strict';
import {createCompiledSlimWebBridge,loadOriginalSlimCommandOracle,normalizeOriginalLoopPrompt,assertCompiledInterviewUsers} from './package-slim-lane.mjs';

test('exact captured pure factories produce activation rather than static declaration templates',async()=>{
 const oracle=await loadOriginalSlimCommandOracle();assert.match(oracle.sourceSha256,/^[a-f0-9]{64}$/);
 const deepwork=await oracle.prompt('deepwork','  exact original task  ');
 assert.ok(deepwork.startsWith('Use the deepwork skill'));assert.ok(deepwork.endsWith('Task:\nexact original task'));
 assert.ok(deepwork.includes('.slim/deepwork/'));assert.notEqual(deepwork,'Start a deepwork session for a complex coding task');
 const loop=await oracle.prompt('loop','goal: local test; successCriteria: pass; maxAttempts: 1');
 assert.ok(normalizeOriginalLoopPrompt(loop).includes('loop-<original-random-id>'));assert.ok(loop.includes('Dispatch @fixer'));
 const anotherLoop=loop.replace(/loop-[a-z0-9]+-[a-z0-9]+/g,'loop-independent-fixture');
 assert.equal(anotherLoop.includes(loop.split('\n').slice(0,12).join('\n')),false);
 assert.equal(normalizeOriginalLoopPrompt(anotherLoop),normalizeOriginalLoopPrompt(loop));
 assert.notEqual(normalizeOriginalLoopPrompt(anotherLoop.replace('Dispatch @fixer','Dispatch @oracle')),normalizeOriginalLoopPrompt(loop));
 assert.throws(()=>normalizeOriginalLoopPrompt(loop.replace(/loop-[a-z0-9]+-[a-z0-9]+/,'loop-tampered-path')),/strictly equal/);
 const reflect=await oracle.prompt('reflect','--sessions --last 200 exact focus');
 assert.ok(reflect.includes('Analyze the last 100 sessions'));assert.ok(reflect.endsWith('Focus:\nexact focus'));
 assert.notEqual(reflect,'Review repeated work and suggest workflow improvements');
 await assert.rejects(loadOriginalSlimCommandOracle({artifacts:{manifest:{inputs:{sourceFiles:[]}}}}),/absent from compiled evidence/);
 await assert.rejects(loadOriginalSlimCommandOracle({artifacts:{manifest:{inputs:{sourceFiles:[{path:'packages/web/runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js',sha256:'a'.repeat(64)}]}}}}),/strictly equal/);
});

test('fixture web bridge mounts only the existing owner and retains constructor/event boundaries',async()=>{
 const bridge=await createCompiledSlimWebBridge(),directory='/owned/fixture';
 try{
  assert.equal((await bridge.request(directory,'/')).status,503);
  const requests=[];bridge.bindRuntimeOwner({handleInterviewRequest:async(req,res)=>{requests.push(req.url);res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({source:'existing owner'}));return true;}});
  const response=await bridge.request(directory,'/api/interviews');assert.equal(response.status,200);assert.deepEqual(await response.json(),{source:'existing owner'});
  assert.match(requests[0],/^\/api\/openchamber\/interviews\/[a-f0-9]{64}\/api\/interviews$/);
  assert.throws(()=>bridge.bindRuntimeOwner({handleInterviewRequest:async()=>true}));
  await assert.rejects(bridge.emitIntegrationEvent({directory,sessionID:'ses_owned',kind:'interview-open',path:'https://external.invalid/'}));
  await assert.rejects(bridge.request(directory,'/../escape'));
 }finally{await bridge.close();}
 await assert.rejects(bridge.request(directory,'/'));
});


test('interview count oracle preserves the original standalone synthetic notification without a duplicate accepted user',async()=>{
 const {projectMessagePage}=await import('../../packages/web/server/lib/opencode/v2/projection/messages.js');
 const sessionID='ses_interview',idea='Exact local idea';
 const canonical=[{id:'msg_command',sessionID,type:'user',time:{created:1},text:`<omos-interview-command>${idea}</omos-interview-command>`,
  metadata:{devryan:{v:1,origin:'native',command:{name:'interview',sessionID,messageID:'msg_command'}}}},
 {id:'msg_answer',sessionID,type:'assistant',time:{created:2,completed:3},agent:'orchestrator',model:{providerID:'fixture',id:'model'},content:[{type:'text',text:'exact answer'}],finish:'stop'},
 {id:'msg_notice',sessionID,type:'synthetic',time:{created:4},metadata:{devryan:{v:1,origin:'interview'}},
  text:'⎔ Interview UI ready\n\nOpen: http://127.0.0.1:1/api/openchamber/interviews/'+ 'a'.repeat(64)+'/interview/local\nDocument: interview/local.md\n\n[system status: continue without acknowledging this notification]'}];
 const records=projectMessagePage(canonical,{sessionID,directory:'/owned',agent:'orchestrator',model:{providerID:'fixture',id:'model'}}).records;
 assert.equal(records.filter(row=>row.info.role==='user').length,2,'Real native projection exposes the synthetic notice as user-role');
 assert.equal(assertCompiledInterviewUsers({records,canonical,sessionID,idea}).info.id,'msg_command');
 assert.throws(()=>assertCompiledInterviewUsers({records,canonical:[...canonical,{...canonical[0],id:'msg_duplicate'}],sessionID,idea}),/exactly one native accepted user/);
 assert.throws(()=>assertCompiledInterviewUsers({records,canonical:[...canonical,canonical[2]],sessionID,idea}),/exactly one native no-reply/);
 assert.throws(()=>assertCompiledInterviewUsers({records,canonical:canonical.filter(row=>row.type!=='synthetic'),sessionID,idea}),/exactly one native no-reply/);
 const forged=structuredClone(records);forged.find(row=>row.info.id==='msg_notice').parts[0].synthetic=false;
 assert.throws(()=>assertCompiledInterviewUsers({records:forged,canonical,sessionID,idea}),/strictly equal/);
 const changed=structuredClone(canonical);changed[2].metadata.devryan.origin='caller';
 assert.throws(()=>assertCompiledInterviewUsers({records,canonical:changed,sessionID,idea}),/strictly equal/);
 assert.throws(()=>assertCompiledInterviewUsers({records,canonical,sessionID,idea:'changed argument'}),/strictly equal/);
});
