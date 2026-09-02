import { describe, expect, it, vi } from 'vitest';

import {
  BotBrowserServiceError,
  botBrowserOperationKind,
  classifyBotBrowserRemoteFailure,
  createBotBrowserService,
  publicBotComputerBrowserStatus,
  safeBotBrowserAuditRemoteCode,
  validateBotBrowserAction,
  validateBotHumanInput,
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

it('projects only the typed privacy-safe Bot browser status contract', () => {
  const projected = publicBotComputerBrowserStatus({
    running: true,
    healthy: true,
    lifecycleState: 'running',
    generation: 4,
    mode: 'headed_virtual',
    engineVersion: 'Chromium/151.0',
    displayReady: true,
    webCapabilities: {
      managedPolicy: 'enforced',
      javascript: 'enabled',
      firstPartyCookies: 'enabled',
      thirdPartyCookies: 'enabled',
      cookieValue: 'secret',
    },
    lastNavigationDiagnostic: {
      revision: 7,
      observedAt: 1234,
      origin: 'https://airtable.com/private/path?token=secret',
      statusCode: 200,
      redirectCount: 2,
      repetitionCount: 3,
      kind: 'site_rejection',
      reason: 'navigation_loop',
      blockedHost: null,
      headers: { cookie: 'secret' },
      pageText: 'private challenge',
      trail: [
        {
          kind: 'navigation',
          origin: 'https://airtable.com',
          path: '/private/path?token=secret',
          statusCode: 302,
          redirectCount: 1,
          observedAt: 1230,
        },
        {
          kind: 'navigation',
          origin: 'https://airtable.com',
          path: '/login/abcdefghijklmnop',
          statusCode: 200,
          redirectCount: 2,
          observedAt: 1234,
        },
      ],
      cookieBlocks: [{
        origin: 'https://airtable.com', path: '/login', reason: 'SameSiteUnspecifiedTreatedAsLax', observedAt: 1233,
      }],
      dialogs: [{
        kind: 'dialog', origin: 'https://airtable.com', path: '/login', type: 'confirm', message: 'Continue?', observedAt: 1234,
      }],
    },
    activeTargetCount: 2,
    popupOpen: true,
    rawNetworkEvents: [{ url: 'https://secret.example/private' }],
  });

  expect(projected).toMatchObject({
    mode: 'headed_virtual',
    engineVersion: 'Chromium/151.0',
    displayReady: true,
    webCapabilities: {
      managedPolicy: 'enforced',
      javascript: 'enabled',
      firstPartyCookies: 'enabled',
      thirdPartyCookies: 'enabled',
    },
    lastNavigationDiagnostic: {
      revision: 7,
      origin: 'https://airtable.com',
      kind: 'site_rejection',
      trail: [expect.objectContaining({ path: '/login/*' })],
      cookieBlocks: [expect.objectContaining({ path: '/login' })],
      dialogs: [expect.objectContaining({ type: 'confirm', message: 'Continue?' })],
    },
    activeTargetCount: 2,
    popupOpen: true,
  });
  const serialized = JSON.stringify(projected);
  expect(serialized).not.toContain('/private');
  expect(serialized).not.toContain('secret');
  expect(serialized).not.toContain('cookieValue');
  expect(serialized).not.toContain('pageText');
  expect(serialized).not.toContain('abcdefghijklmnop');
});

const createHarness = ({
  now,
  viewAttachTtlMs,
  recordDiagnostic = vi.fn(),
  computerRuntimeManager: managerOverride = null,
  transport: transportOverride = null,
} = {}) => {
  const responses = [];
  const transport = transportOverride || {
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
  const logger = { warn: vi.fn() };
  const service = createBotBrowserService({
    store,
    authorization,
    gatewayHost,
    computerRuntimeManager,
    eventStream,
    audit,
    recordDiagnostic,
    transport,
    logger,
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
    logger,
    recordDiagnostic,
    authorization,
    responses,
  };
};

describe('Bot governed browser service', () => {
  it('relinquishes the stream-owned control lease after account access is revoked', async () => {
    const harness = createHarness();
    const principal = { id: USER_ID, role: 'developer', scope: 'managed' };
    const { view } = await harness.service.startComputerView({ principal, botId: BOT_ID, channelId: CHANNEL_ID });
    await harness.service.openComputerView({ principal, botId: BOT_ID, viewId: view.id });
    await harness.service.takeControl({ principal, botId: BOT_ID });
    harness.authorization.requireOperator.mockRejectedValue(new Error('Access was revoked'));
    harness.authorization.requireActiveMembership.mockRejectedValue(new Error('Access was revoked'));
    await harness.service.stopComputerView({ principal, botId: BOT_ID, viewId: view.id });
    expect(harness.transport.request).toHaveBeenLastCalledWith(expect.objectContaining({
      path: '/v1/control/return',
      body: { actorId: USER_ID, actorType: 'user', leaseId: 'control-1' },
    }));
    expect(harness.transport.stream.mock.calls[0][0].signal.aborted).toBe(true);
    await harness.service.stopComputerView({ principal, botId: BOT_ID, viewId: view.id });
    expect(harness.transport.request.mock.calls.filter(([request]) => request.path === '/v1/control/return')).toHaveLength(1);
    await harness.service.shutdown();
  });

  it('releases a late takeover before a replacement viewer can acquire control', async () => {
    const harness = createHarness();
    const principal = { id: USER_ID, role: 'developer', scope: 'managed' };
    const { view } = await harness.service.startComputerView({ principal, botId: BOT_ID, channelId: CHANNEL_ID });
    let finishTake;
    let enteredTake;
    const entered = new Promise((resolve) => { enteredTake = resolve; });
    const order = [];
    harness.transport.request.mockImplementation(async ({ path, body }) => {
      order.push(path);
      if (path === '/v1/control/take' && !finishTake) {
        enteredTake();
        return new Promise((resolve) => { finishTake = () => resolve({ ...body, leaseId: 'old-control', expiresAt: 31_000 }); });
      }
      if (path === '/v1/control/take') return { ...body, leaseId: 'new-control', expiresAt: 31_000 };
      return { returned: true };
    });
    const taking = harness.service.takeControl({ principal, botId: BOT_ID });
    const rejected = expect(taking).rejects.toMatchObject({ code: 'bot_browser_view_not_found' });
    await entered;
    await harness.service.stopComputerView({ principal, botId: BOT_ID, viewId: view.id });
    await harness.service.startComputerView({ principal, botId: BOT_ID, channelId: CHANNEL_ID });
    const replacement = harness.service.takeControl({ principal, botId: BOT_ID });
    finishTake();
    await rejected;
    expect((await replacement).control.leaseId).toBe('new-control');
    expect(order).toEqual(['/v1/control/take', '/v1/control/return', '/v1/control/take']);
    await harness.service.shutdown();
  });

  it('does not return another control lease when a passive viewer closes', async () => {
    const harness = createHarness();
    const principal = { id: USER_ID, role: 'developer', scope: 'managed' };
    const { view } = await harness.service.startComputerView({ principal, botId: BOT_ID, channelId: CHANNEL_ID });
    await harness.service.openComputerView({ principal, botId: BOT_ID, viewId: view.id });
    await harness.service.stopComputerView({ principal, botId: BOT_ID, viewId: view.id });
    expect(harness.transport.request.mock.calls.some(([request]) => request.path === '/v1/control/return')).toBe(false);
    await harness.service.shutdown();
  });

  it('automatic viewing rejects stale run ownership and terminates its stream on handoff', async () => {
    const { service, transport } = createHarness();
    await service.activity.begin(run());
    const { view } = await service.startComputerView({ principal: { id: USER_ID }, botId: BOT_ID, channelId: CHANNEL_ID, runId: RUN_ID });
    await service.openComputerView({ principal: { id: USER_ID }, botId: BOT_ID, viewId: view.id });
    const streamSignal = transport.stream.mock.calls[0][0].signal;
    expect(streamSignal.aborted).toBe(false);
    await service.activity.begin({ ...run(), id: 'd0000000-0000-4000-8000-000000000002' });
    expect(streamSignal.aborted).toBe(true);
    await expect(service.startComputerView({ principal: { id: USER_ID }, botId: BOT_ID, channelId: CHANNEL_ID, runId: RUN_ID })).rejects.toMatchObject({ code: 'bot_computer_activity_changed' });
    await service.shutdown();
  });

  it('handoff while start audit waits cannot return a resurrected view ticket', async () => {
    const { service, audit } = createHarness();
    await service.activity.begin(run());
    let releaseAudit;
    const waiting = new Promise((resolve) => { releaseAudit = resolve; });
    audit.mockImplementationOnce(() => waiting);
    const start = service.startComputerView({ principal: { id: USER_ID }, botId: BOT_ID, channelId: CHANNEL_ID, runId: RUN_ID });
    for (let index = 0; index < 20 && audit.mock.calls.length === 0; index++) await Promise.resolve();
    expect(audit).toHaveBeenCalled();
    await service.activity.endRun(run());
    releaseAudit();
    await expect(start).rejects.toMatchObject({ code: 'bot_computer_activity_changed' });
    await service.shutdown();
  });
  it('separates safe reads from potentially mutating interactions', () => {
    for (const command of ['navigate', 'snapshot', 'scroll', 'wait', 'download', 'screenshot']) {
      expect(botBrowserOperationKind(command)).toBe('read');
    }
    for (const command of ['click', 'fill', 'select', 'key', 'upload']) {
      expect(botBrowserOperationKind(command)).toBe('write');
    }
    expect(() => botBrowserOperationKind('evaluate')).toThrow(/not reviewed/i);
    // Closing the persistent browser would sign the Bot out of every site.
    expect(() => botBrowserOperationKind('close')).toThrow(/not reviewed/i);
    expect(() => botBrowserOperationKind('CLOSE')).toThrow(/not reviewed/i);
  });

  it('classifies only browser transport loss as uncertain and recoverable', () => {
    expect(classifyBotBrowserRemoteFailure({
      statusCode: 503,
      remoteCode: 'DEVRYAN_BOT_BROWSER_CLOSED',
    })).toEqual({
      code: 'bot_browser_command_failed',
      transportUncertain: true,
      recoverable: true,
      preExecution: false,
    });
    expect(classifyBotBrowserRemoteFailure({
      statusCode: 504,
      remoteCode: 'DEVRYAN_BOT_BROWSER_COMMAND_TIMEOUT',
    })).toMatchObject({ transportUncertain: true, recoverable: true });
    expect(classifyBotBrowserRemoteFailure({
      statusCode: 502,
      remoteCode: 'DEVRYAN_BOT_NAVIGATION_FAILED',
    })).toMatchObject({ transportUncertain: false, recoverable: false });
    expect(classifyBotBrowserRemoteFailure({
      statusCode: 409,
      remoteCode: 'DEVRYAN_BOT_CONTROL_HELD',
    })).toEqual({
      code: 'bot_browser_control_held',
      transportUncertain: false,
      recoverable: true,
      preExecution: true,
    });
    expect(classifyBotBrowserRemoteFailure({
      statusCode: 409,
      remoteCode: 'DEVRYAN_BOT_REF_STALE',
    })).toMatchObject({ code: 'bot_browser_reference_stale', preExecution: true });
    expect(classifyBotBrowserRemoteFailure({
      statusCode: 409,
      remoteCode: 'DEVRYAN_BOT_TARGET_NOT_VISIBLE',
    })).toMatchObject({ code: 'bot_browser_target_not_visible', preExecution: true });
    expect(classifyBotBrowserRemoteFailure({
      statusCode: 409,
      remoteCode: 'DEVRYAN_BOT_CONTROL_CONFLICT',
    })).toMatchObject({ code: 'bot_browser_control_conflict' });
    expect(classifyBotBrowserRemoteFailure({
      statusCode: 409,
      remoteCode: 'DEVRYAN_BOT_SOMETHING_NEW',
    })).toMatchObject({ code: 'bot_browser_conflict' });
    expect(safeBotBrowserAuditRemoteCode('DEVRYAN_BOT_REF_STALE'))
      .toBe('DEVRYAN_BOT_REF_STALE');
    expect(safeBotBrowserAuditRemoteCode('DEVRYAN_BOT_SOMETHING_NEW')).toBeNull();
  });

  it('waits across renewed human-control leases until authoritative return or expiry', async () => {
    const timestamp = Date.now();
    const statusResponses = [
      { control: { leaseId: 'lease-1', actorId: USER_ID, actorType: 'user', expiresAt: timestamp + 1 } },
      { control: { leaseId: 'lease-1', actorId: USER_ID, actorType: 'user', expiresAt: timestamp + 30_000 } },
      { control: null },
    ];
    const transport = {
      request: vi.fn(async ({ path }) => (
        path === '/v1/status' ? statusResponses.shift() : { clicked: true }
      )),
      stream: vi.fn(async () => new Response('frame')),
    };
    const harness = createHarness({ transport });
    const waiting = harness.service.waitForControlRelease({
      run: run(),
      bot: bot(),
      ownerUserId: USER_ID,
    });
    await expect(waiting).resolves.toEqual({ released: true });
    expect(transport.request).toHaveBeenCalledTimes(3);
  });

  it('keeps cancellation available while browser control is held', async () => {
    const controller = new AbortController();
    const transport = {
      request: vi.fn(async () => ({
        control: { leaseId: 'lease-1', actorId: USER_ID, actorType: 'user', expiresAt: Date.now() + 30_000 },
      })),
      stream: vi.fn(async () => new Response('frame')),
    };
    const harness = createHarness({ transport });
    const waiting = harness.service.waitForControlRelease({
      run: run(),
      bot: bot(),
      ownerUserId: USER_ID,
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'bot_run_cancelled', preExecution: true });
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

  it('aggregates private human input into one content-free row per control lease', async () => {
    const harness = createHarness();
    const principal = { id: USER_ID, role: 'admin', scope: 'managed' };
    const events = [
      { type: 'pointer', phase: 'move', x: 100, y: 200, button: 'none', buttons: 0, clickCount: 0 },
      { type: 'text', text: 'private input' },
    ];
    const { view } = await harness.service.startComputerView({
      principal,
      botId: BOT_ID,
      channelId: CHANNEL_ID,
    });

    await expect(harness.service.humanCommand({
      principal,
      botId: BOT_ID,
      viewId: view.id,
      leaseId: 'control-1',
      command: 'input',
      args: { events },
    })).rejects.toMatchObject({ code: 'bot_browser_view_not_found' });

    await harness.service.openComputerView({ principal, botId: BOT_ID, viewId: view.id });
    const taken = await harness.service.takeControl({ principal, botId: BOT_ID });
    await harness.service.humanCommand({
      principal,
      botId: BOT_ID,
      viewId: view.id,
      leaseId: taken.control.leaseId,
      command: 'input',
      args: { events },
    });
    await harness.service.humanCommand({
      principal,
      botId: BOT_ID,
      viewId: view.id,
      leaseId: taken.control.leaseId,
      command: 'input',
      args: { events },
    });

    expect(harness.transport.request).toHaveBeenLastCalledWith(expect.objectContaining({
      path: '/v1/control/command',
      body: expect.objectContaining({ command: 'input', args: { events } }),
    }));
    expect(harness.audit.mock.calls.some(([entry]) => (
      entry.action === 'bot.computer.human_command' && entry.result === 'success'
    ))).toBe(false);
    expect(harness.audit.mock.calls.some(([entry]) => entry.action === 'bot.computer.human_session'))
      .toBe(false);
    await harness.service.returnControl({
      principal,
      botId: BOT_ID,
      leaseId: taken.control.leaseId,
    });
    const sessionAudit = harness.audit.mock.calls.find(([entry]) => (
      entry.action === 'bot.computer.human_session'
    ))?.[0];
    const metadata = sessionAudit?.metadata;
    expect(metadata).toMatchObject({
      viewId: view.id,
      endedBy: 'return',
      commandCount: 2,
      eventCount: 4,
      eventCountByType: { pointer: 2, text: 2 },
    });
    expect(JSON.stringify(metadata)).not.toContain('private input');
    expect(JSON.stringify(metadata)).not.toContain('"x"');
    expect(() => validateBotHumanInput({ events: Array.from({ length: 33 }, () => events[0]) }))
      .toThrow(/batch/i);
  });

  it('returns human input after CDP dispatch without writing a per-batch success audit', async () => {
    const harness = createHarness();
    const principal = { id: USER_ID, role: 'admin', scope: 'managed' };
    const { view } = await harness.service.startComputerView({
      principal,
      botId: BOT_ID,
      channelId: CHANNEL_ID,
    });
    await harness.service.openComputerView({ principal, botId: BOT_ID, viewId: view.id });
    const auditCount = harness.audit.mock.calls.length;

    await expect(harness.service.humanCommand({
      principal,
      botId: BOT_ID,
      viewId: view.id,
      leaseId: 'control-1',
      command: 'input',
      args: {
        events: [{
          type: 'pointer', phase: 'down', x: 100, y: 200,
          button: 'left', buttons: 1, clickCount: 1,
        }],
      },
    })).resolves.toEqual({ clicked: true });
    expect(harness.audit).toHaveBeenCalledTimes(auditCount);
  });

  it('audits a failed human input batch individually without retaining input content', async () => {
    const harness = createHarness();
    const principal = { id: USER_ID, role: 'admin', scope: 'managed' };
    const { view } = await harness.service.startComputerView({ principal, botId: BOT_ID, channelId: CHANNEL_ID });
    await harness.service.openComputerView({ principal, botId: BOT_ID, viewId: view.id });
    harness.transport.request.mockRejectedValueOnce(new BotBrowserServiceError(
      'private failure text',
      'bot_browser_conflict',
      409,
      { remoteCode: 'DEVRYAN_BOT_CONTROL_NOT_OWNER' },
    ));

    await expect(harness.service.humanCommand({
      principal,
      botId: BOT_ID,
      viewId: view.id,
      leaseId: 'expired-control',
      command: 'input',
      args: { events: [{ type: 'text', text: 'private input' }] },
    })).rejects.toMatchObject({ code: 'bot_browser_conflict' });

    const failure = harness.audit.mock.calls.find(([entry]) => (
      entry.action === 'bot.computer.human_command' && entry.result === 'failure'
    ))?.[0];
    expect(failure?.metadata).toMatchObject({
      controlLeaseId: 'expired-control',
      eventTypes: ['text'],
      eventCount: 1,
      code: 'bot_browser_conflict',
      status: 409,
    });
    expect(JSON.stringify(failure)).not.toContain('private input');
    expect(JSON.stringify(failure)).not.toContain('private failure');
  });

  it('flushes aggregate input when an expired heartbeat loses control ownership', async () => {
    const harness = createHarness();
    const principal = { id: USER_ID, role: 'admin', scope: 'managed' };
    const { view } = await harness.service.startComputerView({ principal, botId: BOT_ID, channelId: CHANNEL_ID });
    await harness.service.openComputerView({ principal, botId: BOT_ID, viewId: view.id });
    const taken = await harness.service.takeControl({ principal, botId: BOT_ID });
    await harness.service.humanCommand({
      principal, botId: BOT_ID, viewId: view.id, leaseId: taken.control.leaseId,
      command: 'input', args: { events: [{ type: 'text', text: 'private input' }] },
    });
    harness.transport.request.mockRejectedValueOnce(new BotBrowserServiceError(
      'expired control',
      'bot_browser_conflict',
      409,
      { remoteCode: 'DEVRYAN_BOT_CONTROL_NOT_OWNER' },
    ));

    await expect(harness.service.heartbeatControl({
      principal,
      botId: BOT_ID,
      leaseId: taken.control.leaseId,
    })).rejects.toMatchObject({ code: 'bot_browser_conflict' });
    expect(harness.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'bot.computer.human_session',
      result: 'success',
      metadata: expect.objectContaining({ endedBy: 'expired', commandCount: 1, eventCount: 1 }),
    }));
  });

  it('preserves the browser error when the failed-input audit cannot be written', async () => {
    const harness = createHarness();
    const principal = { id: USER_ID, role: 'admin', scope: 'managed' };
    const { view } = await harness.service.startComputerView({ principal, botId: BOT_ID, channelId: CHANNEL_ID });
    await harness.service.openComputerView({ principal, botId: BOT_ID, viewId: view.id });
    harness.transport.request.mockRejectedValueOnce(new BotBrowserServiceError(
      'private browser failure',
      'bot_browser_conflict',
      409,
    ));
    harness.audit.mockRejectedValueOnce(new Error('private audit failure'));

    await expect(harness.service.humanCommand({
      principal,
      botId: BOT_ID,
      viewId: view.id,
      leaseId: 'control-1',
      command: 'input',
      args: { events: [{ type: 'text', text: 'private input' }] },
    })).rejects.toMatchObject({ code: 'bot_browser_conflict' });
    expect(harness.logger.warn).toHaveBeenCalledWith(
      '[BotsComputer] human-command failure audit failed',
      expect.objectContaining({ code: 'bot_computer_audit_failed', botId: BOT_ID }),
    );
    expect(JSON.stringify(harness.logger.warn.mock.calls)).not.toContain('private');
  });

  it('flushes an aggregate human session when its viewer closes and at shutdown', async () => {
    const principal = { id: USER_ID, role: 'admin', scope: 'managed' };
    for (const endedBy of ['cleanup', 'shutdown']) {
      const harness = createHarness();
      const { view } = await harness.service.startComputerView({ principal, botId: BOT_ID, channelId: CHANNEL_ID });
      await harness.service.openComputerView({ principal, botId: BOT_ID, viewId: view.id });
      const taken = await harness.service.takeControl({ principal, botId: BOT_ID });
      await harness.service.humanCommand({
        principal, botId: BOT_ID, viewId: view.id, leaseId: taken.control.leaseId,
        command: 'input', args: { events: [{ type: 'key', phase: 'down', key: 'Tab', code: 'Tab', location: 0, repeat: false, modifiers: [] }] },
      });
      if (endedBy === 'cleanup') {
        await harness.service.stopComputerView({ principal, botId: BOT_ID, viewId: view.id });
      } else {
        await harness.service.shutdown();
      }
      expect(harness.audit).toHaveBeenCalledWith(expect.objectContaining({
        action: 'bot.computer.human_session',
        metadata: expect.objectContaining({ endedBy, commandCount: 1, eventCount: 1 }),
      }));
    }
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

  it('journals recovery and supervisor failure stages with the action identity', async () => {
    const recordDiagnostic = vi.fn();
    const harness = createHarness({ recordDiagnostic });
    harness.transport.request.mockRejectedValueOnce(new BotBrowserServiceError(
      'browser closed', 'bot_browser_command_failed', 503,
      { transportUncertain: true, remoteCode: 'DEVRYAN_BOT_BROWSER_CLOSED' },
    ));
    harness.computerRuntimeManager.restartBot.mockRejectedValueOnce(Object.assign(new Error('Supervisor unavailable'), {
      code: 'bot_runtime_supervisor_unavailable', diagnostics: { stage: 'supervisor_request', reason: 'ECONNRESET' },
    }));
    await expect(harness.service.executeAction({
      run: run(), bot: bot(), ownerUserId: USER_ID, actionAttemptId: 'action-1',
      command: 'navigate', args: { url: 'https://example.com' }, target: { origin: 'https://example.com' },
      limits: {}, decision: { actionHash: 'sha256:action', effect: 'allow', expiresAt: new Date(Date.now() + 60_000).toISOString() },
    })).rejects.toMatchObject({ code: 'bot_runtime_supervisor_unavailable' });
    expect(recordDiagnostic.mock.calls.map(([record]) => record.payload.stage))
      .toEqual(['command_failed', 'runtime_restart_failed']);
    expect(recordDiagnostic.mock.calls[1][0].payload).toMatchObject({
      runId: RUN_ID, operationId: 'action-1', error: { stage: 'supervisor_request', reason: 'ECONNRESET' },
    });
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
    await harness.service.heartbeatControl({
      principal,
      botId: BOT_ID,
      leaseId: taken.control.leaseId,
    });
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
    expect(harness.audit.mock.calls.some(([entry]) => (
      entry.action === 'bot.computer.control.heartbeat'
    ))).toBe(false);
  });

  it('audits each navigation-loop diagnostic revision once with a privacy-safe trail', async () => {
    const recordDiagnostic = vi.fn();
    const harness = createHarness({ recordDiagnostic });
    const principal = { id: USER_ID, role: 'admin', scope: 'managed' };
    let revision = 4;
    harness.transport.request.mockImplementation(async ({ path }) => {
      if (path !== '/v1/status') return { clicked: true };
      return {
        browser: {
          running: true,
          generation: 2,
          lastNavigationDiagnostic: {
            revision,
            observedAt: 100,
            origin: 'https://example.com',
            statusCode: 200,
            redirectCount: 1,
            repetitionCount: 3,
            kind: 'site_rejection',
            reason: 'navigation_loop',
            trail: [{
              kind: 'navigation', origin: 'https://example.com', path: '/login',
              statusCode: 200, redirectCount: 1, observedAt: 100,
            }],
          },
        },
        control: { leaseId: 'lease-1', actorId: USER_ID, actorType: 'admin', takenAt: 1, expiresAt: 1000 },
        screencast: {},
      };
    });

    await harness.service.status({ principal, botId: BOT_ID });
    await harness.service.status({ principal, botId: BOT_ID });
    await vi.waitFor(() => expect(harness.audit.mock.calls.filter(([entry]) => (
      entry.action === 'bot.computer.navigation_loop'
    ))).toHaveLength(1));
    revision += 1;
    await harness.service.status({ principal, botId: BOT_ID });
    await vi.waitFor(() => expect(harness.audit.mock.calls.filter(([entry]) => (
      entry.action === 'bot.computer.navigation_loop'
    ))).toHaveLength(2));
    expect(recordDiagnostic).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(harness.audit.mock.calls)).not.toContain('?');
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
