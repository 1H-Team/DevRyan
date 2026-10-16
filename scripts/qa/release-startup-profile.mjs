import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { qaPlatformEnvironment } from './launch-environment.mjs';
import { createRuntimeUiProvider, runtimeUiConfiguration, runtimeUiNativeConfiguration, runtimeUiAgentOverrides, runtimeUiTuple } from './native-backend-ui-diagnostic.mjs';
import { readRuntimeBundleBinding } from '../../packages/web/server/lib/opencode/runtime-host/runtime-bundle-binding.js';
import { reservePort } from './process.mjs';

const exec = promisify(execFile);
export function releaseStartupEnvironment(root, base = process.env) {
  const home = path.join(root, 'home');
  return { ...qaPlatformEnvironment(base), HOME: home, ZDOTDIR: path.join(root, 'shell'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_STATE_HOME: path.join(home, '.local/state'), XDG_CACHE_HOME: path.join(home, '.cache'),
    TMPDIR: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'), TEMP: path.join(root, 'tmp'),
    OPENCHAMBER_DATA_DIR: path.join(home, '.config/openchamber'),
    OPENCHAMBER_ELECTRON_USER_DATA_DIR: path.join(root, 'profile'),
    GH_CONFIG_DIR: path.join(root, 'gh'), GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: root, GIT_TERMINAL_PROMPT: '0', NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1' };
}

export async function createReleaseStartupProfile(root, { fixtureSetup = true, resume = false, deadline, signal } = {}) {
  const check = () => { signal?.throwIfAborted(); if (deadline !== undefined) assert.ok(performance.now() < deadline, 'Release fixture deadline expired'); };
  check();
  const env = releaseStartupEnvironment(root), workspace = path.join(root, 'workspace');
  for (const directory of [root, workspace, env.HOME, env.ZDOTDIR, env.TMPDIR, env.OPENCHAMBER_DATA_DIR,
    env.OPENCHAMBER_ELECTRON_USER_DATA_DIR, path.join(env.XDG_CONFIG_HOME, 'opencode')]) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  assert.equal(await fs.realpath(root), root);
  // Electron starts in HOME; fence both discovery roots from the enclosing checkout.
  for (const directory of [env.HOME, workspace]) await exec('git', ['init', '--quiet', '--initial-branch=main', '--template=', directory], { env, signal, timeout: deadline === undefined ? undefined : Math.max(1, deadline - performance.now()) });
  check();
  const port = await reservePort(), provider = await createRuntimeUiProvider({ generation: 2, directory: workspace });
  const settings = { desktopLocalPort: port, desktopLanAccessEnabled: false,
    productionBotsRuntimeMode: 'disabled', productionBotsRuntimeServiceOptOut: true,
    lastDirectory: workspace, activeProjectId: 'release-startup',
    projects: [{ id: 'release-startup', path: workspace, label: 'Release startup fixture' }],
    messageStreamTransport: 'sse', desktopWindowState: { width: 1280, height: 800, maximized: false } };
  const controlRoot = path.join(env.XDG_STATE_HOME, 'devryan/runtime-bundles');
  const binding = () => readRuntimeBundleBinding({ DEVRYAN_RUNTIME_BUNDLE_ROOT: controlRoot });
  const writeJson = async (file, value) => {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    check();
    await fs.writeFile(file, JSON.stringify(value) + '\n', { mode: 0o600, signal });
    check();
  };
  const configure = async ({ selected = false } = {}) => {
    const legacy = runtimeUiConfiguration(provider.baseURL), native = runtimeUiNativeConfiguration(legacy);
    const configDirectory = selected ? binding().descriptor.launch.opencodeConfigDirectory : path.join(env.XDG_CONFIG_HOME, 'opencode');
    await writeJson(path.join(configDirectory, 'opencode.json'), { ...legacy, provider: undefined, providers: native.providers });
    await writeJson(path.join(configDirectory, '.openchamber/config.json'), { agentOverrides: runtimeUiAgentOverrides() });
    const modelSettings = { ...settings, defaultModel: legacy.model, defaultAgent: 'builder', defaultVariant: runtimeUiTuple.variant };
    await writeJson(path.join(env.OPENCHAMBER_DATA_DIR, 'settings.json'), modelSettings);
    if (selected) await writeJson(path.join(binding().descriptor.launch.webDataDirectory, 'settings.json'), modelSettings);
  };
  try {
    assert.equal(await fs.stat(path.join(controlRoot, 'selection.json')).then(() => true, () => false), resume,
      resume ? 'Reboot qualification must retain the original provisioned profile' : 'Release startup must perform its own bundle provisioning');
    if (resume) await configure({ selected: true });
    else {
      await writeJson(path.join(env.OPENCHAMBER_DATA_DIR, 'settings.json'), settings);
      if (fixtureSetup) await configure();
    }
    check();
    return { root, env, workspace, port, controlRoot, binding, configure, provider,
      close: () => provider.close(), check: () => provider.check() };
  } catch (error) { await provider.close(); throw error; }
}
