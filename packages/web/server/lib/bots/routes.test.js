import { describe, expect, it, vi } from 'vitest';

import { SupabaseRequestError } from '../multi-user/supabase-client.js';
import { registerBotRoutes, resolveBotCapabilities } from './routes.js';

const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const CHANNEL_ID = 'c0000000-0000-4000-8000-000000000001';
const OBJECT_ID = 'd0000000-0000-4000-8000-000000000001';
const SOURCE_ID = 'd0000000-0000-4000-8000-000000000002';
const VERSION_ID = 'd0000000-0000-4000-8000-000000000003';
const SCAN_ID = 'd0000000-0000-4000-8000-000000000004';
const ROUTINE_ID = 'd0000000-0000-4000-8000-000000000005';
const SKILL_BINDING_ID = 'd0000000-0000-4000-8000-000000000006';
const MCP_BINDING_ID = 'd0000000-0000-4000-8000-000000000007';
const REVISION_ID = 'd0000000-0000-4000-8000-000000000008';
const RUN_ID = 'e0000000-0000-4000-8000-000000000001';
const ACTION_ID = 'f0000000-0000-4000-8000-000000000001';
const SHARED_FILE_ID = 'f0000000-0000-4000-8000-000000000002';
const USER_ID = 'a0000000-0000-4000-8000-000000000001';
const TIMESTAMP = '2026-08-23T12:00:00.000Z';

const host = (state, extras = {}) => ({
  owner: 'electron',
  getStatus: vi.fn(async () => ({ state, code: null, issues: [], ...extras })),
});

const createResponse = () => ({
  statusCode: 200,
  payload: null,
  headers: {},
  chunks: [],
  writableEnded: false,
  destroyed: false,
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.payload = payload; return this; },
  send(payload) { this.payload = payload; return this; },
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
  flushHeaders() {},
  write(value) { this.chunks.push(Buffer.from(value)); return true; },
  end() {
    this.writableEnded = true;
    if (this.chunks.length > 0) this.payload = Buffer.concat(this.chunks);
    return this;
  },
});

const createHarness = (overrides = {}) => {
  const handlers = new Map();
  const middleware = [];
  const registrations = [];
  const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map((method) => [
    method,
    (route, ...routeHandlers) => {
      const key = `${method.toUpperCase()} ${route}`;
      registrations.push(key);
      handlers.set(key, routeHandlers.at(-1));
    },
  ]));
  app.use = (paths, handler) => {
    middleware.push({ paths, handler });
  };
  const blobStore = {
    uploadPrivate: vi.fn(async () => ({
      id: OBJECT_ID,
      bot_id: BOT_ID,
      channel_id: CHANNEL_ID,
      visibility: 'private',
      content_type: 'text/plain',
      ciphertext_hash: 'a'.repeat(64),
      ciphertext_size: 5,
      provenance: {},
      created_by: USER_ID,
      created_at: '2026-08-22T10:00:00.000Z',
      updated_at: '2026-08-22T10:00:00.000Z',
      deleted_at: null,
      storage_object_name: 'must-not-be-public',
      wrapped_key: { ciphertext: 'must-not-be-public' },
    })),
    download: vi.fn(),
    deleteObject: vi.fn(),
    publishToLibrary: vi.fn(),
    ...overrides.blobStore,
  };
  const channels = {
    getOrCreateOwnerChannel: vi.fn(async () => ({ id: CHANNEL_ID, botId: BOT_ID })),
    listMessages: vi.fn(async () => ({ messages: [], nextCursor: null })),
    ...overrides.channels,
  };
  const memoryRuntime = {
    listForManager: vi.fn(async () => ({ memories: [], nextCursor: null })),
    getForManager: vi.fn(async () => ({ memory: { id: OBJECT_ID }, versions: [], sources: [] })),
    editMemory: vi.fn(async () => ({ memory: { id: OBJECT_ID } })),
    mergeMemories: vi.fn(async () => ({ memory: { id: OBJECT_ID }, conflicts: [] })),
    tombstoneMemory: vi.fn(async () => ({ memory: { id: OBJECT_ID, tombstonedAt: TIMESTAMP } })),
    restoreMemory: vi.fn(async () => ({ memory: { id: OBJECT_ID, tombstonedAt: null } })),
    rebuildIndex: vi.fn(async () => ({ documentCount: 2 })),
    deleteChannel: vi.fn(async () => ({
      deleted: true,
      notice: 'Shared learning survives channel deletion; private channel memory is removed.',
    })),
    ...overrides.memoryRuntime,
  };
  const libraryRuntime = {
    listForManager: vi.fn(async () => ({ sources: [], nextCursor: null })),
    listComputerFiles: vi.fn(async () => ({
      available: false, state: 'offline', path: '', entries: [], truncated: false,
    })),
    scanImport: vi.fn(async () => ({ scanId: SCAN_ID, sourceId: SOURCE_ID })),
    scanRefresh: vi.fn(async () => ({ scanId: SCAN_ID, sourceId: SOURCE_ID })),
    publishScan: vi.fn(async () => ({ version: { id: VERSION_ID } })),
    getVersionForManager: vi.fn(async () => ({ version: { id: VERSION_ID } })),
    rebuildIndex: vi.fn(async () => ({ documentCount: 3 })),
    ...overrides.libraryRuntime,
  };
  const routineRuntime = {
    listForManager: vi.fn(async () => ({ routines: [], nextCursor: null })),
    draft: vi.fn(async () => ({ contract: { version: 1 }, requiresManagerReview: true })),
    createDraft: vi.fn(async () => ({ routine: { id: ROUTINE_ID, status: 'draft' } })),
    updateDraft: vi.fn(async () => ({ routine: { id: ROUTINE_ID, status: 'draft' } })),
    transition: vi.fn(async () => ({ routine: { id: ROUTINE_ID, status: 'active' } })),
    ...overrides.routineRuntime,
  };
  const artifactService = {
    publishPrivate: vi.fn(async () => ({
      object: { id: 'd0000000-0000-4000-8000-000000000099', visibility: 'library' },
      version: { id: VERSION_ID },
    })),
    ...overrides.artifactService,
  };
  const sharedFileService = {
    listChannel: vi.fn(async () => ({
      sharedFiles: [{
        id: SHARED_FILE_ID,
        botId: BOT_ID,
        channelId: CHANNEL_ID,
        filename: 'fixture.txt',
        computerPath: `/workspace/Shared/${CHANNEL_ID}/${OBJECT_ID}/fixture.txt`,
        copyState: 'ready',
      }],
      nextCursor: null,
    })),
    retry: vi.fn(async () => ({
      id: SHARED_FILE_ID,
      botId: BOT_ID,
      channelId: CHANNEL_ID,
      filename: 'fixture.txt',
      copyState: 'ready',
    })),
    ...overrides.sharedFileService,
  };
  const dispatcher = {
    enqueueMessage: vi.fn(async () => ({
      created: true,
      message: { id: OBJECT_ID },
      run: { id: RUN_ID, state: 'queued' },
    })),
    prewarmChannel: vi.fn(async () => ({
      state: 'ready',
      leaseId: SHARED_FILE_ID,
      revisionId: REVISION_ID,
      expiresAt: TIMESTAMP,
      reason: null,
    })),
    releasePrewarm: vi.fn(async () => ({ released: true })),
    getRunStatus: vi.fn(async () => ({ id: RUN_ID, state: 'running' })),
    retryRun: vi.fn(async () => ({ id: RUN_ID, state: 'queued', retryable: false })),
    cancelRun: vi.fn(async () => ({ id: RUN_ID, state: 'cancelled' })),
    ...overrides.dispatcher,
  };
  const approvalService = {
    listPending: vi.fn(async () => ({ actions: [{ id: ACTION_ID }], nextCursor: null })),
    decide: vi.fn(async () => ({
      action: { id: ACTION_ID, state: 'approved' },
      approval: { decision: 'approved' },
    })),
    ...overrides.approvalService,
  };
  const browserService = {
    status: vi.fn(async () => ({ botId: BOT_ID, state: 'running', control: null })),
    takeControl: vi.fn(async () => ({ leaseId: 'lease-1', actorId: USER_ID })),
    heartbeatControl: vi.fn(async () => ({ leaseId: 'lease-1', actorId: USER_ID })),
    returnControl: vi.fn(async () => null),
    humanCommand: vi.fn(async () => ({ ok: true })),
    startComputerView: vi.fn(async () => ({
      view: {
        id: 'view_opaque',
        botId: BOT_ID,
        channelId: CHANNEL_ID,
        streamUrl: `/api/bots/${BOT_ID}/computer/view/view_opaque/stream`,
        startedAt: TIMESTAMP,
      },
    })),
    openComputerView: vi.fn(async () => new Response('frame', {
      headers: { 'content-type': 'multipart/x-mixed-replace; boundary=test' },
    })),
    stopComputerView: vi.fn(async () => ({ stopped: true })),
    ...overrides.browserService,
  };
  const evidenceService = {
    download: vi.fn(async () => ({ bytes: Buffer.from('png') })),
    ...overrides.evidenceService,
  };
  const actionGateway = {
    getAction: vi.fn(async () => ({
      action: { id: ACTION_ID, botId: BOT_ID, state: 'unknown' },
      receipt: null,
    })),
    reconcile: vi.fn(async () => ({
      action: { id: ACTION_ID, state: 'reconciled' },
      replayed: false,
    })),
    ...overrides.actionGateway,
  };
  const recoveryBundle = {
    exportBundle: vi.fn(async () => ({
      bot: { id: BOT_ID, name: 'Release Sentinel' },
      bundle: Buffer.from('encrypted-recovery-bundle'),
    })),
    restoreBundle: vi.fn(async () => ({
      restored: true,
      bot: { id: BOT_ID, name: 'Release Sentinel' },
      mode: 'empty',
      result: { objectCount: 1 },
    })),
    ...overrides.recoveryBundle,
  };
  const purgeRuntime = {
    get: vi.fn(async () => null),
    start: vi.fn(async () => ({ id: 'purge-1', complete: false, state: 'partial' })),
    startComplete: vi.fn(async () => ({
      id: 'purge-complete-1', complete: true, state: 'completed', botDeleted: true,
    })),
    retry: vi.fn(async () => ({ id: 'purge-1', complete: true, state: 'completed' })),
    ...overrides.purgeRuntime,
  };
  const capabilityBindings = {
    list: vi.fn(async () => ({
      revision: { id: REVISION_ID, updatedAt: TIMESTAMP },
      skills: [],
      mcp: [],
    })),
    attachSkill: vi.fn(async () => ({
      revision: { id: REVISION_ID },
      binding: { id: SKILL_BINDING_ID },
    })),
    detachSkill: vi.fn(async () => ({ revision: { id: REVISION_ID } })),
    attachMcp: vi.fn(async () => ({
      revision: { id: REVISION_ID },
      binding: { id: MCP_BINDING_ID },
    })),
    detachMcp: vi.fn(async () => ({ revision: { id: REVISION_ID } })),
    rotateMcpCredential: vi.fn(async () => ({
      revision: { id: REVISION_ID },
      binding: { id: MCP_BINDING_ID, credentialState: 'connected' },
    })),
    ...overrides.capabilityBindings,
  };
  const management = {
    canCreateBot: vi.fn(() => false),
    listCatalog: vi.fn(async () => ({ bots: [], canCreateBot: false })),
    getDetail: vi.fn(async () => ({ bot: { id: BOT_ID }, canManage: true })),
    updateProfile: vi.fn(async () => ({ bot: { id: BOT_ID }, avatarCleanupRequired: false })),
    downloadAvatar: vi.fn(async () => ({
      object: { content_type: 'image/png' },
      bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    })),
    modelOptions: vi.fn(async () => ({ available: true, providers: [] })),
    publishRevision: vi.fn(async () => ({
      bot: { id: BOT_ID, activeRevisionId: REVISION_ID },
      revision: { id: REVISION_ID, activatedAt: TIMESTAMP },
      health: { ready: true, gates: [] },
      futureRunsOnly: true,
    })),
    createCredentialConnection: vi.fn(async () => ({
      credential: { id: OBJECT_ID, maskedIdentifier: '••••5678', version: 1 },
    })),
    createOAuthCredentialConnection: vi.fn(async () => ({
      credential: { id: OBJECT_ID, provider: 'openai', kind: 'oauth', version: 1 },
    })),
    rotateCredentialConnection: vi.fn(async () => ({
      credential: { id: OBJECT_ID, maskedIdentifier: '••••4321', version: 2 },
    })),
    listEvalCases: vi.fn(async () => []),
    saveEvalCase: vi.fn(),
    runEvalCase: vi.fn(),
    ...overrides.management,
  };
  const environmentSecrets = {
    list: vi.fn(async () => ({ environmentSecrets: [] })),
    put: vi.fn(async (_principal, botId, name) => ({
      environmentSecret: { id: OBJECT_ID, botId, name, status: 'active', updatedAt: TIMESTAMP },
    })),
    remove: vi.fn(async (_principal, _botId, name) => ({ deleted: true, name })),
    ...overrides.environmentSecrets,
  };
  registerBotRoutes(app, {
    store: { available: true, ...overrides.store },
    management,
    blobStore,
    channels,
    memoryRuntime,
    routineRuntime,
    libraryRuntime,
    artifactService,
    sharedFileService,
    dispatcher,
    eventStream: overrides.eventStream || { writeSse: vi.fn(async () => {}) },
    approvalService,
    browserService,
    evidenceService,
    actionGateway,
    capabilityBindings,
    environmentSecrets,
    recoveryBundle,
    purgeRuntime,
    botHost: overrides.botHost || host('healthy'),
    encryption: { getKey: () => Buffer.alloc(32) },
    getSchemaFailure: overrides.getSchemaFailure || (() => null),
    getControlPlaneFailure: overrides.getControlPlaneFailure || (() => null),
    getExecutionFailure: overrides.getExecutionFailure || (() => null),
    resolveCapabilities: overrides.resolveCapabilities || null,
    getRuntimeServices: overrides.getRuntimeServices || null,
  });
  return {
    blobStore,
    channels,
    memoryRuntime,
    routineRuntime,
    libraryRuntime,
    artifactService,
    sharedFileService,
    dispatcher,
    approvalService,
    browserService,
    evidenceService,
    actionGateway,
    capabilityBindings,
    environmentSecrets,
    management,
    recoveryBundle,
    purgeRuntime,
    registrations,
    middleware,
    async invoke(method, route, request = {}) {
      const response = createResponse();
      await handlers.get(`${method} ${route}`)({
        body: {},
        params: {},
        headers: {},
        query: {},
        principal: { id: USER_ID, role: 'developer', scope: 'managed' },
        ...request,
      }, response);
      return response;
    },
  };
};

describe('Production Bots capabilities and routes', () => {
  it('registers the static Bot event stream before the dynamic Bot detail path', () => {
    const harness = createHarness();
    expect(harness.registrations.indexOf('GET /api/bots/events')).toBeLessThan(
      harness.registrations.indexOf('GET /api/bots/:botId'),
    );
    expect(harness.registrations.indexOf('POST /api/bots/recovery/restore')).toBeLessThan(
      harness.registrations.indexOf('GET /api/bots/:botId'),
    );
  });

  it('uses reconciled runtime services after routes have already been registered', async () => {
    let liveLibraryRuntime = null;
    const harness = createHarness({
      getExecutionFailure: () => ({ code: 'bot_runtime_docker_unavailable' }),
      getRuntimeServices: () => ({ libraryRuntime: liveLibraryRuntime }),
    });

    const unavailableLibrary = await harness.invoke('GET', '/api/bots/:botId/library-sources', {
      params: { botId: BOT_ID },
    });
    expect(unavailableLibrary.payload).toMatchObject({
      available: false,
      state: 'runtime_unavailable',
      code: 'bot_runtime_docker_unavailable',
      sources: [],
      nextCursor: null,
    });

    const unavailable = await harness.invoke('GET', '/api/bots/:botId/computer-files', {
      params: { botId: BOT_ID },
    });
    expect(unavailable.payload).toMatchObject({
      available: false,
      state: 'runtime_unavailable',
      code: 'bot_runtime_docker_unavailable',
    });

    liveLibraryRuntime = {
      listForManager: vi.fn(async () => ({ sources: [], nextCursor: null })),
      listComputerFiles: vi.fn(async () => ({
        available: true,
        state: 'ready',
        path: '',
        entries: [],
        truncated: false,
      })),
    };
    const readyLibrary = await harness.invoke('GET', '/api/bots/:botId/library-sources', {
      params: { botId: BOT_ID },
    });
    expect(readyLibrary.payload).toEqual({ sources: [], nextCursor: null });
    expect(liveLibraryRuntime.listForManager).toHaveBeenCalledTimes(1);

    const ready = await harness.invoke('GET', '/api/bots/:botId/computer-files', {
      params: { botId: BOT_ID },
    });
    expect(ready.payload).toMatchObject({ available: true, state: 'ready' });
    expect(liveLibraryRuntime.listComputerFiles).toHaveBeenCalledTimes(1);
  });

  it('keeps Bot environment-secret values write-only across manager routes', async () => {
    const harness = createHarness();
    const write = await harness.invoke('PUT', '/api/bots/:botId/environment-secrets/:name', {
      params: { botId: BOT_ID, name: 'SERVICE_TOKEN' },
      body: { value: 'must-never-return', expectedUpdatedAt: null },
    });
    expect(write.statusCode).toBe(200);
    expect(JSON.stringify(write.payload)).not.toContain('must-never-return');
    expect(harness.environmentSecrets.put).toHaveBeenCalledWith(
      expect.objectContaining({ id: USER_ID }),
      BOT_ID,
      'SERVICE_TOKEN',
      { value: 'must-never-return', expectedUpdatedAt: null },
    );

    const listed = await harness.invoke('GET', '/api/bots/:botId/environment-secrets', {
      params: { botId: BOT_ID },
    });
    expect(listed.payload).toEqual({ environmentSecrets: [] });

    const removed = await harness.invoke('DELETE', '/api/bots/:botId/environment-secrets/:name', {
      params: { botId: BOT_ID, name: 'SERVICE_TOKEN' },
      body: { expectedUpdatedAt: TIMESTAMP },
    });
    expect(removed.payload).toEqual({ deleted: true, name: 'SERVICE_TOKEN' });
  });

  it('rejects client attempts to select or widen the computer-files scope', async () => {
    const harness = createHarness();
    const response = await harness.invoke('GET', '/api/bots/:botId/computer-files', {
      params: { botId: BOT_ID },
      query: { scope: 'container' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.payload).toMatchObject({ code: 'bot_request_invalid' });
    expect(harness.libraryRuntime.listComputerFiles).not.toHaveBeenCalled();
  });

  it('rejects unsafe computer-files paths before consulting runtime availability', async () => {
    const harness = createHarness();
    const paths = [
      '/workspace',
      '../workspace',
      'workspace/../data',
      'workspace\\Shared',
      'workspace\0Shared',
      `${Array.from({ length: 33 }, () => 'nested').join('/')}`,
      'x'.repeat(1_025),
    ];
    for (const path of paths) {
      const response = await harness.invoke('GET', '/api/bots/:botId/computer-files', {
        params: { botId: BOT_ID },
        query: { path },
      });
      expect(response.statusCode).toBe(400);
      expect(response.payload).toMatchObject({ code: 'bot_request_invalid' });
    }
    expect(harness.libraryRuntime.listComputerFiles).not.toHaveBeenCalled();
  });

  it('keeps encrypted recovery bytes in binary routes and exposes resumable purge status', async () => {
    const harness = createHarness();
    const exported = await harness.invoke('POST', '/api/bots/:botId/recovery/export', {
      params: { botId: BOT_ID },
      body: { passphrase: 'correct horse battery staple' },
    });
    expect(exported.payload).toEqual(Buffer.from('encrypted-recovery-bundle'));
    expect(exported.headers['content-type']).toBe('application/vnd.devryan.bot-recovery');
    expect(exported.headers['content-disposition']).toContain('DevRyan-Bot-Recovery');

    const restored = await harness.invoke('POST', '/api/bots/recovery/restore', {
      body: Buffer.from('encrypted-recovery-bundle'),
      headers: {
        'x-devryan-recovery-passphrase': 'correct horse battery staple',
        'x-devryan-recovery-mode': 'empty',
      },
    });
    expect(restored.payload).toMatchObject({ restored: true, mode: 'empty' });
    expect(harness.recoveryBundle.restoreBundle).toHaveBeenCalledWith(
      expect.objectContaining({ id: USER_ID }),
      expect.objectContaining({ mode: 'empty', bundle: expect.any(Buffer) }),
    );

    const partial = await harness.invoke('POST', '/api/bots/:botId/purge', {
      params: { botId: BOT_ID },
      body: { resourceIds: ['objects'] },
    });
    expect(partial.statusCode).toBe(202);
    const completed = await harness.invoke('POST', '/api/bots/:botId/purge/retry', {
      params: { botId: BOT_ID },
      body: { resourceIds: ['objects'] },
    });
    expect(completed.statusCode).toBe(200);

    const deleted = await harness.invoke('POST', '/api/bots/:botId/purge/complete', {
      params: { botId: BOT_ID },
      body: {
        typedName: 'Release Sentinel',
        confirm: true,
        expectedUpdatedAt: TIMESTAMP,
      },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.payload).toMatchObject({ purge: { botDeleted: true } });
    expect(harness.purgeRuntime.startComplete).toHaveBeenCalledWith(
      expect.objectContaining({ id: USER_ID }),
      BOT_ID,
      {
        typedName: 'Release Sentinel',
        confirm: true,
        expectedUpdatedAt: TIMESTAMP,
      },
    );
  });

  it('distinguishes every setup and runtime state needed by the UI', async () => {
    const encryption = { getKey: () => Buffer.alloc(32) };
    await expect(resolveBotCapabilities({ hasSupabase: false, botHost: host('healthy'), encryption }))
      .resolves.toMatchObject({ state: 'supabase_unavailable', available: false });
    await expect(resolveBotCapabilities({
      hasSupabase: true,
      botHost: { owner: 'web' },
      encryption,
    })).resolves.toMatchObject({ state: 'unsupported_host', owner: 'web' });
    const executionHost = host('healthy', { canRepair: false });
    await expect(resolveBotCapabilities({
      hasSupabase: true,
      botHost: executionHost,
      encryption,
      executionFailure: { code: 'bot_gateway_bind_invalid' },
    })).resolves.toMatchObject({
      state: 'runtime_degraded',
      code: 'bot_gateway_bind_invalid',
      runtime: { state: 'healthy' },
    });
    expect(executionHost.getStatus).toHaveBeenCalledTimes(1);
    await expect(resolveBotCapabilities({
      hasSupabase: true,
      botHost: host('docker_unavailable'),
      encryption,
      executionFailure: { code: 'bot_run_recovery_failed' },
    })).resolves.toMatchObject({
      state: 'docker_stopped',
      code: 'bot_runtime_docker_unavailable',
      runtime: { state: 'docker_unavailable' },
    });
    await expect(resolveBotCapabilities({
      hasSupabase: true,
      botHost: host('healthy'),
      encryption: { getKey: () => { throw Object.assign(new Error('sealed'), { code: 'bot_key_locked' }); } },
    })).resolves.toMatchObject({ state: 'encryption_unavailable', code: 'bot_key_locked' });

    const cases = [
      ['docker_not_installed', {}, 'docker_not_installed'],
      ['docker_unavailable', {}, 'docker_stopped'],
      ['setup_required', {}, 'setup_required'],
      ['runtime_update_required', {}, 'image_update_available'],
      ['healthy', { indexState: 'rebuilding' }, 'index_rebuilding'],
      ['healthy', {}, 'healthy'],
    ];
    for (const [runtimeState, extras, expectedState] of cases) {
      const result = await resolveBotCapabilities({
        hasSupabase: true,
        botHost: host(runtimeState, extras),
        encryption,
      });
      expect(result.state).toBe(expectedState);
      expect(result.available).toBe(expectedState === 'healthy');
    }
  });

  it('reports a stale Bot schema before inspecting Docker', async () => {
    const botHost = host('healthy');
    const harness = createHarness({
      botHost,
      getSchemaFailure: () => ({
        code: 'bot_schema_migration_required',
        requiredMigration: '20260824120000',
      }),
    });
    const response = await harness.invoke('GET', '/api/bots/capabilities');
    expect(response.payload).toMatchObject({
      available: false,
      state: 'migration_required',
      code: 'bot_schema_migration_required',
      requiredMigration: '20260824120000',
    });
    expect(botHost.getStatus).not.toHaveBeenCalled();
  });

  it('projects authoritative creation access and routes write-only API-key create and rotate requests', async () => {
    const harness = createHarness({
      management: { canCreateBot: vi.fn(() => true) },
    });
    const capabilities = await harness.invoke('GET', '/api/bots/capabilities');
    expect(capabilities.payload).toMatchObject({ available: true, canCreateBot: true });

    const createRequest = {
      provider: 'openai',
      label: 'Production OpenAI',
      kind: 'api_key',
      credentialScope: 'user',
      ownerUserId: USER_ID,
      secret: 'sk-production-12345678',
    };
    const created = await harness.invoke('POST', '/api/bots/:botId/credentials', {
      params: { botId: BOT_ID },
      body: createRequest,
    });
    expect(created.statusCode).toBe(201);
    expect(created.payload).toMatchObject({
      credential: { maskedIdentifier: '••••5678', version: 1 },
    });
    expect(JSON.stringify(created.payload)).not.toContain(createRequest.secret);
    expect(harness.management.createCredentialConnection).toHaveBeenCalledWith(
      expect.objectContaining({ id: USER_ID }), BOT_ID, createRequest,
    );

    const oauthRequest = {
      provider: 'openai',
      connectionId: 'host:openai',
      label: 'Existing OpenAI account',
      kind: 'oauth',
      credentialScope: 'user',
      ownerUserId: USER_ID,
    };
    const oauth = await harness.invoke('POST', '/api/bots/:botId/credentials', {
      params: { botId: BOT_ID },
      body: oauthRequest,
    });
    expect(oauth.statusCode).toBe(201);
    expect(oauth.payload).toMatchObject({ credential: { kind: 'oauth', provider: 'openai' } });
    expect(harness.management.createOAuthCredentialConnection).toHaveBeenCalledWith(
      expect.objectContaining({ id: USER_ID }), BOT_ID, oauthRequest,
    );

    const rotateRequest = { secret: 'sk-replacement-87654321', expectedUpdatedAt: TIMESTAMP };
    const rotated = await harness.invoke(
      'POST',
      '/api/bots/:botId/credentials/:credentialId/rotate',
      { params: { botId: BOT_ID, credentialId: OBJECT_ID }, body: rotateRequest },
    );
    expect(rotated.payload).toMatchObject({
      credential: { maskedIdentifier: '••••4321', version: 2 },
    });
    expect(harness.management.rotateCredentialConnection).toHaveBeenCalledWith(
      expect.objectContaining({ id: USER_ID }), BOT_ID, OBJECT_ID, rotateRequest,
    );
  });

  it('keeps historical evaluations readable while deprecating Test Lab mutations', async () => {
    const harness = createHarness({
      management: { listEvalCases: vi.fn(async () => [{ id: OBJECT_ID }]) },
    });
    const listed = await harness.invoke('GET', '/api/bots/:botId/eval-cases', {
      params: { botId: BOT_ID },
    });
    expect(listed.payload).toEqual({ evalCases: [{ id: OBJECT_ID }] });

    const saved = await harness.invoke('POST', '/api/bots/:botId/eval-cases', {
      params: { botId: BOT_ID },
      body: { name: 'Legacy test' },
    });
    const run = await harness.invoke('POST', '/api/bots/:botId/eval-cases/:evalCaseId/run', {
      params: { botId: BOT_ID, evalCaseId: OBJECT_ID },
      body: { mode: 'simulation' },
    });
    expect(saved).toMatchObject({
      statusCode: 410,
      payload: { code: 'bot_evaluations_deprecated' },
    });
    expect(run).toMatchObject({
      statusCode: 410,
      payload: { code: 'bot_evaluations_deprecated' },
    });
    expect(harness.management.saveEvalCase).not.toHaveBeenCalled();
    expect(harness.management.runEvalCase).not.toHaveBeenCalled();
  });

  it('blocks every Bot mutation at the route boundary when the schema marker is stale', async () => {
    const harness = createHarness({
      getSchemaFailure: () => ({
        status: 503,
        error: 'Database migration required',
        code: 'bot_schema_migration_required',
        requiredMigration: '20260824120000',
      }),
    });
    const response = createResponse();
    const next = vi.fn();

    await harness.middleware[0].handler({}, response, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(503);
    expect(response.payload).toEqual({
      error: 'Database migration required',
      code: 'bot_schema_migration_required',
      requiredMigration: '20260824120000',
    });
    expect(harness.middleware[0].paths).toEqual([
      '/api/bots',
      '/api/bot-actions',
      '/api/bot-channels',
      '/api/bot-runs',
    ]);
  });

  it('routes revision-bound Skill and MCP assignment operations without widening payloads', async () => {
    const harness = createHarness();
    const principal = expect.objectContaining({ id: USER_ID });

    const listed = await harness.invoke(
      'GET',
      '/api/bots/:botId/revisions/:revisionId/capability-bindings',
      {
        params: { botId: BOT_ID, revisionId: REVISION_ID },
        query: { directory: '/workspace/project', checkLive: 'true' },
      },
    );
    expect(listed.payload).toMatchObject({ revision: { id: REVISION_ID } });
    expect(harness.capabilityBindings.list).toHaveBeenCalledWith(
      principal,
      BOT_ID,
      REVISION_ID,
      { directory: '/workspace/project', checkLive: true },
    );

    const expectedUpdatedAt = TIMESTAMP;
    const skillRequest = { skillName: 'review-queue', expectedUpdatedAt };
    const attachedSkill = await harness.invoke(
      'POST',
      '/api/bots/:botId/revisions/:revisionId/skill-bindings',
      { params: { botId: BOT_ID, revisionId: REVISION_ID }, body: skillRequest },
    );
    expect(attachedSkill.statusCode).toBe(201);
    expect(harness.capabilityBindings.attachSkill).toHaveBeenCalledWith(
      principal, BOT_ID, REVISION_ID, skillRequest,
    );
    await harness.invoke(
      'DELETE',
      '/api/bots/:botId/revisions/:revisionId/skill-bindings/:bindingId',
      {
        params: { botId: BOT_ID, revisionId: REVISION_ID, bindingId: SKILL_BINDING_ID },
        body: { expectedUpdatedAt },
      },
    );
    expect(harness.capabilityBindings.detachSkill).toHaveBeenCalledWith(
      principal, BOT_ID, REVISION_ID, SKILL_BINDING_ID, { expectedUpdatedAt },
    );

    const mcpRequest = {
      serverName: 'Inventory',
      directory: '/workspace',
      expectedUpdatedAt,
      confirmSharedCredential: true,
    };
    const attachedMcp = await harness.invoke(
      'POST',
      '/api/bots/:botId/revisions/:revisionId/mcp-bindings',
      { params: { botId: BOT_ID, revisionId: REVISION_ID }, body: mcpRequest },
    );
    expect(attachedMcp.statusCode).toBe(201);
    expect(harness.capabilityBindings.attachMcp).toHaveBeenCalledWith(
      principal, BOT_ID, REVISION_ID, mcpRequest,
    );
    await harness.invoke(
      'DELETE',
      '/api/bots/:botId/revisions/:revisionId/mcp-bindings/:bindingId',
      {
        params: { botId: BOT_ID, revisionId: REVISION_ID, bindingId: MCP_BINDING_ID },
        body: { expectedUpdatedAt },
      },
    );
    expect(harness.capabilityBindings.detachMcp).toHaveBeenCalledWith(
      principal, BOT_ID, REVISION_ID, MCP_BINDING_ID, { expectedUpdatedAt },
    );

    const credentialRequest = {
      serverName: 'Inventory',
      directory: '/workspace',
      expectedUpdatedAt,
      confirmSharedCredential: true,
    };
    await harness.invoke(
      'POST',
      '/api/bots/:botId/revisions/:revisionId/mcp-bindings/:bindingId/credential',
      {
        params: { botId: BOT_ID, revisionId: REVISION_ID, bindingId: MCP_BINDING_ID },
        body: credentialRequest,
      },
    );
    expect(harness.capabilityBindings.rotateMcpCredential).toHaveBeenCalledWith(
      principal, BOT_ID, REVISION_ID, MCP_BINDING_ID, credentialRequest,
    );
  });

  it('routes durable profile avatars, sanitized model options, and exact Draft publishing', async () => {
    const harness = createHarness();
    const avatarBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const profileRequest = {
      name: 'Release Sentinel',
      title: 'Release Operations',
      summary: 'Coordinates releases.',
      expectedUpdatedAt: TIMESTAMP,
      avatar: { contentType: 'image/png', dataBase64: avatarBytes.toString('base64') },
    };
    const profile = await harness.invoke('PATCH', '/api/bots/:botId/profile', {
      params: { botId: BOT_ID }, body: profileRequest,
    });
    expect(profile.payload).toMatchObject({ bot: { id: BOT_ID } });
    expect(harness.management.updateProfile).toHaveBeenCalledWith(
      expect.objectContaining({ id: USER_ID }),
      BOT_ID,
      expect.objectContaining({
        name: profileRequest.name,
        title: profileRequest.title,
        summary: profileRequest.summary,
        expectedUpdatedAt: TIMESTAMP,
        avatar: expect.objectContaining({ contentType: 'image/png', bytes: expect.any(Buffer) }),
      }),
    );
    expect(harness.management.updateProfile.mock.calls[0][2].avatar.bytes).toHaveLength(
      avatarBytes.byteLength,
    );

    const avatar = await harness.invoke('GET', '/api/bots/:botId/avatar', {
      params: { botId: BOT_ID },
    });
    expect(avatar.payload).toEqual(avatarBytes);
    expect(avatar.headers['content-type']).toBe('image/png');
    expect(avatar.headers['cache-control']).toBe('no-store, private');

    await harness.invoke('GET', '/api/bots/:botId/model-options', { params: { botId: BOT_ID } });
    expect(harness.management.modelOptions).toHaveBeenCalledWith(
      expect.objectContaining({ id: USER_ID }), BOT_ID,
    );

    const publishAvatar = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const publishRequest = {
      contract: { version: 1 },
      expectedUpdatedAt: TIMESTAMP,
      profile: {
        name: 'Release Sentinel',
        title: 'Release Operations',
        summary: 'Coordinates releases.',
        expectedUpdatedAt: TIMESTAMP,
        avatar: { contentType: 'image/png', dataBase64: publishAvatar.toString('base64') },
      },
    };
    const published = await harness.invoke(
      'POST',
      '/api/bots/:botId/revisions/:revisionId/publish',
      { params: { botId: BOT_ID, revisionId: REVISION_ID }, body: publishRequest },
    );
    expect(published.payload).toMatchObject({ futureRunsOnly: true });
    expect(harness.management.publishRevision).toHaveBeenCalledWith(
      expect.objectContaining({ id: USER_ID }),
      BOT_ID,
      REVISION_ID,
      expect.objectContaining({
        contract: publishRequest.contract,
        expectedUpdatedAt: TIMESTAMP,
        profile: expect.objectContaining({
          name: 'Release Sentinel',
          avatar: expect.objectContaining({
            contentType: 'image/png',
            bytes: expect.any(Buffer),
          }),
        }),
      }),
    );
    const routedAvatar = harness.management.publishRevision.mock.calls[0][3].profile.avatar.bytes;
    expect(routedAvatar).toHaveLength(publishAvatar.byteLength);
    expect([...routedAvatar].every((byte) => byte === 0)).toBe(true);
  });

  it('validates uploads and returns only public encrypted-object metadata', async () => {
    const harness = createHarness();
    const response = await harness.invoke(
      'POST',
      '/api/bots/:botId/channels/:channelId/objects',
      {
        params: { botId: BOT_ID, channelId: CHANNEL_ID },
        body: {
          contentType: 'text/plain',
          dataBase64: Buffer.from('hello').toString('base64'),
          provenance: { source: 'upload' },
        },
      },
    );
    expect(response.statusCode).toBe(201);
    expect(harness.blobStore.uploadPrivate).toHaveBeenCalledWith(expect.objectContaining({
      botId: BOT_ID,
      channelId: CHANNEL_ID,
      contentType: 'text/plain',
      bytes: expect.any(Buffer),
    }));
    expect(response.payload.object).toMatchObject({ id: OBJECT_ID, visibility: 'private' });
    expect(response.payload.object).not.toHaveProperty('storageObjectName');
    expect(JSON.stringify(response.payload)).not.toContain('must-not-be-public');

    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x00,
    ]);
    const pngResponse = await harness.invoke(
      'POST',
      '/api/bots/:botId/channels/:channelId/objects',
      {
        params: { botId: BOT_ID, channelId: CHANNEL_ID },
        body: {
          contentType: 'image/png',
          dataBase64: png.toString('base64'),
          provenance: { source: 'channel_upload', name: 'screenshot.png' },
        },
      },
    );
    expect(pngResponse.statusCode).toBe(201);
    expect(harness.blobStore.uploadPrivate).toHaveBeenLastCalledWith(expect.objectContaining({
      botId: BOT_ID,
      channelId: CHANNEL_ID,
      contentType: 'image/png',
      bytes: expect.any(Buffer),
    }));

    const invalid = await harness.invoke(
      'POST',
      '/api/bots/:botId/channels/:channelId/objects',
      {
        params: { botId: BOT_ID, channelId: CHANNEL_ID },
        body: { contentType: 'text/plain', dataBase64: 'aGVsbG8=', secret: 'no' },
      },
    );
    expect(invalid.statusCode).toBe(400);
  });

  it('routes conversation-scoped Shared listing and retry through the authorized service', async () => {
    const harness = createHarness();
    const listed = await harness.invoke(
      'GET',
      '/api/bots/:botId/channels/:channelId/shared-files',
      { params: { botId: BOT_ID, channelId: CHANNEL_ID } },
    );
    expect(listed.payload.sharedFiles).toEqual([
      expect.objectContaining({ id: SHARED_FILE_ID, copyState: 'ready' }),
    ]);
    expect(harness.sharedFileService.listChannel).toHaveBeenCalledWith({
      principal: expect.objectContaining({ id: USER_ID }),
      botId: BOT_ID,
      channelId: CHANNEL_ID,
    });

    const retried = await harness.invoke(
      'POST',
      '/api/bots/:botId/channels/:channelId/shared-files/:id/retry',
      {
        params: { botId: BOT_ID, channelId: CHANNEL_ID, id: SHARED_FILE_ID },
        body: {},
      },
    );
    expect(retried.payload.sharedFile).toMatchObject({ id: SHARED_FILE_ID, copyState: 'ready' });
    expect(harness.sharedFileService.retry).toHaveBeenCalledWith({
      principal: expect.objectContaining({ id: USER_ID }),
      botId: BOT_ID,
      channelId: CHANNEL_ID,
      sharedFileId: SHARED_FILE_ID,
    });
  });

  it('exposes continuous channels and admits messages through the dispatcher', async () => {
    const harness = createHarness({
      dispatcher: {
        enqueueMessage: vi.fn(async ({ timing }) => {
          timing('authorization', 12.5);
          timing('library', 8.25);
          timing('admission', 24.75);
          return {
            created: true,
            message: { id: OBJECT_ID },
            run: {
              id: RUN_ID,
              state: 'queued',
              retryable: false,
              modelSnapshot: { version: 1, state: 'pending' },
            },
          };
        }),
      },
    });
    const ownerChannel = await harness.invoke('POST', '/api/bots/:botId/channel', {
      params: { botId: BOT_ID },
    });
    expect(ownerChannel.payload.channel).toMatchObject({ id: CHANNEL_ID });
    expect(harness.channels.getOrCreateOwnerChannel).toHaveBeenCalledWith(expect.objectContaining({
      botId: BOT_ID,
    }));

    const queued = await harness.invoke('POST', '/api/bot-channels/:channelId/messages', {
      params: { channelId: CHANNEL_ID },
      body: {
        messageId: OBJECT_ID,
        idempotencyKey: 'client-1',
        text: 'Hello',
        attachmentIds: [],
        attachmentDeliveryMode: 'compatibility',
      },
    });
    expect(queued.statusCode).toBe(202);
    expect(queued.payload.run).toMatchObject({
      id: RUN_ID,
      state: 'queued',
      retryable: false,
      modelSnapshot: { version: 1, state: 'pending' },
    });
    expect(queued.headers['server-timing']).toMatch(/authorization;dur=12\.5/);
    expect(queued.headers['server-timing']).toMatch(/library;dur=8\.3/);
    expect(queued.headers['server-timing']).toMatch(/admission;dur=24\.8/);
    expect(queued.headers['server-timing']).toMatch(/total;dur=/);
    expect(harness.dispatcher.enqueueMessage).toHaveBeenCalledWith(expect.objectContaining({
      channelId: CHANNEL_ID,
      message: expect.objectContaining({ attachmentDeliveryMode: 'compatibility' }),
    }));

    const warmed = await harness.invoke('POST', '/api/bot-channels/:channelId/prewarm', {
      params: { channelId: CHANNEL_ID },
      body: {},
    });
    expect(warmed.payload).toEqual({
      state: 'ready',
      leaseId: SHARED_FILE_ID,
      revisionId: REVISION_ID,
      expiresAt: TIMESTAMP,
      reason: null,
    });
    expect(harness.dispatcher.prewarmChannel).toHaveBeenCalledWith({
      principal: expect.objectContaining({ id: USER_ID }),
      channelId: CHANNEL_ID,
    });
    const released = await harness.invoke(
      'DELETE',
      '/api/bot-channels/:channelId/prewarm/:leaseId',
      { params: { channelId: CHANNEL_ID, leaseId: SHARED_FILE_ID } },
    );
    expect(released.payload).toEqual({ released: true });
    expect(harness.dispatcher.releasePrewarm).toHaveBeenCalledWith({
      principal: expect.objectContaining({ id: USER_ID }),
      channelId: CHANNEL_ID,
      leaseId: SHARED_FILE_ID,
    });

    const retried = await harness.invoke('POST', '/api/bot-runs/:runId/retry', {
      params: { runId: RUN_ID },
      body: {},
    });
    expect(retried.statusCode).toBe(202);
    expect(retried.payload.run).toMatchObject({ id: RUN_ID, state: 'queued' });
    expect(harness.dispatcher.retryRun).toHaveBeenCalledWith({
      principal: expect.objectContaining({ id: USER_ID }),
      runId: RUN_ID,
    });
  });

  it('routes conversational routine drafting separately from reviewed activation', async () => {
    const harness = createHarness();
    const drafted = await harness.invoke('POST', '/api/bots/:botId/routines/draft', {
      params: { botId: BOT_ID },
      body: { rationale: 'Review the queue each morning.', timezone: 'UTC' },
    });
    expect(drafted.payload).toMatchObject({ requiresManagerReview: true });
    expect(harness.routineRuntime.draft).toHaveBeenCalledWith(
      expect.objectContaining({ id: USER_ID }),
      BOT_ID,
      { rationale: 'Review the queue each morning.', timezone: 'UTC' },
    );

    const activated = await harness.invoke(
      'POST',
      '/api/bots/:botId/routines/:routineId/lifecycle',
      {
        params: { botId: BOT_ID, routineId: ROUTINE_ID },
        body: { target: 'active', reviewed: true, expectedUpdatedAt: TIMESTAMP },
      },
    );
    expect(activated.payload.routine.status).toBe('active');
    expect(harness.routineRuntime.transition).toHaveBeenCalledWith(
      expect.objectContaining({ id: USER_ID }),
      BOT_ID,
      ROUTINE_ID,
      { target: 'active', reviewed: true, expectedUpdatedAt: TIMESTAMP },
    );
  });

  it('exposes manager memory operations and explicit shared-learning channel deletion', async () => {
    const harness = createHarness();
    const listed = await harness.invoke('GET', '/api/bots/:botId/memories', {
      params: { botId: BOT_ID },
      query: { limit: '25' },
    });
    expect(listed.payload).toEqual({ memories: [], nextCursor: null });
    expect(harness.memoryRuntime.listForManager).toHaveBeenCalledWith(
      expect.objectContaining({ id: USER_ID }),
      BOT_ID,
      { cursor: null, limit: '25' },
    );

    const edited = await harness.invoke('PATCH', '/api/bots/:botId/memories/:memoryId', {
      params: { botId: BOT_ID, memoryId: OBJECT_ID },
      body: {
        text: 'Manager fact.',
        sensitivity: 'normal',
        confidence: 0.9,
        expectedUpdatedAt: '2026-08-23T12:00:00.000Z',
      },
    });
    expect(edited.payload.memory.id).toBe(OBJECT_ID);
    expect(harness.memoryRuntime.editMemory).toHaveBeenCalledWith(
      expect.objectContaining({ id: USER_ID }),
      BOT_ID,
      OBJECT_ID,
      expect.objectContaining({ text: 'Manager fact.' }),
    );

    const deleted = await harness.invoke('DELETE', '/api/bot-channels/:channelId', {
      params: { channelId: CHANNEL_ID },
      body: { sharedMemorySurvives: true },
    });
    expect(deleted.payload.notice).toContain('Shared learning survives');
    expect(harness.memoryRuntime.deleteChannel).toHaveBeenCalledWith(
      expect.objectContaining({ id: USER_ID }),
      CHANNEL_ID,
      { sharedMemorySurvives: true },
    );
  });

  it('exposes durable approvals, reconciliation, evidence, and human computer control', async () => {
    const harness = createHarness();

    const pending = await harness.invoke('GET', '/api/bot-actions/pending', {
      query: { limit: '25' },
    });
    expect(pending.payload.actions).toEqual([{ id: ACTION_ID }]);
    expect(harness.approvalService.listPending).toHaveBeenCalledWith(expect.objectContaining({
      limit: 25,
    }));

    const decisionRequest = {
      actionHash: `sha256:${'a'.repeat(64)}`,
      revisionId: 'a0000000-0000-4000-8000-000000000002',
      argsDigest: 'b'.repeat(64),
      decision: 'approved',
    };
    const decided = await harness.invoke('POST', '/api/bot-actions/:actionId/decision', {
      params: { actionId: ACTION_ID },
      body: decisionRequest,
    });
    expect(decided.payload.action.state).toBe('approved');
    expect(harness.approvalService.decide).toHaveBeenCalledWith(expect.objectContaining({
      actionAttemptId: ACTION_ID,
      request: decisionRequest,
    }));

    const reconciled = await harness.invoke('POST', '/api/bot-actions/:actionId/reconcile', {
      params: { actionId: ACTION_ID },
      body: { ...decisionRequest, decision: 'complete' },
    });
    expect(reconciled.payload).toMatchObject({ replayed: false });

    const evidence = await harness.invoke(
      'GET',
      '/api/bot-actions/:actionId/evidence/:objectId',
      { params: { actionId: ACTION_ID, objectId: OBJECT_ID } },
    );
    expect(evidence.payload).toEqual(Buffer.from('png'));
    expect(evidence.headers['content-type']).toBe('image/png');
    expect(harness.evidenceService.download).toHaveBeenCalledWith(expect.objectContaining({
      botId: BOT_ID,
      actionAttemptId: ACTION_ID,
      objectId: OBJECT_ID,
    }));

    const status = await harness.invoke('GET', '/api/bots/:botId/computer/status', {
      params: { botId: BOT_ID },
    });
    expect(status.payload).toMatchObject({ botId: BOT_ID, state: 'running' });
    const control = await harness.invoke(
      'POST',
      '/api/bots/:botId/computer/control/take',
      { params: { botId: BOT_ID }, body: {} },
    );
    expect(control.payload).toMatchObject({ leaseId: 'lease-1' });
    expect(harness.browserService.takeControl).toHaveBeenCalledWith(expect.objectContaining({
      botId: BOT_ID,
    }));
  });

  it('creates, streams, and stops passive computer viewers without a control lease', async () => {
    const harness = createHarness();
    const created = await harness.invoke('POST', '/api/bots/:botId/computer/view', {
      params: { botId: BOT_ID },
      body: { channelId: CHANNEL_ID },
    });

    expect(created.statusCode).toBe(201);
    expect(created.payload.view).toMatchObject({ id: 'view_opaque', botId: BOT_ID, channelId: CHANNEL_ID });
    expect(harness.browserService.startComputerView).toHaveBeenCalledWith({
      principal: expect.objectContaining({ id: USER_ID }),
      botId: BOT_ID,
      channelId: CHANNEL_ID,
    });

    const streamed = await harness.invoke(
      'GET',
      '/api/bots/:botId/computer/view/:viewId/stream',
      { params: { botId: BOT_ID, viewId: 'view_opaque' } },
    );
    expect(streamed.payload.toString('utf8')).toBe('frame');
    expect(streamed.headers['content-type']).toContain('multipart/x-mixed-replace');
    expect(harness.browserService.openComputerView).toHaveBeenCalledWith(expect.objectContaining({
      principal: expect.objectContaining({ id: USER_ID }),
      botId: BOT_ID,
      viewId: 'view_opaque',
      signal: expect.any(AbortSignal),
    }));
    expect(harness.browserService.stopComputerView).toHaveBeenCalledTimes(1);

    const stopped = await harness.invoke(
      'DELETE',
      '/api/bots/:botId/computer/view/:viewId',
      { params: { botId: BOT_ID, viewId: 'view_opaque' } },
    );
    expect(stopped.payload).toEqual({ stopped: true });
    expect(harness.browserService.stopComputerView).toHaveBeenLastCalledWith({
      principal: expect.objectContaining({ id: USER_ID }),
      botId: BOT_ID,
      viewId: 'view_opaque',
    });
  });

  it('routes reviewed Library scans and explicit private-artifact publication', async () => {
    const harness = createHarness();
    const scanRequest = {
      path: '/manager-selected/handbook',
      name: 'Handbook',
      exclusions: { names: [], extensions: [], paths: [] },
    };
    const scanned = await harness.invoke('POST', '/api/bots/:botId/library-sources/scan', {
      params: { botId: BOT_ID },
      body: scanRequest,
    });
    expect(scanned.payload).toMatchObject({ scanId: SCAN_ID, sourceId: SOURCE_ID });
    expect(harness.libraryRuntime.scanImport).toHaveBeenCalledWith(
      expect.objectContaining({ id: USER_ID }),
      BOT_ID,
      scanRequest,
    );

    const published = await harness.invoke(
      'POST',
      '/api/bots/:botId/library-scans/:scanId/publish',
      {
        params: { botId: BOT_ID, scanId: SCAN_ID },
        body: { confirmed: true, expectedSourceUpdatedAt: null },
      },
    );
    expect(published.statusCode).toBe(201);
    expect(harness.libraryRuntime.publishScan).toHaveBeenCalledWith(
      expect.objectContaining({ id: USER_ID }),
      BOT_ID,
      SCAN_ID,
      { confirmed: true, expectedSourceUpdatedAt: null },
    );

    const artifact = await harness.invoke(
      'POST',
      '/api/bots/:botId/objects/:objectId/publish',
      {
        params: { botId: BOT_ID, objectId: OBJECT_ID },
        body: { name: 'Reviewed artifact.txt' },
      },
    );
    expect(artifact.statusCode).toBe(201);
    expect(harness.artifactService.publishPrivate).toHaveBeenCalledWith(
      expect.objectContaining({ id: USER_ID }),
      BOT_ID,
      OBJECT_ID,
      { name: 'Reviewed artifact.txt', sourceId: null, provenance: {} },
    );
    expect(harness.blobStore.publishToLibrary).not.toHaveBeenCalled();
  });

  it('maps a partial/missing Bot schema to the durable migration envelope', async () => {
    const harness = createHarness({
      blobStore: {
        uploadPrivate: vi.fn(async () => {
          throw new SupabaseRequestError(
            "Could not find the table 'public.bot_objects' in the schema cache",
            { status: 404, payload: { code: 'PGRST205' } },
          );
        }),
      },
    });
    const response = await harness.invoke(
      'POST',
      '/api/bots/:botId/channels/:channelId/objects',
      {
        params: { botId: BOT_ID, channelId: CHANNEL_ID },
        body: { contentType: 'text/plain', dataBase64: 'aGVsbG8=' },
      },
    );
    expect(response.statusCode).toBe(503);
    expect(response.payload).toEqual({
      error: 'Database migration required',
      code: 'bot_schema_migration_required',
      requiredMigration: '20260827100000',
    });
  });
});
