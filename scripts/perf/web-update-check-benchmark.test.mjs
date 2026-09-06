import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  UPDATE_CHECK_MODULE, UPDATE_CHECK_SOURCE_HASHES, WEB_UPDATE_CHECK_PROTOCOL,
  validateWebUpdateCheckOptions, assertUpdateCheckSource, createUpdateCheckModuleManifestEntry, assertOnlyUpdateCheckModuleDiff,
  isReadOnlyPackageProbe, observePackageProbe, assertColdUpdateCheckEvidence,
  summarizeUpdateCheckCpu, summarizeWebUpdateCheckStudy,
} from './web-update-check-benchmark.mjs';

const ROOT = process.cwd();
const options = () => ({ beforeSource: path.join(ROOT, '.cache/before.js'), afterSource: path.join(ROOT, '.cache/after.js'), uiDirectory: path.join(ROOT, 'packages/web/dist') });
const fingerprint = file => createHash('sha256').update(file).digest('hex');
const manifest = arm => [{ file: UPDATE_CHECK_MODULE, sha256: UPDATE_CHECK_SOURCE_HASHES[arm] }, { file: 'node_modules/example/index.js', sha256: 'a'.repeat(64) }]
  .map(entry => ({ ...entry, fingerprint: fingerprint(entry.file) }));
const response = () => ({ status: 200, body: { available: false, currentVersion: 'unknown', error: 'Unable to check DevRyan releases' }, durationMs: 400 });
const host = arm => ({ errors: [], targetLoads: 1, requests: [{ startMs: 50, endMs: 450, authorized: true, status: 200 }],
  probes: [{ kind: arm === 'before' ? 'spawnSync' : 'execFile', phase: 'cold', startMs: 60, endMs: 440 }],
  selection: { reason: 'cached', packageManager: 'npm' }, profileStoppedBeforeSelection: true,
  cpu: { complete: true, packageManagerSpawnSyncMs: arm === 'before' ? 390 : 0 },
  loadedModules: manifest(arm), runtime: { node: 'v26.0.0', executable: { sha256: 'e'.repeat(64) } }, eventLoop: [{ atMs: 460, lagMs: 350 }] });
const study = () => WEB_UPDATE_CHECK_PROTOCOL.order.map((arm, index) => ({ arm, order: index + 1, outcome: 'passed',
  host: host(arm), response: response(), cleanup: { complete: true }, journal: { complete: true, gapRecords: 0, errorRecords: 0 },
  source: { sha256: 's' }, scripts: { sha256: 'p' }, ui: { sha256: 'u' }, servedIndex: { sha256: 'i' }, health: [{ durationMs: 400 }] }));

test('core rejects unknown options, escaping paths, forced discovery and release API overrides', () => {
  assert.equal(validateWebUpdateCheckOptions(options(), {}).label, 'cold-discovery');
  for (const value of [{ ...options(), runs: 1 }, { ...options(), beforeSource: '/tmp/before.js' },
    { ...options(), uiDirectory: path.join(ROOT, '..', 'other') }, { ...options(), outputRoot: path.join(ROOT, '.cache/../outside') },
    { ...options(), label: '../unsafe' }, { ...options(), signal: {} }]) assert.throws(() => validateWebUpdateCheckOptions(value, {}));
  for (const environment of [{ OPENCHAMBER_PACKAGE_MANAGER: 'npm' }, { OPENCHAMBER_UPDATE_API_URL: 'https://example.test' },
    { OPENCHAMBER_RUNTIME: 'desktop' }, { OPENCHAMBER_UI_PASSWORD: 'enabled' }]) assert.throws(() => validateWebUpdateCheckOptions(options(), environment));
});

test('one-module provenance rejects drift, missing modules, duplicate entries and reversed arms', () => {
  assert.doesNotThrow(() => assertOnlyUpdateCheckModuleDiff(manifest('before'), manifest('after')));
  const extraChange = manifest('after'); extraChange[1].sha256 = 'b'.repeat(64);
  for (const pair of [[manifest('before'), extraChange], [manifest('before'), manifest('after').slice(0, 1)],
    [manifest('before'), [...manifest('after'), manifest('after')[0]]], [manifest('after'), manifest('before')],
    [manifest('after'), manifest('after')]]) assert.throws(() => assertOnlyUpdateCheckModuleDiff(...pair));
});

test('module fingerprints are mandatory, unique and bound to the exact changed target', () => {
  for (const mutate of [value => { delete value[0].fingerprint; }, value => { value[0].fingerprint = 'invalid'; },
    value => { value[0].fingerprint = value[1].fingerprint; }, value => { value[0].sha256 = null; },
    value => { value[0] = null; }, value => { value[1].fingerprint = fingerprint('node_modules/different/index.js'); }]) {
    const value = manifest('after'); mutate(value);
    assert.throws(() => assertOnlyUpdateCheckModuleDiff(manifest('before'), value));
  }
  const before = manifest('before'); const after = manifest('after');
  // Keeping the readable target label and pinned bytes cannot substitute for
  // the fingerprint of the actual target path.
  before[0].fingerprint = fingerprint('packages/web/server/lib/other.js');
  after[0].fingerprint = before[0].fingerprint;
  assert.throws(() => assertOnlyUpdateCheckModuleDiff(before, after), /exact package-manager module/);
});

test('source pinning rejects changed code before a host can be launched', () => {
  const source = readFileSync(path.join(ROOT, UPDATE_CHECK_MODULE));
  // The historical study keeps its original pins when application code changes.
  for (const arm of ['before', 'after']) {
    if (fingerprint(source) === UPDATE_CHECK_SOURCE_HASHES[arm]) {
      assert.doesNotThrow(() => assertUpdateCheckSource(source, arm));
    } else {
      assert.throws(() => assertUpdateCheckSource(source, arm), /Unexpected .* package-manager source/);
    }
  }
  assert.throws(() => assertUpdateCheckSource(Buffer.concat([source, Buffer.from('\n')]), 'after'));
  assert.throws(() => assertUpdateCheckSource(source, 'unknown'));
});

test('mandatory sanitizer preserves the exact executable, module and artifact hash proofs', async () => {
  const { createDiagnosticSanitizer } = await import(path.join(ROOT, 'packages/harness-runtime/lib/sanitizer.js'));
  const sanitizer = createDiagnosticSanitizer({ homeDir: process.env.HOME });
  const value = study();
  for (const entry of value) {
    entry.source.sha256 = UPDATE_CHECK_SOURCE_HASHES.after;
    entry.host.runtime.executable.sha256 = UPDATE_CHECK_SOURCE_HASHES.before;
  }
  const sanitized = sanitizer.sanitizeExportValue(value);
  assert.deepEqual(sanitized, value);
  assert.doesNotThrow(() => summarizeWebUpdateCheckStudy(sanitized));
});

test('real installed scoped dependency paths may redact identically without losing module provenance', async () => {
  const { createDiagnosticSanitizer } = await import(path.join(ROOT, 'packages/harness-runtime/lib/sanitizer.js'));
  const sanitizer = createDiagnosticSanitizer({ homeDir: process.env.HOME,
    pathMappings: [{ path: ROOT, placeholder: '<REPOSITORY>' }] });
  const sdk = path.dirname(realpathSync(fileURLToPath(import.meta.resolve('@opencode-ai/sdk/v2'))));
  const dependencies = ['gen/client.gen.js', 'gen/client/client.gen.js'].map(file => {
    const filename = path.join(sdk, file);
    return createUpdateCheckModuleManifestEntry(filename, readFileSync(filename));
  });
  assert.notEqual(dependencies[0].file, dependencies[1].file);
  assert.notEqual(dependencies[0].fingerprint, dependencies[1].fingerprint);
  for (const entry of dependencies) assert.equal(entry.fingerprint, fingerprint(entry.file));
  const redacted = sanitizer.sanitizeExportValue(dependencies);
  assert.equal(redacted[0].file, redacted[1].file);
  assert.match(redacted[0].file, /\[REDACTED\]:high_entropy/);
  assert.deepEqual(redacted.map(({ fingerprint, sha256 }) => [fingerprint, sha256]),
    dependencies.map(({ fingerprint, sha256 }) => [fingerprint, sha256]));
  const value = study();
  for (const arm of value) arm.host.loadedModules.push(...dependencies);
  // The host writes sanitized evidence, then the driver sanitizes the study.
  const retained = sanitizer.sanitizeExportValue(sanitizer.sanitizeExportValue(value));
  assert.deepEqual(summarizeWebUpdateCheckStudy(retained), summarizeWebUpdateCheckStudy(value));
  assert.throws(() => createUpdateCheckModuleManifestEntry('/outside/module.js', Buffer.from('source')));
  assert.throws(() => createUpdateCheckModuleManifestEntry(UPDATE_CHECK_MODULE, Buffer.from('source')));
});

test('every arm compares fingerprint membership and content independently of readable labels and row order', () => {
  const value = study();
  value[2].host.loadedModules.reverse();
  for (const entry of value[3].host.loadedModules) entry.file = '[REDACTED]';
  assert.deepEqual(summarizeWebUpdateCheckStudy(value), summarizeWebUpdateCheckStudy(study()));
  for (const mutate of [arm => { delete arm.host.loadedModules[0].fingerprint; },
    arm => { arm.host.loadedModules[0].fingerprint = arm.host.loadedModules[1].fingerprint; },
    arm => { arm.host.loadedModules[1].fingerprint = fingerprint('node_modules/different/index.js'); }]) {
    const changed = study(); mutate(changed[4]);
    assert.throws(() => summarizeWebUpdateCheckStudy(changed));
  }
});

test('only actual read-only package-discovery command forms are admitted', () => {
  for (const [command, args] of [['npm', ['root', '-g']], ['/opt/local/bin/bun', ['pm', 'bin', '-g']], ['yarn', ['global', 'list', '--depth=0']]]) {
    assert.equal(isReadOnlyPackageProbe(command, args), true);
  }
  for (const [command, args] of [['sh', ['-c', 'npm --version']], ['npm', ['install', '-g', 'example']],
    ['npm', ['list', '-g', '--depth=0', 'different-package']], ['curl', ['--version']], ['npm', ['--version', '--extra']]]) {
    assert.equal(isReadOnlyPackageProbe(command, args), false);
  }
});

test('sync observation preserves identity, exact options, return value, error behavior and non-target calls', () => {
  const records = []; const context = {}; const commandOptions = { timeout: 10000, encoding: 'utf8' };
  const output = { status: 0, stdout: 'private command output', stderr: '' }; let call;
  const original = function (...args) { call = { context: this, args }; return output; };
  const custom = Symbol('custom'); original[custom] = context;
  const observed = observePackageProbe(original, 'spawnSync', { matchesCaller: () => true, phase: () => 'cold', record: entry => records.push(entry), now: () => records.length * 10 });
  assert.equal(observed.call(context, 'npm', ['--version'], commandOptions), output);
  assert.equal(call.context, context); assert.equal(call.args[2], commandOptions); assert.equal(observed[custom], context);
  assert.equal(records.length, 1); assert.equal(records[0].stdout.bytes, output.stdout.length);
  assert.equal(JSON.stringify(records).includes(output.stdout), false);
  const failure = Object.assign(new Error('probe failed'), { code: 'ENOENT' });
  const throwing = observePackageProbe(() => { throw failure; }, 'spawnSync', { matchesCaller: () => true, phase: () => 'cold', record: entry => records.push(entry) });
  assert.throws(() => throwing('npm', ['--version']), error => error === failure);
  assert.equal(records[1].errorCode, 'ENOENT'); assert.equal(Number.isFinite(records[1].endMs), true);
  const ignored = observePackageProbe(original, 'spawnSync', { matchesCaller: () => false, phase: () => { throw new Error('must not record'); }, record: () => {} });
  assert.equal(ignored.call(context, 'git', ['status']), output);
  assert.throws(() => observed('npm', ['install']), /non-read-only/);
  assert.equal(records.at(-1).blocked, true);
});

test('async observation preserves child return and callback arguments/context without swallowing callback failure', () => {
  const records = []; const child = {}; const callbackThis = {}; let pending;
  const original = (...args) => { pending = args.at(-1); return child; };
  const observed = observePackageProbe(original, 'execFile', { matchesCaller: () => true, phase: () => 'cold', record: entry => records.push(entry) });
  const failure = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); let received;
  assert.equal(observed('npm', ['root', '-g'], { timeout: 10000 }, function (...args) { received = { context: this, args }; }), child);
  assert.equal(records[0].endMs, null); pending.call(callbackThis, failure, 'out', 'err');
  assert.deepEqual(received, { context: callbackThis, args: [failure, 'out', 'err'] }); assert.equal(records[0].errorCode, 'ETIMEDOUT');
  const callbackFailure = new Error('caller failure');
  observed('npm', ['--version'], {}, () => { throw callbackFailure; });
  assert.throws(() => pending(null, '1.0', ''), error => error === callbackFailure);
});

test('cold gate rejects warm, missing, incomplete, unrelated and out-of-window discovery', () => {
  assert.doesNotThrow(() => assertColdUpdateCheckEvidence(host('before'), response()));
  for (const mutate of [value => { value.probes = []; }, value => { value.targetLoads = 2; }, value => { value.errors.push('truncated'); },
    value => { value.requests.push({ ...value.requests[0] }); }, value => { value.requests[0].authorized = false; },
    value => { value.probes[0].phase = 'startup'; }, value => { value.probes[0].endMs = null; },
    value => { value.probes[0].startMs = 49; }, value => { value.probes[0].endMs = 451; },
    value => { value.selection.reason = 'fallback'; }, value => { value.profileStoppedBeforeSelection = false; },
    value => { value.cpu.complete = false; }, value => { value.probes.push({ phase: 'selection-proof', blocked: true }); }]) {
    const value = host('before'); mutate(value); assert.throws(() => assertColdUpdateCheckEvidence(value, response()));
  }
  const extra = response(); extra.body.packageManager = 'npm'; assert.throws(() => assertColdUpdateCheckEvidence(host('before'), extra));
  assert.throws(() => assertColdUpdateCheckEvidence(host('before'), { ...response(), status: 503 }));
  const selected = host('after'); selected.probes.push({ phase: 'selection-proof', startMs: 600, endMs: 700 });
  assert.doesNotThrow(() => assertColdUpdateCheckEvidence(selected, response()));
});

test('V8 attribution counts only sync stacks descended from the exact package-manager URL', () => {
  const url = 'file:///repository/packages/web/server/lib/package-manager.js';
  const profile = { nodes: [
    { id: 1, callFrame: { functionName: 'root', url: '' }, children: [2, 4] },
    { id: 2, callFrame: { functionName: 'getCommandOutput', url }, children: [3, 6] },
    { id: 3, callFrame: { functionName: 'spawnSync', url: 'node:child_process' } },
    { id: 4, callFrame: { functionName: 'other', url: 'file:///other.js' }, children: [5] },
    { id: 5, callFrame: { functionName: 'spawnSync', url: 'node:child_process' } },
    { id: 6, callFrame: { functionName: 'execFile', url: 'node:child_process' } },
  ], samples: [3, 5, 6], timeDeltas: [4000, 9000, 1000] };
  // The first 4 ms precede the first sample. Its forward interval is 9 ms.
  assert.equal(summarizeUpdateCheckCpu(profile, url).packageManagerSpawnSyncMs, 9);
  assert.equal(summarizeUpdateCheckCpu(profile, `${url}?other`).packageManagerSpawnSyncMs, 0);
  assert.equal(summarizeUpdateCheckCpu({ ...profile, timeDeltas: [1] }, url).complete, false);
  assert.equal(summarizeUpdateCheckCpu({ nodes: [], samples: [], timeDeltas: [] }, url).complete, false);
});

test('V8 normalization preserves sample identity through negative deltas and equal timestamps', () => {
  const url = 'file:///package-manager.js';
  const nodes = [{ id: 1, callFrame: { functionName: 'discover', url }, children: [2] },
    { id: 2, callFrame: { functionName: 'spawnSync', url: 'node:child_process' } },
    { id: 3, callFrame: { functionName: 'other', url: '' } }];
  const profile = { nodes, samples: [2, 3, 1], timeDeltas: [4000, 9000, -1000] };
  const original = structuredClone(profile);
  const result = summarizeUpdateCheckCpu(profile, url);
  assert.equal(result.complete, true); assert.equal(result.packageManagerSpawnSyncMs, 8);
  assert.deepEqual(result.normalization, { method: 'stable timestamp sort; forward intervals; average terminal interval',
    rawNegativeDeltas: 1, reorderedSamples: 2, sampledWindowMs: 13.5 });
  assert.deepEqual(profile, original, 'Raw samples and deltas must remain unchanged');
  const ordered = { nodes, samples: [2, 1, 3], timeDeltas: [4000, 8000, 1000] };
  assert.equal(summarizeUpdateCheckCpu(ordered, url).packageManagerSpawnSyncMs, result.packageManagerSpawnSyncMs);
  assert.equal(summarizeUpdateCheckCpu({ nodes, samples: [3, 2, 1], timeDeltas: [4000, 0, 9000] }, url).packageManagerSpawnSyncMs, 9);
  assert.equal(summarizeUpdateCheckCpu({ nodes, samples: [3, 1, 2], timeDeltas: [4000, 9000, 1000] }, url).packageManagerSpawnSyncMs, 5);
  for (const value of [{ ...profile, timeDeltas: [1, NaN, 1] }, { ...profile, timeDeltas: [1, Infinity, 1] },
    { ...profile, timeDeltas: [Number.MAX_VALUE, Number.MAX_VALUE, 1] }, { ...profile, timeDeltas: [0, 0, 0] },
    { ...profile, samples: [2, 99, 1] }, { ...profile, nodes: [...nodes, nodes[0]] },
    { ...profile, samples: [2], timeDeltas: [1] },
    { ...profile, nodes: [{ ...nodes[0], children: [2, 99] }, ...nodes.slice(1)] },
    { ...profile, nodes: [nodes[0], { ...nodes[1], children: [1] }, nodes[2]] }]) {
    const invalid = summarizeUpdateCheckCpu(value, url);
    assert.equal(invalid.complete, false); assert.equal(invalid.packageManagerSpawnSyncMs, null);
  }
});

test('CPU completeness and stop ordering failures have separate errors', () => {
  const incomplete = host('before'); incomplete.cpu.complete = false;
  assert.throws(() => assertColdUpdateCheckEvidence(incomplete, response()), /CPU profile is incomplete/);
  const overlap = host('before'); overlap.profileStoppedBeforeSelection = false;
  assert.throws(() => assertColdUpdateCheckEvidence(overlap, response()), /must end before/);
});

test('three fixed-order pairs cannot pass with dropped failures, changed identities, selection, gaps or dirty cleanup', () => {
  const summary = summarizeWebUpdateCheckStudy(study());
  assert.equal(summary.before.coldRequestMs.count, 3); assert.equal(summary.after.packageManagerSpawnSyncMs.median, 0);
  assert.throws(() => summarizeWebUpdateCheckStudy(study().slice(1)));
  for (const mutate of [value => { value[0].outcome = 'failed'; }, value => { value[0].arm = 'after'; },
    value => { value[2].host.runtime.node = 'v99'; }, value => { value[3].ui.sha256 = 'changed'; },
    value => { value[4].scripts.sha256 = 'changed'; }, value => { value[5].source.sha256 = 'changed'; },
    value => { value[2].host.selection.packageManager = 'yarn'; }, value => { value[1].cleanup.complete = false; },
    value => { value[4].journal.gapRecords = 1; }, value => { value[4].journal.errorRecords = 1; },
    value => { value[3].host.loadedModules[1].sha256 = 'b'.repeat(64); }]) {
    const value = study(); mutate(value); assert.throws(() => summarizeWebUpdateCheckStudy(value));
  }
});
