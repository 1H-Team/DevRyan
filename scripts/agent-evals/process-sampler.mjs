import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

export const MIB = 1024 * 1024;

export const RETRY_MEMORY_PROFILE = Object.freeze({
  intervalMs: 1_000,
  idleSeconds: 60,
  cycles: 5,
  settlementSeconds: 30,
  runs: 2,
});

export const parsePsOutput = (output) => {
  const rows = [];
  for (const line of String(output).split(/\r?\n/)) {
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/,
    );
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const rssKiB = Number(match[3]);
    if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isSafeInteger(ppid) || ppid < 0) continue;
    if (!Number.isSafeInteger(rssKiB) || rssKiB < 0) continue;
    rows.push({
      pid,
      ppid,
      rssBytes: rssKiB * 1024,
      startIdentity: match[4],
      command: match[5],
    });
  }
  return rows;
};

export const readMacProcessTable = (options = {}) => {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') {
    const error = new Error('Electron process sampling is supported only on macOS');
    error.code = 'process_sampling_unsupported';
    throw error;
  }
  const spawnImpl = options.spawnImpl ?? spawn;
  return new Promise((resolve, reject) => {
    const child = spawnImpl(
      '/bin/ps',
      ['-axo', 'pid=,ppid=,rss=,lstart=,command='],
      { shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const stdout = [];
    let stdoutBytes = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    child.on('error', () => {
      const error = new Error('macOS ps process sampling failed to start');
      error.code = 'process_sampling_spawn_failed';
      finish(error);
    });
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= 16 * 1024 * 1024) stdout.push(chunk);
    });
    // Drain stderr without retaining command lines or other process details.
    child.stderr.on('data', () => {});
    child.on('close', (code, signal) => {
      if (code !== 0 || signal || stdoutBytes > 16 * 1024 * 1024) {
        const error = new Error('macOS ps process sampling failed');
        error.code = 'process_sampling_failed';
        finish(error);
        return;
      }
      finish(null, parsePsOutput(Buffer.concat(stdout).toString('utf8')));
    });
  });
};

export const aggregateProcessTree = (processes, rootPid) => {
  const byPid = new Map();
  const childrenByParent = new Map();
  for (const entry of Array.isArray(processes) ? processes : []) {
    if (!Number.isSafeInteger(entry?.pid) || entry.pid < 1) continue;
    byPid.set(entry.pid, entry);
    const children = childrenByParent.get(entry.ppid) ?? [];
    children.push(entry.pid);
    childrenByParent.set(entry.ppid, children);
  }
  for (const children of childrenByParent.values()) children.sort((left, right) => left - right);
  const root = byPid.get(rootPid);
  if (!root) {
    return {
      rootPid,
      rootPresent: false,
      rootIdentity: null,
      processCount: 0,
      rssBytes: 0,
      pids: [],
    };
  }
  const rootIdentity = typeof root.startIdentity === 'string' && root.startIdentity.trim()
    && typeof root.command === 'string' && root.command.trim()
    ? `root-${createHash('sha256')
      .update(`${rootPid}\0${root.startIdentity}\0${root.command}`)
      .digest('hex')
      .slice(0, 16)}`
    : null;
  const visited = new Set();
  const pids = [];
  const queue = [rootPid];
  let rssBytes = 0;
  while (queue.length > 0) {
    const pid = queue.shift();
    if (visited.has(pid)) continue;
    visited.add(pid);
    const entry = byPid.get(pid);
    if (!entry) continue;
    pids.push(pid);
    if (Number.isFinite(entry.rssBytes) && entry.rssBytes >= 0) rssBytes += entry.rssBytes;
    queue.push(...(childrenByParent.get(pid) ?? []));
  }
  return {
    rootPid,
    rootPresent: true,
    rootIdentity,
    processCount: pids.length,
    rssBytes,
    pids,
  };
};

export const sampleElectronProcessTree = async (options = {}) => {
  const table = await readMacProcessTable(options);
  return {
    at: (options.now ?? Date.now)(),
    ...aggregateProcessTree(table, options.rootPid),
  };
};

const sleep = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs));

export const createProcessSampleCollector = (options = {}) => {
  const sample = options.sample ?? ((input) => sampleElectronProcessTree({
    rootPid: input.rootPid,
    platform: options.platform,
    spawnImpl: options.spawnImpl,
    now: options.now,
  }));
  const sleepImpl = options.sleep ?? sleep;
  const now = options.now ?? Date.now;

  const takeSample = async (input) => ({
    ...(await sample(input)),
    phase: input.phase,
    runIndex: input.runIndex,
    ...(input.cycleIndex === undefined ? {} : { cycleIndex: input.cycleIndex }),
  });

  return {
    async collectFor(input) {
      const samples = [];
      const startedAt = now();
      while (true) {
        samples.push(await takeSample(input));
        const elapsed = now() - startedAt;
        if (elapsed >= input.durationMs) break;
        await sleepImpl(Math.min(input.intervalMs, input.durationMs - elapsed));
      }
      return samples;
    },
    async collectDuring(input) {
      const samples = [await takeSample(input)];
      let settlement = null;
      const actionPromise = Promise.resolve()
        .then(input.action)
        .then(
          (value) => { settlement = { status: 'fulfilled', value }; },
          (reason) => { settlement = { status: 'rejected', reason }; },
        );
      while (!settlement) {
        await Promise.race([actionPromise, sleepImpl(input.intervalMs)]);
        if (!settlement) samples.push(await takeSample(input));
      }
      samples.push(await takeSample(input));
      if (settlement.status === 'rejected') throw settlement.reason;
      return samples;
    },
  };
};

const monotonicSuffixLength = (values) => {
  if (values.length === 0) return 0;
  let length = 1;
  for (let index = values.length - 2; index >= 0; index -= 1) {
    if (values[index] > values[index + 1]) break;
    length += 1;
  }
  return length;
};

const classifyRun = (run) => {
  const samples = Array.isArray(run?.samples) ? run.samples : [];
  const idle = samples.filter((sample) => sample?.phase === 'idle' && Number.isFinite(sample.rssBytes));
  const settled = samples.filter((sample) => sample?.phase === 'settlement' && Number.isFinite(sample.rssBytes));
  const baselineBytes = idle.at(-1)?.rssBytes ?? null;
  const finalBytes = settled.at(-1)?.rssBytes ?? null;
  const monotonicSettledSamples = monotonicSuffixLength(settled.map((sample) => sample.rssBytes));
  const growthBytes = baselineBytes === null || finalBytes === null ? null : finalBytes - baselineBytes;
  const growthPercent = growthBytes === null || !Number.isFinite(baselineBytes) || baselineBytes <= 0
    ? null
    : (growthBytes / baselineBytes) * 100;
  const rootIdentities = new Set(samples.map((sample) => sample?.rootIdentity));
  const rootIdentityComplete = samples.length > 0
    && samples.every((sample) => sample?.rootPresent === true
      && typeof sample.rootIdentity === 'string'
      && sample.rootIdentity.length > 0)
    && rootIdentities.size === 1;
  const rootIdentity = rootIdentityComplete ? samples[0].rootIdentity : null;
  const sufficient = baselineBytes !== null
    && finalBytes !== null
    && monotonicSettledSamples >= 4
    && rootIdentityComplete;
  const qualifies = sufficient
    && growthBytes > 100 * MIB
    && growthPercent > 10;
  return {
    baselineBytes,
    finalBytes,
    growthBytes,
    growthPercent,
    monotonicSettledSamples,
    rootIdentity,
    rootIdentityComplete,
    sufficient,
    qualifies,
  };
};

export const classifyMemoryRuns = (runs) => {
  const analyses = (Array.isArray(runs) ? runs : []).map(classifyRun);
  const runIdentities = new Set(analyses.map((run) => run.rootIdentity).filter(Boolean));
  const stableRootAcrossRuns = analyses.length > 0
    && analyses.every((run) => run.rootIdentityComplete)
    && runIdentities.size === 1;
  const reproducedRuns = stableRootAcrossRuns
    ? analyses.filter((run) => run.qualifies).length
    : 0;
  let classification = 'not-reproduced';
  if (analyses.length < 2 || analyses.some((run) => !run.sufficient) || !stableRootAcrossRuns) {
    classification = 'insufficient-data';
  } else if (reproducedRuns >= 2) {
    classification = 'retained-growth-reproduced';
  }
  return { classification, reproducedRuns, runs: analyses };
};

export const runRetryMemoryProfile = async (options = {}) => {
  if (!Number.isSafeInteger(options.rootPid) || options.rootPid < 1) {
    throw new RangeError('rootPid must be a positive safe integer');
  }
  if (typeof options.executeFailureCycle !== 'function') {
    throw new TypeError('executeFailureCycle is required');
  }
  const profile = { ...RETRY_MEMORY_PROFILE };
  const collector = options.collector ?? createProcessSampleCollector(options);
  const runs = [];
  for (let runIndex = 1; runIndex <= profile.runs; runIndex += 1) {
    const samples = await collector.collectFor({
      rootPid: options.rootPid,
      phase: 'idle',
      runIndex,
      durationMs: profile.idleSeconds * 1_000,
      intervalMs: profile.intervalMs,
    });
    for (let cycleIndex = 1; cycleIndex <= profile.cycles; cycleIndex += 1) {
      samples.push(...await collector.collectDuring({
        rootPid: options.rootPid,
        phase: 'failure-cycle',
        runIndex,
        cycleIndex,
        intervalMs: profile.intervalMs,
        action: async () => await options.executeFailureCycle({ runIndex, cycleIndex }),
      }));
    }
    samples.push(...await collector.collectFor({
      rootPid: options.rootPid,
      phase: 'settlement',
      runIndex,
      durationMs: profile.settlementSeconds * 1_000,
      intervalMs: profile.intervalMs,
    }));
    runs.push({ samples });
  }
  return { profile, ...classifyMemoryRuns(runs) };
};
