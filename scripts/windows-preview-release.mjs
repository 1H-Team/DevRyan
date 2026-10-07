import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WINDOWS_PREVIEW_VERSION, WINDOWS_PREVIEW_OPENCODE_VERSION, WINDOWS_PREVIEW_OPENCODE_PINS } from '../packages/electron/windows-preview.mjs';

export const WINDOWS_PREVIEW_VERSION_PATTERN = /^\d+\.\d+\.\d+-windows-preview\.[1-9]\d*$/;
export function parseWindowsPreviewVersion(value) {
  if (typeof value !== 'string' || !WINDOWS_PREVIEW_VERSION_PATTERN.test(value)) throw new Error('windows_preview_version_invalid');
  return value;
}
export function windowsPreviewAssetName(arch, version = WINDOWS_PREVIEW_VERSION) {
  if (!['x64', 'arm64'].includes(arch)) throw new Error('windows_preview_architecture_invalid');
  return `DevRyan-${parseWindowsPreviewVersion(version)}-win-${arch}.exe`;
}
export function verifyWindowsPreviewAssetNames(names, version = WINDOWS_PREVIEW_VERSION) {
  const expected = ['x64', 'arm64'].map(arch => windowsPreviewAssetName(arch, version));
  if (names.length !== expected.length || new Set(names).size !== expected.length || names.some(name => !expected.includes(name))) {
    throw new Error('windows_preview_asset_allowlist_failed');
  }
  return expected;
}
export async function sha256File(file) {
  const { createReadStream } = await import('node:fs');
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(file)) digest.update(bytes);
  return digest.digest('hex');
}
export function verifyPreviewFunctionalEvidence(value, phase) {
  const expected = phase === 'initial'
    ? ['authenticated-runtime-readiness', 'runtime-restart', 'project-file-read-write', 'file-traversal-refused',
      'provider-api-key-setup', 'api-key-authenticated-provider-request', 'chat-completion', 'sse-text', 'session-history',
      'active-chat-abort', 'unsupported-routes-refused']
    : ['authenticated-runtime-readiness', 'history-after-application-restart', 'files-after-application-restart'];
  if (value?.status !== 'passed' || value.phase !== phase || value.runtimeMode !== 'standard-preview'
    || !Array.isArray(value.scenarios) || expected.some(name => !value.scenarios.includes(name))) throw new Error('windows_preview_functional_evidence_unverified');
}
export async function verifyWindowsPreviewEvidence({ installer, evidence, arch, sourceSha }) {
  const receipt = JSON.parse(await fs.readFile(evidence, 'utf8'));
  const pin = WINDOWS_PREVIEW_OPENCODE_PINS[arch];
  if (path.basename(installer) !== windowsPreviewAssetName(arch) || receipt.schema !== 1 || receipt.status !== 'passed'
    || receipt.arch !== arch || receipt.appVersion !== WINDOWS_PREVIEW_VERSION || !/^[a-f0-9]{40}$/.test(receipt.sourceSha)
    || sourceSha && receipt.sourceSha !== sourceSha || receipt.installer?.name !== path.basename(installer)
    || receipt.installer.sha256 !== await sha256File(installer) || receipt.installer.size !== (await fs.stat(installer)).size
    || !['Valid', 'NotSigned'].includes(receipt.installer.signing?.status)
    || receipt.opencode?.version !== WINDOWS_PREVIEW_OPENCODE_VERSION || receipt.opencode.arch !== arch
    || receipt.opencode.package !== pin?.package || receipt.opencode.integrity !== pin?.integrity || !/^[a-f0-9]{64}$/.test(receipt.opencode.sha256 || '')
    || receipt.opencode.archiveURL !== `https://registry.npmjs.org/${pin?.package}/-/${pin?.package.split('/')[1]}-${WINDOWS_PREVIEW_OPENCODE_VERSION}.tgz`
    || !Number.isSafeInteger(receipt.opencode.size) || receipt.opencode.size < 1_000_000 || receipt.opencode.size > 256 * 1024 * 1024
    || !/^[a-f0-9]{64}$/.test(receipt.installedExecutable?.sha256 || '') || receipt.installedExecutable.arch !== arch
    || !Number.isSafeInteger(receipt.installedExecutable.size) || receipt.installedExecutable.size < 1_000_000 || receipt.installedExecutable.size > 256 * 1024 * 1024
    || !['Valid', 'NotSigned'].includes(receipt.installedExecutable.signing?.status)
    || receipt.install !== 'passed' || receipt.uninstall !== 'passed'
    || receipt.launch?.functional?.status !== 'passed' || receipt.restart?.functional?.status !== 'passed'
    || receipt.launch.runtimeMode !== 'standard-preview' || receipt.restart.runtimeMode !== 'standard-preview'
    || receipt.launch.opencodeVersion !== WINDOWS_PREVIEW_OPENCODE_VERSION || receipt.restart.opencodeVersion !== WINDOWS_PREVIEW_OPENCODE_VERSION
    || receipt.launch.appVersion !== WINDOWS_PREVIEW_VERSION || receipt.restart.appVersion !== WINDOWS_PREVIEW_VERSION
    || receipt.launch.arch !== arch || receipt.restart.arch !== arch || receipt.launch.ordinaryUserPermissions !== true
    || receipt.restart.ordinaryUserPermissions !== true || receipt.launch.renderer?.body !== true || receipt.launch.renderer?.bridge !== true
    || receipt.restart.renderer?.body !== true || receipt.restart.renderer?.bridge !== true) throw new Error('windows_preview_evidence_unverified');
  verifyPreviewFunctionalEvidence(receipt.launch.functional, 'initial');
  verifyPreviewFunctionalEvidence(receipt.restart.functional, 'restart');
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, sourceSha] = process.argv.slice(2);
  if (!directory || !/^[a-f0-9]{40}$/.test(sourceSha || '') || process.argv.length !== 4) throw new Error('Usage: windows-preview-release.mjs directory sourceSha');
  const allNames = await fs.readdir(directory);
  const names = allNames.filter(name => name.endsWith('.exe'));
  verifyWindowsPreviewAssetNames(names);
  const internalEvidence = ['x64', 'arm64'].map(arch => `DevRyan-preview-evidence-${arch}.json`);
  if (allNames.length !== 4 || allNames.some(name => !names.includes(name) && !internalEvidence.includes(name))) throw new Error('windows_preview_asset_allowlist_failed');
  for (const arch of ['x64', 'arm64']) await verifyWindowsPreviewEvidence({
    installer: path.join(directory, windowsPreviewAssetName(arch)),
    evidence: path.join(directory, `DevRyan-preview-evidence-${arch}.json`), arch, sourceSha,
  });
  console.log('Exact x64 and ARM64 preview installers and native smoke evidence verified.');
}
