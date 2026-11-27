// Test wrapper, never part of the product: runs a sequence of calls on one registry made by
// `createAbortSourceRegistry`, with a clock the steps set, and returns every call's result.
import { createAbortSourceRegistry, normalizeAbortSource } from '../../../../../orchestration-runtime/abort-sources.js';

export function normalizeAbortSourceOf(value) {
  return normalizeAbortSource(value);
}

/**
 * @param {{ ttlMs?: number, maximumSessions?: number }} options
 * @param {{ op: string, at: number, arg?: unknown }[]} steps
 * @returns {unknown[]}
 */
export function runAbortSourceRegistry(options, steps) {
  let clock = 0;
  const registry = createAbortSourceRegistry({ ...options, now: () => clock });
  return steps.map((step) => {
    clock = step.at;
    if (step.op === 'record') return registry.record(step.arg);
    if (step.op === 'withdraw') return registry.withdraw(step.arg);
    if (step.op === 'read') return registry.read(step.arg);
    if (step.op === 'clear') return registry.clear(step.arg);
    return registry.size;
  });
}
