import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, test } from 'node:test';

import {
  MIB,
  aggregateProcessTree,
  classifyMemoryRuns,
  parsePsOutput,
  readMacProcessTable,
  runRetryMemoryProfile,
} from './process-sampler.mjs';

describe('macOS Electron process sampler', () => {
  test('parses ps rows with command text and ignores malformed rows', () => {
    assert.deepEqual(parsePsOutput(`
      10     1   2048 Wed Jul 15 09:30:00 2026 /Applications/DevRyan.app/Contents/MacOS/DevRyan --flag
      11    10    512 Wed Jul 15 09:30:01 2026 /Applications/DevRyan Helper.app/Contents/MacOS/DevRyan Helper
      malformed row
      12    10 nope bad rss
    `), [
      {
        pid: 10,
        ppid: 1,
        rssBytes: 2_097_152,
        startIdentity: 'Wed Jul 15 09:30:00 2026',
        command: '/Applications/DevRyan.app/Contents/MacOS/DevRyan --flag',
      },
      {
        pid: 11,
        ppid: 10,
        rssBytes: 524_288,
        startIdentity: 'Wed Jul 15 09:30:01 2026',
        command: '/Applications/DevRyan Helper.app/Contents/MacOS/DevRyan Helper',
      },
    ]);
  });

  test('aggregates only the recursive root process tree', () => {
    const table = [
      { pid: 10, ppid: 1, rssBytes: 100, startIdentity: 'start-a', command: 'Electron' },
      { pid: 11, ppid: 10, rssBytes: 50, startIdentity: 'start-b', command: 'Renderer' },
      { pid: 12, ppid: 11, rssBytes: 25, startIdentity: 'start-c', command: 'Utility' },
      { pid: 20, ppid: 1, rssBytes: 999, startIdentity: 'start-d', command: 'Unrelated' },
    ];
    const aggregate = aggregateProcessTree(table, 10);
    assert.deepEqual({ ...aggregate, rootIdentity: undefined }, {
      rootPid: 10,
      rootPresent: true,
      rootIdentity: undefined,
      processCount: 3,
      rssBytes: 175,
      pids: [10, 11, 12],
    });
    assert.match(aggregate.rootIdentity, /^root-[a-f0-9]{16}$/);
  });

  test('marks a missing root explicitly and changes identity on PID reuse or command replacement', () => {
    assert.deepEqual(aggregateProcessTree([], 10), {
      rootPid: 10,
      rootPresent: false,
      rootIdentity: null,
      processCount: 0,
      rssBytes: 0,
      pids: [],
    });
    const original = aggregateProcessTree([
      { pid: 10, ppid: 1, rssBytes: 100, startIdentity: 'start-a', command: 'Electron' },
    ], 10);
    const reusedPid = aggregateProcessTree([
      { pid: 10, ppid: 1, rssBytes: 100, startIdentity: 'start-b', command: 'Electron' },
    ], 10);
    const replacedCommand = aggregateProcessTree([
      { pid: 10, ppid: 1, rssBytes: 100, startIdentity: 'start-a', command: 'Other process' },
    ], 10);
    assert.notEqual(original.rootIdentity, reusedPid.rootIdentity);
    assert.notEqual(original.rootIdentity, replacedCommand.rootIdentity);
  });

  test('spawns /bin/ps with an argument array and no shell', async () => {
    const calls = [];
    const spawnImpl = (command, args, options) => {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('10 1 100 Wed Jul 15 09:30:00 2026 Electron\n'));
        child.emit('close', 0, null);
      });
      return child;
    };
    const table = await readMacProcessTable({ spawnImpl, platform: 'darwin' });
    assert.equal(table[0].pid, 10);
    assert.deepEqual(calls, [{
      command: '/bin/ps',
      args: ['-axo', 'pid=,ppid=,rss=,lstart=,command='],
      options: { shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
    }]);
  });

  test('runs the prescribed idle/five-cycle/settlement profile twice', async () => {
    const phases = [];
    const cycles = [];
    const calls = [];
    const collector = {
      async collectFor(input) {
        const { phase, runIndex } = input;
        phases.push([phase, runIndex]);
        calls.push({ method: 'collectFor', ...input });
        const base = runIndex * 1_000 * MIB;
        if (phase === 'idle') {
          return [{ phase, rssBytes: base, rootPresent: true, rootIdentity: 'root-stable' }];
        }
        return [0, 1, 2, 3].map((offset) => ({
          phase,
          rssBytes: base + 200 * MIB + offset,
          rootPresent: true,
          rootIdentity: 'root-stable',
        }));
      },
      async collectDuring(input) {
        const { phase, runIndex, cycleIndex, action } = input;
        phases.push([phase, runIndex, cycleIndex]);
        calls.push({
          method: 'collectDuring',
          rootPid: input.rootPid,
          phase,
          runIndex,
          cycleIndex,
          intervalMs: input.intervalMs,
          action: typeof action,
        });
        await action();
        return [{
          phase,
          rssBytes: runIndex * 1_000 * MIB + cycleIndex,
          rootPresent: true,
          rootIdentity: 'root-stable',
        }];
      },
    };

    const result = await runRetryMemoryProfile({
      rootPid: 42,
      collector,
      executeFailureCycle: async ({ runIndex, cycleIndex }) => cycles.push([runIndex, cycleIndex]),
    });
    assert.equal(cycles.length, 10);
    assert.deepEqual(cycles[0], [1, 1]);
    assert.deepEqual(cycles.at(-1), [2, 5]);
    assert.equal(phases.filter(([phase]) => phase === 'idle').length, 2);
    assert.equal(phases.filter(([phase]) => phase === 'settlement').length, 2);
    assert.equal(result.profile.intervalMs, 1_000);
    assert.equal(result.profile.idleSeconds, 60);
    assert.equal(result.profile.cycles, 5);
    assert.equal(result.profile.settlementSeconds, 30);
    assert.equal(result.profile.runs, 2);
    assert.deepEqual(calls.filter((call) => call.method === 'collectFor'), [
      {
        method: 'collectFor', rootPid: 42, phase: 'idle', runIndex: 1, durationMs: 60_000, intervalMs: 1_000,
      },
      {
        method: 'collectFor', rootPid: 42, phase: 'settlement', runIndex: 1, durationMs: 30_000, intervalMs: 1_000,
      },
      {
        method: 'collectFor', rootPid: 42, phase: 'idle', runIndex: 2, durationMs: 60_000, intervalMs: 1_000,
      },
      {
        method: 'collectFor', rootPid: 42, phase: 'settlement', runIndex: 2, durationMs: 30_000, intervalMs: 1_000,
      },
    ]);
    assert.equal(calls.filter((call) => call.method === 'collectDuring').every((call) => (
      call.rootPid === 42
      && call.phase === 'failure-cycle'
      && call.intervalMs === 1_000
      && call.action === 'function'
    )), true);
  });
});

describe('memory growth classification', () => {
  const sample = (phase, rssBytes, rootIdentity = 'root-stable') => ({
    phase,
    rssBytes,
    rootPresent: true,
    rootIdentity,
  });
  const reproducedRun = (baselineBytes = 1_000 * MIB, rootIdentity = 'root-stable') => ({
    samples: [
      sample('idle', baselineBytes, rootIdentity),
      sample('settlement', baselineBytes + 120 * MIB, rootIdentity),
      sample('settlement', baselineBytes + 121 * MIB, rootIdentity),
      sample('settlement', baselineBytes + 122 * MIB, rootIdentity),
      sample('settlement', baselineBytes + 123 * MIB, rootIdentity),
    ],
  });

  test('classifies retained growth only when both thresholds reproduce in two runs', () => {
    const result = classifyMemoryRuns([reproducedRun(), reproducedRun(900 * MIB)]);
    assert.equal(result.classification, 'retained-growth-reproduced');
    assert.equal(result.reproducedRuns, 2);
    assert.equal(result.runs.every((run) => run.monotonicSettledSamples >= 4), true);
    assert.equal(result.runs.every((run) => run.growthBytes > 100 * MIB), true);
    assert.equal(result.runs.every((run) => run.growthPercent > 10), true);
  });

  test('uses a monotonic suffix ending at the final sample and strict threshold comparisons', () => {
    const noisy = reproducedRun();
    noisy.samples.splice(1, 0, sample('settlement', 2_000 * MIB));
    assert.equal(classifyMemoryRuns([noisy, reproducedRun()]).classification, 'retained-growth-reproduced');

    const equalBytes = reproducedRun(1_000 * MIB);
    equalBytes.samples = [
      sample('idle', 1_000 * MIB),
      ...[0, 1, 2, 3].map(() => sample('settlement', 1_100 * MIB)),
    ];
    assert.equal(classifyMemoryRuns([equalBytes, equalBytes]).classification, 'not-reproduced');
  });

  test('reports insufficient data without two runs of four settled samples', () => {
    assert.equal(classifyMemoryRuns([reproducedRun()]).classification, 'insufficient-data');
    const short = { samples: reproducedRun().samples.slice(0, 4) };
    assert.equal(classifyMemoryRuns([short, short]).classification, 'insufficient-data');
  });

  test('reports insufficient data when any required sample misses or replaces the root process', () => {
    const missing = reproducedRun();
    missing.samples[2] = {
      phase: 'settlement', rssBytes: 1_121 * MIB, rootPresent: false, rootIdentity: null,
    };
    assert.equal(classifyMemoryRuns([missing, reproducedRun()]).classification, 'insufficient-data');

    const replacedWithinRun = reproducedRun();
    replacedWithinRun.samples.at(-1).rootIdentity = 'root-replaced';
    assert.equal(
      classifyMemoryRuns([replacedWithinRun, reproducedRun()]).classification,
      'insufficient-data',
    );
    assert.equal(
      classifyMemoryRuns([reproducedRun(), reproducedRun(900 * MIB, 'root-other')]).classification,
      'insufficient-data',
    );
  });
});
