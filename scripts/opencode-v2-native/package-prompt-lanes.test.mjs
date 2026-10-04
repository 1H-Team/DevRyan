import test from 'node:test';
import assert from 'node:assert/strict';
import {runCompiledPromptLanes} from './package-prompt-lanes.mjs';

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
