import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { createClaudeCandidate, preserveManagedClaude } from './managed-claude-candidate.js';
import { CLAUDE_ASSET, CLAUDE_PACKAGE, CLAUDE_TEAM, claudeArchiveURL, sha256 } from './managed-claude-installation.js';
import { REVIEWED_CLAUDE_ASSETS } from './reviewed-claude-transform.js';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const verifyArtifacts = async ({ manifestPath, manifestSha256 }) => {
  const bytes = await fs.readFile(manifestPath); expect(sha256(bytes)).toBe(manifestSha256);
  const manifest = JSON.parse(bytes), directory = path.dirname(manifestPath);
  for (const row of manifest.files) expect(sha256(await fs.readFile(path.join(directory, row.path)))).toBe(row.sha256);
  return { manifest, directory, manifestPath, manifestSha256, controller: path.join(directory, 'DevRyan-controller'), writer: path.join(directory, 'DevRyan-writer') };
};
async function fixture(core = 'original') {
  const controlRoot = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'claude-candidate-')); roots.push(controlRoot);
  const directory = path.join(controlRoot, 'source'); await fs.mkdir(directory);
  const files = [];
  for (const name of ['DevRyan-controller', 'DevRyan-writer', CLAUDE_ASSET]) {
    const bytes = Buffer.from(name + '-' + core); await fs.writeFile(path.join(directory, name), bytes, { mode: 0o755 });
    files.push({ path: name, role: name === CLAUDE_ASSET ? 'asset' : name === 'DevRyan-controller' ? 'controller' : 'writer', size: bytes.length, mode: 0o755, sha256: sha256(bytes), signing: { mode: 'unsigned' } });
  }
  const bytes = JSON.stringify({ schema: 1, files, inputs: { reviewedPlugins: [] } }), manifestPath = path.join(directory, 'native-bundle.json');
  await fs.writeFile(manifestPath, bytes);
  const source = await verifyArtifacts({ manifestPath, manifestSha256: sha256(bytes) });
  return { controlRoot, source };
}
async function download({ directory, version }) {
  const bytes = Buffer.from('new-Claude-' + version + '-'.repeat(48)); await fs.writeFile(path.join(directory, CLAUDE_ASSET), bytes, { mode: 0o755 });
  return { schema: 1, package: CLAUDE_PACKAGE, version, platform: 'darwin-arm64', archiveUrl: claudeArchiveURL(version),
    archiveIntegrity: 'sha512-' + 'a'.repeat(86) + '==', sha256: sha256(bytes), size: bytes.length,
    signatureTeamID: CLAUDE_TEAM, cdhash: 'c'.repeat(40) };
}
test('candidate changes only Claude, retains a complete inventory and removes interrupted staging', async () => {
  const f = await fixture();
  await fs.mkdir(path.join(f.controlRoot, 'claude-staging', 'candidate-abandoned'), { recursive: true });
  await fs.writeFile(path.join(f.controlRoot, 'claude-staging', 'candidate-abandoned', 'partial'), 'partial');
  const result = await createClaudeCandidate({ ...f, version: '9.0.0', download, verifyArtifacts });
  expect(result.artifacts.manifest.claudeInstallation.version).toBe('9.0.0');
  expect(result.artifacts.manifest.claudeBaseManifestSha256).toBe(f.source.manifestSha256);
  expect(result.artifacts.manifest.files.slice(0, 2)).toEqual(f.source.manifest.files.slice(0, 2));
  expect(await fs.readdir(path.join(f.controlRoot, 'claude-staging'))).toEqual([]);
  expect((await fs.readFile(path.join(f.source.directory, CLAUDE_ASSET))).toString()).toContain('-original');
});
test('failed staging leaves the source exact and cleans its scratch', async () => {
  const f = await fixture();
  await expect(createClaudeCandidate({ ...f, version: '9.0.0', verifyArtifacts, download: async ({ directory }) => {
    await fs.writeFile(path.join(directory, 'partial'), 'partial'); throw new Error('download failed');
  } })).rejects.toThrow('download failed');
  expect(await fs.readdir(path.join(f.controlRoot, 'claude-staging'))).toEqual([]);
  expect(sha256(await fs.readFile(f.source.manifestPath))).toBe(f.source.manifestSha256);
});
test('same app cold startup preserves the selected future Claude without producing another candidate', async () => {
  const f = await fixture(), selected = await createClaudeCandidate({ ...f, version: '9.0.0', download, verifyArtifacts });
  // Read-only identity comparison; the production verifier checked these shipped bytes first.
  const shipped = structuredClone(f.source);
  shipped.manifest.files.find(row => row.path === CLAUDE_ASSET).sha256 = REVIEWED_CLAUDE_ASSETS.claude.sha256;
  const result = await preserveManagedClaude({ controlRoot: f.controlRoot, source: selected.artifacts,
    candidate: { artifacts: shipped, manifestSha256: f.source.manifestSha256, manifestPath: f.source.manifestPath }, verifyArtifacts });
  expect(result.manifestSha256).toBe(selected.manifestSha256);
});
test('app upgrade carries the selected Claude into the new core inventory', async () => {
  const f = await fixture(), selected = await createClaudeCandidate({ ...f, version: '9.0.0', download, verifyArtifacts });
  const next = await fixture('upgraded-core');
  const candidate = await createClaudeCandidate({ ...next, version: '8.0.0', download, verifyArtifacts });
  const result = await preserveManagedClaude({ controlRoot: f.controlRoot, source: selected.artifacts, candidate, verifyArtifacts });
  expect(result.artifacts.manifest.claudeInstallation.version).toBe('9.0.0');
  expect(result.artifacts.manifest.files.slice(0, 2)).toEqual(candidate.artifacts.manifest.files.slice(0, 2));
});
