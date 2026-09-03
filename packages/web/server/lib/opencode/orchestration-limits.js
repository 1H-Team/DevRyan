import { CONFIG_FILE } from './shared.js';
import {
  getOpenchamberSidecarPath,
  readOpenchamberSidecar,
  writeOpenchamberSidecar,
} from './openchamber-sidecar.js';

/**
 * Managed sub-agent launch limits. DevRyan-only sidecar state under
 * `openchamber.orchestrationLimits`; OpenCode never reads it, so writes go to
 * the sidecar alone and nothing needs an apply/restart.
 */
export const ORCHESTRATION_LIMITS_CONFIG_KEY = 'orchestrationLimits';
export const MIN_CONCURRENT_SUBAGENTS = 1;
export const MAX_CONCURRENT_SUBAGENTS = 16;
export const DEFAULT_ORCHESTRATION_LIMITS = Object.freeze({
  maxConcurrentSubagents: 4,
  pauseUnderMemoryPressure: true,
});
const READ_CACHE_TTL_MS = 5_000;

const cache = new Map();

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isValidConcurrency = (value) => (
  Number.isSafeInteger(value)
  && value >= MIN_CONCURRENT_SUBAGENTS
  && value <= MAX_CONCURRENT_SUBAGENTS
);

const resolveUserConfigPath = (options = {}) => options.userConfigPath || CONFIG_FILE;

export const INVALID_ORCHESTRATION_LIMITS_CODE = 'invalid_orchestration_limits';

const invalidLimits = (message) => Object.assign(new Error(message), { code: INVALID_ORCHESTRATION_LIMITS_CODE });

/** Lenient read-side normalization: anything malformed falls back to the default. */
export function normalizeOrchestrationLimits(raw) {
  const source = isPlainObject(raw) ? raw : {};
  return {
    maxConcurrentSubagents: isValidConcurrency(source.maxConcurrentSubagents)
      ? source.maxConcurrentSubagents
      : DEFAULT_ORCHESTRATION_LIMITS.maxConcurrentSubagents,
    pauseUnderMemoryPressure: typeof source.pauseUnderMemoryPressure === 'boolean'
      ? source.pauseUnderMemoryPressure
      : DEFAULT_ORCHESTRATION_LIMITS.pauseUnderMemoryPressure,
  };
}

/** Strict write-side validation of a partial update; unknown keys are ignored. */
export function validateOrchestrationLimitsPatch(partial) {
  if (!isPlainObject(partial)) {
    throw invalidLimits('Orchestration limits must be an object');
  }
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(partial, 'maxConcurrentSubagents')) {
    if (!isValidConcurrency(partial.maxConcurrentSubagents)) {
      throw invalidLimits(
        `maxConcurrentSubagents must be an integer between ${MIN_CONCURRENT_SUBAGENTS} and ${MAX_CONCURRENT_SUBAGENTS}`,
      );
    }
    patch.maxConcurrentSubagents = partial.maxConcurrentSubagents;
  }
  if (Object.prototype.hasOwnProperty.call(partial, 'pauseUnderMemoryPressure')) {
    if (typeof partial.pauseUnderMemoryPressure !== 'boolean') {
      throw invalidLimits('pauseUnderMemoryPressure must be a boolean');
    }
    patch.pauseUnderMemoryPressure = partial.pauseUnderMemoryPressure;
  }
  return patch;
}

export function invalidateOrchestrationLimitsCache() {
  cache.clear();
}

/** Cached for 5 s: the scheduler's admission hook calls this on every pump. */
export function readOrchestrationLimits(options = {}) {
  const userConfigPath = resolveUserConfigPath(options);
  const cacheKey = getOpenchamberSidecarPath(userConfigPath);
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now) return { ...cached.value };
  const sidecar = readOpenchamberSidecar(userConfigPath);
  const value = normalizeOrchestrationLimits(sidecar?.[ORCHESTRATION_LIMITS_CONFIG_KEY]);
  cache.set(cacheKey, { value, expiresAt: now + READ_CACHE_TTL_MS });
  return { ...value };
}

export function writeOrchestrationLimits(partial, options = {}) {
  const patch = validateOrchestrationLimitsPatch(partial);
  const userConfigPath = resolveUserConfigPath(options);
  const sidecar = readOpenchamberSidecar(userConfigPath) || {};
  const next = {
    ...normalizeOrchestrationLimits(sidecar[ORCHESTRATION_LIMITS_CONFIG_KEY]),
    ...patch,
  };
  writeOpenchamberSidecar({ ...sidecar, [ORCHESTRATION_LIMITS_CONFIG_KEY]: next }, userConfigPath);
  cache.delete(getOpenchamberSidecarPath(userConfigPath));
  return { ...next };
}
