// Gen-2 cases of the harness tool manifest (DESIGN.md E item 13d): the tool
// catalog comes from the host's sealed tool snapshot through openCodeClient
// (`catalog.tools`, `GET /devryan/tools`). Gen 1 keeps the
// `/experimental/tool[/ids]` reads, which harness-preflight.test.js covers.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createLoopbackOpenCodeFixtureForGeneration } from '../../../../../scripts/perf/loopback-opencode-fixtures.mjs';
import { createOpenCodeClient, OpenCodeClientError } from './opencode-client/index.js';
import { createHarnessToolManifestReader } from './harness-tool-manifest.js';

const definitions = [
  { id: 'bash', description: 'Run a command', parameters: { type: 'object' } },
  { id: 'read', description: 'Read a file', parameters: { type: 'object' } },
];

const fakeClient = (tools, generation = 2) => ({
  generation: () => generation,
  catalog: { tools: vi.fn(tools) },
});

describe('harness tool manifest on OpenCode 2', () => {
  it('reads ids and the provider/model catalog from one host snapshot', async () => {
    const client = fakeClient(async () => ({ ids: ['bash', 'read'], definitions }));
    const fetchImpl = vi.fn();
    const read = createHarnessToolManifestReader({ openCodeClient: client, fetchImpl, buildOpenCodeUrl: (p) => `http://127.0.0.1:1${p}` });

    const manifest = await read({ directory: '/project', providerID: 'anthropic', modelID: 'claude' });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(client.catalog.tools).toHaveBeenCalledTimes(1);
    expect(client.catalog.tools.mock.calls[0][0]).toEqual({ directory: '/project', providerID: 'anthropic', modelID: 'claude' });
    expect(manifest).toMatchObject({
      toolIds: ['bash', 'read'],
      directory: '/project',
      selector: { mode: 'providerModel', providerID: 'anthropic', modelID: 'claude' },
      availability: { ids: { availability: 'available' }, catalog: { availability: 'available' } },
    });
    expect(manifest.tools.map((tool) => [tool.id, tool.description, tool.aliases])).toEqual([
      ['bash', 'Run a command', ['bash']],
      ['read', 'Read a file', ['read']],
    ]);
  });

  it('marks the catalog as not requested without a provider and model', async () => {
    const client = fakeClient(async () => ({ ids: ['edit'], definitions: null }));
    const manifest = await createHarnessToolManifestReader({ openCodeClient: client })({ directory: '/project' });
    expect(client.catalog.tools.mock.calls[0][0]).toEqual({ directory: '/project' });
    expect(manifest.availability).toEqual({ ids: { availability: 'available' }, catalog: { availability: 'notRequested' } });
    expect(manifest.aliases.edit).toEqual(['edit', 'write', 'patch', 'apply_patch']);
  });

  it('reports upstream, local and payload failures as unavailable measurements', async () => {
    const upstream = new OpenCodeClientError('catalog.tools failed (503)', { code: 'opencode_unavailable', statusCode: 503 });
    const local = new OpenCodeClientError('needs a project directory', { code: 'opencode_location_required', statusCode: 400 });
    const cases = [
      [async () => { throw upstream; }, { kind: 'httpError', httpStatus: 503 }],
      [async () => { throw local; }, { kind: 'requestFailed' }],
      [async () => ({ ids: 'bash', definitions: [] }), { kind: 'invalidPayload' }],
    ];
    for (const [tools, error] of cases) {
      const manifest = await createHarnessToolManifestReader({ openCodeClient: fakeClient(tools) })({ directory: '/project', providerID: 'xai', modelID: 'grok' });
      expect(manifest.availability.ids).toEqual({ availability: 'unavailable', error });
      expect(manifest.toolIds).toEqual([]);
    }
  });

  it('times out a stalled snapshot and aborts it', async () => {
    let signal;
    const client = fakeClient((_query, options) => {
      signal = options.signal;
      return new Promise(() => {});
    });
    const manifest = await createHarnessToolManifestReader({ openCodeClient: client, toolRequestTimeoutMs: 5 })({
      directory: '/project', providerID: 'xai', modelID: 'grok',
    });
    expect(manifest.availability).toEqual({
      ids: { availability: 'unavailable', error: { kind: 'timeout' } },
      catalog: { availability: 'unavailable', error: { kind: 'timeout' } },
    });
    expect(signal.aborted).toBe(true);
  });

  it('fails closed on unknown or generation 1 identities', async () => {
    const unknown = { generation: () => { throw new Error('unknown generation'); }, catalog: { tools: vi.fn() } };
    const failed = await createHarnessToolManifestReader({ openCodeClient: unknown })({ directory: '/project' });
    expect(failed.availability.ids).toEqual({ availability: 'unavailable', error: { kind: 'requestFailed' } });
    expect(unknown.catalog.tools).not.toHaveBeenCalled();

    const gen1 = fakeClient(async () => ({ ids: [], definitions: [] }), 1);
    const fetchImpl = vi.fn(async () => Response.json(['bash']));
    const legacy = await createHarnessToolManifestReader({
      openCodeClient: gen1, fetchImpl, buildOpenCodeUrl: (requestPath) => `http://127.0.0.1:1${requestPath}`,
    })({ directory: '/project' });
    expect(gen1.catalog.tools).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(legacy.toolIds).toEqual([]);
    expect(legacy.availability.ids).toMatchObject({ availability: 'unavailable' });
  });
});

describe('harness tool manifest against the gen-2 fixture', () => {
  let directory;
  let fixture;
  let client;

  beforeAll(async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'devryan-tool-manifest-'));
    fixture = await createLoopbackOpenCodeFixtureForGeneration(2, { directory, heartbeatMs: 50 });
    client = createOpenCodeClient({
      getRuntime: () => ({ generation: 2, baseUrl: fixture.origin }),
      getAuthHeaders: () => ({ ...fixture.authHeaders }),
    });
  });

  afterAll(async () => {
    fixture?.stopScenario?.({ settle: false });
    await fixture?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it('reads the fixture-served host tool snapshot in v1 tool names', async () => {
    const manifest = await createHarnessToolManifestReader({ openCodeClient: () => client })({
      directory, providerID: 'anthropic', modelID: 'claude',
    });
    expect(manifest.availability).toEqual({ ids: { availability: 'available' }, catalog: { availability: 'available' } });
    expect(manifest.toolIds).toEqual(['bash', 'read', 'edit', 'write', 'question']);
    expect(manifest.tools.map((tool) => tool.id)).toEqual(['bash', 'read', 'edit', 'write', 'question']);
    expect(manifest.tools.every((tool) => typeof tool.description === 'string' && tool.parameters)).toBe(true);
  });

  it('refuses a snapshot read without a project directory before any request', async () => {
    const manifest = await createHarnessToolManifestReader({ openCodeClient: client })({ providerID: 'anthropic', modelID: 'claude' });
    expect(manifest.availability.ids).toEqual({ availability: 'unavailable', error: { kind: 'requestFailed' } });
  });
});
