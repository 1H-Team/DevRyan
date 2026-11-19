// One SIGKILL of a driver run (BH2 self-test only): starts toy/driver-child.mjs,
// waits until it is where `mode` puts it, kills it with SIGKILL (and, with
// `keeperToo`, kills its keeper first, so that only the next run's sweep is
// left to clean up), then shows what is left. Every wait has a deadline that
// names what did not happen and carries the child's last output. Whatever
// happens, everything this run started is continued and killed before it
// returns (by the pids and groups it announced, never by name).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBackendRun } from '../run-scratch.mjs';
import { groupAlive, groupMembers, liveOnly, processTable, signalGroup } from '../tree.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(HERE, '../../..');
const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const calls = (file) => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; } };

/** Polls `test` until it is true; throws naming `what` (and `context()`) after `ms`. */
export async function until(test, what, { ms = 60_000, context = () => '' } = {}) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await test()) return;
    if (Date.now() > deadline) throw new Error(`${what} within ${ms} ms${context() ? `\n${context()}` : ''}`);
    await pause(20);
  }
}

/**
 * `{ mode, arm, keeperToo, parent }` -> what was seen: `{ frozenAtKill, frozenAfterKill, groupGoneAlone, runLeft,
 * groupsAfterSweep (groups with a member that can still run), zombieGroupsAfterSweep (groups with only unreaped
 * zombies), runAfterSweep, keepersAlive, describe }`.
 * mode: hang | frozen | restart; arm: fake | reference.
 */
export async function sigkillOnce({ mode, arm = 'fake', keeperToo = false, parent }) {
  // The killed run lives in `parent`, a private directory of the caller's: no other run's sweep touches it.
  const child = spawn(process.execPath, [path.join(HERE, 'driver-child.mjs'), mode, `--arm=${arm}`, `--parent=${parent}`], { cwd: REPOSITORY_ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const lines = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; let newline; while ((newline = stdout.indexOf('\n')) >= 0) { try { lines.push(JSON.parse(stdout.slice(0, newline))); } catch { /* product output */ } stdout = stdout.slice(newline + 1); } });
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
  let exited = false;
  child.once('exit', () => { exited = true; });
  const describe = () => `driver child pid ${child.pid} (${mode}, ${arm})${exited ? ', exited' : ''}; its last lines: ${JSON.stringify(lines.slice(-3))}; stderr: ${stderr.slice(-1500)}`;
  const groups = () => lines.filter((line) => line.started).map((line) => line.started.pgid);
  const keepers = () => [...new Set(lines.flatMap((line) => [line.started?.keeper, line.waiting?.keeper]).filter(Number.isInteger))];
  const cleanUp = () => {
    for (const pgid of groups()) { try { signalGroup(pgid, 'SIGCONT'); signalGroup(pgid, 'SIGKILL'); } catch { /* gone */ } }
    for (const pid of keepers()) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    if (!exited) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  };
  try {
    await until(() => lines.some((line) => line.waiting) || exited, 'the driver child did not reach its waiting point', { ms: 120_000, context: describe });
    const waiting = lines.find((line) => line.waiting)?.waiting;
    if (!waiting) throw new Error(`the driver child exited before its waiting point\n${describe()}`);
    if (mode === 'hang' && arm === 'fake') await until(() => calls(waiting.log).some((entry) => entry.url === '/hang'), 'the hang request did not reach the fake', { context: describe });
    const frozenAtKill = groupMembers(waiting.pgid).every((member) => member.state.startsWith('T'));
    if (keeperToo) {
      for (const pid of keepers()) process.kill(pid, 'SIGKILL');
      await until(() => keepers().every((pid) => !alive(pid)), `the keeper ${keepers()} did not die by SIGKILL`, { context: describe });
    }
    child.kill('SIGKILL');
    await until(() => exited, 'the driver child did not die by SIGKILL', { context: describe });
    const frozenRightAfter = groups().some((pgid) => groupAlive(pgid) && groupMembers(pgid).some((member) => member.state.startsWith('T')));
    let groupGoneAlone = null;
    if (!keeperToo) {
      // The keeper alone: every group of the run gone and the keeper exited, with no other run.
      await until(() => groups().every((pgid) => !groupAlive(pgid)), `the keeper did not kill groups ${groups()}`, { context: () => `${describe()}\nmembers: ${JSON.stringify(groups().map((pgid) => groupMembers(pgid)))}` });
      await until(() => keepers().every((pid) => !alive(pid)), `the keeper ${keepers()} did not exit after its pipe closed`, { context: describe });
      groupGoneAlone = true;
    } else {
      // No keeper: a frozen arm stays frozen (nothing else can continue it) until the next run's sweep.
      groupGoneAlone = groups().every((pgid) => !groupAlive(pgid));
    }
    // Without the keeper, a frozen arm is still stopped now (nothing else continues it).
    const frozenAfterKill = frozenRightAfter && groups().some((pgid) => groupAlive(pgid) && groupMembers(pgid).some((member) => member.state.startsWith('T')));
    const runLeft = fs.existsSync(waiting.run);
    // The next run in the same parent: its sweep kills what the killed run recorded, then removes the directory.
    const next = createBackendRun({ owner: 'backend-conformance-sigkill-next', signals: 'exit', parent });
    next.finish('passed');
    // The sweep is synchronous: when it returns, no member of a recorded group can still run. That is what
    // "left" means here. A killed member stays a zombie until its parent reaps it, and the harness that started
    // it is dead, so that parent is init: Linux counts such a zombie as a member of its group until then
    // (macOS does not), so asking whether the group exists right after the sweep races init. The members are
    // read once, from one process table, and their states go into the description.
    const table = processTable();
    const afterSweep = groups().map((pgid) => ({ pgid, members: groupMembers(pgid, table) })).filter((group) => group.members.length > 0);
    const groupsAfterSweep = afterSweep.filter((group) => liveOnly(group.members).length > 0).map((group) => group.pgid);
    const zombieGroupsAfterSweep = afterSweep.length - groupsAfterSweep.length;
    const runAfterSweep = fs.existsSync(waiting.run);
    return { mode, arm, keeperToo, frozenAtKill, frozenAfterKill, groupGoneAlone, runLeft, groupsAfterSweep, zombieGroupsAfterSweep, runAfterSweep, keepersAlive: keepers().filter(alive), describe: `${describe()}; members after the sweep: ${JSON.stringify(afterSweep)}` };
  } finally { cleanUp(); }
}
