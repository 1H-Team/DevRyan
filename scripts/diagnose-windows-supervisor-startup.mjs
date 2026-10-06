// Trusted startup probes only. Diagnostic helpers never receive an acceptance
// marker, enter a runtime bundle or authorize execution. Production is untouched.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { windowsSessionExecutionProfile } from '../packages/harness-runtime/lib/session-execution.js';
import { ensureWindowsPrivateDirectory, createWindowsPrivateFile } from '../packages/harness-runtime/lib/windows-private-files.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exec = promisify(execFile);
export function supervisorStartupVariants(source) {
  if (typeof source !== 'string' || !source.includes('PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY')) {
    throw new Error('LPAC supervisor source required');
  }
  return [{ id: 'original-lpac', source }];
}

export async function runSupervisorStartupDiagnostic(directory) {
  if (process.platform !== 'win32') throw new Error('Native Windows startup diagnostic required');
  const output = path.resolve(directory ?? path.join(root, '.cache/windows-native', process.arch, 'supervisor-startup-diagnostic'));
  if (!output.startsWith(path.join(root, '.cache') + path.sep)) throw new Error('Repository-owned diagnostic directory required');
  if (await fs.realpath(path.dirname(output)) !== path.dirname(output)) throw new Error('Canonical diagnostic parent required');
  await fs.mkdir(output, { recursive: false });
  if (await fs.realpath(output) !== output) throw new Error('Canonical diagnostic directory required');
  const sourcePath = path.join(root, 'packages/harness-runtime/native/session-execution-windows.c');
  const source = await fs.readFile(sourcePath, 'utf8'), sourceSha256 = hash(source);
  const inputProfile = path.join(output, 'inputs'); await fs.mkdir(inputProfile);
  const environment = scratch => ({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT,
    HOME: scratch, USERPROFILE: scratch, LOCALAPPDATA: scratch, APPDATA: scratch,
    TMP: scratch, TEMP: scratch, TMPDIR: scratch });
  const bun = spawnSync('bun', ['-e', 'process.stdout.write(JSON.stringify({version:Bun.version,arch:process.arch,path:process.execPath}))'],
    { cwd: inputProfile, env: environment(inputProfile), encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
  if (bun.error || bun.status !== 0) throw new Error('Pinned native Bun identity unavailable');
  const bunIdentity = JSON.parse(bun.stdout);
  if (bunIdentity.version !== '1.3.14' || bunIdentity.arch !== process.arch || !path.isAbsolute(bunIdentity.path)) throw new Error('Pinned native Bun identity invalid');
  const runtimes = [{ id: 'node', executable: process.execPath, version: process.versions.node },
    { id: 'bun', executable: bunIdentity.path, version: bunIdentity.version }];
  for (const runtime of runtimes) runtime.sha256 = hash(await fs.readFile(runtime.executable));
  const variants = [];
  for (const variant of supervisorStartupVariants(source)) {
    const candidate = path.join(output, variant.id); await fs.mkdir(candidate);
    const candidateSource = path.join(candidate, 'supervisor.c'), executable = path.join(candidate, 'DevRyan-diagnostic-supervisor.exe');
    await fs.writeFile(candidateSource, variant.source, { flag: 'wx' });
    const row = { id: variant.id, sourceSha256: hash(variant.source), admission: false, acceptance: false, runs: [] };
    try {
      const compiled = await exec('cl.exe', ['/nologo', '/std:c11', '/W4', '/WX', '/O2', '/D_CRT_SECURE_NO_WARNINGS',
        candidateSource, `/Fe:${executable}`, `/Fo:${path.join(candidate, 'supervisor.obj')}`, '/link', 'advapi32.lib', 'user32.lib', 'userenv.lib', 'onecoreuap.lib'],
      { cwd: root, timeout: 60000, maxBuffer: 65536 });
      await fs.writeFile(path.join(candidate, 'compile.log'), compiled.stdout + compiled.stderr);
      row.compilation = 'passed'; row.binarySha256 = hash(await fs.readFile(executable));
    } catch (error) {
      row.compilation = 'failed'; row.errorCode = error.code ?? null;
      await fs.writeFile(path.join(candidate, 'compile-failure.log'), (error.stdout ?? '') + (error.stderr ?? ''));
      variants.push(row); continue;
    }
    for (const runtime of runtimes) {
        const fixture = path.join(candidate, runtime.id); await ensureWindowsPrivateDirectory(executable, fixture);
        const view = path.join(fixture, 'view'), scratch = path.join(fixture, 'scratch');
        await ensureWindowsPrivateDirectory(executable, view); await ensureWindowsPrivateDirectory(executable, scratch);
        const profile = path.join(fixture, 'diagnostic-profile'), receiptPath = path.join(fixture, 'termination.json');
        await createWindowsPrivateFile(executable, profile, windowsSessionExecutionProfile({ viewDirectory: view, scratchDirectory: scratch, auxiliaryDirectory: scratch }));
        const marker = `DevRyan startup diagnostic ${variant.id}/${runtime.id}\n`;
        const result = spawnSync(executable, [view, scratch, profile, receiptPath, '--', runtime.executable, '-e',
          `process.stdout.write(${JSON.stringify(marker)});`], { cwd: view, encoding: 'utf8', timeout: 15000, maxBuffer: 65536,
          env: { ...environment(scratch), DEVRYAN_EXECUTION_CWD: view, DEVRYAN_EXECUTION_CACHE: scratch,
            DEVRYAN_EXECUTION_CANCEL_EVENT: `Local\\DevRyan-diagnostic-${randomUUID()}` } });
        await fs.writeFile(path.join(fixture, 'stdout.log'), result.stdout ?? '');
        await fs.writeFile(path.join(fixture, 'stderr.log'), result.stderr ?? '');
        const receiptBytes = await fs.readFile(receiptPath).catch(error => {
          if (error.code === 'ENOENT') return null; throw error;
        });
        let receipt = null, receiptStatus = receiptBytes === null ? 'missing' : receiptBytes.length === 0 ? 'empty' : 'invalid';
        if (receiptBytes?.length && receiptBytes.length <= 4096) {
          try {
            const value = JSON.parse(receiptBytes.toString('utf8'));
            if (value && Object.keys(value).sort().join(',') === 'cancelled,confined,exitCode,terminated'
              && typeof value.terminated === 'boolean' && typeof value.confined === 'boolean' && typeof value.cancelled === 'boolean'
              && Number.isInteger(value.exitCode) && value.exitCode >= 0 && value.exitCode <= 0xffffffff) {
              receipt = value; receiptStatus = 'recorded';
            }
          } catch { /* Retain the original partial receipt as diagnostic evidence. */ }
        }
        const started = !result.error && result.status === 0 && result.stdout === marker
          && receipt?.terminated === true && receipt.cancelled === false && receipt.exitCode === 0;
        const refusal = /^([a-z ]{1,80}) failed \(([0-9]{1,10})\)$/.exec((result.stderr ?? '').trim());
        row.runs.push({ runtime: runtime.id, status: started ? 'started' : 'refused', exitCode: result.status,
          errorCode: result.error?.code ?? null, receipt, receiptStatus,
          receiptSha256: receiptBytes === null ? null : hash(receiptBytes), receiptAcceptedForAdmission: false,
          stdoutSha256: hash(result.stdout ?? ''), stderrSha256: hash(result.stderr ?? ''),
          ...(refusal ? { refusal: { operation: refusal[1], windowsError: Number(refusal[2]) } } : {}) });
    }
    variants.push(row);
  }
  if (hash(await fs.readFile(sourcePath)) !== sourceSha256) throw new Error('Production supervisor changed during diagnostic');
  const result = { schema: 1, status: 'diagnostic-completed', platform: process.platform, arch: process.arch,
    admission: false, acceptance: false, sourceSha256, runtimes, variants,
    excluded: ['read confinement', 'integrity-policy qualification', 'process-security qualification', 'desktop-security qualification', 'descendant containment qualification', 'standard-user and concurrent station ownership', 'runtime acceptance'] };
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3) throw new Error('Pass only the owned diagnostic output directory');
  const result = await runSupervisorStartupDiagnostic(process.argv[2]);
  console.log(JSON.stringify({ status: result.status, admission: false, variants: result.variants.map(v =>
    ({ id: v.id, compilation: v.compilation, runs: v.runs.map(r => ({ runtime: r.runtime, status: r.status, exitCode: r.exitCode, refusal: r.refusal })) })) }));
}
