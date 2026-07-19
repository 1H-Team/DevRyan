import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { isAllowedDefaultConfigRelativePath } from '../packages/web/server/lib/opencode/default-config-assets.js';
import { formatArtifactDiagnostics, verifyDefaultConfigArtifact } from './verify-default-config-artifact.mjs';

const sourceRoot = path.resolve('packages/web/server/default-config');

const withArtifact = async (run) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-default-config-artifact-'));
  const artifactRoot = path.join(root, 'default-config');
  await fs.cp(sourceRoot, artifactRoot, {
    recursive: true,
    filter: async (source) => {
      const relativePath = path.relative(sourceRoot, source);
      return !relativePath || isAllowedDefaultConfigRelativePath(relativePath, {
        directory: (await fs.stat(source)).isDirectory(),
      });
    },
  });
  try {
    await run(artifactRoot);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
};

test('verifies a complete canonical default-config artifact', async () => {
  await withArtifact(async (artifactRoot) => {
    assert.deepEqual(await verifyDefaultConfigArtifact({ source: sourceRoot, artifactRoot }), {
      ok: true,
      missing: [],
      altered: [],
      prohibited: [],
    });
  });
});

test('aggregates missing, altered, and prohibited managed runtime diagnostics', async () => {
  await withArtifact(async (artifactRoot) => {
    await fs.rm(path.join(artifactRoot, 'agents', 'builder.md'));
    await fs.writeFile(path.join(artifactRoot, 'plugins', 'council-session.js'), 'altered\n');
    await fs.mkdir(path.join(artifactRoot, 'user-profile', 'cache'), { recursive: true });
    await fs.writeFile(path.join(artifactRoot, 'user-profile', 'cache', 'state.json'), '{}\n');
    await fs.writeFile(path.join(artifactRoot, 'README.md'), 'unrelated metadata\n');

    const result = await verifyDefaultConfigArtifact({ source: sourceRoot, artifactRoot });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['agents/builder.md']);
    assert.deepEqual(result.altered, ['plugins/council-session.js']);
    assert.deepEqual(result.prohibited, ['user-profile/cache/state.json']);
    assert.match(formatArtifactDiagnostics(result), /missing:\n- agents\/builder.md/);
    assert.match(formatArtifactDiagnostics(result), /altered:\n- plugins\/council-session.js/);
    assert.match(formatArtifactDiagnostics(result), /prohibited:\n- user-profile\/cache\/state.json/);
  });
});
