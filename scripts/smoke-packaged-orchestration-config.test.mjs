import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { smokePackagedOrchestrationConfig } from './smoke-packaged-orchestration-config.mjs';
const compatibilityPluginPin = JSON.parse(await fs.readFile(new URL('../packages/web/package.json', import.meta.url), 'utf8')).devDependencies['@opencode-ai/plugin'];

const sourceRoot = path.resolve('packages/web/server/default-config');

const withConfig = async (mutate, run = smokePackagedOrchestrationConfig) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-packaged-config-test-'));
  const configRoot = path.join(root, 'default-config');
  await fs.cp(sourceRoot, configRoot, { recursive: true });
  try {
    await mutate(configRoot);
    return await run({ configRoot });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
};

test('smokes clean-user provisioning and runtime overlays from an artifact config root', async () => {
  const result = await withConfig(async () => {});
  assert.equal(result.ok, true);
  assert.ok(result.managedFiles.includes('agents/orchestrator.md'));
  assert.ok(result.runtimePlugins.includes('plugins/devryan-managed-orchestration.mjs'));
  assert.ok(result.runtimePlugins.includes('plugins/openai-tool-schema-sanitizer.mjs'));
  assert.ok(result.runtimePlugins.includes('plugins/devryan-document-reader.mjs'));
});

test('rejects packaged user profile skills', async () => {
  await assert.rejects(() => withConfig(async (root) => {
    const skillPath = path.join(root, 'user-profile', 'skills', 'unexpected', 'SKILL.md');
    await fs.mkdir(path.dirname(skillPath), { recursive: true });
    await fs.writeFile(skillPath, '---\nname: unexpected\n---\nUnexpected skill.\n');
  }), /Packaged config must not include user profile skills/);
});

for (const [name, mutate, message] of [
  ['agent', (root) => fs.rm(path.join(root, 'agents', 'orchestrator.md')), /Missing required orchestration agent/],
  ['plugin', (root) => fs.rm(path.join(root, 'plugins', 'devryan-managed-orchestration.mjs')), /Missing required orchestration runtime plugin/],
  ['profile', (root) => fs.rm(path.join(root, 'user-profile', 'opencode.json')), /Missing user profile config/],
  ['dependency', async (root) => fs.writeFile(path.join(root, 'user-profile', 'package.json'), '{"dependencies":{}}\n'), /Missing user profile dependency declarations/],
  ['retired Slim dependency', async (root) => {
    const packagePath = path.join(root, 'user-profile', 'package.json');
    const profilePackage = JSON.parse(await fs.readFile(packagePath, 'utf8'));
    profilePackage.dependencies['oh-my-opencode-slim'] = '2.2.25';
    await fs.writeFile(packagePath, `${JSON.stringify(profilePackage, null, 2)}\n`);
  }, /installs the retired Slim package/],
  ['retired Slim registration', async (root) => {
    const configPath = path.join(root, 'user-profile', 'opencode.json');
    const profileConfig = JSON.parse(await fs.readFile(configPath, 'utf8'));
    profileConfig.plugin.push('./plugins/devryan-oh-my-opencode-slim.mjs');
    await fs.writeFile(configPath, `${JSON.stringify(profileConfig, null, 2)}\n`);
  }, /registers a retired plugin/],
  // Claude runs through OpenCode's built-in claude-agent provider; the Meridian proxy must not return.
  ...['opencode-with-claude', '@rynfar/meridian'].map((retired) => [`retired Claude proxy package ${retired}`, async (root) => {
    const packagePath = path.join(root, 'user-profile', 'package.json');
    const profilePackage = JSON.parse(await fs.readFile(packagePath, 'utf8'));
    profilePackage.dependencies[retired] = '1.11.2';
    await fs.writeFile(packagePath, `${JSON.stringify(profilePackage, null, 2)}\n`);
  }, new RegExp(`installs the retired Claude proxy package ${retired.replace('/', '\\/')}$`)]),
  // A pinned retired spec is caught by the retired-plugin list; any other version or path by name.
  ...[['opencode-with-claude@1.11.2', /registers a retired plugin/], ['opencode-with-claude@9.9.9', /registers the retired Claude proxy plugin/],
    ['./node_modules/opencode-with-claude/dist/server.js', /registers the retired Claude proxy plugin/]].map(([spec, message]) => [`retired Claude proxy registration ${spec}`, async (root) => {
    const configPath = path.join(root, 'user-profile', 'opencode.json');
    const profileConfig = JSON.parse(await fs.readFile(configPath, 'utf8'));
    profileConfig.plugin.push(spec);
    await fs.writeFile(configPath, `${JSON.stringify(profileConfig, null, 2)}\n`);
  }, message]),
  ['retired Slim adapter', (root) => fs.writeFile(path.join(root, 'plugins', 'devryan-oh-my-opencode-slim.mjs'), 'export default async () => ({});\n'), /Retired Slim adapter must not ship/],
  ['document reader plugin', (root) => fs.rm(path.join(root, 'plugins', 'devryan-document-reader.mjs')), /Missing default document reader plugin/],
  ['document dependency', async (root) => {
    const packagePath = path.join(root, 'user-profile', 'package.json');
    const profilePackage = JSON.parse(await fs.readFile(packagePath, 'utf8'));
    delete profilePackage.dependencies.unpdf;
    await fs.writeFile(packagePath, `${JSON.stringify(profilePackage, null, 2)}\n`);
  }, /Missing default document dependency/],
  ['sanitizer plugin', (root) => fs.rm(path.join(root, 'plugins', 'openai-tool-schema-sanitizer.mjs')), /Missing default OpenAI tool schema sanitizer plugin/],
  // The packaged pure-tool SDK pin follows its manifest dependency, independently of the native runtime pin.
  ['plugin SDK pin', async (root) => {
    const packagePath = path.join(root, 'user-profile', 'package.json');
    const profilePackage = JSON.parse(await fs.readFile(packagePath, 'utf8'));
    profilePackage.dependencies['@opencode-ai/plugin'] = '0.0.0';
    await fs.writeFile(packagePath, `${JSON.stringify(profilePackage, null, 2)}\n`);
  }, new RegExp(`Missing default document dependency: @opencode-ai/plugin@${compatibilityPluginPin.replaceAll('.', '\\.')}`)],
]) {
  test(`reports an explicit missing ${name} failure without modifying repository defaults`, async () => {
    await assert.rejects(() => withConfig(mutate), message);
  });
}
