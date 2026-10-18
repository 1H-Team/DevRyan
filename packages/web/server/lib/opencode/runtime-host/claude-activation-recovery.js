import path from 'node:path';
import { readBundleJSON } from './bundle-migration-inventory.js';
import { createRuntimeBundleStore } from './runtime-bundle.js';
import { readRuntimeBundleBinding } from './runtime-bundle-binding.js';
import { assertNoLiveOwner } from './native-bundle-startup-upgrade.js';
import { verifyNativeRuntimeArtifacts } from './native-artifacts.js';
import { preflightClaude } from './managed-claude-installation.js';
import { executionArtifacts } from '../execution-artifacts.js';
import { recordStartupFindings } from './startup-notices.js';
import { writeFileAtomic, withCrossProcessFileLock } from '../../../../../harness-runtime/lib/atomic-file.js';

/** Called inside bootstrap.lock, before any selected data or process owner starts. */
export async function recoverClaudeActivationAtStartup({ controlRoot, verifyArtifacts = verifyNativeRuntimeArtifacts, preflight = preflightClaude }) {
  let intent;
  try { intent = await readBundleJSON(path.join(controlRoot, 'claude-activation.json')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (intent.state !== 'pending') return;
  const binding = readRuntimeBundleBinding({ DEVRYAN_RUNTIME_BUNDLE_ROOT: controlRoot }, { allowHeldInspection: true });
  if (binding.selection.selectedBundleID !== intent.candidateBundleID || binding.admission === 'held') return;
  const launch = binding.descriptor.launch;
  await assertNoLiveOwner(launch);
  try {
    const artifacts = await verifyArtifacts({ manifestPath: launch.artifactManifestPath, manifestSha256: launch.artifactManifestSha256,
      launcher: executionArtifacts(path.dirname(launch.artifactManifestPath)).launcher });
    if (!artifacts.manifest.claudeInstallation || !artifacts.reviewedClaude?.claude) throw new Error('missing installation');
    await preflight(artifacts.reviewedClaude.claude.path, artifacts.manifest.claudeInstallation.version);
  } catch {
    const store = createRuntimeBundleStore({ controlRoot, assertNoLiveOwner,
      runMigration: async () => { throw new Error('cold recovery cannot migrate'); },
      withQuiescedSource: async () => { throw new Error('cold recovery cannot checkpoint'); },
      verifyArtifacts: ({ launch: value, purpose }) => verifyArtifacts({ manifestPath: value.artifactManifestPath,
        manifestSha256: value.artifactManifestSha256, launcher: executionArtifacts(path.dirname(value.artifactManifestPath)).launcher, purpose }) });
    await store.restoreUnstartedClaude();
    recordStartupFindings('claude_update', [{ code: 'claude_update_restored', scope: 'upgrade', key: 'previous-version' }], {});
  }
}

/** After startup is ready, automatic restoration is permanently retired. */
export async function completeClaudeActivation(binding) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || !binding) return;
  const file = path.join(binding.controlRoot, 'claude-activation.json');
  await withCrossProcessFileLock(path.join(binding.controlRoot, 'selection.lock'), async () => {
    let intent;
    try { intent = await readBundleJSON(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (intent.state !== 'pending' || intent.candidateBundleID !== binding.selection.selectedBundleID) return;
    const selected = await readBundleJSON(path.join(binding.controlRoot, 'selection.json'));
    if (selected.revision !== binding.selection.revision || selected.selectedBundleID !== intent.candidateBundleID) throw new Error('claude_activation_selection_changed');
    await writeFileAtomic(file, JSON.stringify({ ...intent, state: 'ready' }) + '\n');
  });
}

export async function readClaudeStartupFailure(binding) {
  if (!binding) return null;
  let intent;
  try { intent = await readBundleJSON(path.join(binding.controlRoot, 'claude-activation.json')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  return ['restored', 'pending'].includes(intent.state) && binding.selection.transition === 'rollback' && binding.selection.selectedBundleID === intent.sourceSelection?.selectedBundleID
    && binding.selection.revision === intent.sourceSelection.revision + 2 ? 'claude_update_restored' : null;
}
