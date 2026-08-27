import { describe, expect, test } from 'bun:test';

import { BotsApiError, createBotsApi, type BotRoutineContract } from './botsApi';

describe('Production Bots HTTP client', () => {
  test('adds same-origin credentials and CSRF to mutations without changing the payload', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const api = createBotsApi({
      fetchImpl: async (input, init) => {
        calls.push({ input, init });
        return new Response(JSON.stringify({
          created: true,
          message: {},
          run: {},
        }), { status: 202, headers: { 'Content-Type': 'application/json' } });
      },
    });

    await api.sendMessage('channel/one', {
      messageId: 'message-1',
      idempotencyKey: 'stable-1',
      text: 'Hello',
      attachmentIds: ['object-1'],
      attachmentDeliveryMode: 'compatibility',
    });

    expect(String(calls[0].input)).toBe('/api/bot-channels/channel%2Fone/messages');
    expect(calls[0].init?.credentials).toBe('same-origin');
    expect(calls[0].init?.method).toBe('POST');
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get('X-DevRyan-CSRF')).toBe('1');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      messageId: 'message-1',
      idempotencyKey: 'stable-1',
      text: 'Hello',
      attachmentIds: ['object-1'],
      attachmentDeliveryMode: 'compatibility',
    });
  });

  test('uses the channel prewarm and same-run safe retry contracts', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const api = createBotsApi({
      fetchImpl: async (input, init) => {
        calls.push({ input, init });
        const path = String(input);
        const payload = path.endsWith('/prewarm') ? {
          state: 'warming', leaseId: 'lease-1', revisionId: 'revision-1',
          expiresAt: '2026-08-26T12:05:00.000Z', reason: null,
        } : path.includes('/prewarm/') ? { released: true }
          : { run: { id: 'run-1', state: 'queued', retryable: false } };
        return new Response(JSON.stringify(payload), {
          status: path.endsWith('/retry') ? 202 : 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    await api.prewarmChannel('channel/one');
    await api.releasePrewarmChannel('channel/one', 'lease/one');
    await api.retryRun('run/one');

    expect(String(calls[0].input)).toBe('/api/bot-channels/channel%2Fone/prewarm');
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({});
    expect(String(calls[1].input)).toBe('/api/bot-channels/channel%2Fone/prewarm/lease%2Fone');
    expect(calls[1].init?.method).toBe('DELETE');
    expect(String(calls[2].input)).toBe('/api/bot-runs/run%2Fone/retry');
    expect(calls[2].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[2].init?.body))).toEqual({});
    expect(new Headers(calls[2].init?.headers).get('X-DevRyan-CSRF')).toBe('1');
  });

  test('preserves stable server status and error codes', async () => {
    const api = createBotsApi({
      fetchImpl: async () => new Response(JSON.stringify({
        error: 'Docker Desktop is stopped',
        code: 'bot_runtime_docker_unavailable',
      }), { status: 503, headers: { 'Content-Type': 'application/json' } }),
    });

    const error = await api.getCapabilities().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BotsApiError);
    expect((error as BotsApiError).status).toBe(503);
    expect((error as BotsApiError).code).toBe('bot_runtime_docker_unavailable');
    expect((error as BotsApiError).message).toBe('Docker Desktop is stopped');
  });

  test('uses no-store reads and preserves break-glass reasons in headers', async () => {
    const calls: RequestInit[] = [];
    const api = createBotsApi({
      fetchImpl: async (_input, init) => {
        calls.push(init || {});
        return new Response(JSON.stringify({ messages: [], nextCursor: null }), {
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    await api.listMessages('channel-1', { breakGlassReason: 'Incident 42' });

    expect(calls[0].cache).toBe('no-store');
    expect(new Headers(calls[0].headers).get('X-DevRyan-Break-Glass-Reason'))
      .toBe('Incident 42');
  });

  test('uses explicit ephemeral viewer sessions instead of an eager screencast URL', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const api = createBotsApi({
      fetchImpl: async (input, init) => {
        calls.push({ input, init });
        return new Response(JSON.stringify(calls.length === 1 ? {
          view: {
            id: 'view_opaque',
            botId: 'bot/one',
            channelId: 'channel/one',
            streamUrl: '/api/bots/bot%2Fone/computer/view/view_opaque/stream',
            startedAt: '2026-08-25T00:00:00.000Z',
          },
        } : { stopped: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    const { view } = await api.startComputerView('bot/one', 'channel/one');
    await api.stopComputerView('bot/one', view.id);

    expect(String(calls[0].input)).toBe('/api/bots/bot%2Fone/computer/view');
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ channelId: 'channel/one' });
    expect(String(calls[1].input))
      .toBe('/api/bots/bot%2Fone/computer/view/view_opaque');
    expect(calls[1].init?.method).toBe('DELETE');
    expect(calls[1].init?.body).toBe(undefined);
    expect(new Headers(calls[1].init?.headers).get('X-DevRyan-CSRF')).toBe('1');
  });

  test('uses an optimistic PATCH contract for setup configuration edits', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const api = createBotsApi({
      fetchImpl: async (input, init) => {
        calls.push({ input, init });
        return new Response(JSON.stringify({ revision: {} }), {
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    const contract = {
      identity: { title: 'Desk', avatar: 'D' }, objectives: ['Help'], soul: '# Soul', tone: 'Direct',
      operatingInstructions: 'Operate', prohibitedInstructions: 'Do not bypass', advancedPrompt: '',
      tenancy: 'team' as const, standingRole: 'You are a Bot.',
      models: { primary: { providerId: 'openai', modelId: 'gpt-5', credentialId: 'credential', egressHosts: ['api.openai.com:443'] }, fallbacks: [] },
      reasoning: {}, fileTools: ['read' as const], gatewayPluginVersion: 'v1', libraryVersionIds: [],
      memoryPolicy: {}, actionPolicy: { defaultEffect: 'deny' as const, defaultRisk: 'sensitive' as const, rules: [] },
      browserPolicy: { allowedOrigins: [], deniedOrigins: [] },
    };

    await api.updateBotRevision('bot/one', 'revision/one', {
      contract,
      expectedUpdatedAt: '2026-08-23T00:00:00.000Z',
    });

    expect(String(calls[0].input)).toBe('/api/bots/bot%2Fone/revisions/revision%2Fone');
    expect(calls[0].init?.method).toBe('PATCH');
    expect(new Headers(calls[0].init?.headers).get('X-DevRyan-CSRF')).toBe('1');
    const body = JSON.parse(String(calls[0].init?.body)) as { expectedUpdatedAt?: string };
    expect(body.expectedUpdatedAt).toBe('2026-08-23T00:00:00.000Z');
  });

  test('uses durable profile, sanitized model-option, and exact publish contracts', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const api = createBotsApi({
      fetchImpl: async (input, init) => {
        calls.push({ input, init });
        return new Response(JSON.stringify({ bot: {}, revision: {}, health: {}, providers: [] }), {
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    const expectedUpdatedAt = '2026-08-23T00:00:00.000Z';
    const contract = {
      identity: { title: 'Legacy runtime identity', avatar: 'D' }, objectives: ['Help'], soul: '# Soul', tone: 'Direct',
      operatingInstructions: 'Operate', prohibitedInstructions: 'Do not bypass', advancedPrompt: '',
      tenancy: 'team' as const, standingRole: 'You are a Bot.',
      models: { primary: { providerId: 'openai', modelId: 'gpt-5', credentialId: 'credential', egressHosts: ['api.openai.com:443'] }, fallbacks: [] },
      reasoning: {}, fileTools: ['read' as const], gatewayPluginVersion: 'v1', libraryVersionIds: [],
      memoryPolicy: {}, actionPolicy: { defaultEffect: 'deny' as const, defaultRisk: 'sensitive' as const, rules: [] },
      browserPolicy: { allowedOrigins: [], deniedOrigins: [] },
    };
    const avatar = { contentType: 'image/png' as const, dataBase64: 'iVBORw0KGgo=' };

    await api.updateBotProfile('bot/one', {
      name: 'Release Desk', title: 'Release Operations', summary: 'Ships safely.',
      expectedUpdatedAt, avatar,
    });
    await api.getBotModelOptions('bot/one');
    const profile = {
      name: 'Release Desk', title: 'Release Operations', summary: 'Ships safely.',
      expectedUpdatedAt, avatar,
    };
    await api.publishBotRevision('bot/one', 'revision/one', {
      contract,
      expectedUpdatedAt,
      profile,
    });

    expect(String(calls[0].input)).toBe('/api/bots/bot%2Fone/profile');
    expect(calls[0].init?.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      name: 'Release Desk', title: 'Release Operations', summary: 'Ships safely.',
      expectedUpdatedAt, avatar,
    });
    expect(String(calls[1].input)).toBe('/api/bots/bot%2Fone/model-options');
    expect(calls[1].init?.method).toBe(undefined);
    expect(String(calls[2].input)).toBe('/api/bots/bot%2Fone/revisions/revision%2Fone/publish');
    expect(calls[2].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[2].init?.body))).toEqual({ contract, expectedUpdatedAt, profile });
  });

  test('uses request-only secrets and exact named credential connection contracts', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const api = createBotsApi({
      fetchImpl: async (input, init) => {
        calls.push({ input, init });
        return new Response(JSON.stringify({ credential: {
          id: 'credential-1', provider: 'openai', label: 'Production', kind: 'api_key',
          scope: 'team', maskedIdentifier: '••••1234', status: 'active', version: 1,
          createdAt: '2026-08-23T00:00:00.000Z', updatedAt: '2026-08-23T00:00:00.000Z',
          rotatedAt: null,
        } }), { headers: { 'Content-Type': 'application/json' } });
      },
    });
    const expectedUpdatedAt = '2026-08-23T00:00:00.000Z';

    await api.saveBotCredentialMetadata('bot/one', {
      provider: 'openai', label: 'Production', kind: 'api_key', credentialScope: 'team',
      ownerUserId: null, secret: 'request-only-key',
    });
    await api.saveBotCredentialMetadata('bot/one', {
      provider: 'github', connectionId: 'host:github', label: 'Work account', kind: 'oauth',
      credentialScope: 'user', ownerUserId: 'user-1',
    });
    await api.rotateBotCredential('bot/one', 'credential/one', {
      secret: 'replacement-key', expectedUpdatedAt,
    });

    expect(String(calls[0].input)).toBe('/api/bots/bot%2Fone/credentials');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      provider: 'openai', label: 'Production', kind: 'api_key', credentialScope: 'team',
      ownerUserId: null, secret: 'request-only-key',
    });
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({
      provider: 'github', connectionId: 'host:github', label: 'Work account', kind: 'oauth',
      credentialScope: 'user', ownerUserId: 'user-1',
    });
    expect(String(calls[2].input)).toBe('/api/bots/bot%2Fone/credentials/credential%2Fone/rotate');
    expect(JSON.parse(String(calls[2].init?.body))).toEqual({ secret: 'replacement-key', expectedUpdatedAt });
  });

  test('uses revision-bound capability assignment paths and optimistic mutation bodies', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const api = createBotsApi({
      fetchImpl: async (input, init) => {
        calls.push({ input, init });
        return new Response(JSON.stringify({ revision: {}, binding: {}, skills: [], mcp: [] }), {
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    const expectedUpdatedAt = '2026-08-23T00:00:00.000Z';

    await api.getBotCapabilityBindings('bot/one', 'revision/one', {
      directory: '/repo one',
      checkLive: true,
    });
    await api.attachBotSkill('bot/one', 'revision/one', {
      skillName: 'review-queue',
      expectedUpdatedAt,
    });
    await api.detachBotSkill('bot/one', 'revision/one', 'skill/one', expectedUpdatedAt);
    await api.attachBotMcp('bot/one', 'revision/one', {
      serverName: 'Inventory',
      directory: '/repo one',
      expectedUpdatedAt,
      confirmSharedCredential: true,
    });
    await api.detachBotMcp('bot/one', 'revision/one', 'mcp/one', expectedUpdatedAt);
    await api.rotateBotMcpCredential('bot/one', 'revision/one', 'mcp/one', {
      serverName: 'Inventory',
      directory: '/repo one',
      expectedUpdatedAt,
      confirmSharedCredential: true,
    });

    expect(String(calls[0].input)).toBe(
      '/api/bots/bot%2Fone/revisions/revision%2Fone/capability-bindings?directory=%2Frepo+one&checkLive=true',
    );
    expect(calls[0].init?.method).toBe(undefined);
    expect(String(calls[1].input))
      .toBe('/api/bots/bot%2Fone/revisions/revision%2Fone/skill-bindings');
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({
      skillName: 'review-queue', expectedUpdatedAt,
    });
    expect(String(calls[2].input))
      .toBe('/api/bots/bot%2Fone/revisions/revision%2Fone/skill-bindings/skill%2Fone');
    expect(calls[2].init?.method).toBe('DELETE');
    expect(JSON.parse(String(calls[2].init?.body))).toEqual({ expectedUpdatedAt });
    expect(String(calls[3].input))
      .toBe('/api/bots/bot%2Fone/revisions/revision%2Fone/mcp-bindings');
    expect(JSON.parse(String(calls[3].init?.body))).toEqual({
      serverName: 'Inventory',
      directory: '/repo one',
      expectedUpdatedAt,
      confirmSharedCredential: true,
    });
    expect(String(calls[4].input))
      .toBe('/api/bots/bot%2Fone/revisions/revision%2Fone/mcp-bindings/mcp%2Fone');
    expect(calls[4].init?.method).toBe('DELETE');
    expect(String(calls[5].input)).toBe(
      '/api/bots/bot%2Fone/revisions/revision%2Fone/mcp-bindings/mcp%2Fone/credential',
    );
    expect(JSON.parse(String(calls[5].init?.body))).toEqual({
      serverName: 'Inventory',
      directory: '/repo one',
      expectedUpdatedAt,
      confirmSharedCredential: true,
    });
  });

  test('preserves bounded activation gate details on a 409', async () => {
    const gates = [{ id: 'mcp', status: 'fail', detail: 'Connection unavailable' }];
    const api = createBotsApi({
      fetchImpl: async () => new Response(JSON.stringify({
        error: 'Activation blocked',
        code: 'bot_activation_blocked',
        details: { gates },
      }), { status: 409, headers: { 'Content-Type': 'application/json' } }),
    });
    const error = await api.activateBotRevision('bot', 'revision').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BotsApiError);
    expect((error as BotsApiError).details).toEqual({ gates });
  });

  test('uses optimistic version contracts for memory edits and explicit channel deletion survival', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const api = createBotsApi({
      fetchImpl: async (input, init) => {
        calls.push({ input, init });
        return new Response(JSON.stringify({ memory: {}, version: {}, indexSynchronized: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    await api.editBotMemory('bot/one', 'memory/one', {
      text: 'Bounded reusable fact.',
      sensitivity: 'normal',
      confidence: 0.9,
      expectedUpdatedAt: '2026-08-23T12:00:00.000Z',
    });
    await api.deleteBotChannel('channel/one');

    expect(String(calls[0].input)).toBe('/api/bots/bot%2Fone/memories/memory%2Fone');
    expect(calls[0].init?.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      text: 'Bounded reusable fact.',
      sensitivity: 'normal',
      confidence: 0.9,
      expectedUpdatedAt: '2026-08-23T12:00:00.000Z',
    });
    expect(String(calls[1].input)).toBe('/api/bot-channels/channel%2Fone');
    expect(calls[1].init?.method).toBe('DELETE');
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ sharedMemorySurvives: true });
  });

  test('uses the dedicated server-derived complete Bot deletion contract', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const api = createBotsApi({
      fetchImpl: async (input, init) => {
        calls.push({ input, init });
        return new Response(JSON.stringify({ purge: { botDeleted: true } }), {
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    await api.deleteBotCompletely('bot/one', {
      typedName: 'Release Sentinel',
      confirm: true,
      expectedUpdatedAt: '2026-08-24T20:00:00.000Z',
    });

    expect(String(calls[0].input)).toBe('/api/bots/bot%2Fone/purge/complete');
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      typedName: 'Release Sentinel',
      confirm: true,
      expectedUpdatedAt: '2026-08-24T20:00:00.000Z',
    });
  });

  test('keeps Library review and private-artifact publication as explicit mutations', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const api = createBotsApi({
      fetchImpl: async (input, init) => {
        calls.push({ input, init });
        return new Response(JSON.stringify({
          source: {}, version: {}, diff: {}, indexSynchronized: true,
        }), { headers: { 'Content-Type': 'application/json' } });
      },
    });

    await api.scanBotLibraryRefresh('bot/one', 'source/one');
    await api.publishBotLibraryScan('bot/one', 'scan/one', {
      confirmed: true,
      expectedSourceUpdatedAt: '2026-08-23T12:00:00.000Z',
    });
    await api.publishObject('bot/one', 'object/one', { name: 'Reviewed result.txt' });

    expect(String(calls[0].input))
      .toBe('/api/bots/bot%2Fone/library-sources/source%2Fone/scan');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({});
    expect(String(calls[1].input))
      .toBe('/api/bots/bot%2Fone/library-scans/scan%2Fone/publish');
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({
      confirmed: true,
      expectedSourceUpdatedAt: '2026-08-23T12:00:00.000Z',
    });
    expect(String(calls[2].input))
      .toBe('/api/bots/bot%2Fone/objects/object%2Fone/publish');
    expect(JSON.parse(String(calls[2].init?.body))).toEqual({ name: 'Reviewed result.txt' });
  });

  test('keeps routine drafting separate from reviewed optimistic activation', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const api = createBotsApi({
      fetchImpl: async (input, init) => {
        calls.push({ input, init });
        return new Response(JSON.stringify({ routine: {}, contract: {}, requiresManagerReview: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    const contract: BotRoutineContract = {
      version: 1,
      rationale: 'Review the queue.',
      trigger: { kind: 'daily', time: '09:00' },
      timezone: 'UTC',
      goal: 'Review the queue.',
      inputs: {},
      allowedTools: [],
      allowedAccountIds: [],
      allowedOrigins: [],
      limits: { maxActions: 1, maxExternalWrites: 0 },
      approvalClass: 'none',
      timeoutSeconds: 300,
      missedPolicy: 'skip',
      missedRunCap: 1,
      completionCriteria: ['The queue is reviewed.'],
    };

    await api.draftBotRoutine('bot/one', { rationale: contract.rationale, timezone: 'UTC' });
    await api.createBotRoutineDraft('bot/one', { name: 'Morning review', contract });
    await api.transitionBotRoutine('bot/one', 'routine/one', {
      target: 'active',
      reviewed: true,
      expectedUpdatedAt: '2026-08-23T12:00:00.000Z',
    });

    expect(String(calls[0].input)).toBe('/api/bots/bot%2Fone/routines/draft');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      rationale: 'Review the queue.', timezone: 'UTC',
    });
    expect(String(calls[1].input)).toBe('/api/bots/bot%2Fone/routines');
    expect(String(calls[2].input))
      .toBe('/api/bots/bot%2Fone/routines/routine%2Fone/lifecycle');
    expect(JSON.parse(String(calls[2].init?.body))).toEqual({
      target: 'active',
      reviewed: true,
      expectedUpdatedAt: '2026-08-23T12:00:00.000Z',
    });
  });

  test('uses typed, revision-bound start and explicit retry contracts for purge', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const api = createBotsApi({
      fetchImpl: async (input, init) => {
        calls.push({ input, init });
        return new Response(JSON.stringify({ purge: null }), {
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    const start = {
      typedName: 'Research Desk',
      confirm: true as const,
      expectedUpdatedAt: '2026-08-23T12:00:00.000Z',
      resourceIds: ['objects', 'channels'],
    };

    await api.getBotPurge('bot/one');
    await api.startBotPurge('bot/one', start);
    await api.retryBotPurge('bot/one', { resourceIds: ['channels'] });

    expect(String(calls[0].input)).toBe('/api/bots/bot%2Fone/purge');
    expect(calls[0].init?.method).toBe(undefined);
    expect(String(calls[1].input)).toBe('/api/bots/bot%2Fone/purge');
    expect(calls[1].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[1].init?.body))).toEqual(start);
    expect(String(calls[2].input)).toBe('/api/bots/bot%2Fone/purge/retry');
    expect(JSON.parse(String(calls[2].init?.body))).toEqual({ resourceIds: ['channels'] });
  });
});
