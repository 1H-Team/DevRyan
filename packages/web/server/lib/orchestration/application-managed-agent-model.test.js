import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { resolveManagedAgentExecution } from '../multi-user/managed-agent-defaults.js';
import { createWebManagedOrchestrationRuntime } from './runtime.js';

// Execute only the actual application composition closures. No application
// initialization, process, provider or installed-data access runs here.
const source = readFileSync(new URL('../../application.js', import.meta.url), 'utf8');
function composition(source, { multiUserRuntime = {}, listConfigAgents = vi.fn() } = {}) {
  const marker = '  const resolveManagedAgentExecutionForOwner =';
  const start = source.indexOf(marker);
  const prefix = start < 0 ? '' : source.slice(start, source.indexOf('  managedOrchestrationRuntime =', start));
  const directStart = source.indexOf('    resolveAgentExecution:');
  const direct = source.slice(directStart, source.indexOf('    // Auto-resume hooks:', directStart));
  const rpcStart = source.indexOf('      resolve_agent_execution:');
  const rpc = source.slice(rpcStart, source.indexOf('    },\n    authorizePrivateRpc:', rpcStart));
  expect(directStart).toBeGreaterThan(0);
  expect(rpcStart).toBeGreaterThan(0);
  return runInNewContext(`${prefix}\nconst direct = {${direct}}; const rpc = {${rpc}};\n({ direct: direct.resolveAgentExecution, rpc: rpc.resolve_agent_execution })`, {
    multiUserRuntime, listConfigAgents, resolveManagedAgentExecution,
  });
}
const input = {
  rootSessionId: 'ses_root', directory: '/fixture/project-b', agent: 'fixer',
  fallbackExecution: { providerId: '', modelId: '', variant: null },
};
const agents = [{ name: 'fixer', mode: 'subagent', model: { providerID: 'fixture-provider', modelID: 'project-fixer' }, variant: 'high' }];
const saved = { providerId: 'fixture-provider', modelId: 'project-fixer', variant: 'high', agentName: 'fixer', source: 'inherited' };

it('resolves both actual application callers to the saved project role and variant', async () => {
  const read = vi.fn(directory => directory === input.directory ? agents : []);
  const candidate = composition(source, { listConfigAgents: read });
  for (const resolve of [candidate.direct, candidate.rpc]) {
    expect(await resolve(input)).toEqual(saved);
    expect(read).toHaveBeenLastCalledWith('/fixture/project-b');
    expect(await resolve({ ...input, fallbackExecution: { providerId: 'parent', modelId: 'unrelated', variant: 'low' } })).toEqual(saved);
  }
});

it('keeps cloud owner delegation and rejection intact without local reads', async () => {
  const failure = Object.assign(new Error('owner refused'), { code: 'managed_orchestration_owner_mismatch', statusCode: 403 });
  const cloud = vi.fn(async params => params.rootSessionId === 'ses_denied' ? Promise.reject(failure) : saved);
  const read = vi.fn(() => { throw new Error('cloud must not read local agents'); });
  const candidate = composition(source, { multiUserRuntime: { resolveSessionAgentExecution: cloud }, listConfigAgents: read });
  for (const resolve of [candidate.direct, candidate.rpc]) {
    expect(await resolve(input)).toBe(saved);
    expect(cloud).toHaveBeenLastCalledWith(input);
    await expect(resolve({ ...input, rootSessionId: 'ses_denied' })).rejects.toBe(failure);
  }
  expect(read).not.toHaveBeenCalled();
});

it('refuses unknown and model-less local roles instead of borrowing the parent', () => {
  for (const configured of [[], [{ name: 'fixer', mode: 'subagent' }]]) {
    const candidate = composition(source, { listConfigAgents: () => configured });
    for (const resolve of [candidate.direct, candidate.rpc]) {
      expect(() => resolve({ ...input, fallbackExecution: { providerId: 'parent', modelId: 'unrelated' } })).toThrow(expect.objectContaining({ code: 'managed_agent_model_unavailable', statusCode: 409 }));
    }
  }
});

it('preserves actual core catalog refusal before scheduler admission', async () => {
  const candidate = composition(source, { listConfigAgents: () => agents });
  const scheduler = {
    initialize: vi.fn(async () => {}), shutdown: vi.fn(async () => {}), flush: vi.fn(async () => {}),
    getDiagnostics: () => ({}), submit: vi.fn(),
  };
  const validateAgentExecution = vi.fn(async () => false);
  const runtime = createWebManagedOrchestrationRuntime({
    persistence: { load: async () => null, save: async () => {} }, scheduler,
    executor: { start: async () => { throw new Error('must not start'); } },
    resolveAgentExecution: candidate.direct,
    readAgentCatalog: async () => agents, validateAgentExecution,
  });
  try {
    await expect(runtime.handleRpc({ method: 'submit', params: {
      idempotencyKey: 'fixture-task', rootSessionId: input.rootSessionId, directory: input.directory,
      mode: 'orchestrator', providerId: '', modelId: '', variant: null,
      agent: input.agent, label: 'Isolated task', prompt: 'Isolated task',
    } })).rejects.toMatchObject({ code: 'managed_agent_model_unavailable', statusCode: 409 });
    expect(validateAgentExecution).toHaveBeenCalledWith({ directory: input.directory, providerId: saved.providerId, modelId: saved.modelId, variant: saved.variant });
    expect(scheduler.submit).not.toHaveBeenCalled();
  } finally { await runtime.shutdown(); }
});
