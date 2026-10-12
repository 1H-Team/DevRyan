import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { selectedRuntimeBundle } from './runtime-host/runtime-bundle-binding.js';
import { REVIEWED_CLAUDE_ASSETS } from './runtime-host/reviewed-claude-transform.js';
import { REVIEWED_WINDOWS_EXECUTABLES } from './runtime-host/reviewed-windows-assets.js';
import { REVIEWED_PREVIOUS_CLAUDE_ASSET } from './runtime-host/native-artifacts.js';
import { checkLatestRegistryRelease, createOpenCodeUpdateCheckHandler, openCodeUpdateCheckFailureBody } from './opencode-update-check.js';

export const CLAUDE_UPDATE_REGISTRY_URL = 'https://registry.npmjs.org/@anthropic-ai%2Fclaude-code/latest';
const stableVersion = value => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);

export const checkLatestClaudeRelease = options => checkLatestRegistryRelease({
  ...options, registryUrl: CLAUDE_UPDATE_REGISTRY_URL, isSupportedVersion: stableVersion,
});
export const createClaudeUpdateCheckHandler = options => createOpenCodeUpdateCheckHandler({
  ...options, checkRelease: checkLatestClaudeRelease,
  failureBody: error => ({ error: 'claude_update_check_failed', code: openCodeUpdateCheckFailureBody(error).code.replace(/^opencode_/, 'claude_') }),
});

/** Identify the running bundle by its bound manifest digest, never the shell's CLI. */
export async function readBundledClaudeVersion({ binding = selectedRuntimeBundle } = {}) {
  if (!binding) return null;
  const { artifactManifestPath, artifactManifestSha256 } = binding.descriptor.launch;
  const handle = await fs.open(artifactManifestPath, 'r');
  let bytes;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('manifest');
    bytes = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== stat.size) throw new Error('manifest');
    bytes = bytes.subarray(0, bytesRead);
  } finally { await handle.close(); }
  if (createHash('sha256').update(bytes).digest('hex') !== artifactManifestSha256) throw new Error('manifest');
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (!Array.isArray(manifest.files)) throw new Error('manifest');
  const reviewed = [REVIEWED_CLAUDE_ASSETS.claude, REVIEWED_PREVIOUS_CLAUDE_ASSET,
    ...Object.values(REVIEWED_WINDOWS_EXECUTABLES).map(assets => assets.claude)];
  const versions = manifest.files.flatMap(file => file?.role === 'asset'
    ? reviewed.filter(asset => asset.sha256 === file.sha256).map(asset => asset.version) : []);
  return versions.length === 1 ? versions[0] : null;
}
