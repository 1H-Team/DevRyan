import { afterEach, describe, expect, test } from 'bun:test';
import { createExecutionIdleWatchdog, parseCpuTime, parseProcessTable, supervisedGroup } from './execution-idle-watchdog.js';

const profile = '/data/harness/views/abc/sandbox-1f0c.sb';
// The shape observed on 2026-09-30: every process idle after the tests passed.
const chain = (cpu = {}) => [
  { pid: 10, ppid: 1, pgid: 10, cpuMs: 50, command: `/app/DevRyan-execution-darwin-arm64 /view /scratch ${profile} /receipt -- /bin/zsh -c npm run verify` },
  { pid: 11, ppid: 10, pgid: 11, cpuMs: cpu.zsh ?? 10, command: '/bin/zsh -c npm run verify' },
  { pid: 12, ppid: 11, pgid: 11, cpuMs: cpu.npm ?? 900, command: 'npm run verify' },
  { pid: 13, ppid: 12, pgid: 11, cpuMs: cpu.playwright ?? 4_000, command: 'node /project/node_modules/.bin/playwright test' },
  { pid: 14, ppid: 13, pgid: 11, cpuMs: cpu.vite ?? 7_000, command: 'node /project/node_modules/.bin/vite --port 8080' },
  { pid: 99, ppid: 1, pgid: 99, cpuMs: 123_000, command: '/Applications/Other.app/Contents/MacOS/Other' },
];
const fixture = (options = {}) => {
  let time = 1_000_000, rows = chain();
  const signals = [], diagnostics = [];
  const watchdog = createExecutionIdleWatchdog({ readProcesses: async () => rows, signal: (pid, name) => signals.push([pid, name]),
    onDiagnostic: (record) => diagnostics.push(record), now: () => time, schedule: () => ({ unref() {} }), cancel: () => {}, ...options });
  const pass = async (ms, next) => { for (let passed = 0; passed < ms; passed += 30_000) { time += 30_000; if (next) rows = next(rows); await watchdog.sample(); } };
  return { watchdog, signals, diagnostics, pass, setRows: (next) => { rows = next; } };
};

describe('process table', () => {
  test('reads the cumulative CPU time ps prints', () => {
    expect(parseCpuTime('0:00.01')).toBe(10);
    expect(parseCpuTime('12:34.56')).toBe(754_560);
    expect(parseCpuTime('1:02:03.50')).toBe(3_723_500);
    expect(parseCpuTime('2-01:02:03')).toBe(176_523_000);
    expect(parseCpuTime('garbage')).toBeNull();
  });
  test('finds the supervised group of one execution by its profile', () => {
    const rows = parseProcessTable('  10     1    10   0:00.05 /app/launcher /view /scratch ' + profile + ' /receipt -- /bin/zsh -c x\n'
      + '  11    10    11   0:00.01 /bin/zsh -c x\n  12    11    11   0:01.00 node server.js\n  99     1    99   9:00.00 other\nnot a row\n');
    const group = supervisedGroup(rows, profile);
    expect(group.leader.pid).toBe(11);
    expect(group.members.map((row) => row.pid)).toEqual([11, 12]);
    expect(supervisedGroup(rows, '/another/profile.sb')).toBeNull();
  });
});

describe('idle command watchdog', () => {
  afterEach(() => { delete process.env.DEVRYAN_EXECUTION_IDLE_WATCHDOG; delete process.env.DEVRYAN_EXECUTION_IDLE_MS; });

  test('ends the leaf of a command that was idle for ten minutes, and nothing outside it', async () => {
    const f = fixture();
    f.watchdog.watch({ token: 'lease', profile, identity: { sessionID: 'ses_a', callID: 'call_a' } });
    await f.pass(9 * 60_000 + 30_000);
    expect(f.signals).toEqual([]);
    await f.pass(60_000);
    expect(f.signals).toEqual([[14, 'SIGTERM']]);
    expect(f.diagnostics).toEqual([expect.objectContaining({ event: 'session_execution', phase: 'idle_watchdog',
      state: 'ended_idle_processes', sessionID: 'ses_a', callID: 'call_a', processes: ['node'] })]);
  });

  test('lets the parents finish, then ends the next leaf; a leaf that stays is killed', async () => {
    const f = fixture();
    f.watchdog.watch({ token: 'lease', profile });
    await f.pass(10 * 60_000 + 30_000);
    expect(f.signals).toEqual([[14, 'SIGTERM']]);
    // The dev server ignored the request.
    await f.pass(30_000);
    expect(f.signals.at(-1)).toEqual([14, 'SIGKILL']);
    // It is gone and its parent is still idle: a change first, then the next leaf.
    f.setRows(chain().filter((row) => row.pid !== 14));
    await f.pass(10 * 60_000);
    expect(f.signals.filter(([pid]) => pid === 13)).toEqual([]);
    await f.pass(30_000);
    expect(f.signals.at(-1)).toEqual([13, 'SIGTERM']);
  });

  test('a working command is never touched', async () => {
    const f = fixture();
    f.watchdog.watch({ token: 'lease', profile });
    // A command that polls a remote service uses 1 % of a core: 300 ms every 30 s.
    await f.pass(40 * 60_000, (rows) => rows.map((row) => row.pid === 13 ? { ...row, cpuMs: row.cpuMs + 300 } : row));
    expect(f.signals).toEqual([]);
  });

  test('output piped through tail is still watched', async () => {
    const f = fixture();
    // npm run verify 2>&1 | tail -80
    f.setRows([...chain(), { pid: 15, ppid: 11, pgid: 11, cpuMs: 0, command: 'tail -80' }]);
    f.watchdog.watch({ token: 'lease', profile });
    await f.pass(10 * 60_000 + 30_000);
    expect(f.signals.map(([pid]) => pid).sort()).toEqual([14, 15]);
  });

  test('a command that waits on purpose is left alone', async () => {
    const f = fixture();
    f.setRows([...chain(), { pid: 15, ppid: 11, pgid: 11, cpuMs: 0, command: 'sleep 900' }]);
    f.watchdog.watch({ token: 'lease', profile });
    await f.pass(40 * 60_000);
    expect(f.signals).toEqual([]);
  });

  test('forgets an execution that ended, and stops sampling when nothing is watched', async () => {
    let cancelled = 0;
    const f = fixture({ cancel: () => { cancelled += 1; } });
    f.watchdog.watch({ token: 'lease', profile });
    await f.pass(60_000);
    f.setRows(chain().filter((row) => row.pid === 99));
    await f.pass(3 * 60_000);
    expect(f.watchdog.size()).toBe(0);
    expect(cancelled).toBeGreaterThan(0);
    f.watchdog.watch({ token: 'other', profile });
    f.watchdog.unwatch('other');
    expect(f.watchdog.size()).toBe(0);
  });

  test('the limit is configurable and the kill switch disables it', async () => {
    process.env.DEVRYAN_EXECUTION_IDLE_MS = '120000';
    const short = fixture();
    short.watchdog.watch({ token: 'lease', profile });
    await short.pass(2 * 60_000 + 30_000);
    expect(short.signals).toEqual([[14, 'SIGTERM']]);

    process.env.DEVRYAN_EXECUTION_IDLE_WATCHDOG = '0';
    const disabled = fixture();
    disabled.watchdog.watch({ token: 'lease', profile });
    expect(disabled.watchdog.size()).toBe(0);
    await disabled.pass(20 * 60_000);
    expect(disabled.signals).toEqual([]);
  });
});
