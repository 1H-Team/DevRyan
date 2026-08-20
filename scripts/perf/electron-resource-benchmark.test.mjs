import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  compareBenchmarkSummaries,
  median,
  parseBenchmarkArguments,
  summarizeMemorySamples,
} from './electron-resource-benchmark.mjs';

const sample = (tabCpu, gpuCpu, tabMemory, browserMemory = 200) => ({
  process: { rss: browserMemory },
  appMetrics: [
    { type: 'Browser', cpu: { percentCPUUsage: 1 }, memory: { workingSetSize: browserMemory } },
    { type: 'Tab', cpu: { percentCPUUsage: tabCpu }, memory: { workingSetSize: tabMemory } },
    { type: 'GPU', cpu: { percentCPUUsage: gpuCpu }, memory: { workingSetSize: 50 } },
  ],
});

describe('Electron resource benchmark metrics', () => {
  it('parses bounded smoke overrides while retaining production defaults', () => {
    const defaults = parseBenchmarkArguments([]);
    assert.equal(defaults.runs, 3);
    assert.equal(defaults.warmupMs, 5_000);
    assert.equal(defaults.measureMs, 30_000);

    const smoke = parseBenchmarkArguments([
      '--label', 'smoke',
      '--scenarios', 'idle,four-stream',
      '--runs', '1',
      '--warmup-ms', '10',
      '--measure-ms', '20',
    ]);
    assert.deepEqual(smoke.scenarios, ['idle', 'four-stream']);
    assert.equal(smoke.runs, 1);
    assert.equal(smoke.warmupMs, 10);
    assert.equal(smoke.measureMs, 20);
  });

  it('discards the first CPU sample and reports medians by Electron process type', () => {
    const summary = summarizeMemorySamples([
      sample(0, 0, 0),
      sample(40, 10, 100),
      sample(20, 6, 80),
      sample(30, 8, 90),
    ]);
    assert.equal(summary.sampleCount, 3);
    assert.equal(summary.medianTabCpu, 30);
    assert.equal(summary.medianGpuCpu, 8);
    assert.equal(summary.medianTabWorkingSet, 90);
    assert.equal(summary.medianTotalAppWorkingSet, 340);
    assert.equal(median([4, 1, 3, 2]), 2.5);
  });

  it('applies renderer, GPU, idle, and memory acceptance gates', () => {
    const scenario = (tabCpu, gpuCpu, tabMemory, totalMemory) => ({
      aggregate: {
        medianTabCpu: tabCpu,
        medianGpuCpu: gpuCpu,
        medianTabWorkingSet: tabMemory,
        medianTotalAppWorkingSet: totalMemory,
      },
    });
    const baseline = {
      scenarios: {
        idle: scenario(10, 1, 100, 200),
        'one-stream': scenario(20, 2, 100, 200),
        'four-stream': scenario(100, 10, 100, 200),
        'plan-skeleton': scenario(20, 20, 100, 200),
      },
    };
    const current = {
      scenarios: {
        idle: scenario(10.5, 1, 100, 200),
        'one-stream': scenario(21, 2, 100, 200),
        'four-stream': scenario(75, 10, 105, 210),
        'plan-skeleton': scenario(20, 10, 100, 200),
      },
    };

    const comparison = compareBenchmarkSummaries(baseline, current);
    assert.equal(comparison.passed, true);
    assert.equal(comparison.checks.length, 6);
  });
});
