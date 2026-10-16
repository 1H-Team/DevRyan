import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { releaseStartupEnvironment } from './release-startup-profile.mjs';
import { parseReleaseStartupArgs, summarizeCompiledQualification, createReleaseScenarioRunner, assertReleaseDiagnosticEnvironment } from './release-startup.mjs';
import { createDiagnosticSanitizer } from '../../packages/harness-runtime/lib/sanitizer.js';
import { launchReleaseStartup, captureReleaseStartupScreenshot, readReleaseSetupInterfaceState } from './release-startup-launch.mjs';

test('empty setup requires ready visible controls without provider-dependent welcome text', () => {
  const control = () => ({ disabled: false, getBoundingClientRect: () => ({ width: 100, height: 30 }) });
  const controls = { textarea: [control()], 'button[aria-label="New Chat"]': [control()], '.model-controls__model-trigger': [control()] };
  const context = { window: { __openchamberStartupReady: true }, document: { readyState: 'complete', visibilityState: 'visible',
    body: { innerText: 'Start new chat Not selected' }, querySelectorAll: selector => controls[selector] ?? [] },
    getComputedStyle: element => element.style ?? { display: 'block', visibility: 'visible', opacity: '1' } };
  const state = () => runInNewContext(`(${readReleaseSetupInterfaceState.toString()})()`, context);
  const ready = () => Object.values(state()).every(Boolean);
  assert.equal(ready(), true);
  context.window.__openchamberStartupReady = false; assert.equal(ready(), false);
  context.window.__openchamberStartupReady = true;
  context.document.readyState = 'loading'; assert.equal(ready(), false);
  context.document.readyState = 'complete';
  context.document.visibilityState = 'hidden'; assert.equal(ready(), false);
  context.document.visibilityState = 'visible';
  controls.textarea[0].disabled = true; assert.equal(ready(), false);
  controls.textarea[0].disabled = false;
  controls['button[aria-label="New Chat"]'][0].getBoundingClientRect = () => ({ width: 0, height: 0 });
  assert.equal(ready(), false);
  controls['button[aria-label="New Chat"]'] = [control()];
  controls['.model-controls__model-trigger'][0].parentElement = { style: { display: 'block', visibility: 'visible', opacity: '0' } };
  assert.equal(ready(), false);
  controls['.model-controls__model-trigger'] = []; assert.equal(ready(), false);
});

test('native lifecycle children report a bounded fatal cause before their default trace', () => {
  const command = fileURLToPath(new URL('../opencode-v2-native/legacy-lifecycle-driver.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [command], { input: '', encoding: 'utf8', timeout: 15000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  const line = result.stderr.split('\n').find(row => row.startsWith('[native-lifecycle] '));
  assert.match(line ?? '', /^\[native-lifecycle\] SyntaxError:/);
  assert.ok(line.length < 1100);
});

test('compiled qualification failures retain bounded diagnostics without private result fields', () => {
  const sanitizer = createDiagnosticSanitizer({ homeDir: '/private-fixture' });
  const result = summarizeCompiledQualification({ status: 'failed', root: '/private-fixture/data',
    cases: [{ id: 'compiled-ready-catalog', status: 'passed', privateValue: 'private-value' }],
    error: { message: 'Failed in /private-fixture/data with Authorization: Bearer secret-fixture-token' },
    cleanupFailures: [], sourceCohort: { changedPaths: [] } }, sanitizer);
  assert.equal(result.outcome, 'failed');
  assert.deepEqual(result.cases, [{ id: 'compiled-ready-catalog', status: 'passed' }]);
  assert.equal(result.cleanupFailures, 0);
  assert.equal(result.changedSources, 0);
  assert.ok(result.reason.length <= 1000);
  assert.doesNotMatch(JSON.stringify(result), /private-fixture|private-value|secret-fixture-token/);
});

test('release profiles cannot inherit external runtimes, accounts, preloads or a selected candidate', () => {
  const env = releaseStartupEnvironment('/private-fixture', { PATH: '/usr/bin:/bin', HOME: '/real-user',
    DEVRYAN_RUNTIME_BUNDLE_ROOT: '/preselected', OPENCHAMBER_ELECTRON_DEV: '1', OPENCODE_HOST: 'https://external.example',
    NODE_OPTIONS: '--require=external', ANTHROPIC_API_KEY: 'not-a-real-key', HTTPS_PROXY: 'https://external.example' });
  assert.equal(env.HOME, '/private-fixture/home');
  assert.equal(env.XDG_STATE_HOME, '/private-fixture/home/.local/state');
  for (const key of ['DEVRYAN_RUNTIME_BUNDLE_ROOT', 'OPENCHAMBER_ELECTRON_DEV', 'OPENCODE_HOST', 'NODE_OPTIONS', 'ANTHROPIC_API_KEY', 'HTTPS_PROXY'])
    assert.equal(env[key], undefined);
});
test('release CLI rejects missing, relative and unsupported arguments', () => {
  const args = ['--release-dmg', '/fixture/DevRyan-2.0.9-arm64.dmg', '--version', '2.0.9', '--source-commit', 'a'.repeat(40), '--receipt', '/fixture/receipt.json'];
  assert.equal(parseReleaseStartupArgs(args).version, '2.0.9');
  for (const bad of [[], [...args, '--skip-service'], args.slice(0, -2), args.map(value => value.startsWith('/fixture') ? value.slice(1) : value)])
    assert.throws(() => parseReleaseStartupArgs(bad));
});
test('production app launches refuse a workstation before reading the artifact or profile', async () => {
  if (process.env.CI === 'true') return;
  await assert.rejects(launchReleaseStartup(null, null), /ephemeral GitHub-hosted macOS ARM64 runner/);
});
test('captured screenshot evidence hashes written pixels and copies only exact artifact identity', async () => {
  const parent = fileURLToPath(new URL('../../.cache/release-startup-tests/', import.meta.url));
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'screenshot-'));
  try {
    const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(2048)]);
    const identity = { sourceCommit: 'a'.repeat(40), dmgSha256: 'b'.repeat(64), manifestSha256: 'c'.repeat(64), appSha256: 'd'.repeat(64),
      privateField: 'must-not-copy', scenarios: [] };
    const launch = { cdp: { send: async method => { assert.equal(method, 'Page.captureScreenshot'); return { data: bytes.toString('base64') }; } } };
    const evidence = await captureReleaseStartupScreenshot(launch, root, 'DevRyan-startup-fixture.png', identity);
    assert.deepEqual(fs.readFileSync(path.join(root, evidence.name)), bytes);
    assert.equal(evidence.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(evidence.privateField, undefined); assert.equal(evidence.scenarios, undefined);
    assert.equal(evidence.sourceCommit, identity.sourceCommit);
    await assert.rejects(captureReleaseStartupScreenshot(launch, root, '../unsafe.png', identity));
    await assert.rejects(captureReleaseStartupScreenshot(launch, root, 'DevRyan-startup-fixture.png', identity), { code: 'EEXIST' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('every PR runs startup contracts; short exact-DMG smoke gates publication while the legacy suite remains distinct', () => {
  const read = file => fs.readFileSync(new URL('../../' + file, import.meta.url), 'utf8');
  const pr = read('.github/workflows/startup-contract.yml'), release = read('.github/workflows/release.yml');
  assert.match(pr, /pull_request:/); assert.doesNotMatch(pr, /paths(?:-ignore)?:/); assert.match(pr, /bun run test:startup/);
  assert.match(release, /needs.final-dmg-smoke.result == 'success'/);
  assert.match(release, /release-startup-smoke.mjs/);
  assert.doesNotMatch(release, /qualify-release-startup|verify-release-startup|--release-dmg/);
  assert.doesNotMatch(release, /reboot_qualification_run_id|--reboot-receipt|DevRyan-reboot-qualification|stage_startup_installer_only|staged_desktop_run_id/);
});


test('diagnostics continue independent failures, block dependents and never retry a case', async () => {
  const receipt = { scenarios: [], cleanupErrors: [] };
  let stops = 0, calls = 0;
  const scenario = createReleaseScenarioRunner({ receipt, diagnostic: true, stop: async () => { stops++; }, sanitizeReason: () => 'sanitized' });
  await scenario('empty-profile', async () => { calls++; throw new Error('private failure'); });
  await scenario('unchanged-reopen', async () => { calls++; }, { dependsOn: ['empty-profile'] });
  await scenario('upgrade-previous', async () => { calls++; });
  await scenario('service-warm', async () => { calls++; throw new Error('service failure'); });
  await scenario('service-cold', async () => { calls++; }, { dependsOn: ['service-warm'] });
  assert.deepEqual(receipt.scenarios.map(row => row.outcome), ['failed', 'blocked', 'passed', 'failed', 'blocked']);
  assert.deepEqual(receipt.scenarios.map(row => row.attempts), [1, 0, 1, 1, 0]);
  assert.deepEqual(receipt.scenarios[1].blockedBy, ['empty-profile']);
  assert.deepEqual(receipt.scenarios[4].blockedBy, ['service-warm']);
  assert.equal(receipt.scenarios[0].reason, 'sanitized');
  assert.equal(stops, 3); assert.equal(calls, 3);
});

test('normal qualification stays fail-fast and diagnostics stop on failed cleanup', async () => {
  for (const diagnostic of [false, true]) {
    const receipt = { scenarios: [], cleanupErrors: [] };
    const scenario = createReleaseScenarioRunner({ receipt, diagnostic, stop: async () => {}, sanitizeReason: String });
    const error = new Error('failure');
    if (diagnostic) error.code = 'release_startup_cleanup_failed';
    await assert.rejects(scenario('fixture', async () => { throw error; }));
    assert.equal(receipt.scenarios[0].outcome, 'failed');
  }
  const receipt = { scenarios: [], cleanupErrors: [] };
  const scenario = createReleaseScenarioRunner({ receipt, diagnostic: true, stop: async () => { throw new Error('owner survived'); }, sanitizeReason: String });
  await assert.rejects(scenario('fixture', async () => {}));
  assert.equal(receipt.scenarios[0].cleanup, 'failed');
  assert.deepEqual(receipt.cleanupErrors, ['fixture_foreground_cleanup_failed']);
});

test('diagnostics require a manual dry run and are explicitly rejected by publication', async () => {
  const { assertReleaseStartupReceipt } = await import('./release-startup-contract.mjs');
  assertReleaseDiagnosticEnvironment(true, { GITHUB_EVENT_NAME: 'workflow_dispatch', RELEASE_DRY_RUN: 'true' });
  for (const env of [{}, { GITHUB_EVENT_NAME: 'push', RELEASE_DRY_RUN: 'true' }, { GITHUB_EVENT_NAME: 'workflow_dispatch', RELEASE_DRY_RUN: 'false' }])
    assert.throws(() => assertReleaseDiagnosticEnvironment(true, env));
  assert.throws(() => assertReleaseStartupReceipt({ protocol: 'devryan.release-startup/1', diagnostic: true, outcome: 'passed' }, {}), /Diagnostic receipts/);
  const source = fs.readFileSync(new URL('./release-startup.mjs', import.meta.url), 'utf8');
  assert.match(source, /assert.equal\(receipt.runAttempt, 1/);
  assert.match(source, /await assertNoPriorStartupFailure\(sourceCommit/);
  assert.match(source, /assert.ok\(!diagnostic, 'Diagnostic receipts cannot qualify a release'\)/);
});


test('diagnostic cleanup wrappers and shared prerequisite failures stop the run', async () => {
  const { runReleaseCleanup } = await import('./release-startup-service.mjs');
  await assert.rejects(runReleaseCleanup(async () => { throw new Error('fixture cleanup'); }), { code: 'release_startup_cleanup_failed' });
  const scenario = createReleaseScenarioRunner({ receipt: { scenarios: [], cleanupErrors: [] }, diagnostic: true, stop: async () => {}, sanitizeReason: String });
  await assert.rejects(scenario('fixture', async () => { throw Object.assign(new Error('shared prerequisite'), { code: 'release_startup_prerequisite_failed' }); }), { code: 'release_startup_prerequisite_failed' });
});
