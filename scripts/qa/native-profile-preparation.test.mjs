import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { verifyQaNativeInput, projectQaNativeSnapshot, assertQaNativeSelection, assertQaNativeCredentialAdmission, prepareQaNativeProfile, validateQaNativeSourceLaunch, createQaNativeLaunchEnvironment,
  createQaNativeInputVerifier, archiveQaNativeControllerLog, qaNativeRequiredProviders } from './native-profile-preparation.mjs';
import { prepareQaMatrixLiveProfile } from './matrix-runner.mjs';
import { translateNativeConfiguration } from '../../packages/web/server/lib/opencode/runtime-host/native-configuration-data.js';
import { createDiagnosticSanitizer } from '../../packages/harness-runtime/lib/sanitizer.js';

test('native input manifest covers every copied file and rejects changed, missing, additional and symlinked state', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.resolve('.cache/qa-native-input-')));
  const sourceHome = path.join(root, 'source'), artifactRoot = path.join(root, 'artifacts');
  await fs.mkdir(sourceHome); await fs.mkdir(artifactRoot);
  const bytes = '{"agents":{"orchestrator":{"model":"saved/model"}}}\n';
  const file = path.join(sourceHome, 'saved.json'); await fs.writeFile(file, bytes);
  const input = { sourceHome, artifactRoot, files: [{ path: 'saved.json', sha256: createHash('sha256').update(bytes).digest('hex') }] };
  try {
    assert.match(await verifyQaNativeInput(input), /^[a-f0-9]{64}$/);
    await fs.writeFile(file, bytes + ' '); await assert.rejects(verifyQaNativeInput(input), { code: 'qa_native_input_changed' });
    await fs.writeFile(file, bytes); await fs.writeFile(path.join(sourceHome, 'extra'), 'unlisted');
    await assert.rejects(verifyQaNativeInput(input), { code: 'qa_native_input_changed' }); await fs.rm(path.join(sourceHome, 'extra'));
    await fs.rename(file, path.join(root, 'original')); await fs.symlink(path.join(root, 'original'), file);
    await assert.rejects(verifyQaNativeInput(input), { code: 'qa_native_input_symlink' }); await fs.rm(file);
    await assert.rejects(verifyQaNativeInput(input), { code: 'qa_native_input_changed' });
    await assert.rejects(verifyQaNativeInput({ ...input, files: [{ ...input.files[0], path: '../original' }] }), { code: 'qa_native_input_manifest_invalid' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('saved snapshot reports original role effort and ordered Council routes, only prompt digests', () => {
  const directory = '/owned/project', digest = 'a'.repeat(64);
  const snapshot = { digest, sourceStamp: 'b'.repeat(64), locations: [{ directory,
    configuration: translateNativeConfiguration({ legacy: {}, agents: {
      orchestrator: { model: 'saved/root', variant: 'medium', prompt: 'private original prompt' },
      oracle: { model: 'anthropic/oracle', variant: 'high', prompt: 'private oracle prompt' },
      builder: { model: 'saved/builder', variant: null, prompt: 'private builder prompt' },
    } }),
    compatibility: { agents: { council: { councillors: [{ model: 'openai/member-one', variant: 'medium' }, { model: 'xai/member-two', variant: 'high' }] } } },
  }] };
  const view = projectQaNativeSnapshot(snapshot, directory);
  assert.equal(view.agentSelections.orchestrator.model, 'saved/root'); assert.equal(view.agentSelections.oracle.variant, 'high');
  assert.equal(view.agentSelections.orchestrator.variant, 'medium'); assert.equal(view.agentSelections.builder.variant, 'default');
  assert.equal(view.agentSelections.orchestrator.promptSha256, createHash('sha256').update('private original prompt').digest('hex'));
  assert.equal(view.agentSelections.oracle.promptSha256, createHash('sha256').update('private oracle prompt').digest('hex'));
  assert.deepEqual(view.councilMembers.map(row => [row.providerId, row.modelId, row.variant]), [['openai', 'member-one', 'medium'], ['xai', 'member-two', 'high']]);
  assert.equal(JSON.stringify(view).includes('private original prompt'), false); assert.equal(JSON.stringify(view).includes('private oracle prompt'), false);
  const cell = { agent: 'orchestrator', providerId: 'saved', modelId: 'root', variant: 'medium' };
  assertQaNativeSelection(cell, view);
  assert.throws(() => assertQaNativeSelection({ ...cell, variant: 'high' }, view), { code: 'qa_native_saved_selection_mismatch' });
  assert.throws(() => projectQaNativeSnapshot(snapshot, '/foreign'), { code: 'qa_native_location_missing' });
});

test('native live branch requires constructor preparation instead of legacy home/auth fallback', async () => {
  let legacyCalled = false;
  await assert.rejects(prepareQaMatrixLiveProfile({ providerId: 'saved', modelId: 'root' }, { targetGeneration: 2 }, () => { legacyCalled = true; }),
    { code: 'qa_native_preparation_prerequisite' });
  assert.equal(legacyCalled, false);
  const record = { kind: 'native-credential', credentialID: 'owned-account', expectedFingerprint: 'c'.repeat(64), valueType: 'oauth', expires: 100 + 1000 + 600000 };
  assert.equal(assertQaNativeCredentialAdmission('saved', { saved: record }, 1000, 100).expiryCheck, 'passed');
  assert.throws(() => assertQaNativeCredentialAdmission('saved', { saved: { ...record, expires: 99 } }, 1000, 100), { code: 'qa_native_credential_expiry' });
  assert.throws(() => assertQaNativeCredentialAdmission('saved', { saved: { ...record, refresh: 'never-report-this' } }, 1000, 100), { code: 'qa_native_credential_prerequisite' });
  const meridian = { kind: 'meridian-profile', profileID: 'saved-profile', configurationFingerprint: 'd'.repeat(64), authKind: 'oauth-token', expires: record.expires };
  assert.equal(assertQaNativeCredentialAdmission('anthropic', { anthropic: meridian }, 1000, 100).profileID, 'saved-profile');
  assert.throws(() => assertQaNativeCredentialAdmission('anthropic', { anthropic: record }, 1000, 100), { code: 'qa_native_credential_prerequisite' });
  assert.throws(() => assertQaNativeCredentialAdmission('anthropic', { anthropic: { ...meridian, oauthToken: 'must-not-enter-evidence' } }, 1000, 100), { code: 'qa_native_credential_prerequisite' });
  assert.throws(() => assertQaNativeCredentialAdmission('anthropic', { anthropic: { ...meridian, expires: undefined } }, 1000, 100), { code: 'qa_native_credential_expiry' });
});

test('preparation failure still checks source immutability and refuses symlink parents before mkdir', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.resolve('.cache/qa-native-source-')));
  const sourceHome = path.join(root, 'source'), artifactRoot = path.join(root, 'artifacts'), workspace = path.join(root, 'workspace');
  for (const directory of [sourceHome, artifactRoot, workspace]) await fs.mkdir(directory);
  const file = path.join(sourceHome, 'original'), bytes = 'original'; await fs.writeFile(file, bytes);
  const preparedInput = { sourceHome, artifactRoot, files: [{ path: 'original', sha256: createHash('sha256').update(bytes).digest('hex') }] };
  try {
    const originalError = new Error('source owner failed');
    await assert.rejects(prepareQaNativeProfile({ runtimeRoot: path.join(root, 'runtime'), workspace, cell: {},
      nativePreparation: { preparedInput, bootstrapCredentials: () => assert.fail('Credential acquisition was reached'),
        prepareSource: async () => { await fs.writeFile(file, 'changed'); throw originalError; } } }),
    error => error instanceof AggregateError && error.errors[0] === originalError && error.errors[1].code === 'qa_native_input_changed');
    await fs.writeFile(file, bytes);
    const outside = path.join(root, 'outside'); await fs.mkdir(outside); await fs.symlink(outside, path.join(root, 'escape'));
    await assert.rejects(prepareQaNativeProfile({ runtimeRoot: path.join(root, 'escape/new/runtime'), workspace, cell: {},
      nativePreparation: { preparedInput, bootstrapCredentials: () => assert.fail('Credential acquisition was reached'),
        prepareSource: () => assert.fail('Source owner was reached') } }), { code: 'qa_native_input_path_invalid' });
    assert.deepEqual(await fs.readdir(outside), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('the offline source home must exist canonically inside the private runtime', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.resolve('.cache/qa-native-globals-'))), runtimeRoot = path.join(root, 'runtime');
  await fs.mkdir(runtimeRoot);
  const database = path.join(runtimeRoot, 'source.db'); await fs.writeFile(database, 'preflight fixture only');
  const global = Object.fromEntries(['home', 'config', 'data', 'state', 'cache', 'tmp', 'bin', 'log', 'repos'].map(key => [key, path.join(runtimeRoot, key)]));
  for (const directory of Object.values(global)) await fs.mkdir(directory);
  const launch = { opencodeDatabasePath: database, webDataDirectory: global.data, webConfigDirectory: global.config, opencodeConfigDirectory: global.config, global: { home: global.home } };
  try {
    await validateQaNativeSourceLaunch(launch, runtimeRoot);
    const outside = path.join(root, 'outside'); await fs.mkdir(outside);
    for (const key of ['home']) {
      const missing = { home: global.home }; delete missing[key];
      await assert.rejects(validateQaNativeSourceLaunch({ ...launch, global: missing }, runtimeRoot), { code: 'qa_native_source_not_isolated' });
      await assert.rejects(validateQaNativeSourceLaunch({ ...launch, global: { home: global.home, [key]: outside } }, runtimeRoot), { code: 'qa_native_source_not_isolated' });
      const alias = path.join(runtimeRoot, `alias-${key}`); await fs.symlink(global[key], alias);
      await assert.rejects(validateQaNativeSourceLaunch({ ...launch, global: { home: global.home, [key]: alias } }, runtimeRoot), { code: 'qa_native_input_path_invalid' });
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('native launch environment runs the real home preload and isolated-host rejects missing bundle admission', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.resolve('.cache/qa-native-host-'))), home = path.join(root, 'home');
  await fs.mkdir(home); await fs.writeFile(path.join(home, '.devryan-qa-home'), 'owned native host fixture\n');
  await fs.mkdir(path.join(root, 'missing-bundle'));
  await fs.writeFile(path.join(root, 'credentials.env.json'), '{}\n');
  const launch = { global: Object.fromEntries(['home', 'config', 'data', 'state', 'cache', 'tmp'].map(key => [key, key === 'home' ? home : path.join(home, key)])), webDataDirectory: path.join(root, 'web-data') };
  for (const directory of Object.values(launch.global)) await fs.mkdir(directory, { recursive: true });
  const env = createQaNativeLaunchEnvironment({ binding: { controlRoot: path.join(root, 'missing-bundle'), descriptor: { launch } }, runtimeRoot: root,
    baseEnvironment: { PATH: process.env.PATH, NODE_OPTIONS: '--invalid-parent-preload', OPENCODE_BINARY: '/unowned/runtime', OPENCODE_CONFIG_CONTENT: 'unowned observer' } });
  try {
    assert.equal(env.OPENCODE_BINARY, undefined); assert.equal(env.OPENCODE_CONFIG_CONTENT, undefined);
    const child = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', "import os from 'node:os';process.stdout.write(JSON.stringify({home:os.homedir(),testHome:process.env.OPENCODE_TEST_HOME}));"], { env });
    assert.deepEqual(JSON.parse(child.stdout), { home, testHome: home }); assert.equal(child.stderr, '');
    await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL('./isolated-host.mjs', import.meta.url))], {
      env: { ...env, DEVRYAN_QA_RUNTIME: 'web', OPENCHAMBER_PORT: '0' }, timeout: 30000, maxBuffer: 1024 * 1024,
    }), error => error.code === 1 && error.stderr.includes('selection.json') && error.stderr.includes('ENOENT'));
    await assert.rejects(fs.access(path.join(root, 'ready.json')), { code: 'ENOENT' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('offline migration sources reject runnable controller and artifact fields', async () => {
  await assert.rejects(validateQaNativeSourceLaunch({ controllerBinary: '/unowned/not-to-be-read', global: { home: '/unowned' } }, '/unowned'), { code: 'qa_native_source_not_isolated' });
});

test('the bound input verifier retains its original manifest through the complete cell lifetime', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.resolve('.cache/qa-native-recheck-')));
  const sourceHome = path.join(root, 'source'), artifactRoot = path.join(root, 'artifacts');
  await fs.mkdir(sourceHome); await fs.mkdir(artifactRoot);
  const file = path.join(sourceHome, 'saved'), bytes = 'saved original'; await fs.writeFile(file, bytes);
  const input = { sourceHome, artifactRoot, files: [{ path: 'saved', sha256: createHash('sha256').update(bytes).digest('hex') }] };
  try {
    const bound = await createQaNativeInputVerifier(input); assert.equal(await bound.verifyInputs(), bound.inputDigest);
    await fs.writeFile(file, 'mutated during cell'); input.files[0].sha256 = createHash('sha256').update('mutated during cell').digest('hex');
    await assert.rejects(bound.verifyInputs(), { code: 'qa_native_input_changed' });
    await fs.writeFile(file, bytes); assert.equal(await bound.verifyInputs(), bound.inputDigest);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('native controller logs are bounded, sanitized and archived from the verified exact log root', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.resolve('.cache/qa-native-logs-')));
  const logRoot = path.join(root, 'log'), evidence = path.join(root, 'evidence'); await fs.mkdir(logRoot); await fs.mkdir(evidence);
  const file = path.join(logRoot, 'native-controller.jsonl');
  const profile = { nativeLogRoot: logRoot, env: { DEVRYAN_QA_RUNTIME_ROOT: root } };
  const sanitizer = createDiagnosticSanitizer({ homeDir: root });
  try {
    await fs.writeFile(file, JSON.stringify({ event: 'native-process-exit', code: 0, token: 'synthetic-secret-value',
      receipt: { path: path.join(root, 'receipt'), terminated: true, confined: true, cancelled: false, exitCode: 0 } }) + '\n');
    const result = await archiveQaNativeControllerLog(profile, evidence, sanitizer);
    assert.equal(result.state, 'captured');
    const output = await fs.readFile(path.join(evidence, result.file), 'utf8');
    assert.equal(output.includes('synthetic-secret-value'), false); assert.equal(output.includes(root), false);
    assert.equal(JSON.parse(output).code, 0); assert.equal(result.sha256, createHash('sha256').update(output).digest('hex'));
    await fs.writeFile(file, JSON.stringify({ event: 'native-process-exit', code: 0, observationUnavailable: true }) + '\n');
    const warning = await archiveQaNativeControllerLog(profile, evidence, sanitizer);
    assert.equal(warning.observationUnavailable, true);
    assert.equal(JSON.parse(await fs.readFile(path.join(evidence, warning.file), 'utf8')).observationUnavailable, true);
    await fs.writeFile(file, 'x'.repeat(4 * 1024 * 1024 + 1));
    await assert.rejects(archiveQaNativeControllerLog(profile, evidence, sanitizer), { code: 'qa_native_log_size_limit' });
    await fs.rm(file); await fs.symlink(path.join(evidence, 'native-controller.jsonl'), file);
    await assert.rejects(archiveQaNativeControllerLog(profile, evidence, sanitizer), { code: 'qa_native_log_path_invalid' });
    await assert.rejects(archiveQaNativeControllerLog({ ...profile, nativeLogRoot: '/outside/log' }, evidence, sanitizer), { code: 'qa_native_log_path_invalid' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('native saved fallback projection retains ordered original models and efforts with separate execution defaults', () => {
  const directory = '/owned/project';
  const location = { directory, activeRegistrationIDs: ['devryan.slim'], configuration: translateNativeConfiguration({ legacy: {},
    agents: { orchestrator: { model: 'openai/root', variant: 'high', prompt: 'unchanged' } } }),
    compatibility: { agents: {}, slim: { nativeRuntime: {
      runtimeChains: { orchestrator: ['openai/root', 'xai/backup', 'anthropic/final'], 'councillor-oracle': ['xai/seat', 'openai/seat-backup'] },
      modelArrays: { orchestrator: [{ id: 'openai/root', variant: 'high' }, { id: 'xai/backup', variant: 'medium' }, { id: 'anthropic/final' }],
        'councillor-oracle': [{ id: 'xai/seat', variant: 'high' }, { id: 'openai/seat-backup', variant: 'low' }] },
      fallback: { enabled: true, maxRetries: 3, initialRetryDelayMs: 0, retryDelayMs: 500 },
    } } } };
  const snapshot = { digest: 'a'.repeat(64), sourceStamp: 'b'.repeat(64), locations: [location] };
  const view = projectQaNativeSnapshot(snapshot, directory, { devryanBackupSelections: { orchestrator: { model: 'opencode-go/shared-backup', variant: 'medium' } } });
  assert.deepEqual(view.nativeBackupSelections.slim.runtimeChains, location.compatibility.slim.nativeRuntime.runtimeChains);
  assert.deepEqual(view.nativeBackupSelections.slim.modelArrays.orchestrator, [
    { id: 'openai/root', variant: 'high' }, { id: 'xai/backup', variant: 'medium' }, { id: 'anthropic/final', variant: null },
  ]);
  assert.equal(view.nativeBackupSelections.slim.effectiveExecutionVariant, 'default');
  assert.deepEqual(view.nativeBackupSelections.devryan, { orchestrator: { model: 'opencode-go/shared-backup', variant: 'medium' } });
  assert.deepEqual(view.nativeBackupSelections.slim.fallback, location.compatibility.slim.nativeRuntime.fallback);
  assert.equal(view.agentSelections.orchestrator.variant, 'high');
  assert.deepEqual(qaNativeRequiredProviders(view), ['openai', 'xai', 'anthropic', 'opencode-go']);
  assert.throws(() => assertQaNativeCredentialAdmission(qaNativeRequiredProviders(view).at(-1), { openai: { kind: 'native-credential' } }, 1000), { code: 'qa_native_credential_prerequisite' });
  for (const change of [
    value => { delete value.locations[0].compatibility.slim.nativeRuntime; },
    value => { delete value.locations[0].compatibility.slim.nativeRuntime.modelArrays.orchestrator; },
    value => { value.locations[0].compatibility.slim.nativeRuntime.modelArrays.orchestrator.pop(); },
    value => { value.locations[0].compatibility.slim.nativeRuntime.runtimeChains.orchestrator.reverse(); },
  ]) {
    const invalid = structuredClone(snapshot); change(invalid);
    assert.throws(() => projectQaNativeSnapshot(invalid, directory), error => ['qa_native_backup_routes_missing', 'qa_native_backup_routes_invalid'].includes(error.code));
  }
});
