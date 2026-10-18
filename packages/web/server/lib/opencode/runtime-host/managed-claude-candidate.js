import fs from 'node:fs/promises';
import { withCrossProcessFileLock } from '../../../../../harness-runtime/lib/atomic-file.js';
import path from 'node:path';
import { CLAUDE_ASSET, sha256, newerClaude, downloadClaudeInstallation } from './managed-claude-installation.js';
import { retainNativeArtifacts } from './retained-native-artifacts.js';
import { verifyNativeRuntimeArtifacts } from './native-artifacts.js';
import { claudeVersionFromManifest } from '../claude-runtime-update.js';
import { executionArtifacts } from '../execution-artifacts.js';

/** Derive a complete immutable inventory, keeping every non-Claude artifact exact. */
export async function createClaudeCandidate({ controlRoot, source, version, installation, installationDirectory,
  verifyArtifacts = verifyNativeRuntimeArtifacts, download = downloadClaudeInstallation, onPhase }) {
  const parent = path.join(controlRoot, 'claude-staging');
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  if (await fs.realpath(parent) !== parent) throw new Error('claude_staging_invalid');
  return withCrossProcessFileLock(path.join(controlRoot, 'claude-update.lock'), async () => {
  // A prior owner killed during download cannot have published these scratch files.
  for (const name of await fs.readdir(parent)) {
    if (!/^candidate-[A-Za-z0-9]+$/.test(name)) continue;
    const entry = path.join(parent, name), stat = await fs.lstat(entry);
    if (stat.isDirectory() && !stat.isSymbolicLink() && await fs.realpath(entry) === entry) await fs.rm(entry, { recursive: true });
  }
  const directory = await fs.mkdtemp(path.join(parent, 'candidate-'));
  try {
    const record = installation ?? await download({ directory, version, onPhase });
    for (const row of source.manifest.files) {
      if (row.path === CLAUDE_ASSET && !installation) continue;
      const from = row.path === CLAUDE_ASSET ? path.join(installationDirectory, CLAUDE_ASSET) : path.join(source.directory, row.path);
      const target = path.join(directory, row.path);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.copyFile(from, target, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
      await fs.chmod(target, row.mode);
    }
    const manifest = { ...source.manifest,
      claudeInstallation: record,
      claudeBaseManifestSha256: source.manifest.claudeBaseManifestSha256 ?? source.manifestSha256,
      files: source.manifest.files.map(row => row.path !== CLAUDE_ASSET ? row : { ...row, version: record.version,
        sha256: record.sha256, size: record.size, signing: { mode: 'release', verified: true, teamID: record.signatureTeamID, cdhash: record.cdhash } }) };
    const bytes = JSON.stringify(manifest) + '\n', manifestPath = path.join(directory, 'native-bundle.json'), manifestSha256 = sha256(bytes);
    await fs.writeFile(manifestPath, bytes, { flag: 'wx', mode: 0o600 });
    await verifyArtifacts({ manifestPath, manifestSha256, launcher: executionArtifacts(directory).launcher });
    const artifacts = await retainNativeArtifacts({ controlRoot, manifestPath, manifestSha256, verifyArtifacts });
    return { artifacts, manifestPath: artifacts.manifestPath, manifestSha256 };
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
}

/** App upgrades retain a newer user-selected Claude without changing their compiled core. */
export async function preserveManagedClaude({ controlRoot, source, candidate, verifyArtifacts }) {
  const installed = source.manifest.claudeInstallation;
  if (!installed) return candidate;
  const shipped = candidate.artifacts.manifest.files.find(row => row.path === CLAUDE_ASSET);
  if (source.manifest.claudeBaseManifestSha256 === candidate.manifestSha256) return {
    artifacts: source, manifestPath: source.manifestPath, manifestSha256: source.manifestSha256,
  };
  if (!shipped || !newerClaude(installed.version, claudeVersionFromManifest(candidate.artifacts.manifest))) return candidate;
  return createClaudeCandidate({ controlRoot, source: candidate.artifacts, installation: installed, installationDirectory: source.directory, verifyArtifacts });
}
