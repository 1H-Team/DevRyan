import { describe, expect, it, vi } from 'vitest';

import {
  classifySystemPressure,
  createSystemPressureSampler,
  parseMemInfo,
  parseSwapUsage,
  parseVmStat,
} from './pressure.js';

const GIB = 1024 ** 3;

const darwinVmStat = [
  'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
  'Pages free:                               50000.',
  'Pages active:                            400000.',
  'Pages inactive:                          100000.',
  'Pages speculative:                        20000.',
  'Pages throttled:                              0.',
  'Pages wired down:                        200000.',
  '',
].join('\n');

const linuxMemInfo = (available, swapFree = 3_000_000) => [
  'MemTotal:       16384000 kB',
  'MemFree:         1000000 kB',
  `MemAvailable:    ${available} kB`,
  'SwapTotal:       4000000 kB',
  `SwapFree:        ${swapFree} kB`,
  '',
].join('\n');

const darwinOs = { totalmem: () => 32 * GIB, freemem: () => 1 * GIB };
const linuxOs = { totalmem: () => 16_384_000 * 1024, freemem: () => 1_000_000 * 1024 };

const createDarwinExecFile = (swapusage) => vi.fn(async (file) => {
  if (file === 'vm_stat') return darwinVmStat;
  if (file === 'sysctl') return swapusage;
  throw new Error(`unexpected command ${file}`);
});

describe('system pressure parsers', () => {
  it('reads vm_stat available pages, swapusage sizes, and /proc/meminfo', () => {
    expect(parseVmStat(darwinVmStat)).toBe((50_000 + 100_000 + 20_000) * 16_384);
    expect(parseVmStat('no page size here')).toBeNull();
    expect(parseSwapUsage('total = 8192.00M  used = 7000.00M  free = 1192.00M  (encrypted)'))
      .toEqual({ totalBytes: 8192 * 1024 ** 2, usedBytes: 7000 * 1024 ** 2 });
    expect(parseSwapUsage('total = 2.00G  used = 512.00K  free = 0.00M'))
      .toEqual({ totalBytes: 2 * GIB, usedBytes: 512 * 1024 });
    expect(parseSwapUsage('garbage')).toBeNull();
    expect(parseMemInfo(linuxMemInfo(8_000_000))).toEqual({
      totalBytes: 16_384_000 * 1024,
      availableBytes: 8_000_000 * 1024,
      swapTotalBytes: 4_000_000 * 1024,
      swapUsedBytes: 1_000_000 * 1024,
    });
    expect(parseMemInfo('MemFree: 1 kB')).toBeNull();
  });

  it('classifies critical below 8% available or above 75% swap, elevated below 15%', () => {
    expect(classifySystemPressure({ availableRatio: 0.5, swapUsedRatio: 0.1, swapTotalBytes: 1 })).toBe('normal');
    expect(classifySystemPressure({ availableRatio: 0.149, swapUsedRatio: 0, swapTotalBytes: 0 })).toBe('elevated');
    expect(classifySystemPressure({ availableRatio: 0.079, swapUsedRatio: 0, swapTotalBytes: 0 })).toBe('critical');
    expect(classifySystemPressure({ availableRatio: 0.5, swapUsedRatio: 0.76, swapTotalBytes: 1 })).toBe('critical');
    expect(classifySystemPressure({ availableRatio: 0.5, swapUsedRatio: 0.99, swapTotalBytes: 0 })).toBe('normal');
    expect(classifySystemPressure({ availableRatio: null, swapUsedRatio: 0.99, swapTotalBytes: 1 })).toBe('normal');
  });
});

describe('createSystemPressureSampler', () => {
  it('samples darwin through vm_stat and swapusage', async () => {
    const execFile = createDarwinExecFile('total = 8192.00M  used = 1000.00M  free = 7192.00M  (encrypted)');
    const sampler = createSystemPressureSampler({
      platform: 'darwin',
      execFile,
      os: darwinOs,
      now: () => 42,
    });

    expect(sampler.getSystemPressure()).toEqual({
      state: 'normal',
      availableRatio: null,
      swapUsedRatio: null,
      sampledAt: null,
      source: 'unavailable',
    });

    const snapshot = await sampler.sample();
    expect(snapshot).toMatchObject({ state: 'elevated', sampledAt: 42, source: 'vm_stat' });
    expect(snapshot.availableRatio).toBeCloseTo((170_000 * 16_384) / (32 * GIB), 5);
    expect(snapshot.swapUsedRatio).toBeCloseTo(1000 / 8192, 5);
    expect(sampler.getSystemPressure()).toEqual(snapshot);
    expect(execFile).toHaveBeenCalledWith('vm_stat', []);
    expect(execFile).toHaveBeenCalledWith('sysctl', ['-n', 'vm.swapusage']);
  });

  it('reports critical darwin pressure from heavy swap use and tolerates a failing swap probe', async () => {
    const swapping = createSystemPressureSampler({
      platform: 'darwin',
      execFile: createDarwinExecFile('total = 8192.00M  used = 7000.00M  free = 1192.00M  (encrypted)'),
      os: darwinOs,
    });
    expect((await swapping.sample()).state).toBe('critical');

    const noSwapProbe = createSystemPressureSampler({
      platform: 'darwin',
      execFile: vi.fn(async (file) => {
        if (file === 'vm_stat') return darwinVmStat;
        throw new Error('sysctl unavailable');
      }),
      os: darwinOs,
    });
    expect(await noSwapProbe.sample()).toMatchObject({ state: 'elevated', swapUsedRatio: 0, source: 'vm_stat' });
  });

  it('samples linux through /proc/meminfo', async () => {
    const readFile = vi.fn(async () => linuxMemInfo(8_000_000));
    const sampler = createSystemPressureSampler({ platform: 'linux', readFile, os: linuxOs, now: () => 7 });

    const snapshot = await sampler.sample();
    expect(snapshot).toMatchObject({ state: 'normal', sampledAt: 7, source: 'meminfo' });
    expect(snapshot.availableRatio).toBeCloseTo(8_000_000 / 16_384_000, 5);
    expect(snapshot.swapUsedRatio).toBeCloseTo(0.25, 5);
    expect(readFile).toHaveBeenCalledWith('/proc/meminfo');

    const starved = createSystemPressureSampler({
      platform: 'linux',
      readFile: async () => linuxMemInfo(500_000),
      os: linuxOs,
    });
    expect((await starved.sample()).state).toBe('critical');
  });

  it('never throws: unsupported platforms and failed samples report normal and unavailable', async () => {
    const unsupported = createSystemPressureSampler({ platform: 'win32', now: () => 3 });
    expect(await unsupported.sample()).toEqual({
      state: 'normal',
      availableRatio: null,
      swapUsedRatio: null,
      sampledAt: 3,
      source: 'unavailable',
    });

    const logger = { warn: vi.fn() };
    const failing = createSystemPressureSampler({
      platform: 'darwin',
      execFile: async () => { throw new Error('vm_stat missing'); },
      os: darwinOs,
      now: () => 4,
      logger,
    });
    expect(await failing.sample()).toMatchObject({ state: 'normal', sampledAt: 4, source: 'unavailable' });
    expect(logger.warn).toHaveBeenCalledTimes(1);

    const unparseable = createSystemPressureSampler({
      platform: 'linux',
      readFile: async () => 'nothing useful',
      os: linuxOs,
    });
    expect(await unparseable.sample()).toMatchObject({ state: 'normal', source: 'unavailable' });
  });

  it('starts one unref-able interval, samples immediately, and stops cleanly', async () => {
    const execFile = createDarwinExecFile('total = 1.00M  used = 0.00M  free = 1.00M');
    const sampler = createSystemPressureSampler({
      platform: 'darwin',
      execFile,
      os: darwinOs,
      intervalMs: 60_000,
    });

    sampler.start();
    sampler.start();
    await sampler.sample();
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(sampler.getSystemPressure().source).toBe('vm_stat');
    sampler.stop();
    sampler.stop();
  });
});
