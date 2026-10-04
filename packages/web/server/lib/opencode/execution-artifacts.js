import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  return {directory,launcher:path.join(directory,`DevRyan-execution-${platform}${extension}`)};
}

/** The supervisor is separate from the native controller/writer artifact bundle. */
export async function verifyExecutionArtifacts({directory}={}) {
  const artifacts=executionArtifacts(directory);
  if(!await verifySessionExecutionLauncher(artifacts))throw Object.assign(new Error('execution_artifacts_unavailable'),{code:'execution_artifacts_unavailable',status:503});
  return artifacts;
}

export function executionReadinessMiddleware(runtime) {
  return (req, res, next) => {
    if (runtime.state !== 'required_unavailable' || req.method !== 'POST') return next();
    let pathname;
    try { pathname = decodeURIComponent(req.path); } catch { return res.status(400).json({ error: 'Invalid request path' }); }
    if (!/^\/api\/session\/[^/]+\/(?:message|prompt_async|command|shell|summarize)\/*$/i.test(pathname)) return next();
    return res.status(503).json({ error: runtime.diagnostic.message, code: runtime.diagnostic.code });
  };
}
