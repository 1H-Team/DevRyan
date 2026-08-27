import { describe, expect, it, vi } from 'vitest';

import {
  BotBrowserServiceError,
  botBrowserOperationKind,
  classifyBotBrowserRemoteFailure,
  createBotBrowserService,
  validateBotBrowserAction,
} from './browser-service.js';

const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const CHANNEL_ID = 'c0000000-0000-4000-8000-000000000001';
const RUN_ID = 'd0000000-0000-4000-8000-000000000001';
const REVISION_ID = 'e0000000-0000-4000-8000-000000000001';
const USER_ID = 'a0000000-0000-4000-8000-000000000001';
const TOKEN = 'a'.repeat(43);

const run = () => ({
  id: RUN_ID,
  bot_id: BOT_ID,
  channel_id: CHANNEL_ID,
  revision_id: REVISION_ID,
  computer_scope_key: `bot:${BOT_ID}`,
  state: 'running',
});
const bot = (overrides = {}) => ({
  id: BOT_ID,
  tenancy: 'team',
  lifecycle: 'active',
  active_revision_id: REVISION_ID,
  ...overrides,
});
const channel = () => ({ id: CHANNEL_ID, bot_id: BOT_ID, owner_user_id: USER_ID });

const createHarness = ({ now, viewAttachTtlMs, computerRuntimeManager: managerOverride = null } = {}) => {
  const responses = [];
  const transport = {
    request: vi.fn(async ({ path, body }) => {
      responses.push({ path, body });
      if (path === '/v1/status') {
        return {
          browser: { running: true },
          control: null,
          screencast: { subscribers: 0, lastFrameAt: null, retainedFrames: 0 },
        };
      }
      if (path === '/v1/control/take') {
        return { leaseId: 'control-1', ...body, takenAt: 1, expiresAt: 31_000 };
      }
      if (path === '/v1/control/return') return { returned: true };
      return { clicked: true };
    }),
    stream: vi.fn(async () => new Response('frame')),
  };
  const store = {
    repositories: {
      bot_runs: { get: vi.fn(async () => run()) },
      bots: { get: vi.fn(async () => bot()) },
      bot_channels: { get: vi.fn(async () => channel()) },
      bot_memberships: { list: vi.fn(async () => ({ items: [{ user_id: USER_ID }] })) },
    },
  };
  const authorization = {
    requireOperator: vi.fn(async () => ({ bot: bot(), membership: { role: 'operator' } })),
    requireActiveMembership: vi.fn(async () => ({ bot: bot(), membership: { role: 'member' } })),
    requireChannelRead: vi.fn(async () => ({ channel: channel() })),
  };
  const dockerProvider = {
    ensureComputer: vi.fn(async () => ({
      endpoint: { host: '127.0.0.1', port: 45100, baseUrl: 'http://127.0.0.1:45100' },
    })),
    stopComputer: vi.fn(async () => ({ state: 'stopped' })),
  };
  const gatewayHost = {
    issueCapability: vi.fn(() => ({
      token: TOKEN,
      dockerGatewayUrl: 'http://host.docker.internal:45101',
    })),
    revokeCapability: vi.fn(),
  };
  const computerRuntimeManager = managerOverride || {
    ensureBot: vi.fn(async () => ({
      botId: BOT_ID,
      scopeKey: `bot:${BOT_ID}`,
      token: TOKEN,
      endpoint: { host: '127.0.0.1', port: 45100, baseUrl: 'http://127.0.0.1:45100' },
    })),
    restartBot: vi.fn(async () => ({
      botId: BOT_ID,
      scopeKey: `bot:${BOT_ID}`,
      token: 'c'.repeat(43),
      endpoint: { host: '127.0.0.1', port: 45102, baseUrl: 'http://127.0.0.1:45102' },
    })),
  };
  const eventStream = { publish: vi.fn(async () => ({ delivered: 1 })) };
  const audit = vi.fn(async () => {});
  const service = createBotBrowserService({
    store,
    authorization,
    gatewayHost,
    computerRuntimeManager,
    eventStream,
    audit,
    transport,
    ...(now ? { now } : {}),
    ...(viewAttachTtlMs ? { viewAttachTtlMs } : {}),
  });
  return {
    service,
    transport,
    dockerProvider,
    computerRuntimeManager,
    gatewayHost,
    eventStream,
    audit,
    authorization,
    responses,
  };
};

describe('Bot governed browser service', () => {
  it('separates safe reads from potentially mutating interactions', () => {
    for (const command of ['navigate', 'snapshot', 'scroll', 'wait', 'download', 'screenshot']) {
      expect(botBrowserOperationKind(command)).toBe('read');
    }
    for (const command of ['click', 'fill', 'select', 'key', 'upload']) {
      expect(botBrowserOperationKind(command)).toBe('write');
    }
    expect(() => botBrowserOperationKind('evaluate')).toThrow(/not reviewed/i);
  });

  it('classifies only browser transport loss as uncertain and recoverable', () => {
    expect(classifyBotBrowserRemoteFailure({
      statusCode: 503,
      remoteCode: 'DEVRYAN_BOT_BROWSER_CLOSED',
    })).toEqual({
      code: 'bot_browser_command_failed',
      transportUncertain: true,
      recoverable: true,
    });
    expect(classifyBotBrowserRemoteFailure({
      statusCode: 504,
      remoteCode: 'DEVRYAN_BOT_BROWSER_COMMAND_TIMEOUT',
    })).toMatchObject({ transportUncertain: true, recoverable: true });
    expect(classifyBotBrowserRemoteFailure({
      statusCode: 502,
      remoteCode: 'DEVRYAN_BOT_NAVIGATION_FAILED',
    })).toMatchObject({ transportUncertain: false, recoverable: false });
  });

  it('requires an exact bounded origin and goal for interactions', () => {
    expect(() => validateBotBrowserAction({
      command: 'click',
      args: { ref: 'button-1' },
      target: { origin: 'https://example.com' },
      limits: {},
    })).toThrow(/origin and goal/i);

    expect(validateBotBrowserAction({
      command: 'click',
      args: { ref: 'button-1' },
      target: { origin: 'https://example.com', goal: 'Open settings' },
      limits: {},
    })).toMatchObject({ operationKind: 'write', target: { origin: 'https://example.com' } });
  });

  it('executes only under an exact per-operation policy capability', async () => {
    const harness = createHarness();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const result = await harness.service.executeAction({
      run: run(),
      bot: bot(),
      ownerUserId: USER_ID,
      command: 'click',
      args: { ref: 'button-1' },
      target: { origin: 'https://example.com', goal: 'Open settings' },
      limits: { allowedOperations: ['click'], decisionExpiresAt: expiresAt },
      decision: { actionHash: 'sha256:action', effect: 'allow', expiresAt },
    });

    expect(result).toMatchObject({
      result: { clicked: true },
      operationKind: 'write',
      nativeExactlyOnce: false,
      writeGuarantee: 'unknown_on_transport_loss',
    });
    expect(harness.computerRuntimeManager.ensureBot).toHaveBeenCalledTimes(1);
    expect(harness.transport.request).toHaveBeenCalledWith(expect.objectContaining({
      path: '/v1/command',
      body: { command: 'click', args: { ref: 'button-1' } },
    }));
  });

  it('issues and revokes a gateway capability only around a transfer command', async () => {
    const computerRuntimeManager = {
      ensureBot: vi.fn(async () => ({
        token: 'b'.repeat(43),
        endpoint: { host: '127.0.0.1', port: 45100, baseUrl: 'http://127.0.0.1:45100' },
      })),
      restartBot: vi.fn(async () => ({
        token: 'c'.repeat(43),
        endpoint: { host: '127.0.0.1', port: 45102, baseUrl: 'http://127.0.0.1:45102' },
      })),
    };
    const harness = createHarness({ computerRuntimeManager });
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    await harness.service.executeAction({
      run: run(),
      bot: bot(),
      ownerUserId: USER_ID,
      command: 'upload',
      args: { artifactId: 'artifact-1', filename: 'input.txt' },
      target: { origin: 'https://example.com', goal: 'Attach the input' },
      limits: { allowedOperations: ['upload'], decisionExpiresAt: expiresAt },
      decision: { actionHash: 'sha256:action', effect: 'allow', expiresAt },
    });

    expect(computerRuntimeManager.ensureBot).toHaveBeenCalledTimes(1);
    expect(harness.gatewayHost.issueCapability).toHaveBeenCalledWith(expect.objectContaining({
      operations: ['artifact.get'],
    }));
    expect(harness.transport.request).toHaveBeenCalledWith(expect.objectContaining({
      headers: { 'x-devryan-gateway-token': TOKEN },
    }));
    expect(harness.gatewayHost.revokeCapability).toHaveBeenCalledWith(TOKEN);
  });

  it('turns transport loss after a browser mutation into an unknown outcome', async () => {
    const harness = createHarness();
    harness.transport.request.mockRejectedValueOnce(new BotBrowserServiceError(
      'connection reset',
      'bot_browser_transport_failed',
      502,
      { transportUncertain: true },
    ));
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    await expect(harness.service.executeAction({
      run: run(),
      bot: bot(),
      ownerUserId: USER_ID,
      command: 'click',
      args: { ref: 'button-1' },
      target: { origin: 'https://example.com', goal: 'Open settings' },
      limits: { allowedOperations: ['click'], decisionExpiresAt: expiresAt },
      decision: { actionHash: 'sha256:action', effect: 'allow', expiresAt },
    })).rejects.toMatchObject({
      code: 'bot_action_needs_reconciliation',
      transportUncertain: true,
    });
    expect(harness.computerRuntimeManager.restartBot).not.toHaveBeenCalled();
  });

  it('recreates the persistent computer once when a safe read exhausts in-container recovery', async () => {
    const harness = createHarness();
    harness.transport.request.mockRejectedValueOnce(new BotBrowserServiceError(
      'browser closed',
      'bot_browser_command_failed',
      503,
      { transportUncertain: true, remoteCode: 'DEVRYAN_BOT_BROWSER_CLOSED' },
    ));
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    const result = await harness.service.executeAction({
      run: run(),
      bot: bot(),
      ownerUserId: USER_ID,
      command: 'navigate',
      args: { url: 'https://example.com/health' },
      target: { origin: 'https://example.com' },
      limits: { maxAttempts: 3 },
      decision: { actionHash: 'sha256:action', effect: 'allow', expiresAt },
    });

    expect(result).toMatchObject({ operationKind: 'read', writeGuarantee: 'safe_to_retry' });
    expect(harness.computerRuntimeManager.restartBot).toHaveBeenCalledTimes(1);
    expect(harness.transport.request).toHaveBeenCalledTimes(2);
    expect(harness.transport.request.mock.calls[1][0].runtime.endpoint.port).toBe(45102);
  });

  it('bounds failed safe-read recovery and suppresses outer transport retries', async () => {
    const harness = createHarness();
    harness.transport.request.mockRejectedValue(new BotBrowserServiceError(
      'browser closed',
      'bot_browser_command_failed',
      503,
      { transportUncertain: true, remoteCode: 'DEVRYAN_BOT_BROWSER_CLOSED' },
    ));
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    await expect(harness.service.executeAction({
      run: run(),
      bot: bot(),
      ownerUserId: USER_ID,
      command: 'snapshot',
      args: {},
      target: {},
      limits: { maxAttempts: 3 },
      decision: { actionHash: 'sha256:action', effect: 'allow', expiresAt },
    })).rejects.toMatchObject({
      code: 'bot_browser_recovery_failed',
      transportUncertain: false,
    });
    expect(harness.computerRuntimeManager.restartBot).toHaveBeenCalledTimes(1);
    expect(harness.transport.request).toHaveBeenCalledTimes(2);
  });

  it('proxies attributed take/return control and never reports retained frames', async () => {
    const harness = createHarness();
    const principal = { id: USER_ID, role: 'developer', scope: 'managed' };
    const taken = await harness.service.takeControl({ principal, botId: BOT_ID });
    await harness.service.returnControl({
      principal,
      botId: BOT_ID,
      leaseId: taken.control.leaseId,
    });
    const status = await harness.service.status({ principal, botId: BOT_ID });

    expect(taken.control).toMatchObject({ leaseId: 'control-1', actorId: USER_ID });
    expect(status).toMatchObject({
      framesRecorded: false,
      arbitraryWebsiteExactlyOnce: false,
      screencast: { retainedFrames: 0 },
    });
    expect(harness.eventStream.publish).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'computer.control.take',
    }));
    expect(harness.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'bot.computer.control.return',
    }));
  });

  it('ensures the persistent Active Bot computer when creating a viewer without a run', async () => {
    const harness = createHarness();

    const { view } = await harness.service.startComputerView({
      principal: { id: USER_ID, role: 'developer', scope: 'managed' },
      botId: BOT_ID,
      channelId: CHANNEL_ID,
    });

    expect(view).toMatchObject({ botId: BOT_ID, channelId: CHANNEL_ID });
    expect(harness.computerRuntimeManager.ensureBot).toHaveBeenCalledTimes(1);
    expect(harness.transport.stream).not.toHaveBeenCalled();
  });

  it('never starts a computer for an inactive Bot or an unreadable channel', async () => {
    const principal = { id: USER_ID, role: 'developer', scope: 'managed' };
    const inactive = createHarness();
    inactive.authorization.requireActiveMembership.mockResolvedValue({
      bot: bot({ lifecycle: 'paused' }),
      membership: { role: 'member' },
    });
    await expect(inactive.service.startComputerView({
      principal,
      botId: BOT_ID,
      channelId: CHANNEL_ID,
    })).rejects.toMatchObject({ code: 'bot_computer_lifecycle_inactive' });
    expect(inactive.computerRuntimeManager.ensureBot).not.toHaveBeenCalled();

    const forbidden = createHarness();
    forbidden.authorization.requireChannelRead.mockRejectedValue(Object.assign(
      new Error('forbidden'),
      { code: 'bot_channel_forbidden', statusCode: 403 },
    ));
    await expect(forbidden.service.startComputerView({
      principal,
      botId: BOT_ID,
      channelId: CHANNEL_ID,
    })).rejects.toMatchObject({ code: 'bot_channel_forbidden' });
    expect(forbidden.computerRuntimeManager.ensureBot).not.toHaveBeenCalled();
  });

  it('creates a passive viewer before Chromium has handled any Bot run', async () => {
    const harness = createHarness();
    const principal = { id: USER_ID, role: 'developer', scope: 'managed' };

    const { view } = await harness.service.startComputerView({
      principal,
      botId: BOT_ID,
      channelId: CHANNEL_ID,
    });

    expect(view).toMatchObject({ botId: BOT_ID, channelId: CHANNEL_ID });
    expect(harness.transport.request).not.toHaveBeenCalled();
    expect(harness.transport.stream).not.toHaveBeenCalled();
    expect(harness.computerRuntimeManager.ensureBot).toHaveBeenCalledTimes(1);
  });

  it('creates an ACL-bound one-use passive viewer independent of human control', async () => {
    const harness = createHarness();
    const principal = { id: USER_ID, role: 'developer', scope: 'managed' };

    const { view } = await harness.service.startComputerView({
      principal,
      botId: BOT_ID,
      channelId: CHANNEL_ID,
    });
    const stream = await harness.service.openComputerView({
      principal,
      botId: BOT_ID,
      viewId: view.id,
    });

    expect(stream).toBeInstanceOf(Response);
    expect(view).toMatchObject({
      botId: BOT_ID,
      channelId: CHANNEL_ID,
      streamUrl: `/api/bots/${BOT_ID}/computer/view/${view.id}/stream`,
    });
    expect(harness.authorization.requireActiveMembership).toHaveBeenCalledWith(principal, BOT_ID);
    expect(harness.authorization.requireChannelRead).toHaveBeenCalledWith(
      principal,
      BOT_ID,
      CHANNEL_ID,
    );
    expect(harness.authorization.requireOperator).not.toHaveBeenCalled();
    expect(harness.transport.stream).toHaveBeenCalledWith(expect.objectContaining({
      path: '/v1/screencast',
    }));
    expect(harness.transport.stream.mock.calls[0][0].headers).toBeUndefined();
    await expect(harness.service.openComputerView({
      principal,
      botId: BOT_ID,
      viewId: view.id,
    })).rejects.toMatchObject({ code: 'bot_browser_view_attached' });
    await expect(harness.service.stopComputerView({
      principal: { ...principal, id: 'a0000000-0000-4000-8000-000000000002' },
      botId: BOT_ID,
      viewId: view.id,
    })).rejects.toMatchObject({ code: 'bot_browser_view_not_found' });
    await expect(harness.service.stopComputerView({ principal, botId: BOT_ID, viewId: view.id }))
      .resolves.toEqual({ stopped: true });
  });

  it('expires unattached viewers, survives run settlement, and closes on Bot deactivation', async () => {
    let timestamp = Date.parse('2026-08-25T12:00:00.000Z');
    const harness = createHarness({ now: () => timestamp, viewAttachTtlMs: 1_000 });
    const principal = { id: USER_ID, role: 'developer', scope: 'managed' };
    const expiring = await harness.service.startComputerView({
      principal,
      botId: BOT_ID,
      channelId: CHANNEL_ID,
    });
    timestamp += 1_001;

    await expect(harness.service.openComputerView({
      principal,
      botId: BOT_ID,
      viewId: expiring.view.id,
    })).rejects.toMatchObject({ code: 'bot_browser_view_expired' });

    const attached = await harness.service.startComputerView({
      principal,
      botId: BOT_ID,
      channelId: CHANNEL_ID,
    });
    await harness.service.openComputerView({
      principal,
      botId: BOT_ID,
      viewId: attached.view.id,
    });
    expect(harness.service.onRunSettled).toBeUndefined();
    expect(harness.service.onBotDeactivated({ botId: BOT_ID })).toBe(1);
    await expect(harness.service.stopComputerView({
      principal,
      botId: BOT_ID,
      viewId: attached.view.id,
    })).resolves.toEqual({ stopped: false });
  });
});
