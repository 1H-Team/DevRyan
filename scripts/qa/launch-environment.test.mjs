import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createQaHostLaunchEnvironment, createQaIsolatedRuntimeEnvironment, qaPlatformEnvironment } from './launch-environment.mjs';
import { createQaLaunchEnvironment } from './profile-preparation.mjs';

const hostile = {
  PATH: '/synthetic/bin', LANG: 'C', TERM: 'xterm', HOME: '/synthetic/personal',
  OPENAI_API_KEY: 'synthetic', ANTHROPIC_AUTH_TOKEN: 'synthetic', XAI_API_KEY: 'synthetic',
  OPENCODE_AUTH_CONTENT: 'synthetic', OPENCODE_HOST: 'http://outside.invalid',
  CLAUDE_CONFIG_DIR: '/synthetic/personal/claude', MERIDIAN_CLAUDE_PATH: '/synthetic/executable',
  NODE_OPTIONS: '--import=/synthetic/preload', ELECTRON_RUN_AS_NODE: '1', HTTP_PROXY: 'http://outside.invalid',
  GIT_CONFIG_GLOBAL: '/synthetic/personal/git', DEVRYAN_EXECUTION_WORKER: '1', UNKNOWN_SETTING: 'synthetic',
};

test('platform allowlist drops inherited providers, account paths, preloads, proxies and runtime flags', () => {
  assert.deepEqual(qaPlatformEnvironment(hostile), { PATH: hostile.PATH, LANG: 'C', TERM: 'xterm' });
  const profile = { HOME: '/synthetic/owned', NODE_OPTIONS: '--import=/synthetic/owned/shim',
    OPENCODE_HOST: 'http://127.0.0.1:1234', XDG_DATA_HOME: '/synthetic/owned/data' };
  const launched = createQaHostLaunchEnvironment(profile, { OPENCHAMBER_PORT: '2345' }, hostile);
  assert.deepEqual(launched, { PATH: hostile.PATH, LANG: 'C', TERM: 'xterm', ...profile, OPENCHAMBER_PORT: '2345' });
  assert.deepEqual(profile, { HOME: '/synthetic/owned', NODE_OPTIONS: '--import=/synthetic/owned/shim',
    OPENCODE_HOST: 'http://127.0.0.1:1234', XDG_DATA_HOME: '/synthetic/owned/data' });
});

test('live profile builder uses the same allowlist and supplies only owned account locations', () => {
  const environment = createQaLaunchEnvironment({ runtimeRoot: '/synthetic/owned', home: '/synthetic/owned/home',
    opencodeBinary: '/synthetic/owned/opencode', baseEnvironment: hostile });
  for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'XAI_API_KEY', 'OPENCODE_AUTH_CONTENT',
    'HTTP_PROXY', 'GIT_CONFIG_GLOBAL', 'DEVRYAN_EXECUTION_WORKER', 'UNKNOWN_SETTING', 'MERIDIAN_CLAUDE_PATH']) {
    assert.equal(environment[name], undefined, name);
  }
  assert.equal(environment.HOME, '/synthetic/owned/home');
  assert.equal(environment.CLAUDE_CONFIG_DIR, '/synthetic/owned/home/.claude');
  assert.equal(environment.PATH, hostile.PATH);
  assert.equal(environment.ELECTRON_RUN_AS_NODE, undefined);
});

test('isolated runtime environment owns the private home and carries fixture flags only when supplied', () => {
  const layout = { runtime: 'electron', runtimeRoot: '/synthetic/root', home: '/synthetic/root/home', data: '/synthetic/root/data',
    profile: '/synthetic/root/profile', distDirectory: '/synthetic/dist', port: 4567 };
  const native = createQaIsolatedRuntimeEnvironment(layout, hostile);
  for (const name of ['OPENCODE_HOST', 'OPENCODE_SKIP_START', 'OPENCHAMBER_SKIP_OPENCODE_START', 'OPENAI_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
    'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CLAUDE_CONFIG_DIR', 'DEVRYAN_EXECUTION_WORKER']) assert.equal(native[name], undefined, name);
  assert.deepEqual({ HOME: native.HOME, XDG_STATE_HOME: native.XDG_STATE_HOME, OPENCODE_CONFIG_DIR: native.OPENCODE_CONFIG_DIR,
    OPENCHAMBER_DATA_DIR: native.OPENCHAMBER_DATA_DIR, OPENCHAMBER_PORT: native.OPENCHAMBER_PORT, DEVRYAN_QA_RUNTIME: native.DEVRYAN_QA_RUNTIME,
    DEVRYAN_QA_RUNTIME_ROOT: native.DEVRYAN_QA_RUNTIME_ROOT, DEVRYAN_QA_HOME: native.DEVRYAN_QA_HOME },
  { HOME: '/synthetic/root/home', XDG_STATE_HOME: '/synthetic/root/home/.local/state', OPENCODE_CONFIG_DIR: '/synthetic/root/home/.config/opencode',
    OPENCHAMBER_DATA_DIR: '/synthetic/root/data', OPENCHAMBER_PORT: '4567', DEVRYAN_QA_RUNTIME: 'electron',
    DEVRYAN_QA_RUNTIME_ROOT: '/synthetic/root', DEVRYAN_QA_HOME: '/synthetic/root/home' });
  const fixture = createQaIsolatedRuntimeEnvironment({ ...layout, overrides: { OPENCODE_HOST: 'http://127.0.0.1:1', OPENCODE_SKIP_START: 'true' },
    runtimeEnv: { FIXTURE_TOKEN: 'synthetic' } }, hostile);
  assert.equal(fixture.OPENCODE_HOST, 'http://127.0.0.1:1');
  assert.equal(fixture.OPENCODE_SKIP_START, 'true');
  assert.equal(fixture.FIXTURE_TOKEN, 'synthetic', 'fixture runtime variables are applied after the secret-name filter');
});
