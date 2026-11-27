// The child processes the tools of the client engine conformance harness start
// (the `bun test` runs of record.mjs runBunTests and the engine processes of
// engine.mjs openEngine, both under the test isolation guard), so that an
// interrupted tool stops them before its run root is removed (record.mjs
// createScratch). Each child is started in a process group of its own
// (`detached`), so the group (the guard and the `bun` below it) can be
// signalled as one when the guard does not answer its own signal.
//
// Stopping is in two stages: SIGTERM to the child itself (the guard forwards it
// to its `bun` and removes its own isolation root), then, for a child still
// running after STOP_GRACE_MS, SIGKILL to its whole group. An exit hook sends
// the first stage to every child still running when the process exits by any
// other path, so no child outlives a tool that forgot to stop it.
import { spawn } from 'node:child_process';

const live = new Set();
/** How long a child has to stop after SIGTERM before its group is killed. */
export const STOP_GRACE_MS = 15000;
const KILL_WAIT_MS = 5000;
let hooked = false;

const signalGroup = (child, signal) => {
  try { process.kill(-child.pid, signal); return true; } catch { /* no such group */ }
  try { child.kill(signal); return true; } catch { return false; }
};

/** `spawn` with the child tracked and in a group of its own; the arguments are spawn's. */
export function spawnTracked(command, args, options) {
  const child = spawn(command, args, { ...options, detached: true });
  const entry = { child, closed: null };
  entry.closed = new Promise((resolve) => { child.once('close', resolve); child.once('error', resolve); });
  live.add(entry);
  entry.closed.then(() => live.delete(entry));
  if (!hooked) {
    hooked = true;
    process.on('exit', () => { for (const item of live) { try { item.child.kill('SIGTERM'); } catch { /* gone */ } } });
  }
  return child;
}

/** The pids of the tracked children still running. */
export const liveChildren = () => [...live].map((entry) => entry.child.pid);

/**
 * Stops every tracked child: SIGTERM, then SIGKILL to the group of each that
 * has not closed after `graceMs`. Resolves the pids that had to be killed and
 * those that did not close even then (each wait is bounded).
 */
export async function stopChildren({ graceMs = STOP_GRACE_MS } = {}) {
  const entries = [...live];
  for (const entry of entries) { try { entry.child.kill('SIGTERM'); } catch { /* gone */ } }
  const bounded = (promise, ms) => Promise.race([promise.then(() => true), new Promise((resolve) => { setTimeout(() => resolve(false), ms).unref(); })]);
  const killed = [];
  const stuck = [];
  await Promise.all(entries.map(async (entry) => {
    if (await bounded(entry.closed, graceMs)) return;
    killed.push(entry.child.pid);
    signalGroup(entry.child, 'SIGKILL');
    if (!(await bounded(entry.closed, KILL_WAIT_MS))) stuck.push(entry.child.pid);
  }));
  return { killed, stuck };
}
