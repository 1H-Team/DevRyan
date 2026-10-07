// Actual-host qualification. Diagnostic/candidate manifests never grant
// admission, and a blocked prerequisite leaves every installer cell not run.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createReadStream, constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createWindowsUpdateOwner, parseWindowsNsisReceipt } from '../packages/electron/windows-update-owner.mjs';
import { createWindowsNsisInstaller } from '../packages/electron/desktop-updater-windows.mjs';
import { releaseAssetName } from '../packages/electron/release-assets.mjs';
import { readWindowsReleaseVersion } from './append-windows-release.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = fileURLToPath(import.meta.url);
const version = await readWindowsReleaseVersion(repository);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const errorEvidence = error => ({ code: error.code ?? error.name ?? 'qualification_failed', message: String(error.message).slice(0, 1200) });
export const WINDOWS_INSTALLER_SCENARIOS = Object.freeze(['installation', 'update-success', 'update-refusal', 'interruption', 'rollback']);
export const WINDOWS_INSTALLER_PREREQUISITES = Object.freeze(['namespace-durability', 'supervisor-acceptance', 'runtime-compatibility', 'native-artifacts']);

async function artifactIdentity(file, maximum = 8 * 1024 ** 3) {
  assert.equal(await fs.realpath(file), file);
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    assert.ok(before.isFile() && before.nlink === 1 && before.size > 0 && before.size <= maximum);
    const digest = createHash('sha256'); let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) { size += chunk.length; assert.ok(size <= before.size); digest.update(chunk); }
    const after = await handle.stat(), named = await fs.lstat(file);
    assert.equal(size, before.size); assert.equal(after.size, before.size);
    for (const key of ['dev', 'ino', 'mtimeMs', 'ctimeMs']) assert.equal(after[key], before[key]);
    assert.ok(named.isFile() && !named.isSymbolicLink() && named.nlink === 1);
    assert.equal(named.dev, before.dev); assert.equal(named.ino, before.ino);
    return { name: path.basename(file), sha256: digest.digest('hex'), size };
  } finally { await handle.close(); }
}

export function installerQualificationStatus(prerequisites, scenarios) {
  assert.deepEqual(prerequisites.map(row => row.id), WINDOWS_INSTALLER_PREREQUISITES);
  assert.deepEqual(scenarios.map(row => row.id), WINDOWS_INSTALLER_SCENARIOS);
  if (prerequisites.some(row => row.status !== 'passed')) return 'blocked';
  return scenarios.every(row => row.status === 'passed') ? 'passed' : 'failed';
}

// The source digest binds bytes, not merely a commit label. Native manifests
// independently bind the reviewed runtime closure and emitted binaries.
export async function captureInstallerQualificationSource(root = repository) {
  const names = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--',
    'scripts', 'packages', 'package.json', 'bun.lock', 'vite.config.ts', 'vite-theme-plugin.ts',
    'postcss.config.js', 'tsconfig.json', 'components.json',
    '.github/workflows/windows.yml', '.github/workflows/windows-lpac.yml', 'docs/WINDOWS_PORT_PLAN.md'],
  { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).split('\0').filter(Boolean).sort();
  const sourceFiles = [];
  for (const name of names) {
    const file = path.resolve(root, name);
    assert.ok(file.startsWith(root + path.sep));
    const stat = await fs.lstat(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), `Unbound source input: ${name}`);
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(file)) digest.update(chunk);
    sourceFiles.push({ path: name.replaceAll('\\', '/'), sha256: digest.digest('hex'), size: stat.size });
  }
  return { sourceFiles, sourceTreeSha256: hash(JSON.stringify(sourceFiles)) };
}

const waitFor = async (observe, timeout = 180_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await observe(); if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Object.assign(new Error('Bounded Windows qualification wait expired'), { code: 'qualification_timeout' });
};

async function availableDebugPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function installedApplicationHealth(debugPort) {
  try {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(1000), redirect: 'error' });
    if (!response.ok) return null;
    const pages = await response.json();
    assert.ok(Array.isArray(pages) && pages.length <= 32);
    for (const page of pages) {
      if (page.type !== 'page') continue;
      const url = new URL(page.url);
      if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) continue;
      const health = await fetch(new URL('/health', url), { signal: AbortSignal.timeout(1000), redirect: 'error' });
      if (!health.ok) continue;
      const value = await health.json();
      if (value.status === 'ok' && value.openCodeRunning === true && value.openCode?.generation === 2
        && typeof value.openCode.runtimeIdentity === 'string' && value.openCode.runtimeIdentity) {
        return { status: value.status, openCodeRunning: true, generation: 2, runtimeIdentity: value.openCode.runtimeIdentity };
      }
    }
    return null;
  } catch (error) { if (error instanceof TypeError || error.name === 'TimeoutError') return null; throw error; }
}

async function run(file, args, { directory, env, log, timeout = 600_000 } = {}) {
  const child = spawn(file, args, { cwd: directory ?? repository, env: env ?? process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-1024 * 1024); });
  child.stderr.on('data', chunk => { errors = (errors + chunk.toString()).slice(-1024 * 1024); });
  let timer;
  try {
    const result = await new Promise((resolve, reject) => {
      timer = setTimeout(() => { child.kill(); reject(Object.assign(new Error('Bounded qualification command expired'), { code: 'qualification_timeout' })); }, timeout);
      child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
    });
    if (log) await fs.writeFile(log, output + '\n' + errors, { flag: 'wx' });
    if (result.code !== 0 || result.signal) throw Object.assign(new Error(`Qualification command refused (${result.code ?? result.signal})`), { code: 'qualification_command_failed' });
    return output;
  } finally { clearTimeout(timer); }
}

async function streamInstaller(owner, source, destination) {
  const size = (await fs.stat(source)).size;
  const writer = await owner.beginDownload(destination, { offset: 0, size, expected: 'absent' });
  const digest = createHash('sha256'); let bytes = 0;
  try {
    for await (const chunk of createReadStream(source)) { digest.update(chunk); bytes += chunk.length; await writer.write(chunk); }
  } finally {
    // Finish also obtains the native final-path/file identity and closes its
    // exact write handle. Interrupted bytes remain private and cannot execute.
    const receipt = await writer.finish();
    assert.equal(receipt.size, size); assert.equal(bytes, size);
    assert.equal(receipt.token.split(':')[2], digest.digest('hex'));
  }
  return destination;
}

async function nativeFirstInstall(owner, installer, target, receiptDirectory) {
  await owner.ensureDirectory(target); await owner.ensureDirectory(receiptDirectory);
  const original = spawn(process.execPath, ['-e', 'process.stdin.resume();process.stdin.on("end",()=>process.exit(0))'], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
  original.once('error', () => {});
  let held;
  try {
    const originalIdentity = await waitFor(() => owner.processIdentity(original.pid), 5000);
    const file = await owner.file(installer);
    const nonce = randomUUID().replaceAll('-', '');
    held = await owner.holdInstaller({ file: installer, sha256: file.token.split(':')[2], size: file.size, target,
      previousToken: await owner.tree(target), ownerPID: original.pid, ownerStart: originalIdentity.startIdentity,
      nonce, receipt: path.join(receiptDirectory, 'native.json') });
    const installing = held.install(); original.stdin.end();
    const settled = await installing;
    assert.equal(settled.exitCode, 0);
    assert.equal(await owner.tree(target), settled.targetToken);
    return { settled, executable: await owner.version(target) };
  } finally { original.stdin.end(); held?.release(); }
}

async function stopOwnedApplication(owner, pid, startIdentity) {
  // The SDK verifies creation time and performs WM_CLOSE while holding the
  // exact process handle. An absent or reused numeric PID grants no authority.
  return owner.terminateProcess(pid, startIdentity, { graceful: true });
}

async function verifyInstalled(target, arch, owner, expected) {
  const { verifyWindowsInstalledArtifacts } = await import('../packages/electron/windows-installed-artifacts.mjs');
  const { verifyNativeRuntimeArtifacts } = await import('../packages/web/server/lib/opencode/runtime-host/native-artifacts.js');
  const verified = await verifyWindowsInstalledArtifacts({ target, arch, owner, verifyNativeArtifacts: verifyNativeRuntimeArtifacts });
  assert.equal(verified.manifestSha256, expected.manifestSha256);
  assert.equal(verified.manifest.buildId, expected.buildId); assert.equal(verified.manifest.inputs.coreDigest, expected.coreDigest);
  return verified;
}

async function installationRegistration(target, environment) {
  const literal = value => `'${value.replaceAll("'", "''")}'`;
  const guid = JSON.parse(await fs.readFile(path.join(repository, 'packages/electron/package.json'), 'utf8')).build.nsis.guid;
  assert.equal(guid, 'f8140f18-5574-54bc-8df6-bf218619bfba');
  const command = `$target=${literal(target)}; $guid=${literal(guid)}; `
    + `$hive=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::Registry64); `
    + `$install=$hive.OpenSubKey('Software\\'+$guid); $uninstall=$hive.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\'+$guid); `
    + `if(-not $install -or -not $uninstall){throw 'Actual fixed-key per-user registration missing'}; `
    + `$location=$install.GetValue('InstallLocation'); $shortcut=$install.GetValue('ShortcutName'); $menu=$install.GetValue('MenuDirectory'); `
    + `$entries=@([pscustomobject]@{key=$guid;name=$uninstall.GetValue('DisplayName');version=$uninstall.GetValue('DisplayVersion');location=$location;uninstall=$uninstall.GetValue('UninstallString');quiet=$uninstall.GetValue('QuietUninstallString')}); `
    + `$install.Close(); $uninstall.Close(); $hive.Close(); `
    + `$shell=New-Object -ComObject WScript.Shell; $links=@(); `
    + `$programs=[Environment]::GetFolderPath([Environment+SpecialFolder]::Programs); if($menu){$programs=Join-Path $programs $menu}; `
    + `foreach($file in @((Join-Path $programs ($shortcut+'.lnk')),(Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)) ($shortcut+'.lnk')))){ `
    + `if(Test-Path -LiteralPath $file){$link=$shell.CreateShortcut($file); `
    + `if($link.TargetPath -ine (Join-Path $target 'DevRyan.exe')){throw 'Actual shortcut targets another installation'}; `
    + `$links+=[pscustomobject]@{path=$file;target=$link.TargetPath;arguments=$link.Arguments;workingDirectory=$link.WorkingDirectory;icon=$link.IconLocation}}}; `
    + `[pscustomobject]@{registry=$entries;shortcuts=@($links|Sort-Object path)}|ConvertTo-Json -Depth 6 -Compress`;
  const value = JSON.parse(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { env: environment, timeout: 10_000 }));
  assert.ok(Array.isArray(value.registry) && value.registry.length === 1, 'Exact per-user uninstall registration required');
  assert.equal(value.registry[0].name, 'DevRyan'); assert.equal(value.registry[0].version, version);
  assert.equal(path.win32.resolve(value.registry[0].location), target);
  assert.ok(Array.isArray(value.shortcuts) && value.shortcuts.length > 0, 'Actual per-user application shortcut required');
  return value;
}

async function refuseExistingInstallation(environment) {
  // The fixed NSIS GUID would otherwise update an existing per-user install.
  // Qualification is restricted to disposable hosted runners, and still
  // refuses any existing DevRyan registration before the first installer.
  const output = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$guid='f8140f18-5574-54bc-8df6-bf218619bfba'; $found=$false; `
    + `foreach($view in @([Microsoft.Win32.RegistryView]::Registry32,[Microsoft.Win32.RegistryView]::Registry64)){ `
    + `$hive=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,$view); `
    + `foreach($name in @(('Software\\'+$guid),('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\'+$guid))){$key=$hive.OpenSubKey($name);if($key){$found=$true;$key.Close()}};$hive.Close()}; `
    + `foreach($directory in @([Environment]::GetFolderPath([Environment+SpecialFolder]::Programs),[Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory))){if(Test-Path -LiteralPath (Join-Path $directory 'DevRyan.lnk')){$found=$true}}; `
    + `if($found){'1'}else{'0'}`],
  { env: environment, timeout: 10_000 });
  assert.equal(output.trim(), '0', 'Existing per-user DevRyan installation must remain untouched');
}

async function actualInstallerScenarios({ root, owner, baseline, candidate, arch, helperSource, environment, nativeIdentity }) {
  const rows = []; let priorFailed = false;
  const installRoot = path.join(root, 'installation-root'); await owner.ensureDirectory(installRoot);
  for (const id of WINDOWS_INSTALLER_SCENARIOS) {
    if (priorFailed) { rows.push({ id, status: 'blocked', reason: 'previous_scenario_failed_or_cleanup_unconfirmed' }); continue; }
    const row = { id, status: 'failed' }, directory = path.join(root, id);
    await owner.ensureDirectory(directory);
    const target = path.join(installRoot, 'DevRyan'), home = path.join(directory, 'home'), userData = path.join(home, 'app-data'), cache = path.join(userData, 'updates');
    await owner.ensureDirectory(home); await owner.ensureDirectory(userData); await owner.ensureDirectory(cache);
    const env = { ...environment, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
      OPENCHAMBER_ELECTRON_USER_DATA_DIR: userData, ELECTRON_RUN_AS_NODE: '0' };
    delete env.OPENCHAMBER_ELECTRON_DEV;
    const applications = []; let updateChild, updateStart, updateSpawnError;
    try {
      row.firstInstall = await nativeFirstInstall(owner, baseline, target, path.join(directory, 'initial-receipt'));
      await verifyInstalled(target, arch, owner, nativeIdentity);
      const before = await owner.tree(target); row.previousToken = before;
      row.registrationBefore = await installationRegistration(target, env);
      if (id === 'installation') {
        const debugPort = await availableDebugPort();
        const child = spawn(path.join(target, 'DevRyan.exe'), [`--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1'], { env, stdio: 'ignore', windowsHide: false });
        child.once('error', () => {});
        const identity = await waitFor(() => owner.processIdentity(child.pid), 10_000);
        applications.push({ pid: child.pid, start: identity.startIdentity });
        await waitFor(async () => {
          const current = await owner.processIdentity(child.pid);
          if (!current?.active || current.startIdentity !== identity.startIdentity) throw Error('Installed application exited before its window opened');
          const output = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${child.pid}).MainWindowHandle.ToInt64()`], { timeout: 5000 });
          return /^\s*[1-9][0-9]*\s*$/.test(output);
        }, 60_000);
        row.application = { pid: child.pid, startIdentity: identity.startIdentity, actualWindow: true,
          health: await waitFor(() => installedApplicationHealth(debugPort), 120_000) };
        await stopOwnedApplication(owner, child.pid, identity.startIdentity);
        row.registrationAfter = await installationRegistration(target, env);
        assert.deepEqual(row.registrationAfter, row.registrationBefore);
        row.status = 'passed'; rows.push(row); continue;
      }
      const source = await owner.file(candidate);
      if (id === 'update-refusal') {
        const installer = createWindowsNsisInstaller({ installedDirectory: target, currentVersion: version, cacheDirectory: cache, arch,
          owner, helperSource, verifyNativeArtifacts: ({ target: installed, arch: architecture }) => verifyInstalled(installed, architecture, owner, nativeIdentity) });
        await assert.rejects(installer.prepare({ file: candidate, update: { version, size: source.size, sha256: '0'.repeat(64) } }), { code: 'update_integrity_failed' });
        assert.equal(await owner.tree(target), before);
        row.registrationAfter = await installationRegistration(target, env);
        assert.deepEqual(row.registrationAfter, row.registrationBefore);
        row.refusal = 'update_integrity_failed'; row.targetUnchanged = true; row.status = 'passed'; rows.push(row); continue;
      }
      // This separate source host owns only the production updater. Its exit
      // authorizes NSIS; candidate readiness comes from the installed real app.
      const parameters = { directory, target, cache, arch, candidate, launcher: owner.launcher, helperSource, nativeIdentity };
      const child = spawn(process.execPath, [script, '--update-host', JSON.stringify(parameters)], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      updateChild = child; child.once('error', error => { updateSpawnError = error; });
      const hostIdentity = await waitFor(() => owner.processIdentity(child.pid), 5000);
      assert.equal(hostIdentity.active, true); updateStart = hostIdentity.startIdentity;
      let output = '', errors = ''; child.stdout.on('data', bytes => { output = (output + bytes.toString()).slice(-4096); });
      child.stderr.on('data', bytes => { errors = (errors + bytes.toString()).slice(-4096); });
      const ready = await waitFor(() => {
        if (updateSpawnError) throw updateSpawnError;
        if (child.exitCode !== null || child.signalCode !== null) throw Error(`Update host exited before acknowledgement: ${errors}`);
        if (!output.includes('\n')) return null;
        return JSON.parse(output.split('\n')[0]);
      }, 60_000);
      assert.equal(ready.status, 'waiting');
      const intentPath = path.join(cache, 'state', 'install-intent.json');
      const readIntent = async () => JSON.parse((await owner.read(intentPath)).bytes.toString('utf8'));
      child.stdin.end();
      if (id === 'interruption' || id === 'rollback') {
        const phase = id === 'interruption' ? 'installing' : 'installed';
        const interrupted = await waitFor(async () => {
          const value = await readIntent();
          if (value.phase === phase) return value;
          if (['launching', 'accepted', 'complete', 'held', 'rolled-back'].includes(value.phase)) throw Error(`Missed actual ${phase} interruption boundary (${value.phase})`);
        });
        // Allow NSIS creation after the original owner has actually exited.
        if (id === 'interruption') {
          await waitFor(async () => child.exitCode !== null || child.signalCode !== null, 10_000);
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        row.helperTermination = await owner.terminateProcess(interrupted.helperPID, interrupted.helperStart);
        await waitFor(async () => {
          const native = await owner.processIdentity(interrupted.nativePID);
          return !native?.active || native.startIdentity !== interrupted.nativeStart;
        }, 30_000);
        const settled = parseWindowsNsisReceipt(JSON.parse((await owner.read(interrupted.receipt)).bytes.toString('utf8')), interrupted.nonce);
        assert.equal(settled.terminated, true); assert.equal(settled.namespaceFlushed, true);
        assert.equal(await owner.tree(interrupted.backup), interrupted.backupToken);
        row.interruptedPhase = phase; row.settled = settled; row.backupPreserved = true;
        // A real ordinary startup observes the interrupted production intent,
        // drains its recovery host and lets the exact helper restore the backup.
        const recovery = spawn(path.join(target, 'DevRyan.exe'), [], { env, stdio: 'ignore', windowsHide: false });
        recovery.once('error', () => {});
        const recoveryIdentity = await waitFor(() => owner.processIdentity(recovery.pid), 5000);
        applications.push({ pid: recovery.pid, start: recoveryIdentity.startIdentity });
        const restored = await waitFor(async () => {
          const value = await readIntent();
          if (value.phase === 'held') throw Error('Actual recovery remained held');
          return value.phase === 'rolled-back' ? value : null;
        });
        assert.equal(await owner.tree(target), restored.backupToken);
        await verifyInstalled(target, arch, owner, nativeIdentity);
        await waitFor(async () => recovery.exitCode !== null || recovery.signalCode !== null, 30_000);
        row.recovery = { phase: restored.phase, backupToken: restored.backupToken, recoveryHostExited: true };
      } else {
        const completed = await waitFor(async () => {
          const value = await readIntent();
          if (value.phase === 'held' || value.phase === 'rolled-back') throw Error(`Actual candidate startup refused (${value.errorCode ?? value.phase})`);
          return value.phase === 'complete' ? value : null;
        });
        assert.ok(completed.candidatePID && completed.candidateStart);
        const actual = await owner.processIdentity(completed.candidatePID);
        assert.ok(actual?.active && actual.startIdentity === completed.candidateStart);
        applications.push({ pid: completed.candidatePID, start: completed.candidateStart });
        await verifyInstalled(target, arch, owner, nativeIdentity);
        row.candidate = { pid: completed.candidatePID, startIdentity: completed.candidateStart, phase: completed.phase };
        await stopOwnedApplication(owner, completed.candidatePID, completed.candidateStart);
      }
      row.registrationAfter = await installationRegistration(target, env);
      assert.deepEqual(row.registrationAfter, row.registrationBefore, 'Per-user uninstall and shortcut identities must survive update/recovery');
      row.status = 'passed';
    } catch (error) { row.error = errorEvidence(error); }
    finally {
      updateChild?.stdin.end();
      const cleanup = [];
      try {
        const intent = JSON.parse((await owner.read(path.join(cache, 'state', 'install-intent.json'))).bytes.toString('utf8'));
        assert.equal(intent.target, target);
        if (intent.candidatePID && !applications.some(application => application.pid === intent.candidatePID && application.start === intent.candidateStart)) {
          applications.push({ pid: intent.candidatePID, start: intent.candidateStart });
        }
        if (row.status !== 'passed' && intent.helperPID) {
          const process_ = await owner.processIdentity(intent.helperPID);
          if (process_?.active && process_.startIdentity === intent.helperStart) {
            cleanup.push({ pid: intent.helperPID, start: intent.helperStart, status: 'terminated',
              receipt: await owner.terminateProcess(intent.helperPID, intent.helperStart) });
          }
          if (intent.nativePID) await waitFor(async () => {
            const native = await owner.processIdentity(intent.nativePID);
            return !native?.active || native.startIdentity !== intent.nativeStart;
          }, 30_000);
        }
      } catch (error) {
        if (error.code !== 'ENOENT') { row.status = 'failed'; cleanup.push({ status: 'held', error: errorEvidence(error) }); }
      }
      for (const application of applications) {
        try {
          const process_ = await owner.processIdentity(application.pid);
          if (!process_?.active || process_.startIdentity !== application.start) { cleanup.push({ ...application, status: 'exited' }); continue; }
          const receipt = await stopOwnedApplication(owner, application.pid, application.start);
          cleanup.push({ ...application, status: 'exited', receipt });
        } catch (error) {
          row.status = 'failed'; cleanup.push({ ...application, status: 'held', error: errorEvidence(error) });
          try { cleanup.at(-1).termination = await owner.terminateProcess(application.pid, application.start); }
          catch (failure) { cleanup.at(-1).terminationError = errorEvidence(failure); }
        }
      }
      if (updateChild?.pid) {
        try {
          await waitFor(() => updateChild.exitCode !== null || updateChild.signalCode !== null, 10_000);
          cleanup.push({ pid: updateChild.pid, status: 'exited' });
        } catch (error) {
          row.status = 'failed'; cleanup.push({ pid: updateChild.pid, start: updateStart, status: 'held', error: errorEvidence(error) });
          if (updateStart) {
            try { cleanup.at(-1).termination = await owner.terminateProcess(updateChild.pid, updateStart); }
            catch (failure) { cleanup.at(-1).terminationError = errorEvidence(failure); }
          }
        }
      }
      row.cleanup = cleanup;
      if (row.status !== 'passed') priorFailed = true;
    }
    rows.push(row);
  }
  return rows;
}

async function buildInstallers(root, arch, environment) {
  await run('bun', ['run', '--cwd', 'packages/electron', 'build:web-assets'], { env: environment, log: path.join(root, 'web-build.log') });
  await run('bun', ['run', '--cwd', 'packages/electron', 'bundle:main'], { env: environment, log: path.join(root, 'electron-bundle.log') });
  await run('bun', ['run', '--cwd', 'packages/electron', 'rebuild:native'], { env: environment, log: path.join(root, 'electron-native.log') });
  const electronRoot = path.join(repository, 'packages/electron');
  const requireElectron = createRequire(path.join(electronRoot, 'package.json'));
  const { build, Platform, Arch } = requireElectron('electron-builder');
  const packageJson = JSON.parse(await fs.readFile(path.join(electronRoot, 'package.json'), 'utf8'));
  assert.equal(packageJson.version, version);
  const inputBytes = await fs.readFile(path.join(electronRoot, 'dist-bundle/main.inputs.json'));
  assert.ok(inputBytes.length <= 4 * 1024 ** 2);
  const mainInputs = JSON.parse(inputBytes); assert.equal(mainInputs.bunVersion, '1.3.14'); assert.equal(mainInputs.workingDirectory, repository);
  const artifacts = {}, buildEvidence = { nodeVersion: process.versions.node,
    electronVersion: packageJson.devDependencies.electron, builderVersion: requireElectron('electron-builder/package.json').version,
    mainInputsSha256: hash(inputBytes), mainInputs, configurations: [] };
  for (const role of ['baseline', 'candidate']) {
    const output = path.join(root, `build-${role}`);
    const config = { ...packageJson.build, extends: null, afterPack: null, publish: null,
      directories: { ...packageJson.build.directories, output },
      // The baseline is an explicit same-source, same-version fixture. It does
      // not purport to be an earlier shipped Windows release.
      ...(role === 'baseline' ? { extraMetadata: { devryanQualificationBaseline: true } } : {}),
    };
    const configFile = path.join(root, `${role}-builder.cjs`);
    await fs.writeFile(configFile, `module.exports = ${JSON.stringify(config, null, 2)};\n`, { flag: 'wx' });
    buildEvidence.configurations.push({ role, sha256: hash(await fs.readFile(configFile)) });
    await build({ projectDir: electronRoot, targets: Platform.WINDOWS.createTarget('nsis', arch === 'arm64' ? Arch.arm64 : Arch.x64), config: configFile, publish: 'never' });
    artifacts[role] = path.join(output, releaseAssetName(`win-${arch}`, version));
  }
  return { ...artifacts, buildEvidence, helperSource: path.join(electronRoot, 'dist-bundle/desktop-update-install-windows.mjs') };
}

export async function qualifyWindowsInstaller(directory) {
  if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch)) throw Error('Actual native Windows installer qualification required');
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') throw Error('Disposable GitHub-hosted Windows installer runner required');
  const requested = path.resolve(directory);
  assert.ok(requested.startsWith(path.join(repository, '.cache') + path.sep));
  await fs.mkdir(requested, { recursive: true });
  const parent = await fs.realpath(requested);
  assert.ok(parent.startsWith(path.join(repository, '.cache') + path.sep));
  const root = path.join(parent, 'installer-qualification'); await fs.mkdir(root, { recursive: false });
  const source = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
  const bound = await captureInstallerQualificationSource();
  const evidence = { protocol: 'devryan.windows-installer-evidence/1', source, version, arch: process.arch,
    status: 'blocked', acceptance: false, ...bound, prerequisites: [], scenarios: [], installer: null, baseline: null };
  const launcher = path.join(parent, `DevRyan-execution-win32-${process.arch}.exe`);
  let owner, nativeManifest, launcherPin, manifestPin;
  const check = async (id, action) => {
    const row = { id, status: 'failed' };
    try { row.result = await action(); row.status = 'passed'; } catch (error) { row.error = errorEvidence(error); }
    evidence.prerequisites.push(row); return row.status === 'passed';
  };
  // This is first: a failed directory flush must not be substituted with a
  // file flush, POSIX chmod, diagnostic marker or a packaging fixture.
  await check('namespace-durability', async () => {
    launcherPin = await artifactIdentity(launcher, 16 * 1024 * 1024);
    const manifestStat = await fs.lstat(launcher + '.json');
    assert.ok(manifestStat.isFile() && !manifestStat.isSymbolicLink() && manifestStat.nlink === 1 && manifestStat.size <= 65536);
    const bytes = await fs.readFile(launcher + '.json'); assert.equal(bytes.length, manifestStat.size); manifestPin = hash(bytes);
    nativeManifest = JSON.parse(bytes);
    assert.equal(nativeManifest.platform, 'win32'); assert.equal(nativeManifest.arch, process.arch);
    assert.equal(nativeManifest.version, 1); assert.equal(nativeManifest.policy, 3); assert.equal(nativeManifest.binary, path.basename(launcher));
    assert.equal(nativeManifest.sha256, launcherPin.sha256);
    assert.equal(nativeManifest.sourceSha256, hash(await fs.readFile(path.join(repository, 'packages/harness-runtime/native/session-execution-windows.c'))));
    owner = createWindowsUpdateOwner({ launcher });
    const fixture = path.join(root, 'native-prerequisites'); await owner.ensureDirectory(fixture);
    const namespace = await owner.namespace(path.join(fixture, 'probe'));
    assert.equal(namespace.directoryFlushed, true);
    return { namespace, supervisorSha256: launcherPin.sha256, manifestSha256: manifestPin, sourceSha256: nativeManifest.sourceSha256 };
  });
  await check('supervisor-acceptance', async () => {
    assert.equal(nativeManifest?.acceptance, true, 'Actual compiled supervisor safety acceptance required');
    return { acceptance: true, sha256: nativeManifest.sha256 };
  });
  await check('runtime-compatibility', async () => {
    const bytes = await fs.readFile(path.join(parent, 'runtime-compatibility/result.json')), value = JSON.parse(bytes);
    assert.equal(value.protocol, 'devryan.windows-runtime-compatibility/1'); assert.equal(value.source, source);
    assert.equal(value.arch, process.arch); assert.equal(value.status, 'passed'); assert.equal(value.admission, false); assert.equal(value.acceptance, false);
    assert.equal(value.supervisorSha256, nativeManifest?.sha256);
    assert.equal(value.sourceSha256, nativeManifest?.sourceSha256);
    assert.equal(value.rows.length, 16); assert.ok(value.rows.every(row => row.status === 'passed'));
    return { sha256: hash(bytes), rows: value.rows.length, admission: false };
  });
  await check('native-artifacts', async () => {
    const { verifyNativeRuntimeArtifacts } = await import('../packages/web/server/lib/opencode/runtime-host/native-artifacts.js');
    const native = path.join(repository, `packages/web/runtime/win32-${process.arch}`), manifestPath = path.join(native, 'native-bundle.json');
    const bytes = await fs.readFile(manifestPath);
    const verified = await verifyNativeRuntimeArtifacts({ manifestPath, manifestSha256: hash(bytes), launcher: path.join(native, `DevRyan-execution-win32-${process.arch}.exe`) });
    return { manifestSha256: hash(bytes), buildId: verified.manifest.buildId, coreDigest: verified.manifest.inputs.coreDigest };
  });
  if (evidence.prerequisites.every(row => row.status === 'passed')) {
    try {
      await refuseExistingInstallation(process.env);
      const built = await buildInstallers(root, process.arch, process.env);
      evidence.build = built.buildEvidence;
      evidence.installer = await artifactIdentity(built.candidate);
      evidence.baseline = { ...await artifactIdentity(built.baseline),
        provenance: 'same frozen source and version; qualification fixture, not a shipped previous release' };
      const privateInputs = path.join(root, 'private-inputs'); await owner.ensureDirectory(privateInputs);
      const baseline = await streamInstaller(owner, built.baseline, path.join(privateInputs, 'baseline.exe'));
      const candidate = await streamInstaller(owner, built.candidate, path.join(privateInputs, 'candidate.exe'));
      const nativeIdentity = evidence.prerequisites.find(row => row.id === 'native-artifacts').result;
      evidence.scenarios = await actualInstallerScenarios({ root, owner, baseline, candidate, arch: process.arch, helperSource: built.helperSource, environment: process.env, nativeIdentity });
      await fs.copyFile(built.candidate, path.join(root, evidence.installer.name));
    } catch (error) {
      evidence.buildError = errorEvidence(error);
      evidence.scenarios = WINDOWS_INSTALLER_SCENARIOS.map(id => ({ id, status: 'blocked', reason: 'installer_build_or_input_staging_failed' }));
    }
  } else evidence.scenarios = WINDOWS_INSTALLER_SCENARIOS.map(id => ({ id, status: 'blocked', reason: 'native_prerequisite_failed' }));
  const after = await captureInstallerQualificationSource();
  if (launcherPin && manifestPin) {
    try {
      assert.deepEqual(await artifactIdentity(launcher, 16 * 1024 * 1024), launcherPin);
      const manifestStat = await fs.lstat(launcher + '.json');
      assert.ok(manifestStat.isFile() && !manifestStat.isSymbolicLink() && manifestStat.nlink === 1 && manifestStat.size <= 65536);
      assert.equal(hash(await fs.readFile(launcher + '.json')), manifestPin);
    } catch (error) { evidence.nativeInputsChanged = errorEvidence(error); }
  }
  if (after.sourceTreeSha256 !== evidence.sourceTreeSha256) {
    evidence.sourceChanged = { before: evidence.sourceTreeSha256, after: after.sourceTreeSha256 };
    evidence.status = 'failed';
  } else evidence.status = evidence.nativeInputsChanged ? 'failed' : installerQualificationStatus(evidence.prerequisites, evidence.scenarios);
  evidence.acceptance = evidence.status === 'passed';
  const bytes = Buffer.from(JSON.stringify(evidence, null, 2) + '\n');
  await fs.writeFile(path.join(root, 'evidence.json'), bytes, { flag: 'wx' });
  const receipt = { protocol: 'devryan.windows-installer-qualification/1', source, version: evidence.version, arch: evidence.arch,
    status: evidence.status, acceptance: evidence.acceptance, sourceTreeSha256: evidence.sourceTreeSha256,
    evidenceSha256: hash(bytes), ...(evidence.installer ?? {}) };
  await fs.writeFile(path.join(root, 'qualification.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  return receipt;
}

async function updateHost(parameters) {
  if (process.platform !== 'win32') throw Error('Actual native Windows update host required');
  assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
  assert.deepEqual(Object.keys(parameters).sort(), ['arch', 'cache', 'candidate', 'directory', 'helperSource', 'launcher', 'nativeIdentity', 'target']);
  assert.ok(WINDOWS_INSTALLER_SCENARIOS.includes(path.win32.basename(parameters.directory)));
  assert.ok(parameters.directory.startsWith(path.join(repository, '.cache') + path.sep));
  assert.equal(await fs.realpath(parameters.directory), parameters.directory);
  assert.equal(parameters.target, path.join(path.dirname(parameters.directory), 'installation-root/DevRyan')); assert.equal(parameters.cache, path.join(parameters.directory, 'home/app-data/updates'));
  assert.equal(parameters.arch, process.arch);
  assert.deepEqual(Object.keys(parameters.nativeIdentity).sort(), ['buildId', 'coreDigest', 'manifestSha256']);
  assert.ok(Object.values(parameters.nativeIdentity).every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)));
  const owner = createWindowsUpdateOwner({ launcher: parameters.launcher });
  const source = await owner.file(parameters.candidate);
  const installer = createWindowsNsisInstaller({ installedDirectory: parameters.target, currentVersion: version, cacheDirectory: parameters.cache,
    arch: parameters.arch, owner, helperSource: parameters.helperSource, executable: path.join(parameters.target, 'DevRyan.exe'),
    verifyNativeArtifacts: ({ target, arch }) => verifyInstalled(target, arch, owner, parameters.nativeIdentity) });
  const prepared = await installer.prepare({ file: parameters.candidate, update: { version, size: source.size, sha256: source.token.split(':')[2] } });
  await installer.launchPrepared(prepared);
  process.stdout.write(JSON.stringify({ status: 'waiting', nonce: prepared.nonce }) + '\n');
  process.stdin.resume(); await new Promise(resolve => process.stdin.once('end', resolve));
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  if (process.argv.length === 4 && process.argv[2] === '--update-host') await updateHost(JSON.parse(process.argv[3]));
  else {
    if (process.argv.length !== 3) throw Error('Pass only the owned native supervisor output directory');
    const receipt = await qualifyWindowsInstaller(process.argv[2]);
    console.log(JSON.stringify(receipt)); process.exitCode = receipt.acceptance ? 0 : 1;
  }
}
