import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {readCompiledConfiguredPrimaryAgent,readCompiledPromptAgent,runCompiledPromptLanes} from './package-prompt-lanes.mjs';
import {createNativeManagedFixture} from './managed-fixture.mjs';

test('initial tool root uses the source-configured primary verified by actual catalog shape',async()=>{
 const configuration={agents:{'fixture-primary':{mode:'primary',model:'fixture-provider/fixture-model'},fixer:{mode:'subagent',model:'fixture-provider/fixture-model'}}};
 const client={catalog:{agents:async options=>{assert.deepEqual(options,{directory:'/owned/project'});return[{name:'build',mode:'primary'},
  {name:'fixture-primary',mode:'primary',model:{providerID:'fixture-provider',modelID:'fixture-model'}}];}}};
 assert.equal(await readCompiledConfiguredPrimaryAgent({client,directory:'/owned/project',configuration}),'fixture-primary');
 for(const fault of ['absent','ambiguous','disabled','catalog-model']){
  const config=structuredClone(configuration);
  if(fault==='absent')delete config.agents['fixture-primary'];
  if(fault==='ambiguous')config.agents.other={mode:'primary',model:'fixture-provider/fixture-model'};
  if(fault==='disabled')config.agents['fixture-primary'].disable=true;
  if(fault==='catalog-model')config.agents['fixture-primary'].model='fixture-provider/foreign';
  await assert.rejects(readCompiledConfiguredPrimaryAgent({client,directory:'/owned/project',configuration:config}),/Compiled root requires/);
 }
});

test('ordinary tool fixture explicitly selects the current canonical agent without guessing its role',async()=>{
 const scope={sessionID:'ses_owned',directory:'/owned/project'};let agent='build';
 const client={sessions:{get:async(id,options)=>{assert.equal(id,scope.sessionID);assert.deepEqual(options,{directory:scope.directory});return{id, directory:scope.directory,agent};}}};
 assert.equal(await readCompiledPromptAgent({client,...scope}),'build');agent='orchestrator';
 assert.equal(await readCompiledPromptAgent({client,...scope}),'orchestrator');
});

test('missing, foreign, child or archived session selection refuses instead of fabricating primary authority',async()=>{
 for(const session of [null,{id:'ses_foreign',directory:'/owned/project',agent:'build'},
  {id:'ses_owned',directory:'/foreign',agent:'build'},
  {id:'ses_owned',directory:'/owned/project',agent:'build',parentID:'ses_parent'},
  {id:'ses_owned',directory:'/owned/project',agent:'build',time:{archived:1}},
  {id:'ses_owned',directory:'/owned/project'},
  {id:'ses_owned',directory:'/owned/project',agent:['build']}]){
  await assert.rejects(readCompiledPromptAgent({client:{sessions:{get:async()=>session}},sessionID:'ses_owned',directory:'/owned/project'}),/Compiled tool prompt requires/);
 }
});

test('missing primary admission authority refuses before creating a command session', async () => {
 await assert.rejects(runCompiledPromptLanes({client:{sessions:{create:()=>{throw Error('must not create');}}}}),
  /Compiled command requires its primary admission owner/);
});

test('reviewed command root enrolment finishes before model or command effects',async()=>{
 const calls=[];
 const client={sessions:{create:async(input,options)=>{
  assert.equal(input.agent,'orchestrator');
  assert.deepEqual(input.model,{providerID:'devryan-smoke',modelID:'smoke-write'});
  assert.deepEqual(options,{directory:'/owned/project'});
  calls.push('create');return {id:'ses_owned'};
 }},prompts:{command:async()=>{calls.push('command');}}};
 const provider={setResponder:async()=>{calls.push('provider');throw Error('model_boundary');}};
 await assert.rejects(runCompiledPromptLanes({provider,client,directory:'/owned/project',admitPrimary:async id=>{
  assert.equal(id,'ses_owned');calls.push('enrol');
 }}),/model_boundary/);
 assert.deepEqual(calls,['create','enrol','provider']);
 calls.length=0;
 await assert.rejects(runCompiledPromptLanes({provider,client,directory:'/owned/project',admitPrimary:async()=>{
  calls.push('enrol');throw Error('ownership_refused');
 }}),/ownership_refused/);
 assert.deepEqual(calls,['create','enrol']);
});

test('compiled root enrollment binds accepted prompts to each owned location',async t=>{
 const dataDirectory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'devryan-prompt-root-test-')));
 t.after(()=>fs.rm(dataDirectory,{recursive:true,force:true}));
 const alpha='/owned/alpha',beta='/owned/beta',calls=[];
 let session={id:'ses_beta',directory:beta};
 const client={generation:()=>2,sessions:{get:async(id,options)=>{calls.push(options.directory);return session;}}};
 const fixture=createNativeManagedFixture({client,directory:alpha,directories:[alpha,beta],dataDirectory,
  admissionOwner:{},executionHost:{runtime:{}},observations:[],diagnostics:[],environment:{}});
 try{
  await fixture.primaryRuntime.initialize();
  const admitted=[];
  fixture.primaryRuntime.admitNativePrompt=async receipt=>{admitted.push(receipt);};
  await fixture.admitPrimary('ses_beta',beta);
  const receipt={sessionID:'ses_beta',directory:beta};
  await fixture.admitNativePrompt(receipt);
  assert.deepEqual(admitted,[receipt]);assert.deepEqual(calls,[beta]);
  assert.equal(fixture.admitNativePrompt({...receipt,directory:alpha}),undefined);
  assert.equal(fixture.admitNativePrompt({sessionID:'ses_foreign',directory:beta}),undefined);
  await assert.rejects(fixture.admitPrimary('ses_beta','/foreign'),/directory must be owned/);
  for(const fault of [{...session,id:'ses_other'},{...session,directory:alpha},{...session,parentID:'ses_parent'},{...session,time:{archived:1}}]){
   session=fault;await assert.rejects(fixture.admitPrimary('ses_beta',beta),assert.AssertionError);
  }
 }finally{await fixture.close();}
});
