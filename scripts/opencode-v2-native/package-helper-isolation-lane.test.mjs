import test from 'node:test';
import assert from 'node:assert/strict';
import {runCompiledHelperIsolation} from './package-helper-isolation-lane.mjs';

test('pre-provider helper rejection retains the actual typed cause and still clears the fixture responder',async()=>{
 const refusal=Object.assign(new Error('native_helper_selection_changed'),{code:'native_helper_selection_changed',status:403});
 let responderChanges=0,conversationCalls=0;
 const provider={setResponder:async()=>{responderChanges++;}};
 const runtimeOwner={generateHelperText:async()=>{throw refusal;}};
 const client={sessions:{create:async()=>{conversationCalls++;throw Error('unexpected conversation');}}};
 await assert.rejects(runCompiledHelperIsolation({runtimeOwner,client,provider,directory:'/owned/project'}),error=>error===refusal);
 assert.equal(conversationCalls,0);assert.equal(responderChanges,2);
});
