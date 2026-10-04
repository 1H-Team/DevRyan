import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { expandQaMatrix } from './matrix-config.mjs';
import { prepareQaMatrixLiveProfile, prepareQaMatrixRuntimeFixtureProfile, applyQaMatrixAppearance, verifyQaMatrixProfileInputs, gradeQaRendererErrors, navigateQaElectronWireFacade } from './matrix-runner.mjs';

test('Electron wire navigation awaits the existing local host registration before changing origin', async () => {
  const localOrigin = 'http://127.0.0.1:61001', facadeOrigin = 'http://127.0.0.1:61002';
  let release, registered, registration;
  const held = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { registered = resolve; });
  const calls = [];
  const cdp = { send: async (method, input) => {
    calls.push(method);
    if (method === 'Runtime.evaluate') {
      assert.equal(input.awaitPromise, true);
      assert.equal(input.returnByValue, true);
      const value = await runInNewContext(input.expression, { location: { origin: localOrigin }, window: { __TAURI__: { core: {
        invoke: async (command, payload) => { registration = JSON.parse(JSON.stringify({ command, payload })); registered(); await held; },
      } } } });
      return { result: { value } };
    }
    assert.equal(method, 'Page.navigate');
    assert.deepEqual(input, { url: facadeOrigin });
    return { frameId: 'main' };
  } };
  const navigating = navigateQaElectronWireFacade(cdp, { localOrigin, facadeOrigin });
  await entered;
  assert.deepEqual(calls, ['Runtime.evaluate']);
  assert.deepEqual(registration, { command: 'desktop_hosts_set', payload: { input: {
    hosts: [{ id: 'qa-wire', label: 'QA wire', url: facadeOrigin }], defaultHostId: 'local', initialHostChoiceCompleted: true,
  } } });
  release();
  assert.deepEqual(await navigating, { localOrigin, facadeOrigin, hostId: 'qa-wire' });
  assert.deepEqual(calls, ['Runtime.evaluate', 'Page.navigate']);
});

test('Electron wire navigation refuses foreign origins, unavailable local capability and registration or navigation failures', async () => {
  const input = { localOrigin: 'http://127.0.0.1:61001', facadeOrigin: 'http://127.0.0.1:61002' };
  for (const origin of ['https://example.com', 'http://localhost:61002', 'http://127.0.0.1:61002/path', 'http://user@127.0.0.1:61002', 'not a URL']) {
    for (const key of ['localOrigin', 'facadeOrigin']) {
      await assert.rejects(navigateQaElectronWireFacade({ send: () => assert.fail('Invalid origin used the preload') }, { ...input, [key]: origin }));
    }
  }
  await assert.rejects(navigateQaElectronWireFacade({ send: () => assert.fail('Same origin used the preload') }, { ...input, facadeOrigin: input.localOrigin }), /distinct_origin/);
  for (const fixture of [
    { location: { origin: input.facadeOrigin }, window: {} },
    { location: { origin: input.localOrigin }, window: {} },
    { location: { origin: input.localOrigin }, window: { __TAURI__: { core: { invoke: async () => { throw new Error('registration refused'); } } } } },
  ]) {
    await assert.rejects(navigateQaElectronWireFacade({ send: async (method, payload) => {
      assert.equal(method, 'Runtime.evaluate', 'Failed registration must not navigate');
      const value = await runInNewContext(payload.expression, fixture);
      return { result: { value } };
    } }, input), /local_page_required|local_preload_required|registration refused/);
  }
  await assert.rejects(navigateQaElectronWireFacade({ send: async (method, payload) => {
    if (method === 'Page.navigate') return { errorText: 'navigation refused' };
    const value = await runInNewContext(payload.expression, { location: { origin: input.localOrigin }, window: { __TAURI__: { core: { invoke: async () => null } } } });
    return { result: { value } };
  } }, input), /navigation refused/);
});

test('synthetic profile is constructor-owned and cannot supply live-account readiness or skip source verification', async () => {
  const cell = { transport: 'runtime-fixture', providerId: 'devryan-smoke', modelId: 'smoke-write', variant: 'high', planMode: false, scenarioId: 'core-journey' };
  const input = { runtimeRoot: '/owned/runtime', workspace: '/owned/workspace', targetGeneration: 2 }, digest = 'a'.repeat(64);
  let received, checked = 0;
  const profile = { evidence: { transport: 'runtime-fixture', generation: 2, credentialsCopied: false, personalSetup: false, inputDigest: digest },
    verifyInputs: async () => { checked++; return digest; }, verifyToolPublication: async () => {} };
  assert.equal(await prepareQaMatrixRuntimeFixtureProfile(cell, input, async value => { received = value; return profile; }), profile);
  assert.deepEqual(received, { ...input, cell }); assert.equal(checked, 1);
  await assert.rejects(prepareQaMatrixRuntimeFixtureProfile({ ...cell, transport: 'live' }, input, () => assert.fail('Synthetic constructor borrowed')));
  await assert.rejects(prepareQaMatrixRuntimeFixtureProfile(cell, input));
  for (const changed of [{ generation: 1 }, { credentialsCopied: true }, { personalSetup: true }, { transport: 'live' }]) {
    await assert.rejects(prepareQaMatrixRuntimeFixtureProfile(cell, input, async () => ({ ...profile, evidence: { ...profile.evidence, ...changed } })));
  }
  await assert.rejects(prepareQaMatrixRuntimeFixtureProfile(cell, input, async () => ({ ...profile, verifyInputs: undefined })), /verifier_required/);
});

test('synthetic preparation awaits cleanup after metadata or input failure and retains cleanup rejection', async () => {
  const cell = { transport: 'runtime-fixture', providerId: 'devryan-smoke', modelId: 'smoke-write', variant: 'high', planMode: false, scenarioId: 'core-journey' };
  const input = { targetGeneration: 2 }, digest = 'a'.repeat(64);
  const profile = { evidence: { transport: 'runtime-fixture', generation: 2, credentialsCopied: false, personalSetup: false, inputDigest: digest },
    verifyInputs: async () => digest, verifyToolPublication: async () => {} };
  for (const changed of [{ evidence: { ...profile.evidence, credentialsCopied: true } }, { verifyInputs: async () => 'b'.repeat(64) }]) {
    let release, entered, settled = false;
    const closing = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
    const action = prepareQaMatrixRuntimeFixtureProfile(cell, input, async () => ({ ...profile, ...changed,
      close: async () => { entered(); await closing; } }));
    const observed = action.then(() => { settled = true; return null; }, error => { settled = true; return error; });
    await started; assert.equal(settled, false); release();
    const error = await observed;
    assert.match(error.message, changed.evidence ? /profile_invalid/ : /input_changed/);
  }
  const cleanup = new Error('owned provider close failed');
  for (const changed of [{ evidence: { ...profile.evidence, personalSetup: true } }, { verifyInputs: async () => 'b'.repeat(64) }]) {
    await assert.rejects(prepareQaMatrixRuntimeFixtureProfile(cell, input, async () => ({ ...profile, ...changed,
      close: async () => { throw cleanup; } })), error => error instanceof AggregateError
        && error.errors.length === 2 && /profile_invalid|input_changed/.test(error.errors[0].message) && error.errors[1] === cleanup);
  }
});

test('expanded desktop cells forward exact theme and actual driver while unthemed mobile remains untouched',async()=>{
  const config={schemaVersion:1,evidenceRoot:'.cache/qa/appearance-plumbing',cells:['light','dark'].map(theme=>({
    id:`desktop-${theme}`,runtime:'electron',transport:'fixture',providerId:'fixture',modelId:'fixture-model',agent:'builder',
    planMode:false,variant:null,scenarioIds:['core-journey'],repetitions:1,timeoutMs:1000,theme,
  }))};
  const cdp={},ui={},received=[];
  for(const cell of expandQaMatrix(config))assert.deepEqual(await applyQaMatrixAppearance(cell,{cdp,ui},async input=>{
    received.push(input);return {observed:input.theme};
  }),{observed:cell.theme});
  assert.deepEqual(received.map(row=>row.theme),['light','dark']);assert.ok(received.every(row=>row.cdp===cdp&&row.ui===ui));
  assert.equal(await applyQaMatrixAppearance({scenarioId:'mobile'},{cdp,ui},()=>assert.fail('Mobile theme loop was replaced')),null);
});

test('live preparation rejects legacy generations before borrowing an old profile callback', () => {
  assert.throws(() => prepareQaMatrixLiveProfile({}, { targetGeneration: 1 }, () => assert.fail('Retired profile callback called')), /native_generation_required/);
});

test('native matrix finalization requires the full-cell original-input verifier and never silently passes a change', async () => {
  const digest = 'a'.repeat(64); let checked = 0;
  const profile = { evidence: { generation: 2, inputDigest: digest }, verifyInputs: async () => { checked++; return digest; } };
  assert.deepEqual(await verifyQaMatrixProfileInputs(profile), { state: 'verified', sha256: digest }); assert.equal(checked, 1);
  await assert.rejects(verifyQaMatrixProfileInputs({ evidence: profile.evidence }), { code: 'qa_native_input_verifier_required' });
  await assert.rejects(verifyQaMatrixProfileInputs({ ...profile, verifyInputs: async () => 'b'.repeat(64) }), { code: 'qa_native_input_changed' });
  const original = Object.assign(new Error('manifest changed during the live cell'), { code: 'qa_native_input_changed' });
  await assert.rejects(verifyQaMatrixProfileInputs({ ...profile, verifyInputs: async () => { throw original; } }), error => error === original);
  assert.equal(await verifyQaMatrixProfileInputs({ evidence: { generation: 1 } }), null);
});


test('renderer accounting allows at most one exact SSE console error inside each witnessed disconnect', () => {
  const text = '[event-pipeline] SSE stream error TypeError: network error';
  const fault = { kind: 'sse-disconnect', consoleStartOrdinal: 1, consoleEndOrdinal: 3,
    beforeConnections: 2, afterConnections: 3, recovery: 'canonical-snapshots',
    sessionID: 'session', messageID: 'user', assistantMessageID: 'assistant' };
  const error = { ordinal: 2, kind: 'console', text };
  assert.deepEqual(gradeQaRendererErrors([error], [fault]), []);
  const secondFault = { ...fault, consoleStartOrdinal: 4, consoleEndOrdinal: 6, beforeConnections: 3, afterConnections: 4 };
  assert.deepEqual(gradeQaRendererErrors([error, { ...error, ordinal: 5 }], [fault, secondFault]), []);
  for (const changed of [{ ordinal: 1 }, { ordinal: 4 }, { ordinal: undefined }, { kind: 'exception' },
    { text: text + ' extra' }, { text: 'another network error' }]) {
    const unexpected = { ...error, ...changed };
    assert.deepEqual(gradeQaRendererErrors([unexpected], [fault]), [unexpected.text]);
  }
  assert.deepEqual(gradeQaRendererErrors([error, { ...error, ordinal: 3 }], [fault]), [text]);
  assert.deepEqual(gradeQaRendererErrors([error], [fault, { ...fault }]), [text], 'Ambiguous overlapping receipts cannot authorize an error');
  for (const changed of [{ consoleStartOrdinal: -1 }, { consoleEndOrdinal: 0 }, { beforeConnections: 0 },
    { afterConnections: 2 }, { recovery: undefined }, { sessionID: '' }, { messageID: '' }, { assistantMessageID: '' }]) {
    assert.deepEqual(gradeQaRendererErrors([error], [{ ...fault, ...changed }]), [text]);
  }
  assert.deepEqual(gradeQaRendererErrors([error], [{ ...fault, beforeConnections: 3, afterConnections: 3 }]), [text],
    'A reconnect before the injected disconnect cannot satisfy its fresh connection-count witness');
  assert.deepEqual(gradeQaRendererErrors([error]), [text], 'A live or uninjected error remains unexpected');
});

test('existing prompt rejection ownership does not exempt exceptions or unrelated renderer errors', () => {
  const expected = [{ kind: 'prompt-rejection', message: 'Configured QA prompt rejection' }];
  const text = 'Message send failed: Failed to send message (400): Configured QA prompt rejection';
  assert.deepEqual(gradeQaRendererErrors([{ ordinal: 1, kind: 'console', text }], expected), []);
  assert.deepEqual(gradeQaRendererErrors([{ ordinal: 1, kind: 'exception', text }], expected), [text]);
  assert.deepEqual(gradeQaRendererErrors([{ ordinal: 1, kind: 'console', text: 'Other 400 failure' }], expected), ['Other 400 failure']);
});
