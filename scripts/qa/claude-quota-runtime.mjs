// Real DevRyan/OpenCode transport in an owned profile. Credentials are supplied
// only in child environments by the live runner; this module never reads them.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { repository, studyModel, studyEffort, requireCacheDirectory } from './claude-quota-fixture.mjs';
import { createUserProfileProvisioningRuntime } from '../../packages/web/server/lib/opencode/user-profile-provisioning.js';
import { prepareQaPluginHomeWrapper, pinQaAgents } from './profile-preparation.mjs';
import { MERIDIAN_PREFIX_EDITS } from '../../packages/web/server/lib/opencode/meridian-passthrough-hotfix.js';
import { reservePort, startOwnedProcess } from './process.mjs';

export async function prepareClaudeQuotaRuntime({ fixture, installedModules, opencodeExecutable, claudeExecutable, arm }) {
  if (!['control', 'candidate'].includes(arm) || !path.isAbsolute(opencodeExecutable) || !path.isAbsolute(claudeExecutable)) {
    throw new Error('Expected explicit native runtime executables and a comparison arm');
  }
  await requireCacheDirectory(fixture.root);
  await requireCacheDirectory(fixture.workspace);
  const runtimeRoot = path.join(fixture.root, 'runtime');
  const qaHome = path.join(runtimeRoot, 'home');
  const config = path.join(qaHome, '.config/opencode');
  const data = path.join(qaHome, '.config/openchamber');
  const claude = path.join(qaHome, '.claude');
  const shim = path.join(repository, 'scripts/qa/isolated-home.mjs');
  const env = {
    PATH: process.env.PATH, USER: process.env.USER, TERM: process.env.TERM ?? 'xterm-256color',
    DEVRYAN_QA_RUNTIME_ROOT: runtimeRoot, DEVRYAN_QA_HOME: qaHome, DEVRYAN_QA_RUNTIME: 'web',
    OPENCODE_TEST_HOME: qaHome, XDG_CONFIG_HOME: path.join(qaHome, '.config'),
    XDG_DATA_HOME: path.join(qaHome, '.local/share'), XDG_STATE_HOME: path.join(qaHome, '.local/state'),
    XDG_CACHE_HOME: path.join(qaHome, '.cache'), TMPDIR: path.join(qaHome, 'tmp'),
    OPENCHAMBER_DATA_DIR: data, OPENCHAMBER_DIST_DIR: path.join(repository, 'packages/web/dist'),
    CLAUDE_CONFIG_DIR: claude, MERIDIAN_CLAUDE_PATH: claudeExecutable,
    MERIDIAN_CONFIG_DIR: path.join(qaHome, '.config/meridian'), MERIDIAN_SESSION_DIR: path.join(qaHome, '.cache/meridian'),
    MERIDIAN_WORKDIR: fixture.workspace, CLAUDE_PROXY_PORT: '0',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(qaHome, '.gitconfig'),
    NODE_OPTIONS: `--import=${JSON.stringify(shim)}`,
    OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
    NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1',
  };
  for (const directory of [config, data, claude, env.TMPDIR, env.XDG_CACHE_HOME, env.XDG_DATA_HOME, env.MERIDIAN_CONFIG_DIR]) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  }
  await fs.writeFile(path.join(qaHome, '.devryan-qa-home'), 'owned QA home\n', { flag: 'wx', mode: 0o600 });
  await fs.writeFile(path.join(qaHome, '.gitconfig'), '[user]\n\tname = Fixture\n\temail = fixture@example.invalid\n', { mode: 0o600 });
  await fs.cp(installedModules, path.join(config, 'node_modules'), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
  const privateModules = await fs.realpath(path.join(config, 'node_modules'));
  const checkLinks = async directory => {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) await checkLinks(file);
      else if (item.isSymbolicLink() && !(await fs.realpath(file)).startsWith(`${privateModules}${path.sep}`)) {
        throw new Error('A copied runtime dependency escapes the private installation');
      }
    }
  };
  await checkLinks(privateModules);
  for (const name of ['package.json', 'bun.lock', 'bun.lockb']) {
    try { await fs.copyFile(path.join(path.dirname(installedModules), name), path.join(config, name)); }
    catch (error) { if (error.code !== 'ENOENT' || name === 'package.json') throw error; }
  }
  const provisioning = await createUserProfileProvisioningRuntime({
    homedir: () => qaHome, configDirectory: config,
    configRoot: path.join(repository, 'packages/web/server/default-config'),
    profileRoot: path.join(repository, 'packages/web/server/default-config/user-profile'),
    runCommand: async () => ({ ok: false, exitCode: 1, stdout: '', stderr: 'Quota fixture does not install dependencies' }),
  }).provision();
  if (!provisioning.ok || provisioning.installDegraded) throw new Error('Private Claude runtime provisioning failed or requires dependency installation');
  if (arm === 'control') {
    const entry = path.join(config, 'node_modules/@rynfar/meridian/dist/cli-wxk8xvd3.js');
    let source = await fs.readFile(entry, 'utf8');
    for (const [before, after] of MERIDIAN_PREFIX_EDITS) source = source.replace(after, before);
    await fs.writeFile(entry, source);
  }
  const opencodeConfig = JSON.parse(await fs.readFile(path.join(config, 'opencode.json'), 'utf8'));
  opencodeConfig.model = `anthropic/${studyModel}`;
  opencodeConfig.enabled_providers = ['anthropic'];
  opencodeConfig.provider = { anthropic: { options: { apiKey: 'meridian-loopback-fixture' } } };
  opencodeConfig.mcp = {};
  opencodeConfig.agent = { ...opencodeConfig.agent,
    designer: { mode: 'subagent', model: `anthropic/${studyModel}`, variant: studyEffort, permission: 'allow' },
    title: { disable: true },
  };
  await fs.writeFile(path.join(config, 'opencode.json'), JSON.stringify(opencodeConfig, null, 2));
  const slimPath = path.join(config, 'oh-my-opencode-slim.json');
  const slim = JSON.parse(await fs.readFile(slimPath, 'utf8'));
  await fs.writeFile(slimPath, JSON.stringify(pinQaAgents(slim, {
    providerId: 'anthropic', modelId: studyModel, variant: studyEffort,
  }), null, 2));
  // The compiled OpenCode binary needs these wrappers before plugin imports;
  // its own paths use OPENCODE_TEST_HOME and the XDG directories above.
  for (const plugin of opencodeConfig.plugin.filter(entry => entry.startsWith('./node_modules/') && !entry.startsWith('./node_modules/context-mode/'))) {
    const entry = await fs.realpath(path.join(config, plugin));
    if (!entry.startsWith(`${privateModules}${path.sep}`)) throw new Error('Private plugin escaped its installation');
    await prepareQaPluginHomeWrapper(entry);
  }
  await fs.writeFile(path.join(env.MERIDIAN_CONFIG_DIR, 'sdk-features.json'), JSON.stringify({ opencode: {
    codeSystemPrompt: true, clientSystemPrompt: false, memory: false, dreaming: false,
  } }));
  await fs.writeFile(path.join(runtimeRoot, 'credentials.env.json'), '{}\n', { mode: 0o600 });
  await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({
    lastDirectory: fixture.workspace, projects: [{ id: 'quota', path: fixture.workspace, label: 'Quota fixture' }], activeProjectId: 'quota',
    messageStreamTransport: 'sse', showReasoningTraces: true,
  }));
  return { runtimeRoot, qaHome, config, claude, env, opencodeExecutable, provisioning };
}

export async function startClaudeQuotaRuntime(profile, { oauthToken, signal }) {
  const owned = [];
  const close = async () => {
    const failures = [];
    for (const process of [...owned].reverse()) {
      try { await process.stop(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Owned quota runtime cleanup failed');
    return owned.map(process => process.getCleanupEvidence());
  };
  const ready = async (origin, route) => {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      for (const process of owned) process.check();
      try {
        const response = await fetch(new URL(route, origin), { signal: AbortSignal.timeout(2_000) });
        if (response.ok) return;
      } catch { /* Only this owned loopback service is polled. */ }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('Owned quota runtime readiness timed out');
  };
  try {
    const opencodePort = await reservePort();
    const webPort = await reservePort();
    const meridianPort = await reservePort();
    const opencodeOrigin = `http://127.0.0.1:${opencodePort}`;
    const origin = `http://127.0.0.1:${webPort}`;
    const env = { ...profile.env, CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
      CLAUDE_PROXY_PORT: String(meridianPort),
      MERIDIAN_PROFILES: JSON.stringify([{ id: 'quota', type: 'oauth-token' }]), MERIDIAN_DEFAULT_PROFILE: 'quota' };
    owned.push(startOwnedProcess(profile.opencodeExecutable, ['serve', '--hostname', '127.0.0.1', '--port', String(opencodePort), '--log-level', profile.logLevel ?? 'WARN'], {
      cwd: profile.env.MERIDIAN_WORKDIR, env,
    }));
    await ready(opencodeOrigin, '/global/health');
    owned.push(startOwnedProcess(process.execPath, [path.join(repository, 'scripts/qa/isolated-host.mjs')], {
      cwd: repository, env: { ...env, OPENCODE_HOST: opencodeOrigin, OPENCODE_SKIP_START: 'true', OPENCHAMBER_SKIP_OPENCODE_START: 'true', OPENCHAMBER_PORT: String(webPort) },
    }));
    await ready(origin, '/api/health');
    return { origin, opencodeOrigin, meridianOrigin: `http://127.0.0.1:${meridianPort}`, close,
      logs: () => owned.map(process => process.getLog().split(oauthToken).join('[redacted]')) };
  } catch (error) {
    await close();
    throw error;
  }
}
