import { expect, test } from 'vitest';
import { createNativeIntegrationAuthorization } from './native-integration-authorization.js';
import { credentialMutationFingerprint } from './native-credential-mutation-owner.js';

const binding = { kind: 'mcp', directory: '/owned/project', controllerInstanceID: 'controller-one',
  server: 'remote', configurationDigest: 'a'.repeat(64), acquisitionID: 'acquisition-one', integrationID: 'mcp_remote', methodID: 'oauth' };
const mutation = { ...binding, valueType: 'oauth', operation: 'create', requestedFingerprint: 'b'.repeat(64) };
const spec = { ...binding, operation: 'mcp.oauth.start', method: 'POST', path: '/api/integration/mcp_remote/connect/oauth', body: { methodID: 'oauth' } };
const fixture = () => {
  let controller = binding.controllerInstanceID, principal = 'original', live = true, reviewed = true;
  const checked = [];
  const owner = createNativeIntegrationAuthorization({ controllerIdentity: () => controller,
    verifyBinding: async () => { if (!reviewed) throw new Error('configuration_changed'); },
    authorizeConfiguredConnection: async () => { if (!reviewed) throw new Error('configuration_changed'); },
    captureWebAuthorization: async () => { const original = principal; return async () => {
      checked.push(original); if (!live) throw new Error('original_caller_revoked');
    }; } });
  return { owner, checked, replace: () => { controller = 'controller-two'; }, revoke: () => { live = false; },
    changeCaller: () => { principal = 'someone-else'; }, changeConfiguration: () => { reviewed = false; } };
};

test('OAuth retains its exact original caller after HTTP return and rejects copied scopes or replacement', async () => {
  const f = fixture(); let authorizationID;
  await f.owner.withCallerOperation(spec, async () => {
    ({ authorizationID } = await f.owner.capture({ binding, operation: 'oauth', requestAuthorization: f.owner.requestHeaders()['x-devryan-native-integration-grant'] }));
  });
  expect(f.owner.requestHeaders()).toEqual({}); f.changeCaller();
  const grant = await f.owner.resolveMutation({ authorizationID, binding: mutation }); await grant.reauthorize();
  expect(new Set(f.checked)).toEqual(new Set(['original']));
  await expect(f.owner.resolveMutation({ authorizationID, binding: { ...mutation, directory: '/foreign' } })).rejects.toMatchObject({ code: 'native_integration_grant_mismatch' });
  await expect(f.owner.resolveMutation({ authorizationID, binding: { ...mutation, acquisitionID: 'replacement' } })).rejects.toMatchObject({ code: 'native_integration_grant_mismatch' });
  f.revoke(); await expect(grant.reauthorize()).rejects.toThrow('original_caller_revoked');
  f.replace(); await expect(f.owner.reauthorize({ authorizationID, binding })).rejects.toMatchObject({ code: 'native_integration_grant_expired' });
});

test('configured connection grants only refresh an exact selected credential; hashes cannot issue grants', async () => {
  const f = fixture();
  await expect(f.owner.capture({ binding, operation: 'oauth', requestAuthorization: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'native_integration_caller_required' });
  const { authorizationID } = await f.owner.capture({ binding, operation: 'connection' });
  await expect(f.owner.resolveMutation({ authorizationID, binding: mutation })).rejects.toMatchObject({ code: 'native_credential_mutation_denied' });
  const selected = { ...mutation, operation: 'update', credentialID: 'credential-one', expectedFingerprint: 'c'.repeat(64) };
  const grant = await f.owner.resolveMutation({ authorizationID, binding: selected }); await grant.reauthorize();
  await expect(f.owner.resolveMutation({ authorizationID, binding: { ...selected, expectedFingerprint: undefined } })).rejects.toMatchObject({ code: 'native_credential_mutation_denied' });
  f.changeConfiguration(); await expect(grant.reauthorize()).rejects.toThrow('configuration_changed');
  f.owner.close(); await expect(grant.reauthorize()).rejects.toMatchObject({ code: 'native_integration_grant_expired' });
});

test('browser scopes bind the actual method, path, body and current controller through awaited checks', async () => {
  const f = fixture(); let effects = 0;
  for (const changed of [{ ...spec, path: '/api/session' }, { ...spec, method: 'GET' }, { ...spec, body: { methodID: 'different' } }]) {
    await expect(f.owner.withCallerOperation(changed, async () => { effects++; })).rejects.toMatchObject({ code: 'native_integration_scope_invalid' });
  }
  expect(effects).toBe(0);
  await f.owner.withCallerOperation(spec, async () => {
    const requestAuthorization = f.owner.requestHeaders()['x-devryan-native-integration-grant'];
    await expect(f.owner.capture({ binding: { ...binding, methodID: 'different' }, operation: 'oauth', requestAuthorization }))
      .rejects.toMatchObject({ code: 'native_integration_scope_invalid' });
  });
  let release; const held = new Promise(resolve => { release = resolve; });
  let controller = binding.controllerInstanceID;
  const owner = createNativeIntegrationAuthorization({ controllerIdentity: () => controller,
    verifyBinding: async () => held, captureWebAuthorization: async () => async () => {}, authorizeConfiguredConnection: async () => {} });
  const captured = owner.capture({ binding, operation: 'connection' }); controller = 'replaced'; release();
  await expect(captured).rejects.toMatchObject({ code: 'native_integration_grant_expired' });
});

const openaiBinding={kind:'openai',directory:binding.directory,controllerInstanceID:binding.controllerInstanceID,
  configurationDigest:binding.configurationDigest,acquisitionID:'openai-acquisition',integrationID:'openai',methodID:'chatgpt-siwc'};
test.each(['create', 'activate', 'remove'])('SIWC %s retains and enforces its private guard while cloning request data', async operation => {
  let current = true, checks = 0, captured;
  const assertCurrent = async () => {
    checks++;
    if (!current) throw Object.assign(new Error('stale attempt'), { code: 'native_chatgpt_siwc_attempt_stale' });
  };
  const owner = createNativeIntegrationAuthorization({ controllerIdentity: () => openaiBinding.controllerInstanceID,
    verifyBinding: async () => {}, authorizeConfiguredConnection: async () => {},
    captureWebAuthorization: async selected => { captured = selected; return () => selected.assertCurrent(); } });
  const body = { integrationID: 'openai', value: { type: 'oauth', methodID: 'chatgpt-siwc',
    access: 'synthetic-access', refresh: 'synthetic-refresh', expires: 123456789, metadata: {} }, activate: false };
  const direct = { ...openaiBinding, operation, valueType: 'oauth',
    ...(operation === 'create' ? {} : { credentialID: 'credential-one', expectedFingerprint: 'c'.repeat(64) }),
    requestedFingerprint: credentialMutationFingerprint(operation === 'create' ? body : { id: 'credential-one' }) };
  const original = { ...direct, operation: `openai.credential.${operation}`, method: operation === 'remove' ? 'DELETE' : 'POST',
    path: operation === 'create' ? '/api/credential' : `/api/credential/credential-one${operation === 'activate' ? '/activate' : ''}`,
    ...(operation === 'create' ? { body } : {}), expectedActiveFingerprint: credentialMutationFingerprint(null), assertCurrent };
  let authorizationID;
  try {
    await owner.withCallerOperation(original, async () => {
      expect(captured).not.toBe(original);
      expect(captured.assertCurrent).toBe(assertCurrent);
      if (operation === 'create') {
        expect(captured.body).not.toBe(body);
        expect(captured.body.value).not.toBe(body.value);
      }
      original.assertCurrent = () => {};
      ({ authorizationID } = await owner.capture({ binding: direct, operation: 'mutation',
        requestAuthorization: owner.requestHeaders()['x-devryan-native-integration-grant'] }));
    });
    const grant = await owner.resolveMutation({ authorizationID, binding: direct });
    expect(checks).toBeGreaterThan(1);
    current = false;
    await expect(grant.reauthorize()).rejects.toMatchObject({ code: 'native_chatgpt_siwc_attempt_stale' });
  } finally { owner.close(); }
});

test.each([null, 'guard', {}, true])('browser scopes reject a nonfunction private guard before authorization: %j', async assertCurrent => {
  let authorized = false, effects = 0;
  const owner = createNativeIntegrationAuthorization({ controllerIdentity: () => openaiBinding.controllerInstanceID,
    verifyBinding: async () => {}, authorizeConfiguredConnection: async () => {},
    captureWebAuthorization: async () => { authorized = true; return async () => {}; } });
  try {
    await expect(owner.withCallerOperation({ ...spec, assertCurrent }, async () => { effects++; }))
      .rejects.toMatchObject({ code: 'native_integration_scope_invalid' });
    expect(authorized).toBe(false);
    expect(effects).toBe(0);
  } finally { owner.close(); }
});

test('OpenAI OAuth pins original caller, controller, configuration and actual acquisition',async()=>{
  const f=fixture();let authorizationID;
  await f.owner.withCallerOperation({...openaiBinding,operation:'openai.oauth.start',method:'POST',path:'/api/integration/openai/connect/oauth',body:{methodID:openaiBinding.methodID}},async()=>{
    ({authorizationID}=await f.owner.capture({binding:openaiBinding,operation:'oauth',requestAuthorization:f.owner.requestHeaders()['x-devryan-native-integration-grant']}));
  });
  f.changeCaller();
  const nativeMutation={kind:'openai',directory:openaiBinding.directory,controllerInstanceID:openaiBinding.controllerInstanceID,integrationID:'openai',methodID:openaiBinding.methodID,valueType:'oauth',operation:'create',requestedFingerprint:'b'.repeat(64)};
  const grant=await f.owner.resolveMutation({authorizationID,binding:nativeMutation});await grant.reauthorize();
  expect(new Set(f.checked)).toEqual(new Set(['original']));
  await expect(f.owner.reauthorize({authorizationID,binding:{...openaiBinding,acquisitionID:'copied'}})).rejects.toMatchObject({code:'native_integration_grant_mismatch'});
  await expect(f.owner.resolveMutation({authorizationID,binding:{...nativeMutation,valueType:'key',methodID:undefined}})).rejects.toMatchObject({code:'native_integration_grant_mismatch'});
  f.revoke();await expect(grant.reauthorize()).rejects.toThrow('original_caller_revoked');
});

test.each([['openai','openai'],['cursor','cursor-acp'],['provider','xai'],['provider','opencode'],['provider','opencode-go']])('direct %s key mutation grant binds exact payload and cannot authorize another effect',async(kind,integrationID)=>{
  const f=fixture(),request={integrationID,label:'Owned fixture',value:{type:'key',key:'synthetic-no-provider'}};
  const direct={...openaiBinding,kind,integrationID,methodID:undefined,valueType:'key',operation:'create',requestedFingerprint:credentialMutationFingerprint(request)};
  let authorizationID;
  await f.owner.withCallerOperation({...direct,operation:`${kind}.credential.create`,method:'POST',path:'/api/credential',body:request},async()=>{
    ({authorizationID}=await f.owner.capture({binding:direct,operation:'mutation',requestAuthorization:f.owner.requestHeaders()['x-devryan-native-integration-grant']}));
  });
  const grant=await f.owner.resolveMutation({authorizationID,binding:direct});await grant.reauthorize();
  await expect(f.owner.resolveMutation({authorizationID,binding:direct})).rejects.toMatchObject({code:'native_credential_mutation_denied'});
  await expect(f.owner.resolveMutation({authorizationID,binding:{...direct,requestedFingerprint:'d'.repeat(64)}})).rejects.toMatchObject({code:'native_credential_mutation_denied'});
  await expect(f.owner.resolveMutation({authorizationID,binding:{...direct,operation:'activate',credentialID:'different',expectedFingerprint:'c'.repeat(64)}})).rejects.toMatchObject({code:'native_credential_mutation_denied'});
  await expect(f.owner.withCallerOperation({...direct,operation:`${kind}.credential.create`,method:'POST',path:'/api/credential',body:{...request,label:'changed'}},async()=>{})).rejects.toMatchObject({code:'native_integration_scope_invalid'});
  if(kind==='cursor'){
    await expect(f.owner.capture({binding:direct,operation:'connection'})).rejects.toMatchObject({code:'native_integration_scope_invalid'});
    const body={integrationID,value:{type:'oauth',methodID:'chatgpt-siwc'}};
    await expect(f.owner.withCallerOperation({...direct,valueType:'oauth',methodID:'chatgpt-siwc',operation:'cursor.credential.create',method:'POST',path:'/api/credential',body,requestedFingerprint:credentialMutationFingerprint(body)},async()=>{})).rejects.toMatchObject({code:'native_integration_scope_invalid'});
    await expect(f.owner.withCallerOperation({...direct,operation:'openai.credential.create',method:'POST',path:'/api/credential',body:request},async()=>{})).rejects.toMatchObject({code:'native_integration_scope_invalid'});
  }
});

test('direct existing OpenAI mutations bind canonical ID/value and reject secret-changing PATCH',async()=>{
  const f=fixture(),body={label:'Owned update'};
  const direct={...openaiBinding,valueType:'oauth',operation:'update',credentialID:'owned-credential',expectedFingerprint:'c'.repeat(64),requestedFingerprint:credentialMutationFingerprint({id:'owned-credential',updates:body})};
  let authorizationID;
  await f.owner.withCallerOperation({...direct,operation:'openai.credential.update',method:'PATCH',path:'/api/credential/owned-credential',body},async()=>{
    ({authorizationID}=await f.owner.capture({binding:direct,operation:'mutation',requestAuthorization:f.owner.requestHeaders()['x-devryan-native-integration-grant']}));
  });
  await f.owner.resolveMutation({authorizationID,binding:direct});
  await expect(f.owner.resolveMutation({authorizationID,binding:{...direct,expectedFingerprint:'e'.repeat(64)}})).rejects.toMatchObject({code:'native_credential_mutation_denied'});
  await expect(f.owner.withCallerOperation({...direct,operation:'openai.credential.update',method:'PATCH',path:'/api/credential/owned-credential',body:{value:{type:'key',key:'synthetic'}}},async()=>{})).rejects.toMatchObject({code:'native_integration_scope_invalid'});
});

test('native XAI device acquisition pins its original caller while Go OAuth and sessionless provider refresh refuse', async()=>{
  const f=fixture(),owned={...openaiBinding,kind:'provider',integrationID:'xai',methodID:'device'};
  let authorizationID;
  await f.owner.withCallerOperation({...owned,operation:'provider.oauth.start',method:'POST',path:'/api/integration/xai/connect/oauth',body:{methodID:'device'}},async()=>{
    ({authorizationID}=await f.owner.capture({binding:owned,operation:'oauth',requestAuthorization:f.owner.requestHeaders()['x-devryan-native-integration-grant']}));
  });
  const mutation={kind:'provider',integrationID:'xai',methodID:'device',directory:owned.directory,controllerInstanceID:owned.controllerInstanceID,
    valueType:'oauth',operation:'create',requestedFingerprint:'b'.repeat(64)};
  f.changeCaller();const grant=await f.owner.resolveMutation({authorizationID,binding:mutation});await grant.reauthorize();
  expect(new Set(f.checked)).toEqual(new Set(['original']));
  await expect(f.owner.capture({binding:owned,operation:'connection'})).rejects.toMatchObject({code:'native_integration_scope_invalid'});
  for(const integrationID of ['opencode','opencode-go'])await expect(f.owner.withCallerOperation({...owned,integrationID,operation:'provider.oauth.start',method:'POST',
    path:`/api/integration/${integrationID}/connect/oauth`,body:{methodID:'device'}},async()=>{})).rejects.toMatchObject({code:'native_integration_scope_invalid'});
  await expect(f.owner.reauthorize({authorizationID,binding:{...owned,acquisitionID:'replacement'}})).rejects.toMatchObject({code:'native_integration_grant_mismatch'});
  f.revoke();await expect(grant.reauthorize()).rejects.toThrow('original_caller_revoked');
});
