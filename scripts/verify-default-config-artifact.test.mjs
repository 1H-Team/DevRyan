import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { isAllowedDefaultConfigRelativePath } from '../packages/web/server/lib/opencode/default-config-assets.js';
import { formatArtifactDiagnostics, verifyDefaultConfigArtifact } from './verify-default-config-artifact.mjs';

const sourceRoot = path.resolve('packages/web/server/default-config');
const tauriRoot = path.resolve('packages/desktop/src-tauri/resources/default-config');

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

test('keeps Tauri agent and Council assets aligned with the canonical defaults', async () => {
  const agentPaths = [
    'agents/council.md',
    'agents/explorer.md',
    'agents/fixer.md',
    'agents/orchestrator.md',
  ];

  for (const relativePath of agentPaths) {
    const [canonical, tauri] = await Promise.all([
      fs.readFile(path.join(sourceRoot, relativePath), 'utf8'),
      fs.readFile(path.join(tauriRoot, relativePath), 'utf8'),
    ]);
    assert.doesNotMatch(canonical, /^modelRefs:|^councillors:/m);
    assert.doesNotMatch(tauri, /^modelRefs:|^councillors:/m);
    assert.equal(tauri.match(/^model:\s*(.+)$/m)?.[1], canonical.match(/^model:\s*(.+)$/m)?.[1]);
    assert.equal(tauri.match(/^variant:\s*(.+)$/m)?.[1], canonical.match(/^variant:\s*(.+)$/m)?.[1]);
  }

  for (const relativePath of ['agents/council.models.json', 'plugins/council-session.js']) {
    const [canonical, tauri] = await Promise.all([
      fs.readFile(path.join(sourceRoot, relativePath), 'utf8'),
      fs.readFile(path.join(tauriRoot, relativePath), 'utf8'),
    ]);
    assert.equal(tauri, canonical, `${relativePath} must match the canonical web asset`);
  }

  const councilCompanion = JSON.parse(
    await fs.readFile(path.join(sourceRoot, 'agents', 'council.models.json'), 'utf8'),
  );
  assert.equal(councilCompanion.version, 1);
  assert.ok(Array.isArray(councilCompanion.councillors));

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
