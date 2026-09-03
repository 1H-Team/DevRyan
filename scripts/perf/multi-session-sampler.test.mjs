import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildProcessTree,
  buildTrackedProcesses,
  classifyProcess,
  commandFamily,
  commandPreview,
  parseDockerStats,
  parseDuration,
  parseFootprintJson,
  parseMemoryPressure,
  parsePsTable,
  parseSamplerArguments,
  parseSize,
  parseSysctl,
  parseTopOutput,
  parseVmStat,
  summarizeRoles,
} from './multi-session-sampler.mjs';
import {
  analyzeRun,
  buildTimeline,
  linearSlopePerMinute,
  percentile,
  renderReport,
  summarizeSeries,
} from './multi-session-report.mjs';

const PS_FIXTURE = `  PID  PPID %CPU    RSS     ELAPSED COMMAND
    1     0  0.0   6640 02-20:13:26 /sbin/launchd
31920     1  0.9 148480    46:32 /Applications/DevRyan.app/Contents/MacOS/DevRyan
31923 31920  0.0  46080    46:32 /Applications/DevRyan.app/Contents/Frameworks/DevRyan Helper.app/Contents/MacOS/DevRyan Helper --type=gpu-process --user-data-dir=/Users/x/y
31924 31920  0.0  35840    46:32 /Applications/DevRyan.app/Contents/Frameworks/DevRyan Helper.app/Contents/MacOS/DevRyan Helper --type=utility --utility-sub-type=network.mojom.NetworkService --lang=en-US
32218 31920  0.0  80896    46:09 /Applications/DevRyan.app/Contents/Frameworks/DevRyan Helper (Renderer).app/Contents/MacOS/DevRyan Helper (Renderer) --type=renderer --user-data-dir=/Users/x/y
32387 31920  2.9 593920    46:06 /Users/zoubair/.opencode/bin/opencode serve --hostname 127.0.0.1 --port 53961
40001 32387  1.0  20480    00:10 /opt/homebrew/bin/node /Users/zoubair/.config/opencode/plugin/cursor-acp-runner.js
40002 40001  5.0  90112    00:09 /Users/zoubair/.cursor-agent/cursor-agent --print
40003 32387  0.0   4096    00:01 /usr/bin/git status --porcelain
35366 31920  0.2  17408    43:20 /opt/homebrew/bin/cloudflared tunnel run --token-file /tmp/token
53145     1  0.0 138160    27:17 /Users/zoubair/.opencode/bin/opencode serve --hostname 127.0.0.1 --port 49274
50079 49316  1.5 100000    01:00 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome Helper --type=renderer
`;

const TOP_FIXTURE = `Processes: 600 total, 4 running, 596 sleeping, 2500 threads
Load Avg: 6.39, 7.36, 7.09

PID    PPID  %CPU MEM    CMPRS  #TH  PAGEINS COMMAND
31920  1     0.0  312M   177M   53   13567   DevRyan
32387  31920 0.0  694M+  466M-  25   100754  opencode

Processes: 600 total, 5 running, 595 sleeping, 2501 threads
Load Avg: 6.40, 7.36, 7.09

PID    PPID  %CPU MEM    CMPRS  #TH  PAGEINS COMMAND
79501  1     24.8 7180M  11G+   20   1624    com.apple.Virtua
31920  1     9.2  312M   177M   53   13567   DevRyan
32387  31920 10.5 694M+  466M-  25/1 100754+ opencode
32218  31920 0.0  469M   463M+  19   8585    DevRyan Helper (
`;

const VM_STAT_FIXTURE = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     3758.
Pages active:                                 169170.
Pages inactive:                               164319.
Pages wired down:                             194805.
Pages stored in compressor:                  2246129.
Pages occupied by compressor:                 475560.
Compressions:                             3170999699.
Pageins:                                   134234302.
Pageouts:                                    2784287.
Swapins:                                    63804244.
Swapouts:                                   71112060.
`;

describe('size and duration parsing', () => {
  it('parses top, docker, and plain byte units including trend suffixes', () => {
    assert.equal(parseSize('694M+'), 694 * 1024 ** 2);
    assert.equal(parseSize('11G+'), 11 * 1024 ** 3);
    assert.equal(parseSize('340MiB'), 340 * 1024 ** 2);
    assert.equal(parseSize('3GiB'), 3 * 1024 ** 3);
    assert.equal(parseSize('12.7kB'), 12700);
    assert.equal(parseSize('0B'), 0);
    assert.equal(parseSize('garbage'), null);
  });

  it('parses durations with default minutes', () => {
    assert.equal(parseDuration('90s'), 90_000);
    assert.equal(parseDuration('2h'), 7_200_000);
    assert.equal(parseDuration('15'), 900_000);
    assert.throws(() => parseDuration('soon'));
  });

  it('parses sampler flags and rejects unsafe labels', () => {
    const options = parseSamplerArguments(['--label', 'dozen', '--interval', '10', '--duration', '30m', '--docker-every', '0', '--cookie', 'abc'], {});
    assert.equal(options.label, 'dozen');
    assert.equal(options.intervalMs, 10_000);
    assert.equal(options.durationMs, 1_800_000);
    assert.equal(options.dockerEvery, 0);
    assert.equal(options.cookie, 'abc');
    assert.throws(() => parseSamplerArguments(['--label', '../escape'], {}));
    assert.throws(() => parseSamplerArguments(['--bogus'], {}));
    assert.equal(parseSamplerArguments([], { DEVRYAN_UI_SESSION_COOKIE: 'env' }).cookie, 'env');
  });
});

describe('macOS collectors', () => {
  it('parses ps rows with full commands', () => {
    const rows = parsePsTable(PS_FIXTURE);
    assert.equal(rows.length, 12);
    const opencode = rows.find((row) => row.pid === 32387);
    assert.equal(opencode.ppid, 31920);
    assert.equal(opencode.rssBytes, 593920 * 1024);
    assert.equal(opencode.command, '/Users/zoubair/.opencode/bin/opencode serve --hostname 127.0.0.1 --port 53961');
  });

  it('parses only the last top sample so CPU reflects the interval', () => {
    const rows = parseTopOutput(TOP_FIXTURE);
    assert.equal(rows.size, 4);
    assert.equal(rows.get(31920).cpu, 9.2);
    assert.equal(rows.get(32387).footprint, 694 * 1024 ** 2);
    assert.equal(rows.get(32387).compressed, 466 * 1024 ** 2);
    assert.equal(rows.get(32387).threads, 25);
    assert.equal(rows.get(32387).pageins, 100754);
    assert.equal(rows.get(79501).name, 'com.apple.Virtua');
    assert.equal(rows.get(32218).name, 'DevRyan Helper (');
  });

  it('parses vm_stat, sysctl, memory_pressure, and docker stats', () => {
    const vm = parseVmStat(VM_STAT_FIXTURE);
    assert.equal(vm.freeBytes, 3758 * 16384);
    assert.equal(vm.compressorBytes, 475560 * 16384);
    assert.equal(vm.swapouts, 71112060);
    const sysctl = parseSysctl('vm.swapusage: total = 13312.00M  used = 12703.56M  free = 608.44M  (encrypted)\nvm.loadavg: { 6.39 7.36 7.09 }\n');
    assert.equal(sysctl.swapUsedBytes, Math.round(12703.56 * 1024 ** 2));
    assert.equal(sysctl.load1, 6.39);
    assert.equal(parseMemoryPressure('...\nSystem-wide memory free percentage: 33%\n'), 33);
    const docker = parseDockerStats('devryan-bots-indexer-1\t160.1MiB / 1GiB\t26.45%\nsupabase_db\t223.8MiB / 6.768GiB\t10.06%\n');
    assert.equal(docker.length, 2);
    assert.equal(docker[0].memBytes, Math.round(160.1 * 1024 ** 2));
    assert.equal(docker[0].limitBytes, 1024 ** 3);
    assert.equal(docker[0].cpuPct, 26.45);
  });

  it('parses footprint json into per-pid footprint, swapped, and dirty categories', () => {
    const parsed = parseFootprintJson({
      processes: [{
        pid: 32387,
        footprint: 753944472,
        categories: {
          'WebKit malloc': { dirty: 638943232, swapped: 444301312, clean: 0 },
          __CTF: { dirty: 0, swapped: 0 },
          stack: { dirty: 1000, swapped: 500 },
        },
      }],
    });
    const entry = parsed.get(32387);
    assert.equal(entry.footprint, 753944472);
    assert.equal(entry.swapped, 444301312 + 500);
    assert.deepEqual(Object.keys(entry.categories), ['WebKit malloc', 'stack']);
  });
});

describe('process tree classification', () => {
  const rows = parsePsTable(PS_FIXTURE);
  const tree = buildProcessTree(rows);

  it('roots the tree at the DevRyan.app binary and walks every descendant', () => {
    assert.deepEqual([...tree.rootPids], [31920]);
    assert.deepEqual([...tree.members.keys()].sort((a, b) => a - b), [31920, 31923, 31924, 32218, 32387, 35366, 40001, 40002, 40003]);
    assert.equal(tree.members.get(40002), 31920);
  });

  it('flags launchd-parented agent processes as orphans but ignores unrelated apps', () => {
    assert.deepEqual(tree.orphans.map((row) => row.pid), [53145]);
  });

  it('assigns roles from the command line', () => {
    const context = { rootPids: tree.rootPids };
    const roleOf = (pid) => classifyProcess(rows.find((row) => row.pid === pid), context);
    assert.equal(roleOf(31920), 'electron-main+server');
    assert.equal(roleOf(31923), 'gpu');
    assert.equal(roleOf(31924), 'utility:network:Network');
    assert.equal(roleOf(32218), 'renderer');
    assert.equal(roleOf(32387), 'opencode-serve');
    assert.equal(roleOf(40001), 'cursor-acp-runner');
    assert.equal(roleOf(40002), 'cursor-agent');
    assert.equal(roleOf(40003), 'git');
    assert.equal(roleOf(35366), 'cloudflared');
    assert.equal(classifyProcess({ pid: 9, command: '/Applications/DevRyan.app/Contents/MacOS/DevRyan --runtime-service' }, { rootPids: new Set([9]) }), 'runtime-service-main');
  });

  it('builds command previews and families', () => {
    assert.equal(commandPreview('/Applications/DevRyan.app/Contents/Frameworks/DevRyan Helper.app/Contents/MacOS/DevRyan Helper --type=gpu-process --user-data-dir=/x/y --foo'), 'DevRyan Helper.app/Contents/MacOS/DevRyan Helper --type=gpu-process --foo');
    assert.equal(commandFamily('/Users/zoubair/.opencode/bin/opencode serve --hostname 127.0.0.1'), 'opencode serve');
    assert.equal(commandFamily('/opt/homebrew/bin/node /Users/x/runner.js --flag'), 'node runner.js');
    assert.equal(commandFamily('/usr/bin/git status --porcelain'), 'git status');
  });

  it('redacts secrets carried on command lines', () => {
    assert.equal(commandPreview('/opt/homebrew/bin/cloudflared tunnel run --token eyJhIjoiNDY5OWRiYzljMzU1NWM0MDNhZjQ2ZTQ1ZWQ1ZjA0ZTQiLCJ0IjoiYzM1'), 'cloudflared tunnel run --token <redacted>'.replace('cloudflared', '/opt/homebrew/bin/cloudflared'));
    assert.equal(commandPreview('node runner.js --password=hunter2 --port 3000'), 'node runner.js --password=<redacted> --port 3000');
    assert.equal(commandPreview('opencode serve --hostname 127.0.0.1 --port 53961'), 'opencode serve --hostname 127.0.0.1 --port 53961');
  });

  it('prefers footprint over top over ps rss when describing tracked processes', () => {
    const topRows = parseTopOutput(TOP_FIXTURE);
    const footprints = new Map([[32387, { footprint: 753944472, swapped: 1, categories: {} }]]);
    const { procs, orphans } = buildTrackedProcesses({ psRows: rows, topRows, footprints });
    const byPid = new Map(procs.map((proc) => [proc.pid, proc]));
    assert.equal(byPid.get(32387).footprint, 753944472);
    assert.equal(byPid.get(32387).footprintSource, 'footprint');
    assert.equal(byPid.get(31920).footprint, 312 * 1024 ** 2);
    assert.equal(byPid.get(31920).footprintSource, 'top');
    assert.equal(byPid.get(40002).footprint, 90112 * 1024);
    assert.equal(byPid.get(40002).footprintSource, 'ps-rss');
    assert.equal(procs[0].pid, 32387);
    assert.equal(orphans.length, 1);
    assert.equal(orphans[0].kind, 'orphan');
    const roles = summarizeRoles(procs);
    assert.equal(roles['opencode-serve'].count, 1);
    assert.equal(roles['electron-main+server'].cpu, 9.2);
  });
});

describe('report analysis', () => {
  it('computes percentiles, slopes, and series summaries', () => {
    assert.equal(percentile([5, 1, 3], 50), 3);
    assert.equal(percentile([], 50), null);
    assert.equal(Math.round(linearSlopePerMinute([{ t: 0, v: 0 }, { t: 60_000, v: 100 }, { t: 120_000, v: 200 }])), 100);
    const summary = summarizeSeries([{ t: 0, v: 10 }, { t: 1, v: 30 }, { t: 2, v: 20 }]);
    assert.equal(summary.max, 30);
    assert.equal(summary.peakAt, 1);
    assert.equal(summary.first, 10);
    assert.equal(summary.last, 20);
    assert.equal(summary.avg, 20);
  });

  it('analyzes and renders a run without authenticated metrics', () => {
    const base = Date.parse('2026-09-03T00:00:00Z');
    const sample = (index, opencodeBytes, extraProcs = []) => ({
      t: new Date(base + index * 5000).toISOString(),
      elapsedS: index * 5,
      tick: index,
      tickMs: 2100,
      system: { freePct: 10 - index, freeBytes: 1, swapUsedBytes: 1000 + index, compressorBytes: 5, load1: 3 + index, swapouts: index * 10, swapins: 0, pageouts: index, compressions: index * 100 },
      devryan: {
        rootPids: [1],
        processCount: 2 + extraProcs.length,
        totalFootprint: 100 + opencodeBytes + extraProcs.reduce((sum, proc) => sum + proc.footprint, 0),
        totalCpu: 5,
        byRole: {
          'electron-main+server': { count: 1, footprint: 100, cpu: 2, threads: 50 },
          'opencode-serve': { count: 1, footprint: opencodeBytes, cpu: 3, threads: 25 },
          ...(extraProcs.length > 0 ? { git: { count: extraProcs.length, footprint: extraProcs.reduce((sum, proc) => sum + proc.footprint, 0), cpu: 0, threads: 1 } } : {}),
        },
      },
      procs: [
        { pid: 1, ppid: 0, kind: 'tree', role: 'electron-main+server', family: 'DevRyan', cmd: 'DevRyan', footprint: 100, cpu: 2, threads: 50 },
        { pid: 2, ppid: 1, kind: 'tree', role: 'opencode-serve', family: 'opencode serve', cmd: 'opencode serve', footprint: opencodeBytes, cpu: 3, threads: 25 },
        ...extraProcs,
      ],
      orphans: [],
      docker: index % 2 === 0 ? { devryan: [{ name: 'devryan-bots-indexer-1', memBytes: 100 + index, limitBytes: 1024, cpuPct: 1 }], otherContainerCount: 1, otherContainersMemBytes: 50 } : null,
      fds: index === 0 ? { 1: { role: 'electron-main+server', fds: 200 } } : null,
      logs: { opencodeLogBytes: 1000 + index * 10, mainLogBytes: 500 },
      server: { healthStatus: 200, healthMs: 10 + index, openCodeReady: true, openCodeProbeMs: 2, authenticated: false, debugMemory: null, appMetrics: null, sessions: null },
      topSystem: [{ pid: 99, name: 'com.apple.Virtua', footprint: 7000, cpu: 20 }],
      marks: index === 1 ? ['sent drafts'] : [],
    });
    const samples = [
      sample(0, 500),
      sample(1, 600, [{ pid: 3, ppid: 2, kind: 'tree', role: 'git', family: 'git status', cmd: 'git status', footprint: 10, cpu: 0, threads: 1 }]),
      sample(2, 700),
    ];
    const events = [
      { t: samples[1].t, elapsedS: 5, type: 'spawn', pid: 3, role: 'git', family: 'git status', kind: 'tree', cmd: 'git status' },
      { t: samples[2].t, elapsedS: 10, type: 'exit', pid: 3, role: 'git', family: 'git status', kind: 'tree', cmd: 'git status', lifetimeS: 5, peakFootprint: 10 },
      { t: samples[1].t, elapsedS: 5, type: 'mark', text: 'sent drafts' },
    ];
    const analysis = analyzeRun({ meta: { label: 'unit', machine: {}, dockerSettings: {} }, samples, events });
    assert.equal(analysis.total.first, 600);
    assert.equal(analysis.total.last, 800);
    assert.equal(analysis.roles['opencode-serve'].footprint.max, 700);
    assert.equal(analysis.childRoles.git.pids, 1);
    assert.equal(analysis.childRoles.git.peakConcurrent, 1);
    assert.equal(analysis.spawnEvents.length, 1);
    assert.equal(analysis.shortLived.length, 1);
    assert.equal(analysis.system.swapoutsDelta, 20);
    assert.equal(analysis.docker['devryan-bots-indexer-1'].peak, 102);
    assert.equal(analysis.logs.opencodeLogDelta, 20);
    assert.equal(analysis.marks.length, 1);
    assert.equal(analysis.server.authenticated, false);

    const timeline = buildTimeline(samples);
    assert.equal(timeline.length, 1);
    assert.equal(timeline[0].freePctMin, 8);
    assert.deepEqual(timeline[0].marks, ['sent drafts']);

    const markdown = renderReport(analysis);
    assert.match(markdown, /# Multi-session sampler report: unit/);
    assert.match(markdown, /opencode-serve/);
    assert.match(markdown, /unauthenticated/);
    assert.match(markdown, /sent drafts/);
    assert.doesNotMatch(markdown, /Server heap/);
    assert.equal(renderReport(null), '# Multi-session sampler report\n\nNo samples found.\n');
  });
});
