import { expect, test } from 'vitest';
import { isReviewedPreviousClaudeAsset, REVIEWED_PREVIOUS_CLAUDE_ASSET, verifyNativeRuntimeArtifacts } from './native-artifacts.js';
import { REVIEWED_CLAUDE_ASSETS } from './reviewed-claude-transform.js';

test('the previous reviewed Claude identity is source/rollback only and never a default or new target pin', async () => {
  const previous = { role: 'asset', ...REVIEWED_PREVIOUS_CLAUDE_ASSET };
  expect(previous.version).toBe('2.1.251'); expect(REVIEWED_CLAUDE_ASSETS.claude.version).toBe('2.1.280');
  expect(previous.sha256).not.toBe(REVIEWED_CLAUDE_ASSETS.claude.sha256);
  for (const purpose of ['bundle-source', 'bundle-rollback']) expect(isReviewedPreviousClaudeAsset(previous, purpose, 'darwin', 'arm64')).toBe(true);
  for (const purpose of [undefined, 'current', 'target', 'unknown']) expect(isReviewedPreviousClaudeAsset(previous, purpose, 'darwin', 'arm64')).toBe(false);
  for (const change of [{ role: 'controller' }, { path: '../DevRyan-Claude-darwin-arm64' }, { sha256: 'a'.repeat(64) }, { size: previous.size + 1 }, { mode: 0o777 }, { version: '2.1.280' }])
    expect(isReviewedPreviousClaudeAsset({ ...previous, ...change }, 'bundle-source', 'darwin', 'arm64')).toBe(false);
  expect(isReviewedPreviousClaudeAsset(previous, 'bundle-source', 'win32', 'arm64')).toBe(false);
  expect(isReviewedPreviousClaudeAsset(previous, 'bundle-source', 'darwin', 'x64')).toBe(false);
  await expect(verifyNativeRuntimeArtifacts({ purpose: 'unknown' })).rejects.toMatchObject({ code: 'native_runtime_artifacts_unverified' });
});

// These fixtures never launch a controller or read installed application state.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fixture = async operation => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-artifact-diagnostics-')));
  const row = { path: 'DevRyan-test', role: 'asset', size: 4, mode: 0o600, sha256: digest('test'), signing: { mode: 'unsigned' } };
  const manifest = { schema: 1, buildId: 'a'.repeat(64), opencodeVersion: '2.0.26', bunVersion: '1.3.14', target: `bun-${process.platform}-${process.arch}`,
    inputs: { coreDigest: 'a'.repeat(64), lockSha256: 'a'.repeat(64), reviewedPlugins: [], nativeRegistrations: [{ id: 'test', manifestDigest: 'a'.repeat(64), capabilities: [] }] },
    files: [row, { ...row, path: 'DevRyan-second' }] };
  const manifestPath = path.join(root, 'native-bundle.json');
  const verify = async (bytes = JSON.stringify(manifest), expected = digest(bytes)) => {
    await fs.writeFile(manifestPath, bytes);
    return verifyNativeRuntimeArtifacts({ manifestPath, manifestSha256: expected, launcher: path.join(root, 'DevRyan-execution-test') });
  };
  try { await operation({ root, row, manifest, manifestPath, verify }); } finally { await fs.rm(root, { recursive: true, force: true }); }
};

test('manifest failures preserve their exact sanitized category', async () => fixture(async ({ root, manifestPath, manifest, verify }) => {
  await expect(verifyNativeRuntimeArtifacts({ manifestPath, manifestSha256: 'a'.repeat(64), launcher: path.join(root, 'DevRyan-launcher') }))
    .rejects.toMatchObject({ code: 'native_runtime_artifacts_unverified', diagnostic: { reason: 'manifest_missing', stage: 'manifest' } });
  await expect(verify('{')).rejects.toMatchObject({ diagnostic: { reason: 'manifest_invalid' } });
  await expect(verify(JSON.stringify(manifest), 'b'.repeat(64))).rejects.toMatchObject({ diagnostic: { reason: 'digest_mismatch' } });
  manifest.target = 'bun-other-platform';
  await expect(verify()).rejects.toMatchObject({ diagnostic: { reason: 'unsupported_platform' } });
}));

test('missing, truncated, changed and linked payloads are rejected before execution', async () => fixture(async ({ root, row, verify }) => {
  const file = path.join(root, row.path);
  await expect(verify()).rejects.toMatchObject({ diagnostic: { reason: 'payload_missing', artifact: row.path } });
  await fs.writeFile(file, 'bad', { mode: row.mode });
  await expect(verify()).rejects.toMatchObject({ diagnostic: { reason: 'digest_mismatch' } });
  await fs.writeFile(file, 'evil');
  await expect(verify()).rejects.toMatchObject({ diagnostic: { reason: 'digest_mismatch' } });
  await fs.writeFile(file, 'test');
  if (process.platform !== 'win32') {
    await fs.chmod(file, 0o700);
    await expect(verify()).rejects.toMatchObject({ diagnostic: { reason: 'mode_mismatch' } });
    await fs.rename(file, file + '-target'); await fs.symlink(file + '-target', file);
    await expect(verify()).rejects.toMatchObject({ diagnostic: { reason: 'payload_invalid' } });
  }
}));

test('unreviewed vendor assets cannot be admitted by recomputing the outer manifest', async () => fixture(async ({ root, row, verify }) => {
  row.path = 'DevRyan-Claude-credentials.mjs'; row.mode = 0o644;
  await fs.writeFile(path.join(root, row.path), 'test', { mode: row.mode });
  await expect(verify()).rejects.toMatchObject({ diagnostic: { stage: 'reviewed_asset', reason: 'reviewed_asset_mismatch', artifact: row.path } });
}));

test.skipIf(process.platform !== 'darwin')('unsigned controller failures are distinguished from manifest failures on macOS', async () => {
  await fixture(async ({ root, row, verify }) => {
    row.path = 'DevRyan-native-controller'; row.role = 'controller'; row.mode = 0o755;
    await fs.writeFile(path.join(root, row.path), 'test', { mode: row.mode });
    await expect(verify()).rejects.toMatchObject({ diagnostic: { stage: 'signature', reason: 'signature_failure', artifact: row.path } });
  });
});
