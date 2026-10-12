import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { releaseStartupEnvironment } from './release-startup-profile.mjs';
import { parseReleaseStartupArgs, summarizeCompiledQualification } from './release-startup.mjs';
import { createDiagnosticSanitizer } from '../../packages/harness-runtime/lib/sanitizer.js';
import { launchReleaseStartup, captureReleaseStartupScreenshot } from './release-startup-launch.mjs';

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
test('every PR runs startup contracts and every release publication depends on final-DMG qualification', () => {
  const read = file => fs.readFileSync(new URL('../../' + file, import.meta.url), 'utf8');
  const pr = read('.github/workflows/startup-contract.yml'), release = read('.github/workflows/release.yml');
  assert.match(pr, /pull_request:/); assert.doesNotMatch(pr, /paths(?:-ignore)?:/); assert.match(pr, /bun run test:startup/);
  for (const name of ['publish-npm', 'finalize-release']) {
    const job = release.slice(release.indexOf(`  ${name}:`)).split(/\n  [a-z][a-z-]+:/)[0];
    assert.match(job, /needs: \[[^\]]*qualify-release-startup/);
  }
  assert.equal((release.match(/node scripts\/verify-release-startup.mjs/g) ?? []).length, 2);
  assert.match(release, /--release-dmg/);
  assert.doesNotMatch(release, /reboot_qualification_run_id|--reboot-receipt|DevRyan-reboot-qualification|stage_startup_installer_only|staged_desktop_run_id/);
});
