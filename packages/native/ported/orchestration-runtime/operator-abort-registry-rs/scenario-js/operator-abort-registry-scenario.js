// Test wrapper, never part of the product: runs a sequence of calls on one registry made by
// `createManagedOperatorAbortRegistry`, with a clock the steps set, and returns every result.
import { createManagedOperatorAbortRegistry } from '../../../../../orchestration-runtime/operator-abort-registry.js';

/**
 * @param {{ maximumSessions?: number }} options
 * @param {{ op: string, at: number, args: unknown[] }[]} steps
 * @returns {unknown[]}
 */
export function runOperatorAbortRegistry(options, steps) {
  let clock = 0;
  const registry = createManagedOperatorAbortRegistry({ ...options, now: () => clock });
  return steps.map((step) => {
    clock = step.at;
    return step.op === 'size' ? registry.size : registry[step.op](...step.args);
  });
}
