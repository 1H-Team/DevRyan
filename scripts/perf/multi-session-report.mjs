#!/usr/bin/env node
// Summarize a multi-session-sampler run (samples.jsonl + events.jsonl +
// meta.json) into report.md next to the data, and print it.
//
//   node scripts/perf/multi-session-report.mjs .cache/perf/multi-session/<label>
//   node scripts/perf/multi-session-report.mjs <runDir> --compare <otherRunDir>

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE_ROLES = ['electron-main+server', 'opencode-serve', 'renderer', 'gpu'];

// ---------------------------------------------------------------------------
// Math helpers (pure, unit-tested)
// ---------------------------------------------------------------------------

export const percentile = (values, p) => {
  const sorted = values.filter((value) => typeof value === 'number' && !Number.isNaN(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
};

export const linearSlopePerMinute = (points) => {
  const valid = points.filter((point) => typeof point.v === 'number' && !Number.isNaN(point.v));
  if (valid.length < 2) return 0;
  const n = valid.length;
  const meanT = valid.reduce((sum, point) => sum + point.t, 0) / n;
  const meanV = valid.reduce((sum, point) => sum + point.v, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (const point of valid) {
    numerator += (point.t - meanT) * (point.v - meanV);
    denominator += (point.t - meanT) ** 2;
  }
  if (denominator === 0) return 0;
  return (numerator / denominator) * 60_000;
};

export const summarizeSeries = (points) => {
  const valid = points.filter((point) => typeof point.v === 'number' && !Number.isNaN(point.v));
  if (valid.length === 0) return null;
  let peak = valid[0];
  let low = valid[0];
  let sum = 0;
  for (const point of valid) {
    sum += point.v;
    if (point.v > peak.v) peak = point;
    if (point.v < low.v) low = point;
  }
  return {
    count: valid.length,
    min: low.v,
    max: peak.v,
    avg: sum / valid.length,
    first: valid[0].v,
    last: valid[valid.length - 1].v,
    peakAt: peak.t,
    p95: percentile(valid.map((point) => point.v), 95),
    slopePerMin: linearSlopePerMinute(valid),
  };
};

export const formatBytes = (bytes) => {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return 'n/a';
  const abs = Math.abs(bytes);
  const sign = bytes < 0 ? '-' : '';
  if (abs >= 1024 ** 3) return `${sign}${(abs / 1024 ** 3).toFixed(2)} GiB`;
  if (abs >= 1024 ** 2) return `${sign}${Math.round(abs / 1024 ** 2)} MiB`;
  if (abs >= 1024) return `${sign}${Math.round(abs / 1024)} KiB`;
  return `${sign}${Math.round(abs)} B`;
};

const formatNumber = (value, digits = 0) => (typeof value === 'number' && !Number.isNaN(value) ? value.toFixed(digits) : 'n/a');
const formatMs = (value) => (typeof value === 'number' ? `${Math.round(value)} ms` : 'n/a');
const formatElapsed = (seconds) => {
  if (typeof seconds !== 'number') return 'n/a';
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
};
const formatDelta = (bytes) => (bytes >= 0 ? `+${formatBytes(bytes)}` : formatBytes(bytes));
const table = (headers, rows) => [
  `| ${headers.join(' | ')} |`,
  `| ${headers.map(() => '---').join(' | ')} |`,
  ...rows.map((row) => `| ${row.map((cell) => String(cell ?? 'n/a')).join(' | ')} |`),
].join('\n');

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const readJsonl = (filePath) => {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
};

export const loadRun = (runDir) => {
  const meta = fs.existsSync(path.join(runDir, 'meta.json'))
    ? JSON.parse(fs.readFileSync(path.join(runDir, 'meta.json'), 'utf8'))
    : {};
  return {
    dir: runDir,
    meta,
    samples: readJsonl(path.join(runDir, 'samples.jsonl')),
    events: readJsonl(path.join(runDir, 'events.jsonl')),
  };
};

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

const timeOf = (sample) => Date.parse(sample.t);
const seriesOf = (samples, pick) => samples.map((sample) => ({ t: timeOf(sample), elapsedS: sample.elapsedS, v: pick(sample) }));
const elapsedAt = (samples, t) => samples.find((sample) => timeOf(sample) === t)?.elapsedS;

export const analyzeRun = ({ meta, samples, events }) => {
  if (samples.length === 0) return null;
  const roleNames = new Set();
  for (const sample of samples) for (const role of Object.keys(sample.devryan?.byRole || {})) roleNames.add(role);

  const roles = {};
  for (const role of roleNames) {
    const footprint = summarizeSeries(seriesOf(samples, (sample) => sample.devryan.byRole[role]?.footprint ?? null));
    const cpu = summarizeSeries(seriesOf(samples, (sample) => sample.devryan.byRole[role]?.cpu ?? null));
    const count = summarizeSeries(seriesOf(samples, (sample) => sample.devryan.byRole[role]?.count ?? 0));
    const threads = summarizeSeries(seriesOf(samples, (sample) => sample.devryan.byRole[role]?.threads ?? null));
    roles[role] = { footprint, cpu, count, threads };
  }

  const total = summarizeSeries(seriesOf(samples, (sample) => sample.devryan.totalFootprint));
  const totalCpu = summarizeSeries(seriesOf(samples, (sample) => sample.devryan.totalCpu));
  const processCount = summarizeSeries(seriesOf(samples, (sample) => sample.devryan.processCount));

  // Per-pid peaks and lifetime across the run.
  const pids = new Map();
  for (const sample of samples) {
    const dt = 1;
    for (const proc of [...(sample.procs || []), ...(sample.orphans || [])]) {
      const entry = pids.get(proc.pid) || {
        pid: proc.pid, role: proc.role, family: proc.family, kind: proc.kind, cmd: proc.cmd,
        firstElapsedS: sample.elapsedS, lastElapsedS: sample.elapsedS, samples: 0, peak: 0, cpuSum: 0, cpuSamples: 0,
        memorySeconds: 0, threadsPeak: 0, swappedPeak: 0,
      };
      entry.lastElapsedS = sample.elapsedS;
      entry.samples += dt;
      entry.peak = Math.max(entry.peak, proc.footprint || 0);
      entry.swappedPeak = Math.max(entry.swappedPeak, proc.swapped || 0);
      entry.threadsPeak = Math.max(entry.threadsPeak, proc.threads || 0);
      if (typeof proc.cpu === 'number') { entry.cpuSum += proc.cpu; entry.cpuSamples += 1; }
      pids.set(proc.pid, entry);
    }
  }
  const intervalS = samples.length > 1 ? (samples[samples.length - 1].elapsedS - samples[0].elapsedS) / (samples.length - 1) : 5;
  for (const entry of pids.values()) {
    entry.avgCpu = entry.cpuSamples > 0 ? entry.cpuSum / entry.cpuSamples : null;
    entry.lifetimeS = Math.max(intervalS, entry.lastElapsedS - entry.firstElapsedS + intervalS);
  }

  // Child process churn by role, from sampled presence plus spawn/exit events.
  const childRoles = {};
  for (const entry of pids.values()) {
    if (CORE_ROLES.includes(entry.role) || entry.role.startsWith('utility:') || entry.role === 'crashpad' || entry.role === 'zygote') continue;
    const bucket = childRoles[entry.role] || (childRoles[entry.role] = { role: entry.role, pids: 0, peak: 0, lifetimeS: 0, memorySeconds: 0, families: {} });
    bucket.pids += 1;
    bucket.peak = Math.max(bucket.peak, entry.peak);
    bucket.lifetimeS += entry.lifetimeS;
    bucket.memorySeconds += entry.peak * entry.lifetimeS;
    bucket.families[entry.family] = (bucket.families[entry.family] || 0) + 1;
  }
  for (const bucket of Object.values(childRoles)) {
    bucket.peakConcurrent = Math.max(0, ...samples.map((sample) => (sample.devryan.byRole[bucket.role]?.count ?? 0)));
  }
  const spawnEvents = events.filter((event) => event.type === 'spawn');
  const shortLived = events.filter((event) => event.type === 'exit' && event.lifetimeS <= Math.ceil(intervalS * 2));

  const system = {
    freePct: summarizeSeries(seriesOf(samples, (sample) => sample.system.freePct)),
    freeBytes: summarizeSeries(seriesOf(samples, (sample) => sample.system.freeBytes)),
    swapUsed: summarizeSeries(seriesOf(samples, (sample) => sample.system.swapUsedBytes)),
    compressor: summarizeSeries(seriesOf(samples, (sample) => sample.system.compressorBytes)),
    load1: summarizeSeries(seriesOf(samples, (sample) => sample.system.load1)),
    swapoutsDelta: (samples[samples.length - 1].system.swapouts ?? 0) - (samples[0].system.swapouts ?? 0),
    swapinsDelta: (samples[samples.length - 1].system.swapins ?? 0) - (samples[0].system.swapins ?? 0),
    pageoutsDelta: (samples[samples.length - 1].system.pageouts ?? 0) - (samples[0].system.pageouts ?? 0),
    compressionsDelta: (samples[samples.length - 1].system.compressions ?? 0) - (samples[0].system.compressions ?? 0),
  };

  const topSystem = new Map();
  for (const sample of samples) {
    for (const row of sample.topSystem || []) {
      const entry = topSystem.get(row.name) || { name: row.name, peak: 0, cpuPeak: 0, seen: 0 };
      entry.peak = Math.max(entry.peak, row.footprint || 0);
      entry.cpuPeak = Math.max(entry.cpuPeak, row.cpu || 0);
      entry.seen += 1;
      topSystem.set(row.name, entry);
    }
  }

  const server = {
    healthMs: summarizeSeries(seriesOf(samples, (sample) => sample.server?.healthMs ?? null)),
    healthFailures: samples.filter((sample) => sample.server && sample.server.healthStatus !== 200).length,
    probeMs: summarizeSeries(seriesOf(samples, (sample) => sample.server?.openCodeProbeMs ?? null)),
    notReady: samples.filter((sample) => sample.server && sample.server.openCodeReady === false).length,
    authenticated: samples.some((sample) => sample.server?.authenticated),
    heapUsed: summarizeSeries(seriesOf(samples, (sample) => sample.server?.debugMemory?.heapUsed ?? null)),
    heapRss: summarizeSeries(seriesOf(samples, (sample) => sample.server?.debugMemory?.rss ?? null)),
    external: summarizeSeries(seriesOf(samples, (sample) => sample.server?.debugMemory?.external ?? null)),
    arrayBuffers: summarizeSeries(seriesOf(samples, (sample) => sample.server?.debugMemory?.arrayBuffers ?? null)),
    busy: summarizeSeries(seriesOf(samples, (sample) => sample.server?.sessions?.busy ?? null)),
    tracked: summarizeSeries(seriesOf(samples, (sample) => sample.server?.sessions?.tracked ?? null)),
    appMetricTypes: {},
  };
  for (const sample of samples) {
    for (const [type, bucket] of Object.entries(sample.server?.appMetrics || {})) {
      const entry = server.appMetricTypes[type] || (server.appMetricTypes[type] = { count: 0, workingSetPeak: 0, cpuPeak: 0 });
      entry.count = Math.max(entry.count, bucket.count);
      entry.workingSetPeak = Math.max(entry.workingSetPeak, bucket.workingSetBytes);
      entry.cpuPeak = Math.max(entry.cpuPeak, bucket.cpu);
    }
  }

  // Busy-session buckets (only when the cookie was provided).
  const busyBuckets = {};
  for (const sample of samples) {
    const busy = sample.server?.sessions?.busy;
    if (typeof busy !== 'number') continue;
    const bucket = busyBuckets[busy] || (busyBuckets[busy] = { busy, samples: 0, total: 0, opencode: 0, main: 0, renderer: 0, cpu: 0, health: [] });
    bucket.samples += 1;
    bucket.total += sample.devryan.totalFootprint;
    bucket.opencode += sample.devryan.byRole['opencode-serve']?.footprint ?? 0;
    bucket.main += sample.devryan.byRole['electron-main+server']?.footprint ?? 0;
    bucket.renderer += sample.devryan.byRole.renderer?.footprint ?? 0;
    bucket.cpu += sample.devryan.totalCpu;
    bucket.health.push(sample.server.healthMs);
  }

  const docker = {};
  for (const sample of samples) {
    for (const container of sample.docker?.devryan || []) {
      const entry = docker[container.name] || (docker[container.name] = { name: container.name, samples: 0, sum: 0, peak: 0, cpuPeak: 0, limit: container.limitBytes });
      entry.samples += 1;
      entry.sum += container.memBytes || 0;
      entry.peak = Math.max(entry.peak, container.memBytes || 0);
      entry.cpuPeak = Math.max(entry.cpuPeak, container.cpuPct || 0);
    }
  }
  const otherContainers = summarizeSeries(seriesOf(samples, (sample) => sample.docker?.otherContainersMemBytes ?? null));

  const fds = {};
  for (const sample of samples) {
    for (const [pid, entry] of Object.entries(sample.fds || {})) {
      const bucket = fds[entry.role] || (fds[entry.role] = { role: entry.role, pid, first: entry.fds, last: entry.fds, max: entry.fds });
      bucket.last = entry.fds;
      bucket.max = Math.max(bucket.max ?? 0, entry.fds ?? 0);
    }
  }

  const logs = {
    opencodeLogDelta: (samples[samples.length - 1].logs?.opencodeLogBytes ?? 0) - (samples[0].logs?.opencodeLogBytes ?? 0),
    mainLogDelta: (samples[samples.length - 1].logs?.mainLogBytes ?? 0) - (samples[0].logs?.mainLogBytes ?? 0),
  };

  const tickMs = summarizeSeries(seriesOf(samples, (sample) => sample.tickMs));
  const durationS = samples[samples.length - 1].elapsedS - samples[0].elapsedS;

  return {
    meta, samples, events, durationS, intervalS, tickMs,
    total, totalCpu, processCount, roles, pids, childRoles, spawnEvents, shortLived,
    system, topSystem, server, busyBuckets, docker, otherContainers, fds, logs,
    marks: events.filter((event) => event.type === 'mark'),
    orphans: [...pids.values()].filter((entry) => entry.kind === 'orphan'),
  };
};

// ---------------------------------------------------------------------------
// Timeline buckets
// ---------------------------------------------------------------------------

export const buildTimeline = (samples, maxRows = 40) => {
  if (samples.length === 0) return [];
  const span = Math.max(1, samples[samples.length - 1].elapsedS - samples[0].elapsedS);
  const bucketS = Math.max(60, Math.ceil(span / maxRows / 60) * 60);
  const buckets = new Map();
  for (const sample of samples) {
    const key = Math.floor(sample.elapsedS / bucketS) * bucketS;
    const bucket = buckets.get(key) || { startS: key, n: 0, total: 0, main: 0, opencode: 0, renderer: 0, children: 0, cpu: 0, freePct: [], swap: 0, busy: [], health: [], marks: [] };
    bucket.n += 1;
    bucket.total += sample.devryan.totalFootprint;
    bucket.main += sample.devryan.byRole['electron-main+server']?.footprint ?? 0;
    bucket.opencode += sample.devryan.byRole['opencode-serve']?.footprint ?? 0;
    bucket.renderer += sample.devryan.byRole.renderer?.footprint ?? 0;
    bucket.children += Object.entries(sample.devryan.byRole)
      .filter(([role]) => !CORE_ROLES.includes(role) && !role.startsWith('utility:'))
      .reduce((sum, [, entry]) => sum + entry.footprint, 0);
    bucket.cpu += sample.devryan.totalCpu;
    if (typeof sample.system.freePct === 'number') bucket.freePct.push(sample.system.freePct);
    bucket.swap += sample.system.swapUsedBytes ?? 0;
    if (typeof sample.server?.sessions?.busy === 'number') bucket.busy.push(sample.server.sessions.busy);
    if (typeof sample.server?.healthMs === 'number') bucket.health.push(sample.server.healthMs);
    bucket.marks.push(...(sample.marks || []));
    buckets.set(key, bucket);
  }
  return [...buckets.values()].map((bucket) => ({
    startS: bucket.startS,
    total: bucket.total / bucket.n,
    main: bucket.main / bucket.n,
    opencode: bucket.opencode / bucket.n,
    renderer: bucket.renderer / bucket.n,
    children: bucket.children / bucket.n,
    cpu: bucket.cpu / bucket.n,
    freePctMin: bucket.freePct.length > 0 ? Math.min(...bucket.freePct) : null,
    swap: bucket.swap / bucket.n,
    busyMax: bucket.busy.length > 0 ? Math.max(...bucket.busy) : null,
    healthP50: percentile(bucket.health, 50),
    marks: bucket.marks,
  }));
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export const renderReport = (analysis, comparison = null) => {
  if (!analysis) return '# Multi-session sampler report\n\nNo samples found.\n';
  const { meta, samples } = analysis;
  const lines = [];
  const first = samples[0];
  const last = samples[samples.length - 1];
  lines.push(`# Multi-session sampler report: ${meta.label ?? path.basename(analysis.dir || '')}`);
  lines.push('');
  lines.push(`- Window: ${first.t} → ${last.t} (${formatElapsed(analysis.durationS)}, ${samples.length} samples every ~${formatNumber(analysis.intervalS, 1)}s, tick cost p95 ${formatMs(analysis.tickMs?.p95)})`);
  lines.push(`- App: DevRyan ${meta.devryanVersion ?? '?'} / opencode ${meta.opencodeVersion ?? '?'} (launched in ${meta.opencodeLaunch?.cwd ?? '?'})`);
  lines.push(`- Machine: ${meta.machine?.cpu ?? '?'}, ${meta.machine?.cpus ?? '?'} cores, ${formatBytes(meta.machine?.memoryBytes)} RAM, macOS ${meta.machine?.macos ?? '?'}; Docker VM ${meta.dockerSettings?.memoryMiB ?? '?'} MiB / ${meta.dockerSettings?.cpus ?? '?'} CPUs`);
  lines.push(`- Server metrics: ${analysis.server.authenticated ? 'authenticated (heap, app metrics, busy sessions captured)' : 'unauthenticated (/api/health only)'}`);
  lines.push('');

  lines.push('## Headline');
  lines.push('');
  const headline = [
    ['DevRyan total footprint', formatBytes(analysis.total.first), formatBytes(analysis.total.max), formatBytes(analysis.total.last), formatDelta(analysis.total.last - analysis.total.first), `${formatDelta(analysis.total.slopePerMin)}/min`],
  ];
  for (const role of CORE_ROLES) {
    const entry = analysis.roles[role]?.footprint;
    if (!entry) continue;
    headline.push([role, formatBytes(entry.first), `${formatBytes(entry.max)} @ ${formatElapsed(elapsedAt(samples, entry.peakAt))}`, formatBytes(entry.last), formatDelta(entry.last - entry.first), `${formatDelta(entry.slopePerMin)}/min`]);
  }
  lines.push(table(['Metric', 'Start', 'Peak', 'End', 'Δ', 'Trend'], headline));
  lines.push('');
  lines.push(table(['System', 'Min', 'Avg', 'Max'], [
    ['Free memory %', formatNumber(analysis.system.freePct?.min), formatNumber(analysis.system.freePct?.avg, 1), formatNumber(analysis.system.freePct?.max)],
    ['Swap used', formatBytes(analysis.system.swapUsed?.min), formatBytes(analysis.system.swapUsed?.avg), formatBytes(analysis.system.swapUsed?.max)],
    ['Compressor occupied', formatBytes(analysis.system.compressor?.min), formatBytes(analysis.system.compressor?.avg), formatBytes(analysis.system.compressor?.max)],
    ['Load (1 min)', formatNumber(analysis.system.load1?.min, 2), formatNumber(analysis.system.load1?.avg, 2), formatNumber(analysis.system.load1?.max, 2)],
    ['DevRyan tree CPU %', formatNumber(analysis.totalCpu?.min), formatNumber(analysis.totalCpu?.avg, 1), formatNumber(analysis.totalCpu?.max)],
    ['DevRyan tree processes', analysis.processCount?.min, formatNumber(analysis.processCount?.avg, 1), analysis.processCount?.max],
  ]));
  lines.push('');
  lines.push(`Paging over the window: swapouts +${analysis.system.swapoutsDelta.toLocaleString()} pages, swapins +${analysis.system.swapinsDelta.toLocaleString()}, pageouts +${analysis.system.pageoutsDelta.toLocaleString()}, compressions +${analysis.system.compressionsDelta.toLocaleString()}. Log growth: opencode.log ${formatDelta(analysis.logs.opencodeLogDelta)}, DevRyan main.log ${formatDelta(analysis.logs.mainLogDelta)}.`);
  lines.push('');

  lines.push('## Per role');
  lines.push('');
  const roleRows = Object.entries(analysis.roles)
    .sort((a, b) => (b[1].footprint?.max ?? 0) - (a[1].footprint?.max ?? 0))
    .map(([role, entry]) => [
      role,
      `${entry.count?.min ?? 0}–${entry.count?.max ?? 0}`,
      formatBytes(entry.footprint?.avg),
      formatBytes(entry.footprint?.max),
      formatDelta((entry.footprint?.last ?? 0) - (entry.footprint?.first ?? 0)),
      formatNumber(entry.cpu?.avg, 1),
      formatNumber(entry.cpu?.max, 1),
      entry.threads?.max ?? 'n/a',
    ]);
  lines.push(table(['Role', 'Procs', 'Avg mem', 'Peak mem', 'Δ mem', 'Avg CPU %', 'Peak CPU %', 'Peak threads'], roleRows));
  lines.push('');

  lines.push('## Top processes by peak footprint');
  lines.push('');
  const topPids = [...analysis.pids.values()].sort((a, b) => b.peak - a.peak).slice(0, 15);
  lines.push(table(['PID', 'Role', 'Peak', 'Swapped peak', 'Avg CPU %', 'Seen', 'Command'],
    topPids.map((entry) => [entry.pid, entry.role + (entry.kind === 'orphan' ? ' (orphan)' : ''), formatBytes(entry.peak), formatBytes(entry.swappedPeak), formatNumber(entry.avgCpu, 1), formatElapsed(entry.lifetimeS), `\`${entry.cmd.slice(0, 80)}\``])));
  lines.push('');

  lines.push('## Child process churn');
  lines.push('');
  const churnRows = Object.values(analysis.childRoles)
    .sort((a, b) => b.memorySeconds - a.memorySeconds)
    .map((bucket) => [
      bucket.role,
      bucket.pids,
      bucket.peakConcurrent,
      formatBytes(bucket.peak),
      formatElapsed(bucket.lifetimeS),
      `${formatBytes(bucket.memorySeconds / 60)}·min`,
      Object.entries(bucket.families).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([family, count]) => `${family} ×${count}`).join(', '),
    ]);
  if (churnRows.length === 0) lines.push('No child processes were observed beyond the Electron helpers.');
  else lines.push(table(['Role', 'Distinct PIDs', 'Peak concurrent', 'Peak mem', 'Σ lifetime', 'Memory-time', 'Commands'], churnRows));
  lines.push('');
  lines.push(`Spawn events: ${analysis.spawnEvents.length}; exits shorter than two ticks (invisible to Activity Monitor but still paying startup cost): ${analysis.shortLived.length}.`);
  if (analysis.orphans.length > 0) {
    lines.push('');
    lines.push(`Orphaned agent processes (parent is launchd, not DevRyan): ${analysis.orphans.map((entry) => `pid ${entry.pid} ${entry.role} peak ${formatBytes(entry.peak)} \`${entry.cmd.slice(0, 60)}\``).join('; ')}.`);
  }
  lines.push('');

  lines.push('## Server responsiveness');
  lines.push('');
  lines.push(table(['Probe', 'p50', 'p95', 'Max', 'Notes'], [
    ['/api/health round trip (Electron main event loop)', formatMs(percentile(samples.map((sample) => sample.server?.healthMs), 50)), formatMs(analysis.server.healthMs?.p95), formatMs(analysis.server.healthMs?.max), `${analysis.server.healthFailures} non-200`],
    ['opencode probe (server → opencode)', formatMs(percentile(samples.map((sample) => sample.server?.openCodeProbeMs), 50)), formatMs(analysis.server.probeMs?.p95), formatMs(analysis.server.probeMs?.max), `${analysis.server.notReady} samples not ready`],
  ]));
  if (analysis.server.authenticated) {
    lines.push('');
    lines.push(table(['Server heap (inside Electron main)', 'Start', 'Peak', 'End'], [
      ['heapUsed', formatBytes(analysis.server.heapUsed?.first), formatBytes(analysis.server.heapUsed?.max), formatBytes(analysis.server.heapUsed?.last)],
      ['rss', formatBytes(analysis.server.heapRss?.first), formatBytes(analysis.server.heapRss?.max), formatBytes(analysis.server.heapRss?.last)],
      ['external', formatBytes(analysis.server.external?.first), formatBytes(analysis.server.external?.max), formatBytes(analysis.server.external?.last)],
      ['arrayBuffers', formatBytes(analysis.server.arrayBuffers?.first), formatBytes(analysis.server.arrayBuffers?.max), formatBytes(analysis.server.arrayBuffers?.last)],
    ]));
    const typeRows = Object.entries(analysis.server.appMetricTypes).map(([type, entry]) => [type, entry.count, formatBytes(entry.workingSetPeak), formatNumber(entry.cpuPeak, 1)]);
    if (typeRows.length > 0) {
      lines.push('');
      lines.push(table(['Electron app metrics type', 'Max procs', 'Peak working set', 'Peak CPU %'], typeRows));
    }
    const busyRows = Object.values(analysis.busyBuckets).sort((a, b) => a.busy - b.busy).map((bucket) => [
      bucket.busy, bucket.samples, formatBytes(bucket.total / bucket.samples), formatBytes(bucket.opencode / bucket.samples), formatBytes(bucket.main / bucket.samples), formatBytes(bucket.renderer / bucket.samples), formatNumber(bucket.cpu / bucket.samples, 1), formatMs(percentile(bucket.health, 50)),
    ]);
    if (busyRows.length > 0) {
      lines.push('');
      lines.push(`Busy sessions peaked at ${analysis.server.busy?.max ?? 'n/a'} of ${analysis.server.tracked?.max ?? 'n/a'} tracked.`);
      lines.push('');
      lines.push(table(['Busy sessions', 'Samples', 'Avg total', 'Avg opencode', 'Avg main', 'Avg renderer', 'Avg CPU %', 'Health p50'], busyRows));
    }
  }
  lines.push('');

  const dockerRows = Object.values(analysis.docker).sort((a, b) => b.peak - a.peak)
    .map((entry) => [entry.name, formatBytes(entry.sum / entry.samples), formatBytes(entry.peak), formatBytes(entry.limit), formatNumber(entry.cpuPeak, 1)]);
  lines.push('## Docker bot containers');
  lines.push('');
  if (dockerRows.length === 0) lines.push('No docker stats captured.');
  else {
    lines.push(table(['Container', 'Avg mem', 'Peak mem', 'Limit', 'Peak CPU %'], dockerRows));
    lines.push('');
    lines.push(`Non-DevRyan containers in the same VM: ${formatBytes(analysis.otherContainers?.avg)} average, ${formatBytes(analysis.otherContainers?.max)} peak.`);
  }
  lines.push('');

  const fdRows = Object.values(analysis.fds).map((entry) => [entry.role, entry.pid, entry.first, entry.last, entry.max]);
  if (fdRows.length > 0) {
    lines.push('## File descriptors');
    lines.push('');
    lines.push(table(['Role', 'PID', 'First', 'Last', 'Max'], fdRows));
    lines.push('');
  }

  lines.push('## System-wide competitors (top consumers seen by top)');
  lines.push('');
  lines.push(table(['Process', 'Peak footprint', 'Peak CPU %', 'Samples present'],
    [...analysis.topSystem.values()].sort((a, b) => b.peak - a.peak).slice(0, 12).map((entry) => [entry.name, formatBytes(entry.peak), formatNumber(entry.cpuPeak, 1), entry.seen])));
  lines.push('');

  lines.push('## Timeline');
  lines.push('');
  const timeline = buildTimeline(samples);
  lines.push(table(['t', 'Total', 'Main', 'opencode', 'Renderer', 'Children', 'CPU %', 'Free % min', 'Swap', 'Busy max', 'Health p50', 'Marks'],
    timeline.map((row) => [formatElapsed(row.startS), formatBytes(row.total), formatBytes(row.main), formatBytes(row.opencode), formatBytes(row.renderer), formatBytes(row.children), formatNumber(row.cpu), row.freePctMin ?? 'n/a', formatBytes(row.swap), row.busyMax ?? '', formatMs(row.healthP50), row.marks.join('; ')])));
  lines.push('');

  if (analysis.marks.length > 0) {
    lines.push('## Marks');
    lines.push('');
    for (const mark of analysis.marks) lines.push(`- ${formatElapsed(mark.elapsedS)} ${mark.text}`);
    lines.push('');
  }

  if (comparison) {
    lines.push(`## Comparison with ${comparison.meta.label ?? comparison.dir}`);
    lines.push('');
    const rows = [['DevRyan total peak', formatBytes(comparison.total.max), formatBytes(analysis.total.max), formatDelta(analysis.total.max - comparison.total.max)]];
    for (const role of CORE_ROLES) {
      const before = comparison.roles[role]?.footprint?.max;
      const after = analysis.roles[role]?.footprint?.max;
      if (typeof before !== 'number' || typeof after !== 'number') continue;
      rows.push([`${role} peak`, formatBytes(before), formatBytes(after), formatDelta(after - before)]);
    }
    rows.push(['Health p95', formatMs(comparison.server.healthMs?.p95), formatMs(analysis.server.healthMs?.p95), formatMs((analysis.server.healthMs?.p95 ?? 0) - (comparison.server.healthMs?.p95 ?? 0))]);
    rows.push(['Free % min', formatNumber(comparison.system.freePct?.min), formatNumber(analysis.system.freePct?.min), '']);
    lines.push(table(['Metric', 'Baseline', 'This run', 'Δ'], rows));
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const main = () => {
  const argv = process.argv.slice(2);
  const runDir = argv.find((arg) => !arg.startsWith('--'));
  if (!runDir) {
    console.error('Usage: node scripts/perf/multi-session-report.mjs <runDir> [--compare <baselineRunDir>] [--no-write]');
    process.exit(1);
  }
  const compareIndex = argv.indexOf('--compare');
  const compareDir = compareIndex !== -1 ? argv[compareIndex + 1] : null;
  const run = loadRun(path.resolve(runDir));
  const analysis = analyzeRun(run);
  if (analysis) analysis.dir = run.dir;
  const comparison = compareDir ? analyzeRun(loadRun(path.resolve(compareDir))) : null;
  if (comparison) comparison.dir = path.resolve(compareDir);
  const markdown = renderReport(analysis, comparison);
  if (!argv.includes('--no-write')) fs.writeFileSync(path.join(run.dir, 'report.md'), markdown);
  process.stdout.write(markdown);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
