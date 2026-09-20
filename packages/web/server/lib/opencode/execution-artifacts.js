import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { verifySessionExecutionLauncher } from '@openchamber/harness-runtime/lib/session-execution.js';

const platform = `${process.platform}-${process.arch}`;
const extension = process.platform === 'win32' ? '.exe' : '';
export function executionArtifactDirectory({ resourcesPath = process.resourcesPath,
  developmentMode = process.env.OPENCHAMBER_ELECTRON_DEV } = {}) {
  return resourcesPath && developmentMode !== '1'
    ? path.join(resourcesPath, 'revert-runtime', platform)
    : fileURLToPath(new URL(`../../../runtime/${platform}/`, import.meta.url));
}
export function executionArtifacts(directory = process.env.DEVRYAN_EXECUTION_ARTIFACTS || executionArtifactDirectory()) {
  return { directory, launcher: path.join(directory, `DevRyan-execution-${platform}${extension}`),
    opencode: path.join(directory, `DevRyan-opencode-${platform}${extension}`) };
}

/** A version string alone cannot attest the companion patch or native policy. */
export async function executionEnvironment({ pluginDirectory, directory, dataDirectory } = {}) {
  const artifacts = executionArtifacts(directory);
  if (!await verifySessionExecutionLauncher(artifacts)) return {};
  try {
    const contract = JSON.parse(await fs.readFile(new URL('./companion/manifest.json', import.meta.url), 'utf8'));
    const manifest = JSON.parse(await fs.readFile(path.join(artifacts.directory, 'companion.json'), 'utf8'));
    if (manifest.executionBoundary !== 1 || manifest.legacyConversationRevert !== 1 || manifest.acceptance !== true
      || manifest.platform !== process.platform || manifest.arch !== process.arch
      || manifest.baseCommit !== contract.baseCommit || manifest.patchSha256 !== contract.patchSha256
      || manifest.binary !== path.basename(artifacts.opencode)
      || createHash('sha256').update(await fs.readFile(artifacts.opencode)).digest('hex') !== manifest.sha256) return {};
    const controls = {};
    // These bundled adapters only issue attributed host RPCs. Native/custom
    // file tools, including a shadowed name, still run inside the private view.
    for (const name of ['devryan-managed-orchestration.mjs', 'council-session.js']) {
      const file = path.join(pluginDirectory, name);
      controls[await fs.realpath(file)] = createHash('sha256').update(await fs.readFile(file)).digest('hex');
    }
    return { DEVRYAN_EXECUTION_BOUNDARY: '1', DEVRYAN_OPENCODE_ARTIFACT: artifacts.opencode,
      DEVRYAN_EXECUTION_CONTROL_PLUGINS: JSON.stringify(controls), DEVRYAN_EXECUTION_LAUNCHER: artifacts.launcher,
      DEVRYAN_PROVIDER_WORKER: fileURLToPath(new URL('./session-provider-worker.mjs', import.meta.url)).replace(/\.asar([\\/])/, '.asar.unpacked$1'),
      DEVRYAN_PROVIDER_STORAGE: path.join(dataDirectory, 'harness', 'provider-executions') };
  } catch { return {}; }
}
