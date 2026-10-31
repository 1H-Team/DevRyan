import { expect, test } from 'vitest';
import { isAcceptedBundleBunVersion, NATIVE_BUNDLE_BUN_VERSION, verifyNativeRuntimeArtifacts, verifyUpdateCandidateArtifacts } from './native-artifacts.js';

test('an unknown verification purpose is refused', async () => {
  await expect(verifyNativeRuntimeArtifacts({ purpose: 'unknown' })).rejects.toMatchObject({ code: 'native_runtime_artifacts_unverified' });
});

test('installed bundles built by the previous Bun are source/rollback only, never the current bundle', () => {
  expect(NATIVE_BUNDLE_BUN_VERSION).toBe('1.4.4');
  for (const purpose of ['current', 'bundle-source', 'bundle-rollback']) expect(isAcceptedBundleBunVersion('1.4.4', purpose)).toBe(true);
  for (const previous of ['1.3.14', '1.4.3']) {
    for (const purpose of ['bundle-source', 'bundle-rollback']) expect(isAcceptedBundleBunVersion(previous, purpose)).toBe(true);
    for (const purpose of [undefined, 'current', 'target']) expect(isAcceptedBundleBunVersion(previous, purpose)).toBe(false);
  }
  for (const version of [undefined, '', '1.3.13', '1.4.2', '1.4.4 ', '1.4.5']) expect(isAcceptedBundleBunVersion(version, 'bundle-source')).toBe(false);
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
  const manifest = { schema: 1, buildId: 'a'.repeat(64), opencodeVersion: '2.0.26', bunVersion: '1.4.4', target: `bun-${process.platform}-${process.arch}`,
    inputs: { coreDigest: 'a'.repeat(64), lockSha256: 'a'.repeat(64), reviewedPlugins: [], nativeRegistrations: [{ id: 'test', manifestDigest: 'a'.repeat(64), capabilities: [] }] },
    files: [row, { ...row, path: 'DevRyan-second' }] };
  const manifestPath = path.join(root, 'native-bundle.json');
  const verifyWith = verifier => async (bytes = JSON.stringify(manifest), expected = digest(bytes)) => {
    await fs.writeFile(manifestPath, bytes);
    return verifier({ manifestPath, manifestSha256: expected, launcher: path.join(root, 'DevRyan-execution-test') });
  };
  const verify = verifyWith(verifyNativeRuntimeArtifacts), verifyCandidate = verifyWith(verifyUpdateCandidateArtifacts);
  try { await operation({ root, row, manifest, manifestPath, verify, verifyCandidate }); } finally { await fs.rm(root, { recursive: true, force: true }); }
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

// The pinned AST payload is the reviewed vendor asset these fixtures exercise.
const AST_ASSET = 'DevRyan-ast-grep-darwin-arm64';

test.skipIf(process.platform === 'win32')('unreviewed vendor assets cannot be admitted by recomputing the outer manifest', async () => fixture(async ({ root, row, verify }) => {
  row.path = AST_ASSET; row.mode = 0o755;
  await fs.writeFile(path.join(root, row.path), 'test', { mode: row.mode });
  await expect(verify()).rejects.toMatchObject({ diagnostic: { stage: 'reviewed_asset', reason: 'reviewed_asset_mismatch', artifact: row.path } });
}));

test('Claude, libsql and credential assets listed by a pre-claude-agent bundle are only checked against the manifest', async () => fixture(async ({ root, row, manifest, verify }) => {
  row.path = 'DevRyan-Claude-credentials.mjs'; row.mode = 0o644;
  manifest.files[1] = { ...manifest.files[1], path: 'DevRyan-Claude-darwin-arm64' };
  manifest.files.push({ ...manifest.files[1], path: 'DevRyan-libsql-darwin-arm64.node' });
  for (const file of manifest.files) await fs.writeFile(path.join(root, file.path), 'test', { mode: file.mode });
  // Nothing pins or signature-checks them any more; the fixture has no controller, so inventory fails afterwards.
  await expect(verify()).rejects.toMatchObject({ diagnostic: { stage: 'inventory' } });
  await fs.writeFile(path.join(root, row.path), 'evil');
  await expect(verify()).rejects.toMatchObject({ diagnostic: { reason: 'digest_mismatch', artifact: row.path } });
}));

test.skipIf(process.platform === 'win32')('an update candidate is checked for integrity, not against the installed app\'s Bun and reviewed-asset pins', async () => fixture(async ({ root, row, manifest, verify, verifyCandidate }) => {
  row.path = AST_ASSET; row.mode = 0o755;
  await fs.writeFile(path.join(root, row.path), 'test', { mode: row.mode });
  await fs.writeFile(path.join(root, 'DevRyan-second'), 'test', { mode: manifest.files[1].mode });
  // The candidate passes the reviewed-asset pin; this fixture's AST payload is unsigned
  // on macOS and there is no controller elsewhere, so a later stage refuses it.
  const passedPins = { stage: process.platform === 'darwin' ? 'signature' : 'inventory', purpose: 'update-candidate' };
  // A later reviewed AST payload and a newer Bun pass the reviewed-asset stage; the installed pins would refuse both.
  await expect(verify()).rejects.toMatchObject({ diagnostic: { stage: 'reviewed_asset', reason: 'reviewed_asset_mismatch', purpose: 'current' } });
  await expect(verifyCandidate()).rejects.toMatchObject({ diagnostic: passedPins });
  manifest.bunVersion = '1.4.5';
  await expect(verify()).rejects.toMatchObject({ diagnostic: { stage: 'manifest', reason: 'manifest_invalid' } });
  await expect(verifyCandidate()).rejects.toMatchObject({ diagnostic: passedPins });
  // Structure, digests, modes and the manifest digest still bind the candidate.
  await expect(verifyCandidate(JSON.stringify(manifest), 'b'.repeat(64))).rejects.toMatchObject({ diagnostic: { reason: 'digest_mismatch', purpose: 'update-candidate' } });
  for (const bunVersion of [undefined, '', '1.4', 'latest', '1.4.5 ']) {
    await expect(verifyCandidate(JSON.stringify({ ...manifest, bunVersion }))).rejects.toMatchObject({ diagnostic: { stage: 'manifest', reason: 'manifest_invalid' } });
  }
  await fs.writeFile(path.join(root, row.path), 'evil');
  await expect(verifyCandidate()).rejects.toMatchObject({ diagnostic: { reason: 'digest_mismatch', artifact: row.path } });
  await fs.writeFile(path.join(root, row.path), 'test');
  await fs.chmod(path.join(root, row.path), 0o700);
  await expect(verifyCandidate()).rejects.toMatchObject({ diagnostic: { reason: 'mode_mismatch' } });
}));

test.skipIf(process.platform !== 'darwin')('unsigned update candidate controllers fail signature verification', async () => {
  await fixture(async ({ root, row, verifyCandidate }) => {
    row.path = 'DevRyan-native-controller'; row.role = 'controller'; row.mode = 0o755;
    await fs.writeFile(path.join(root, row.path), 'test', { mode: row.mode });
    await expect(verifyCandidate()).rejects.toMatchObject({ diagnostic: { stage: 'signature', reason: 'signature_failure', purpose: 'update-candidate' } });
  });
});

test.skipIf(process.platform !== 'darwin')('unsigned controller failures are distinguished from manifest failures on macOS', async () => {
  await fixture(async ({ root, row, verify }) => {
    row.path = 'DevRyan-native-controller'; row.role = 'controller'; row.mode = 0o755;
    await fs.writeFile(path.join(root, row.path), 'test', { mode: row.mode });
    await expect(verify()).rejects.toMatchObject({ diagnostic: { stage: 'signature', reason: 'signature_failure', artifact: row.path } });
  });
});

test('unchanged payloads are hashed once per process and any rewrite is hashed again', async () => fixture(async ({ root, row, verify }) => {
  const { vi } = await import('vitest');
  for (const name of [row.path, 'DevRyan-second']) await fs.writeFile(path.join(root, name), 'test', { mode: row.mode });
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  const hashed = () => info.mock.calls.filter(([, detail]) => String(detail).includes('"artifact_hashing"')).length;
  try {
    // Both payloads verify; the fixture has no controller, so inventory fails afterwards.
    await expect(verify()).rejects.toMatchObject({ diagnostic: { stage: 'inventory' } });
    expect(hashed()).toBe(1);
    await expect(verify()).rejects.toMatchObject({ diagnostic: { stage: 'inventory' } });
    expect(hashed()).toBe(1);
    // Same size, new content: the changed identity is never served from the cache.
    await fs.writeFile(path.join(root, row.path), 'evil');
    await expect(verify()).rejects.toMatchObject({ diagnostic: { reason: 'digest_mismatch', artifact: row.path } });
    expect(hashed()).toBe(2);
  } finally { info.mockRestore(); }
}));
