import assert from 'node:assert/strict';
import { test } from 'node:test';
import { qaPackagedAppEnvironment } from './launch-environment.mjs';
import { expectedUpdate, gradeVisualQa, parseVisualQaArgs, visualQaHostRefusal } from './release-visual-qa.mjs';

test('arguments name exactly one absolute DMG or a version, and an absolute report', () => {
  assert.deepEqual(parseVisualQaArgs(['--dmg', '/r/DevRyan-2.1.11-arm64.dmg', '--report', '/r/out/report.json', '--upgrade-from', 'v2.1.9']),
    { isolatedHost: false, keepArtifacts: false, dmg: '/r/DevRyan-2.1.11-arm64.dmg', report: '/r/out/report.json', upgradeFrom: 'v2.1.9' });
  assert.equal(parseVisualQaArgs(['--version', '2.1.11', '--report', '/r/report.json', '--isolated-host']).isolatedHost, true);
  for (const argv of [[], ['--report', '/r/report.json'], ['--dmg', 'relative.dmg', '--report', '/r/report.json'], ['--dmg', '/r/a.dmg', '--version', '2.1.11', '--report', '/r/report.json'],
    ['--version', 'v2.1.11', '--report', '/r/report.json'], ['--version', '2.1.11', '--report', 'report.json'], ['--version', '2.1.11', '--report', '/r/report.json', '--upgrade-from', '2.1.9'],
    ['--version', '2.1.11', '--report', '/r/report.json', '--force']]) assert.throws(() => parseVisualQaArgs(argv), undefined, argv.join(' '));
});

test('it never runs beside the owner app: a disposable runner or an isolated host, and no DevRyan running for this user', () => {
  assert.equal(visualQaHostRefusal({ platform: 'darwin', arch: 'arm64', environment: { GITHUB_ACTIONS: 'true' } }), null);
  assert.equal(visualQaHostRefusal({ platform: 'darwin', arch: 'arm64', environment: {}, isolatedHost: true }), null);
  assert.equal(visualQaHostRefusal({ platform: 'darwin', arch: 'arm64', environment: {} }), 'disposable_host_required');
  assert.equal(visualQaHostRefusal({ platform: 'darwin', arch: 'arm64', environment: { GITHUB_ACTIONS: 'true' }, runningApps: ['4242'] }), 'devryan_running_for_this_user');
  assert.equal(visualQaHostRefusal({ platform: 'linux', arch: 'x64', environment: { GITHUB_ACTIONS: 'true' } }), 'macos_arm64_required');
});

test('the private profile keeps HOME, XDG, temp and Git inside the run root and inherits no secrets', () => {
  const env = qaPackagedAppEnvironment({ home: '/run/candidate/home', root: '/run' }, { PATH: '/usr/bin', HOME: '/Users/owner', GITHUB_TOKEN: 'secret', OPENAI_API_KEY: 'secret' });
  assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/run/candidate/home', XDG_CONFIG_HOME: '/run/candidate/home/.config', XDG_DATA_HOME: '/run/candidate/home/.local/share',
    XDG_STATE_HOME: '/run/candidate/home/.local/state', XDG_CACHE_HOME: '/run/candidate/home/.cache', TMPDIR: '/run', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_CEILING_DIRECTORIES: '/run' });
});

test('the update check expects exactly what the real feed should offer', () => {
  assert.deepEqual(expectedUpdate({ current: '2.1.11', latest: '2.1.10' }), { available: false, version: null }, 'an unpublished candidate is newer than the feed');
  assert.deepEqual(expectedUpdate({ current: '2.1.11', latest: '2.1.11' }), { available: false, version: null });
  assert.deepEqual(expectedUpdate({ current: '2.1.9', latest: '2.1.11' }), { available: true, version: '2.1.11' });
  assert.deepEqual(expectedUpdate({ current: '2.1.11', latest: '2.10.0' }), { available: true, version: '2.10.0' });
  assert.deepEqual(expectedUpdate({ current: '2.1.11', latest: null }), { available: false, version: null });
});

test('every step, the optional upgrade and cleanup must pass; a skipped upgrade is not a failure', () => {
  const steps = Object.fromEntries(['dmg', 'install', 'splash', 'ready', 'about', 'updateCheck', 'stopped'].map(name => [name, { passed: true }]));
  assert.deepEqual(gradeVisualQa({ steps }), { passed: true, failures: [] });
  assert.deepEqual(gradeVisualQa({ steps, upgrade: { status: 'skipped' } }), { passed: true, failures: [] });
  assert.deepEqual(gradeVisualQa({ steps, upgrade: { status: 'failed' } }), { passed: false, failures: ['upgrade'] });
  assert.deepEqual(gradeVisualQa({ steps: { ...steps, about: { passed: false } }, cleanupFailures: [{ step: 'app' }] }), { passed: false, failures: ['about', 'cleanup'] });
  assert.deepEqual(gradeVisualQa({ steps: {} }).failures, ['dmg', 'install', 'splash', 'ready', 'about', 'updateCheck', 'stopped']);
});
