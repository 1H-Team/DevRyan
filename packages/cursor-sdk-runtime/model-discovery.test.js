import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createCursorSdkRuntime } from './index.js';
import { createNativeCursorOwner } from '../web/server/lib/opencode/runtime-host/native-cursor-owner.js';

const createRuntimeForModels = (models) => createCursorSdkRuntime({
  env: { CURSOR_API_KEY: 'test-key' },
  readAuth: () => ({}),
  writeAuth: () => {},
  loadSdk: async () => ({
    Cursor: {
      models: {
        list: async () => models,
      },
    },
  }),
});

test('owned catalogs retain saved effort and settle cancellation, deadline and uncertain receipts', async () => {
  for (const mode of ['success', 'cancel', 'deadline', 'uncertain']) {
    const timedOut = mode === 'deadline';
    const caller = new AbortController(), receipt = Promise.withResolvers(), started = Promise.withResolvers(), stopped = Promise.withResolvers();
    const inputs = [], diagnostics = [], catalogEvents = [];
    let cancelled = 0, completed = false;
    const owner = createNativeCursorOwner({ instanceID: 'fixture', isReady: () => true, admissionOwner: {}, runtime: {},
      controller: () => ({ instanceID: 'fixture', call: async ({ action, ...input }) => {
        expect(action).toBe('cursor-readonly-key-owned'); await owner.assertReadOnlyKey(input);
        return { key: 'synthetic-owned-key', credentialID: 'fixture-key', expectedFingerprint: 'a'.repeat(64) };
      } }), abortAndWait: async () => {}, onStarted: async () => {} });
    const runtime = createCursorSdkRuntime({ env: {}, nativeWarming: false, nodeBinary: process.execPath,
      emitEvent: event => catalogEvents.push(event),
      recordDiagnostic: entry => { diagnostics.push(entry); if (mode === 'success') throw Error('fixture observer failure'); },
      resolveApiKey: scope => owner.resolveApiKey(scope),
      ownedReadOnly: (scope, action) => owner.withReadOnly({ kind: scope.kind, directory: scope.directory },
        { revision: 0, recheck: async () => scope.signal?.throwIfAborted() }, action),
      executionAdapter: { startReadOnly: request => owner.withReadOnlyExecution(async () => {
        const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
        let wire = '';
        child.stdin = new Writable({ write: (chunk, _encoding, done) => { wire += chunk; done(); },
          final: done => {
            inputs.push(JSON.parse(wire)); started.resolve(); done();
            if (mode === 'success') queueMicrotask(() => {
              child.stdout.end(`${JSON.stringify({ type: 'catalog-result', models: [{ id: 'chosen', variants: [{ params: [{ id: 'effort', value: 'high' }] }] }] })}\n`);
              child.emit('close', 0, null);
            });
          } });
        return { child, workerInput: request.inputForLease({ workingDirectory: '/confined' }), result: receipt.promise,
          cancel: async () => {
            cancelled++; child.stdout.end(`${JSON.stringify({ type: 'catalog-result', models: [{ id: 'late-success' }] })}\n`);
            child.emit('close', 0, null); stopped.resolve();
          } };
      }) },
    });
    const reason = Error('caller stopped');
    try {
      const pending = runtime.refreshVirtualProvider({ directory: '/fixture', timeoutMs: timedOut ? 30 : 1000,
        signal: caller.signal }).finally(() => { completed = true; });
      void pending.catch(() => {});
      await started.promise;
      if (mode === 'success') {
        expect(completed).toBe(false);
        expect(catalogEvents).toHaveLength(0);
        receipt.resolve({ confined: true, terminated: true, cancelled: false });
        const provider = await pending;
        expect(provider.models.chosen.variants.high.cursorSdkModel).toEqual({ id: 'chosen', params: [{ id: 'effort', value: 'high' }] });
        expect(await runtime.validateModelSelection({ directory: '/fixture', modelID: 'chosen', variant: 'high' })).toBe(true);
        expect(inputs).toHaveLength(1); expect(cancelled).toBe(0);
        expect(diagnostics.slice(0, 4).map(entry => entry.payload.phase)).toEqual(['key_resolved', 'worker_started', 'worker_result', 'settled']);
        expect(diagnostics[3].payload.outcome).toBe('completed');
        expect(catalogEvents).toHaveLength(1);
        expect(catalogEvents[0].properties).toEqual({ providerID: 'cursor-acp', directory: '/fixture', source: 'sdk' });
        continue;
      }
      if (!timedOut) caller.abort(reason);
      await stopped.promise;
      expect(cancelled).toBe(1); expect(completed).toBe(false);
      expect(inputs[0]).toMatchObject({ type: 'catalog', apiKey: 'synthetic-owned-key', directory: '/confined' });
      expect(inputs[0]).not.toHaveProperty('signal');
      if (mode === 'uncertain') receipt.reject(Error('termination receipt unavailable'));
      else receipt.resolve({ confined: true, terminated: true, cancelled: true });
      if (mode === 'uncertain') await expect(pending).rejects.toMatchObject({ nativeProcessUnsettled: true });
      else if (timedOut) await expect(pending).rejects.toMatchObject({ code: 'native_cursor_catalog_timeout' });
      else await expect(pending).rejects.toBe(reason);
      expect(runtime.getCachedVirtualProvider().models['late-success']).toBeUndefined();
      expect(catalogEvents).toHaveLength(0);
      expect(runtime.getRuntimeStatus()).toMatchObject({ lastModelRefreshTimedOut: timedOut,
        lastModelRefreshError: timedOut ? 'native_cursor_catalog_timeout' : 'cursor_model_catalog_cancelled' });
      expect(diagnostics.map(entry => entry.payload.phase)).toEqual(['key_resolved', 'worker_started', 'worker_result', 'settled']);
      expect(diagnostics.at(-1).payload.outcome).toBe(timedOut ? 'timeout' : 'cancelled');
      expect(diagnostics.every(entry => entry.type === 'lifecycle' && entry.event === 'cursor_catalog'
        && Number.isFinite(entry.payload.elapsedMs) && entry.payload.elapsedMs >= 0)).toBe(true);
      expect(JSON.stringify(diagnostics)).not.toContain('synthetic-owned-key');
    } finally { receipt.resolve({ confined: true, terminated: true, cancelled: true }); await runtime.dispose(); await owner.close(); }
  }
});

describe('Cursor SDK model discovery', () => {
  test('scoped adoption notifies once when a global discovery commits before scoped credential resolution', async () => {
    const listing = Promise.withResolvers(), releaseListing = Promise.withResolvers();
    const scopedKey = Promise.withResolvers(), releaseScopedKey = Promise.withResolvers();
    const events = [];
    let calls = 0, deferScopedKey = true, key = 'owned-fixture';
    const runtime = createCursorSdkRuntime({ env: {}, nativeWarming: false, modelDiscoveryTtlMs: 60_000,
      resolveApiKey: async ({ directory }) => {
        if (directory === '/owned/project' && deferScopedKey) {
          scopedKey.resolve(); await releaseScopedKey.promise;
        }
        return key;
      },
      ownedReadOnly: async (_scope, action) => action(),
      loadSdk: async () => ({ Cursor: { models: { list: async () => {
        calls++; listing.resolve(); await releaseListing.promise;
        return [{ id: 'sdk-chosen', displayName: 'Chosen' }];
      } } } }),
      emitEvent: event => {
        expect(runtime.getCachedVirtualProvider().models['sdk-chosen']).toBeDefined();
        events.push(event);
      },
    });
    try {
      const global = runtime.refreshVirtualProvider();
      await listing.promise;
      const scoped = runtime.refreshVirtualProvider({ directory: '/owned/project' });
      // The synchronous providers route has already served its startup fallback.
      expect(runtime.getCachedVirtualProvider().models['sdk-chosen']).toBeUndefined();
      await scopedKey.promise;
      releaseListing.resolve(); await global;
      expect(events.map(event => event.properties.directory)).toEqual(['']);
      deferScopedKey = false; releaseScopedKey.resolve();
      expect((await scoped).models['sdk-chosen']).toBeDefined();
      expect(calls).toBe(1);
      expect(events.map(event => event.properties.directory)).toEqual(['', '/owned/project']);
      await runtime.refreshVirtualProvider({ directory: '/owned/project' });
      await runtime.refreshVirtualProvider();
      expect(events).toHaveLength(2);
      await runtime.refreshVirtualProvider({ directory: '/owned/project', force: true });
      expect(calls).toBe(2); expect(events).toHaveLength(3);
      // A new account may publish the same IDs, but has a distinct committed generation.
      key = 'owned-other-fixture';
      await runtime.refreshVirtualProvider({ directory: '/owned/project' });
      expect(calls).toBe(3); expect(events).toHaveLength(4);
      expect(JSON.stringify(events)).not.toContain('fixture');
    } finally { releaseScopedKey.resolve(); releaseListing.resolve(); await runtime.dispose(); }
  });

  test('catalog invalidation follows SDK cache commit and excludes cached reads, fallback and failure', async () => {
    for (const native of [true, false]) {
      const entered = Promise.withResolvers(), release = Promise.withResolvers(), events = [];
      let fail = false, calls = 0;
      const runtime = createCursorSdkRuntime({ nativeWarming: false, modelDiscoveryTtlMs: 60_000,
        ...(native ? { env: {}, resolveApiKey: async () => 'owned-fixture', ownedReadOnly: async (_scope, action) => action() }
          : { env: { CURSOR_API_KEY: 'legacy-fixture' }, readAuth: () => ({}) }),
        loadSdk: async () => ({ Cursor: { models: { list: async () => {
          calls++; entered.resolve(); await release.promise;
          if (fail) throw Error('Fixture catalog unavailable');
          return [{ id: 'sdk-chosen', displayName: 'Chosen' }];
        } } } }),
        emitEvent: (event, context) => {
          events.push({ event, context });
          expect(runtime.getCachedVirtualProvider().models['sdk-chosen']).toBeDefined();
        },
      });
      try {
        expect(runtime.getCachedVirtualProvider().models['sdk-chosen']).toBeUndefined();
        const pending = runtime.refreshVirtualProvider({ directory: '/owned/project' });
        await entered.promise;
        expect(events).toHaveLength(0);
        release.resolve();
        await pending;
        expect(events).toEqual([{ event: { type: 'openchamber:provider-catalog',
          properties: { providerID: 'cursor-acp', directory: '/owned/project', source: 'sdk' } },
          context: { directory: '/owned/project', eventId: expect.any(String) } }]);
        await runtime.refreshVirtualProvider({ directory: '/owned/project' });
        expect(calls).toBe(1); expect(events).toHaveLength(1);
        fail = true;
        await runtime.refreshVirtualProvider({ directory: '/owned/project', force: true });
        expect(calls).toBe(2); expect(events).toHaveLength(1);
        fail = false;
        await runtime.refreshVirtualProvider({ directory: '/owned/other', force: true });
        expect(events).toHaveLength(2);
        expect(events[1].event.properties.directory).toBe('/owned/other');
        expect(events[1].context.directory).toBe('/owned/other');
        await runtime.refreshVirtualProvider({ force: true });
        expect(events[2].event.properties.directory).toBe('');
        expect(events[2].context.directory).toBeUndefined();
        expect(JSON.stringify(events)).not.toContain('fixture');
        expect(events.every(({ event }) => !('models' in event.properties))).toBe(true);
      } finally { release.resolve(); await runtime.dispose(); }
    }
    const events = [];
    const fallback = createCursorSdkRuntime({ env: {}, nativeWarming: false, readAuth: () => ({}), emitEvent: event => events.push(event) });
    try { await fallback.refreshVirtualProvider(); expect(events).toHaveLength(0); }
    finally { await fallback.dispose(); }
    const empty = createCursorSdkRuntime({ env: { CURSOR_API_KEY: 'legacy-fixture' }, nativeWarming: false,
      readAuth: () => ({}), loadSdk: async () => ({ Cursor: { models: { list: async () => [] } } }),
      emitEvent: event => events.push(event),
    });
    try { await empty.refreshVirtualProvider(); expect(events).toHaveLength(0); }
    finally { await empty.dispose(); }
  });

  test('catalog invalidation observer failure cannot replace a committed SDK catalog', async () => {
    let emitted = 0;
    const runtime = createCursorSdkRuntime({ env: {}, nativeWarming: false,
      resolveApiKey: async () => 'owned-fixture', ownedReadOnly: async (_scope, action) => action(),
      loadSdk: async () => ({ Cursor: { models: { list: async () => [{ id: 'sdk-chosen' }] } } }),
      emitEvent: () => { emitted++; throw Error('Fixture observer unavailable'); },
    });
    try {
      expect((await runtime.refreshVirtualProvider({ directory: '/owned/project' })).models['sdk-chosen']).toBeDefined();
      expect(runtime.getRuntimeStatus().modelsSource).toBe('sdk');
      expect(emitted).toBe(1);
    } finally { await runtime.dispose(); }
  });

  test('native public timeout after an account switch returns declared fallback without prior-account evidence', async () => {
    let key = 'owned-account-a', readSignal;
    const calls = [];
    const runtime = createCursorSdkRuntime({ nativeWarming: false, modelDiscoveryTtlMs: 60_000,
      resolveApiKey: async () => key,
      ownedReadOnly: async (scope, action) => { readSignal = scope.signal; return action(); },
      loadSdk: async () => ({ Cursor: { models: { list: async ({ apiKey }) => {
        calls.push(apiKey);
        if (apiKey === 'owned-account-b') await new Promise(resolve => readSignal.addEventListener('abort', resolve, { once: true }));
        return [{ id: apiKey }];
      } } } }),
    });
    try {
      expect((await runtime.getVirtualProvider({ directory: '/owned/project' })).models['owned-account-a']).toBeDefined();
      key = 'owned-account-b';
      const provider = await runtime.refreshVirtualProvider({ directory: '/owned/project', timeoutMs: 20 });
      expect(calls).toEqual(['owned-account-a', 'owned-account-b']);
      expect(provider.models['owned-account-a']).toBeUndefined();
      expect(provider.models['owned-account-b']).toBeUndefined();
      expect(provider.models['composer-2.5']).toBeDefined();
      expect(runtime.getCachedVirtualProvider().models).toEqual(provider.models);
      expect(runtime.getRuntimeStatus()).toMatchObject({ modelsRefreshing: false, modelsSource: 'fallback',
        modelCount: Object.keys(provider.models).length, lastModelRefreshTimedOut: true,
        lastModelRefreshError: 'native_cursor_catalog_timeout' });
    } finally { await runtime.dispose(); }
  });

  test('native catalogs resolve the current account before TTL reuse and keep warming disabled', async () => {
    let key = 'owned-account-a';
    let allowed = true;
    const calls = [], scopes = [];
    const runtime = createCursorSdkRuntime({
      env: { CURSOR_API_KEY: 'forbidden-ambient-key' },
      readAuth: () => { throw new Error('Legacy auth must remain unread'); },
      resolveApiKey: async scope => {
        scopes.push(scope);
        if (!allowed) throw new Error('original caller revoked');
        return key;
      },
      ownedReadOnly: async (scope, action) => {
        expect(scope.directory).toBe('/owned/project');
        return action();
      },
      nativeWarming: false,
      modelDiscoveryTtlMs: 60_000,
      loadSdk: async () => ({ Cursor: { models: { list: async input => {
        calls.push(input.apiKey);
        return [{ id: input.apiKey, displayName: input.apiKey }];
      } } } }),
    });
    try {
      expect((await runtime.getVirtualProvider({ directory: '/owned/project' })).models[key]).toBeDefined();
      await runtime.getVirtualProvider({ directory: '/owned/project' });
      expect(calls).toEqual(['owned-account-a']);
      expect(scopes).toHaveLength(2);
      key = 'owned-account-b';
      const changed = await runtime.getVirtualProvider({ directory: '/owned/project' });
      expect(changed.models[key]).toBeDefined();
      expect(changed.models['owned-account-a']).toBeUndefined();
      expect(calls).toEqual(['owned-account-a', 'owned-account-b']);
      allowed = false;
      await expect(runtime.getVirtualProvider({ directory: '/owned/project' })).rejects.toThrow('original caller revoked');
      const reads = scopes.length;
      expect(await runtime.prewarm()).toMatchObject({ disabled: true, reason: 'native_warming_disabled' });
      expect(await runtime.prewarmSession({ sessionID: 'ses_owned', directory: '/owned/project' })).toMatchObject({ disabled: true, reason: 'native_warming_disabled' });
      expect(scopes).toHaveLength(reads);
      expect(runtime.getRuntimeStatus()).toMatchObject({ authSource: 'native-credential', authObservation: 'unknown', sdkAuthConfigured: false });
    } finally { await runtime.dispose(); }
  });

  test('native verification loads the SDK before selecting the current key and preserves the requested directory', async () => {
    const phases = [];
    const runtime = createCursorSdkRuntime({
      resolveApiKey: async scope => { phases.push(`key:${scope.kind}:${scope.directory}`); return 'owned-current-key'; },
      ownedReadOnly: async (scope, action) => { phases.push(`scope:${scope.kind}`); return action(); },
      nativeWarming: false,
      loadSdk: async () => { phases.push('sdk'); return { Cursor: {
        me: async input => { expect(input.apiKey).toBe('owned-current-key'); phases.push('me'); },
        models: { list: async input => { expect(input.apiKey).toBe('owned-current-key'); phases.push('models'); return []; } },
      } }; },
    });
    try {
      expect(await runtime.verifyConnection({ directory: '/owned/project' })).toMatchObject({ ok: true, configured: true });
      expect(phases).toEqual(['scope:verify', 'sdk', 'key:verify:/owned/project', 'me', 'scope:catalog', 'sdk', 'key:catalog:/owned/project', 'models']);
    } finally { await runtime.dispose(); }
  });
  test('explicit native verification completes beyond the quick public cap under the existing owned catalog deadline', async () => {
    const started=Promise.withResolvers(),release=Promise.withResolvers(),signals=[],diagnostics=[];
    let settled=false,lists=0;
    const runtime=createCursorSdkRuntime({nativeWarming:false,modelDiscoveryTimeoutMs:10,
      resolveApiKey:async()=> 'owned-verification-fixture',
      ownedReadOnly:async(scope,action)=>{if(scope.kind==='catalog')signals.push(scope.signal);return action();},
      recordDiagnostic:entry=>diagnostics.push(entry),
      loadSdk:async()=>({Cursor:{me:async()=>{},models:{list:async()=>{lists++;started.resolve();await release.promise;
        return [{id:'grok-4.6',variants:[{params:[{id:'effort',value:'medium'}]}]}];}}}}),
    });
    let pending;
    try{
      pending=runtime.verifyConnection({directory:'/owned/project'}).finally(()=>{settled=true;});
      await started.promise;await new Promise(resolve=>setTimeout(resolve,30));
      expect(signals).toHaveLength(1);expect(signals[0].aborted).toBe(false);expect(settled).toBe(false);
      release.resolve();expect(await pending).toMatchObject({ok:true,configured:true,modelCount:1,modelsSource:'sdk',lastModelRefreshTimedOut:false});
      expect(runtime.getCachedVirtualProvider().models['grok-4.6'].variants.medium).toBeDefined();
      expect(lists).toBe(1);expect(diagnostics.at(-1).payload.outcome).toBe('completed');
      // Ordinary public discovery still uses the caller's quick cap. Its
      // account switch cannot reuse this completed account's catalog.
    }finally{release.resolve();await pending;await runtime.dispose();}
  });

  test('maps fallback Composer fast rows to SDK fast parameter selections', async () => {
    const runtime = createRuntimeForModels([]);

    const provider = await runtime.getVirtualProvider();

    expect(provider.models['composer-2.5']?.options?.cursorSdkModel).toEqual({
      id: 'composer-2.5',
      params: [{ id: 'fast', value: 'false' }],
    });
    expect(provider.models['composer-2.5-fast']?.options?.cursorSdkModel).toEqual({
      id: 'composer-2.5',
      params: [{ id: 'fast', value: 'true' }],
    });
    expect(provider.models['composer-2']?.options?.cursorSdkModel).toEqual({
      id: 'composer-2',
      params: [{ id: 'fast', value: 'false' }],
    });
    expect(provider.models['composer-2-fast']?.options?.cursorSdkModel).toEqual({
      id: 'composer-2',
      params: [{ id: 'fast', value: 'true' }],
    });
  });

  test('returns cached provider immediately while SDK model discovery refreshes in the background', async () => {
    let resolveModels;
    const modelListPromise = new Promise((resolve) => {
      resolveModels = resolve;
    });
    const runtime = createCursorSdkRuntime({
      env: { CURSOR_API_KEY: 'test-key' },
      readAuth: () => ({}),
      writeAuth: () => {},
      loadSdk: async () => ({
        Cursor: {
          models: {
            list: async () => modelListPromise,
          },
        },
      }),
    });

    const cachedProvider = runtime.getCachedVirtualProvider();
    const refreshPromise = runtime.refreshVirtualProvider({ force: true, reason: 'test' });

    expect(cachedProvider.models['composer-2.5']).toBeDefined();
    expect(runtime.getRuntimeStatus().modelsRefreshing).toBe(true);

    resolveModels([{ id: 'composer-special', displayName: 'Composer Special' }]);
    await refreshPromise;

    expect(runtime.getCachedVirtualProvider().models['composer-special']).toMatchObject({
      id: 'composer-special',
      name: 'Composer Special',
    });
    expect(runtime.getRuntimeStatus()).toMatchObject({
      modelsRefreshing: false,
      modelsSource: 'sdk',
      lastModelRefreshReason: 'test',
    });
    expect(runtime.getRuntimeStatus().lastModelRefreshDurationMs).toBeGreaterThanOrEqual(0);
  });

  test('adds Composer 2.5 Fast compatibility row when SDK only returns Composer 2.5', async () => {
    const runtime = createRuntimeForModels([
      { id: 'composer-2.5', displayName: 'Composer 2.5' },
    ]);

    const provider = await runtime.getVirtualProvider();

    expect(provider.models['composer-2.5']).toMatchObject({
      id: 'composer-2.5',
      name: 'Composer 2.5',
      options: {
        cursorSdkModel: {
          id: 'composer-2.5',
          params: [{ id: 'fast', value: 'false' }],
        },
      },
    });
    expect(provider.models['composer-2.5-fast']).toMatchObject({
      id: 'composer-2.5-fast',
      name: 'Composer 2.5 Fast',
    });
  });

  test('does not overwrite SDK-returned Composer 2.5 Fast metadata', async () => {
    const runtime = createRuntimeForModels([
      { id: 'composer-2.5', displayName: 'Composer 2.5' },
      { id: 'composer-2.5-fast', displayName: 'Composer 2.5 Turbo' },
    ]);

    const provider = await runtime.getVirtualProvider();

    expect(provider.models['composer-2.5-fast']).toMatchObject({
      id: 'composer-2.5-fast',
      name: 'Composer 2.5 Turbo',
    });
  });

  test('exposes SDK thinking and fast parameters as selectable variants', async () => {
    const runtime = createRuntimeForModels([
      {
        id: 'claude-opus-4-7',
        displayName: 'Opus 4.7',
        parameters: [
          { id: 'thinking', values: [{ value: 'false' }, { value: 'true' }] },
          { id: 'effort', values: [{ value: 'low' }, { value: 'high' }] },
          { id: 'fast', values: [{ value: 'false' }, { value: 'true' }] },
        ],
        variants: [
          {
            displayName: 'Opus 4.7',
            isDefault: true,
            params: [
              { id: 'thinking', value: 'true' },
              { id: 'effort', value: 'high' },
              { id: 'fast', value: 'false' },
            ],
          },
          {
            displayName: 'Opus 4.7',
            params: [
              { id: 'thinking', value: 'true' },
              { id: 'effort', value: 'high' },
              { id: 'fast', value: 'true' },
            ],
          },
          {
            displayName: 'Opus 4.7',
            params: [
              { id: 'thinking', value: 'false' },
              { id: 'effort', value: 'low' },
              { id: 'fast', value: 'false' },
            ],
          },
        ],
      },
    ]);

    const provider = await runtime.getVirtualProvider();

    expect(provider.models['claude-opus-4-7']?.variants?.['thinking-high']?.cursorSdkModel).toEqual({
      id: 'claude-opus-4-7',
      params: [
        { id: 'thinking', value: 'true' },
        { id: 'effort', value: 'high' },
        { id: 'fast', value: 'false' },
      ],
    });
    expect(provider.models['claude-opus-4-7']?.variants?.low?.cursorSdkModel).toEqual({
      id: 'claude-opus-4-7',
      params: [
        { id: 'thinking', value: 'false' },
        { id: 'effort', value: 'low' },
        { id: 'fast', value: 'false' },
      ],
    });
    expect(provider.models['claude-opus-4-7-fast']?.variants?.['thinking-high']?.cursorSdkModel).toEqual({
      id: 'claude-opus-4-7',
      params: [
        { id: 'thinking', value: 'true' },
        { id: 'effort', value: 'high' },
        { id: 'fast', value: 'true' },
      ],
    });
  });

  test('keeps Max distinct and adds native Ultra only for Sol and Terra', async () => {
    const runtime = createRuntimeForModels([
      {
        id: 'gpt-5.6-sol',
        displayName: 'GPT-5.6 Sol',
        variants: [
          {
            displayName: 'GPT-5.6 Sol Max',
            params: [
              { id: 'reasoning', value: 'max' },
              { id: 'fast', value: 'false' },
            ],
          },
          {
            displayName: 'GPT-5.6 Sol Max Fast',
            params: [
              { id: 'reasoning', value: 'max' },
              { id: 'fast', value: 'true' },
            ],
          },
        ],
      },
      {
        id: 'gpt-5.6-terra',
        displayName: 'GPT-5.6 Terra',
        variants: [{
          displayName: 'GPT-5.6 Terra Max',
          params: [{ id: 'reasoning', value: 'max' }],
        }],
      },
      {
        id: 'gpt-5.6-luna',
        displayName: 'GPT-5.6 Luna',
        variants: [{
          displayName: 'GPT-5.6 Luna Max',
          params: [{ id: 'reasoning', value: 'max' }],
        }],
      },
      {
        id: 'gpt-5.6-pro',
        displayName: 'GPT-5.6 Pro',
        variants: [{
          displayName: 'GPT-5.6 Pro Max',
          params: [{ id: 'reasoning', value: 'max' }],
        }],
      },
      {
        id: 'claude-opus-4-7',
        displayName: 'Claude Opus 4.7',
        variants: [{
          displayName: 'Claude Opus 4.7 Max',
          params: [{ id: 'effort', value: 'max' }],
        }],
      },
    ]);

    const provider = await runtime.getVirtualProvider();

    expect(provider.models['gpt-5.6-sol']?.variants?.max?.cursorSdkModel).toEqual({
      id: 'gpt-5.6-sol',
      params: [
        { id: 'reasoning', value: 'max' },
        { id: 'fast', value: 'false' },
      ],
    });
    expect(provider.models['gpt-5.6-sol']?.variants?.ultra?.cursorSdkModel).toEqual({
      id: 'gpt-5.6-sol',
      params: [
        { id: 'reasoning', value: 'ultra' },
        { id: 'fast', value: 'false' },
      ],
    });
    expect(provider.models['gpt-5.6-sol-fast']?.variants?.ultra?.cursorSdkModel).toEqual({
      id: 'gpt-5.6-sol',
      params: [
        { id: 'reasoning', value: 'ultra' },
        { id: 'fast', value: 'true' },
      ],
    });
    expect(provider.models['gpt-5.6-terra']?.variants?.max?.cursorSdkModel).toEqual({
      id: 'gpt-5.6-terra',
      params: [{ id: 'reasoning', value: 'max' }],
    });
    expect(provider.models['gpt-5.6-terra']?.variants?.ultra?.cursorSdkModel).toEqual({
      id: 'gpt-5.6-terra',
      params: [{ id: 'reasoning', value: 'ultra' }],
    });
    expect(provider.models['gpt-5.6-luna']?.variants?.max).toBeDefined();
    expect(provider.models['gpt-5.6-luna']?.variants?.ultra).toBeUndefined();
    expect(provider.models['gpt-5.6-pro']?.variants?.max).toBeDefined();
    expect(provider.models['claude-opus-4-7']?.variants?.max).toBeDefined();
  });

  test('preserves literal Ultra as a distinct SDK effort variant', async () => {
    const runtime = createRuntimeForModels([{
      id: 'gpt-5.6-sol',
      displayName: 'GPT-5.6 Sol',
      variants: [
        {
          displayName: 'GPT-5.6 Sol Extra High',
          params: [{ id: 'reasoning', value: 'extra-high' }],
        },
        {
          displayName: 'GPT-5.6 Sol Ultra',
          params: [{ id: 'reasoning', value: 'ultra' }],
        },
      ],
    }]);

    const provider = await runtime.getVirtualProvider();

    expect(provider.models['gpt-5.6-sol']?.variants?.['extra-high']).toBeDefined();
    expect(provider.models['gpt-5.6-sol']?.variants?.ultra?.cursorSdkModel.params).toEqual([
      { id: 'reasoning', value: 'ultra' },
    ]);
  });

  test('preserves Ultra as a distinct SDK effort variant', async () => {
    const runtime = createRuntimeForModels([
      {
        id: 'gpt-5.6',
        displayName: 'GPT-5.6',
        parameters: [
          { id: 'thinking', values: [{ value: 'false' }, { value: 'true' }] },
          { id: 'effort', values: [{ value: 'extra-high' }, { value: 'ultra' }] },
        ],
        variants: [
          {
            displayName: 'GPT-5.6 Extra High',
            params: [
              { id: 'thinking', value: 'false' },
              { id: 'effort', value: 'extra-high' },
            ],
          },
          {
            displayName: 'GPT-5.6 Ultra',
            params: [
              { id: 'thinking', value: 'false' },
              { id: 'effort', value: 'ultra' },
            ],
          },
          {
            displayName: 'GPT-5.6 Thinking Ultra',
            params: [
              { id: 'thinking', value: 'true' },
              { id: 'effort', value: 'ultra' },
            ],
          },
        ],
      },
    ]);

    const provider = await runtime.getVirtualProvider();

    expect(provider.models['gpt-5.6']?.variants?.['extra-high']?.cursorSdkModel).toEqual({
      id: 'gpt-5.6',
      params: [
        { id: 'thinking', value: 'false' },
        { id: 'effort', value: 'extra-high' },
      ],
    });
    expect(provider.models['gpt-5.6']?.variants?.ultra?.cursorSdkModel).toEqual({
      id: 'gpt-5.6',
      params: [
        { id: 'thinking', value: 'false' },
        { id: 'effort', value: 'ultra' },
      ],
    });
    expect(provider.models['gpt-5.6']?.variants?.['thinking-ultra']?.cursorSdkModel).toEqual({
      id: 'gpt-5.6',
      params: [
        { id: 'thinking', value: 'true' },
        { id: 'effort', value: 'ultra' },
      ],
    });
  });

  test('maps base and fast Composer rows to SDK fast parameter selections', async () => {
    const runtime = createRuntimeForModels([
      {
        id: 'composer-2',
        displayName: 'Composer 2',
        parameters: [
          { id: 'fast', values: [{ value: 'false' }, { value: 'true' }] },
        ],
        variants: [
          {
            displayName: 'Composer 2',
            isDefault: true,
            params: [{ id: 'fast', value: 'true' }],
          },
          {
            displayName: 'Composer 2',
            params: [{ id: 'fast', value: 'false' }],
          },
        ],
      },
    ]);

    const provider = await runtime.getVirtualProvider();

    expect(provider.models['composer-2']?.options?.cursorSdkModel).toEqual({
      id: 'composer-2',
      params: [{ id: 'fast', value: 'false' }],
    });
    expect(provider.models['composer-2-fast']?.options?.cursorSdkModel).toEqual({
      id: 'composer-2',
      params: [{ id: 'fast', value: 'true' }],
    });
  });

  test('publishes validated SDK context magnitudes on default and variant records', async () => {
    const runtime = createRuntimeForModels([{
      id: 'gpt-5.5',
      displayName: 'GPT-5.5',
      variants: [
        {
          displayName: 'GPT-5.5 High',
          isDefault: true,
          params: [
            { id: 'effort', value: 'high' },
            { id: 'context', value: '1m' },
            { id: 'fast', value: 'false' },
          ],
        },
        {
          displayName: 'GPT-5.5 Low',
          params: [
            { id: 'effort', value: 'low' },
            { id: 'context', value: '200k' },
            { id: 'fast', value: 'false' },
          ],
        },
        {
          displayName: 'GPT-5.5 Fast',
          params: [
            { id: 'effort', value: 'high' },
            { id: 'context', value: '272k' },
            { id: 'fast', value: 'true' },
          ],
        },
      ],
    }]);

    const provider = await runtime.getVirtualProvider();

    expect(provider.models['gpt-5.5']?.limit).toEqual({ context: 1_000_000 });
    expect(provider.models['gpt-5.5']?.variants?.high?.limit).toEqual({ context: 1_000_000 });
    expect(provider.models['gpt-5.5']?.variants?.low?.limit).toEqual({ context: 200_000 });
    expect(provider.models['gpt-5.5-fast']?.limit).toEqual({ context: 272_000 });
    expect(provider.models['gpt-5.5-fast']?.variants?.high?.limit).toEqual({ context: 272_000 });
  });

  test('keeps malformed, zero, and absent SDK context parameters limit-free', async () => {
    const runtime = createRuntimeForModels([
      {
        id: 'malformed-context',
        variants: [{ params: [{ id: 'context', value: '200000' }] }],
      },
      {
        id: 'zero-context',
        variants: [{ params: [{ id: 'context', value: '0k' }] }],
      },
      { id: 'missing-context' },
    ]);

    const provider = await runtime.getVirtualProvider();

    expect(provider.models['malformed-context']?.limit).toBeUndefined();
    expect(provider.models['zero-context']?.limit).toBeUndefined();
    expect(provider.models['missing-context']?.limit).toBeUndefined();
  });

  test('uses full fallback list when SDK model discovery returns no models', async () => {
    const runtime = createRuntimeForModels([]);

    const provider = await runtime.getVirtualProvider();

    expect(provider.models['composer-2.5']).toBeDefined();
    expect(provider.models['composer-2.5-fast']).toBeDefined();
    expect(provider.models.auto).toBeDefined();
    expect(provider.models['composer-2.5']?.limit).toBeUndefined();
  });

  test('advertises Cursor model input modalities as text and image only', async () => {
    const runtime = createRuntimeForModels([
      { id: 'composer-2', displayName: 'Composer 2' },
    ]);

    const provider = await runtime.getVirtualProvider();

    expect(provider.models['composer-2']?.capabilities).toMatchObject({
      attachment: true,
      input: {
        text: true,
        image: true,
        pdf: false,
      },
      output: {
        text: true,
      },
    });
  });
});


describe('Composer 2.5 mode normalization', () => {
  for (const id of ['composer-2.5', 'composer-2.5-fast']) {
    for (const fast of [undefined, 'false', 'true']) {
      test(`normalizes ${id} with fast=${fast} and preserves discovered metadata`, async () => {
        const provider = await createRuntimeForModels([{
          id,
          displayName: 'Composer 2.5 Fast',
          description: 'Discovered description',
          variants: [{
            isDefault: true,
            params: [
              { id: 'context', value: '200k' },
              { id: 'effort', value: 'high' },
              ...(fast === undefined ? [] : [{ id: 'fast', value: fast }]),
            ],
          }],
        }]).getVirtualProvider();
        expect(Object.keys(provider.models).sort()).toEqual(['composer-2.5', 'composer-2.5-fast']);
        for (const enabled of [false, true]) {
          const model = provider.models[enabled ? 'composer-2.5-fast' : 'composer-2.5'];
          expect(model.name).toBe(enabled ? 'Composer 2.5 Fast' : 'Composer 2.5');
          expect(model.description).toBe('Discovered description');
          expect(model.limit).toEqual({ context: 200000 });
          expect(model.variants.high.limit).toEqual({ context: 200000 });
          const expected = { id: 'composer-2.5', params: [
            { id: 'context', value: '200k' },
            { id: 'effort', value: 'high' },
            { id: 'fast', value: String(enabled) },
          ] };
          expect(model.options.cursorSdkModel).toEqual(expected);
          expect(model.variants.high.cursorSdkModel).toEqual(expected);
        }
      });
    }
    test(`normalizes misleading labels without variant metadata for ${id}`, async () => {
      const provider = await createRuntimeForModels([{ id, displayName: 'Composer 2.5 Fast' }]).getVirtualProvider();
      expect(provider.models['composer-2.5'].name).toBe('Composer 2.5');
      for (const enabled of [false, true]) {
        expect(provider.models[enabled ? 'composer-2.5-fast' : 'composer-2.5'].options.cursorSdkModel).toEqual({
          id: 'composer-2.5', params: [{ id: 'fast', value: String(enabled) }],
        });
      }
    });
  }
});


test('Composer 2.5 sequential prompts switch SDK mode and restore saved Fast selection', async () => {
  const storageDir = await mkdtemp(path.join(os.tmpdir(), 'devryan-composer-mode-test-'));
  const selections = [];
  const makeAgent = () => ({
    agentId: 'fixture_composer_agent',
    send: async () => ({
      status: 'finished',
      wait: async () => ({ status: 'finished', result: 'done' }),
      conversation: async () => [{ type: 'agentConversationTurn', turn: { steps: [{type:'assistantMessage',message:{text:'done'}}] } }],
      async *stream() { yield { type: 'status', status: 'FINISHED' }; },
    }),
  });
  const createRuntime = () => createCursorSdkRuntime({
    storageDir, env: { CURSOR_API_KEY: 'fixture-key' }, readAuth: () => ({}), writeAuth: () => {},
    getWorkspaceDiff: async () => '',
    loadSdk: async () => ({
      Cursor: { models: { list: async () => [{
        id: 'composer-2.5-fast', displayName: 'Composer 2.5 Fast',
        variants: [{ params: [{ id: 'effort', value: 'high' }, { id: 'context', value: '200k' }] }],
      }] } },
      Agent: {
        create: async (options) => { selections.push(options.model); return makeAgent(); },
        resume: async (_id, options) => { selections.push(options.model); return makeAgent(); },
      },
    }),
  });
  let runtime = createRuntime();
  try {
    for (const [index, enabled] of [false, true, false, true, true].entries()) {
      if (index === 4) {
        await runtime.dispose();
        runtime = createRuntime();
      }
      await runtime.getVirtualProvider();
      await runtime.handlePromptAsync({ sessionID: 'ses_composer_modes', directory: storageDir, body: {
        model: { providerID: 'cursor-acp', modelID: enabled ? 'composer-2.5-fast' : 'composer-2.5' },
        variant: 'high', messageID: `msg_composer_${index}`, parts: [{ type: 'text', text: 'Fixture prompt' }],
      } });
      const deadline = Date.now() + 3000;
      while (selections.length <= index || runtime.getSessionStatus().ses_composer_modes?.type !== 'idle') {
        if (Date.now() > deadline) throw new Error('Composer fixture prompt did not finish');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(selections[index]).toEqual({ id: 'composer-2.5', params: [
        { id: 'effort', value: 'high' }, { id: 'context', value: '200k' }, { id: 'fast', value: String(enabled) },
      ] });
    }
  } finally {
    await runtime.dispose();
    await rm(storageDir, { recursive: true, force: true });
  }
});

test('native prompt selections refresh account-specific SDK parameters while preserving requested effort and directory', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'devryan-native-cursor-model-selection-'));
  let key = 'owned-a';const requests = [], selections = [], scopes = [];
  const runtime = createCursorSdkRuntime({
    storageDir: directory, env: { CURSOR_API_KEY: 'forbidden-ambient' },
    readAuth: () => { throw Error('Native selection must not read legacy auth'); },
    resolveApiKey: async scope => { expect(scope.directory).toBe(directory);return key; },
    ownedReadOnly: async (scope, action) => { expect(scope).toEqual({ kind: 'catalog', directory, signal: expect.any(AbortSignal) });scopes.push(scope);return action(); },
    nativeWarming: false, modelDiscoveryTtlMs: 60_000, getWorkspaceDiff: async () => '',
    loadSdk: async () => ({
      Cursor: { models: { list: async input => { requests.push(input.apiKey);return [{
        id: 'composer-2.5', variants: [{ params: [{ id: 'effort', value: 'high' }, { id: 'context', value: input.apiKey === 'owned-a' ? '200k' : '400k' }] }],
      }]; } } },
      Agent: { create: async input => {
        selections.push({ key: input.apiKey, model: input.model });return { agentId: `agent_${selections.length}`, send: async () => ({
          status: 'finished', wait: async () => ({ status: 'finished', result: 'done' }),
      conversation: async () => [{ type: 'agentConversationTurn', turn: { steps: [{type:'assistantMessage',message:{text:'done'}}] } }], async *stream() { yield { type: 'status', status: 'FINISHED' }; },
        }) };
      } },
    }),
  });
  try {
    await runtime.getVirtualProvider({ directory });
    for (const [index, account] of ['owned-a', 'owned-b'].entries()) {
      key = account;
      await runtime.handlePromptAsync({ sessionID: `ses_native_${index}`, directory, body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5-fast' }, variant: 'high', messageID: `msg_owned_${index}`, parts: [{ type: 'text', text: 'Owned prompt' }],
      } });
      const deadline = Date.now() + 3000;
      while (selections.length <= index || runtime.getSessionStatus()[`ses_native_${index}`]?.type !== 'idle') {
        if (Date.now() > deadline) throw Error('Native SDK selection fixture did not settle');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(selections[index]).toEqual({ key: account, model: { id: 'composer-2.5', params: [
        { id: 'effort', value: 'high' }, { id: 'context', value: index === 0 ? '200k' : '400k' }, { id: 'fast', value: 'true' },
      ] } });
    }
    expect(requests).toEqual(['owned-a', 'owned-b']);expect(scopes).toHaveLength(3);
  } finally { await runtime.dispose();await rm(directory, { recursive: true, force: true }); }
});

test('native exact effort failures and unknown catalogs never create an agent or helper worker', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'devryan-cursor-exact-unavailable-'));
  try {
    for (const mode of ['unsupported', 'empty', 'failed']) {
      let physicalCalls = 0;
      const runtime = createCursorSdkRuntime({
        storageDir: directory, env: {}, nativeWarming: false,
        resolveApiKey: async () => 'owned-fixture-account', ownedReadOnly: async (_scope, action) => action(),
        getWorkspaceDiff: async () => '', spawnImpl: () => { physicalCalls++; throw new Error('Helper dispatch must not start'); },
        loadSdk: async () => ({
          Cursor: { models: { list: async () => {
            if (mode === 'failed') throw new Error('Fixture catalog unavailable');
            return mode === 'empty' ? [] : [{ id: 'composer-2.5', variants: [{ params: [{ id: 'effort', value: 'medium' }] }] }];
          } } },
          Agent: { create: async () => { physicalCalls++; throw new Error('Agent dispatch must not start'); } },
        }),
      });
      try {
        const code = mode === 'failed' ? 'cursor_model_catalog_unavailable' : 'cursor_model_unavailable';
        const selection = Object.freeze({ modelID: 'composer-2.5', variant: 'high', directory });
        expect(await runtime.validateModelSelection(selection)).toBe(mode === 'failed' ? null : false);
        await expect(runtime.handlePromptAsync({ sessionID: 'ses_unavailable', directory, body: {
          model: { providerID: 'cursor-acp', modelID: selection.modelID }, variant: selection.variant,
          messageID: 'msg_unavailable', parts: [{ type: 'text', text: 'Must not execute' }],
        } })).rejects.toMatchObject({ code });
        await expect(runtime.generateText({ ...selection, text: 'Must not execute' })).rejects.toMatchObject({ code });
        expect(selection.variant).toBe('high');
        expect(physicalCalls).toBe(0);
        expect(await runtime.getSessionMessages('ses_unavailable')).toEqual([]);
      } finally { await runtime.dispose(); }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('changing the selected account between discovery and prompt dispatch refuses the frozen selection', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'devryan-cursor-selection-binding-'));
  let physicalCalls = 0;
  const runtime = createCursorSdkRuntime({
    storageDir: directory, env: {}, nativeWarming: false,
    resolveApiKey: async scope => scope.kind === 'catalog' ? 'owned-fixture-a' : 'owned-fixture-b',
    ownedReadOnly: async (_scope, action) => action(), getWorkspaceDiff: async () => '',
    loadSdk: async () => ({ Cursor: { models: { list: async () => [{ id: 'composer-2.5', variants: [{ params: [{ id: 'effort', value: 'high' }] }] }] } },
      Agent: { create: async () => { physicalCalls++; throw new Error('Changed account must not execute'); } } }),
  });
  try {
    await expect(runtime.handlePromptAsync({ sessionID: 'ses_changed', directory, body: {
      model: { providerID: 'cursor-acp', modelID: 'composer-2.5' }, variant: 'high', messageID: 'msg_changed',
      parts: [{ type: 'text', text: 'Must remain bound to the selected account' }],
    } })).rejects.toMatchObject({ code: 'cursor_model_account_changed' });
    expect(physicalCalls).toBe(0);
    expect(await runtime.getSessionMessages('ses_changed')).toEqual([]);
  } finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('reasoning_effort preserves exact thinking efforts and rejects missing effort aliases', async () => {
  const params = effort => [{ id: 'thinking', value: 'true' }, { id: 'reasoning_effort', value: effort }, { id: 'context', value: '200k' }];
  const runtime = createRuntimeForModels([{ id: 'claude-haiku-5.5', variants: ['high', 'low', 'medium'].map(effort => ({ params: params(effort) })) }]);
  try {
    const record = (await runtime.getVirtualProvider()).models['claude-haiku-5.5'];
    expect(Object.keys(record.variants).sort()).toEqual(['thinking-high', 'thinking-low', 'thinking-medium']);
    expect(record.variants['thinking-medium'].cursorSdkModel.params).toEqual(params('medium'));
    expect(record.variants['thinking-medium'].limit.context).toBe(200000);
    expect(record.options.cursorSdkModel.params).toEqual(params('medium'));
    expect(await runtime.validateModelSelection({ modelID: record.id, variant: 'medium' })).toBe(true);
    expect(await runtime.validateModelSelection({ modelID: record.id, variant: 'thinking-medium' })).toBe(true);
    expect(await runtime.validateModelSelection({ modelID: record.id, variant: 'thinking-unknown' })).toBe(false);
    expect(await runtime.validateModelSelection({ modelID: record.id, variant: 'max' })).toBe(false);
  } finally { await runtime.dispose(); }
  const unavailable = createRuntimeForModels([{ id: 'claude-haiku-5.5', variants: [{ params: params('high') }] }]);
  try {
    expect(await unavailable.validateModelSelection({ modelID: 'claude-haiku-5.5', variant: 'medium' })).toBe(false);
    expect(await unavailable.validateModelSelection({ modelID: 'claude-haiku-5.5', variant: 'thinking-medium' })).toBe(false);
  } finally { await unavailable.dispose(); }
});


test('native ultra replaces reasoning_effort without adding a conflicting effort parameter', async () => {
  const runtime = createRuntimeForModels([{ id: 'gpt-5.6-sol', variants: [{ params: [{ id: 'reasoning_effort', value: 'max' }, { id: 'context', value: '400k' }] }] }]);
  try {
    const record = (await runtime.getVirtualProvider()).models['gpt-5.6-sol'];
    expect(record.variants.ultra.cursorSdkModel.params).toEqual([{ id: 'reasoning_effort', value: 'ultra' }, { id: 'context', value: '400k' }]);
  } finally { await runtime.dispose(); }
});


test('selection diagnostics expose bounded codes while authority failures retain a safe refusal', async () => {
  for (const code of ['native_web_principal_required', 'unsafe_secret:credential', `native_${'a'.repeat(81)}`]) {
    const failures = [];
    const runtime = createCursorSdkRuntime({ env: {}, nativeWarming: false,
      resolveApiKey: async () => { throw new Error('Credential reads forbidden'); },
      ownedReadOnly: async () => { throw Object.assign(new Error('Sensitive provider details'), { code }); },
    });
    try {
      const pending = runtime.validateModelSelection({ modelID: 'chosen', onFailure: failure => { failures.push(failure); throw new Error('Diagnostic sink failed'); } });
      if (code === 'native_web_principal_required') await expect(pending).rejects.toMatchObject({ code, message: code });
      else expect(await pending).toBe(null);
      expect(failures).toEqual([{ reason: code === 'native_web_principal_required' ? code : 'cursor_model_catalog_unavailable' }]);
    } finally { await runtime.dispose(); }
  }
});


test('terminal persistence diagnostics locate held ownership without changing busy settlement or exposing content', async () => {
  const storageDir = await mkdtemp(path.join(os.tmpdir(), 'devryan-cursor-terminal-diagnostics-'));
  const held = Promise.withResolvers(), entered = Promise.withResolvers(), diagnostics = [];
  const agent = { agentId: 'fixture_agent', send: async () => ({ status: 'finished',
    wait: async () => ({ status: 'finished', result: 'private provider response' }),
      conversation: async () => [{ type: 'agentConversationTurn', turn: { steps: [{type:'assistantMessage',message:{text:'private provider response'}}] } }],
    async *stream() { yield { type: 'status', status: 'FINISHED' }; } }) };
  const runtime = createCursorSdkRuntime({ storageDir, env: { CURSOR_API_KEY: 'private fixture key' }, readAuth: () => ({}), writeAuth: () => {},
    getWorkspaceDiff: async () => '', loadSdk: async () => ({ Cursor: { models: { list: async () => [{ id: 'fixture_model' }] } },
      Agent: { create: async () => agent, resume: async () => agent } }),
    recordDiagnostic: entry => { diagnostics.push(entry); throw Error('observer cannot change persistence'); },
    onPersistRecord: async ({ record }) => { if (record.info.role === 'assistant' && record.info.time.completed) { entered.resolve(); await held.promise; } },
  });
  try {
    await runtime.handlePromptAsync({ sessionID: 'ses_terminal_diagnostic', directory: storageDir, body: {
      messageID: 'msg_terminal_diagnostic', model: { providerID: 'cursor-acp', modelID: 'fixture_model' }, parts: [{ type: 'text', text: 'private caller prompt' }],
    } });
    await entered.promise;
    expect(runtime.getRuntimeStatus().activeRuns).toBe(0);
    expect(runtime.getSessionStatus().ses_terminal_diagnostic.type).toBe('busy');
    expect(diagnostics.filter(entry => entry.event === 'cursor_persistence').map(entry => entry.payload.phase)).toEqual(['sdk_queued', 'sdk_started', 'sdk_owner_started']);
    held.resolve(); await runtime.abortAndWait('ses_terminal_diagnostic');
    expect(runtime.getSessionStatus().ses_terminal_diagnostic.type).toBe('idle');
    expect(diagnostics.filter(entry => entry.event === 'cursor_persistence').map(entry => entry.payload.phase)).toEqual(['sdk_queued', 'sdk_started', 'sdk_owner_started', 'sdk_owner_returned', 'sdk_stored', 'sdk_settled']);
    for (const entry of diagnostics.filter(entry => entry.event === 'cursor_persistence')) {
      expect(entry).toMatchObject({ type: 'lifecycle', event: 'cursor_persistence', sessionID: 'ses_terminal_diagnostic', directory: storageDir,
        payload: { userMessageID: 'msg_terminal_diagnostic', assistantMessageID: 'msg_terminal_diagnostic_assistant' } });
      expect(Object.keys(entry.payload).sort()).toEqual(['assistantMessageID', 'elapsedMs', 'phase', 'startedAt', 'userMessageID']);
      expect(Number.isFinite(entry.payload.elapsedMs) && entry.payload.elapsedMs >= 0).toBe(true);
    }
    expect(JSON.stringify(diagnostics)).not.toMatch(/private|observer/);
  } finally { held.resolve(); await runtime.dispose(); await rm(storageDir, { recursive: true, force: true }); }
});


test('slow owned persistence coalesces streaming snapshots while preserving tools and the final barrier', async () => {
  const storageDir = await mkdtemp(path.join(os.tmpdir(), 'devryan-cursor-persist-backpressure-'));
  const ownerEntered = Promise.withResolvers(), ownerRelease = Promise.withResolvers(), providerDone = Promise.withResolvers(), finalQueued = Promise.withResolvers();
  const saved = []; let inFlightRecord, first = true;
  const text = Array.from({ length: 30 }, (_, i) => `chunk-${i} `).join('');
  const agent = { agentId: 'fixture_backpressure', send: async () => ({ status: 'running',
    wait: async () => { await providerDone.promise; return { status: 'finished', result: text }; },
    conversation: async () => [{type:'agentConversationTurn',turn:{steps:[{type:'assistantMessage',message:{text}},{type:'toolCall'}]}}],
    async *stream() {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'chunk-0 ' }] } };
      await ownerEntered.promise;
      for (let i = 1; i < 30; i++) yield { type: 'assistant', message: { content: [{ type: 'text', text: `chunk-${i} ` }] } };
      yield { type: 'tool_call', call_id: 'fixture_read', name: 'read', status: 'running', args: { path: 'fixture.txt' } };
      yield { type: 'tool_call', call_id: 'fixture_read', name: 'read', status: 'completed', result: 'retained tool output' };
      providerDone.resolve(); yield { type: 'status', status: 'FINISHED' };
    },
  }) };
  const runtime = createCursorSdkRuntime({ storageDir, env: { CURSOR_API_KEY: 'synthetic key' }, readAuth: () => ({}), writeAuth: () => {},
    getWorkspaceDiff: async () => '', loadSdk: async () => ({ Cursor: { models: { list: async () => [{ id: 'fixture_model' }] } },
      Agent: { create: async () => agent, resume: async () => agent } }),
    recordDiagnostic: entry => { if (entry.event === 'cursor_persistence' && entry.payload.phase === 'sdk_queued') finalQueued.resolve(); },
    onPersistRecord: async ({ record }) => {
      if (record.info.role === 'assistant' && record.parts.length && first) {
        first = false; inFlightRecord = record; ownerEntered.resolve(); await ownerRelease.promise;
      }
      saved.push(structuredClone(record));
    },
  });
  try {
    await runtime.handlePromptAsync({ sessionID: 'ses_backpressure', directory: storageDir, body: {
      messageID: 'msg_backpressure', model: { providerID: 'cursor-acp', modelID: 'fixture_model' }, parts: [{ type: 'text', text: 'Inspect fixture' }],
    } });
    await finalQueued.promise;
    expect(inFlightRecord.info.time.completed).toBeUndefined();
    expect(inFlightRecord.parts.map(part => part.text).filter(Boolean).join('')).toBe('chunk-0 ');
    expect(runtime.getSessionStatus().ses_backpressure.type).toBe('busy');
    ownerRelease.resolve(); await runtime.abortAndWait('ses_backpressure');
    const writes = saved.filter(record => record.info.role === 'assistant' && record.parts.length);
    expect(writes.length).toBeLessThanOrEqual(3);
    expect(writes.filter(record => record.info.time.completed)).toHaveLength(1);
    const records = await runtime.getSessionMessages('ses_backpressure');
    expect(records.map(record => record.info.role)).toEqual(['user', 'assistant']);
    const final = records[1]; expect(final.info.finish).toBe('stop'); expect(final.info.time.completed).toBeNumber();
    expect(final.parts.filter(part => part.type === 'text').map(part => part.text).join('')).toBe(text);
    expect(final.parts.find(part => part.type === 'tool')).toMatchObject({ state: { status: 'completed', output: 'retained tool output' } });
    expect(runtime.getSessionStatus().ses_backpressure.type).toBe('idle');
  } finally { ownerRelease.resolve(); providerDone.resolve(); await runtime.abortAndWait('ses_backpressure'); await runtime.dispose(); await rm(storageDir, { recursive: true, force: true }); }
});
