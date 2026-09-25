import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { classifyProcessCommand } from '../../packages/web/server/lib/processes/runtime.js';
import {
  appInfoPlistFromCommand,
  buildProcessTree,
  buildTrackedProcesses,
  classifyProcess,
  commandFamily,
  commandPreview,
  commandReferencesDirectory,
  describeLspProcesses,
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
  runtimeRootLogPaths,
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
    const options = parseSamplerArguments(['--label', 'dozen', '--interval', '10', '--duration', '30m', '--docker-every', '0', '--cookie', 'oc_ui_session_3000=fixture'], {});
    assert.equal(options.label, 'dozen');
    assert.equal(options.intervalMs, 10_000);
    assert.equal(options.durationMs, 1_800_000);
    assert.equal(options.dockerEvery, 0);
    assert.equal(options.cookie, 'oc_ui_session_3000=fixture');
    assert.throws(() => parseSamplerArguments(['--label', '../escape'], {}));
    assert.throws(() => parseSamplerArguments(['--bogus'], {}));
    assert.equal(parseSamplerArguments([], { DEVRYAN_UI_SESSION_COOKIE: 'oc_ui_session_3000=env' }).cookie, 'oc_ui_session_3000=env');
  });

  it('defaults to the installed app target and its home-directory logs', () => {
    const options = parseSamplerArguments([], {});
    assert.equal(options.targetMode, 'app');
    assert.equal(options.rootPid, null);
    assert.equal(options.runtimeRoot, null);
    assert.equal(options.opencodeLog, path.join(os.homedir(), '.local/share/opencode/log/opencode.log'));
    assert.equal(options.mainLog, path.join(os.homedir(), 'Library/Logs/DevRyan/main.log'));
  });

  it('parses a pid target and rejects malformed or system pids', () => {
    const options = parseSamplerArguments(['--pid', '4242'], {});
    assert.equal(options.targetMode, 'pid');
    assert.equal(options.rootPid, 4242);
    for (const raw of ['0', '1', '-5', '12abc', '1.5', '99999999999999999999']) {
      assert.throws(() => parseSamplerArguments(['--pid', raw], {}), /--pid requires a process id greater than 1/, raw);
    }
    assert.throws(() => parseSamplerArguments(['--pid'], {}), /--pid requires a value/);
  });

  it('derives runtime-root log defaults and keeps explicit log overrides', () => {
    const runtimeRoot = '/work/DevRyan/.cache/qa/web-smoke-abc/runtime';
    const options = parseSamplerArguments(['--runtime-root', runtimeRoot], {});
    assert.equal(options.targetMode, 'runtime-root');
    assert.equal(options.runtimeRoot, runtimeRoot);
    assert.deepEqual(runtimeRootLogPaths(runtimeRoot), {
      opencodeLog: `${runtimeRoot}/home/.local/share/opencode/log/opencode.log`,
      mainLog: `${runtimeRoot}/logs/main.log`,
    });
    assert.equal(options.opencodeLog, `${runtimeRoot}/home/.local/share/opencode/log/opencode.log`);
    assert.equal(options.mainLog, `${runtimeRoot}/logs/main.log`);

    const overridden = parseSamplerArguments(['--runtime-root', runtimeRoot, '--opencode-log', '/logs/oc.log', '--main-log', '/logs/main.log'], {});
    assert.equal(overridden.opencodeLog, '/logs/oc.log');
    assert.equal(overridden.mainLog, '/logs/main.log');
    assert.equal(parseSamplerArguments(['--runtime-root', 'relative/runtime'], {}).runtimeRoot, path.resolve('relative/runtime'));
  });

  it('rejects combined or unbounded targets', () => {
    assert.throws(() => parseSamplerArguments(['--pid', '4242', '--runtime-root', '/tmp/runtime'], {}), /mutually exclusive/);
    assert.throws(() => parseSamplerArguments(['--runtime-root', '/'], {}), /filesystem root/);
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
     const companion = '/Applications/DevRyan.app/Contents/Resources/revert-runtime/darwin-arm64/DevRyan-opencode-darwin-arm64';
    const noRoots = { rootPids: new Set() };
    assert.equal(classifyProcess({ pid: 10, command: `${companion} serve --hostname 127.0.0.1 --port 0` }, noRoots), 'opencode-serve');
    assert.equal(classifyProcess({ pid: 11, command: `${companion} debug devryan-tool` }, noRoots), 'companion-worker');
    assert.equal(classifyProcess({ pid: 12, command: '/x/darwin-arm64/DevRyan-execution-darwin-arm64 --owner-lock /tmp/o' }, noRoots), 'execution-launcher');
    assert.equal(classifyProcess({ pid: 13, command: '/x/node_modules/.bin/typescript-language-server --stdio' }, noRoots), 'lsp');
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

describe('pid and runtime-root targets', () => {
  const RUNTIME_ROOT = '/Users/x/DevRyan/.cache/qa/web-smoke-abc/runtime';
  const QA_PS_FIXTURE = `  PID  PPID %CPU    RSS     ELAPSED COMMAND
    1     0  0.0   6640 02-20:13:26 /sbin/launchd
  700     1  0.1  20480    10:00 /bin/zsh -l
  701   700  0.5 204800    09:59 /opt/homebrew/bin/node scripts/qa/isolated-host.mjs
  702   701  2.0 409600    09:58 /Users/x/DevRyan/.cache/qa/opencode-1.18.31/package/bin/opencode serve --hostname 127.0.0.1 --port 0
  703   702  1.0 102400    05:00 /opt/homebrew/bin/bun x typescript-language-server --stdio
  704   703  3.0 307200    04:59 /opt/homebrew/bin/node /Users/x/.cache/opencode/node_modules/typescript/lib/tsserver.js --useInferredProjectPerProjectRoot
  705   702  0.0   4096    00:01 /usr/bin/git -C ${RUNTIME_ROOT}/workspace status --porcelain
  706     1  1.0 409600    30:00 /Users/x/.opencode/bin/opencode serve --hostname 127.0.0.1 --port 4096
  800     1  0.3 148480    08:00 /Users/x/electron/dist/Electron.app/Contents/MacOS/Electron scripts/qa/isolated-host.mjs
  801   800  0.0  46080    08:00 /Users/x/electron/dist/Electron.app/Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper --type=gpu-process --user-data-dir=${RUNTIME_ROOT}/browser-profile
  802   800  0.0  80896    07:59 /Users/x/electron/dist/Electron.app/Contents/Frameworks/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer) --type=renderer --user-data-dir=${RUNTIME_ROOT}/browser-profile
  803   801  0.0   1024    07:58 /Users/x/electron/crashpad_handler --database=${RUNTIME_ROOT}/browser-profile/Crashpad
  900     1  0.0   2048    01:00 /opt/homebrew/bin/node ${RUNTIME_ROOT}-other/tool.mjs
  901     1  0.0   2048    01:00 /opt/homebrew/bin/node /elsewhere${RUNTIME_ROOT}/tool.mjs
`;
  const rows = parsePsTable(QA_PS_FIXTURE);

  it('roots the tree at the given pid and walks only its descendants', () => {
    const tree = buildProcessTree(rows, { mode: 'pid', pid: 701 });
    assert.equal(tree.mode, 'pid');
    assert.deepEqual([...tree.rootPids], [701]);
    assert.deepEqual([...tree.members.keys()].sort((a, b) => a - b), [701, 702, 703, 704, 705]);
    assert.equal(tree.members.get(704), 701);
    // A launchd-parented opencode elsewhere on the machine is not this target's orphan.
    assert.deepEqual(tree.orphans, []);
    assert.deepEqual([...buildProcessTree(rows).rootPids], [], 'no DevRyan.app runs in this listing');
  });

  it('reports an exited pid root as an empty tree', () => {
    const exited = rows.filter((row) => row.pid !== 701);
    const tree = buildProcessTree(exited, { mode: 'pid', pid: 701 });
    assert.equal(tree.rootPids.size, 0);
    assert.equal(tree.members.size, 0);
  });

  it('labels a generic pid root as the host main process and keeps child roles', () => {
    const { procs } = buildTrackedProcesses({ psRows: rows, topRows: new Map(), footprints: new Map(), target: { mode: 'pid', pid: 701 } });
    const roleOf = new Map(procs.map((proc) => [proc.pid, proc.role]));
    assert.equal(roleOf.get(701), 'electron-main+server');
    assert.equal(roleOf.get(702), 'opencode-serve');
    assert.equal(roleOf.get(703), 'lsp');
    assert.equal(roleOf.get(704), 'lsp');
    assert.equal(roleOf.get(705), 'git');
  });

  it('matches only whole-path references to the runtime root', () => {
    const directories = [RUNTIME_ROOT];
    assert.equal(commandReferencesDirectory(`node --user-data-dir=${RUNTIME_ROOT}/browser-profile`, directories), true);
    assert.equal(commandReferencesDirectory(`git -C ${RUNTIME_ROOT} status`, directories), true);
    assert.equal(commandReferencesDirectory(`node ${RUNTIME_ROOT}`, directories), true);
    assert.equal(commandReferencesDirectory(`node "${RUNTIME_ROOT}/x"`, directories), true);
    assert.equal(commandReferencesDirectory(`node file://${RUNTIME_ROOT}/x.mjs`, directories), true);
    assert.equal(commandReferencesDirectory(`node ${RUNTIME_ROOT}-other/tool.mjs`, directories), false);
    assert.equal(commandReferencesDirectory(`node /elsewhere${RUNTIME_ROOT}/tool.mjs`, directories), false);
    assert.equal(commandReferencesDirectory('node /Users/x/DevRyan/.cache/qa/web-smoke-abc/runtime2', directories), false);
    // Either spelling of a symlinked root (e.g. /tmp and /private/tmp) matches.
    assert.equal(commandReferencesDirectory('node /private/tmp/qa/runtime/x', ['/tmp/qa/runtime', '/private/tmp/qa/runtime']), true);
  });

  it('roots a runtime-root target at the topmost processes naming the directory', () => {
    const target = { mode: 'runtime-root', directories: [RUNTIME_ROOT] };
    const tree = buildProcessTree(rows, target);
    // 803 names the root too, but its parent 801 already does.
    assert.deepEqual([...tree.rootPids].sort((a, b) => a - b), [705, 801, 802]);
    assert.equal(tree.members.get(803), 801);
    assert.equal(tree.members.has(900), false);
    assert.equal(tree.members.has(901), false);
    assert.deepEqual(tree.orphans, []);

    const { procs } = buildTrackedProcesses({ psRows: rows, topRows: new Map(), footprints: new Map(), target });
    const roleOf = new Map(procs.map((proc) => [proc.pid, proc.role]));
    // Specific roots keep their own role; nothing is mislabelled as the main process.
    assert.equal(roleOf.get(801), 'gpu');
    assert.equal(roleOf.get(802), 'renderer');
    assert.equal(roleOf.get(705), 'git');
    assert.equal(roleOf.get(803), 'crashpad');
  });

  it('never samples the sampler, its launching shell, or its own children', () => {
    const samplerRows = parsePsTable(`  PID  PPID %CPU    RSS     ELAPSED COMMAND
    1     0  0.0   6640 02-20:13:26 /sbin/launchd
  600     1  0.0  20480    10:00 /bin/zsh -c node scripts/perf/multi-session-sampler.mjs --runtime-root ${RUNTIME_ROOT}
  601   600  0.5  40960    09:59 node scripts/perf/multi-session-sampler.mjs --runtime-root ${RUNTIME_ROOT}
  602   601  0.0   2048    00:01 ps -axww -o pid,ppid,pcpu,rss,etime,command
  801     1  0.0  46080    08:00 /x/Electron Helper --type=gpu-process --user-data-dir=${RUNTIME_ROOT}/browser-profile
`);
    const runtimeTree = buildProcessTree(samplerRows, { mode: 'runtime-root', directories: [RUNTIME_ROOT], samplerPid: 601 });
    assert.deepEqual([...runtimeTree.rootPids], [801]);
    assert.deepEqual([...runtimeTree.members.keys()], [801]);

    // A pid target that happens to contain the sampler skips its subtree.
    const pidTree = buildProcessTree(samplerRows, { mode: 'pid', pid: 600, samplerPid: 601 });
    assert.deepEqual([...pidTree.members.keys()], [600]);
  });

  it('derives the app version plist only from DevRyan.app bundles', () => {
    assert.equal(appInfoPlistFromCommand('/Applications/DevRyan.app/Contents/MacOS/DevRyan'), '/Applications/DevRyan.app/Contents/Info.plist');
    assert.equal(
      appInfoPlistFromCommand('/Users/x/DevRyan/.cache/qa/packaged-electron-1/mac-arm64/DevRyan.app/Contents/Frameworks/DevRyan Helper.app/Contents/MacOS/DevRyan Helper --type=gpu-process'),
      '/Users/x/DevRyan/.cache/qa/packaged-electron-1/mac-arm64/DevRyan.app/Contents/Info.plist',
    );
    assert.equal(appInfoPlistFromCommand('/Users/x/electron/dist/Electron.app/Contents/MacOS/Electron scripts/qa/isolated-host.mjs'), null);
    assert.equal(appInfoPlistFromCommand('/opt/homebrew/bin/node scripts/qa/isolated-host.mjs'), null);
    assert.equal(appInfoPlistFromCommand(undefined), null);
  });

  it('strips packaged QA bundle prefixes from command previews', () => {
    assert.equal(
      commandPreview('/Users/x/DevRyan/.cache/qa/packaged-electron-1/mac-arm64/DevRyan.app/Contents/MacOS/DevRyan --inspect'),
      'DevRyan --inspect',
    );
  });
});

describe('LSP classification and spawn chains', () => {
  it('classifies LSP servers exactly as the app process runtime does', () => {
    const noRoots = { rootPids: new Set() };
    const commands = [
      '/opt/homebrew/bin/bun x typescript-language-server --stdio',
      '/x/node_modules/.bin/typescript-language-server --stdio',
      '/opt/homebrew/bin/node /x/node_modules/typescript/lib/tsserver.js --serverMode partialSemantic',
      '/x/bin/pyright-langserver --stdio',
      '/usr/local/bin/pylsp',
      '/x/bin/gopls serve',
      '/x/bin/rust-analyzer',
      '/usr/bin/clangd --background-index',
      '/x/bin/lua-language-server',
      '/x/node_modules/.bin/vscode-json-language-server --stdio',
      '/x/bin/bash-language-server start',
      '/x/bin/yaml-language-server --stdio',
      '/x/bin/ruby-lsp',
      '/x/bin/elixir-ls',
      '/usr/bin/git status --porcelain',
      '/opt/homebrew/bin/node /x/runner.js',
      '/x/bin/lspconfig-helper --stdio',
      '/x/pyright/dist/pyright.js --outputjson',
    ];
    for (const command of commands) {
      const appSaysLsp = classifyProcessCommand(command) === 'lsp';
      const samplerSaysLsp = classifyProcess({ pid: 99, command }, noRoots) === 'lsp';
      assert.equal(samplerSaysLsp, appSaysLsp, command);
    }
    // The corpus exercises both outcomes, including servers the old sampler regex missed.
    assert.equal(classifyProcess({ pid: 99, command: '/x/bin/pyright-langserver --stdio' }, noRoots), 'lsp');
    assert.equal(classifyProcess({ pid: 99, command: '/usr/local/bin/pylsp' }, noRoots), 'lsp');
    assert.equal(classifyProcess({ pid: 99, command: '/x/bin/lua-language-server' }, noRoots), 'lsp');
    assert.notEqual(classifyProcess({ pid: 99, command: '/opt/homebrew/bin/node /x/runner.js' }, noRoots), 'lsp');
  });

  it('dumps each LSP server with its sanitized spawn chain up to the root', () => {
    const psText = `  PID  PPID %CPU    RSS     ELAPSED COMMAND
    1     0  0.0   6640 02-20:13:26 /sbin/launchd
  500     1  0.9 148480    46:32 /Applications/DevRyan.app/Contents/MacOS/DevRyan
  510   500  2.9 593920    46:06 /Users/x/.opencode/bin/opencode serve --hostname 127.0.0.1 --port 53961 --password=hunter2
  520   510  1.0 102400    05:00 /opt/homebrew/bin/bun x typescript-language-server --stdio --api-key sk-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOP
  521   520  3.0 307200    04:59 /opt/homebrew/bin/node /Users/x/.cache/opencode/node_modules/typescript/lib/tsserver.js ${'--flag '.repeat(40)}
  530   510  0.1  20480    00:30 /bin/zsh -c ls
`;
    const psRows = parsePsTable(psText);
    const { procs } = buildTrackedProcesses({ psRows, topRows: new Map(), footprints: new Map() });
    const details = describeLspProcesses(procs);

    assert.deepEqual(details.map((entry) => entry.pid), [520, 521]);
    const [languageServer, tsserver] = details;
    assert.equal(languageServer.root, 500);
    assert.deepEqual(languageServer.spawnChain.map((link) => [link.pid, link.role]), [
      [510, 'opencode-serve'],
      [500, 'electron-main+server'],
    ]);
    assert.deepEqual(tsserver.spawnChain.map((link) => link.pid), [520, 510, 500]);
    assert.equal(tsserver.spawnChain[0].role, 'lsp');
    assert.equal(tsserver.ppid, 520);
    assert.ok(tsserver.cmd.length <= 160);

    const serialized = JSON.stringify(details);
    assert.equal(serialized.includes('hunter2'), false);
    assert.equal(serialized.includes('sk-abcdefghijklmnopqrstuvwxyz'), false);
    assert.match(serialized, /--password=<redacted>/);
    assert.match(serialized, /--api-key <redacted>/);
    assert.equal(serialized.includes('/Applications/DevRyan.app'), false);
  });

  it('stops a spawn chain at a missing parent or a cycle', () => {
    const proc = (pid, ppid, role, root = 1) => ({ pid, ppid, role, root, family: role, cmd: role, etime: '00:01', footprint: 1 });
    const detached = describeLspProcesses([proc(10, 9, 'lsp')]);
    assert.deepEqual(detached[0].spawnChain, []);
    const cyclic = describeLspProcesses([proc(10, 11, 'lsp'), proc(11, 12, 'js-child'), proc(12, 11, 'shell')]);
    assert.deepEqual(cyclic[0].spawnChain.map((link) => link.pid), [11, 12]);
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
