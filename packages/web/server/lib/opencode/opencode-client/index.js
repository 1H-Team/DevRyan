// ---------------------------------------------------------------------------
// openCodeClient: the one way DevRyan server modules talk to OpenCode
// (DESIGN.md C.1).
//
//   createOpenCodeClient({ getRuntime, getAuthHeaders, fetchImpl, policy,
//     projector, recordDiagnostic, getAdmission }) -> {
//     generation(),
//     sessions:    list, get, create, update, archive, remove, children, fork,
//                  status, abort, messages, message, diff, todo
//     prompts:     prompt, command, compact          (gen 2 -> admission)
//     interaction: permissions {list, reply}, questions {list, reply, reject}
//     catalog:     agents, providers, providerList, commands, skills, mcp,
//                  config, project, path, vcs, tools
//     health:      probe, runtimeInfo (native version only; no readiness claim)
//     events:      url, parseBlock, createProjector }
//
// `getRuntime()` returns `{generation: 2, baseUrl, version?, epoch?, paths?}`.
// Each operation captures one identity and refuses to cross a runtime change;
// epoch advances on replacement even when its URL and version are unchanged.
// The v2 backend maps paths and locations, applies the route policy,
// unwraps envelopes, fills pages and projects into the same v1 domain.
// Every operation takes a trailing `options` `{directory?, signal?,
// timeoutMs?, allowNotFound?}`; failures are `OpenCodeClientError`s (errors.js).
//
// The privileged factory lives in `privileged.js` and is deliberately not
// re-exported here (privilege boundary, C.1).
// ---------------------------------------------------------------------------

import { createOpenCodeClientError, OPENCODE_CLIENT_ERROR_CODES } from './errors.js';
import { createV2Backend } from './v2.js';
import { readOpenCodeRuntime, withOpenCodeRuntime } from './runtime.js';

export { OpenCodeClientError, OPENCODE_CLIENT_ERROR_CODES, isOpenCodeNotFoundError } from './errors.js';

/** The operation names of the public client, per group (C.1). */
export const OPENCODE_CLIENT_SHAPE = Object.freeze({
  sessions: Object.freeze(['list', 'get', 'create', 'update', 'archive', 'remove', 'children', 'fork', 'status', 'abort',
    'messages', 'message', 'diff', 'todo']),
  prompts: Object.freeze(['prompt', 'command', 'compact']),
  interaction: Object.freeze({
    permissions: Object.freeze(['list', 'reply']),
    questions: Object.freeze(['list', 'reply', 'reject']),
  }),
  catalog: Object.freeze(['agents', 'providers', 'providerList', 'commands', 'skills', 'mcp', 'config', 'project', 'path', 'vcs',
    'tools']),
  health: Object.freeze(['probe', 'runtimeInfo']),
  events: Object.freeze(['url', 'parseBlock', 'createProjector']),
});

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Groups whose operations are synchronous; every other operation returns a promise. */
const SYNC_GROUPS = new Set(['events']);

/**
 * Builds a group whose functions resolve the backend on every call. In async
 * groups a failure to resolve the backend is a rejected promise, never a throw.
 * @param {unknown} shape
 * @param {(backend: object) => unknown} select picks the matching group of a backend
 * @param {() => object} backendFor
 * @param {boolean} sync
 * @param {Function} getRuntime shared source used by all nested requesters
 * @param {string} group operation group, for runtime-change errors
 */
const delegateGroup = (shape, select, backendFor, sync, getRuntime, group) => {
  if (Array.isArray(shape)) {
    return Object.freeze(Object.fromEntries(shape.map((name) => [
      name,
      (...args) => {
        const invoke = () => withOpenCodeRuntime(getRuntime, `${group}.${name}`, () => select(backendFor())[name](...args));
        if (sync) return invoke();
        try {
          return Promise.resolve(invoke());
        } catch (error) {
          return Promise.reject(error);
        }
      },
    ])));
  }
  return Object.freeze(Object.fromEntries(Object.entries(shape).map(([key, child]) => [
    key,
    delegateGroup(child, (backend) => select(backend)[key], backendFor, sync, getRuntime, `${group}.${key}`),
  ])));
};

/**
 * Creates the OpenCode client.
 * @param {import('./v2.js').V2BackendDeps} deps
 */
export const createOpenCodeClient = (deps) => {
  if (!isRecord(deps) || typeof deps.getRuntime !== 'function') throw new TypeError('getRuntime is required');
  const v2 = createV2Backend(deps);

  const generation = () => {
    const runtime = readOpenCodeRuntime(deps.getRuntime);
    const value = isRecord(runtime) ? runtime.generation : undefined;
    if (value === 2) return value;
    // A missing or unsupported identity cannot authorize any request.
    throw createOpenCodeClientError(OPENCODE_CLIENT_ERROR_CODES.generationInvalid, 503,
      'The OpenCode runtime generation is unknown', { operation: 'generation' });
  };
  const backendFor = () => { generation(); return v2; };

  return Object.freeze({
    generation,
    ...Object.fromEntries(Object.entries(OPENCODE_CLIENT_SHAPE).map(([group, shape]) => [
      group,
      delegateGroup(shape, (backend) => backend[group], backendFor, SYNC_GROUPS.has(group), deps.getRuntime, group),
    ])),
  });
};
