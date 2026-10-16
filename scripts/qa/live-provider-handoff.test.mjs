import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { userInfo } from 'node:os';
import { createHash } from 'node:crypto';
import { qa1ExerciseRequestTimeout, qa1ExerciseHttpFailure, parseHandoffCommand, projectHandoffChildRefusal, assertHandoffUpgradeSettlement, assertHandoffJournalScope, handoffSetup, prepareProviderHandoff, projectHandoffProviderStatus, projectHandoffClaudeStatus, pinProviderHandoff,
  registerProviderHandoffProfile, readRegisteredProviderHandoff, assertHandoffUpgradeLineage, createHandoffChildLifetime, cleanupHandoffChildResources } from './live-provider-handoff.mjs';
import { waitLiveOwnerAttendance, createLiveOwnerLink } from './live-credential-owner.mjs';
import { nativeUpgradeBundleID } from '../../packages/web/server/lib/opencode/runtime-host/runtime-bundle-lifecycle.js';
import { canonicalJSON } from '../../packages/web/server/lib/opencode/runtime-host/bundle-migration-inventory.js';
import { readRunMeta } from '../storage-policy.mjs';

test('shared child cleanup preserves startup as cause while independently attempting failed link and handle cleanup', async () => {
  const primary = Object.assign(Error('original startup failure'), { code: 'qa_handoff_checkpoint_invalid' });
  const linkFailure = Error('link cleanup failed'), handleFailure = Error('handle cleanup failed'), calls = [];
  await assert.rejects(cleanupHandoffChildResources({ primaryError: primary,
    link: { close: async () => { calls.push('link'); throw linkFailure; } },
    handle: { stop: async options => { assert.deepEqual(options, { exitProcess: false }); calls.push('handle'); throw handleFailure; } },
  }), error => {
    assert.ok(error instanceof AggregateError); assert.equal(error.cause, primary);
    assert.equal(error.code, primary.code); assert.deepEqual(error.errors, [primary, linkFailure, handleFailure]);
    assert.deepEqual(projectHandoffChildRefusal({ status: 'refused', code: error.code }), { status: 'refused', code: primary.code });
    return true;
  });
  assert.deepEqual(calls, ['link', 'handle']);
});

test('shared child cleanup never hides a cleanup-only failure or invents an error after successful cleanup', async () => {
  const failure = Error('failed cleanup'); let stopped = 0;
  await assert.rejects(cleanupHandoffChildResources({ link: { close: () => { throw failure; } },
    handle: { stop: async () => { stopped++; } } }), error => {
    assert.equal(error.code, 'qa_handoff_cleanup_failed'); assert.equal(error.cause, failure);
    assert.deepEqual(error.errors, [failure]); return true;
  });
  assert.equal(stopped, 1);
  await cleanupHandoffChildResources({ primaryError: failure });
});

for (const event of ['disconnect', 'SIGINT', 'SIGTERM']) for (const phase of ['attendance', 'server', 'link', 'ready']) {
  test(`child lifetime retains ${event} during ${phase} and cleans adopted late resources`, async () => {
    const channel = Object.assign(new EventEmitter(), { connected: true });
    const controller = new AbortController(), lifetime = createHandoffChildLifetime(channel, controller);
    let release, entered, handle, link, serverStops = 0, linkCloses = 0, admissions = 0, refused;
    const barrier = new Promise(resolve => { release = resolve; });
    const atBarrier = new Promise(resolve => { entered = resolve; });
    const startup = (async () => {
      try {
        lifetime.assertCurrent();
        const attendance = waitLiveOwnerAttendance(channel, { parentPid: 42, timeoutMs: 1000 });
        if (phase === 'attendance') entered();
        await attendance;
        lifetime.assertCurrent();
        if (phase === 'server') { entered(); await barrier; }
        handle = { stop: async () => { serverStops++; } };
        lifetime.assertCurrent();
        if (phase === 'link') { entered(); await barrier; }
        link = { close: async () => { linkCloses++; } };
        lifetime.assertCurrent();
        admissions++;
        if (phase === 'ready') entered();
        await lifetime.stopped;
      } catch (error) { refused = error.code; }
      finally {
        await link?.close(); await handle?.stop(); lifetime.dispose();
      }
    })();
    assert.equal(admissions, 0, 'A stop latch cannot supply human attendance');
    if (phase !== 'attendance') channel.emit('message', { status: 'owner-attended', launcherPid: 42 });
    await atBarrier;
    if (event === 'disconnect') channel.connected = false;
    channel.emit(event);
    assert.equal(controller.signal.aborted, true);
    if (phase === 'attendance') channel.emit('message', { status: 'owner-attended', launcherPid: 42 });
    if (phase !== 'ready') assert.equal(serverStops, 0, 'Startup must settle before adopting and closing its handle');
    release(); await startup;
    assert.equal(serverStops, phase === 'attendance' ? 0 : 1);
    assert.equal(linkCloses, ['attendance', 'server'].includes(phase) ? 0 : 1);
    assert.equal(admissions, phase === 'ready' ? 1 : 0);
    assert.equal(refused, phase === 'ready' ? undefined : phase === 'attendance' && event === 'disconnect'
      ? 'qa_live_owner_attendance_required' : 'qa_handoff_closed');
    for (const name of ['message', 'disconnect', 'SIGINT', 'SIGTERM']) assert.equal(channel.listenerCount(name), 0);
  });
}

test('child lifetime rejects an already disconnected parent and cannot replace exact attendance', async () => {
  for (const connected of [false, true]) {
    const channel = Object.assign(new EventEmitter(), { connected });
    const lifetime = createHandoffChildLifetime(channel, new AbortController());
    try {
      if (!connected) { assert.throws(lifetime.assertCurrent, /qa_handoff_closed/); await lifetime.stopped; }
      else {
        const attended = waitLiveOwnerAttendance(channel, { parentPid: 42, timeoutMs: 1000 });
        channel.emit('message', { status: 'owner-attended', launcherPid: 99 });
        await assert.rejects(attended, /qa_live_owner_attendance_required/);
      }
    } finally { lifetime.dispose(); }
    for (const name of ['message', 'disconnect', 'SIGINT', 'SIGTERM']) assert.equal(channel.listenerCount(name), 0);
  }
});

test('child stop during owner-cookie setup cannot admit its pending human challenge', async () => {
  const channel = Object.assign(new EventEmitter(), { connected: true });
  const controller = new AbortController(), lifetime = createHandoffChildLifetime(channel, controller);
  let release, entered, admitted = 0;
  const barrier = new Promise(resolve => { release = resolve; }), issuing = new Promise(resolve => { entered = resolve; });
  const link = await createLiveOwnerLink({ hostOrigin: 'http://127.0.0.1:43210',
    isHeld: () => controller.signal.aborted, onAdmission: () => { lifetime.assertCurrent(); admitted++; },
    handle: { issueLocalOwnerSession: async () => {
      lifetime.assertCurrent(); entered(); await barrier; lifetime.assertCurrent();
      return { name: 'devryan_local_owner', value: 'x'.repeat(43), maxAge: 3600 };
    } } });
  try {
    const response = fetch(link.issue().link, { redirect: 'manual' });
    await issuing; channel.connected = false; channel.emit('disconnect'); release();
    const result = await response; await result.body?.cancel();
    assert.equal(result.status, 403); assert.equal(admitted, 0);
    assert.throws(() => link.issue(), /qa_live_source_held/);
  } finally { release(); await link.close(); lifetime.dispose(); }
});

async function writeHandoffDocument(root) {
  const runtimeRoot = path.join(root, 'runtime');
  await fs.writeFile(path.join(root, 'handoff.json'), JSON.stringify({ schema: 1, root, runtimeRoot,
    workspace: path.join(root, 'workspace'), controlRoot: path.join(runtimeRoot, 'native-bundles'), bundleID: 'independent-signin',
    artifactRoot: path.join(root, 'artifact'), buildID: 'fixture', artifactManifestSha256: 'a'.repeat(64),
    purpose: 'provider-signin-only-no-inference-no-account-copy' }), { mode: 0o600 });
}

test('attended handoff accepts only owned commands without caller-supplied account/principal values', () => {
  for (const command of ['status', 'owner-link', 'restart', 'close', 'exercise', 'qualify-providers']) assert.equal(parseHandoffCommand(JSON.stringify({ command })), command);
  for (const input of [{ command: 'run' }, { command: 'hold-and-verify' }, { command: 'status', principal: 'local-admin' },
    { command: 'owner-link', cookie: 'untrusted' }, { command: 'restart', credentials: {} }, [], null]) {
    assert.throws(() => parseHandoffCommand(JSON.stringify(input)), /qa_handoff_command_invalid/);
  }
  assert.throws(() => parseHandoffCommand('x'.repeat(1025)), /qa_handoff_command_invalid/);
});

test('nonsecret fresh handoff setup uses requested provider combination and independent Default Zen helper', () => {
  const setup = handoffSetup('/owned/workspace');
  assert.equal(setup.agents.orchestrator.model, 'openai/gpt-6-astra');
  assert.equal(setup.agents.orchestrator.variant, 'medium');
  assert.equal(setup.agents.explorer.model, 'cursor-acp/grok-4.6');
  assert.equal(setup.agents.explorer.variant, 'medium');
  assert.equal(Object.hasOwn(setup.agents, 'fixer'), false, 'Sign-in setup must not invent original specialist assignments');
  assert.deepEqual(setup.settings.helperModelSelection, { providerID: 'opencode', modelID: 'deepseek-v4.1-flash', revision: 'default' });
  assert.equal(Object.hasOwn(setup.settings.helperModelSelection, 'variant'), false);
  assert.deepEqual(setup.legacy.mcp, {});
  assert.equal(/apiKey|credential|accessToken|password/.test(JSON.stringify(setup)), false);
});

test('profile preparation rejects any outside-repository source before native/artifact access', async () => {
  await assert.rejects(prepareProviderHandoff({ artifactRoot: '/outside/artifact', root: '/outside/profile' }), /qa_live_private_path_required/);
});

test('status exposes only fixed provider flags/model counts and incomplete state, never catalog metadata', () => {
  const value = { connected: ['openai', 'cursor-acp', 'anthropic', 'private-provider'], cookie: 'private', all: [
    { id: 'anthropic', models: { first: { credential: 'private' }, second: { account: 'private' } }, credential: 'private' },
    { id: 'openai', models: { only: { name: 'private' } } }, { id: 'private-provider', models: { secret: {} } },
  ] };
  const expected = { catalogConnected: { openai: true, 'cursor-acp': true, opencode: false, anthropic: true },
    modelCounts: { openai: 1, 'cursor-acp': 0, opencode: 0, anthropic: 2 }, catalogIncomplete: false };
  assert.deepEqual(projectHandoffProviderStatus(value), expected);
  assert.deepEqual(projectHandoffProviderStatus({ ...value, catalogIncomplete: true }), { ...expected, catalogIncomplete: true });
  for (const input of [null, {}, { ...value, connected: 'openai' }, { ...value, connected: [7] }, { ...value, all: {} },
    { ...value, all: [null] }, { ...value, all: [{ id: 'anthropic', models: [] }] }, { ...value, all: [value.all[0], value.all[0]] },
    { ...value, catalogIncomplete: 'private' }]) assert.throws(() => projectHandoffProviderStatus(input), /qa_handoff_catalog_invalid/);
});

test('Claude status projects strict booleans and known enums without accounts, credentials or raw errors', () => {
  const extra = { path: 'private', account: 'private', details: { accessToken: 'private' }, error: 'private', authMethod: 'oauth' };
  assert.deepEqual(projectHandoffClaudeStatus({ ...extra, installed: true, loggedIn: true, authStatus: 'authenticated' }),
    { installed: true, loggedIn: true, authStatus: 'authenticated' });
  assert.deepEqual(projectHandoffClaudeStatus({ ...extra, installed: true, loggedIn: false, authStatus: 'unavailable', errorCode: 'claude_credentials_expired' }),
    { installed: true, loggedIn: false, authStatus: 'unavailable', errorCode: 'claude_credentials_expired' });
  for (const value of [null, [], {}, { installed: 'private', loggedIn: true, authStatus: 'authenticated' },
    { installed: false, loggedIn: true, authStatus: 'authenticated' }, { installed: true, loggedIn: false, authStatus: 'authenticated' },
    { installed: true, loggedIn: true, authStatus: 'authenticated', errorCode: 'private' },
    { installed: true, loggedIn: false, authStatus: 'private' }, { installed: true, loggedIn: true, authStatus: 'unavailable', errorCode: 'claude_credentials_expired' },
    { installed: true, loggedIn: false, authStatus: 'unavailable', errorCode: 'private' }]) assert.throws(() => projectHandoffClaudeStatus(value), /qa_handoff_claude_status_invalid/);
});

test('reusable profile retention remains pinned after ordinary run completion and rejects foreign ownership', async t => {
  await fs.mkdir('.cache/test-fixtures', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.cache/test-fixtures/provider-handoff-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const run = { schemaVersion: 1, owner: 'scripts/qa/live-provider-handoff.mjs', createdAt: new Date().toISOString(), status: 'running', pinned: false };
  await fs.writeFile(path.join(root, 'run.json'), JSON.stringify(run), { mode: 0o600 });
  await pinProviderHandoff(root);
  await fs.writeFile(path.join(root, 'run.json'), JSON.stringify({ ...run, status: 'interrupted', completedAt: run.createdAt }));
  assert.equal(readRunMeta(root).pinned, true, 'Existing pruning policy must preserve the persistent profile');
  await pinProviderHandoff(root);
  await fs.writeFile(path.join(root, 'run.json'), JSON.stringify({ ...run, owner: 'foreign' }));
  await assert.rejects(pinProviderHandoff(root), /qa_handoff_identity_invalid/);
});

test('default registration reuses exact retained profile and refuses replacement, aliases and foreign ownership', async t => {
  await fs.mkdir('.cache/test-fixtures', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.cache/test-fixtures/provider-registration-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'provider-handoff-current.json');
  const makeProfile = async name => {
    const profile = path.join(root, name); await fs.mkdir(profile, { mode: 0o700 });
    await fs.writeFile(path.join(profile, 'run.json'), JSON.stringify({ schemaVersion: 1,
      owner: 'scripts/qa/live-provider-handoff.mjs', createdAt: new Date().toISOString() }), { mode: 0o600 });
    await writeHandoffDocument(profile);
    return path.join(profile, 'handoff.json');
  };
  const current = await makeProfile('current'), replacement = await makeProfile('replacement');
  assert.equal(await readRegisteredProviderHandoff(file), null);
  const value = await registerProviderHandoffProfile(current, file);
  assert.deepEqual(value.labels, { profile: 'V1', qa: 'QA1' });
  assert.equal(value.stateFile, current);
  assert.deepEqual(await registerProviderHandoffProfile(current, file), value);
  await assert.rejects(registerProviderHandoffProfile(replacement, file), /qa_handoff_profile_already_registered/);
  assert.deepEqual(await readRegisteredProviderHandoff(file), value);
  const alias = path.join(root, 'alias.json'); await fs.symlink(file, alias);
  await assert.rejects(readRegisteredProviderHandoff(alias), /qa_live_input_path_invalid/);
  await assert.rejects(registerProviderHandoffProfile(current, alias), /qa_live_input_path_invalid/);
  assert.deepEqual(await readRegisteredProviderHandoff(file), value);
  await fs.writeFile(path.join(path.dirname(current), 'run.json'), JSON.stringify({ schemaVersion: 1, owner: 'foreign' }));
  await assert.rejects(readRegisteredProviderHandoff(file), /qa_handoff_identity_invalid/);
  assert.equal((await fs.readdir(root)).some(name => name.endsWith('.tmp')), false);
});

test('default registration rejects forged labels, extra account fields and substituted profile path', async t => {
  await fs.mkdir('.cache/test-fixtures', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.cache/test-fixtures/provider-registration-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'run.json'), JSON.stringify({ schemaVersion: 1,
    owner: 'scripts/qa/live-provider-handoff.mjs', createdAt: new Date().toISOString() }), { mode: 0o600 });
  await writeHandoffDocument(root);
  const file = path.join(root, 'provider-handoff-current.json'), stateFile = path.join(root, 'handoff.json');
  const good = await registerProviderHandoffProfile(stateFile, file);
  for (const value of [{ ...good, labels: { profile: 'V2', qa: 'QA1' } }, { ...good, principal: 'forged' },
    { ...good, stateFile: path.join(root, 'other.json') }]) {
    await fs.writeFile(file, JSON.stringify(value));
    await assert.rejects(readRegisteredProviderHandoff(file), /qa_handoff_registration_invalid/);
  }
});

test('registration publication syncs its directory and removes temporary data after an interrupted write', async t => {
  await fs.mkdir('.cache/test-fixtures', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.cache/test-fixtures/provider-registration-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'run.json'), JSON.stringify({ schemaVersion: 1,
    owner: 'scripts/qa/live-provider-handoff.mjs', createdAt: new Date().toISOString() }), { mode: 0o600 });
  await writeHandoffDocument(root);
  const stateFile = path.join(root, 'handoff.json'), file = path.join(root, 'provider-handoff-current.json');
  let directorySynced = false;
  const io = { ...fs, open: async (name, ...args) => {
    const handle = await fs.open(name, ...args);
    if (name === root) return { sync: async () => { await handle.sync(); directorySynced = true; }, close: () => handle.close() };
    return { writeFile: async () => { throw Object.assign(new Error('interrupted write'), { code: 'EIO' }); },
      sync: () => handle.sync(), close: () => handle.close() };
  } };
  await assert.rejects(registerProviderHandoffProfile(stateFile, file, io), { code: 'EIO' });
  assert.equal(directorySynced, true);
  assert.equal(await readRegisteredProviderHandoff(file), null);
  assert.equal((await fs.readdir(root)).some(name => name.endsWith('.tmp')), false);
  directorySynced = false;
  io.open = async (name, ...args) => {
    const handle = await fs.open(name, ...args);
    return name === root ? { sync: async () => { await handle.sync(); directorySynced = true; }, close: () => handle.close() } : handle;
  };
  await registerProviderHandoffProfile(stateFile, file, io);
  assert.equal(directorySynced, true);
  assert.equal((await readRegisteredProviderHandoff(file)).stateFile, stateFile);
});

test('Claude security home uses trusted OS-user constructor value without a public command or HOME override', async () => {
  const source = await fs.readFile(new URL('./live-provider-handoff.mjs', import.meta.url), 'utf8');
  assert.match(source, /startWebUiServer\(\{[^}]*nativeClaudeSecurityHome: userInfo\(\)\.homedir,/);
  assert.ok(path.isAbsolute(userInfo().homedir));
  assert.throws(() => parseHandoffCommand(JSON.stringify({ command: 'restart', nativeClaudeSecurityHome: '/forged' })), /qa_handoff_command_invalid/);
  assert.equal(source.includes('HOME: userInfo().homedir'), false, 'Only the constructor-scoped security owner may use the OS home');
});

test('upgrade recovery requires exact native selected/previous/source/checkpoint and workspace lineage', () => {
  const state = { bundleID: 'independent-signin', controlRoot: '/owned/control' };
  const projectMap = [{ sourceDirectory: '/owned/workspace', targetDirectory: '/owned/workspace', mode: 'identity' }];
  const pending = { sourceBundleID: state.bundleID, sourceRevision: 1, targetManifestSha256: 'b'.repeat(64),
    projectMapSha256: createHash('sha256').update(canonicalJSON(projectMap)).digest('hex') };
  const bundleID = nativeUpgradeBundleID(pending.targetManifestSha256, 1);
  const binding = { controlRoot: state.controlRoot, admission: 'pending',
    selection: { selectedBundleID: bundleID, previousBundleID: state.bundleID, revision: 2, transition: 'activate', reconciliationRequired: false },
    descriptor: { bundleID, sourceBundleID: state.bundleID, checkpoint: { ownerID: state.bundleID, generation: 2 },
      launch: { artifactManifestSha256: pending.targetManifestSha256 }, projectMap } };
  assert.deepEqual(assertHandoffUpgradeLineage({ state, binding, pending }), { bundleID, revision: 2 });
  const persisted = JSON.parse(canonicalJSON(binding));
  assert.notEqual(JSON.stringify(persisted.descriptor.projectMap), JSON.stringify(projectMap), 'Native persistence reorders object keys');
  assert.deepEqual(assertHandoffUpgradeLineage({ state, binding: persisted, pending }), { bundleID, revision: 2 });
  const mutate = (change) => { const value = structuredClone(binding); change(value); return value; };
  for (const value of [mutate(row => row.controlRoot = '/foreign'), mutate(row => row.selection.previousBundleID = 'foreign'),
    mutate(row => row.selection.revision++), mutate(row => row.selection.reconciliationRequired = true),
    mutate(row => row.selection.transition = 'rollback'), mutate(row => row.admission = 'held'),
    mutate(row => row.descriptor.sourceBundleID = 'foreign'), mutate(row => row.descriptor.checkpoint.ownerID = 'foreign'),
    mutate(row => row.descriptor.launch.artifactManifestSha256 = 'c'.repeat(64)),
    mutate(row => row.descriptor.projectMap[0].targetDirectory = '/foreign'),
    mutate(row => row.descriptor.projectMap[0].sourceDirectory = '/foreign'),
    mutate(row => row.descriptor.projectMap[0].mode = 'copy'),
    mutate(row => row.descriptor.projectMap[0].extra = true),
    mutate(row => row.descriptor.projectMap.push({ ...row.descriptor.projectMap[0] }))]) {
    assert.throws(() => assertHandoffUpgradeLineage({ state, binding: value, pending }), /qa_handoff_upgrade_lineage_invalid/);
  }
  const ordered = [projectMap[0], { sourceDirectory: '/owned/second', targetDirectory: '/owned/second', mode: 'identity' }];
  const orderedPending = { ...pending, projectMapSha256: createHash('sha256').update(canonicalJSON(ordered)).digest('hex') };
  const orderedBinding = structuredClone(binding); orderedBinding.descriptor.projectMap = JSON.parse(canonicalJSON(ordered));
  assertHandoffUpgradeLineage({ state, binding: orderedBinding, pending: orderedPending });
  orderedBinding.descriptor.projectMap.reverse();
  assert.throws(() => assertHandoffUpgradeLineage({ state, binding: orderedBinding, pending: orderedPending }), /qa_handoff_upgrade_lineage_invalid/);
  assert.throws(() => assertHandoffUpgradeLineage({ state, binding, pending: { ...pending, sourceRevision: 0 } }), /qa_handoff_upgrade_lineage_invalid/);
});


test('owned journal windows refuse foreign sessions, extra fields and unbounded or reversed timestamps', () => {
  const owned = new Set(['ses_owned']), directory = path.resolve('.cache/qa/qa1-owned/project'), directories = new Set([directory]);
  const input = { sessionIDs: ['ses_owned'], directory, since: 1, until: 2 };
  assertHandoffJournalScope(input, owned, directories);
  for (const value of [{ ...input, sessionIDs: ['ses_foreign'] }, { ...input, sessionIDs: [] },
    { ...input, sessionIDs: ['ses_owned', 'ses_owned'] }, { ...input, since: NaN }, { ...input, until: 0 },
    { ...input, until: 3600002 }, { ...input, directory: path.resolve('.cache/qa/foreign') }, { ...input, credential: 'untrusted' }]) {
    assert.throws(() => assertHandoffJournalScope(value, owned, directories), /qa_profile_journal_scope_invalid/);
  }
});


test('child startup refusals preserve only exact bounded IPC codes and never replace cleanup or receipt gates', () => {
  const refusal = { status: 'refused', code: 'native_catalog_incomplete' };
  assert.deepEqual(projectHandoffChildRefusal(refusal), refusal);
  for (const value of [{ ...refusal, message: 'private account' }, { ...refusal, stack: 'private stack' },
    { ...refusal, account: 'private account' }, { ...refusal, code: 'private account' }, { ...refusal, code: 'EACCES' },
    { ...refusal, status: 'upgrade-committed' }, null, [], 'private']) assert.equal(projectHandoffChildRefusal(value), null);
  const result = { teardown: 'passed', exitCode: 0 }, receipt = { status: 'upgrade-committed', bundleID: 'owned', revision: 2 };
  assertHandoffUpgradeSettlement(result, receipt);
  assert.throws(() => assertHandoffUpgradeSettlement(result, receipt, refusal), { code: refusal.code });
  assert.throws(() => assertHandoffUpgradeSettlement({ ...result, teardown: 'failed' }, receipt, refusal), { code: 'qa_handoff_upgrade_unconfirmed' });
  assert.throws(() => assertHandoffUpgradeSettlement(result, undefined), { code: 'qa_handoff_upgrade_unconfirmed' });
  assert.throws(() => assertHandoffUpgradeSettlement({ ...result, exitCode: 1 }, receipt), { code: 'qa_handoff_upgrade_unconfirmed' });
});

test('original child reports a startup refusal over IPC before natural nonzero exit without exposing stdout or private state', async t => {
  await fs.mkdir('.cache/test-fixtures', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.cache/test-fixtures/provider-refusal-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'handoff.json'); await fs.writeFile(stateFile, JSON.stringify({ schema: 0 }), { mode: 0o600 });
  const child = fork(new URL('./live-provider-handoff.mjs', import.meta.url), ['--child', stateFile], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const messages = [], closed = once(child, 'exit');
  child.on('message', value => messages.push(value));
  try {
    child.send({ status: 'owner-attended', launcherPid: process.pid });
    assert.deepEqual(await closed, [1, null]);
    assert.deepEqual(messages, [{ status: 'refused', code: 'qa_handoff_identity_invalid' }]);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; }
});

test('Explorer apply keeps the owner transport bounded and revision conflicts distinct without broadening other request budgets', () => {
  assert.equal(qa1ExerciseRequestTimeout('/api/config/apply', 'POST'), 40000);
  assert.equal(qa1ExerciseRequestTimeout('/api/config/apply', 'GET'), 10000);
  assert.equal(qa1ExerciseRequestTimeout('/api/config/apply/acknowledge-external', 'POST'), 10000);
  assert.equal(qa1ExerciseRequestTimeout('/api/provider/cursor-acp/configure', 'POST'), 25000);
  assert.equal(qa1ExerciseHttpFailure('/api/config/apply', 'POST', 409), 'qa_profile_explorer_apply_revision_conflict');
  for (const status of [400, 403, 404, 500, 503]) assert.equal(qa1ExerciseHttpFailure('/api/config/apply', 'POST', status), 'qa_profile_explorer_apply_failed');
  assert.equal(qa1ExerciseHttpFailure('/api/config/agents/explorer/override', 'PUT', 409), 'qa_profile_api_explorer_override_save_409');
  assert.equal(qa1ExerciseHttpFailure('/api/other', 'GET', 404), 'qa_profile_api_not_found');
});

test('fixed QA HTTP failures retain bounded operation and status through the existing refusal projection', () => {
  for (const [pathname, method, operation] of [
    ['/api/provider/cursor-acp/runtime-status', 'GET', 'cursor_runtime_status'],
    ['/api/provider/cursor-acp/configure', 'POST', 'cursor_configure'],
    ['/api/config/settings', 'GET', 'settings_read'],
    ['/api/config/settings', 'PUT', 'settings_update'],
    ['/api/config/agents/explorer/override', 'DELETE', 'explorer_override_delete'],
    ['/api/session', 'POST', 'session_create'],
  ]) for (const status of [403, 500]) {
    const code = qa1ExerciseHttpFailure(pathname, method, status);
    assert.equal(code, `qa_profile_api_${operation}_${status}`);
    assert.deepEqual(projectHandoffChildRefusal({ status: 'refused', code }), { status: 'refused', code });
    assert.ok(code.length < 100);
  }
  assert.equal(qa1ExerciseHttpFailure('/api/provider/cursor-acp/runtime-status', 'GET', 404), 'qa_profile_api_not_found');
});

test('HTTP diagnostics never retain unknown paths, query secrets, arbitrary methods or invalid status values', () => {
  const secret = 'synthetic_private_account_token';
  for (const pathname of [`/api/session/${secret}/message`, `/api/${secret}`,
    `/api/provider/cursor-acp/runtime-status?credential=${secret}`, '/api/provider/cursor-acp/runtime-status/extra', null]) {
    const code = qa1ExerciseHttpFailure(pathname, 'GET', 403);
    assert.equal(code, 'qa_profile_api_failed'); assert.ok(!code.includes(secret));
    assert.equal(qa1ExerciseHttpFailure(pathname, 'GET', 404), 'qa_profile_api_not_found');
  }
  const requested = new URL(`/api/provider/cursor-acp/runtime-status?credential=${secret}`, 'http://fixture');
  assert.equal(qa1ExerciseHttpFailure(requested.pathname, 'GET', 403), 'qa_profile_api_cursor_runtime_status_403');
  for (const method of ['get', 'POST', 'PUT', 'PATCH', secret, null])
    assert.equal(qa1ExerciseHttpFailure(requested.pathname, method, 403), 'qa_profile_api_failed');
  for (const status of [undefined, null, '403', 403.5, NaN, Infinity, 0, 200, 399, 600])
    assert.equal(qa1ExerciseHttpFailure(requested.pathname, 'GET', status), 'qa_profile_api_failed');
});
