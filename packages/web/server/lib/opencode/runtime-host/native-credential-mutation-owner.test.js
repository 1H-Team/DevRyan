import { describe, expect, it } from 'vitest';
import { createNativeCredentialMutationOwner, credentialMutationFingerprint } from './native-credential-mutation-owner.js';

const instance = '00000000-0000-4000-8000-000000000001';
const binding = { kind: 'mcp', valueType: 'oauth', directory: '/owned/project', controllerInstanceID: instance,
  integrationID: 'mcp_fixture', methodID: 'oauth_fixture', server: 'fixture', configurationDigest: 'a'.repeat(64),
  acquisitionID: 'owned_acquisition', operation: 'update', credentialID: 'credential_fixture',
  expectedFingerprint: 'b'.repeat(64), requestedFingerprint: 'c'.repeat(64) };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture() {
  let queue = Promise.resolve(), revoked = false, effects = 0;
  const owner = createNativeCredentialMutationOwner({ controllerInstanceID: instance,
    withMutationQueue: work => { const next = queue.then(work); queue = next.catch(() => {}); return next; },
    resolveAuthorization: async () => ({ reauthorize: () => { if (revoked) throw Object.assign(new Error('fixture_revoked'), { code: 'fixture_revoked' }); } }),
    verifyBinding: async actual => { expect(actual).toEqual(binding); }, commitOwned: async () => { effects++; } });
  return { owner, revoke: () => { revoked = true; }, effects: () => effects,
    input: callID => ({ callID, controllerInstanceID: instance, binding, bindingFingerprint: credentialMutationFingerprint(binding), authorizationID: 'owned_grant' }),
    hold: work => { const next = queue.then(work); queue = next.catch(() => {}); return next; } };
}

describe('private credential queue owner', () => {
  it('preserves the shared queue and rejects forged and replayed identities without effects', async () => {
    const f = fixture(), entered = deferred(), release = deferred();
    const prior = f.hold(async () => { entered.resolve(); await release.promise; }); await entered.promise;
    const mutation = f.owner.handleRpc('credential.mutation.commit', f.input('one'));
    await Promise.resolve(); expect(f.effects()).toBe(0);
    await expect(f.owner.handleRpc('credential.mutation.commit', { ...f.input('wrong'), bindingFingerprint: 'd'.repeat(64) })).rejects.toMatchObject({ code: 'native_credential_mutation_binding_invalid' });
    await expect(f.owner.handleRpc('credential.mutation.commit', { ...f.input('epoch'), controllerInstanceID: 'different' })).rejects.toMatchObject({ code: 'native_credential_mutation_request_invalid' });
    release.resolve(); await prior; expect(await mutation).toBeNull(); expect(f.effects()).toBe(1);
    await expect(f.owner.handleRpc('credential.mutation.commit', f.input('one'))).rejects.toMatchObject({ code: 'native_credential_mutation_replayed' });
  });
  it('reauthorizes the original caller after waiting in the queue', async () => {
    const f = fixture(), entered = deferred(), release = deferred();
    const prior = f.hold(async () => { entered.resolve(); await release.promise; }); await entered.promise;
    const mutation = f.owner.handleRpc('credential.mutation.commit', f.input('revoked'));
    const proof = expect(mutation).rejects.toMatchObject({ code: 'fixture_revoked' });
    f.revoke(); release.resolve(); await prior; await proof; expect(f.effects()).toBe(0);
  });
  it('aborted queued work cannot execute', async () => {
    const f = fixture(), entered = deferred(), release = deferred(), abort = new AbortController();
    const prior = f.hold(async () => { entered.resolve(); await release.promise; }); await entered.promise;
    const mutation = f.owner.handleRpc('credential.mutation.commit', f.input('aborted'), { signal: abort.signal });
    const proof = expect(mutation).rejects.toMatchObject({ code: 'native_credential_mutation_closed' });
    abort.abort(); release.resolve(); await prior; await proof; expect(f.effects()).toBe(0);
  });
  it('invalidation waits a started reverse action and fences queued successors', async () => {
    let queue = Promise.resolve(), effects = 0;
    const started = deferred(), settle = deferred();
    const owner = createNativeCredentialMutationOwner({ controllerInstanceID: instance,
      withMutationQueue: work => { const next = queue.then(work); queue = next.catch(() => {}); return next; },
      resolveAuthorization: async () => ({ reauthorize: () => {} }), verifyBinding: async () => {},
      commitOwned: async () => { effects++; started.resolve(); await settle.promise; } });
    const f = fixture();
    const first = owner.handleRpc('credential.mutation.commit', f.input('running')); await started.promise;
    const second = owner.handleRpc('credential.mutation.commit', f.input('queued'));
    const firstProof = expect(first).rejects.toMatchObject({ code: 'native_credential_mutation_closed' });
    const secondProof = expect(second).rejects.toMatchObject({ code: 'native_credential_mutation_closed' });
    let done = false; const closing = owner.invalidate().then(() => { done = true; });
    await Promise.resolve(); expect(done).toBe(false); expect(effects).toBe(1);
    settle.resolve(); await closing; await firstProof; await secondProof; expect(effects).toBe(1);
  });
  it('rejects key/OAuth ambiguity and missing fingerprints before queue entry', async () => {
    const f = fixture();
    for (const change of [{ valueType: 'key' }, { expectedFingerprint: undefined }, { directory: 'relative' }, { credential: 'never allowed' }]) {
      const candidate = { ...binding, ...change };
      await expect(f.owner.handleRpc('credential.mutation.commit', { ...f.input('invalid'), binding: candidate,
        bindingFingerprint: credentialMutationFingerprint(candidate) })).rejects.toMatchObject({ code: 'native_credential_mutation_binding_invalid' });
    }
    expect(f.effects()).toBe(0);
  });
});

it('revocation during asynchronous binding validation refuses before reverse mutation', async () => {
  const entered = deferred(), release = deferred(); let revoked = false, effects = 0;
  const owner = createNativeCredentialMutationOwner({ controllerInstanceID: instance,
    withMutationQueue: work => work(), resolveAuthorization: async () => ({ reauthorize: () => {
      if (revoked) throw Object.assign(new Error('fixture_revoked'), { code: 'fixture_revoked' });
    } }), verifyBinding: async () => { entered.resolve(); await release.promise; }, commitOwned: async () => { effects++; } });
  const f = fixture(), mutation = owner.handleRpc('credential.mutation.commit', f.input('validation_revoked'));
  const proof = expect(mutation).rejects.toMatchObject({ code: 'fixture_revoked' });
  await entered.promise; revoked = true; release.resolve(); await proof; expect(effects).toBe(0); await owner.close();
});

it('finite provider identities never alias accounts or authorize foreign OAuth methods', async () => {
  const { parseCredentialMutationBinding, parseCredentialResolutionBinding } = await import('./native-credential-mutation-owner.js');
  const key = {kind:'provider',valueType:'key',directory:'/owned/project',controllerInstanceID:instance,
    integrationID:'xai',operation:'create',requestedFingerprint:'a'.repeat(64)};
  for (const integrationID of ['xai','opencode','opencode-go']) expect(parseCredentialMutationBinding({...key,integrationID})).toEqual({...key,integrationID});
  expect(parseCredentialMutationBinding({...key,valueType:'oauth',methodID:'device'}).methodID).toBe('device');
  for (const change of [{integrationID:'foreign'}, {integrationID:'opencode',valueType:'oauth',methodID:'device'},
    {integrationID:'opencode-go',valueType:'oauth',methodID:'device'}, {valueType:'oauth',methodID:'browser'}, {valueType:'key',methodID:'device'}]) {
    expect(()=>parseCredentialMutationBinding({...key,...change})).toThrow('native_credential_mutation_binding_invalid');
  }
  const resolution={kind:'provider',valueType:'oauth',integrationID:'xai',methodID:'device',directory:'/owned/project',controllerInstanceID:instance,
    acquisitionID:'acquisition-one',configurationDigest:'a'.repeat(64),credentialID:'credential-one',expectedFingerprint:'b'.repeat(64),
    sessionID:'ses_one',permit:{token:'c'.repeat(64),sessionID:'ses_one',revision:0}};
  expect(parseCredentialResolutionBinding(resolution)).toEqual(resolution);
  for (const change of [{methodID:'browser'},{integrationID:'opencode-go'},{permit:{...resolution.permit,revision:-1}},
    {permit:{...resolution.permit,sessionID:'ses_other'}},{credential:'secret-not-permitted'},{directory:42},{directory:{}},{directory:null}]) {
    expect(()=>parseCredentialResolutionBinding({...resolution,...change})).toThrow('native_credential_resolution_binding_invalid');
  }
});

it('native provider resolution and mutation hold the SAME queue through reverse-action final settlement', async () => {
  let queue=Promise.resolve(),live=true,commits=0,mutations=0;
  const entered=deferred(),settle=deferred();
  const resolution={kind:'provider',valueType:'oauth',integrationID:'xai',methodID:'device',directory:'/owned/project',controllerInstanceID:instance,
    acquisitionID:'acquisition-one',configurationDigest:'a'.repeat(64),credentialID:'credential-one',expectedFingerprint:'b'.repeat(64),
    sessionID:'ses_one',permit:{token:'c'.repeat(64),sessionID:'ses_one',revision:0}};
  const check=()=>{if(!live)throw Object.assign(Error('fixture_epoch_replaced'),{code:'fixture_epoch_replaced'});};
  const owner=createNativeCredentialMutationOwner({controllerInstanceID:instance,
    withMutationQueue:action=>{const next=queue.then(action);queue=next.catch(()=>{});return next;},
    withResolution:async(actual,action)=>{expect(actual).toEqual(resolution);check();await action();check();},
    resolveAuthorization:async()=>({reauthorize:check}),verifyBinding:async()=>{},
    commitOwned:async input=>{commits++;if(input.callID==='resolution-one'){entered.resolve();await settle.promise;}else mutations++;}});
  const request={callID:'resolution-one',controllerInstanceID:instance,binding:resolution,
    bindingFingerprint:credentialMutationFingerprint(resolution),authorizationID:'resolution-one'};
  const operation=owner.handleRpc('credential.resolution.commit',request);
  await entered.promise;
  const f=fixture(),following=owner.handleRpc('credential.mutation.commit',f.input('following'));
  const failed=expect(operation).rejects.toMatchObject({code:'fixture_epoch_replaced'});
  const denied=expect(following).rejects.toMatchObject({code:'fixture_epoch_replaced'});
  await Promise.resolve();expect(commits).toBe(1);expect(mutations).toBe(0);
  live=false;settle.resolve();await failed;await denied;expect(commits).toBe(1);expect(mutations).toBe(0);
  await expect(owner.handleRpc('credential.resolution.commit',{...request,callID:'wrong-private-id',authorizationID:'caller-grant'}))
    .rejects.toMatchObject({code:'native_credential_resolution_authorization_required'});
  await owner.close();
});


it('completed resolution replay receipts are bounded without a controller lifetime operation cap', async () => {
  let effects=0;
  const resolution={kind:'provider',valueType:'oauth',integrationID:'xai',methodID:'device',directory:'/owned/project',controllerInstanceID:instance,
    acquisitionID:'acquisition-one',configurationDigest:'a'.repeat(64),credentialID:'credential-one',expectedFingerprint:'b'.repeat(64),
    sessionID:'ses_one',permit:{token:'c'.repeat(64),sessionID:'ses_one',revision:0}};
  const owner=createNativeCredentialMutationOwner({controllerInstanceID:instance,withMutationQueue:action=>action(),
    withResolution:(_binding,action)=>action(),resolveAuthorization:async()=>({reauthorize:()=>{}}),verifyBinding:async()=>{},
    commitOwned:async()=>{effects++;}});
  const input=callID=>({callID,controllerInstanceID:instance,binding:resolution,
    bindingFingerprint:credentialMutationFingerprint(resolution),authorizationID:callID});
  for(let i=0;i<4100;i++)await owner.handleRpc('credential.resolution.commit',input('resolution-'+i));
  expect(effects).toBe(4100);
  await expect(owner.handleRpc('credential.resolution.commit',input('resolution-4099'))).rejects.toMatchObject({code:'native_credential_mutation_replayed'});
  expect(effects).toBe(4100);await owner.close();
});

it('inflight resolution identities cannot be evicted and active capacity refusal preserves their settlement', async () => {
  const settle=deferred();let effects=0;
  const resolution={kind:'provider',valueType:'oauth',integrationID:'xai',methodID:'device',directory:'/owned/project',controllerInstanceID:instance,
    acquisitionID:'acquisition-one',configurationDigest:'a'.repeat(64),credentialID:'credential-one',expectedFingerprint:'b'.repeat(64),
    sessionID:'ses_one',permit:{token:'c'.repeat(64),sessionID:'ses_one',revision:0}};
  const owner=createNativeCredentialMutationOwner({controllerInstanceID:instance,withMutationQueue:async action=>{await settle.promise;return action();},
    withResolution:(_binding,action)=>action(),resolveAuthorization:async()=>({reauthorize:()=>{}}),verifyBinding:async()=>{},commitOwned:async()=>{effects++;}});
  const input=callID=>({callID,controllerInstanceID:instance,binding:resolution,
    bindingFingerprint:credentialMutationFingerprint(resolution),authorizationID:callID});
  const work=Array.from({length:4096},(_,i)=>owner.handleRpc('credential.resolution.commit',input('active-'+i)));
  await expect(owner.handleRpc('credential.resolution.commit',input('active-0'))).rejects.toMatchObject({code:'native_credential_mutation_replayed'});
  await expect(owner.handleRpc('credential.resolution.commit',input('overflow'))).rejects.toMatchObject({code:'native_credential_mutation_capacity'});
  expect(effects).toBe(0);settle.resolve();await Promise.all(work);expect(effects).toBe(4096);await owner.close();
});
