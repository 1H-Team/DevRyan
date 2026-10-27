import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { DEFAULT_RG, RG_SHA256, repositoryRoot, verifyNativeAcceptanceArtifacts, captureNativeAcceptanceSource } from './artifacts.mjs';

test('native qualification pins actual Cursor producers and paid QA exercise inputs alongside its verifier', async () => {
  const proof = await captureNativeAcceptanceSource();
  for (const file of ['packages/cursor-sdk-runtime/index.js', 'packages/cursor-sdk-runtime/node-worker.mjs',
    'packages/cursor-sdk-runtime/persistent-worker.mjs', 'scripts/verify-opencode-v2-package.mjs',
    'scripts/qa/live-provider-handoff.mjs', 'scripts/qa/profile-project-fixture.mjs',
    'scripts/qa/qa1-profile-exercise.mjs', 'scripts/qa/ui-driver.mjs', 'scripts/qa/process.mjs',
    'scripts/perf/receipt-ui-settlement.mjs', 'scripts/perf/electron-interactive-benchmark.mjs',
    'scripts/perf/electron-lifecycle-benchmark.mjs', 'scripts/perf/fixture-session-seeds.mjs',
    'scripts/agent-evals/client.mjs', 'scripts/agent-evals/cases.mjs', 'scripts/agent-evals/graders.mjs',
    'scripts/journal.mjs', 'packages/web/server/lib/git/routes.js', 'packages/web/server/lib/git/zen-text.js',
    'packages/web/server/default-config/agents/explorer.md',
    'packages/web/server/default-config/user-profile/devryan-agents.jsonc',
    'patches/@modelcontextprotocol%2Fclient@2.3.1.patch']) {
    assert.match(proof.sources[file] ?? '', /^[a-f0-9]{64}$/, `Missing qualification source: ${file}`);
  }
});

test('native qualification refuses unsupported hosts or uses the locked shipped ripgrep', async () => {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') {
      await assert.rejects(verifyNativeAcceptanceArtifacts(), /Captured native acceptance requires qualified (Darwin|arm64)/);
      return;
    }
    const canonical = await fs.realpath(DEFAULT_RG);
    assert.ok(canonical.startsWith(path.join(repositoryRoot, 'node_modules') + path.sep));
    const manifest = JSON.parse(await fs.readFile(path.join(path.dirname(DEFAULT_RG), '../package.json'), 'utf8'));
    const owner = JSON.parse(await fs.readFile(path.join(repositoryRoot, 'packages/cursor-sdk-runtime/package.json'), 'utf8'));
    assert.equal(manifest.name, '@cursor/sdk-darwin-arm64');
    assert.equal(manifest.version, owner.dependencies['@cursor/sdk']);
    assert.equal(createHash('sha256').update(await fs.readFile(canonical)).digest('hex'), RG_SHA256);
    assert.ok((await fs.stat(canonical)).mode & 0o111);
  });
