import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createQaHostLaunchEnvironment, qaPlatformEnvironment } from './launch-environment.mjs';
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
