import { expect, test } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createNativeIntegrationOwner } from './native-integration-owner.js';
import { credentialMutationFingerprint as fingerprint } from './native-credential-mutation-owner.js';
import { NativeCommandRefusal } from './native-command-refusal.js';

test.each([
  ['native_integration_acquisition_expired', 'reply'],
  ['native_credential_mutation_failed', 'reply'],
  ['native_process_busy', 'not-dispatched'],
])('a proven finite credential refusal keeps its controller alive: %s', async (code, settlement) => {
  const root = await fs.mkdtemp(path.resolve(import.meta.dirname, '../../../../../../.cache/v2-validation/integration-refusal-'));
  let kills = 0; const instanceID = 'controller-fixture';
  const controller = { instanceID, call: async () => { throw new NativeCommandRefusal(code, 403, settlement); },
    killAndWaitForTermination: async () => { kills++; }, killAndWaitForExit: async () => { kills++; } };
  const owner = createNativeIntegrationOwner({ instanceID, stateDirectory: root,
    snapshot: { locations: [{ directory: root, configuration: {}, compatibility: { mcp: {} } }] },
    controller: () => controller, isReady: () => true, withMutationQueue: action => action(),
    captureWebAuthorization: async () => async () => {}, admissionOwner: {} });
  try {
    await expect(owner.credentialMetadata({ kind: 'openai', directory: root, integrationID: 'openai',
      configurationDigest: fingerprint({}), operation: 'openai.integration', method: 'GET', path: '/api/integration/openai' }))
      .rejects.toMatchObject({ code });
    expect(kills).toBe(0);
  } finally { await owner.invalidate(); await fs.rm(root, { recursive: true, force: true }); }
});

test('a timed-out reverse credential commit holds the shared queue through actual controller exit', async () => {
  const root = await fs.mkdtemp(path.resolve(import.meta.dirname, '../../../../../../.cache/v2-validation/integration-owner-'));
  let releaseExit, entered;
  const exited = new Promise(resolve => { releaseExit = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let queue = Promise.resolve(), nextMutation = false;
  const withMutationQueue = action => { const next = queue.then(action); queue = next.catch(() => {}); return next; };
  const instanceID = 'controller-fixture';
  const controller = { instanceID, call: async () => { entered(); throw Object.assign(new Error('timeout'), { code: 'native_process_command_timeout' }); },
    killAndWaitForExit: () => exited };
  const owner = createNativeIntegrationOwner({ instanceID, stateDirectory: root,
    snapshot: { locations: [{ directory: root, configuration: {}, compatibility: { mcp: {} } }] },
    controller: () => controller, isReady: () => true, withMutationQueue,
    captureWebAuthorization: async () => async () => {}, admissionOwner: {} });
  try {
    const request = { integrationID: 'openai', value: { type: 'key', key: 'synthetic-fixture' } };
    const binding = { kind: 'openai', controllerInstanceID: instanceID, directory: root, integrationID: 'openai',
      operation: 'create', valueType: 'key', requestedFingerprint: fingerprint(request) };
    const scoped = { ...binding, acquisitionID: 'acquisition-fixture', configurationDigest: fingerprint({}) };
    let authorizationID;
    await owner.withCallerOperation({ ...scoped, operation: 'openai.credential.create', method: 'POST', path: '/api/credential', body: request }, async () => {
      ({ authorizationID } = await owner.handleRpc('integration.capture', { binding: scoped, operation: 'mutation',
        requestAuthorization: owner.requestHeaders()['x-devryan-native-integration-grant'] }));
    });
    const commit = owner.handleRpc('credential.mutation.commit', { callID: 'call-fixture', controllerInstanceID: instanceID,
      binding, bindingFingerprint: fingerprint(binding), authorizationID });
    const rejected = expect(commit).rejects.toMatchObject({ code: 'native_process_command_timeout' });
    await started;
    const following = withMutationQueue(async () => { nextMutation = true; });
    const invalidating = owner.invalidate();
    await Promise.resolve(); await Promise.resolve();
    expect(nextMutation).toBe(false);
    releaseExit(); await rejected; await invalidating; await following;
    expect(nextMutation).toBe(true);
  } finally { releaseExit(); await owner.invalidate(); await fs.rm(root, { recursive: true, force: true }); }
});

test('manual credential dispatch retains its browser grant through native capture and refuses revoked callers', async () => {
  const root = await fs.mkdtemp(path.resolve(import.meta.dirname, '../../../../../../.cache/v2-validation/integration-operation-'));
  const instanceID = 'controller-fixture';
  let revoked = false, calls = 0, owner;
  const input = { integrationID: 'openai', value: { type: 'key', key: 'synthetic-fixture' } };
  const operation = { kind: 'openai', directory: root, integrationID: 'openai', configurationDigest: fingerprint({}),
    operation: 'openai.credential.create', method: 'POST', path: '/api/credential', body: input,
    valueType: 'key', requestedFingerprint: fingerprint(input) };
  const controller = { instanceID, killAndWaitForExit: async () => {}, call: async command => {
    calls++;
    expect(command).toMatchObject({ action: 'credential-operation-owned', directory: root, controllerInstanceID: instanceID, mutation: { operation: 'create', input } });
    expect(command.requestAuthorization).toMatch(/^[a-f0-9]{64}$/);
    return owner.handleRpc('integration.capture', { operation: 'mutation', requestAuthorization: command.requestAuthorization,
      binding: { ...operation, controllerInstanceID: instanceID, acquisitionID: 'acquisition-fixture', operation: 'create' } });
  } };
  owner = createNativeIntegrationOwner({ instanceID, stateDirectory: root,
    snapshot: { locations: [{ directory: root, configuration: {}, compatibility: { mcp: {} } }] },
    controller: () => controller, isReady: () => true, withMutationQueue: action => action(), admissionOwner: {},
    captureWebAuthorization: async () => async () => { if (revoked) throw Object.assign(new Error('revoked'), { code: 'caller_revoked' }); } });
  try {
    const result = await owner.credentialOperation(operation, { operation: 'create', input });
    expect(result.authorizationID).toMatch(/^[a-f0-9]{64}$/);
    expect(owner.requestHeaders()).toEqual({});
    revoked = true;
    await expect(owner.credentialOperation(operation, { operation: 'create', input })).rejects.toMatchObject({ code: 'caller_revoked' });
    expect(calls).toBe(1);
  } finally { await owner.invalidate(); await fs.rm(root, { recursive: true, force: true }); }
});


test('finite physical and resolution checks use the original admitted caller, exact controller and reviewed location', async () => {
  const root=await fs.mkdtemp(path.resolve(import.meta.dirname,'../../../../../../.cache/v2-validation/provider-attempt-owner-'));
  const instanceID='controller-fixture';let ready=true,revoked=false,attempts=0,resolutions=0;
  const permit={token:'a'.repeat(64),revision:0,sessionID:'ses_fixture'};
  const recheck=()=>{if(revoked)throw Object.assign(Error('caller_revoked'),{code:'caller_revoked'});};
  const owner=createNativeIntegrationOwner({instanceID,stateDirectory:root,
    snapshot:{locations:[{directory:root,configuration:{providers:{xai:{options:{}}}},compatibility:{mcp:{}}}]},
    controller:()=>({instanceID,call:async()=>{throw Error('no_reverse_command_expected');}}),isReady:()=>ready,
    withMutationQueue:action=>action(),captureWebAuthorization:async()=>{throw Error('no_settings_grant_expected');},
    admissionOwner:{withProviderAttempt:async(input,action)=>{expect(input).toEqual({controllerInstanceID:instanceID,directory:root,sessionID:'ses_fixture',permit,kind:'primary'});recheck();attempts++;const result=await action();recheck();return result;},
      withProviderResolution:async(input,action)=>{expect(input).toEqual({directory:root,sessionID:'ses_fixture',permit});recheck();resolutions++;return action(recheck);}}});
  const attempt={controllerInstanceID:instanceID,directory:root,sessionID:'ses_fixture',permit,kind:'primary',integrationID:'xai'};
  try{
    for(const integrationID of ['xai','opencode','opencode-go'])expect(await owner.handleRpc('provider.attempt',{...attempt,integrationID})).toBeNull();
    const resolution={kind:'provider',valueType:'key',integrationID:'xai',directory:root,controllerInstanceID:instanceID,
      acquisitionID:'acquisition-fixture',configurationDigest:fingerprint({options:{}}),credentialID:'credential-fixture',expectedFingerprint:'b'.repeat(64),sessionID:'ses_fixture',permit};
    expect(await owner.handleRpc('provider.credential.assert',resolution)).toBeNull();expect(resolutions).toBe(1);
    for(const changes of [{integrationID:'foreign'},{directory:root+'/foreign'},{controllerInstanceID:'old'},{metadata:{permission:'admin'}}]){
      await expect(owner.handleRpc('provider.attempt',{...attempt,...changes})).rejects.toMatchObject({code:'native_provider_attempt_invalid'});
    }
    expect(attempts).toBe(3);revoked=true;
    await expect(owner.handleRpc('provider.attempt',attempt)).rejects.toMatchObject({code:'caller_revoked'});
    await expect(owner.handleRpc('provider.credential.assert',resolution)).rejects.toMatchObject({code:'caller_revoked'});
    revoked=false;ready=false;await expect(owner.handleRpc('provider.attempt',attempt)).rejects.toMatchObject({code:'native_provider_attempt_invalid'});
    ready=true;await owner.invalidate();await expect(owner.handleRpc('provider.attempt',attempt)).rejects.toMatchObject({code:'native_integration_grant_expired'});
  }finally{await owner.invalidate();await fs.rm(root,{recursive:true,force:true});}
});
