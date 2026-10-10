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

test('SIWC sign-out waits for shared mutation settlement and blocks native, Bot and image access', async () => {
  const root = await fs.mkdtemp(path.resolve(import.meta.dirname, '../../../../../../.cache/v2-validation/siwc-signout-owner-'));
  const instanceID = 'controller-fixture', credentialID = 'fixture-siwc';
  const selected = { directory: root, controllerInstanceID: instanceID, credentialID, integrationID: 'openai',
    value: { type: 'oauth', methodID: 'chatgpt-siwc', access: 'fixture-access', refresh: 'fixture-refresh', expires: Date.now() + 3600000,
      metadata: { clientId: 'issued-fixture', subject: 'fixture-subject', accountID: 'fixture-subject',
        scopes: ['chatgpt.tokens.use.direct'], planUsage: true, extAgentHostId: 'urn:uuid:00000000-0000-4000-8000-000000000001' } } };
  let queue = Promise.resolve(), releaseQueue, enteredQueue;
  const withMutationQueue = action => { const result = queue.then(action); queue = result.catch(() => {}); return result; };
  const pending = new Promise(resolve => { releaseQueue = resolve; });
  const entered = new Promise(resolve => { enteredQueue = resolve; });
  const prior = withMutationQueue(async () => { enteredQueue(); await pending; });
  await entered;
  const owner = createNativeIntegrationOwner({ instanceID, stateDirectory: root,
    snapshot: { locations: [{ directory: root, configuration: { providers: {} }, compatibility: { mcp: {} } }] },
    controller: () => ({ instanceID, call: async command => {
      if (command.action !== 'openai-read-selected-owned') throw new Error('unexpected fixture command');
      return selected;
    } }), isReady: () => true, withMutationQueue, captureWebAuthorization: async () => async () => {},
    admissionOwner: { withProviderAttempt: async (_input, action) => action(), withImageGeneration: async (_input, action) => action(async () => {}) } });
  owner.markReady();
  const scope = { kind: 'openai', directory: root, integrationID: 'openai', configurationDigest: fingerprint({}),
    operation: 'openai.integration', method: 'GET', path: '/api/integration/openai', expectedActiveFingerprint: fingerprint(selected) };
  let held = false;
  const holding = owner.holdOpenAiSelection(scope).then(release => { held = true; return release; });
  try {
    await Promise.resolve(); await Promise.resolve(); expect(held).toBe(false);
    releaseQueue(); await prior; const release = await holding;
    const input = { controllerInstanceID: instanceID, directory: root, credentialID, sessionID: 'fixture-session', kind: 'primary' };
    await expect(owner.handleRpc('openai.access', input)).rejects.toMatchObject({ code: 'native_chatgpt_siwc_signed_out' });
    await expect(owner.getOpenAiOAuthCoordinator().access({})).rejects.toMatchObject({ code: 'native_chatgpt_siwc_signed_out' });
    release(false);
    await expect(owner.handleRpc('openai.attempt', input)).rejects.toMatchObject({ code: 'native_chatgpt_siwc_signed_out' });
    release(true);
    expect(await owner.handleRpc('openai.attempt', input)).toBeNull();
    await expect(owner.withImageGeneration({ directory: root }, image => image.access()))
      .rejects.toMatchObject({ code: 'native_image_generation_siwc_unsupported' });
  } finally { releaseQueue(); await owner.invalidate(); await fs.rm(root, { recursive: true, force: true }); }
});

test('native image access retains selected key and admission proof through final settlement', async () => {
  const root = await fs.mkdtemp(path.resolve(import.meta.dirname, '../../../../../../.cache/v2-validation/image-key-owner-'));
  const instanceID = 'controller-fixture', invocation = { directory: root };
  let ready = true, revoked = false, checks = 0;
  let selected = { directory: root, controllerInstanceID: instanceID, credentialID: 'fixture-image-key', integrationID: 'openai',
    value: { type: 'key', key: 'fixture-selected-image-key' } };
  const owner = createNativeIntegrationOwner({ instanceID, stateDirectory: root,
    snapshot: { locations: [{ directory: root, configuration: { providers: {} }, compatibility: { mcp: {} } }] },
    controller: () => ({ instanceID, call: async input => {
      expect(input.action).toBe('openai-read-selected-owned'); return structuredClone(selected);
    } }), isReady: () => ready, withMutationQueue: () => { throw Error('image_key_must_not_refresh'); },
    captureWebAuthorization: async () => { throw Error('image_key_must_use_original_admission'); },
    admissionOwner: { withImageGeneration: async (input, action) => {
      expect(input).toBe(invocation); return action(async () => { checks++; if (revoked) throw Error('caller_revoked'); });
    } } });
  try {
    expect(await owner.withImageGeneration(invocation, async image => {
      const access = await image.access();
      expect(access).toMatchObject({ valueType: 'key', methodID: 'api-key', accessToken: 'fixture-selected-image-key' });
      await image.recheck(); return 'image-result';
    })).toBe('image-result');
    expect(checks).toBeGreaterThan(3);
    await expect(owner.withImageGeneration(invocation, async image => {
      await image.access(); selected = { ...selected, credentialID: 'fixture-replacement-key' }; return 'stale-result';
    })).rejects.toMatchObject({ code: 'native_image_generation_credential_changed' });
    await expect(owner.withImageGeneration(invocation, async image => {
      await image.access(); revoked = true; return 'revoked-result';
    })).rejects.toThrow('caller_revoked');
    revoked = false; ready = false;
    await expect(owner.withImageGeneration(invocation, image => image.access())).rejects.toMatchObject({ code: 'native_image_generation_unavailable' });
  } finally { await owner.invalidate(); await fs.rm(root, { recursive: true, force: true }); }
});

test('expired SIWC image access refuses before OAuth refresh, provider traffic or native mutation', async () => {
  const root = await fs.mkdtemp(path.resolve(import.meta.dirname, '../../../../../../.cache/v2-validation/image-siwc-refusal-'));
  const instanceID = 'controller-fixture', originalFetch = globalThis.fetch;
  let network = 0, mutations = 0, commands = 0;
  globalThis.fetch = async () => { network++; throw Error('image_siwc_must_not_contact_provider'); };
  const selected = { directory: root, controllerInstanceID: instanceID, credentialID: 'fixture-expired-siwc', integrationID: 'openai',
    value: { type: 'oauth', methodID: 'chatgpt-siwc', access: 'fixture-access', refresh: 'fixture-refresh', expires: 0,
      metadata: { clientId: 'issued-fixture', subject: 'fixture-subject', accountID: 'fixture-subject',
        scopes: ['chatgpt.tokens.use.direct'], planUsage: true, extAgentHostId: 'urn:uuid:00000000-0000-4000-8000-000000000001' } } };
  const owner = createNativeIntegrationOwner({ instanceID, stateDirectory: root,
    snapshot: { locations: [{ directory: root, configuration: { providers: {} }, compatibility: { mcp: {} } }] },
    controller: () => ({ instanceID, call: async input => { commands++; expect(input.action).toBe('openai-read-selected-owned'); return selected; } }),
    isReady: () => true, withMutationQueue: action => { mutations++; return action(); }, captureWebAuthorization: async () => async () => {},
    admissionOwner: { withImageGeneration: async (_input, action) => action(async () => {}) } });
  owner.markReady();
  try {
    await expect(owner.withImageGeneration({ directory: root }, image => image.access())).rejects.toMatchObject({ code: 'native_image_generation_siwc_unsupported' });
    expect(commands).toBe(1); expect(network).toBe(0); expect(mutations).toBe(0);
  } finally { globalThis.fetch = originalFetch; await owner.invalidate(); await fs.rm(root, { recursive: true, force: true }); }
});

test('provider selected reads are limited to xAI and OpenCode Go under the caller grant', async () => {
  const root = await fs.mkdtemp(path.resolve(import.meta.dirname, '../../../../../../.cache/v2-validation/provider-read-owner-'));
  const instanceID = 'controller-fixture'; let reply, calls = [];
  const owner = createNativeIntegrationOwner({ instanceID, stateDirectory: root,
    snapshot: { locations: [{ directory: root, configuration: { providers: {} }, compatibility: { mcp: {} } }] },
    controller: () => ({ instanceID, call: async input => { calls.push(input); return structuredClone(reply); } }),
    isReady: () => true, withMutationQueue: action => action(), captureWebAuthorization: async () => async () => {}, admissionOwner: {} });
  const scope = id => ({ kind: 'provider', directory: root, integrationID: id, configurationDigest: fingerprint({}),
    operation: 'provider.integration', method: 'GET', path: `/api/integration/${id}` });
  try {
    reply = { directory: root, controllerInstanceID: instanceID, integrationID: 'xai', credentialID: 'cred_x', value: { type: 'oauth', methodID: 'device', access: 'fixture-access' } };
    expect(await owner.readProviderSelected(scope('xai'))).toEqual(reply);
    expect(calls).toEqual([{ action: 'provider-read-selected-owned', directory: root, integrationID: 'xai', controllerInstanceID: instanceID }]);
    reply = null; expect(await owner.readProviderSelected(scope('opencode-go'))).toBeUndefined();
    reply = { directory: root, controllerInstanceID: instanceID, integrationID: 'opencode-go', credentialID: 'cred_x', value: { type: 'key', key: 'k' } };
    await expect(owner.readProviderSelected(scope('xai'))).rejects.toMatchObject({ code: 'native_integration_binding_invalid' });
    const count = calls.length;
    await expect(owner.readProviderSelected({ ...scope('xai'), operation: 'openai.integration' })).rejects.toBeTruthy();
    await expect(owner.readProviderSelected({ ...scope('opencode'), integrationID: 'opencode' })).rejects.toBeTruthy();
    expect(calls.length).toBe(count);
  } finally { await owner.invalidate(); await fs.rm(root, { recursive: true, force: true }); }
});
