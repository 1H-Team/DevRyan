import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { DEFAULT_RG, RG_SHA256, repositoryRoot, verifyNativeAcceptanceArtifacts } from './artifacts.mjs';

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
