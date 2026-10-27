import {test} from 'vitest';
import assert from 'node:assert/strict';
import {captureNativeSetupCredentialSeed} from './native-setup-credential-ack.js';

test('lost, mismatched, and failed CAS acknowledgements retain the exact seed for retry',async()=>{
 const previous={identity:{fileId:'fixture'},bytes:Buffer.from(JSON.stringify({schema:1,credentials:[{integrationID:'openai'}]}))};
 let removed=0,failCAS=false;
 const owner={read:async()=>previous,delete:async(_file,{expected})=>{assert.equal(expected,previous);if(failCAS)throw Error('fixture_cas_changed');removed++;}};
 const captured=await captureNativeSetupCredentialSeed('/fixture/seed',owner);
 await assert.rejects(captured.settle(undefined),/ack_invalid/);
 await assert.rejects(captured.settle({status:'applied',...captured.expected,count:0}),/ack_invalid/);
 await assert.rejects(captured.settle({status:'applied',...captured.expected,sha256:'0'.repeat(64)}),/ack_invalid/);
 assert.equal(removed,0);failCAS=true;
 await assert.rejects(captured.settle({status:'applied',...captured.expected}),/cas_changed/);
 assert.equal(removed,0);failCAS=false;
 await captured.settle({status:'already-applied',...captured.expected});assert.equal(removed,1);
});
test('an absent captured seed refuses an unexpected import acknowledgement',async()=>{
 const owner={read:async()=>{throw Object.assign(Error('missing'),{code:'ENOENT'});},delete:async()=>{throw Error('unexpected deletion');}};
 const captured=await captureNativeSetupCredentialSeed('/fixture/seed',owner);
 assert.equal(captured.expected,null);
 await assert.rejects(captured.settle({status:'applied',count:1,sha256:'0'.repeat(64)}),/ack_invalid/);
 await captured.settle({status:'absent',count:0,sha256:null});
});
