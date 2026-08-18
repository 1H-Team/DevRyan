import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { smokePackagedOrchestrationConfig } from './smoke-packaged-orchestration-config.mjs';

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
  ['Slim dependency', async (root) => {
    const packagePath = path.join(root, 'user-profile', 'package.json');
    const profilePackage = JSON.parse(await fs.readFile(packagePath, 'utf8'));
    delete profilePackage.dependencies['oh-my-opencode-slim'];
    await fs.writeFile(packagePath, `${JSON.stringify(profilePackage, null, 2)}\n`);
  }, /Missing default Slim dependency/],
  ['Claude dependency', async (root) => {
    const packagePath = path.join(root, 'user-profile', 'package.json');
    const profilePackage = JSON.parse(await fs.readFile(packagePath, 'utf8'));
    delete profilePackage.dependencies['opencode-with-claude'];
    await fs.writeFile(packagePath, `${JSON.stringify(profilePackage, null, 2)}\n`);
  }, /Missing default Claude dependency/],
  ['Slim wrapper', (root) => fs.rm(path.join(root, 'plugins', 'devryan-oh-my-opencode-slim.mjs')), /Missing default Slim wrapper plugin/],
  ['document reader plugin', (root) => fs.rm(path.join(root, 'plugins', 'devryan-document-reader.mjs')), /Missing default document reader plugin/],
  ['document dependency', async (root) => {
    const packagePath = path.join(root, 'user-profile', 'package.json');
    const profilePackage = JSON.parse(await fs.readFile(packagePath, 'utf8'));
    delete profilePackage.dependencies.unpdf;
    await fs.writeFile(packagePath, `${JSON.stringify(profilePackage, null, 2)}\n`);
  }, /Missing default document dependency/],
  ['sanitizer plugin', (root) => fs.rm(path.join(root, 'plugins', 'openai-tool-schema-sanitizer.mjs')), /Missing default OpenAI tool schema sanitizer plugin/],
]) {
  test(`reports an explicit missing ${name} failure without modifying repository defaults`, async () => {
    await assert.rejects(() => withConfig(mutate), message);
  });
}
