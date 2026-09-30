import { execFile } from 'node:child_process';

// Safety net for confined commands that finished their work but never exit.
//
// On 2026-09-30 three browser checks had passed and then sat idle for 9, 11
// and 32 minutes, because nothing could stop the dev server they had started.
// The only guard was the 60-minute task deadline. Group signals now stop such
// a server (native/session-group-darwin.h); this watchdog covers every other
// way a command can wait forever (a prompt for input, a lost child).
//
// A command is idle when the processes of its supervised group together used
// less than 0.5 % of one core for `idleMs` (ten minutes). A command that polls
// a remote service uses more than that; six idle Node processes use less. The
// watchdog then ends the group's
// leaf processes (those without children), which lets their parents finish on
// their own and return their output. A group that is waiting on purpose
// (`sleep`) is left alone. Nothing here limits, delays or queues a launch.
//
// Kill switch, read per sample: DEVRYAN_EXECUTION_IDLE_WATCHDOG=0.
// DEVRYAN_EXECUTION_IDLE_MS overrides the ten-minute limit (minimum 60 s).

const DEFAULT_IDLE_MS = 10 * 60_000;
const SAMPLE_MS = 30_000;
const ACTIVE_CPU_SHARE = 0.005;
const FORGET_AFTER_MS = 2 * 60_000;
// Only an explicit sleep: a pipe into `tail` or `grep` is how agents shorten
// output, and must not exempt the command that feeds it.
const WAITING_ON_PURPOSE = /^(?:sleep|gsleep)$/;

/** `[[dd-]hh:]mm:ss.cc` as ps prints cumulative CPU time, in milliseconds. */
export const parseCpuTime = (value) => {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(String(value).trim());
  if (!match) return null;
  const [, days = 0, hours = 0, minutes, seconds] = match;
  return Math.round(((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60_000 + Number(seconds) * 1000);
};

export const parseProcessTable = (output) => {
  const rows = [];
  for (const line of String(output ?? '').split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const cpuMs = parseCpuTime(match[4]);
    if (cpuMs === null) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), cpuMs, command: match[5] });
  }
  return rows;
};

const readProcessTable = () => new Promise((resolve) => {
  execFile('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,time=,command='], { timeout: 5_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
    (error, stdout) => resolve(error ? null : parseProcessTable(stdout)));
});

const programOf = (command) => {
  const first = String(command).trim().split(/\s+/)[0] ?? '';
  return first.split('/').pop() || first;
};

/** The supervised group of the execution whose launcher was given `profile`. */
export const supervisedGroup = (rows, profile) => {
  const supervisor = rows.find((row) => row.command.includes(profile));
  if (!supervisor) return null;
  const leader = rows.find((row) => row.ppid === supervisor.pid);
  if (!leader) return { supervisor, leader: null, members: [] };
  return { supervisor, leader, members: rows.filter((row) => row.pgid === leader.pid) };
};

export function createExecutionIdleWatchdog({ readProcesses = readProcessTable, signal = (pid, name) => process.kill(pid, name),
  onDiagnostic, now = Date.now, sampleMs = SAMPLE_MS, idleMs, platform = process.platform,
  schedule = setInterval, cancel = clearInterval } = {}) {
  const watches = new Map();
  let timer = null, sampling = false;
  const limit = () => {
    if (Number.isFinite(idleMs)) return idleMs;
    const configured = Number(process.env.DEVRYAN_EXECUTION_IDLE_MS);
    return Number.isSafeInteger(configured) && configured >= 60_000 ? configured : DEFAULT_IDLE_MS;
  };
  const report = (watch, record) => {
    try { onDiagnostic?.({ event: 'session_execution', ...watch.identity, phase: 'idle_watchdog', ...record }); } catch { /* Observer only. */ }
  };
  const stop = () => { if (timer) cancel(timer); timer = null; };
  const inspect = (watch, rows, at) => {
    const group = supervisedGroup(rows, watch.profile);
    if (!group?.leader) {
      // Not started yet, or already gone: finish and cancel forget it too.
      if (at - (watch.seenAt ?? watch.startedAt) >= FORGET_AFTER_MS) watches.delete(watch.token);
      return;
    }
    watch.seenAt = at;
    const cpuMs = group.members.reduce((total, row) => total + row.cpuMs, 0);
    const elapsed = at - (watch.sampledAt ?? at);
    const active = watch.cpuMs === undefined || cpuMs - watch.cpuMs > elapsed * ACTIVE_CPU_SHARE
      // A member that left or joined is activity.
      || group.members.length !== watch.members;
    watch.cpuMs = cpuMs; watch.sampledAt = at; watch.members = group.members.length;
    if (active) { watch.idleSince = at; return; }
    if (at - watch.idleSince < limit()) return;
    if (group.members.some((row) => WAITING_ON_PURPOSE.test(programOf(row.command)))) return;
    const parents = new Set(group.members.map((row) => row.ppid));
    const leaves = group.members.filter((row) => !parents.has(row.pid));
    if (!leaves.length) return;
    for (const row of leaves) {
      // A leaf that survived a polite request is killed.
      const name = watch.asked.has(row.pid) ? 'SIGKILL' : 'SIGTERM';
      watch.asked.add(row.pid);
      try { signal(row.pid, name); } catch { /* Already gone. */ }
    }
    report(watch, { state: 'ended_idle_processes', idleMs: at - watch.idleSince, processes: leaves.map((row) => programOf(row.command)).slice(0, 16) });
    // Their parents get one sample to finish before the next leaves are ended.
    watch.idleSince = at - limit() + sampleMs;
  };
  const sample = async () => {
    if (sampling) return;
    sampling = true;
    try {
      if (process.env.DEVRYAN_EXECUTION_IDLE_WATCHDOG === '0') { watches.clear(); return; }
      const rows = await readProcesses();
      if (!rows) return;
      const at = now();
      for (const watch of [...watches.values()]) inspect(watch, rows, at);
    } finally {
      sampling = false;
      if (!watches.size) stop();
    }
  };
  return {
    /** Starts watching one confined process execution. */
    watch({ token, profile, identity = {} }) {
      if (platform === 'win32' || process.env.DEVRYAN_EXECUTION_IDLE_WATCHDOG === '0'
        || typeof token !== 'string' || typeof profile !== 'string' || !profile) return;
      const at = now();
      watches.set(token, { token, profile, identity, startedAt: at, idleSince: at, asked: new Set() });
      while (watches.size > 256) watches.delete(watches.keys().next().value);
      if (!timer) { timer = schedule(() => { void sample(); }, sampleMs); timer?.unref?.(); }
    },
    unwatch(token) { watches.delete(token); if (!watches.size) stop(); },
    sample,
    size: () => watches.size,
    stop() { watches.clear(); stop(); },
  };
}
