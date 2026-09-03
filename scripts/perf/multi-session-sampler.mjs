#!/usr/bin/env node
// Live multi-session resource sampler for a running DevRyan desktop app (macOS).
//
// Read-only by design: it never launches, signals, or reconfigures anything. It
// discovers the running DevRyan.app process tree (Electron main with the
// in-process web server, renderer/GPU/utility helpers, the managed
// `opencode serve`, and every descendant those spawn), samples it on a fixed
// cadence together with Docker bot containers and macOS-wide memory pressure,
// and appends JSONL under .cache/perf/multi-session/<label>/.
//
//   node scripts/perf/multi-session-sampler.mjs --label dozen --interval 5
//   echo "sent 12 drafts" >> .cache/perf/multi-session/dozen/marks.txt
//   node scripts/perf/multi-session-report.mjs .cache/perf/multi-session/dozen
//
// Memory is macOS phys_footprint (Activity Monitor's Memory column) from
// `footprint`, with `top` as the fallback. `ps` RSS is recorded only as a
// secondary column because it undercounts compressed and swapped pages.
//
// Optional authenticated server metrics (server heap, Electron app metrics,
// busy session count) need the UI session cookie: --cookie <oc_ui_session> or
// DEVRYAN_UI_SESSION_COOKIE. Without it the sampler still records everything
// visible from the OS plus the unauthenticated /api/health probe.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../..');

export const DEVRYAN_APP_PATTERN = /DevRyan\.app\/Contents\/MacOS\/DevRyan(?:\s|$)/;
const DEVRYAN_BUNDLE_PREFIX = /\/Applications\/DevRyan\.app\/Contents\/(?:Frameworks|MacOS)\//g;
const ORPHAN_PATTERNS = [
  /\/opencode serve\b/,
  /cursor-agent/,
  /context-mode-worker/,
  /cloudflared tunnel/,
  /agent-browser/,
];
const SYSTEM_TOP_COUNT = 10;
const MAX_FOOTPRINT_PIDS = 80;
const COMMAND_PREVIEW_LENGTH = 160;
const COOKIE_NAME = 'oc_ui_session';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

export const parseDuration = (raw) => {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(String(raw).trim());
  if (!match) throw new Error(`Invalid duration: ${raw}`);
  const unit = match[2] || 'm';
  return Math.round(Number(match[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit]);
};

export const parseSamplerArguments = (argv, env = process.env) => {
  const options = {
    label: new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19),
    intervalMs: 5000,
    durationMs: null,
    dockerEvery: 6,
    fdsEvery: 12,
    categoriesEvery: 12,
    server: 'http://127.0.0.1:3000',
    cookie: env.DEVRYAN_UI_SESSION_COOKIE || null,
    outRoot: path.join(repositoryRoot, '.cache/perf/multi-session'),
    opencodeLog: path.join(os.homedir(), '.local/share/opencode/log/opencode.log'),
    mainLog: path.join(os.homedir(), 'Library/Logs/DevRyan/main.log'),
    quiet: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const takeValue = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${flag} requires a value`);
      index += 1;
      return value;
    };
    const takeCount = () => Math.max(0, Number.parseInt(takeValue(), 10) || 0);
    switch (flag) {
      case '--label': options.label = takeValue(); break;
      case '--interval': options.intervalMs = Math.max(1, Number(takeValue()) || 5) * 1000; break;
      case '--duration': options.durationMs = parseDuration(takeValue()); break;
      case '--docker-every': options.dockerEvery = takeCount(); break;
      case '--fds-every': options.fdsEvery = takeCount(); break;
      case '--categories-every': options.categoriesEvery = takeCount(); break;
      case '--server': options.server = takeValue().replace(/\/+$/, ''); break;
      case '--cookie': options.cookie = takeValue(); break;
      case '--out': options.outRoot = path.resolve(takeValue()); break;
      case '--quiet': options.quiet = true; break;
      case '--help': case '-h': options.help = true; break;
      default: throw new Error(`Unknown flag ${flag}`);
    }
  }
  if (!/^[A-Za-z0-9._-]+$/.test(options.label)) throw new Error('--label may only contain letters, digits, ., _ and -');
  return options;
};

const HELP = `Usage: node scripts/perf/multi-session-sampler.mjs [options]

  --label <name>          run directory name under .cache/perf/multi-session (default: timestamp)
  --interval <seconds>    sample cadence (default 5; a tick costs ~2.5s because top takes two samples)
  --duration <10m|2h|90s> stop automatically (default: run until Ctrl+C)
  --docker-every <n>      docker stats every n ticks (default 6, 0 disables)
  --fds-every <n>         lsof fd counts for main + opencode every n ticks (default 12, 0 disables)
  --categories-every <n>  footprint category breakdown every n ticks (default 12, 0 disables)
  --server <origin>       DevRyan web server origin (default http://127.0.0.1:3000)
  --cookie <value>        ${COOKIE_NAME} cookie value for authenticated server metrics
  --out <dir>             output root (default .cache/perf/multi-session)
  --quiet                 no per-tick console line

Add a marker at any time:  echo "sent 12 drafts" >> <run dir>/marks.txt
`;

// ---------------------------------------------------------------------------
// Parsers (pure, unit-tested)
// ---------------------------------------------------------------------------

const SIZE_UNITS = {
  b: 1, k: 1024, kb: 1000, kib: 1024, m: 1024 ** 2, mb: 1000 ** 2, mib: 1024 ** 2,
  g: 1024 ** 3, gb: 1000 ** 3, gib: 1024 ** 3, t: 1024 ** 4, tb: 1000 ** 4, tib: 1024 ** 4,
};

export const parseSize = (raw) => {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([A-Za-z]*)[+-]?\s*$/.exec(String(raw ?? ''));
  if (!match) return null;
  const multiplier = SIZE_UNITS[(match[2] || 'b').toLowerCase()];
  if (!multiplier) return null;
  return Math.round(Number(match[1]) * multiplier);
};

export const parsePsTable = (text) => {
  const rows = [];
  for (const line of text.split('\n').slice(1)) {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      lifetimeCpu: Number(match[3]),
      rssBytes: Number(match[4]) * 1024,
      etime: match[5],
      command: match[6].trim(),
    });
  }
  return rows;
};

// `top -l 2 ... -stats pid,ppid,cpu,mem,cmprs,threads,pageins,command`; only the
// last sample block carries real CPU deltas, so parse from the last PID header.
export const parseTopOutput = (text) => {
  const rows = new Map();
  const headerIndex = text.lastIndexOf('\nPID ');
  if (headerIndex === -1) return rows;
  for (const line of text.slice(headerIndex + 1).split('\n').slice(1)) {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(\S+)\s+(\d+)(?:\/\d+)?\s+(\d+)[+-]?\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    rows.set(pid, {
      pid,
      ppid: Number(match[2]),
      cpu: Number(match[3]),
      footprint: parseSize(match[4]),
      compressed: parseSize(match[5]),
      threads: Number(match[6]),
      pageins: Number(match[7]),
      name: match[8].trim(),
    });
  }
  return rows;
};

export const parseVmStat = (text) => {
  const pageSize = Number(/page size of (\d+)/.exec(text)?.[1] || 16384);
  const value = (label) => {
    const match = new RegExp(`${label}:\\s+(\\d+)`).exec(text);
    return match ? Number(match[1]) : null;
  };
  const bytes = (label) => {
    const pages = value(label);
    return pages === null ? null : pages * pageSize;
  };
  return {
    pageSize,
    freeBytes: bytes('Pages free'),
    activeBytes: bytes('Pages active'),
    inactiveBytes: bytes('Pages inactive'),
    wiredBytes: bytes('Pages wired down'),
    compressorBytes: bytes('Pages occupied by compressor'),
    storedInCompressorBytes: bytes('Pages stored in compressor'),
    swapins: value('Swapins'),
    swapouts: value('Swapouts'),
    pageouts: value('Pageouts'),
    compressions: value('Compressions'),
  };
};

export const parseSysctl = (text) => {
  const swap = /vm\.swapusage:\s+total = ([\d.]+)M\s+used = ([\d.]+)M\s+free = ([\d.]+)M/.exec(text);
  const load = /vm\.loadavg:\s*\{\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(text);
  return {
    swapTotalBytes: swap ? Math.round(Number(swap[1]) * 1024 ** 2) : null,
    swapUsedBytes: swap ? Math.round(Number(swap[2]) * 1024 ** 2) : null,
    load1: load ? Number(load[1]) : null,
    load5: load ? Number(load[2]) : null,
    load15: load ? Number(load[3]) : null,
  };
};

export const parseMemoryPressure = (text) => {
  const match = /System-wide memory free percentage:\s*(\d+)%/.exec(text);
  return match ? Number(match[1]) : null;
};

export const parseDockerStats = (text) => text
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => {
    const [name, memUsage = '', cpuPerc = ''] = line.split('\t');
    const [used, limit] = memUsage.split('/').map((part) => part.trim());
    return {
      name,
      memBytes: parseSize(used),
      limitBytes: parseSize(limit),
      cpuPct: Number(cpuPerc.replace('%', '')) || 0,
    };
  });

export const parseFootprintJson = (json) => {
  const processes = new Map();
  for (const entry of json?.processes || []) {
    if (typeof entry?.pid !== 'number') continue;
    let swapped = 0;
    const categories = {};
    for (const [name, category] of Object.entries(entry.categories || {})) {
      swapped += Number(category?.swapped || 0);
      const dirty = Number(category?.dirty || 0);
      if (dirty > 0) categories[name] = dirty;
    }
    processes.set(entry.pid, { footprint: Number(entry.footprint) || 0, swapped, categories });
  }
  return processes;
};

// ---------------------------------------------------------------------------
// Process tree + classification
// ---------------------------------------------------------------------------

const SECRET_ARGUMENT_PATTERN = /(--?(?:token|password|passwd|secret|api-?key|auth|bearer|cookie)(?:=|\s+))\S+/gi;
const LONG_OPAQUE_TOKEN_PATTERN = /\b(?=[A-Za-z0-9_-]{48,}\b)(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]+\b/g;

export const commandPreview = (command) => command
  .replace(DEVRYAN_BUNDLE_PREFIX, '')
  .replace(/--user-data-dir=\S+/g, '')
  .replace(SECRET_ARGUMENT_PATTERN, '$1<redacted>')
  .replace(LONG_OPAQUE_TOKEN_PATTERN, '<redacted>')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, COMMAND_PREVIEW_LENGTH);

export const commandFamily = (command) => {
  const tokens = command.trim().split(/\s+/);
  const executable = path.basename(tokens[0] || '').replace(/\.(mjs|cjs|js|sh)$/, '');
  const argument = tokens.find((token, index) => index > 0 && !token.startsWith('-'));
  if (!argument || /^(node|bun|python3?|sh|zsh|bash)$/.test(executable) === false) {
    return argument && !argument.includes('/') ? `${executable} ${argument}` : executable;
  }
  return `${executable} ${path.basename(argument)}`;
};

export const classifyProcess = (row, { rootPids }) => {
  const command = row.command;
  if (rootPids.has(row.pid)) {
    return /--runtime-service/.test(command) ? 'runtime-service-main' : 'electron-main+server';
  }
  if (/--type=renderer/.test(command)) return 'renderer';
  if (/--type=gpu-process/.test(command)) return 'gpu';
  if (/--type=utility/.test(command)) {
    const subtype = /--utility-sub-type=([\w.]+)/.exec(command)?.[1] || 'unknown';
    return `utility:${subtype.replace('.mojom.', ':').replace(/Service$/, '')}`;
  }
  if (/--type=zygote/.test(command)) return 'zygote';
  if (/crashpad/.test(command)) return 'crashpad';
  if (/\/opencode serve\b|(^|\s)opencode serve\b/.test(command)) return 'opencode-serve';
  if (/cloudflared/.test(command)) return 'cloudflared';
  if (/cursor-acp|open-cursor/.test(command)) return 'cursor-acp-runner';
  if (/cursor-agent/.test(command)) return 'cursor-agent';
  if (/claude(\.app\/Contents\/MacOS\/claude|\s--output-format)/.test(command)) return 'claude-cli';
  if (/context-mode/.test(command)) return 'context-mode-worker';
  if (/agent-browser/.test(command)) return 'agent-browser';
  if (/(^|\/)git(\s|$)/.test(command)) return 'git';
  if (/(^|\/)(rg|ripgrep)(\s|$)/.test(command)) return 'ripgrep';
  if (/(^|\/)(zsh|bash|sh|fish)(\s|$)/.test(command)) return 'shell';
  if (/(^|\/)(node|bun|deno)(\s|$)/.test(command)) return 'js-child';
  if (/(^|\/)(python3?|uv|uvx)(\s|$)/.test(command)) return 'python-child';
  return 'other-child';
};

export const buildProcessTree = (rows) => {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const children = new Map();
  for (const row of rows) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row.pid);
  }
  const rootPids = new Set(rows
    .filter((row) => DEVRYAN_APP_PATTERN.test(row.command)
      && !DEVRYAN_APP_PATTERN.test(byPid.get(row.ppid)?.command || ''))
    .map((row) => row.pid));
  const members = new Map();
  const walk = (pid, root) => {
    if (members.has(pid)) return;
    members.set(pid, root);
    for (const child of children.get(pid) || []) walk(child, root);
  };
  for (const root of rootPids) walk(root, root);
  const orphans = rows.filter((row) => row.ppid === 1
    && !members.has(row.pid)
    && ORPHAN_PATTERNS.some((pattern) => pattern.test(row.command)));
  return { rootPids, members, orphans, byPid };
};

// ---------------------------------------------------------------------------
// Collectors
// ---------------------------------------------------------------------------

const run = async (file, args = [], { timeoutMs = 15_000 } = {}) => {
  const { stdout } = await execFileAsync(file, args, {
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'utf8',
  });
  return stdout;
};

const runOptional = (file, args, options) => run(file, args, options).catch(() => '');

const collectFootprint = async (pids, jsonPath) => {
  if (pids.length === 0) return new Map();
  const args = ['-j', jsonPath];
  for (const pid of pids.slice(0, MAX_FOOTPRINT_PIDS)) args.push('-p', String(pid));
  try {
    await execFileAsync('footprint', args, { timeout: 20_000, maxBuffer: 16 * 1024 * 1024 });
    const json = JSON.parse(await fsp.readFile(jsonPath, 'utf8'));
    return parseFootprintJson(json);
  } catch {
    return new Map();
  }
};

const countFds = async (pid) => {
  const text = await runOptional('lsof', ['-n', '-P', '-p', String(pid)], { timeoutMs: 20_000 });
  const lines = text.split('\n').filter(Boolean).length;
  return lines > 0 ? lines - 1 : null;
};

const fetchJson = async (url, { cookie = null, timeoutMs = 4000 } = {}) => {
  const startedAt = performance.now();
  const headers = { accept: 'application/json' };
  if (cookie) headers.cookie = `${COOKIE_NAME}=${cookie}`;
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    return { ok: response.ok, status: response.status, ms: Math.round(performance.now() - startedAt), body };
  } catch (error) {
    return { ok: false, status: 0, ms: Math.round(performance.now() - startedAt), error: error?.name || 'fetch_failed' };
  }
};

const summarizeAppMetrics = (appMetrics) => {
  if (!Array.isArray(appMetrics)) return null;
  const byType = {};
  for (const entry of appMetrics) {
    const type = entry?.type || 'unknown';
    const bucket = byType[type] || (byType[type] = { count: 0, workingSetBytes: 0, privateBytes: 0, cpu: 0 });
    bucket.count += 1;
    bucket.workingSetBytes += Number(entry?.memory?.workingSetSize || 0) * 1024;
    bucket.privateBytes += Number(entry?.memory?.privateBytes || 0) * 1024;
    bucket.cpu += Number(entry?.cpu?.percentCPUUsage || 0);
  }
  return byType;
};

const collectServer = async (options, state) => {
  const health = await fetchJson(`${options.server}/api/health`);
  const server = {
    healthStatus: health.status,
    healthMs: health.ms,
    openCodeReady: health.body?.isOpenCodeReady ?? null,
    openCodeProbeMs: health.body?.openCodeProbe?.durationMs ?? null,
    openCodeProbeOk: health.body?.openCodeProbe?.succeeded ?? null,
    authenticated: false,
    debugMemory: null,
    appMetrics: null,
    sessions: null,
  };
  if (options.cookie && !state.cookieRejected) {
    const [memory, status] = await Promise.all([
      fetchJson(`${options.server}/api/debug/memory`, { cookie: options.cookie }),
      fetchJson(`${options.server}/api/session/status`, { cookie: options.cookie }),
    ]);
    if (memory.status === 401 || status.status === 401) {
      state.cookieRejected = true;
      console.warn('[sampler] cookie rejected (401); continuing without authenticated server metrics');
    } else {
      server.authenticated = memory.ok || status.ok;
      if (memory.ok) {
        server.debugMemory = { ms: memory.ms, ...(memory.body?.process || {}) };
        server.appMetrics = summarizeAppMetrics(memory.body?.appMetrics);
      }
      if (status.ok && status.body && typeof status.body === 'object') {
        const entries = Object.values(status.body);
        const busy = entries.filter((entry) => entry && typeof entry === 'object' && entry.type && entry.type !== 'idle');
        server.sessions = {
          ms: status.ms,
          tracked: entries.length,
          busy: busy.length,
          byType: busy.reduce((acc, entry) => { acc[entry.type] = (acc[entry.type] || 0) + 1; return acc; }, {}),
        };
      }
    }
  }
  return server;
};

const readMarks = async (marksPath, state) => {
  let text = '';
  try { text = await fsp.readFile(marksPath, 'utf8'); } catch { return []; }
  const fresh = text.slice(state.marksOffset);
  state.marksOffset = text.length;
  return fresh.split('\n').map((line) => line.trim()).filter(Boolean);
};

const fileSize = async (filePath) => {
  try { return (await fsp.stat(filePath)).size; } catch { return null; }
};

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

export const buildTrackedProcesses = ({ psRows, topRows, footprints }) => {
  const tree = buildProcessTree(psRows);
  const describe = (row, kind) => {
    const top = topRows.get(row.pid);
    const fp = footprints.get(row.pid);
    const role = classifyProcess(row, { rootPids: tree.rootPids });
    return {
      pid: row.pid,
      ppid: row.ppid,
      root: tree.members.get(row.pid) ?? null,
      kind,
      role,
      family: commandFamily(row.command),
      cmd: commandPreview(row.command),
      etime: row.etime,
      footprint: fp?.footprint ?? top?.footprint ?? row.rssBytes,
      footprintSource: fp ? 'footprint' : (top ? 'top' : 'ps-rss'),
      swapped: fp?.swapped ?? null,
      compressed: top?.compressed ?? null,
      rssBytes: row.rssBytes,
      cpu: top?.cpu ?? null,
      threads: top?.threads ?? null,
      pageins: top?.pageins ?? null,
      categories: fp?.categories && Object.keys(fp.categories).length > 0 ? fp.categories : undefined,
    };
  };
  const procs = [...tree.members.keys()]
    .map((pid) => tree.byPid.get(pid))
    .filter(Boolean)
    .map((row) => describe(row, 'tree'));
  const orphans = tree.orphans.map((row) => describe(row, 'orphan'));
  procs.sort((a, b) => b.footprint - a.footprint);
  orphans.sort((a, b) => b.footprint - a.footprint);
  return { tree, procs, orphans };
};

export const summarizeRoles = (procs) => {
  const byRole = {};
  for (const proc of procs) {
    const bucket = byRole[proc.role] || (byRole[proc.role] = { count: 0, footprint: 0, cpu: 0, threads: 0 });
    bucket.count += 1;
    bucket.footprint += proc.footprint || 0;
    bucket.cpu += proc.cpu || 0;
    bucket.threads += proc.threads || 0;
  }
  return byRole;
};

const systemTopConsumers = (topRows) => {
  const rows = [...topRows.values()];
  const byMemory = rows.slice().sort((a, b) => (b.footprint || 0) - (a.footprint || 0)).slice(0, SYSTEM_TOP_COUNT);
  const byCpu = rows.slice().sort((a, b) => (b.cpu || 0) - (a.cpu || 0)).slice(0, 5);
  const seen = new Set();
  const picked = [];
  for (const row of [...byMemory, ...byCpu]) {
    if (seen.has(row.pid)) continue;
    seen.add(row.pid);
    picked.push({ pid: row.pid, name: row.name, footprint: row.footprint, compressed: row.compressed, cpu: row.cpu });
  }
  return picked;
};

const collectTick = async (options, state, paths) => {
  const tick = state.tick;
  const startedAt = Date.now();
  const dockerDue = options.dockerEvery > 0 && tick % options.dockerEvery === 0;
  const fdsDue = options.fdsEvery > 0 && tick % options.fdsEvery === 0;

  const [psText, topText, vmText, sysctlText, pressureText, dockerText, server] = await Promise.all([
    run('ps', ['-axww', '-o', 'pid,ppid,pcpu,rss,etime,command']),
    run('top', ['-l', '2', '-s', '1', '-stats', 'pid,ppid,cpu,mem,cmprs,threads,pageins,command', '-o', 'mem', '-n', '900'], { timeoutMs: 30_000 }),
    run('vm_stat'),
    run('sysctl', ['vm.swapusage', 'vm.loadavg']),
    runOptional('memory_pressure', [], { timeoutMs: 8000 }),
    dockerDue
      ? runOptional('docker', ['stats', '--no-stream', '--format', '{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}'], { timeoutMs: 12_000 })
      : Promise.resolve(null),
    collectServer(options, state),
  ]);

  const psRows = parsePsTable(psText);
  const topRows = parseTopOutput(topText);
  const tree = buildProcessTree(psRows);
  const trackedPids = [...tree.members.keys(), ...tree.orphans.map((row) => row.pid)];
  const footprints = await collectFootprint(trackedPids, paths.footprintJson);
  const { procs, orphans } = buildTrackedProcesses({ psRows, topRows, footprints });
  if (!(options.categoriesEvery > 0 && tick % options.categoriesEvery === 0)) {
    for (const proc of [...procs, ...orphans]) delete proc.categories;
  }

  const fds = {};
  if (fdsDue) {
    const targets = procs.filter((proc) => proc.role === 'electron-main+server' || proc.role === 'opencode-serve' || proc.role === 'renderer');
    const counts = await Promise.all(targets.map((proc) => countFds(proc.pid)));
    targets.forEach((proc, index) => { fds[proc.pid] = { role: proc.role, fds: counts[index] }; });
  }

  const vm = parseVmStat(vmText);
  const sysctl = parseSysctl(sysctlText);
  const docker = dockerText === null ? null : (() => {
    const containers = parseDockerStats(dockerText);
    const devryan = containers.filter((container) => /devryan/i.test(container.name));
    const others = containers.filter((container) => !/devryan/i.test(container.name));
    return {
      devryan,
      otherContainerCount: others.length,
      otherContainersMemBytes: others.reduce((sum, container) => sum + (container.memBytes || 0), 0),
      otherContainersCpuPct: others.reduce((sum, container) => sum + (container.cpuPct || 0), 0),
    };
  })();

  const marks = await readMarks(paths.marks, state);
  const now = new Date();
  const byRole = summarizeRoles(procs);
  const sample = {
    t: now.toISOString(),
    elapsedS: Math.round((now.getTime() - state.startedAt) / 1000),
    tick,
    tickMs: Date.now() - startedAt,
    system: {
      freePct: parseMemoryPressure(pressureText),
      ...vm,
      ...sysctl,
    },
    devryan: {
      rootPids: [...tree.rootPids],
      processCount: procs.length,
      totalFootprint: procs.reduce((sum, proc) => sum + (proc.footprint || 0), 0),
      totalCpu: procs.reduce((sum, proc) => sum + (proc.cpu || 0), 0),
      byRole,
    },
    procs,
    orphans,
    docker,
    fds: fdsDue ? fds : null,
    logs: {
      opencodeLogBytes: await fileSize(options.opencodeLog),
      mainLogBytes: await fileSize(options.mainLog),
    },
    server,
    topSystem: systemTopConsumers(topRows),
    marks,
  };

  // Process lifecycle events (spawn/exit) with peak footprint per pid.
  const events = [];
  const currentPids = new Map([...procs, ...orphans].map((proc) => [proc.pid, proc]));
  for (const [pid, proc] of currentPids) {
    const known = state.known.get(pid);
    if (!known) {
      state.known.set(pid, { firstSeen: now.getTime(), role: proc.role, cmd: proc.cmd, family: proc.family, peak: proc.footprint || 0, kind: proc.kind });
      if (tick > 0) events.push({ t: sample.t, elapsedS: sample.elapsedS, type: 'spawn', pid, ppid: proc.ppid, role: proc.role, family: proc.family, kind: proc.kind, cmd: proc.cmd });
    } else if ((proc.footprint || 0) > known.peak) {
      known.peak = proc.footprint || 0;
    }
  }
  for (const [pid, known] of state.known) {
    if (currentPids.has(pid)) continue;
    events.push({
      t: sample.t,
      elapsedS: sample.elapsedS,
      type: 'exit',
      pid,
      role: known.role,
      family: known.family,
      kind: known.kind,
      cmd: known.cmd,
      lifetimeS: Math.round((now.getTime() - known.firstSeen) / 1000),
      peakFootprint: known.peak,
    });
    state.known.delete(pid);
  }
  for (const mark of marks) events.push({ t: sample.t, elapsedS: sample.elapsedS, type: 'mark', text: mark });

  return { sample, events };
};

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export const formatBytes = (bytes) => {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return 'n/a';
  const abs = Math.abs(bytes);
  if (abs >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)}G`;
  if (abs >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)}M`;
  if (abs >= 1024) return `${Math.round(bytes / 1024)}K`;
  return `${bytes}B`;
};

const formatElapsed = (seconds) => {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `+${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
};

const liveLine = (sample) => {
  const role = (name) => formatBytes(sample.devryan.byRole[name]?.footprint ?? 0);
  const childRoles = Object.entries(sample.devryan.byRole)
    .filter(([name]) => !['electron-main+server', 'renderer', 'gpu', 'opencode-serve'].includes(name) && !name.startsWith('utility:'))
    .reduce((acc, [, bucket]) => ({ count: acc.count + bucket.count, footprint: acc.footprint + bucket.footprint }), { count: 0, footprint: 0 });
  const parts = [
    formatElapsed(sample.elapsedS),
    `DevRyan ${formatBytes(sample.devryan.totalFootprint)}`,
    `[main ${role('electron-main+server')} | opencode ${role('opencode-serve')} | renderer ${role('renderer')} | gpu ${role('gpu')} | children ${childRoles.count}=${formatBytes(childRoles.footprint)}]`,
    `cpu ${sample.devryan.totalCpu.toFixed(0)}%`,
    `sys free ${sample.system.freePct ?? '?'}% swap ${formatBytes(sample.system.swapUsedBytes)} comp ${formatBytes(sample.system.compressorBytes)} load ${sample.system.load1 ?? '?'}`,
    `health ${sample.server.healthMs}ms/${sample.server.healthStatus}`,
  ];
  if (sample.server.openCodeProbeMs !== null) parts.push(`probe ${sample.server.openCodeProbeMs}ms`);
  if (sample.server.sessions) parts.push(`busy ${sample.server.sessions.busy}/${sample.server.sessions.tracked}`);
  if (sample.orphans.length > 0) parts.push(`orphans ${sample.orphans.length}`);
  if (sample.marks.length > 0) parts.push(`MARK ${sample.marks.join(' | ')}`);
  return parts.join(' ');
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const readDockerSettings = async () => {
  try {
    const raw = await fsp.readFile(path.join(os.homedir(), 'Library/Group Containers/group.com.docker/settings-store.json'), 'utf8');
    const json = JSON.parse(raw);
    return { memoryMiB: json.MemoryMiB ?? null, cpus: json.Cpus ?? null, swapMiB: json.SwapMiB ?? null };
  } catch {
    return null;
  }
};

const collectMeta = async (options) => {
  const [productVersion, memsize, ncpu, brand, appVersion, health, dockerSettings] = await Promise.all([
    runOptional('sw_vers', ['-productVersion']),
    runOptional('sysctl', ['-n', 'hw.memsize']),
    runOptional('sysctl', ['-n', 'hw.ncpu']),
    runOptional('sysctl', ['-n', 'machdep.cpu.brand_string']),
    runOptional('defaults', ['read', '/Applications/DevRyan.app/Contents/Info.plist', 'CFBundleShortVersionString']),
    fetchJson(`${options.server}/api/health`),
    readDockerSettings(),
  ]);
  return {
    label: options.label,
    startedAt: new Date().toISOString(),
    options: { ...options, cookie: options.cookie ? '<provided>' : null },
    machine: {
      macos: productVersion.trim() || null,
      memoryBytes: Number(memsize.trim()) || null,
      cpus: Number(ncpu.trim()) || null,
      cpu: brand.trim() || null,
    },
    devryanVersion: appVersion.trim() || null,
    opencodeVersion: health.body?.openCodeVersion ?? null,
    opencodeLaunch: health.body?.lastOpenCodeLaunchDiagnostics ?? null,
    dockerSettings,
  };
};

const main = async () => {
  const options = parseSamplerArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  if (process.platform !== 'darwin') throw new Error('This sampler relies on macOS footprint/top/vm_stat');

  const runDir = path.join(options.outRoot, options.label);
  await fsp.mkdir(runDir, { recursive: true });
  const paths = {
    samples: path.join(runDir, 'samples.jsonl'),
    events: path.join(runDir, 'events.jsonl'),
    meta: path.join(runDir, 'meta.json'),
    marks: path.join(runDir, 'marks.txt'),
    pid: path.join(runDir, 'sampler.pid'),
    footprintJson: path.join(runDir, '.footprint.json'),
  };
  const samplesStream = fs.createWriteStream(paths.samples, { flags: 'a' });
  const eventsStream = fs.createWriteStream(paths.events, { flags: 'a' });
  const meta = await collectMeta(options);
  meta.samplerPid = process.pid;
  await fsp.writeFile(paths.meta, JSON.stringify(meta, null, 2));
  await fsp.writeFile(paths.pid, `${process.pid}\n`);
  try { await fsp.access(paths.marks); } catch { await fsp.writeFile(paths.marks, ''); }

  const state = { tick: 0, startedAt: Date.now(), known: new Map(), marksOffset: 0, cookieRejected: false, stopping: false };
  console.log(`[sampler] run dir: ${runDir}`);
  console.log(`[sampler] DevRyan ${meta.devryanVersion ?? '?'} / opencode ${meta.opencodeVersion ?? '?'} / ${meta.machine.cpu ?? '?'} ${formatBytes(meta.machine.memoryBytes)} / Docker VM ${meta.dockerSettings?.memoryMiB ?? '?'} MiB`);
  console.log(`[sampler] interval ${options.intervalMs / 1000}s, docker every ${options.dockerEvery} ticks, fds every ${options.fdsEvery} ticks, auth ${options.cookie ? 'cookie' : 'none (health only)'}`);
  console.log(`[sampler] add a marker with: echo "text" >> ${paths.marks}`);
  console.log(`[sampler] stop with: kill -INT ${process.pid}   (pid also in ${paths.pid})`);

  const stop = () => { state.stopping = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  const deadline = options.durationMs ? state.startedAt + options.durationMs : null;
  while (!state.stopping) {
    const tickStartedAt = Date.now();
    try {
      const { sample, events } = await collectTick(options, state, paths);
      samplesStream.write(`${JSON.stringify(sample)}\n`);
      for (const event of events) eventsStream.write(`${JSON.stringify(event)}\n`);
      if (!options.quiet) {
        console.log(liveLine(sample));
        for (const event of events) {
          if (event.type === 'spawn') console.log(`   + spawn pid ${event.pid} ${event.role} ${event.cmd.slice(0, 90)}`);
          if (event.type === 'exit') console.log(`   - exit  pid ${event.pid} ${event.role} after ${event.lifetimeS}s peak ${formatBytes(event.peakFootprint)}`);
        }
        if (sample.devryan.rootPids.length === 0) console.log('   ! no running DevRyan.app process found');
      }
    } catch (error) {
      console.error(`[sampler] tick ${state.tick} failed: ${error?.stack || error}`);
    }
    state.tick += 1;
    if (deadline && Date.now() >= deadline) break;
    const wait = Math.max(250, options.intervalMs - (Date.now() - tickStartedAt));
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, wait);
      const poll = setInterval(() => { if (state.stopping) { clearTimeout(timer); clearInterval(poll); resolve(); } }, 200);
      timer.unref?.();
      setTimeout(() => clearInterval(poll), wait + 50).unref?.();
    });
  }

  meta.endedAt = new Date().toISOString();
  meta.ticks = state.tick;
  await fsp.writeFile(paths.meta, JSON.stringify(meta, null, 2));
  await new Promise((resolve) => samplesStream.end(resolve));
  await new Promise((resolve) => eventsStream.end(resolve));
  await fsp.rm(paths.footprintJson, { force: true });
  await fsp.rm(paths.pid, { force: true });
  console.log(`[sampler] stopped after ${state.tick} ticks -> ${runDir}`);
  console.log(`[sampler] report: node scripts/perf/multi-session-report.mjs ${path.relative(process.cwd(), runDir) || runDir}`);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack || String(error));
    process.exit(1);
  });
}
