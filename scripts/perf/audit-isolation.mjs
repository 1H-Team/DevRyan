import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { cp, lstat, mkdir, readdir, readFile, readlink, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');
const inside = (root, target) => target === root || target.startsWith(root + path.sep);

// Hash names as well as contents: provider configuration may contain private
// filenames. Reading does not make access-time changes an isolation failure.
export async function captureAuditConfigManifest(roots) {
  const entries = [], visited = new Set();
  const visit = async (absolute, identity) => {
    let stats;
    try { stats = await lstat(absolute); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      entries.push({ identity: hash(identity), missing: true }); return;
    }
    const metadata = { identity: hash(identity), mode: stats.mode, uid: stats.uid, gid: stats.gid,
      dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs };
    if (stats.isSymbolicLink()) {
      const link = await readlink(absolute);
      entries.push({ ...metadata, kind: 'symlink', targetSha256: hash(link) });
      const resolved = path.resolve(path.dirname(absolute), link);
      if (!visited.has(resolved)) { visited.add(resolved); await visit(resolved, `${identity}/resolved`); }
    } else if (stats.isDirectory()) {
      entries.push({ ...metadata, kind: 'directory' });
      for (const name of (await readdir(absolute)).sort()) await visit(path.join(absolute, name), `${identity}/${name}`);
    } else if (stats.isFile()) {
      const bytes = await readFile(absolute), after = await lstat(absolute);
      assert.equal(after.ino, stats.ino, 'Configuration changed during isolation snapshot');
      assert.equal(after.mtimeMs, stats.mtimeMs, 'Configuration changed during isolation snapshot');
      assert.equal(after.ctimeMs, stats.ctimeMs, 'Configuration changed during isolation snapshot');
      entries.push({ ...metadata, kind: 'file', sha256: hash(bytes) });
    } else entries.push({ ...metadata, kind: 'special' });
  };
  for (const [index, root] of roots.entries()) await visit(path.resolve(root), `root-${index}`);
  return { schemaVersion: 1, sha256: hash(JSON.stringify(entries)), entries };
}

export const auditConfigRoots = (home = os.homedir()) => ['opencode', 'devryan', 'openchamber']
  .map(name => path.join(home, '.config', name));

export function assertAuditConfigUnchanged(before, after) {
  assert.equal(after.sha256, before.sha256,
    'Real configuration changed: stop affected runs; do not restore over the running user app');
}

// Every copied link must resolve inside the copied arm. cp preserves relative
// workspace links; dereferencing would silently share native rebuild outputs.
export async function assertAuditDependencyLinks(checkout) {
  const canonical = await realpath(checkout);
  const visit = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const link = await readlink(absolute);
        assert.ok(!path.isAbsolute(link), 'Audit dependency link must be relative');
        assert.ok(inside(canonical, await realpath(absolute)), 'Audit dependency link escapes its arm');
      } else if (entry.isDirectory()) await visit(absolute);
    }
  };
  for (const directory of ['node_modules', ...(await readdir(path.join(canonical, 'packages')))
    .map(name => path.join('packages', name, 'node_modules'))]) {
    try { await visit(path.join(canonical, directory)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export async function cloneAuditDependencies(source, target) {
  for (const relative of ['node_modules', ...(await readdir(path.join(source, 'packages')))
    .map(name => path.join('packages', name, 'node_modules'))]) {
    try { await lstat(path.join(source, relative)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    await cp(path.join(source, relative), path.join(target, relative), {
      recursive: true, dereference: false, verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
      errorOnExist: true, force: false,
    });
  }
  // Reconcile the arm against its own frozen lockfile before validating links.
  // Install scripts are intentionally absent: they can sign/rebuild shared or
  // global state. Native preparation is a later, arm-owned operation.
  await mkdir(path.join(target, '.audit-install-home'), { mode: 0o700 });
  execFileSync('bun', ['install', '--frozen-lockfile', '--ignore-scripts'], {
    cwd: target, stdio: 'pipe', env: { PATH: process.env.PATH, HOME: path.join(target, '.audit-install-home'),
      DEVRYAN_SKIP_INSTALL_PREPARE: '1', OPENCHAMBER_SKIP_INSTALL_PREPARE: '1' },
  });
  await assertAuditDependencyLinks(target);
}

// Keep command arguments out of evidence: the user's running app can carry
// private paths. %CPU, executable basename and ancestry are sufficient here.
const cpuSeconds = text => {
  const fields = text.split(':').map(Number);
  return fields.reduce((seconds, value) => seconds * 60 + value, 0);
};
export function captureAuditHostLoad({ excludedPids = [], previous } = {}) {
  const observedAt = performance.now();
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,%cpu=,time=,comm='], { encoding: 'utf8' })
    .trim().split('\n').flatMap(line => {
      const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+([\d:.]+)\s+(.+)$/.exec(line);
      return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), cpu: Number(match[3]),
        cpuSeconds: cpuSeconds(match[4]), executable: path.basename(match[5]) }] : [];
    });
  const descendants = roots => {
    const pids = new Set(roots);
    for (let size = -1; size !== pids.size;) {
      size = pids.size;
      for (const row of rows) if (pids.has(row.ppid)) pids.add(row.pid);
    }
    return pids;
  };
  const excluded = descendants([...excludedPids, process.pid]);
  const app = descendants(rows.filter(row => /^(DevRyan|OpenChamber)(?: Helper.*)?$/.test(row.executable)
    && !excluded.has(row.pid)).map(row => row.pid));
  const otherProcesses = rows.filter(row => !excluded.has(row.pid));
  const userAppProcesses = rows.filter(row => app.has(row.pid));
  const intervalCpu = processes => {
    if (!previous) return null;
    const prior = new Map(previous.otherProcesses.map(row => [row.pid, row]));
    const deltaSeconds = processes.reduce((sum, row) => {
      const before = prior.get(row.pid);
      return sum + (before?.executable === row.executable ? Math.max(0, row.cpuSeconds - before.cpuSeconds) : row.cpuSeconds);
    }, 0);
    return deltaSeconds / ((observedAt - previous.observedAt) / 1000) * 100;
  };
  return { at: new Date().toISOString(), observedAt, logicalCpus: os.cpus().length, loadAverage: os.loadavg(),
    totalOtherCpuPercent: otherProcesses.reduce((sum, row) => sum + row.cpu, 0),
    userAppCpuPercent: userAppProcesses.reduce((sum, row) => sum + row.cpu, 0),
    intervalOtherCpuPercent: intervalCpu(otherProcesses), intervalUserAppCpuPercent: intervalCpu(userAppProcesses),
    otherProcesses, userAppProcesses,
    source: 'ps cumulative CPU time differences at one-second cadence; lifetime %CPU retained separately; exited-process CPU unavailable' };
}

// Limits are declared before calibration and applied to either arm. Host CPU
// is expressed as a fraction of all logical CPUs; app CPU uses one-core units.
export const AUDIT_CONTAMINATION_LIMITS = Object.freeze({ hostCpuFraction: 0.25, userAppCpuPercent: 50,
  consecutiveSamples: 2, sampleIntervalMs: 1000 });

export function gradeAuditHostLoad(samples) {
  let consecutive = 0;
  for (const sample of samples) {
    const high = (sample.intervalOtherCpuPercent ?? sample.totalOtherCpuPercent) > sample.logicalCpus * 100 * AUDIT_CONTAMINATION_LIMITS.hostCpuFraction
      || (sample.intervalUserAppCpuPercent ?? sample.userAppCpuPercent) > AUDIT_CONTAMINATION_LIMITS.userAppCpuPercent;
    consecutive = high ? consecutive + 1 : 0;
    if (consecutive >= AUDIT_CONTAMINATION_LIMITS.consecutiveSamples) return 'contaminated';
  }
  return samples.length >= 2 ? 'accepted' : 'unqualified';
}

/** Run only after all audit agents have acknowledged idle. Never signals the user's app. */
export async function runAuditCommand({ command, args, cwd, environment, evidenceDirectory, label, realConfigRoots = auditConfigRoots() }) {
  assert.match(label, /^[a-z0-9-]+$/);
  assert.ok(path.isAbsolute(environment.HOME ?? '') && environment.HOME !== os.homedir(), 'A private runner HOME is required');
  for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'TMPDIR']) {
    assert.ok(typeof environment[key] === 'string' && inside(environment.HOME, environment[key]), `${key} must be private`);
  }
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  const before = await captureAuditConfigManifest(realConfigRoots);
  await writeFile(path.join(evidenceDirectory, `${label}-config-before.json`), JSON.stringify(before), { mode: 0o600 });
  const samples = [], output = [];
  let overflow = false, observationFailed = false, child;
  const sample = () => {
    try { samples.push(captureAuditHostLoad({ excludedPids: child?.pid ? [child.pid] : [], previous: samples.at(-1) })); }
    catch { observationFailed = true; }
  };
  sample();
  const timer = setInterval(sample, AUDIT_CONTAMINATION_LIMITS.sampleIntervalMs);
  let result;
  try {
    child = spawn(command, args, { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let bytes = 0;
    const append = chunk => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) { overflow = true; return; }
      output.push(chunk);
    };
    child.stdout.on('data', append); child.stderr.on('data', append);
    result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
    });
  } finally {
    clearInterval(timer); sample();
    const after = await captureAuditConfigManifest(realConfigRoots);
    await writeFile(path.join(evidenceDirectory, `${label}-config-after.json`), JSON.stringify(after), { mode: 0o600 });
    const isolation = before.sha256 === after.sha256 ? 'unchanged' : 'changed';
    const evidence = { ...result, isolation, hostLoad: observationFailed ? 'unqualified' : gradeAuditHostLoad(samples),
      contaminationLimits: AUDIT_CONTAMINATION_LIMITS, samples, outputOverflow: overflow };
    await writeFile(path.join(evidenceDirectory, `${label}-window.json`), JSON.stringify(evidence, null, 2), { mode: 0o600 });
    await writeFile(path.join(evidenceDirectory, `${label}.log`), Buffer.concat(output), { mode: 0o600 });
    assertAuditConfigUnchanged(before, after);
    result = evidence;
  }
  return result;
}
