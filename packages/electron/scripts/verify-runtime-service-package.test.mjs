import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runtimeServiceProbeLaunch } from './verify-runtime-service-package.mjs';

const realHome = os.homedir();
const inherited = {
  ...process.env, PATH: '/usr/bin:/bin', HOME: realHome, XDG_CONFIG_HOME: path.join(realHome, '.config'),
  XDG_STATE_HOME: path.join(realHome, '.local/state'), DEVRYAN_DATA_DIR: path.join(realHome, '.config/devryan'),
  DEVRYAN_ELECTRON_USER_DATA_DIR: path.join(realHome, 'Library/Application Support/@devryan/electron'),
  DEVRYAN_RUNTIME_BUNDLE_ROOT: path.join(realHome, '.local/state/devryan/runtime-bundles'),
  OPENCODE_CONFIG_DIR: path.join(realHome, '.config/opencode'), DEVRYAN_ELECTRON_DEV: '1', ELECTRON_RUN_AS_NODE: '1',
  CSC_KEY_PASSWORD: 'synthetic', GITHUB_TOKEN: 'synthetic', APPLE_APP_SPECIFIC_PASSWORD: 'synthetic',
};
// A path string only: the test never creates scratch or launches the app.
const root = path.join(os.tmpdir(), 'devryan-runtime-package', 'run-synthetic');
const inside = (value) => typeof value === 'string' && path.isAbsolute(value)
  && (path.resolve(value) === root || path.resolve(value).startsWith(root + path.sep));

test('the status probe runs the candidate on a private profile inside its run root', () => {
  const executable = '/Volumes/candidate/DevRyan.app/Contents/MacOS/DevRyan';
  const launch = runtimeServiceProbeLaunch({ executable, root, name: 'dmg' }, inherited);
  const { env, cwd } = launch.options;
  assert.equal(launch.command, executable);
  assert.deepEqual(launch.args, ['--runtime-service-control=status', '--use-mock-keychain']);
  assert.equal(launch.home, path.join(root, 'dmg-home'));
  assert.ok(inside(cwd), cwd);

  // Every location the app derives: electron-log and LaunchAgents follow HOME;
  // data roots follow XDG; userData follows DEVRYAN_ELECTRON_USER_DATA_DIR.
  const locations = {
    HOME: env.HOME, TMPDIR: env.TMPDIR, XDG_CONFIG_HOME: env.XDG_CONFIG_HOME, XDG_DATA_HOME: env.XDG_DATA_HOME,
    XDG_STATE_HOME: env.XDG_STATE_HOME, XDG_CACHE_HOME: env.XDG_CACHE_HOME, userData: env.DEVRYAN_ELECTRON_USER_DATA_DIR,
    logs: path.join(env.HOME, 'Library/Logs/DevRyan'), launchAgents: path.join(env.HOME, 'Library/LaunchAgents'),
    devryanConfig: path.join(env.XDG_CONFIG_HOME, 'devryan'), legacyConfig: path.join(env.XDG_CONFIG_HOME, 'openchamber'),
    devryanState: path.join(env.XDG_STATE_HOME, 'devryan'), opencodeConfig: path.join(env.XDG_CONFIG_HOME, 'opencode'),
    opencodeData: path.join(env.XDG_DATA_HOME, 'opencode'),
  };
  for (const [name, location] of Object.entries(locations)) assert.ok(inside(location), `${name}: ${location}`);
  assert.equal(env.DEVRYAN_ELECTRON_USER_DATA_DIR, path.join(launch.home, 'electron-profile'));

  // Nothing points back to the account: no inherited data root, bundle root,
  // OpenCode config, dev-mode flag, Node mode or secret.
  for (const [name, value] of Object.entries(env)) {
    assert.ok(!String(value).startsWith(realHome + path.sep) && value !== realHome, `${name} resolves to the real home`);
  }
  for (const name of ['DEVRYAN_DATA_DIR', 'DEVRYAN_RUNTIME_BUNDLE_ROOT', 'OPENCODE_CONFIG_DIR', 'DEVRYAN_ELECTRON_DEV',
    'ELECTRON_RUN_AS_NODE', 'CSC_KEY_PASSWORD', 'GITHUB_TOKEN', 'APPLE_APP_SPECIFIC_PASSWORD']) {
    assert.equal(env[name], undefined, name);
  }
});

test('both candidates get separate homes in the same run root', () => {
  const unpacked = runtimeServiceProbeLaunch({ executable: '/x/DevRyan', root, name: 'unpacked' }, inherited);
  const dmg = runtimeServiceProbeLaunch({ executable: '/y/DevRyan', root, name: 'dmg' }, inherited);
  assert.notEqual(unpacked.home, dmg.home);
  assert.equal(unpacked.options.env.TMPDIR, root);
  assert.equal(dmg.options.env.TMPDIR, root);
});

test('the verifier launches the candidate only through the private probe launch inside an OS-temp run root', () => {
  const source = fs.readFileSync(new URL('./verify-runtime-service-package.mjs', import.meta.url), 'utf8');
  const probe = source.slice(source.indexOf('const launch = runtimeServiceProbeLaunch('), source.indexOf('const output ='));
  assert.match(probe, /run\(launch\.command, launch\.args, \{[\s\S]*\.\.\.launch\.options,/);
  assert.equal(source.match(/run\(executable\b/g), null, 'the executable is never run on the inherited environment');
  assert.match(source, /createRunRoot\(\{\s+parent: scratchParent\('runtime-package'\)/);
  assert.doesNotMatch(source, /RUNNER_TEMP|'\/tmp'/);
});

test('the verifier runs when started through a symlinked path, and not when imported', async () => {
  const { isMainModule } = await import('./verify-runtime-service-package.mjs');
  const moduleUrl = new URL('./verify-runtime-service-package.mjs', import.meta.url);
  const real = fs.realpathSync(moduleUrl);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-verifier-entry-'));
  try {
    const link = path.join(directory, 'verify.mjs');
    fs.symlinkSync(real, link);
    assert.equal(isMainModule(moduleUrl.href, real), true);
    assert.equal(isMainModule(moduleUrl.href, link), true, 'a symlinked entry still runs the verifier');
    assert.equal(isMainModule(moduleUrl.href, path.join(directory, 'other.mjs')), false);
    assert.equal(isMainModule(moduleUrl.href, undefined), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
