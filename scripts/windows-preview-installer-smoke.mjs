import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { WINDOWS_PREVIEW_VERSION, WINDOWS_PREVIEW_NAME } from '../packages/electron/windows-preview.mjs';
import { windowsPreviewAssetName, sha256File, verifyWindowsPreviewEvidence } from './windows-preview-release.mjs';
import { verifyPreviewExecutable } from './windows-preview-opencode.mjs';

const exec = promisify(execFile);
const repository = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
export async function waitForPreviewExecutable(executable, { timeout = 60_000, pollInterval = 250 } = {}) {
  const deadline = Date.now() + timeout;
  while (true) {
    try {
      const stat = await fs.lstat(executable);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('windows_preview_installed_executable_invalid');
      if (stat.size > 0) return;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (Date.now() >= deadline) throw new Error('windows_preview_installed_executable_timeout');
    await sleep(Math.min(pollInterval, Math.max(1, deadline - Date.now())));
  }
}
async function previewDirectoryInventory(directory) {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return { entries: entries.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 64).map(entry => ({
      name: entry.name.slice(0, 200), type: entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other',
    })), truncated: entries.length > 64 };
  } catch (error) { return { errorCode: /^E[A-Z]{1,24}$/.test(error.code || '') ? error.code : 'unavailable' }; }
}
export async function readPreviewSigning(file, execute = exec) {
  const script = "$ErrorActionPreference='Stop'; $s=Get-AuthenticodeSignature -LiteralPath $env:DEVRYAN_SIGNING_TARGET; $thumbprint=$null; if($s.SignerCertificate){$thumbprint=$s.SignerCertificate.Thumbprint}; @{status=$s.Status.ToString();thumbprint=$thumbprint} | ConvertTo-Json -Compress";
  let output;
  try {
    // The native workflow runs in PowerShell 7. Reuse that host: spawning
    // Windows PowerShell 5 from its inherited module environment can select
    // incompatible Microsoft.PowerShell.Security modules before verification.
    output = await execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { env: { ...process.env, DEVRYAN_SIGNING_TARGET: file }, timeout: 30_000, maxBuffer: 4096, windowsHide: true });
  } catch (cause) {
    const error = new Error('windows_preview_signing_probe_failed');
    error.signingProbe = { code: typeof cause.code === 'number' || /^E[A-Z]{1,24}$/.test(cause.code || '') ? cause.code : null,
      stdout: String(cause.stdout || '').slice(0, 4096), stderr: String(cause.stderr || '').slice(0, 4096) };
    throw error;
  }
  let signing;
  try { signing = JSON.parse(output.stdout.trim()); }
  catch {
    const error = new Error('windows_preview_signing_output_invalid');
    error.signingProbe = { stdout: String(output.stdout || '').slice(0, 4096), stderr: String(output.stderr || '').slice(0, 4096) };
    throw error;
  }
  if (!['Valid', 'NotSigned'].includes(signing.status) || signing.status === 'Valid' && !/^[A-Fa-f0-9]{40,64}$/.test(signing.thumbprint || '')) {
    throw new Error('windows_preview_signing_invalid');
  }
  return signing;
}
async function launch({ executable, fixtureRoot, profile, phase }) {
  const receipt = path.join(fixtureRoot, phase + '.json');
  const child = spawn(executable, ['--devryan-preview-smoke'], { stdio: 'ignore', windowsHide: false,
    env: { ...process.env, DEVRYAN_PREVIEW_SMOKE_ROOT: fixtureRoot, DEVRYAN_PREVIEW_SMOKE_USER_DATA: profile,
      DEVRYAN_PREVIEW_SMOKE_RECEIPT: receipt, DEVRYAN_PREVIEW_SMOKE_PHASE: phase } });
  let exited = false;
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => { exited = true; code === 0 ? resolve() : reject(new Error('windows_preview_app_exit_failed')); });
  });
  // Attach immediately; polling must not leave a rejected promise unobserved.
  completion.catch(() => {});
  try {
    const timeout = new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('windows_preview_app_timeout')), 180_000);
      completion.finally(() => clearTimeout(timer)).catch(() => {});
    });
    await Promise.race([completion, timeout]);
    const evidence = JSON.parse(await fs.readFile(receipt, 'utf8'));
    if (evidence.pid !== child.pid || evidence.functional?.status !== 'passed') throw new Error('windows_preview_launch_evidence_invalid');
    return evidence;
  } finally {
    if (!exited && child.pid) await exec('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 30_000, windowsHide: true }).catch(() => {});
  }
}
export async function qualifyWindowsPreviewInstaller({ arch, sourceSha }) {
  if (process.platform !== 'win32' || process.arch !== arch || !['x64', 'arm64'].includes(arch)
    || !/^[a-f0-9]{40}$/.test(sourceSha || '')) throw new Error('windows_preview_native_host_required');
  const directory = path.join(repository, '.cache/windows-preview', arch);
  const installer = path.join(directory, 'package', windowsPreviewAssetName(arch));
  const fixtureRoot = await fs.mkdtemp(path.join(directory, 'smoke-'));
  const installed = path.join(fixtureRoot, 'installed');
  const executable = path.join(installed, WINDOWS_PREVIEW_NAME + '.exe');
  const profile = path.join(fixtureRoot, 'profile');
  const report = { schema: 1, status: 'failed', arch, sourceSha, appVersion: WINDOWS_PREVIEW_VERSION };
  let installedApp = false;
  let failure;
  let stage = 'installer-file';
  try {
    const stat = await fs.lstat(installer);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('windows_preview_installer_invalid');
    stage = 'installer-hash';
    report.installer = { name: path.basename(installer), size: stat.size, sha256: await sha256File(installer) };
    stage = 'installer-signing';
    report.installer.signing = await readPreviewSigning(installer);
    stage = 'install';
    const installationStarted = Date.now();
    await exec(installer, ['/S', '/D=' + installed], { timeout: 300_000, windowsHide: true, maxBuffer: 4096 });
    report.installation = { elapsedMilliseconds: Date.now() - installationStarted, hostArch: process.arch };
    installedApp = true;
    stage = 'installed-executable';
    await waitForPreviewExecutable(executable);
    report.installedExecutable = { ...await verifyPreviewExecutable(executable, arch), signing: await readPreviewSigning(executable) };
    stage = 'installed-stock';
    report.opencode = JSON.parse(await fs.readFile(path.join(installed, 'resources/opencode/opencode.json'), 'utf8'));
    const stock = await verifyPreviewExecutable(path.join(installed, 'resources/opencode/opencode.exe'), arch);
    if (stock.sha256 !== report.opencode.sha256 || stock.size !== report.opencode.size) throw new Error('windows_preview_installed_stock_mismatch');
    report.install = 'passed';
    stage = 'initial-launch';
    report.launch = await launch({ executable, fixtureRoot, profile, phase: 'initial' });
    stage = 'restart-launch';
    report.restart = await launch({ executable, fixtureRoot, profile, phase: 'restart' });
  } catch (error) {
    failure = error; report.failedStage = stage;
    // Capture only our generated package/install filenames before uninstall
    // removes the evidence. Never inspect the runtime profile or fixture keys.
    const unpacked = path.join(directory, 'package', arch === 'arm64' ? 'win-arm64-unpacked' : 'win-unpacked');
    report.installationDiagnostics = {
      hostArch: process.arch,
      packaged: await previewDirectoryInventory(unpacked),
      packagedResources: await previewDirectoryInventory(path.join(unpacked, 'resources')),
      installed: await previewDirectoryInventory(installed),
      installedResources: await previewDirectoryInventory(path.join(installed, 'resources')),
    };
  }
  finally {
    const uninstaller = path.join(installed, 'Uninstall ' + WINDOWS_PREVIEW_NAME + '.exe');
    installedApp ||= await fs.stat(uninstaller).then(stat => stat.isFile(), () => false);
    if (installedApp) try {
      await exec(uninstaller, ['/S'], { timeout: 120_000, windowsHide: true, maxBuffer: 4096 });
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        try { await fs.access(executable); } catch (error) { if (error.code === 'ENOENT') { report.uninstall = 'passed'; break; } throw error; }
        await sleep(250);
      }
      if (report.uninstall !== 'passed') throw new Error('windows_preview_uninstall_failed');
    } catch (error) { failure ||= error; report.failedStage ||= 'uninstall'; }
  }
  report.status = failure ? 'failed' : 'passed';
  if (failure) report.errorCode = /^windows_preview_[a-z_]+$/.test(failure.message || '') ? failure.message : 'windows_preview_smoke_failed';
  if (failure?.signingProbe) report.signingProbe = failure.signingProbe;
  if (failure && /^E[A-Z]{1,24}$/.test(failure.code || '')) report.systemErrorCode = failure.code;
  const evidence = path.join(directory, 'package', `DevRyan-preview-evidence-${arch}.json`);
  await fs.writeFile(evidence, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  if (failure) throw new Error(report.errorCode);
  await verifyWindowsPreviewEvidence({ installer, evidence, arch, sourceSha });
  await fs.rm(fixtureRoot, { recursive: true, force: true });
  console.log(JSON.stringify({ status: report.status, arch, installer: report.installer.name, signing: report.installer.signing.status }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error('Usage: windows-preview-installer-smoke.mjs x64|arm64 sourceSha');
  await qualifyWindowsPreviewInstaller({ arch: process.argv[2], sourceSha: process.argv[3] });
}
