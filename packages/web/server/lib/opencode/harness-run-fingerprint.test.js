import { createNativeConsumerFixture } from './test-native-consumer-client.js';
const createHarnessRunFingerprintReader = (options = {}) => createHarnessRunFingerprintReaderNative({
  ...options, openCodeClient: options.openCodeClient ?? createNativeConsumerFixture({
    readFixture: options.fetchImpl ?? ((...args) => globalThis.fetch(...args)), headers: options.getOpenCodeAuthHeaders,
  }),
});
import { describe, expect, it, vi } from 'vitest';
import { createDiagnosticSanitizer } from '@devryan/harness-runtime';
import { buildHarnessRunFingerprint, captureBehaviourSwitches, createHarnessRunFingerprintReader as createHarnessRunFingerprintReaderNative } from './harness-run-fingerprint.js';
import { describeAgentPromptTemplate, setAgentPromptPolicySource } from './packaged-agents.js';
import { PLAN_MODE_SYSTEM_INSTRUCTIONS } from '@devryan/orchestration-runtime';
import { withPrimaryPlanModeInstructions } from './runtime-host/native-configuration-data.js';

const input = () => ({ runtimeVersion: '1.18.30', selection: { providerID: 'openai', modelID: 'gpt-6-astra', agent: 'orchestrator', variant: 'medium' },
  agent: { prompt: 'Scoped role instructions' }, source: { scope: 'packaged', path: '/fixture/agents/orchestrator.md' },
  toolManifest: { tools: [{ id: 'read', description: 'Read a file', parameters: { type: 'object' } }], toolIds: ['read'],
    availability: { ids: { availability: 'available' }, catalog: { availability: 'available' } } },
  configuredPlugins: ['file:///fixture/plugins/owner.mjs?credential=private'],
  observedPlugins: [{ name: 'owner', contentHash: 'a'.repeat(64), factoryCalls: 1, ownership: 'managed' }],
  policies: { readOverlap: false, waitAny: true, compactResults: false, contextProjection: false },
});

describe('run fingerprints', () => {
  it('is stable, changes with the role or policies, and includes no raw instructions or paths', () => {
    const one = buildHarnessRunFingerprint(input());
    expect(buildHarnessRunFingerprint(input())).toEqual(one);
    expect(buildHarnessRunFingerprint({ ...input(), agent: { prompt: 'Changed' } }).configurationHash).not.toBe(one.configurationHash);
    expect(buildHarnessRunFingerprint({ ...input(), policies: {} }).configurationHash).not.toBe(one.configurationHash);
    expect(JSON.stringify(one)).not.toMatch(/Scoped role|\/fixture|credential=private/);
    expect(one.plugins.configured[0].name).toBe('owner.mjs');
    expect(one.plugins.observation).toBe('factory_report');
  });
  it('does not infer loaded plugins or zero tool counts from unavailable metadata', () => {
    const value = buildHarnessRunFingerprint();
    expect(value.catalog).toMatchObject({ contentHash: null, idsHash: null, count: null, availability: 'unavailable' });
    expect(value.plugins).toEqual({ configured: null, observed: null, inventory: null, observation: 'unavailable' });
    expect(value.role.contentHash).toBeNull();
  });
  it('survives journal sanitization while dropping malformed hash fields', () => {
    const sanitizer = createDiagnosticSanitizer();
    const fingerprint = buildHarnessRunFingerprint({ ...input(), runtimeHash: 'c'.repeat(64), pluginInventory: {
      configurationHash: 'd'.repeat(64), providerHash: 'e'.repeat(64), contentHash: 'f'.repeat(64),
      entries: [{ name: 'owner.mjs', sourceHash: 'a'.repeat(64), contentHash: 'b'.repeat(64) }],
    } });
    const result = sanitizer.sanitizeRecord({ type: 'lifecycle', event: 'harness_run_start',
      sessionID: 'ses_fixture', payload: { fingerprint, contentHash: 'a private credential', providerHash: 'private text', runtimeHash: 'not-a-hash' } });
    expect(result.payload.fingerprint).toEqual(fingerprint);
    expect(result.payload.contentHash).toBeUndefined();
    expect(result.payload.providerHash).toBeUndefined();
    expect(result.payload.runtimeHash).toBeUndefined();
  });
  it('hashes the catalog without host-local reviewed-skill IDs but keeps every readable skill name', () => {
    const skillTool = (names, ids) => ({ id: 'skill', description: 'Load a skill.', parameters: { type: 'object',
      properties: { id: { type: 'string', enum: [...names, ...ids] } } } });
    const manifest = (tool) => ({ ...input().toolManifest, tools: [...input().toolManifest.tools, tool], toolIds: ['read', 'skill'] });
    const at = (tool) => buildHarnessRunFingerprint({ ...input(), toolManifest: manifest(tool) }).catalog;
    const here = at(skillTool(['Diagnosing Bugs', 'worktrees'], ['devryan-16d75fc67a7fe595136215a66b2482d8', 'devryan-de72f0cae4e31d8535161e514102067a']));
    const there = at(skillTool(['Diagnosing Bugs', 'worktrees'], ['devryan-18f0e8a7a68c3e6d6de8299acc954185', 'devryan-26a0ec7475ccd992e8a98d46161c00a8']));
    expect(there).toEqual(here);
    expect(at(skillTool(['Diagnosing Bugs', 'reflect'], ['devryan-16d75fc67a7fe595136215a66b2482d8', 'devryan-de72f0cae4e31d8535161e514102067a'])).contentHash)
      .not.toBe(here.contentHash);
    expect(at(skillTool(['Diagnosing Bugs'], ['devryan-16d75fc67a7fe595136215a66b2482d8'])).contentHash).not.toBe(here.contentHash);
    // Only the exact reviewed-skill ID shape is neutral; other text keeps its identity.
    expect(at(skillTool(['devryan-16d75fc67a7fe595', 'worktrees'], [])).contentHash).not.toBe(at(skillTool(['devryan-de72f0cae4e31d853', 'worktrees'], [])).contentHash);
  });
  it('records the role derivation, per-tool catalog hashes, policy provenance and enum-valued switches', () => {
    const template = 'Base.\n<!-- devryan:if adaptiveDelegation -->\nAdaptive.\n<!-- devryan:end -->\n<!-- devryan:if !adaptiveDelegation -->\nSpecialists.\n<!-- devryan:end -->';
    const policies = { ...input().policies, adaptiveDelegation: true };
    const value = buildHarnessRunFingerprint({ ...input(), agent: { prompt: 'Base.\nAdaptive.' }, template, policies,
      policySource: 'runtime-projection', switches: captureBehaviourSwitches({ DEVRYAN_LEDGER_PACK: '0', DEVRYAN_VIEW_CLONE: 'sk-private-value',
        DEVRYAN_FS_WATCH: ' Off ', DEVRYAN_UNLISTED: '1' }) });
    expect(value.role).toMatchObject({ templatePolicies: ['adaptiveDelegation'], rendererVersion: 1,
      templateHash: describeAgentPromptTemplate(template, policies).templateHash });
    // The host's own render for these policies equals the rendered role.
    expect(value.role.attestedContentHash).toBe(value.role.contentHash);
    expect(buildHarnessRunFingerprint({ ...input(), agent: { prompt: 'Base.\nSpecialists.' }, template, policies }).role.attestedContentHash)
      .not.toBe(buildHarnessRunFingerprint({ ...input(), agent: { prompt: 'Base.\nSpecialists.' }, template, policies }).role.contentHash);
    expect(value.catalog.tools).toEqual([{ id: 'read', contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
    expect(value.policySource).toBe('runtime-projection');
    expect(buildHarnessRunFingerprint(input()).policySource).toBe('unknown');
    expect(value.switches).toMatchObject({ DEVRYAN_LEDGER_PACK: '0', DEVRYAN_VIEW_CLONE: 'other', DEVRYAN_FS_WATCH: 'off', DEVRYAN_LAZY_BASE_RUNS: 'unset' });
    expect('DEVRYAN_UNLISTED' in value.switches).toBe(false);
    expect(JSON.stringify(value)).not.toMatch(/sk-private|Adaptive\.|Specialists/);
    expect(buildHarnessRunFingerprint({ ...input(), switches: { ...value.switches, DEVRYAN_LEDGER_PACK: '1' } }).configurationHash)
      .not.toBe(buildHarnessRunFingerprint({ ...input(), switches: value.switches }).configurationHash);
    // The whole record survives journal sanitization.
    const record = createDiagnosticSanitizer().sanitizeRecord({ type: 'lifecycle', event: 'harness_run_start', sessionID: 'ses_fixture', payload: { fingerprint: value } });
    expect(record.payload.fingerprint).toEqual(value);
  });
  it('attests a primary agent\'s effective prompt, including the appended Plan-mode instructions', () => {
    const template = 'Base.\n<!-- devryan:if adaptiveDelegation -->\nAdaptive.\n<!-- devryan:end -->';
    const policies = { ...input().policies, adaptiveDelegation: true };
    const effective = withPrimaryPlanModeInstructions('Base.\nAdaptive.', { name: 'orchestrator', mode: 'primary' });
    expect(effective).toContain(PLAN_MODE_SYSTEM_INSTRUCTIONS);
    const primary = buildHarnessRunFingerprint({ ...input(), agent: { name: 'orchestrator', mode: 'primary', prompt: effective }, template, policies });
    expect(primary.role.attestedContentHash).toBe(primary.role.contentHash);
    // A subagent keeps its rendered prompt unchanged.
    const subagent = buildHarnessRunFingerprint({ ...input(), agent: { name: 'fixer', mode: 'subagent', prompt: 'Base.\nAdaptive.' }, template, policies });
    expect(subagent.role.attestedContentHash).toBe(subagent.role.contentHash);
    // A primary agent whose effective prompt lacks the shared instructions is not attested.
    const missing = buildHarnessRunFingerprint({ ...input(), agent: { name: 'orchestrator', mode: 'primary', prompt: 'Base.\nAdaptive.' }, template, policies });
    expect(missing.role.attestedContentHash).not.toBe(missing.role.contentHash);
  });

  it('reads one policy projection, the role template, runtime bytes and switches at every read', async () => {
    const client = {
      generation: () => 2,
      health: { probe: vi.fn(async () => ({ ready: true, version: '2.0.20' })) },
      catalog: {
        config: vi.fn(async () => ({ plugin: [] })),
        agents: vi.fn(async () => [{ name: 'orchestrator', prompt: 'Base.\nSpecialists.' }]),
        tools: vi.fn(async () => ({ ids: ['read'], definitions: [{ id: 'read', description: 'Read', parameters: {} }] })),
      },
    };
    const environment = { DEVRYAN_VIEW_REUSE: '0' };
    const fs = await import('node:fs/promises'), os = await import('node:os'), path = await import('node:path');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-fingerprint-'));
    try {
      const binary = path.join(directory, 'opencode');
      await fs.writeFile(binary, 'runtime bytes');
      const template = 'Base.\n<!-- devryan:if adaptiveDelegation -->\nAdaptive.\n<!-- devryan:end -->\n<!-- devryan:if !adaptiveDelegation -->\nSpecialists.\n<!-- devryan:end -->';
      const reader = createHarnessRunFingerprintReader({ openCodeClient: () => client, environment, getRuntimeBinary: () => binary,
        getAgentSource: () => input().source, readAgentTemplate: (source) => (source.path === input().source.path ? template : null) });
      setAgentPromptPolicySource(() => ({ readOverlap: true, waitAny: true, compactResults: true, contextProjection: false,
        duplicateOutputs: false, adaptiveDelegation: false }));
      const start = await reader.read({ ...input().selection, directory: '/fixture' });
      expect(start).toMatchObject({ policySource: 'runtime-projection', runtimeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        policies: { adaptiveDelegation: false, waitAny: true }, switches: { DEVRYAN_VIEW_REUSE: '0' } });
      expect(start.role.attestedContentHash).toBe(start.role.contentHash);
      environment.DEVRYAN_VIEW_REUSE = '1';
      expect((await reader.read({ ...input().selection, directory: '/fixture' })).switches.DEVRYAN_VIEW_REUSE).toBe('1');
      // A projection the prompts did not render from cannot attest the role.
      setAgentPromptPolicySource(() => ({ readOverlap: true, waitAny: true, compactResults: true, contextProjection: false,
        duplicateOutputs: false, adaptiveDelegation: true }));
      const drifted = await reader.read({ ...input().selection, directory: '/fixture' });
      expect(drifted.role.attestedContentHash).not.toBe(drifted.role.contentHash);
    } finally {
      setAgentPromptPolicySource(null);
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  it('captures native selection using bounded local endpoints and shares in-flight preflight reads', async () => {
    const entries = [];
    const fetchImpl = vi.fn(async (value) => {
      const url = new URL(value);
      const responses = { '/global/health': { healthy: true, version: '1.18.30' }, '/config': { plugin: [] },
        '/agent': [{ name: 'orchestrator', prompt: 'Role' }], '/experimental/tool/ids': ['read'],
        '/experimental/tool': [{ id: 'read', description: 'Read', parameters: {} }] };
      return Response.json(responses[url.pathname]);
    });
    const reader = createHarnessRunFingerprintReader({ fetchImpl, buildOpenCodeUrl: (p) => `http://127.0.0.1:12345${p}`,
      getOpenCodeAuthHeaders: () => ({}), getAgentSource: () => input().source, recordDiagnostic: (value) => entries.push(value) });
    const context = { ...input().selection, directory: '/fixture', sessionID: 'ses_fixture', messageID: 'msg_fixture' };
    const [a, b] = await Promise.all([reader.capture(context), reader.read(context)]);
    expect(a).toEqual(b);
    expect(a.policies.readOverlap).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(entries[0]).toMatchObject({ event: 'harness_run_start', userMessageID: 'msg_fixture', payload: { fingerprint: a } });
  });
  it('reads health, config, agents and the tool snapshot through the client on OpenCode 2', async () => {
    const fetchImpl = vi.fn();
    const client = {
      generation: () => 2,
      health: { probe: vi.fn(async () => ({ ready: true, version: '2.0.20' })) },
      catalog: {
        config: vi.fn(async () => ({ plugin: [] })),
        agents: vi.fn(async () => [{ name: 'orchestrator', prompt: 'Role' }]),
        tools: vi.fn(async () => ({ ids: ['read'], definitions: [{ id: 'read', description: 'Read', parameters: {} }] })),
      },
    };
    const reader = createHarnessRunFingerprintReader({ fetchImpl, buildOpenCodeUrl: (p) => `http://127.0.0.1:12345${p}`,
      openCodeClient: () => client, getAgentSource: () => input().source });
    const context = { ...input().selection, directory: '/fixture' };
    const value = await reader.read(context);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(client.catalog.config.mock.calls[0][0]).toEqual({ directory: '/fixture' });
    expect(client.catalog.agents.mock.calls[0][0]).toEqual({ directory: '/fixture' });
    expect(value).toMatchObject({ runtimeVersion: '2.0.20', role: { contentHash: expect.any(String) },
      catalog: { count: 1, availability: 'available' }, plugins: { configured: [] } });

    // Unsupported identities produce unavailable metadata without any transport.
    const gen1Fetch = vi.fn(async (raw) => {
      const responses = { '/global/health': { healthy: true, version: '2.0.20' }, '/config': { plugin: [] },
        '/agent': [{ name: 'orchestrator', prompt: 'Role' }], '/experimental/tool/ids': ['read'],
        '/experimental/tool': [{ id: 'read', description: 'Read', parameters: {} }] };
      return Response.json(responses[new URL(raw).pathname]);
    });
    const gen1 = createHarnessRunFingerprintReader({ fetchImpl: gen1Fetch, buildOpenCodeUrl: (p) => `http://127.0.0.1:12345${p}`,
      openCodeClient: { ...client, generation: () => 1 }, getAgentSource: () => input().source });
    expect(await gen1.read(context)).toMatchObject({ runtimeVersion: null, catalog: { availability: 'unavailable', count: null } });
    expect(gen1Fetch).not.toHaveBeenCalled();
  });
  it('treats an unready host, a failed read or an unknown generation as unavailable metadata', async () => {
    const fetchImpl = vi.fn();
    const failing = {
      generation: () => 2,
      health: { probe: vi.fn(async () => ({ ready: false, reason: 'not_ready', version: null })) },
      catalog: {
        config: vi.fn(async () => { throw new Error('catalog.config failed (503)'); }),
        agents: vi.fn(async () => { throw new Error('catalog.agents failed (503)'); }),
        tools: vi.fn(async () => { throw new Error('catalog.tools failed (503)'); }),
      },
    };
    for (const openCodeClient of [failing, { generation: () => { throw new Error('unknown generation'); } }]) {
      const value = await createHarnessRunFingerprintReader({ fetchImpl, buildOpenCodeUrl: (p) => `http://127.0.0.1:12345${p}`, openCodeClient })
        .read({ ...input().selection, directory: '/fixture' });
      expect(value).toMatchObject({ runtimeVersion: null, role: { contentHash: null }, catalog: { availability: 'unavailable' },
        plugins: { configured: null } });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
