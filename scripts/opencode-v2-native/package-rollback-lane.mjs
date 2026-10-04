import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixtureSha256 } from './migration-fixture.mjs';
import { processIdentity } from '../../packages/web/server/lib/opencode/runtime-host/bundle-rollback-intent.js';
import { createQaHostLaunchEnvironment } from '../qa/launch-environment.mjs';

/** Hash bytes, mode and link identity without traversing a link into another root. */
export async function snapshotOwnedTree(directory) {
  const rows = [];
  const walk = async relative => {
    for (const name of (await fs.readdir(path.join(directory, relative))).sort()) {
      const child = path.join(relative, name), file = path.join(directory, child), stat = await fs.lstat(file);
      if (stat.isDirectory()) await walk(child);
      else if (stat.isSymbolicLink()) rows.push({ path: child, link: await fs.readlink(file) });
      else { assert.ok(stat.isFile()); rows.push({ path: child, mode: stat.mode & 0o777, sha256: fixtureSha256(await fs.readFile(file)) }); }
    }
  };
  await walk(''); return rows;
}

/** Start the actual selected v2 lifecycle in a fresh private process before module imports. */
export async function runSelectedNativeLifecycle({ controlRoot, descriptor, configuration, fixture, logFile, sessionIDs = [], seedInput, rollback, readProcessIdentity = processIdentity }) {
  const globals = descriptor.launch.global;
  const environment = createQaHostLaunchEnvironment(fixture.environment, {
    DEVRYAN_RUNTIME_BUNDLE_ROOT: controlRoot, OPENCHAMBER_DATA_DIR: descriptor.launch.webDataDirectory,
    OPENCODE_DISABLE_MODELS_FETCH: 'true',
    HOME: globals.home, XDG_CONFIG_HOME: path.dirname(globals.config), XDG_DATA_HOME: path.dirname(globals.data),
    XDG_STATE_HOME: path.dirname(globals.state), XDG_CACHE_HOME: path.dirname(globals.cache),
    TMPDIR: globals.tmp, TMP: globals.tmp, TEMP: globals.tmp,
  });
  const driver = fileURLToPath(new URL('./legacy-lifecycle-driver.mjs', import.meta.url));
  const evidencePath = logFile + '.pids.json';
  const child = spawn(process.execPath, [driver], { cwd: fixture.root, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
  const chunks = [], errors = []; let bytes = 0, timedOut = false, settled = false, spawnError, failure, hostIdentity, force;
  const closed = new Promise(resolve => {
    child.once('error', error => { spawnError = error; });
    child.once('close', (code, signal) => { settled = true; resolve({ code, signal }); });
  });
  const terminate = () => {
    if (settled || !child.pid) return;
    child.kill('SIGTERM'); force ??= setTimeout(() => { if (!settled) child.kill('SIGKILL'); }, 5000);
  };
  child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes <= 65536) chunks.push(chunk); else child.kill('SIGTERM'); });
  child.stderr.on('data', chunk => { if (errors.reduce((n, value) => n + value.length, 0) < 4 * 1024 * 1024) errors.push(chunk); });
  child.stdin.on('error', error => { failure ??= error; terminate(); });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 120000);
  let exit;
  try {
    assert.ok(child.pid, 'Selected native lifecycle spawn did not create a process');
    hostIdentity = readProcessIdentity(child.pid); assert.equal(hostIdentity?.pid, child.pid);
    child.stdin.end(JSON.stringify({ bundleID: descriptor.bundleID, configuration,
      sessionIDs, seedInput, evidencePath, ...(rollback ? { rollback } : {}) }));
    exit = await closed;
    if (spawnError) failure ??= spawnError;
  } catch (error) {
    failure ??= error; child.stdin.destroy(); terminate(); exit = await closed;
  } finally { clearTimeout(timer); clearTimeout(force); }
  await fs.writeFile(logFile, Buffer.concat(errors));
  await fs.writeFile(logFile + '.exit.json', JSON.stringify({ pid: child.pid ?? null,
    hostIdentity: hostIdentity ?? null, ...exit, spawnError: spawnError?.code ?? null, timedOut,
    failure: failure ? 'selected_native_lifecycle_failed' : null }) + '\n');
  // The product watchdog handles unexpected parent death. Check independently
  // that every real native controller PID captured by the private driver is now gone.
  let records = [];
  try { records = JSON.parse(await fs.readFile(evidencePath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const deadline = Date.now() + 10000;
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
  while (records.some(record => alive(record.childPid)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(records.some(record => alive(record.childPid)), false, 'Selected native lifecycle left a companion process alive');
  if (failure) throw failure;
  assert.equal(timedOut, false, 'Selected native lifecycle timed out'); assert.ok(bytes <= 65536);
  assert.equal(exit.code, 0, `Selected native lifecycle failed; inspect ${logFile}`); assert.equal(exit.signal, null);
  const lines = Buffer.concat(chunks).toString('utf8').trim().split('\n'); assert.equal(lines.length, 1);
  const result = JSON.parse(lines[0]); assert.equal(result.status, 'passed'); assert.ok(records.length === 2);
  return { ...result, hostIdentity, exit, controllerPIDs: records.map(record => record.childPid), actualExitConfirmed: true };
}
