import {test,expect} from 'bun:test';import fs from 'node:fs/promises';import path from 'node:path';import {pathToFileURL} from 'node:url';
import {rewriteReviewedSlimServer} from '../../packages/web/server/lib/opencode/runtime-host/reviewed-package-transforms.js';
import {createOwnedSlimTaskBoardRenderer} from '../../packages/web/server/lib/opencode/runtime-host/native-slim-context-algorithms.js';
import type * as ReviewedSlim from '../../packages/web/runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js';

test('original pure retry selector preserves chain order, rearm and exhaustion without a fallback manager',async()=>{
 const root=await fs.mkdtemp(path.resolve('.cache/v2-validation/slim-context-'));
 try{
  const entry=path.join(root,'reviewed.mjs');await fs.writeFile(entry,rewriteReviewedSlimServer(await fs.readFile(new URL('../../packages/web/runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js',import.meta.url))).contents);
  const originals:typeof ReviewedSlim=await import(pathToFileURL(entry).href);
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
 const root=await fs.mkdtemp(path.resolve('.cache/v2-validation/slim-board-'));
 try{
  const entry=path.join(root,'reviewed.mjs');await fs.writeFile(entry,rewriteReviewedSlimServer(await fs.readFile(new URL('../../packages/web/runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js',import.meta.url))).contents);
  const originals:typeof ReviewedSlim=await import(pathToFileURL(entry).href);
  let live=true,inFence=false;const reconciled:unknown[]=[];
  let job:ReviewedSlim.ReviewedSlimBoardJob={taskID:'ses_child',alias:'exp-1',agent:'explorer',state:'completed',generation:3,terminalRevision:7,terminalUnreconciled:true,contextFiles:[],description:'Exact & objective',resultSummary:'Exact result'};
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

test('fresh image workers restore only bounded per-location original presentation state',async()=>{
 const root=await fs.mkdtemp(path.resolve('.cache/v2-validation/slim-image-state-'));
 try{
  const entry=path.join(root,'reviewed.mjs'),view=path.join(root,'view');await fs.mkdir(view);await fs.writeFile(entry,rewriteReviewedSlimServer(await fs.readFile(new URL('../../packages/web/runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js',import.meta.url))).contents);
  const script=path.join(root,'worker.mjs');await fs.writeFile(script,`import * as original from ${JSON.stringify(pathToFileURL(entry).href)};
const view=process.cwd(),logical='/reviewed/location';original.bindReviewedSlimImageWorker(view);
const state=JSON.parse(process.env.REVIEWED_STATE||'null');if(state)original.restoreReviewedSlimImageState(state,logical);
const messages=[{info:{role:'user',id:'msg_one',sessionID:'ses_owned'},parts:[{type:'file',url:'data:image/png;base64,aGVsbG8=',mime:'image/png',filename:'same.png'}]}];let notices=0;
const skipped=original.processReviewedSlimImageAttachments({messages,workDir:view,imageRouting:'auto',disabledAgents:new Set(process.env.REVIEWED_IMAGES==='enabled'?[]:['observer']),log:()=>{notices++}});
console.log(JSON.stringify({skipped,notices,state:original.snapshotReviewedSlimImageState(logical)}));`);
  const run=async(state?:unknown,images=false)=>{const childProcess=Bun.spawn([process.execPath,script],{cwd:view,env:{...globalThis.process.env,REVIEWED_STATE:state?JSON.stringify(state):'',REVIEWED_IMAGES:images?'enabled':''},stdout:'pipe',stderr:'pipe'});const out=await new Response(childProcess.stdout).text(),error=await new Response(childProcess.stderr).text();expect(await childProcess.exited).toBe(0);expect(error).toBe('');return JSON.parse(out);};
  const first=await run();expect(first).toMatchObject({skipped:true,notices:1,state:{schema:1,logicalDirectory:'/reviewed/location',counts:[['ses_owned',1]]}});expect(JSON.stringify(first.state)).not.toContain(view);
  const next=await run(first.state);expect(next).toMatchObject({skipped:false,notices:0});expect(next.state).toEqual(first.state);
  const image=await run(undefined,true);expect(image.state.resolved).toHaveLength(1);expect(image.state.resolved[0][0]).toContain('/.opencode/images/ses_owned\n');const imageRestored=await run(image.state,true);expect(imageRestored.state.resolved).toEqual(image.state.resolved);expect(imageRestored.state.cleanup).toEqual(image.state.cleanup);
  const malicious={...first.state,resolved:[['/.opencode/images\nname\nhash','../outside']]};const child=Bun.spawn([process.execPath,script],{cwd:view,env:{...process.env,REVIEWED_STATE:JSON.stringify(malicious)},stdout:'pipe',stderr:'pipe'});expect(await child.exited).not.toBe(0);expect(await new Response(child.stderr).text()).toContain('reviewed_slim_image_state_invalid');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
