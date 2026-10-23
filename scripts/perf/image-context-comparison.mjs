#!/usr/bin/env node
// Compare the real text-only image preparation path with HEAD on one synthetic tree.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {createSessionExecutionHost} from '../../packages/web/server/lib/opencode/session-execution-host.js';
import {readNativeRuntimeManifest,verifyNativeRuntimeArtifacts} from '../../packages/web/server/lib/opencode/runtime-host/native-artifacts.js';
import {createRunRoot,scratchParent} from '../qa/run-root.mjs';

const repository=fileURLToPath(new URL('../../',import.meta.url)).replace(/\/$/,'');
const ownerPath='packages/web/server/lib/opencode/runtime-host/native-image-runtime.js';
const hash=value=>createHash('sha256').update(value).digest('hex');
const milliseconds=value=>Math.round(value*1000)/1000;
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
const checkedInteger=(value,min,max)=>{const number=Number(value);assert.ok(Number.isSafeInteger(number)&&number>=min&&number<=max);return number;};

async function importOwner(source){
 const dependency=pathToFileURL(path.join(repository,path.dirname(ownerPath),'native-owned-requests.js')).href;
 assert.equal(source.split("'./native-owned-requests.js'").length,2,'Expected exactly one owned-request dependency');
 return import('data:text/javascript;base64,'+Buffer.from(source.replace("'./native-owned-requests.js'",JSON.stringify(dependency))).toString('base64'));
}

export async function compareImageContext({artifactRoot,fileCount=1200,bytesPerFile=4096,pairs=3,keepArtifacts=false}){
 assert.equal(process.platform,'darwin');assert.equal(process.arch,'arm64');
 fileCount=checkedInteger(fileCount,1,12000);bytesPerFile=checkedInteger(bytesPerFile,128,65536);pairs=checkedInteger(pairs,1,3);
 artifactRoot=await fs.realpath(artifactRoot);
 assert.ok(artifactRoot.startsWith(repository+path.sep),'Use a repository-owned native artifact');
 const manifestPath=path.join(artifactRoot,'native-bundle.json');
 const {bytes}=await readNativeRuntimeManifest(manifestPath);
 const artifacts=await verifyNativeRuntimeArtifacts({manifestPath,manifestSha256:hash(bytes),launcher:path.join(artifactRoot,'DevRyan-execution-darwin-arm64')});
 const verifySources=async()=>{
  for(const source of [...artifacts.manifest.inputs.buildSources,...artifacts.manifest.inputs.sourceFiles]){
   assert.equal(typeof source.path,'string');const file=path.resolve(repository,source.path);
   assert.ok(file.startsWith(repository+path.sep),'Native source escaped repository');
   assert.equal(hash(await fs.readFile(file)),source.sha256,`Shared native artifact source changed: ${source.path}`);
  }
 };
 await verifySources();
 const baselineSource=execFileSync('git',['show',`HEAD:${ownerPath}`],{cwd:repository,encoding:'utf8',maxBuffer:1024*1024});
 const candidateSource=await fs.readFile(path.join(repository,ownerPath),'utf8');
 assert.notEqual(hash(baselineSource),hash(candidateSource),'Baseline and candidate must differ');
 const baseline=await importOwner(baselineSource),candidate=await importOwner(candidateSource);
 let stopActive=async()=>{};
 const run=createRunRoot({parent:scratchParent('perf'),prefix:'image-context-',owner:'scripts/perf/image-context-comparison.mjs',keepArtifacts,onInterrupt:()=>stopActive()});
 const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(Error('image_context_benchmark_timeout')),600000);
 const fixture=path.join(await fs.realpath(run.dir),'fixture'),directory=path.join(fixture,'project');
 const report={schemaVersion:1,scope:'same synthetic text-only context and project; real image worker, execution supervisor, view materialization and mutation ledger; constructor-owned fixture authorization',
  excluded:['provider/model latency','token savings','installed app','original user project','fresh candidate native build qualification'],
  sources:{baseline:{ref:'HEAD',sha256:hash(baselineSource)},candidate:{sha256:hash(candidateSource)}},
  artifact:{buildId:artifacts.manifest.buildId,opencodeVersion:artifacts.manifest.opencodeVersion,manifestSha256:hash(bytes),sharedByBothArms:true},
  fixture:{fileCount,bytesPerFile,totalBytes:fileCount*bytesPerFile,sha256:null},pairs:[],outcome:'failed'};
 try{
  await fs.mkdir(directory,{recursive:true});
  const gitEnv={PATH:process.env.PATH,HOME:fixture,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'};
  execFileSync('git',['init','--quiet','--initial-branch=main','--template=',directory],{env:gitEnv});
  const files=[];
  for(let index=0;index<fileCount;index++){
   deadline.signal.throwIfAborted();
   const relative=`src/group-${Math.floor(index/100)}/file-${index}.txt`;
   const content=Buffer.alloc(bytesPerFile,97+index%26);Buffer.from(`Synthetic fixture file ${index}\n`).copy(content);
   files.push(relative);
   await fs.mkdir(path.dirname(path.join(directory,relative)),{recursive:true});await fs.writeFile(path.join(directory,relative),content);
  }
  files.sort();
  const fixtureDigest=async()=>{
   const found=[];
   const walk=async relative=>{for(const entry of await fs.readdir(path.join(directory,relative),{withFileTypes:true})){
    const file=path.posix.join(relative,entry.name);if(file==='.git')continue;
    if(entry.isDirectory())await walk(file);else{assert.ok(entry.isFile(),'Fixture gained a non-file entry');found.push(file);}
   }};
   await walk('');assert.deepEqual(found.sort(),files,'Fixture file inventory changed');
   const fixtureHash=createHash('sha256');for(const file of files){fixtureHash.update(file+'\0');fixtureHash.update(await fs.readFile(path.join(directory,file)));}
   return fixtureHash.digest('hex');
  };
  report.fixture.sha256=await fixtureDigest();
  const origin=artifacts.manifest.inputs.reviewedPlugins.find(row=>row.id==='devryan.slim');assert.ok(origin);
  const context={records:[{info:{id:'msg_text',role:'user',sessionID:'ses_text'},parts:[{type:'text',text:'Summarize the synthetic workspace without changing files.'}]}],
   latestTurnParent:{id:'msg_text',type:'user',fingerprint:'a'.repeat(64)}};
  const contextSha256=hash(JSON.stringify(context));
  async function arm(label,pair){
   const diagnostics=[];let workerAdmissions=0;
   const host=createSessionExecutionHost({dataDirectory:path.join(fixture,`ledger-${pair}-${label}`),getLauncher:()=>artifacts.launcher,
    openCodeClient:{generation:()=>2},onDiagnostic:row=>diagnostics.push(row),
    nativeExecution:{workerCommand:artifacts.writer,workerArgs:[],workerEnvironment:{PATH:process.env.PATH},socketDirectory:null,
     locations:[{directory}],reviewedAstOrigin:{kind:'plugin',...origin},
     captureContextAssets:async input=>({contextAssetID:randomUUID(),recheck:async()=>{assert.equal(hash(JSON.stringify(context)),contextSha256);},
      anchor:structuredClone(context.latestTurnParent),messageIDs:[...input.messageIDs],messages:structuredClone(context.records),imageRouting:'auto',disabledAgents:[],origin:{kind:'plugin',...origin}})}});
   const runtime=(label==='baseline'?baseline:candidate).createNativeImageRuntime({locations:[{directory}],
    admissionOwner:{captureSessionHookAuthorization:async()=>async()=>{}},readContext:async()=>structuredClone(context),
    executionHost:{nativeContextAssets:(...args)=>{workerAdmissions++;return host.nativeContextAssets(...args);}}});
   let closing;const close=()=>closing??=(async()=>{try{await runtime.close();}finally{await host.drain();}})();stopActive=close;
   const scope={requestID:randomUUID(),directory,sessionID:'ses_text',permit:{fixture:true}};
   const started=performance.now();let elapsedMs;
   try{
    const output=await runtime.transform({...scope,phase:'context',messageIDs:['msg_text']},{signal:deadline.signal});
    elapsedMs=milliseconds(performance.now()-started);assert.deepEqual(output,{replacements:[],imagesSkipped:false});
    await runtime.settle(scope);
   }catch(error){
    report.failedArm={label,pair,elapsedMs:milliseconds(performance.now()-started),workerAdmissions,
     diagnostics:diagnostics.filter(row=>['admission','preparation','view_files'].includes(row.phase)).map(({phase,state,elapsedMs,steps,code})=>({phase,state,elapsedMs,steps,code})).slice(-16)};
    throw error;
   }finally{await close();stopActive=async()=>{};}
   const phases=diagnostics.filter(row=>['admission','preparation'].includes(row.phase)&&row.state==='completed'&&row.steps!==undefined);
   const viewFiles=phases.flatMap(row=>String(row.steps??'').split(',')).filter(step=>step.startsWith('view_files:'));
   const viewFilesCount=viewFiles.reduce((sum,step)=>sum+Number(step.split(':')[1].split('/')[0]),0);
   const viewFilesMs=viewFiles.reduce((sum,step)=>sum+Number(step.split('/')[1]),0);
   assert.equal(workerAdmissions,label==='baseline'?1:0);assert.equal(viewFilesCount,label==='baseline'?1:0);
   assert.equal(hash(JSON.stringify(context)),contextSha256);
   assert.equal(await fixtureDigest(),report.fixture.sha256,'Arm changed the shared synthetic tree');
   const result={elapsedMs,workerAdmissions,viewFilesCount,viewFilesMs,outputSha256:hash(JSON.stringify({replacements:[],imagesSkipped:false}))};
   console.error(JSON.stringify({pair:pair+1,arm:label,...result}));return result;
  }
  for(let pair=0;pair<pairs;pair++){
   const order=pair%2?['candidate','baseline']:['baseline','candidate'],result={order};
   for(const label of order)result[label]=await arm(label,pair);
   assert.equal(result.baseline.outputSha256,result.candidate.outputSha256);report.pairs.push(result);
  }
  assert.equal(hash(await fs.readFile(path.join(repository,ownerPath))),hash(candidateSource),'Candidate owner changed during measurement');
  assert.equal(hash(await fs.readFile(manifestPath)),hash(bytes),'Shared native artifact changed during measurement');
  await verifySources();
  report.summary=Object.fromEntries(['baseline','candidate'].map(label=>[label,{medianElapsedMs:median(report.pairs.map(pair=>pair[label].elapsedMs)),
   workerAdmissions:report.pairs.reduce((sum,pair)=>sum+pair[label].workerAdmissions,0),viewFilesCount:report.pairs.reduce((sum,pair)=>sum+pair[label].viewFilesCount,0),
   medianViewFilesMs:median(report.pairs.map(pair=>pair[label].viewFilesMs))}]));
  report.outcome='passed';
 }catch(error){report.error=error.code??error.message;throw error;}
 finally{
  clearTimeout(timer);
  await fs.writeFile(path.join(run.dir,'report.json'),JSON.stringify(report,null,2)+'\n');
  await fs.rm(fixture,{recursive:true,force:true});run.finish(report.outcome==='passed'?'passed':'failed');
 }
 return {report,reportPath:path.join(run.dir,'report.json')};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const {values}=parseArgs({options:{'artifact-root':{type:'string'},files:{type:'string'},'bytes-per-file':{type:'string'},pairs:{type:'string'},'keep-artifacts':{type:'boolean'}}});
 assert.ok(values['artifact-root'],'Explicit verified repository-owned artifact root required');
 const result=await compareImageContext({artifactRoot:values['artifact-root'],fileCount:values.files??1200,bytesPerFile:values['bytes-per-file']??4096,
  pairs:values.pairs??3,keepArtifacts:values['keep-artifacts']});
 console.log(JSON.stringify({outcome:result.report.outcome,fixture:result.report.fixture,summary:result.report.summary,report:result.reportPath}));
}
