import { afterEach, describe, expect, it, vi } from 'vitest';

import { setVsCodeHarnessRuntime, takeVsCodeHarnessRuntime } from './harness-runtime-access';

const mocks = vi.hoisted(() => ({
  auth: {} as Record<string, Record<string, unknown>>,
}));

vi.mock('./opencodeAuth', () => ({
  readAuthFile: vi.fn(() => mocks.auth),
}));

const { handleProxyBridgeMessage } = await import('./bridge-proxy-runtime');

const deps = {
  tryHandleLocalFsProxy: vi.fn(async () => null),
  buildUnavailableApiResponse: vi.fn(() => ({ status: 503, headers: {}, bodyBase64: '' })),
  sanitizeForwardHeaders: vi.fn(() => ({})),
  collectHeaders: vi.fn(() => ({ 'content-type': 'application/json' })),
  base64EncodeUtf8: (text: string) => Buffer.from(text).toString('base64'),
  getCachedCursorProvider: vi.fn(() => null as Record<string, unknown> | null),
  refreshCursorProvider: vi.fn(),
  getXaiPromptToolOverrides: vi.fn(() => null as Record<string, false> | null),
  supportsXaiProvider: vi.fn((providerID: unknown) => providerID === 'xai'),
  refreshXaiProviderPayload: vi.fn(async () => undefined),
  refreshXaiToolModel: vi.fn(async () => undefined),
  scheduleSessionTitle: vi.fn(async () => true),
  scheduleSessionTitleRecovery: vi.fn(async () => true),
};

const context = {
  manager: {
    getApiUrl: () => 'http://opencode.test',
    getOpenCodeAuthHeaders: () => ({}),
  },
  postMessage: vi.fn(),
};

afterEach(() => {
  takeVsCodeHarnessRuntime();
  mocks.auth = {};
  vi.restoreAllMocks();
  deps.getCachedCursorProvider.mockReset();
  deps.getCachedCursorProvider.mockReturnValue(null);
  deps.refreshCursorProvider.mockReset();
  deps.getXaiPromptToolOverrides.mockReset();
  deps.getXaiPromptToolOverrides.mockReturnValue(null);
  deps.supportsXaiProvider.mockClear();
  deps.refreshXaiProviderPayload.mockReset();
  deps.refreshXaiToolModel.mockReset();
  deps.scheduleSessionTitle.mockReset();
  deps.scheduleSessionTitle.mockResolvedValue(true);
  deps.scheduleSessionTitleRecovery.mockReset();
  deps.scheduleSessionTitleRecovery.mockResolvedValue(true);
  context.postMessage.mockReset();
});

describe('VS Code prompt admission proxy', () => {
  it('schedules bounded placeholder recovery after a successful session list', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json([
      { id: 'ses_1', title: 'Untitled Session' },
    ]));

    const result = await handleProxyBridgeMessage({
      id: 'session-list-recovery',
      type: 'api:proxy',
      payload: { method: 'GET', path: '/session?directory=%2Frepo' },
    }, context as never, deps);

    expect((result?.data as { status: number }).status).toBe(200);
    expect(deps.scheduleSessionTitleRecovery).toHaveBeenCalledWith('/repo');
  });

  it('returns the exact context-mode recovery block without forwarding or recording a duplicate prompt', async () => {
    const recordPrompt = vi.fn();
    setVsCodeHarnessRuntime({
      getPromptAdmissionBlock: () => ({
        name: 'context_mode_recovery',
        code: 'CONTEXT_MODE_RECOVERY_PENDING',
        error: 'Context-mode recovery is pending',
        retryAfterSeconds: 1,
      }),
      recordPrompt,
    } as never);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const response = await handleProxyBridgeMessage({
      id: 'prompt-recovery-pending',
      type: 'api:proxy',
      payload: {
        method: 'POST',
        path: '/session/ses_1/prompt_async?directory=%2Frepo',
        bodyBase64: Buffer.from(JSON.stringify({ messageID: 'msg_client_1', parts: [] })).toString('base64'),
      },
    }, context as never, deps);

    const data = response?.data as { status: number; headers: Record<string, string>; bodyBase64: string };
    expect(data.status).toBe(503);
    expect(data.headers['retry-after']).toBe('1');
    expect(JSON.parse(Buffer.from(data.bodyBase64, 'base64').toString('utf8'))).toEqual({
      error: 'Context-mode recovery is pending',
      code: 'CONTEXT_MODE_RECOVERY_PENDING',
    });
    expect(recordPrompt).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('merges cached Grok duplicate-tool overrides before forwarding', async () => {
    const recordPrompt = vi.fn();
    const recordPromptAccepted = vi.fn();
    setVsCodeHarnessRuntime({
      getPromptAdmissionBlock: () => null,
      recordPrompt,
      lifecycle: { recordPromptAccepted },
    } as never);
    deps.getXaiPromptToolOverrides.mockReturnValue({
      mcp__context_mode__ctx_search: false,
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));

    const response = await handleProxyBridgeMessage({
      id: 'prompt-grok-cached-tools',
      type: 'api:proxy',
      payload: {
        method: 'POST',
        path: '/session/ses_1/prompt_async?directory=%2Frepo',
        bodyBase64: Buffer.from(JSON.stringify({
          model: { providerID: 'xai', modelID: 'grok-4.6' },
          messageID: 'msg_client_1',
          tools: { unique_tool: true },
          parts: [],
        })).toString('base64'),
      },
    }, context as never, deps);

    expect((response?.data as { status: number }).status).toBe(204);
    const forwarded = JSON.parse((fetchSpy.mock.calls[0]?.[1]?.body as Buffer).toString('utf8'));
    expect(forwarded.tools).toEqual({
      unique_tool: true,
      mcp__context_mode__ctx_search: false,
    });
    expect(deps.refreshXaiToolModel).not.toHaveBeenCalled();
    expect(recordPromptAccepted).toHaveBeenCalledTimes(1);
  });

  it.each(
    ['builder', 'orchestrator'].flatMap((agent) =>
      [false, true].flatMap((planMode) => [
        ['openai', 'gpt-5.6-sol'],
        ['xai', 'grok-4.6'],
        ['opencode', 'nemotron-3.5-lightning-free'],
      ].map(([providerID, modelID]) => ({ agent, planMode, providerID, modelID }))),
    ),
  )('schedules title parity for $agent $providerID prompts (plan=$planMode)', async ({
    agent,
    planMode,
    providerID,
    modelID,
  }) => {
    setVsCodeHarnessRuntime({
      getPromptAdmissionBlock: () => null,
      recordPrompt: vi.fn(),
      lifecycle: { recordPromptAccepted: vi.fn() },
    } as never);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const visibleText = `repair ${providerID} ${agent} title behavior`;
    const parts = planMode
      ? [
          { type: 'text', text: 'User has requested to enter plan mode.', synthetic: true },
          { type: 'text', text: visibleText },
        ]
      : [{ type: 'text', text: visibleText }];

    await handleProxyBridgeMessage({
      id: `prompt-${providerID}-${agent}-${planMode}`,
      type: 'api:proxy',
      payload: {
        method: 'POST',
        path: '/session/ses_title/prompt_async?directory=%2Frepo',
        bodyBase64: Buffer.from(JSON.stringify({
          model: { providerID, modelID },
          agent,
          variant: providerID === 'openai' ? 'medium' : undefined,
          messageID: 'msg_client_1',
          parts,
        })).toString('base64'),
      },
    }, context as never, deps);

    expect(deps.scheduleSessionTitle).toHaveBeenCalledWith({
      sessionID: 'ses_title',
      directory: '/repo',
      text: visibleText,
      providerID,
      modelID,
      variant: providerID === 'openai' ? 'medium' : undefined,
    });
  });
});

describe('VS Code provider catalog proxy', () => {
  it('merges cached Cursor metadata and refreshes it without blocking managed catalogs', async () => {
    mocks.auth = { 'cursor-acp': { type: 'api', key: 'secret-cursor-key' } };
    deps.getCachedCursorProvider.mockReturnValue({
      id: 'cursor-acp',
      name: 'Cursor',
      models: {
        'gpt-5.5-fast': {
          id: 'gpt-5.5-fast',
          name: 'GPT-5.5 Fast',
          limit: { context: 272_000 },
        },
      },
    });
    deps.refreshCursorProvider.mockImplementation(() => new Promise(() => {}));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      providers: [
        { id: 'openai', models: { 'gpt-5.5': { id: 'gpt-5.5' } } },
        { id: 'cursor-acp', models: { stale: { id: 'stale' } } },
      ],
      default: { openai: 'gpt-5.5' },
    }));

    const response = await handleProxyBridgeMessage({
      id: 'providers-cursor',
      type: 'api:proxy',
      payload: { method: 'GET', path: '/config/providers?directory=%2Frepo' },
    }, context as never, deps);

    const encoded = (response?.data as { bodyBase64: string }).bodyBase64;
    const body = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    expect(body.providers.filter((provider: { id?: string }) => provider.id === 'cursor-acp')).toEqual([
      expect.objectContaining({
        models: {
          'gpt-5.5-fast': expect.objectContaining({ limit: { context: 272_000 } }),
        },
      }),
    ]);
    expect(deps.refreshCursorProvider).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(body)).not.toContain('secret-cursor-key');
  });

  it('publishes a catalog reload after a cold background refresh changes Cursor metadata', async () => {
    let cachedProvider: Record<string, unknown> = {
      id: 'cursor-acp',
      name: 'Cursor',
      models: { 'gpt-5.5': { id: 'gpt-5.5', name: 'GPT-5.5' } },
    };
    let finishRefresh: (() => void) | undefined;
    deps.getCachedCursorProvider.mockImplementation(() => cachedProvider);
    deps.refreshCursorProvider.mockImplementation(() => new Promise<void>((resolve) => {
      finishRefresh = () => {
        cachedProvider = {
          id: 'cursor-acp',
          name: 'Cursor',
          models: {
            'gpt-5.5': {
              id: 'gpt-5.5',
              name: 'GPT-5.5',
              limit: { context: 1_000_000 },
            },
          },
        };
        resolve();
      };
    }));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      providers: [],
      default: {},
    }));

    const response = await handleProxyBridgeMessage({
      id: 'providers-cold-cache',
      type: 'api:proxy',
      payload: { method: 'GET', path: '/config/providers?directory=%2Frepo' },
    }, context as never, deps);

    const encoded = (response?.data as { bodyBase64: string }).bodyBase64;
    const body = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    expect(body.providers[0].models['gpt-5.5'].limit).toBeUndefined();
    expect(context.postMessage).not.toHaveBeenCalled();

    finishRefresh?.();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(context.postMessage).toHaveBeenCalledWith({
      type: 'command',
      command: 'providersChanged',
    });
  });

  it('keeps only real GPT-5.6 family rows selectable for OAuth', async () => {
    mocks.auth = { openai: { type: 'oauth', access: 'secret-token' } };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      providers: [{
        id: 'openai',
        models: {
          'gpt-5.6': { id: 'gpt-5.6' },
          'gpt-5.6-pro': { id: 'gpt-5.6-pro' },
          'gpt-5.6-sol': { id: 'gpt-5.6-sol' },
          'gpt-5.6-terra': { id: 'gpt-5.6-terra' },
          'gpt-5.6-luna': {
            id: 'gpt-5.6-luna',
            variants: { none: {}, low: {}, medium: {}, high: {}, xhigh: {} },
          },
          'gpt-5.6-luna-fast': {
            id: 'gpt-5.6-luna-fast',
            variants: { none: {}, low: {}, medium: {}, high: {}, xhigh: {} },
          },
        },
      }],
      default: { openai: 'gpt-5.6' },
    }));

    const response = await handleProxyBridgeMessage({
      id: 'providers',
      type: 'api:proxy',
      payload: { method: 'GET', path: '/config/providers?directory=%2Frepo' },
    }, context as never, deps);

    const encoded = (response?.data as { bodyBase64: string }).bodyBase64;
    const body = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    expect(body.providers[0]).toMatchObject({
      authType: 'oauth',
      models: {
        'gpt-5.6': {
          id: 'gpt-5.6',
          available: false,
          unavailableReason: 'auth_type_unsupported',
          requiredAuthType: 'api',
        },
        'gpt-5.6-luna': {
          id: 'gpt-5.6-luna',
          variants: { none: {}, low: {}, medium: {}, high: {}, xhigh: {} },
        },
        'gpt-5.6-luna-fast': {
          id: 'gpt-5.6-luna-fast',
          variants: { none: {}, low: {}, medium: {}, high: {}, xhigh: {} },
        },
        'gpt-5.6-sol': {
          id: 'gpt-5.6-sol',
        },
        'gpt-5.6-terra': {
          id: 'gpt-5.6-terra',
        },
        'gpt-5.6-pro': {
          available: false,
          unavailableReason: 'auth_type_unsupported',
          requiredAuthType: 'api',
        },
      },
    });
    expect(body.providers[0].models['gpt-5.6-luna'].available).not.toBe(false);
    expect(body.providers[0].models['gpt-5.6-luna-fast'].available).not.toBe(false);
    expect(body.providers[0].models['gpt-5.6-sol'].available).not.toBe(false);
    expect(body.providers[0].models['gpt-5.6-terra'].available).not.toBe(false);
    expect(JSON.stringify(body)).not.toContain('secret-token');
  });

  it('leaves external OpenCode provider catalogs unchanged', async () => {
    mocks.auth = { openai: { type: 'oauth', access: 'secret-token' } };
    const upstream = {
      providers: [{
        id: 'openai',
        models: {
          'gpt-5.6': { id: 'gpt-5.6' },
          'gpt-5.6-sol': { id: 'gpt-5.6-sol' },
        },
      }],
      default: { openai: 'gpt-5.6' },
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(upstream));

    const response = await handleProxyBridgeMessage({
      id: 'providers-external',
      type: 'api:proxy',
      payload: { method: 'GET', path: '/config/providers?directory=%2Frepo' },
    }, {
      manager: {
        ...context.manager,
        getDebugInfo: () => ({ mode: 'external' }),
      },
    } as never, deps);

    const encoded = (response?.data as { bodyBase64: string }).bodyBase64;
    const body = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    expect(body).toEqual(upstream);
    expect(deps.getCachedCursorProvider).not.toHaveBeenCalled();
    expect(deps.refreshCursorProvider).not.toHaveBeenCalled();
  });

  it('leaves API-key OpenAI catalogs provider-driven', async () => {
    mocks.auth = { openai: { type: 'api', key: 'secret-api-key' } };
    const upstream = {
      providers: [{
        id: 'openai',
        models: {
          'gpt-5.6': { id: 'gpt-5.6' },
          'gpt-5.6-sol-pro': { id: 'gpt-5.6-sol-pro' },
        },
      }],
      default: { openai: 'gpt-5.6' },
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(upstream));

    const response = await handleProxyBridgeMessage({
      id: 'providers-api-key',
      type: 'api:proxy',
      payload: { method: 'GET', path: '/config/providers?directory=%2Frepo' },
    }, context as never, deps);

    const encoded = (response?.data as { bodyBase64: string }).bodyBase64;
    const body = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    expect(body.providers[0]).toMatchObject({
      id: 'openai',
      authType: 'api',
      models: upstream.providers[0].models,
    });
    expect(JSON.stringify(body)).not.toContain('secret-api-key');
  });
});
