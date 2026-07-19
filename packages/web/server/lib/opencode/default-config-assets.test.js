import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  isAllowedDefaultConfigRelativePath,
  isProhibitedDefaultConfigRelativePath,
  isRuntimePluginFileName,
  listDefaultConfigAssets,
  listRuntimePluginAssets,
} from './default-config-assets.js';

describe('default config asset policy', () => {
  const roots = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it('allows only the canonical runtime roots and runtime plugin extensions', () => {
    expect(isAllowedDefaultConfigRelativePath('opencode.json')).toBe(true);
    expect(isAllowedDefaultConfigRelativePath('agents/orchestrator.md')).toBe(true);
    expect(isAllowedDefaultConfigRelativePath('user-profile/skills/example/SKILL.md')).toBe(true);
    expect(isAllowedDefaultConfigRelativePath('plugins/runtime.mjs')).toBe(true);
    expect(isAllowedDefaultConfigRelativePath('plugins/runtime.test.mjs')).toBe(false);
    expect(isAllowedDefaultConfigRelativePath('README.md')).toBe(false);
    expect(isRuntimePluginFileName('plugin.cjs')).toBe(true);
    expect(isRuntimePluginFileName('plugin.d.ts')).toBe(false);
  });

  it('excludes generated, credential, cache, lockfile, and test artifacts', () => {
    for (const relativePath of [
      'plugins/.DS_Store', 'plugins/plugin.spec.mjs', 'plugins/plugin.d.ts',
      'user-profile/node_modules/x/index.js', 'user-profile/auth/token.json',
      'user-profile/auth.json', 'user-profile/credentials.json',
      'user-profile/cache/value.json', 'user-profile/package-lock.json',
      'user-profile/.openchamber/user-profile-manifest.json',
    ]) {
      expect(isProhibitedDefaultConfigRelativePath(relativePath)).toBe(true);
    }
  });

  it('returns a deterministic canonical asset and runtime plugin inventory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-default-assets-'));
    roots.push(root);
    await fs.mkdir(path.join(root, 'agents'), { recursive: true });
    await fs.mkdir(path.join(root, 'plugins'), { recursive: true });
    await fs.mkdir(path.join(root, 'user-profile', 'skills', 'example'), { recursive: true });
    await fs.mkdir(path.join(root, 'user-profile', 'secrets'), { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(root, 'opencode.json'), '{}\n'),
      fs.writeFile(path.join(root, 'agents', 'builder.md'), 'builder\n'),
      fs.writeFile(path.join(root, 'plugins', 'runtime.mjs'), 'export {};\n'),
      fs.writeFile(path.join(root, 'plugins', 'runtime.test.mjs'), 'export {};\n'),
      fs.writeFile(path.join(root, 'user-profile', 'skills', 'example', 'SKILL.md'), 'skill\n'),
      fs.writeFile(path.join(root, 'user-profile', 'secrets', 'token'), 'nope\n'),
    ]);

    await expect(listDefaultConfigAssets(root)).resolves.toEqual([
      'agents/builder.md', 'opencode.json', 'plugins/runtime.mjs', 'user-profile/skills/example/SKILL.md',
    ]);
    await expect(listRuntimePluginAssets(root)).resolves.toEqual(['plugins/runtime.mjs']);
  });
});
