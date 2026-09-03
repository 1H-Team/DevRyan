import { execFile as execFileCallback } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import nodeOs from 'node:os';

/**
 * Host memory-pressure sampler. The managed-orchestration launch admission
 * hook reads the latest snapshot to pause new sub-agent launches (running work
 * is never touched) while the machine is swapping or nearly out of memory.
 *
 * Snapshot: `{ state: 'normal' | 'elevated' | 'critical', availableRatio,
 * swapUsedRatio, sampledAt, source }`. An unsupported platform or a failed
 * sample reports `state: 'normal'` with `source: 'unavailable'`; nothing here
 * ever throws.
 */

export const SYSTEM_PRESSURE_CRITICAL_AVAILABLE_RATIO = 0.08;
export const SYSTEM_PRESSURE_ELEVATED_AVAILABLE_RATIO = 0.15;
export const SYSTEM_PRESSURE_CRITICAL_SWAP_USED_RATIO = 0.75;
export const DEFAULT_SYSTEM_PRESSURE_INTERVAL_MS = 15_000;
const COMMAND_TIMEOUT_MS = 3_000;
const BYTE_UNITS = Object.freeze({ '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 });

const UNAVAILABLE_SNAPSHOT = Object.freeze({
  state: 'normal',
  availableRatio: null,
  swapUsedRatio: null,
  sampledAt: null,
  source: 'unavailable',
});

const defaultExecFile = (file, args) => new Promise((resolve, reject) => {
  execFileCallback(file, args, { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout) => {
    if (error) {
      reject(error);
      return;
    }
    resolve(String(stdout));
  });
});

const defaultReadFile = (filePath) => fsPromises.readFile(filePath, 'utf8');

const toRatio = (part, whole) => (
  Number.isFinite(part) && Number.isFinite(whole) && whole > 0
    ? Math.min(1, Math.max(0, part / whole))
    : null
);

const outputText = (value) => (
  typeof value === 'string' ? value : String(value?.stdout ?? '')
);

export const classifySystemPressure = ({ availableRatio, swapUsedRatio, swapTotalBytes = 0 }) => {
  if (!Number.isFinite(availableRatio)) return 'normal';
  if (availableRatio < SYSTEM_PRESSURE_CRITICAL_AVAILABLE_RATIO) return 'critical';
  if (
    swapTotalBytes > 0
    && Number.isFinite(swapUsedRatio)
    && swapUsedRatio > SYSTEM_PRESSURE_CRITICAL_SWAP_USED_RATIO
  ) {
    return 'critical';
  }
  if (availableRatio < SYSTEM_PRESSURE_ELEVATED_AVAILABLE_RATIO) return 'elevated';
  return 'normal';
};

/** `vm_stat`: free + inactive + speculative pages × page size. */
export const parseVmStat = (text) => {
  const pageSizeMatch = /page size of (\d+) bytes/i.exec(text);
  if (!pageSizeMatch) return null;
  const pageSize = Number(pageSizeMatch[1]);
  const pages = (label) => {
    const match = new RegExp(`^Pages ${label}:\\s+(\\d+)\\.?\\s*$`, 'm').exec(text);
    return match ? Number(match[1]) : null;
  };
  const free = pages('free');
  const inactive = pages('inactive');
  if (free === null || inactive === null || !Number.isFinite(pageSize) || pageSize <= 0) return null;
  const speculative = pages('speculative') ?? 0;
  return (free + inactive + speculative) * pageSize;
};

/** `sysctl -n vm.swapusage`: `total = 2048.00M  used = 1536.00M  free = 512.00M`. */
export const parseSwapUsage = (text) => {
  const read = (label) => {
    const match = new RegExp(`${label}\\s*=\\s*([\\d.]+)\\s*([KMGT]?)`, 'i').exec(text);
    if (!match) return null;
    const value = Number(match[1]) * BYTE_UNITS[match[2].toUpperCase()];
    return Number.isFinite(value) ? value : null;
  };
  const total = read('total');
  const used = read('used');
  if (total === null || used === null) return null;
  return { totalBytes: total, usedBytes: used };
};

/** `/proc/meminfo`: MemTotal / MemAvailable / SwapTotal / SwapFree in kB. */
export const parseMemInfo = (text) => {
  const read = (label) => {
    const match = new RegExp(`^${label}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
    return match ? Number(match[1]) * 1024 : null;
  };
  const totalBytes = read('MemTotal');
  const availableBytes = read('MemAvailable');
  if (totalBytes === null || availableBytes === null) return null;
  const swapTotalBytes = read('SwapTotal') ?? 0;
  const swapFreeBytes = read('SwapFree');
  return {
    totalBytes,
    availableBytes,
    swapTotalBytes,
    swapUsedBytes: swapFreeBytes === null ? 0 : Math.max(0, swapTotalBytes - swapFreeBytes),
  };
};

const sampleDarwin = async ({ execFile, os }) => {
  const availableFromVmStat = parseVmStat(outputText(await execFile('vm_stat', [])));
  if (availableFromVmStat === null) return null;
  let swap = null;
  try {
    swap = parseSwapUsage(outputText(await execFile('sysctl', ['-n', 'vm.swapusage'])));
  } catch {
    swap = null;
  }
  return {
    source: 'vm_stat',
    totalBytes: os.totalmem(),
    // Free pages are a floor for availability; vm_stat's inactive/speculative
    // pages are what the kernel would actually hand out next.
    availableBytes: Math.max(availableFromVmStat, os.freemem()),
    swapTotalBytes: swap?.totalBytes ?? 0,
    swapUsedBytes: swap?.usedBytes ?? 0,
  };
};

const sampleLinux = async ({ readFile, os }) => {
  const parsed = parseMemInfo(await readFile('/proc/meminfo'));
  if (!parsed) return null;
  return {
    source: 'meminfo',
    ...parsed,
    availableBytes: Math.max(parsed.availableBytes, os.freemem()),
  };
};

export const createSystemPressureSampler = ({
  platform = process.platform,
  execFile = defaultExecFile,
  readFile = defaultReadFile,
  os = nodeOs,
  now = Date.now,
  intervalMs = DEFAULT_SYSTEM_PRESSURE_INTERVAL_MS,
  logger = console,
} = {}) => {
  let snapshot = { ...UNAVAILABLE_SNAPSHOT };
  let timer = null;
  let inflight = null;

  const sampleOnce = async () => {
    const sampledAt = now();
    try {
      const measured = platform === 'darwin'
        ? await sampleDarwin({ execFile, os })
        : platform === 'linux'
          ? await sampleLinux({ readFile, os })
          : null;
      if (!measured) {
        snapshot = { ...UNAVAILABLE_SNAPSHOT, sampledAt };
        return { ...snapshot };
      }
      const availableRatio = toRatio(measured.availableBytes, measured.totalBytes);
      const swapUsedRatio = measured.swapTotalBytes > 0
        ? toRatio(measured.swapUsedBytes, measured.swapTotalBytes)
        : 0;
      snapshot = {
        state: classifySystemPressure({
          availableRatio,
          swapUsedRatio,
          swapTotalBytes: measured.swapTotalBytes,
        }),
        availableRatio,
        swapUsedRatio,
        sampledAt,
        source: measured.source,
      };
    } catch (error) {
      logger?.warn?.('[SystemPressure] Memory sample failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      snapshot = { ...UNAVAILABLE_SNAPSHOT, sampledAt };
    }
    return { ...snapshot };
  };

  const sample = () => {
    if (!inflight) {
      inflight = sampleOnce().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  };

  return {
    start() {
      if (timer) return;
      void sample();
      timer = setInterval(() => {
        void sample();
      }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    sample,
    getSystemPressure() {
      return { ...snapshot };
    },
  };
};

let sharedSampler = null;

/** Lazy process-wide sampler; started (unref'd) on first use. Never throws. */
export const getSystemPressure = () => {
  try {
    if (!sharedSampler) {
      sharedSampler = createSystemPressureSampler();
      sharedSampler.start();
    }
    return sharedSampler.getSystemPressure();
  } catch {
    return { ...UNAVAILABLE_SNAPSHOT };
  }
};

export const stopSharedSystemPressureSampler = () => {
  sharedSampler?.stop();
  sharedSampler = null;
};
