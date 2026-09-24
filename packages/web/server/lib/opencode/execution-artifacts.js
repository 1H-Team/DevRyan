import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
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

/** Keep diagnostics available without interpreting required-but-missing as an
 * opt-out. Callers must enforce assertReady at every execution entrypoint.
 * A managed host without a verified companion degrades to plain OpenCode:
 * execution is unconfined, and ledger-owned conversations keep Revert/Redo
 * disabled (see session-execution-host assertLegacyRevertAllowed). A host
 * started with DEVRYAN_EXECUTION_BOUNDARY=1 requires capture and fails closed. */
export async function executionRuntimeState(options) {
  try {
    const environment = await executionEnvironment(options);
    const active = environment.DEVRYAN_EXECUTION_BOUNDARY === '1';
    return { state: active ? 'active' : 'not_expected', environment, assertReady() {}, diagnostic: null,
      companion: active ? await companionIdentity(options?.directory) : null };
  } catch {
    if (options?.runtimeMode !== 'captured') {
      return { state: 'degraded', environment: {}, assertReady() {}, diagnostic: { code: 'execution_artifacts_unavailable',
        message: 'The DevRyan companion is missing or incompatible, so DevRyan is running plain OpenCode. Tools are not confined and conversation Revert is limited. Repair or update DevRyan, then restart the server.' } };
    }
    const diagnostic = { code: 'execution_artifacts_unavailable',
      message: 'The verified execution runtime is missing or incompatible. Repair or update DevRyan, then restart the server.' };
    return { state: 'required_unavailable', environment: {}, diagnostic,
      assertReady() { throw Object.assign(new Error(diagnostic.message), { code: diagnostic.code, status: 503 }); } };
  }
}

/** Display identity of the verified companion; its OpenCode base is reported separately by health. */
export async function companionIdentity(directory) {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(executionArtifacts(directory).directory, 'companion.json'), 'utf8'));
    const version = typeof manifest.companionVersion === 'string' ? manifest.companionVersion
      : typeof manifest.version === 'string' ? manifest.version : null;
    return version && /^[0-9A-Za-z.+-]{1,64}$/.test(version) ? { version } : null;
  } catch { return null; }
}

// Stream the digest: the companion binary is ~100 MiB and must not be buffered
// in the server process just to verify it at startup.
const fileDigest = async (file) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};

export function executionReadinessMiddleware(runtime) {
  return (req, res, next) => {
    if (runtime.state !== 'required_unavailable' || req.method !== 'POST') return next();
    let pathname;
    try { pathname = decodeURIComponent(req.path); } catch { return res.status(400).json({ error: 'Invalid request path' }); }
    if (!/^\/api\/session\/[^/]+\/(?:message|prompt_async|command|shell|summarize)\/*$/i.test(pathname)) return next();
    return res.status(503).json({ error: runtime.diagnostic.message, code: runtime.diagnostic.code });
  };
}

/** A version string alone cannot attest the companion patch or native policy. */
export async function executionEnvironment({ pluginDirectory, directory, dataDirectory, runtimeMode = 'managed' } = {}) {
  const contract = JSON.parse(await fs.readFile(new URL('./companion/manifest.json', import.meta.url), 'utf8'));
  if (runtimeMode === 'external' || runtimeMode !== 'captured' && !contract.supportedArtifacts?.includes(platform)) return {};
  const unavailable = () => Object.assign(new Error('The verified DevRyan execution runtime is missing or incompatible. Repair the runtime before starting captured tasks.'), {
    code: 'execution_artifacts_unavailable', status: 503,
  });
  const artifacts = executionArtifacts(directory);
  if (!await verifySessionExecutionLauncher(artifacts)) throw unavailable();
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(artifacts.directory, 'companion.json'), 'utf8'));
    if (Object.entries(contract.capability).some(([name, version]) => manifest[name] !== version) || manifest.acceptance !== true
      || manifest.platform !== process.platform || manifest.arch !== process.arch
      || manifest.baseCommit !== contract.baseCommit || manifest.patchSha256 !== contract.patchSha256
      || manifest.binary !== path.basename(artifacts.opencode)
      || await fileDigest(artifacts.opencode) !== manifest.sha256) throw unavailable();
    const controls = {};
    // These bundled adapters only issue attributed host RPCs. Native/custom
    // file tools, including a shadowed name, still run inside the private view.
    for (const name of ['devryan-managed-orchestration.mjs', 'council-session.js']) {
      const file = path.join(pluginDirectory, name);
      controls[await fs.realpath(file)] = createHash('sha256').update(await fs.readFile(file)).digest('hex');
    }
    return { DEVRYAN_EXECUTION_BOUNDARY: '1', DEVRYAN_OPENCODE_ARTIFACT: artifacts.opencode,
      DEVRYAN_EXECUTION_BROWSER_PLUGIN: createHash('sha256').update(await fs.readFile(path.join(pluginDirectory, 'devryan-browser.mjs'))).digest('hex'),
      DEVRYAN_EXECUTION_CONTROL_PLUGINS: JSON.stringify(controls), DEVRYAN_EXECUTION_LAUNCHER: artifacts.launcher,
      DEVRYAN_PROVIDER_WORKER: fileURLToPath(new URL('./session-provider-worker.mjs', import.meta.url)).replace(/\.asar([\\/])/, '.asar.unpacked$1'),
      DEVRYAN_PROVIDER_STORAGE: path.join(dataDirectory, 'harness', 'provider-executions') };
  } catch { throw unavailable(); }
}
