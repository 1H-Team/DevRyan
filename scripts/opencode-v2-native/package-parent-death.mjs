import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { toolTurn } from './assertions.mjs';
import { waitFor } from './process-lanes.mjs';
import { createV2MessageId } from '../../packages/web/server/lib/opencode/v2/admission.js';
import { createQaHostLaunchEnvironment } from '../qa/launch-environment.mjs';
import { readManagedOpenCodeRegistry, reapOrphanedManagedOpenCodeProcesses } from '../../packages/web/server/lib/opencode/managed-process-registry.js';
import { createFixtureJournal } from './fixture-journal.mjs';

const exec = promisify(execFile);
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };

/** Pause an actual compiled tool only after its confined shell is alive in a private view. */
export async function prepareCompiledParentDeathProbe({ root, provider, client, host, controller, descriptor, directory, sessionID, journal, inheritedJournals = [] }) {
  const callID = 'native_compiled-parent-death', turn = toolTurn('shell', {
    command: "printf '%s' $$ > owner-death.pid; sleep 120; printf 'must not publish\\n' > owner-death-published.txt",
  }, 'compiled-parent-death');
  await provider.setResponder(turn.responder);
  await client.prompts.prompt(sessionID, { messageID: createV2MessageId(), variant: 'default',
    model: { providerID: 'devryan-smoke', modelID: 'smoke-write' }, parts: [{ type: 'text', text: turn.marker }] },
  { directory, origin: 'native_acceptance', timeoutMs: 30000 });
  const lease = await waitFor(() => host.runtime.leaseForCall({ directory, sessionID, callID }), value => value?.state === 'ready',
    'Parent-death lane did not acquire its actual process lease');
  const shellPID = await waitFor(async () => {
    try { return Number(await fs.readFile(path.join(lease.viewDirectory, 'owner-death.pid'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }, value => Number.isSafeInteger(value) && value > 0 && alive(value), 'Parent-death confined shell never became alive');
  await assert.rejects(fs.stat(path.join(directory, 'owner-death-published.txt')), error => error.code === 'ENOENT');
  assert.equal(controller.hasExited(), false);
  // Everything accepted before this summary is durable before the crash; the
  // still-open chunk is sealed afterwards only by the owner's own recovery.
  const flushed = journal.summary();
  await journal.flush();
  return { root, directory, sessionID, callID, shellPID, controllerPID: controller.pid, instanceID: controller.instanceID,
    journal: { directory: journal.journalDirectory, flushed, inherited: inheritedJournals },
    controllerReceiptPath: path.join(path.dirname(descriptor.preparedManifestPath), '.native-controller', controller.instanceID, 'termination.json'),
    workerReceiptPath: path.join(path.dirname(lease.viewDirectory), 'termination.json'),
    registryPath: path.join(descriptor.launch.global.state, 'managed-opencode-processes.json') };
}

/** SIGKILL only a fresh owned QA Node owner; production launchers independently attest its descendants' termination. */
export async function runCompiledParentDeath({ artifactRoot, root, environment }) {
  const privateRoot = path.join(root, 'parent-death-owner'); await fs.mkdir(privateRoot);
  const globals = Object.fromEntries(['home','config','data','state','cache','tmp'].map(key => [key, path.join(privateRoot, key)]));
  for (const directory of Object.values(globals)) await fs.mkdir(directory);
  await fs.writeFile(path.join(globals.tmp, 'package.json'), '{"type":"commonjs"}\n');
  const env = createQaHostLaunchEnvironment(environment, { HOME: globals.home, XDG_CONFIG_HOME: globals.config,
    XDG_DATA_HOME: globals.data, XDG_STATE_HOME: globals.state, XDG_CACHE_HOME: globals.cache,
    TMPDIR: globals.tmp, TMP: globals.tmp, TEMP: globals.tmp });
  const driver = fileURLToPath(new URL('./package-parent-death-driver.mjs', import.meta.url));
  const child = fork(driver, [], { cwd: root, env, execArgv: [], stdio: ['pipe','ignore','pipe','ipc'] });
  const errors = []; let stderrBytes = 0, evidence, killed = false;
  child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes <= 4 * 1024 * 1024) errors.push(chunk); });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  void exited.catch(() => {});
  try {
    const ready = new Promise((resolve, reject) => {
      child.once('message', value => { if (value?.type === 'parent-death-ready') resolve(value.evidence); else reject(new Error('Invalid parent-death probe response')); });
      void exited.then(exit => reject(Object.assign(new Error('Parent-death probe exited before its actual tool became alive'), { exit })), reject);
    });
    child.stdin.end(JSON.stringify({ artifactRoot }));
    evidence = await waitFor(() => Promise.race([ready, Promise.resolve(null)]), value => value !== null,
      'Parent-death probe did not reach its actual compiled tool', 120000);
    assert.ok(evidence.root.startsWith(path.dirname(root) + path.sep));
    for (const key of ['directory','controllerReceiptPath','workerReceiptPath','registryPath']) assert.ok(evidence[key].startsWith(evidence.root + path.sep));
    assert.ok(evidence.journal.directory.startsWith(evidence.root + path.sep) && path.basename(evidence.journal.directory) === 'journal');
    const registry = { registryPath: evidence.registryPath };
    const registered = readManagedOpenCodeRegistry(registry);
    assert.equal(registered.length, 1); assert.equal(registered[0].ownerPid, child.pid); assert.equal(registered[0].childPid, evidence.controllerPID);
    assert.ok([evidence.shellPID, evidence.controllerPID].every(pid => Number.isSafeInteger(pid) && pid > 0 && alive(pid)));
    const descendants = [];
    const collect = async pid => {
      let output;
      try { output = (await exec('/usr/bin/pgrep', ['-P', String(pid)], { timeout: 5000, maxBuffer: 65536 })).stdout; }
      catch (error) { if (error.code === 1) return; throw error; }
      for (const value of output.trim().split('\n').filter(Boolean)) { const childPID = Number(value); assert.ok(Number.isSafeInteger(childPID)); descendants.push(childPID); await collect(childPID); }
    };
    await collect(child.pid);
    assert.ok(descendants.includes(evidence.controllerPID) && descendants.includes(evidence.shellPID),
      'Owned Node descendant snapshot omitted the actual controller or confined worker shell');
    child.kill('SIGKILL'); killed = true;
    assert.deepEqual(await exited, { code: null, signal: 'SIGKILL' });
    const receipts = [];
    for (const receiptPath of [evidence.controllerReceiptPath, evidence.workerReceiptPath]) {
      const receipt = await waitFor(async () => { try { return JSON.parse(await fs.readFile(receiptPath, 'utf8')); }
        catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; } },
      value => value?.terminated === true, 'Owner death did not publish the real supervisor termination receipt', 15000);
      assert.equal(receipt.confined, true); assert.equal(receipt.cancelled, true); assert.equal(receipt.exitCode, 137); receipts.push({ path: receiptPath, ...receipt });
    }
    const pids = [...new Set([evidence.shellPID, evidence.controllerPID, ...descendants])];
    await waitFor(() => pids.every(pid => !alive(pid)), value => value, 'Parent death left an owned native descendant alive', 15000);
    const reaped = await reapOrphanedManagedOpenCodeProcesses(registry); assert.deepEqual(reaped.kept, []);
    assert.deepEqual(readManagedOpenCodeRegistry(registry), []);
    await assert.rejects(fs.stat(path.join(evidence.directory, 'owner-death-published.txt')), error => error.code === 'ENOENT');
    // The next owner's journal initialization is the product recovery that seals
    // the killed owner's open chunks; it records nothing itself.
    const recovery = await createFixtureJournal({ webDataDirectory: path.dirname(path.dirname(evidence.journal.directory)), label: 'fixture-pd-recovery' });
    await recovery.drain();
    evidence.journal = { ...evidence.journal, recovery: recovery.summary() };
    return { id: 'compiled-parent-death-drain', status: 'passed', ownerPID: child.pid, ...evidence,
      terminatedPIDs: pids, receipts, registryEmpty: true, source: 'actual-Node-owner-SIGKILL-and-independent-confined-supervisor-receipts' };
  } finally {
    if (!killed && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    await fs.writeFile(path.join(privateRoot, 'owner.log'), Buffer.concat(errors));
  }
}
