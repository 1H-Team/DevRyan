import { describe, expect, it, vi } from 'vitest';
import { createDiagnosticSanitizer } from '@openchamber/harness-runtime';
import { buildHarnessRunFingerprint, createHarnessRunFingerprintReader } from './harness-run-fingerprint.js';

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
    expect(value.plugins).toEqual({ configured: null, observed: null, observation: 'unavailable' });
    expect(value.role.contentHash).toBeNull();
  });
  it('survives journal sanitization while dropping malformed hash fields', () => {
    const sanitizer = createDiagnosticSanitizer();
    const fingerprint = buildHarnessRunFingerprint(input());
    const result = sanitizer.sanitizeRecord({ type: 'lifecycle', event: 'harness_run_start',
      sessionID: 'ses_fixture', payload: { fingerprint, contentHash: 'a private credential' } });
    expect(result.payload.fingerprint).toEqual(fingerprint);
    expect(result.payload.contentHash).toBeUndefined();
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
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(entries[0]).toMatchObject({ event: 'harness_run_start', userMessageID: 'msg_fixture', payload: { fingerprint: a } });
  });
});
