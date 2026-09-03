import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_ORCHESTRATION_LIMITS,
  INVALID_ORCHESTRATION_LIMITS_CODE,
  invalidateOrchestrationLimitsCache,
  normalizeOrchestrationLimits,
  readOrchestrationLimits,
  validateOrchestrationLimitsPatch,
  writeOrchestrationLimits,
} from './orchestration-limits.js';

describe('orchestration limits sidecar state', () => {
  let tempRoot;
  let userConfigPath;
  let sidecarPath;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-orchestration-limits-'));
    userConfigPath = path.join(tempRoot, 'opencode-config', 'config.json');
    sidecarPath = path.join(path.dirname(userConfigPath), '.openchamber', 'config.json');
    await fs.mkdir(path.dirname(userConfigPath), { recursive: true });
    invalidateOrchestrationLimitsCache();
  });

  afterEach(async () => {
    invalidateOrchestrationLimitsCache();
    if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  });

  it('normalizes malformed values back to the defaults', () => {
    expect(normalizeOrchestrationLimits(undefined)).toEqual(DEFAULT_ORCHESTRATION_LIMITS);
    expect(normalizeOrchestrationLimits({ maxConcurrentSubagents: 8, pauseUnderMemoryPressure: false }))
      .toEqual({ maxConcurrentSubagents: 8, pauseUnderMemoryPressure: false });
    expect(normalizeOrchestrationLimits({ maxConcurrentSubagents: 0, pauseUnderMemoryPressure: 'no' }))
      .toEqual(DEFAULT_ORCHESTRATION_LIMITS);
    expect(normalizeOrchestrationLimits({ maxConcurrentSubagents: 17 }).maxConcurrentSubagents).toBe(4);
    expect(normalizeOrchestrationLimits({ maxConcurrentSubagents: 2.5 }).maxConcurrentSubagents).toBe(4);
    expect(normalizeOrchestrationLimits([])).toEqual(DEFAULT_ORCHESTRATION_LIMITS);
  });

  it('validates partial updates strictly and ignores unknown keys', () => {
    expect(validateOrchestrationLimitsPatch({ maxConcurrentSubagents: 16 })).toEqual({ maxConcurrentSubagents: 16 });
    expect(validateOrchestrationLimitsPatch({ pauseUnderMemoryPressure: false, pressure: { state: 'normal' } }))
      .toEqual({ pauseUnderMemoryPressure: false });
    for (const invalid of [
      { maxConcurrentSubagents: 0 },
      { maxConcurrentSubagents: 17 },
      { maxConcurrentSubagents: 1.5 },
      { maxConcurrentSubagents: '4' },
      { pauseUnderMemoryPressure: 'yes' },
      null,
      [],
    ]) {
      let caught = null;
      try {
        validateOrchestrationLimitsPatch(invalid);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught.code).toBe(INVALID_ORCHESTRATION_LIMITS_CODE);
    }
  });

  it('reads defaults without a sidecar and writes only the sidecar, preserving sibling keys', async () => {
    expect(readOrchestrationLimits({ userConfigPath })).toEqual(DEFAULT_ORCHESTRATION_LIMITS);

    await fs.mkdir(path.dirname(sidecarPath), { recursive: true });
    await fs.writeFile(sidecarPath, JSON.stringify({ agentBackupModels: { builder: { model: 'openai/gpt-5.5', variant: null } } }));

    expect(writeOrchestrationLimits({ maxConcurrentSubagents: 6 }, { userConfigPath }))
      .toEqual({ maxConcurrentSubagents: 6, pauseUnderMemoryPressure: true });
    expect(writeOrchestrationLimits({ pauseUnderMemoryPressure: false }, { userConfigPath }))
      .toEqual({ maxConcurrentSubagents: 6, pauseUnderMemoryPressure: false });

    const sidecar = JSON.parse(await fs.readFile(sidecarPath, 'utf8'));
    expect(sidecar).toEqual({
      agentBackupModels: { builder: { model: 'openai/gpt-5.5', variant: null } },
      orchestrationLimits: { maxConcurrentSubagents: 6, pauseUnderMemoryPressure: false },
    });
    await expect(fs.stat(userConfigPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(readOrchestrationLimits({ userConfigPath })).toEqual({ maxConcurrentSubagents: 6, pauseUnderMemoryPressure: false });

    expect(() => writeOrchestrationLimits({ maxConcurrentSubagents: 99 }, { userConfigPath }))
      .toThrow(/between 1 and 16/);
  });

  it('caches reads for five seconds and invalidates on write', async () => {
    expect(readOrchestrationLimits({ userConfigPath, now: () => 0 })).toEqual(DEFAULT_ORCHESTRATION_LIMITS);

    await fs.mkdir(path.dirname(sidecarPath), { recursive: true });
    await fs.writeFile(sidecarPath, JSON.stringify({ orchestrationLimits: { maxConcurrentSubagents: 8 } }));

    expect(readOrchestrationLimits({ userConfigPath, now: () => 4_999 }).maxConcurrentSubagents).toBe(4);
    expect(readOrchestrationLimits({ userConfigPath, now: () => 5_000 }).maxConcurrentSubagents).toBe(8);
    expect(readOrchestrationLimits({ userConfigPath, now: () => 6_000 }).maxConcurrentSubagents).toBe(8);

    writeOrchestrationLimits({ pauseUnderMemoryPressure: false }, { userConfigPath });
    expect(readOrchestrationLimits({ userConfigPath, now: () => 6_001 }))
      .toEqual({ maxConcurrentSubagents: 8, pauseUnderMemoryPressure: false });
  });
});
