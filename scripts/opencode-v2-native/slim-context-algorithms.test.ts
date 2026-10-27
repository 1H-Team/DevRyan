import {test,expect} from 'bun:test';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {pathToFileURL} from 'node:url';
import {bundleAgentsCore,importAgentsCore} from './agents-core-fixture.ts';
import {createOwnedSlimTaskBoardRenderer} from '../../packages/web/server/lib/opencode/runtime-host/native-slim-context-algorithms.js';
import type * as ReviewedSlim from '../../packages/agents-core/index.js';

test('original pure retry selector preserves chain order, rearm and exhaustion without a fallback manager',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'devryan-slim-context-')));
 try{
  const originals=await importAgentsCore(root);
  const initial={chains:{explorer:['saved/first','saved/second','saved/last']},agent:'explorer',currentModel:'saved/first',tried:[],exhaustion:0 as const};const before=JSON.stringify(initial);
  const first=originals.selectReviewedSlimFallback(initial);expect(first.selection).toMatchObject({nextModel:'saved/second',ref:{providerID:'saved',modelID:'second'}});expect(JSON.stringify(initial)).toBe(before);
  const second=originals.selectReviewedSlimFallback({...initial,currentModel:'saved/second',tried:first.tried,exhaustion:first.exhaustion});expect(second.selection).toMatchObject({nextModel:'saved/last'});
  const reFallback=originals.selectReviewedSlimFallback({...initial,currentModel:'saved/last',tried:second.tried,exhaustion:second.exhaustion});expect(reFallback.exhaustion).toBe(1);expect(reFallback.selection).toMatchObject({nextModel:'saved/last'});
  const exhausted=originals.selectReviewedSlimFallback({...initial,currentModel:'saved/last',tried:['saved/first','saved/second','saved/last'],exhaustion:1});expect(exhausted.selection).toBe('exhausted');expect(exhausted.exhaustion).toBe(2);
  expect(originals.selectReviewedSlimFallback({...initial,tried:['saved/first','saved/last'],exhaustion:2}).selection).toMatchObject({nextModel:'saved/second'});
  expect(originals.isReviewedSlimFailoverError({statusCode:429})).toBe(true);expect(originals.isReviewedSlimFailoverError({message:'invalid request shape'})).toBe(false);
  expect(()=>originals.processReviewedSlimImageAttachments({messages:[],workDir:root,imageRouting:'direct',disabledAgents:new Set(),log:()=>{}})).toThrow('reviewed_slim_image_worker_required');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('original taskboard renderer uses canonical owner formatting and exact terminal CAS inside existing fence',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'devryan-slim-board-')));
 try{
  const originals=await importAgentsCore(root);
  let live=true,inFence=false;const reconciled:unknown[]=[];
  let job:ReviewedSlim.ReviewedSlimBoardJob={taskID:'ses_child',parentSessionID:'ses_parent',alias:'exp-1',agent:'explorer',state:'completed',generation:3,taskGeneration:3,terminalRevision:7,activityRevision:0,terminalUnreconciled:true,contextFiles:[],description:'Exact & objective',resultSummary:'Exact result',
   background:true,timedOut:false,recoverableAfterLiveBusy:false,statusUncertain:false,cancellationRequested:false,launchedAt:1,lastLaunchedAt:1,runStartedAt:1,updatedAt:2,lastUsedAt:2};
  const renderer=createOwnedSlimTaskBoardRenderer(originals,{assertCurrent:async()=>{if(!live)throw new Error('task_grant_revoked');},withTaskState:async action=>{inFence=true;try{await action();}finally{inFence=false;}},presentation:{shouldManageSession:id=>id==='ses_parent',board:{get:()=>job,
   formatForPromptWithMetadata:()=>originals.formatReviewedSlimTaskBoard({jobs:[job],reusable:job.terminalUnreconciled?[]:[job]}),
   markReconciled:(taskID,_at,generation,revision)=>{if(!inFence)throw new Error('missing_owner_fence');reconciled.push({taskID,generation,revision});job={...job,state:'reconciled',terminalUnreconciled:false};return job;},
  }}});
  const first={messages:[{info:{id:'msg_first',role:'user',sessionID:'ses_parent',agent:'orchestrator'},parts:[{type:'text',text:'Exact objective'}]}]};await renderer.transform({},first);
  expect(JSON.stringify(first)).toContain('SENTINEL: background-job-board-v2');expect(JSON.stringify(first)).toContain('Exact &amp; objective');expect(reconciled).toEqual([]);
  const next={messages:[...first.messages,{info:{id:'msg_next',role:'user',sessionID:'ses_parent',agent:'orchestrator'},parts:[{type:'text',text:'Continue'}]}]};await renderer.transform({},next);expect(reconciled).toEqual([{taskID:'ses_child',generation:3,revision:7}]);
  live=false;await expect(renderer.transform({},next)).rejects.toThrow('task_grant_revoked');expect(reconciled).toHaveLength(1);renderer.clearSession('ses_parent');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('fresh image workers save content-addressed images without carrying state between runs',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'devryan-slim-image-state-')));
 try{
  const entry=await bundleAgentsCore(root),view=path.join(root,'view');await fs.mkdir(view);
  // 3.x keeps no per-directory state: every confined worker run is fresh and
  // the saved, content-addressed file is the only memo.
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const script=path.join(root,'worker.mjs');await fs.writeFile(script,`import * as original from ${JSON.stringify(entry)};
const view=process.cwd();original.bindReviewedSlimImageWorker(view);
if(process.env.REVIEWED_ESCAPE)original.processReviewedSlimImageAttachments({messages:[],workDir:'/elsewhere',imageRouting:'auto',disabledAgents:new Set(),log:()=>{}});
const messages=[{info:{role:'user',id:'msg_one',sessionID:'ses_owned'},parts:[{type:'file',url:'data:image/png;base64,${png}',mime:'image/png',filename:'same.png'}]}];const logs=[];
const skipped=original.processReviewedSlimImageAttachments({messages,workDir:view,imageRouting:'auto',disabledAgents:new Set(process.env.REVIEWED_IMAGES==='enabled'?[]:['observer']),log:message=>{logs.push(message)}});
console.log(JSON.stringify({skipped,logs,parts:messages[0].parts}));`);
  const run=async(env:Record<string,string>)=>{const childProcess=Bun.spawn([process.execPath,script],{cwd:view,env:{...globalThis.process.env,...env},stdout:'pipe',stderr:'pipe'});const out=await new Response(childProcess.stdout).text(),error=await new Response(childProcess.stderr).text();return {exit:await childProcess.exited,out,error};};
  const parse=async(env:Record<string,string>)=>{const result=await run(env);expect(result.exit).toBe(0);expect(result.error).toBe('');return JSON.parse(result.out);};
  const retained=await parse({});expect(retained.skipped).toBe(true);expect(retained.logs).toHaveLength(1);expect(retained.parts[0].type).toBe('file');
  const saved=await fs.realpath(view)+'/.opencode/images/ses_owned/same-c7a9c45f.png';
  const notice='[Image saved to:\n- '+saved+'\nDelegate to @observer with the path(s) and your goal — @observer reads images with its read tool.]';
  const first=await parse({REVIEWED_IMAGES:'enabled'});expect(first.skipped).toBe(false);expect(first.parts).toEqual([{type:'text',text:notice}]);
  expect(Buffer.from(await fs.readFile(saved)).toString('base64')).toBe(png);
  const again=await parse({REVIEWED_IMAGES:'enabled'});expect(again.parts).toEqual(first.parts);
  expect(await fs.readdir(path.join(view,'.opencode/images/ses_owned'))).toEqual(['same-c7a9c45f.png']);
  const escape=await run({REVIEWED_ESCAPE:'1'});expect(escape.exit).not.toBe(0);expect(escape.error).toContain('reviewed_slim_image_worker_required');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
