import { normalizeOrchestrationLimits } from '../opencode/orchestration-limits.js';

/**
 * Pure launch-admission policy for managed sub-agents. The scheduler asks
 * before every queued→starting transition; a hold never touches running work,
 * it only defers the next launch.
 *
 * - `pauseUnderMemoryPressure` and `critical` pressure → hold as `system_pressure`.
 * - `elevated` pressure halves the cap (minimum 1) while pausing is enabled.
 * - `activeCount >= effective cap` → hold as `capacity` with that cap.
 */
export const CAPACITY_RETRY_MS = 5_000;
export const SYSTEM_PRESSURE_RETRY_MS = 15_000;

export const resolveEffectiveConcurrencyCap = ({ limits, pressure }) => {
  const normalized = normalizeOrchestrationLimits(limits);
  const cap = normalized.maxConcurrentSubagents;
  if (normalized.pauseUnderMemoryPressure && pressure?.state === 'elevated') {
    return Math.max(1, Math.floor(cap / 2));
  }
  return cap;
};

export const resolveLaunchAdmission = ({ limits, pressure, activeCount }) => {
  const normalized = normalizeOrchestrationLimits(limits);
  const state = pressure?.state === 'critical' || pressure?.state === 'elevated'
    ? pressure.state
    : 'normal';
  if (normalized.pauseUnderMemoryPressure && state === 'critical') {
    return { admit: false, reason: 'system_pressure', limit: null, retryInMs: SYSTEM_PRESSURE_RETRY_MS };
  }
  const effectiveCap = resolveEffectiveConcurrencyCap({ limits: normalized, pressure: { state } });
  const active = Number.isSafeInteger(activeCount) && activeCount > 0 ? activeCount : 0;
  if (active >= effectiveCap) {
    return { admit: false, reason: 'capacity', limit: effectiveCap, retryInMs: CAPACITY_RETRY_MS };
  }
  return { admit: true };
};

/** Scheduler `admitLaunch` hook: cached limits + latest pressure snapshot, never throws. */
export const createLaunchAdmissionHook = ({ readLimits, getSystemPressure, logger = console }) => (
  ({ activeCount }) => {
    let limits = null;
    let pressure = null;
    try {
      limits = typeof readLimits === 'function' ? readLimits() : null;
    } catch (error) {
      logger?.warn?.('[ManagedOrchestration] Failed to read orchestration limits; using defaults', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      pressure = typeof getSystemPressure === 'function' ? getSystemPressure() : null;
    } catch {
      pressure = null;
    }
    return resolveLaunchAdmission({ limits, pressure, activeCount });
  }
);
