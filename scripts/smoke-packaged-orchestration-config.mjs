import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import crypto from 'node:crypto';

import { listDefaultConfigAssets, listRuntimePluginAssets } from '../packages/web/server/lib/opencode/default-config-assets.js';
import {
  OPENAI_TOOL_SCHEMA_SANITIZER_SPEC,
} from '../packages/web/server/lib/opencode/default-plugins.js';
import { ANTHROPIC_OAUTH_PLUGIN_SPEC } from '../packages/web/server/lib/opencode/anthropic-oauth-plugin.js';
import {
  DEVRYAN_SLIM_WRAPPER_PLUGIN_FILE,
  DEVRYAN_SLIM_WRAPPER_PLUGIN_SPEC,
  SLIM_MANAGED_VERSION,
  SLIM_PLUGIN_PACKAGE_NAME,
} from '../packages/web/server/lib/opencode/slim-config.js';
import { createUserProfileProvisioningRuntime } from '../packages/web/server/lib/opencode/user-profile-provisioning.js';
import { syncRuntimeAgentOverlays } from '../packages/web/server/lib/opencode/runtime-agent-overlays.js';

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));
const requireFile = (filePath, label) => {
  if (!fs.existsSync(filePath)) throw new Error(`Missing ${label}: ${filePath}`);
};
const hashFile = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

const managedProfileFiles = (assets) => assets.flatMap((relativePath) => {
  if (relativePath.startsWith('agents/')) return [relativePath];
  if (relativePath === 'plugins/devryan-oh-my-opencode-slim.mjs') return [relativePath];
  if (relativePath.startsWith('user-profile/')) return [relativePath.slice('user-profile/'.length)];
  return [];
}).sort();

export const smokePackagedOrchestrationConfig = async ({ configRoot }) => {
  const resolvedConfigRoot = path.resolve(configRoot);
  const profileRoot = path.join(resolvedConfigRoot, 'user-profile');
  requireFile(path.join(resolvedConfigRoot, 'opencode.json'), 'default config');
  requireFile(path.join(resolvedConfigRoot, 'agents', 'orchestrator.md'), 'required orchestration agent');
  requireFile(path.join(resolvedConfigRoot, 'plugins', 'devryan-managed-orchestration.mjs'), 'required orchestration runtime plugin');
  requireFile(path.join(resolvedConfigRoot, 'plugins', DEVRYAN_SLIM_WRAPPER_PLUGIN_FILE), 'default Slim wrapper plugin');
  requireFile(path.join(resolvedConfigRoot, 'plugins', 'openai-tool-schema-sanitizer.mjs'), 'default OpenAI tool schema sanitizer plugin');
  requireFile(path.join(profileRoot, 'opencode.json'), 'user profile config');
  requireFile(path.join(profileRoot, 'package.json'), 'user profile dependency declaration');
  requireFile(path.join(profileRoot, 'oh-my-opencode-slim.json'), 'user profile Slim configuration');

  const profileConfig = readJson(path.join(profileRoot, 'opencode.json'));
  const profilePackage = readJson(path.join(profileRoot, 'package.json'));
  if (!Array.isArray(profileConfig.plugin) || profileConfig.plugin.length === 0) {
    throw new Error('Missing user profile plugin declarations');
  }
  if (!profilePackage.dependencies || Object.keys(profilePackage.dependencies).length === 0) {
    throw new Error('Missing user profile dependency declarations');
  }
  if (!profileConfig.plugin.includes(DEVRYAN_SLIM_WRAPPER_PLUGIN_SPEC)) {
    throw new Error(`Missing default Slim registration: ${DEVRYAN_SLIM_WRAPPER_PLUGIN_SPEC}`);
  }
  if (!profileConfig.plugin.includes(ANTHROPIC_OAUTH_PLUGIN_SPEC)) {
    throw new Error(`Missing default Claude registration: ${ANTHROPIC_OAUTH_PLUGIN_SPEC}`);
  }
  if (profilePackage.dependencies[SLIM_PLUGIN_PACKAGE_NAME] !== SLIM_MANAGED_VERSION) {
    throw new Error(`Missing default Slim dependency: ${SLIM_PLUGIN_PACKAGE_NAME}@${SLIM_MANAGED_VERSION}`);
  }
  if (profilePackage.dependencies['opencode-with-claude'] !== '1.6.18') {
    throw new Error(`Missing default Claude dependency: ${ANTHROPIC_OAUTH_PLUGIN_SPEC}`);
  }

  const [assets, runtimePlugins] = await Promise.all([
    listDefaultConfigAssets(resolvedConfigRoot),
    listRuntimePluginAssets(resolvedConfigRoot),
  ]);
  if (runtimePlugins.length === 0) throw new Error('Missing canonical runtime plugin assets');
  if (!assets.some((relativePath) => relativePath.startsWith('user-profile/skills/'))) {
    throw new Error('Missing user profile skills');
  }

  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'devryan-packaged-config-smoke-'));
  try {
    const home = path.join(tempRoot, 'home');
    const configDirectory = path.join(home, '.config', 'opencode');
    const runtime = createUserProfileProvisioningRuntime({
      configRoot: resolvedConfigRoot,
      profileRoot,
      configDirectory,
      runCommand: async (_command, _args, { cwd }) => {
        for (const dependency of Object.keys(readJson(path.join(cwd, 'package.json')).dependencies || {})) {
          fs.mkdirSync(path.join(cwd, 'node_modules', ...dependency.split('/')), { recursive: true });
        }
        return { ok: true, exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const provisioned = await runtime.provision();
    if (!provisioned.ok) throw new Error(provisioned.error || 'Clean-user provisioning failed');
    requireFile(path.join(configDirectory, 'node_modules', SLIM_PLUGIN_PACKAGE_NAME), 'installed default Slim dependency');
    requireFile(path.join(configDirectory, 'node_modules', 'opencode-with-claude'), 'installed default Claude dependency');

    const expectedManagedFiles = managedProfileFiles(assets);
    const manifest = readJson(path.join(configDirectory, '.openchamber', 'user-profile-manifest.json'));
    for (const relativePath of expectedManagedFiles) {
      requireFile(path.join(configDirectory, relativePath), `provisioned managed file ${relativePath}`);
      if (!manifest.files?.[relativePath]?.hash) throw new Error(`Missing manifest record for ${relativePath}`);
    }
    if (JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(expectedManagedFiles)) {
      throw new Error('Provisioned manifest does not match canonical managed files');
    }

    const projectDirectory = path.join(tempRoot, 'project');
    await fsp.mkdir(projectDirectory, { recursive: true });
    const overlay = await syncRuntimeAgentOverlays({
      workingDirectory: projectDirectory,
      packagedAgentDirectory: path.join(resolvedConfigRoot, 'agents'),
      packagedPluginDirectory: path.join(resolvedConfigRoot, 'plugins'),
      overlayRoot: path.join(tempRoot, 'runtime-overlays'),
      manifestPath: path.join(tempRoot, 'runtime-overlays-manifest.json'),
      readAuthFile: () => ({}),
      writeAuthFile: () => {},
      readConfig: () => readJson(path.join(configDirectory, 'opencode.json')),
      listMcpConfigs: () => [],
    });
    const overlayConfig = readJson(path.join(overlay.targetConfigDirectory, 'opencode.json'));
    for (const relativePath of runtimePlugins) {
      const pluginFileName = path.basename(relativePath);
      const sourcePath = path.join(resolvedConfigRoot, relativePath);
      const targetPath = path.join(overlay.targetPluginDirectory, pluginFileName);
      requireFile(targetPath, `runtime overlay plugin ${pluginFileName}`);
      if (hashFile(sourcePath) !== hashFile(targetPath)) throw new Error(`Runtime plugin bytes differ: ${pluginFileName}`);
      if (pluginFileName === DEVRYAN_SLIM_WRAPPER_PLUGIN_FILE) {
        if (overlayConfig.plugin?.includes(DEVRYAN_SLIM_WRAPPER_PLUGIN_SPEC)) {
          throw new Error(`Source-owned Slim wrapper is registered twice: ${pluginFileName}`);
        }
      } else if (!overlayConfig.plugin?.includes(`./plugins/${pluginFileName}`)) {
        throw new Error(`Runtime plugin is not registered: ${pluginFileName}`);
      }
    }
    if (!overlayConfig.plugin?.includes(ANTHROPIC_OAUTH_PLUGIN_SPEC)) {
      throw new Error(`Default Claude plugin is not registered: ${ANTHROPIC_OAUTH_PLUGIN_SPEC}`);
    }
    if (!overlayConfig.plugin?.includes(OPENAI_TOOL_SCHEMA_SANITIZER_SPEC)) {
      throw new Error(`Default OpenAI tool schema sanitizer is not registered: ${OPENAI_TOOL_SCHEMA_SANITIZER_SPEC}`);
    }

    const secondProvision = await runtime.provision();
    if (secondProvision.changed || !secondProvision.ok) throw new Error('Clean-user provisioning is not idempotent');
    return { ok: true, assets, runtimePlugins, managedFiles: expectedManagedFiles };
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
};

const readArg = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
};

const isCli = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isCli) {
  const configRoot = readArg('--config-root');
  if (!configRoot) {
    console.error('Usage: node scripts/smoke-packaged-orchestration-config.mjs --config-root <default-config>');
    process.exitCode = 2;
  } else {
    try {
      const result = await smokePackagedOrchestrationConfig({ configRoot });
      console.log(`Packaged orchestration config smoke passed (${result.runtimePlugins.length} runtime plugins).`);
    } catch (error) {
      console.error(`Packaged orchestration config smoke failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
