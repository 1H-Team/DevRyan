import { AsyncLocalStorage } from 'node:async_hooks';

import { createOpenCodeClientError, OPENCODE_CLIENT_ERROR_CODES } from './errors.js';

/**
 * One operation may use the public client, admission and privileged requesters.
 * Their shared getRuntime function identifies the same runtime source; nested
 * calls inherit its snapshot instead of silently switching stores mid-operation.
 * `epoch` changes on process/data replacement, including a same-URL restart.
 */
const operations = new AsyncLocalStorage();
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** @typedef {{ generation?: 1 | 2, baseUrl: string, version?: string | null,
 *   epoch?: number | string, paths?: Record<string, string> }} OpenCodeRuntime */

/** Runtime identity excludes paths: the lifecycle increments epoch when their owner changes. */
export const isSameOpenCodeRuntime = (left, right) => (
  isRecord(left) && isRecord(right)
  && left.generation === right.generation
  && left.baseUrl === right.baseUrl
  && left.version === right.version
  && left.epoch === right.epoch
);

const scopeFor = (getRuntime) => {
  for (let scope = operations.getStore(); scope; scope = scope.parent) {
    if (scope.getRuntime === getRuntime) return scope;
  }
  return undefined;
};

const assertCurrent = (scope) => {
  if (isSameOpenCodeRuntime(scope.runtime, scope.getRuntime())) return;
  throw createOpenCodeClientError(OPENCODE_CLIENT_ERROR_CODES.runtimeChanged, 503,
    `${scope.operation} stopped because the OpenCode runtime changed; earlier requests may have been accepted by the previous runtime`,
    {
      operation: scope.operation,
      generation: scope.runtime.generation ?? null,
      // Replaying a mutation against the replacement store is a new action.
      retryable: false,
    });
};

/** The operation's unchanged runtime, or the current runtime outside an operation. */
export const readOpenCodeRuntime = (getRuntime) => {
  const scope = scopeFor(getRuntime);
  if (!scope) return getRuntime();
  assertCurrent(scope);
  return scope.runtime;
};

/**
 * Run a synchronous or asynchronous operation against one runtime identity.
 * Snapshots live only as long as their operation; concurrent calls stay isolated.
 */
export const withOpenCodeRuntime = (getRuntime, operation, run) => {
  const inherited = scopeFor(getRuntime);
  const invoke = (scope) => {
    assertCurrent(scope);
    const result = run();
    if (result instanceof Promise) {
      return result.then((value) => {
        assertCurrent(scope);
        return value;
      });
    }
    assertCurrent(scope);
    return result;
  };
  if (inherited) return invoke(inherited);
  const current = getRuntime();
  if (!isRecord(current)) {
    throw createOpenCodeClientError(OPENCODE_CLIENT_ERROR_CODES.generationInvalid, 503,
      'The OpenCode runtime is unavailable', { operation });
  }
  const runtime = { ...current, ...(isRecord(current.paths) ? { paths: { ...current.paths } } : {}) };
  const scope = { getRuntime, operation, runtime, parent: operations.getStore() };
  return operations.run(scope, () => invoke(scope));
};
