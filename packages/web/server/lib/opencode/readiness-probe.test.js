import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createLoopbackOpenCodeV2Fixture } from '../../../../../scripts/perf/loopback-opencode-v2-fixture.mjs';
import {
  OPENCODE_GENERATION_ENV,
  TARGET_OPENCODE_V2_VERSION,
  describeOpenCodeRuntimeCapabilities,
  parseOpenCodeGeneration,
  probe,
  resolveExpectedOpenCodeVersion,
  resolveExternalOpenCodeGeneration,
  resolveManagedOpenCodeGeneration,
} from './readiness-probe.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const READY_BODY = Object.freeze({
  ready: true,
  generation: 2,
  opencode: { version: TARGET_OPENCODE_V2_VERSION },
  host: { version: '0.1.0', buildId: 'test-build' },
  migration: { v1: 'completed' },
  catalog: { asserted: true },
});

const stubGenerationTwo = ({ ready = jsonResponse(200, READY_BODY), info = jsonResponse(200, { version: 'unknown' }) } = {}) => (
  vi.fn(async (url) => (String(url).endsWith('/devryan/ready') ? ready : info))
);

describe('readiness probe against the loopback fixtures', () => {
  let directory;
  let v2;

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'devryan-readiness-probe-'));
    v2 = await createLoopbackOpenCodeV2Fixture({ directory, heartbeatMs: 50 });
  });

  afterAll(async () => {
    await v2?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  afterEach(() => {
    v2.setReady({ ready: true });
  });

  it('rejects the retired runtime before any request', async () => {
    const fetchImpl = vi.fn();
    expect(await probe({ generation: 1, baseUrl: v2.origin, fetchImpl }))
      .toMatchObject({ ready: false, generation: null, reason: 'generation_invalid' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports a gen-2 host ready with /devryan/ready and /api/info at the pinned version', async () => {
    const result = await probe({ generation: 2, baseUrl: `${v2.origin}/`, headers: v2.authHeaders, timeoutMs: 3000, env: {} });
    expect(result).toEqual({
      ready: true,
      generation: 2,
      version: TARGET_OPENCODE_V2_VERSION,
      expectedVersion: TARGET_OPENCODE_V2_VERSION,
      reason: null,
      status: 200,
      phase: null,
      retryAfterMs: null,
      catalogAsserted: true,
      host: { version: '0.0.0-fixture', buildId: 'loopback-opencode-v2-fixture' },
      migration: 'not-needed',
    });
  });

  it('is not ready without the runtime credentials', async () => {
    const result = await probe({ generation: 2, baseUrl: v2.origin, timeoutMs: 3000, env: {} });
    expect(result).toMatchObject({ ready: false, reason: 'unauthorized', status: 401 });
  });

  it('passes the host not-ready phase and retry hint through', async () => {
    v2.setReady({ ready: false, phase: 'migrating', retryAfterMs: 250 });
    const result = await probe({ generation: 2, baseUrl: v2.origin, headers: v2.authHeaders, timeoutMs: 3000, env: {} });
    expect(result).toMatchObject({ ready: false, reason: 'not_ready', status: 503, phase: 'migrating', retryAfterMs: 250 });
  });

  it('requires the owned native readiness route', async () => {
    expect(await probe({ generation: 2, baseUrl: 'http://fixture.invalid',
      fetchImpl: stubGenerationTwo({ ready: jsonResponse(404, null) }), env: {} }))
      .toMatchObject({ ready: false, generation: 2, reason: 'ready_route_missing', status: 404 });
  });

  it('is not ready when the host embeds a version other than the pin', async () => {
    const other = await createLoopbackOpenCodeV2Fixture({ directory, heartbeatMs: 50, opencodeVersion: '2.0.19' });
    try {
      const pinned = await probe({ generation: 2, baseUrl: other.origin, headers: other.authHeaders, timeoutMs: 3000, env: {} });
      expect(pinned).toMatchObject({ ready: false, reason: 'version_mismatch', version: '2.0.19', expectedVersion: TARGET_OPENCODE_V2_VERSION });

      // An explicit 2.x QA candidate replaces the pin.
      const candidate = await probe({
        generation: 2,
        baseUrl: other.origin,
        headers: other.authHeaders,
        timeoutMs: 3000,
        env: { DEVRYAN_QA_OPENCODE_VERSION: '2.0.19' },
      });
      expect(candidate).toMatchObject({ ready: true, version: '2.0.19', expectedVersion: '2.0.19' });
    } finally {
      await other.close();
    }
  });

  it('reports an unreachable host', async () => {
    const closed = await createLoopbackOpenCodeV2Fixture({ directory, heartbeatMs: 50 });
    const origin = closed.origin;
    await closed.close();
    expect(await probe({ generation: 2, baseUrl: origin, headers: closed.authHeaders, timeoutMs: 3000, env: {} }))
      .toMatchObject({ ready: false, reason: 'unreachable' });
  });
});

describe('readiness probe edge cases', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('never fetches for an invalid generation', async () => {
    const fetchImpl = vi.fn();
    expect(await probe({ generation: 3, baseUrl: 'http://127.0.0.1:1', fetchImpl }))
      .toMatchObject({ ready: false, generation: null, reason: 'generation_invalid' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses only the native routes with caller authentication', async () => {
    const fetchImpl = stubGenerationTwo();
    expect(await probe({ generation: 2, baseUrl: 'http://fixture.invalid//',
      headers: { Authorization: 'Basic fixture' }, fetchImpl, env: {} })).toMatchObject({ ready: true });
    expect(fetchImpl.mock.calls.map(([url]) => url).sort()).toEqual([
      'http://fixture.invalid/api/info', 'http://fixture.invalid/devryan/ready',
    ]);
    for (const [, options] of fetchImpl.mock.calls) expect(options).toMatchObject({
      method: 'GET', headers: { Accept: 'application/json', Authorization: 'Basic fixture' },
    });
  });

  it('times out with the internal abort timer and clears it', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const pending = probe({ generation: 2, baseUrl: 'http://127.0.0.1:1', fetchImpl, timeoutMs: 3000, env: {} });
    await vi.advanceTimersByTimeAsync(3000);
    await expect(pending).resolves.toMatchObject({ ready: false, reason: 'timeout' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['a body that is not ready', { ...READY_BODY, ready: false }, 'invalid_ready_body'],
    ['a gen-1 generation claim', { ...READY_BODY, generation: 1 }, 'generation_mismatch'],
    ['a missing host build', { ...READY_BODY, host: { version: '0.1.0' } }, 'invalid_ready_body'],
    ['an unknown migration state', { ...READY_BODY, migration: { v1: 'failed' } }, 'invalid_ready_body'],
    ['an unasserted catalog', { ...READY_BODY, catalog: { asserted: false } }, 'catalog_unasserted'],
  ])('rejects %s', async (_label, body, reason) => {
    const fetchImpl = stubGenerationTwo({ ready: jsonResponse(200, body) });
    expect(await probe({ generation: 2, baseUrl: 'http://x', fetchImpl, env: {} })).toMatchObject({ ready: false, reason });
  });

  it('requires /api/info to answer 200 and to agree on a known version', async () => {
    expect(await probe({ generation: 2, baseUrl: 'http://x', fetchImpl: stubGenerationTwo({ info: jsonResponse(500, null) }), env: {} }))
      .toMatchObject({ ready: false, reason: 'info_status', status: 500 });
    expect(await probe({ generation: 2, baseUrl: 'http://x', fetchImpl: stubGenerationTwo({ info: jsonResponse(200, { version: '2.0.1' }) }), env: {} }))
      .toMatchObject({ ready: false, reason: 'version_mismatch', version: '2.0.1' });
    expect(await probe({ generation: 2, baseUrl: 'http://x', fetchImpl: stubGenerationTwo({ info: jsonResponse(200, { version: TARGET_OPENCODE_V2_VERSION }) }), env: {} }))
      .toMatchObject({ ready: true });
  });

  it('fails closed on a malformed QA version override', async () => {
    expect(await probe({ generation: 2, baseUrl: 'http://x', fetchImpl: stubGenerationTwo(), env: { DEVRYAN_QA_OPENCODE_VERSION: 'latest' } }))
      .toMatchObject({ ready: false, reason: 'version_policy_invalid' });
  });
});

describe('runtime generation', () => {
  it('parses only 2', () => {
    expect(parseOpenCodeGeneration(2)).toBe(2);
    expect(parseOpenCodeGeneration(' 2 ')).toBe(2);
    for (const value of [0, 1, '1', 3, '3', 'two', '', null, undefined, 2.5, {}]) expect(parseOpenCodeGeneration(value)).toBeNull();
  });

  it('reads the external declaration, targeting only gen 2 and failing closed on an invalid value', () => {
    expect(resolveExternalOpenCodeGeneration({})).toEqual({ generation: 2, source: 'default' });
    expect(resolveExternalOpenCodeGeneration({ [OPENCODE_GENERATION_ENV]: ' ' })).toEqual({ generation: 2, source: 'default' });
    expect(resolveExternalOpenCodeGeneration({ [OPENCODE_GENERATION_ENV]: '2' })).toEqual({ generation: 2, source: OPENCODE_GENERATION_ENV });
    expect(resolveExternalOpenCodeGeneration({ [OPENCODE_GENERATION_ENV]: '1' })).toEqual({ generation: null, source: 'invalid' });
    expect(resolveExternalOpenCodeGeneration({ [OPENCODE_GENERATION_ENV]: 'v2' })).toEqual({ generation: null, source: 'invalid' });
  });

  it('reads a managed launch generation from the selection this process owns', () => {
    const selection = (generation, ownerPid) => () => ({ ownerPid, runtime: { generation } });
    expect(resolveManagedOpenCodeGeneration({ readSelection: selection(2, 42), ownerPid: 42 })).toEqual({ generation: 2, source: 'selection' });
    expect(resolveManagedOpenCodeGeneration({ readSelection: selection(2, 41), ownerPid: 42 })).toEqual({ generation: null, source: 'invalid' });
    expect(resolveManagedOpenCodeGeneration({ readSelection: () => null, ownerPid: 42 })).toEqual({ generation: null, source: 'invalid' });
    expect(resolveManagedOpenCodeGeneration({ readSelection: selection(1, 42), ownerPid: 42 })).toEqual({ generation: null, source: 'invalid' });
  });

  it('pins gen 2 to the vendored route table version, which matches the schema dev dependency', () => {
    const rootPackage = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    expect(rootPackage.devDependencies['@opencode/schema']).toBe(TARGET_OPENCODE_V2_VERSION);
    expect(() => resolveExpectedOpenCodeVersion(1, {})).toThrow('Only OpenCode 2');
    expect(resolveExpectedOpenCodeVersion(2, {})).toBe(TARGET_OPENCODE_V2_VERSION);
    expect(() => resolveExpectedOpenCodeVersion(2, { DEVRYAN_QA_OPENCODE_VERSION: '1.18.40' })).toThrow('major 2');
    expect(resolveExpectedOpenCodeVersion(2, { DEVRYAN_QA_OPENCODE_VERSION: '2.0.21' })).toBe('2.0.21');
  });

  it('grants capabilities only to a qualified gen 2 host', () => {
    expect(describeOpenCodeRuntimeCapabilities(1)).toEqual({
      generation: null,
      capabilities: { share: false, mcpOAuth: false, sessionShell: false, lsp: false, messageEdit: false },
    });
    const off = { share: false, mcpOAuth: false, sessionShell: false, lsp: false, messageEdit: false };
    expect(describeOpenCodeRuntimeCapabilities(2)).toEqual({ generation: 2, capabilities: off });
    expect(describeOpenCodeRuntimeCapabilities(2, { mcpOAuthAvailable: true })).toEqual({ generation: 2, capabilities: { ...off, mcpOAuth: true } });
    expect(describeOpenCodeRuntimeCapabilities('x', { mcpOAuthAvailable: true })).toEqual({ generation: null, capabilities: off });
    expect(describeOpenCodeRuntimeCapabilities('x')).toEqual({ generation: null, capabilities: off });
  });
});


describe('strict readiness body contract', () => {
  it('keeps ordinary lifecycle read failures as diagnostics while client reads reject', async () => {
    const fetchImpl = async () => new Response('x'.repeat(4096), { status: 503 });
    expect(await probe({ generation: 2, baseUrl: 'http://fixture.invalid', fetchImpl, maxResponseBytes: 128 }))
      .toMatchObject({ ready: false, reason: 'unreachable' });
    await expect(probe({ generation: 2, baseUrl: 'http://fixture.invalid', fetchImpl, maxResponseBytes: 128, propagateReadFailures: true }))
      .rejects.toMatchObject({ code: 'opencode_response_too_large' });
  });
});
