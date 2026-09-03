import { describe, expect, it, vi } from 'vitest';

import {
  CAPACITY_RETRY_MS,
  SYSTEM_PRESSURE_RETRY_MS,
  createLaunchAdmissionHook,
  resolveEffectiveConcurrencyCap,
  resolveLaunchAdmission,
} from './launch-admission.js';

const limits = (overrides = {}) => ({ maxConcurrentSubagents: 4, pauseUnderMemoryPressure: true, ...overrides });
const pressure = (state) => ({ state, availableRatio: null, swapUsedRatio: null, sampledAt: 1, source: 'unavailable' });

describe('resolveLaunchAdmission', () => {
  it('admits below the cap and holds for capacity at the cap', () => {
    expect(resolveLaunchAdmission({ limits: limits(), pressure: pressure('normal'), activeCount: 3 })).toEqual({ admit: true });
    expect(resolveLaunchAdmission({ limits: limits(), pressure: pressure('normal'), activeCount: 4 }))
      .toEqual({ admit: false, reason: 'capacity', limit: 4, retryInMs: CAPACITY_RETRY_MS });
    expect(resolveLaunchAdmission({ limits: limits(), pressure: pressure('normal'), activeCount: 9 }).admit).toBe(false);
  });

  it('falls back to the default limits and a normal state when inputs are missing', () => {
    expect(resolveLaunchAdmission({ limits: null, pressure: null, activeCount: 3 })).toEqual({ admit: true });
    expect(resolveLaunchAdmission({ limits: undefined, pressure: undefined, activeCount: 4 }))
      .toMatchObject({ admit: false, reason: 'capacity', limit: 4 });
    expect(resolveLaunchAdmission({ limits: limits(), pressure: { state: 'weird' }, activeCount: 'many' }))
      .toEqual({ admit: true });
  });

  it('halves the cap under elevated pressure with a floor of one', () => {
    expect(resolveEffectiveConcurrencyCap({ limits: limits(), pressure: pressure('elevated') })).toBe(2);
    expect(resolveEffectiveConcurrencyCap({ limits: limits({ maxConcurrentSubagents: 1 }), pressure: pressure('elevated') })).toBe(1);
    expect(resolveEffectiveConcurrencyCap({ limits: limits({ maxConcurrentSubagents: 5 }), pressure: pressure('elevated') })).toBe(2);
    expect(resolveEffectiveConcurrencyCap({ limits: limits(), pressure: pressure('normal') })).toBe(4);
    expect(resolveLaunchAdmission({ limits: limits(), pressure: pressure('elevated'), activeCount: 2 }))
      .toEqual({ admit: false, reason: 'capacity', limit: 2, retryInMs: CAPACITY_RETRY_MS });
    expect(resolveLaunchAdmission({ limits: limits(), pressure: pressure('elevated'), activeCount: 1 })).toEqual({ admit: true });
  });

  it('pauses every launch under critical pressure', () => {
    expect(resolveLaunchAdmission({ limits: limits(), pressure: pressure('critical'), activeCount: 0 }))
      .toEqual({ admit: false, reason: 'system_pressure', limit: null, retryInMs: SYSTEM_PRESSURE_RETRY_MS });
  });

  it('ignores pressure entirely when pausing is disabled', () => {
    const relaxed = limits({ pauseUnderMemoryPressure: false });
    expect(resolveLaunchAdmission({ limits: relaxed, pressure: pressure('critical'), activeCount: 3 })).toEqual({ admit: true });
    expect(resolveLaunchAdmission({ limits: relaxed, pressure: pressure('elevated'), activeCount: 3 })).toEqual({ admit: true });
    expect(resolveLaunchAdmission({ limits: relaxed, pressure: pressure('critical'), activeCount: 4 }))
      .toMatchObject({ admit: false, reason: 'capacity', limit: 4 });
  });
});

describe('createLaunchAdmissionHook', () => {
  it('combines cached limits with the latest pressure snapshot', () => {
    const hook = createLaunchAdmissionHook({
      readLimits: () => limits({ maxConcurrentSubagents: 2 }),
      getSystemPressure: () => pressure('normal'),
    });
    expect(hook({ activeCount: 1 })).toEqual({ admit: true });
    expect(hook({ activeCount: 2 })).toMatchObject({ admit: false, reason: 'capacity', limit: 2 });
  });

  it('fails open to the defaults when the limits or pressure readers throw', () => {
    const logger = { warn: vi.fn() };
    const hook = createLaunchAdmissionHook({
      readLimits: () => { throw new Error('sidecar unreadable'); },
      getSystemPressure: () => { throw new Error('sampler broken'); },
      logger,
    });
    expect(hook({ activeCount: 3 })).toEqual({ admit: true });
    expect(hook({ activeCount: 4 })).toMatchObject({ admit: false, reason: 'capacity', limit: 4 });
    expect(logger.warn).toHaveBeenCalled();
  });
});
