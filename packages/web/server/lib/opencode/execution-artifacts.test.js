import { test, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { executionArtifactDirectory, executionArtifacts, executionEnvironment } from './execution-artifacts.js';

test('packaged Electron uses resources when its development flag is explicitly disabled', () => {
  const resourcesPath = path.resolve('/fixture/DevRyan.app/Contents/Resources');
  for (const developmentMode of ['0', 'false', '']) {
    expect(executionArtifactDirectory({ resourcesPath, developmentMode }))
      .toBe(path.join(resourcesPath, 'revert-runtime', `${process.platform}-${process.arch}`));
  }
  expect(executionArtifactDirectory({ resourcesPath, developmentMode: '1' }))
    .not.toContain(resourcesPath);
});

test('capture requires the exact shipped companion contract and accepted native artifacts', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'execution-artifacts-'));
  const { launcher, opencode } = executionArtifacts(directory);
  const contract = JSON.parse(await fs.readFile(new URL('./companion/manifest.json', import.meta.url)));
  const sha256 = createHash('sha256').update('fixture').digest('hex');
  const native = { version: 1, policy: 2, acceptance: true, platform: process.platform, arch: process.arch,
    binary: path.basename(launcher), sha256, spawnLibrary: path.basename(launcher) + '-spawn.dylib', spawnSha256: sha256 };
  const companion = { ...contract.capability, acceptance: true, platform: process.platform, arch: process.arch,
    binary: path.basename(opencode), baseCommit: contract.baseCommit, patchSha256: contract.patchSha256, sha256 };
  const environment = () => executionEnvironment({ directory, pluginDirectory: directory, dataDirectory: directory });
  try {
    for (const file of [launcher, opencode, launcher + '-spawn.dylib', ...['devryan-managed-orchestration.mjs', 'council-session.js'].map((name) => path.join(directory, name))]) {
      await fs.writeFile(file, 'fixture');
    }
    await fs.writeFile(launcher + '.json', JSON.stringify(native));
    await fs.writeFile(path.join(directory, 'companion.json'), JSON.stringify(companion));
    expect((await environment()).DEVRYAN_EXECUTION_BOUNDARY).toBe('1');
    await fs.writeFile(path.join(directory, 'companion.json'), JSON.stringify({ ...companion, patchSha256: 'older-patch' }));
    expect(await environment()).toEqual({});
    await fs.writeFile(path.join(directory, 'companion.json'), JSON.stringify({ ...companion, baseCommit: 'different-source' }));
    expect(await environment()).toEqual({});
    await fs.writeFile(path.join(directory, 'companion.json'), JSON.stringify(companion));
    await fs.writeFile(launcher + '.json', JSON.stringify({ ...native, acceptance: false }));
    expect(await environment()).toEqual({});
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
