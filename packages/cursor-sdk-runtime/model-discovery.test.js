import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { createCursorSdkRuntime } from './index.js';

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

describe('Cursor SDK model discovery', () => {
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
  const cacheRoot = path.resolve(import.meta.dir, '../../.cache');
  await mkdir(cacheRoot, { recursive: true });
  const storageDir = await mkdtemp(path.join(cacheRoot, 'composer-mode-test-'));
  const selections = [];
  const makeAgent = () => ({
    agentId: 'fixture_composer_agent',
    send: async () => ({
      status: 'finished',
      wait: async () => ({ status: 'finished', result: 'done' }),
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
  const root = path.resolve(import.meta.dir, '../../.cache');await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'native-cursor-model-selection-'));
  let key = 'owned-a';const requests = [], selections = [], scopes = [];
  const runtime = createCursorSdkRuntime({
    storageDir: directory, env: { CURSOR_API_KEY: 'forbidden-ambient' },
    readAuth: () => { throw Error('Native selection must not read legacy auth'); },
    resolveApiKey: async scope => { expect(scope.directory).toBe(directory);return key; },
    ownedReadOnly: async (scope, action) => { expect(scope).toEqual({ kind: 'catalog', directory });scopes.push(scope);return action(); },
    nativeWarming: false, modelDiscoveryTtlMs: 60_000, getWorkspaceDiff: async () => '',
    loadSdk: async () => ({
      Cursor: { models: { list: async input => { requests.push(input.apiKey);return [{
        id: 'composer-2.5', variants: [{ params: [{ id: 'effort', value: 'high' }, { id: 'context', value: input.apiKey === 'owned-a' ? '200k' : '400k' }] }],
      }]; } } },
      Agent: { create: async input => {
        selections.push({ key: input.apiKey, model: input.model });return { agentId: `agent_${selections.length}`, send: async () => ({
          status: 'finished', wait: async () => ({ status: 'finished', result: 'done' }), async *stream() { yield { type: 'status', status: 'FINISHED' }; },
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
  const cacheRoot = path.resolve(import.meta.dir, '../../.cache');
  await mkdir(cacheRoot, { recursive: true });
  const directory = await mkdtemp(path.join(cacheRoot, 'cursor-exact-unavailable-'));
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
  const cacheRoot = path.resolve(import.meta.dir, '../../.cache');
  await mkdir(cacheRoot, { recursive: true });
  const directory = await mkdtemp(path.join(cacheRoot, 'cursor-selection-binding-'));
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
