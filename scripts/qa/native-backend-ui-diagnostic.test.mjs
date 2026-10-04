import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Schema } from 'effect';
import { Config } from '@opencode/schema/config';
import { openChangeStore, changeKey } from '../../packages/harness-runtime/lib/session-changes-store.js';
import { git } from '../../packages/harness-runtime/lib/session-changes-git.js';
import { runtimeUiConfiguration, runtimeUiNativeConfiguration, runtimeUiTuple, runtimeUiToolPrompt, createRuntimeUiResponder,
  createRuntimeUiProvider, assertRuntimeUiPublication, readRuntimeUiLease, prepareRuntimeUiProfile, runtimeUiAgentOverrides } from './native-backend-ui-diagnostic.mjs';

test('private UI pins survive the original packaged agent producer and exact native catalog requirements', async t => {
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const root = await fs.realpath(await fs.mkdtemp(path.join(repository, '.cache/qa-ui-agent-pins-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'project'), config = path.join(root, '.config/opencode');
  await fs.mkdir(directory); await fs.mkdir(path.join(config, '.openchamber'), { recursive: true });
  const overrides = runtimeUiAgentOverrides(), legacy = runtimeUiConfiguration('http://127.0.0.1:12345/v1');
  const pinned = Object.fromEntries(Object.entries(overrides).map(([name, value]) => [name, { model: value.model, variant: value.variant }]));
  await fs.writeFile(path.join(config, 'opencode.json'), JSON.stringify(legacy));
  await fs.writeFile(path.join(config, 'oh-my-opencode-slim.json'), JSON.stringify({ preset: 'qa', presets: { qa: pinned }, agents: pinned }));
  const sidecar = path.join(config, '.openchamber/config.json');
  const read = () => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    import {listPackagedAgents} from './packages/web/server/lib/opencode/packaged-agents.js';
    import {getAgentConfig} from './packages/web/server/lib/opencode/agents.js';
    import {translateNativeConfiguration} from './packages/web/server/lib/opencode/runtime-host/native-configuration-data.js';
    import {nativeCatalogModels} from './packages/web/server/lib/opencode/runtime-host/native-configuration-snapshot.js';
    import fs from 'node:fs';
    const directory=process.argv[1]+'/project',config=process.argv[1]+'/.config/opencode';
    const agents=Object.fromEntries(listPackagedAgents().map(row=>[row.name,getAgentConfig(row.name,directory,{userConfigPath:config+'/opencode.json',slimConfigDirectory:config}).config]));
    const legacy=JSON.parse(fs.readFileSync(config+'/opencode.json','utf8'));
    const native=translateNativeConfiguration({legacy,agents});
    console.log(JSON.stringify({names:Object.keys(agents),councillors:agents.council.councillors,models:nativeCatalogModels(native,{agents})}));
  `, root], { cwd: repository, env: { PATH: process.env.PATH, HOME: root }, encoding: 'utf8' }));
  // Preserve the failing primary-only seed as a meaningful contrast: actual
  // packaged Council defaults require account models absent from this fixture.
  await fs.writeFile(sidecar, JSON.stringify({ agentOverrides: { builder: overrides.builder, orchestrator: overrides.orchestrator } }));
  assert.ok(read().models.some(row => row.providerID !== runtimeUiTuple.providerID));
  await fs.writeFile(sidecar, JSON.stringify({ agentOverrides: overrides }));
  const actual = read();
  assert.deepEqual(actual.names.sort(), Object.keys(overrides).filter(name => name !== 'build').sort());
  assert.deepEqual(actual.councillors, overrides.council.councillors);
  assert.ok(actual.models.length > 0);
  assert.ok(actual.models.every(row => row.providerID === runtimeUiTuple.providerID && row.id === runtimeUiTuple.modelID
    && ['high', 'default'].includes(row.variant)));
});

test('synthetic backend declaration retains one finite loopback tuple and no account route', () => {
  const legacy = runtimeUiConfiguration('http://127.0.0.1:12345/v1');
  const native = runtimeUiNativeConfiguration(legacy);
  const decoded = Schema.decodeUnknownSync(Config.Info)(native, { onExcessProperty: 'error' });
  assert.equal(decoded.providers['devryan-smoke'].models['smoke-write'].variants[0].id, 'high');
  assert.deepEqual(legacy.enabled_providers, ['devryan-smoke']);
  assert.equal(legacy.provider['devryan-smoke'].options.apiKey, '');
  assert.equal(native.providers['devryan-smoke'].package, '@opencode/ai/providers/openai-compatible');
  assert.deepEqual(native.providers['devryan-smoke'].models['smoke-write'].variants, [{ id: 'high', settings: { temperature: 0 } }]);
  assert.equal(native.agents.builder.model.providerID, runtimeUiTuple.providerID);
  assert.equal(native.agents.builder.model.model, runtimeUiTuple.modelID);
  assert.equal(native.agents.builder.model.variant, 'high');
  for (const origin of ['https://external.invalid/v1', 'http://localhost:12345/v1', 'http://127.0.0.1:12345/v1?key=fake', 'http://user@127.0.0.1:12345/v1']) assert.throws(() => runtimeUiConfiguration(origin));
});

test('real model packets require completed read before write and preserve actual generation schemas', () => {
  for (const generation of [2]) {
    const respond = createRuntimeUiResponder({ generation, directory: '/owned/project' });
    const body = { model: 'smoke-write', messages: [{ role: 'user', content: runtimeUiToolPrompt }], tools: ['read', 'write'].map(name => ({ function: { name } })) };
    const read = respond({ body }); assert.equal(read.reason, 'tool-calls'); assert.equal(read.items[0].name, 'read');
    assert.deepEqual(read.items[0].input, { path: 'src/tasks.mjs' });
    body.messages.push({ role: 'tool', tool_call_id: 'runtime_ui_read', content: 'actual read result' });
    const write = respond({ body }); assert.equal(write.items[0].name, 'write');
    assert.equal(write.items[0].input.content, 'DevRyan actual backend publication\n');
    body.messages.push({ role: 'tool', tool_call_id: 'runtime_ui_write', content: 'actual write result' });
    assert.equal(respond({ body }).reason, 'stop');
    assert.throws(() => respond({ body: { ...body, messages: [{ role: 'user', content: 'unrelated inference' }] } }), /unrelated_prompt/);
    assert.throws(() => respond({ body: { ...body, model: 'other-model' } }));
  }
});

test('owned packet transport exposes a live streamed body and settles an actual disconnect', async () => {
  const provider = await createRuntimeUiProvider({ generation: 2, directory: '/owned/project', packetDelayMs: 10 });
  try {
    const abort = new AbortController();
    const response = await fetch(provider.baseURL + '/chat/completions', { method: 'POST', signal: abort.signal,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'smoke-write', stream: true,
        messages: [{ role: 'user', content: 'Write 250 numbered one-line test cases' }] }) });
    assert.equal(response.status, 200); const reader = response.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /data:/);
    abort.abort(); await reader.cancel().catch(() => {});
    assert.equal(provider.observations.length, 1); assert.match(provider.observations[0].requestSha256, /^[a-f0-9]{64}$/);
    assert.equal(Object.hasOwn(provider.observations[0], 'body'), false);
  } finally { await provider.close(); }
});

test('publication oracle refuses prose, stale scope, failed tool and unconfirmed termination', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.resolve('.cache/qa-ui-publication-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'runtime-ui-proof.txt'), 'DevRyan actual backend publication\n');
  const sessionID = 'ses_owned', rows = ['read', 'write'].map((tool, index) => ({ info: { id: `msg_${index}`, sessionID },
    parts: [{ type: 'tool', tool, callID: `runtime_ui_${tool}`, state: { status: 'completed' } }] }));
  const lease = { directory, state: 'published', executionKind: 'process', scope: { sessionID, callID: 'runtime_ui_write', messageID: 'msg_1' }, result: { operationID: 'owned-operation' } };
  const input = { directory, sessionID, rows, leaseForCall: async request => { assert.deepEqual(request, { directory, sessionID, callID: 'runtime_ui_write' }); return lease; },
    readReceipt: async () => ({ terminated: true, confined: true, cancelled: false, exitCode: 0 }) };
  assert.equal((await assertRuntimeUiPublication(input)).state, 'published');
  for (const changed of [{ rows: [] }, { rows: [...rows, rows[0]] },
    { rows: [rows[0], { ...rows[1], parts: [...rows[1].parts, rows[1].parts[0]] }] },
    { rows: [rows[0], { ...rows[1], parts: [{ ...rows[1].parts[0], state: { status: 'error' } }] }] },
    { leaseForCall: async () => ({ ...lease, state: 'ready' }) },
    { leaseForCall: async () => ({ ...lease, directory: undefined }) },
    { leaseForCall: async () => ({ ...lease, directory: path.join(directory, 'foreign') }) },
    { leaseForCall: async () => ({ ...lease, scope: { ...lease.scope, sessionID: 'ses_foreign' } }) },
    { readReceipt: async () => ({ terminated: false, confined: true }) },
    { readReceipt: async () => ({ terminated: true, confined: false }) },
    ...[{ cancelled: true, exitCode: 0 }, { exitCode: 0 }, { cancelled: false, exitCode: 1 }, { cancelled: false }]
      .map(receipt => ({ readReceipt: async () => ({ terminated: true, confined: true, ...receipt }) }))]) await assert.rejects(assertRuntimeUiPublication({ ...input, ...changed }));
  await fs.writeFile(path.join(directory, 'runtime-ui-proof.txt'), 'model prose'); await assert.rejects(assertRuntimeUiPublication(input));
});

test('publication reader uses only the committed workspace tree and refuses incomplete evidence without writes', async t => {
  const fixture = await fs.realpath(await fs.mkdtemp(path.resolve('.cache/qa-ui-ledger-')));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const gitConfig = path.join(fixture, 'gitconfig'); await fs.writeFile(gitConfig, '');
  const previous = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
  process.env.GIT_CONFIG_GLOBAL = gitConfig; process.env.GIT_CONFIG_NOSYSTEM = '1';
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const directory = path.join(fixture, 'workspace'), storage = path.join(fixture, 'ledger'); await fs.mkdir(directory);
  const input = { storage, directory, sessionID: 'ses_owned', callID: 'runtime_ui_write' };
  await assert.rejects(readRuntimeUiLease(input), /ledger_missing/); assert.equal(await fs.stat(storage).catch(() => null), null);
  const root = path.join(storage, changeKey(directory)), gitDir = path.join(root, 'git'); await fs.mkdir(root, { recursive: true });
  await git(root, ['init', '--bare', '--quiet', gitDir]);
  const files = async (dir, prefix = '') => {
    const entries = [];
    for (const name of (await fs.readdir(dir)).sort()) {
      const file = path.join(dir, name), relative = prefix + name;
      if ((await fs.lstat(file)).isDirectory()) entries.push(...await files(file, relative + '/'));
      else entries.push([relative, (await fs.readFile(file)).toString('hex')]);
    }
    return entries;
  };
  const unchanged = async action => { const before = await files(root); await action(); assert.deepEqual(await files(root), before); };
  await unchanged(() => assert.rejects(readRuntimeUiLease(input), /ledger_invalid/));
  const token = '00000000-0000-4000-8000-000000000001';
  const callKey = `calls/${changeKey(input.sessionID + '\0' + input.callID)}.json`, leaseKey = `leases/${changeKey(token)}.json`;
  const meta = { version: 1, directory }, lease = { token, directory, state: 'published' };
  const seed = await openChangeStore(root, gitDir); seed.set('meta.json', meta); seed.set(callKey, { token }); seed.set(leaseKey, lease); await seed.commit();
  await unchanged(async () => assert.deepEqual(await readRuntimeUiLease(input), lease));
  for (const [key, value, code] of [
    ['meta.json', { ...meta, directory: path.join(fixture, 'foreign') }, 'ledger_invalid'],
    ['meta.json', { ...meta, version: 2 }, 'ledger_invalid'],
    ['materialization.json', { operation: 'pending' }, 'materialization_pending'],
    [callKey, null, 'call_missing'], [callKey, { token: 'invalid' }, 'call_missing'],
    [leaseKey, null, 'lease_missing'], [leaseKey, { ...lease, token: 'foreign' }, 'lease_missing'],
  ]) {
    const db = await openChangeStore(root, gitDir), original = await db.get(key);
    if (value === null) db.remove(key); else db.set(key, value); await db.commit();
    await unchanged(() => assert.rejects(readRuntimeUiLease(input), new RegExp(code)));
    if (original === null) db.remove(key); else db.set(key, original); await db.commit();
  }
  await unchanged(() => assert.rejects(readRuntimeUiLease({ ...input, callID: 'foreign' }), /call_missing/));
});

test('profile refuses unknown generation and escaped source before any provider or migration starts', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.resolve('.cache/qa-ui-path-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outside = path.join(root, 'outside'), artifactRoot = path.join(root, 'artifacts'); await fs.mkdir(outside); await fs.mkdir(artifactRoot);
  await fs.symlink(outside, path.join(root, 'link'));
  const input = { cell: { transport: 'runtime-fixture' }, runtimeRoot: path.join(root, 'runtime'), workspace: root, artifactRoot };
  await assert.rejects(prepareRuntimeUiProfile({ ...input, targetGeneration: 3 }));
  await assert.rejects(prepareRuntimeUiProfile({ ...input, targetGeneration: 2, runtimeRoot: path.join(root, 'link/runtime') }), /path_invalid/);
  assert.deepEqual(await fs.readdir(outside), []);
});
