import { randomBytes } from 'node:crypto';

import {
  BOT_BROWSER_MUTATING_ACTIONS,
  BOT_BROWSER_READ_ACTIONS,
} from './policy-engine.js';
import {
  assertExactObject,
  validateBoundedJsonObject,
  validateBoundedString,
  validateUuid,
} from './validation.js';

const COMPUTER_RESPONSE_LIMIT = 5 * 1024 * 1024;
const COMPUTER_REQUEST_TIMEOUT_MS = 35_000;
const VIEW_ATTACH_TTL_MS = 15_000;
const ACTIVE_RUN_STATES = new Set([
  'starting',
  'running',
  'waiting_approval',
  'needs_reconciliation',
]);
const ALL_BROWSER_ACTIONS = new Set([
  ...BOT_BROWSER_READ_ACTIONS,
  ...BOT_BROWSER_MUTATING_ACTIONS,
  'close',
]);
const RECOVERABLE_REMOTE_CODES = new Set([
  'DEVRYAN_BOT_BROWSER_CLOSED',
  'DEVRYAN_BOT_BROWSER_COMMAND_TIMEOUT',
  'DEVRYAN_BOT_BROWSER_START_FAILED',
]);
const UNCERTAIN_REMOTE_CODES = new Set([
  'DEVRYAN_BOT_BROWSER_CLOSED',
  'DEVRYAN_BOT_BROWSER_COMMAND_TIMEOUT',
]);

export class BotBrowserServiceError extends Error {
  constructor(
    message,
    code = 'bot_browser_invalid',
    statusCode = 400,
    { transportUncertain = false, remoteCode = null } = {},
  ) {
    super(message);
    this.name = 'BotBrowserServiceError';
    this.code = code;
    this.statusCode = statusCode;
    this.transportUncertain = transportUncertain;
    this.remoteCode = remoteCode;
  }
}

const fail = (message, code, statusCode, options) => {
  throw new BotBrowserServiceError(message, code, statusCode, options);
};

export const classifyBotBrowserRemoteFailure = ({ statusCode, remoteCode } = {}) => Object.freeze({
  code: statusCode === 409 ? 'bot_browser_control_conflict' : 'bot_browser_command_failed',
  transportUncertain: UNCERTAIN_REMOTE_CODES.has(remoteCode),
  recoverable: RECOVERABLE_REMOTE_CODES.has(remoteCode),
});

export const botBrowserOperationKind = (command) => {
  const normalized = typeof command === 'string' ? command.trim().toLowerCase() : '';
  if (!ALL_BROWSER_ACTIONS.has(normalized)) {
    fail('Browser command is not reviewed', 'bot_browser_command_denied', 403);
  }
  return BOT_BROWSER_READ_ACTIONS.includes(normalized) ? 'read' : 'write';
};

const normalizeOrigin = (value, field) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${field} is invalid`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    fail(`${field} is invalid`);
  }
  return url.origin;
};

export const validateBotBrowserAction = ({ command, args, target, limits } = {}) => {
  const normalizedCommand = validateBoundedString(command, 'command', { maximum: 120 }).toLowerCase();
  const operationKind = botBrowserOperationKind(normalizedCommand);
  const normalizedArgs = validateBoundedJsonObject(args ?? {}, 'args', 64 * 1024);
  const normalizedTarget = validateBoundedJsonObject(target ?? {}, 'target', 16 * 1024);
  const normalizedLimits = validateBoundedJsonObject(limits ?? {}, 'limits', 16 * 1024);
  let origin = null;
  if (normalizedTarget.origin !== undefined) {
    origin = normalizeOrigin(normalizedTarget.origin, 'target.origin');
    normalizedTarget.origin = origin;
  }
  if (normalizedCommand === 'navigate') {
    const navigationOrigin = normalizeOrigin(normalizedArgs.url, 'args.url');
    if (origin !== null && origin !== navigationOrigin) {
      fail('Browser navigation target does not match its bounded origin', 'bot_browser_scope_denied', 403);
    }
    normalizedTarget.origin = navigationOrigin;
  }
  if (operationKind === 'write') {
    const goal = typeof normalizedTarget.goal === 'string' ? normalizedTarget.goal.trim() : '';
    if (!normalizedTarget.origin || !goal || goal.length > 512) {
      fail(
        'Browser interactions require a bounded origin and goal',
        'bot_browser_capability_required',
        409,
      );
    }
    normalizedTarget.goal = goal;
  }
  return Object.freeze({
    command: normalizedCommand,
    operationKind,
    args: normalizedArgs,
    target: normalizedTarget,
    limits: normalizedLimits,
  });
};

const readBoundedBody = async (response, maximumBytes = COMPUTER_RESPONSE_LIMIT) => {
  const declared = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    fail('Bot computer response is too large', 'bot_browser_response_too_large', 502);
  }
  if (!response?.body || typeof response.body.getReader !== 'function') {
    fail('Bot computer response is invalid', 'bot_browser_response_invalid', 502);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      fail('Bot computer response is too large', 'bot_browser_response_too_large', 502);
    }
    chunks.push(Buffer.from(value));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    fail('Bot computer response is invalid', 'bot_browser_response_invalid', 502);
  }
};

const defaultTransport = Object.freeze({
  async request({ runtime, path, method = 'POST', body = null, headers = {}, signal }) {
    let response;
    try {
      const timeout = AbortSignal.timeout(COMPUTER_REQUEST_TIMEOUT_MS);
      response = await fetch(`${runtime.endpoint.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${runtime.token}`,
          ...(body === null ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body === null ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      throw new BotBrowserServiceError(
        'Bot computer transport failed',
        'bot_browser_transport_failed',
        502,
        {
          transportUncertain: true,
          remoteCode: signal?.aborted ? 'DEVRYAN_BOT_COMMAND_ABORTED' : (error?.code || null),
        },
      );
    }
    const payload = await readBoundedBody(response);
    if (!response.ok || payload?.ok !== true) {
      const remoteCode = payload?.error?.code || null;
      const classification = classifyBotBrowserRemoteFailure({
        statusCode: response.status,
        remoteCode,
      });
      throw new BotBrowserServiceError(
        'Bot computer rejected the request',
        classification.code,
        response.status >= 400 && response.status <= 599 ? response.status : 502,
        { transportUncertain: classification.transportUncertain, remoteCode },
      );
    }
    return payload.result ?? payload.lease ?? payload;
  },

  async stream({ runtime, path, headers = {}, signal }) {
    try {
      const response = await fetch(`${runtime.endpoint.baseUrl}${path}`, {
        headers: {
          authorization: `Bearer ${runtime.token}`,
          ...headers,
        },
        redirect: 'error',
        signal,
      });
      if (!response.ok || !response.body) {
        throw new BotBrowserServiceError(
          'Bot computer screencast was rejected',
          'bot_browser_screencast_failed',
          response.status || 502,
        );
      }
      return response;
    } catch (error) {
      if (error instanceof BotBrowserServiceError) throw error;
      throw new BotBrowserServiceError(
        'Bot computer screencast is unavailable',
        'bot_browser_screencast_failed',
        502,
      );
    }
  },
});

const publicControl = (value) => {
  if (!value || typeof value !== 'object') return null;
  return Object.freeze({
    leaseId: typeof value.leaseId === 'string' ? value.leaseId : null,
    actorId: typeof value.actorId === 'string' ? value.actorId : null,
    actorType: typeof value.actorType === 'string' ? value.actorType : null,
    takenAt: Number.isFinite(value.takenAt) ? value.takenAt : null,
    expiresAt: Number.isFinite(value.expiresAt) ? value.expiresAt : null,
  });
};

export function createBotBrowserService({
  store,
  authorization,
  gatewayHost,
  computerRuntimeManager,
  eventStream,
  audit = async () => {},
  transport = defaultTransport,
  now = Date.now,
  randomBytesImpl = randomBytes,
  viewAttachTtlMs = VIEW_ATTACH_TTL_MS,
} = {}) {
  if (!store?.repositories?.bot_runs || !store.repositories?.bots
    || !store.repositories?.bot_channels || !authorization
    || typeof authorization.requireOperator !== 'function'
    || typeof authorization.requireActiveMembership !== 'function'
    || typeof authorization.requireChannelRead !== 'function'
    || !computerRuntimeManager || typeof computerRuntimeManager.ensureBot !== 'function'
    || typeof computerRuntimeManager.restartBot !== 'function'
    || !gatewayHost || typeof gatewayHost.issueCapability !== 'function'
    || typeof gatewayHost.revokeCapability !== 'function'
    || !eventStream || typeof eventStream.publish !== 'function'
    || typeof audit !== 'function' || typeof transport?.request !== 'function'
    || typeof transport?.stream !== 'function' || typeof now !== 'function'
    || typeof randomBytesImpl !== 'function' || !Number.isInteger(viewAttachTtlMs)
    || viewAttachTtlMs < 1_000 || viewAttachTtlMs > 60_000) {
    throw new TypeError('Bot browser service is misconfigured');
  }
  const runtimes = new Map();
  const scopeLocks = new Map();
  const viewSessions = new Map();

  const withScopeLock = (scopeKey, operation) => {
    const previous = scopeLocks.get(scopeKey) || Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    scopeLocks.set(scopeKey, current);
    return current.finally(() => {
      if (scopeLocks.get(scopeKey) === current) scopeLocks.delete(scopeKey);
    });
  };

  const audienceForBot = async (botId, fallbackUserId = null) => {
    const page = await store.repositories.bot_memberships?.list?.({
      filters: { bot_id: botId, revoked_at: null },
      limit: 100,
    });
    const users = new Set((page?.items || []).map((membership) => membership.user_id));
    if (fallbackUserId) users.add(fallbackUserId);
    return [...users];
  };

  const loadRunContext = async (runId) => {
    const run = await store.repositories.bot_runs.get({ id: validateUuid(runId, 'runId') });
    if (!run) fail('Bot run not found', 'bot_run_not_found', 404);
    const [bot, channel] = await Promise.all([
      store.repositories.bots.get({ id: run.bot_id }),
      store.repositories.bot_channels.get({ id: run.channel_id, bot_id: run.bot_id }),
    ]);
    if (!bot || !channel) fail('Bot computer scope is unavailable', 'bot_run_context_missing', 409);
    return Object.freeze({ run, bot, channel });
  };

  const requireActiveBot = (bot) => {
    if (!bot || bot.lifecycle !== 'active' || !bot.active_revision_id) {
      fail('Only an Active Bot owns a running computer', 'bot_computer_lifecycle_inactive', 409);
    }
    return bot;
  };

  const authorizedBotContext = async (principal, botId, { operator = false } = {}) => {
    const authorized = operator
      ? await authorization.requireOperator(principal, validateUuid(botId, 'botId'))
      : await authorization.requireActiveMembership(principal, validateUuid(botId, 'botId'));
    return Object.freeze({ bot: requireActiveBot(authorized.bot) });
  };

  const authorizedViewerContext = async (principal, botId, channelId) => {
    const normalizedBotId = validateUuid(botId, 'botId');
    const normalizedChannelId = validateUuid(channelId, 'channelId');
    const [{ bot }, channelAccess] = await Promise.all([
      authorization.requireActiveMembership(principal, normalizedBotId),
      authorization.requireChannelRead(principal, normalizedBotId, normalizedChannelId),
    ]);
    return Object.freeze({
      bot: requireActiveBot(bot),
      channel: channelAccess.channel,
    });
  };

  const runtimeForBot = async (bot) => {
    const runtime = await computerRuntimeManager.ensureBot(requireActiveBot(bot));
    if (!runtime?.endpoint || typeof runtime.token !== 'string') {
      fail('Bot computer runtime is unavailable', 'bot_computer_runtime_unavailable', 503);
    }
    return runtime;
  };

  const ensureRuntime = ({ run, bot, ownerUserId }) => withScopeLock(
    run.computer_scope_key,
    async () => {
      const current = runtimes.get(run.computer_scope_key);
      if (current?.runId === run.id && current.revisionId === run.revision_id) return current;
      if (!ACTIVE_RUN_STATES.has(run.state)) {
        fail('Bot run does not own a live computer lease', 'bot_browser_run_inactive', 409);
      }
      if (current?.gatewayToken) gatewayHost.revokeCapability(current.gatewayToken);
      const computer = await runtimeForBot(bot);
      const runtime = Object.freeze({
        runId: run.id,
        botId: run.bot_id,
        channelId: run.channel_id,
        revisionId: run.revision_id,
        scopeKey: run.computer_scope_key,
        tenancy: bot.tenancy,
        ownerUserId,
        token: computer.token,
        gatewayToken: null,
        endpoint: computer.endpoint,
      });
      runtimes.set(run.computer_scope_key, runtime);
      return runtime;
    },
  );

  const recoverRuntime = ({ run, bot, ownerUserId, failedRuntime }) => withScopeLock(
    run.computer_scope_key,
    async () => {
      const current = runtimes.get(run.computer_scope_key);
      if (current && current !== failedRuntime) return current;
      if (current?.gatewayToken) gatewayHost.revokeCapability(current.gatewayToken);
      runtimes.delete(run.computer_scope_key);
      const computer = await computerRuntimeManager.restartBot(requireActiveBot(bot));
      if (!computer?.endpoint || typeof computer.token !== 'string') {
        fail('Bot computer runtime is unavailable', 'bot_computer_runtime_unavailable', 503);
      }
      const runtime = Object.freeze({
        runId: run.id,
        botId: run.bot_id,
        channelId: run.channel_id,
        revisionId: run.revision_id,
        scopeKey: run.computer_scope_key,
        tenancy: bot.tenancy,
        ownerUserId,
        token: computer.token,
        gatewayToken: null,
        endpoint: computer.endpoint,
      });
      runtimes.set(run.computer_scope_key, runtime);
      return runtime;
    },
  );

  const shouldRecoverRead = (error, signal) => (
    !signal?.aborted
    && error instanceof BotBrowserServiceError
    && (error.transportUncertain === true || RECOVERABLE_REMOTE_CODES.has(error.remoteCode))
  );

  const withTransferCapability = async ({ runtime, run, command, operation }) => {
    if (!['upload', 'download'].includes(command)) {
      return operation(runtime.gatewayToken ? {
        'x-devryan-gateway-token': runtime.gatewayToken,
      } : {});
    }
    const capability = gatewayHost.issueCapability({
      botId: run.bot_id,
      runId: run.id,
      channelId: run.channel_id,
      revisionId: run.revision_id,
      scopeKey: run.computer_scope_key,
      kind: 'computer',
      operations: command === 'upload' ? ['artifact.get'] : ['artifact.put'],
    });
    try {
      return await operation({ 'x-devryan-gateway-token': capability.token });
    } finally {
      gatewayHost.revokeCapability(capability.token);
    }
  };

  const publishControl = async (kind, bot, payload, principal) => eventStream.publish({
    kind,
    botId: bot.id,
    audienceUserIds: await audienceForBot(bot.id, principal?.id),
    payload,
  });

  const controlActor = (principal) => Object.freeze({
    actorId: validateUuid(principal?.id, 'principal.id'),
    actorType: principal?.role === 'admin' ? 'admin' : 'user',
  });

  const deleteViewSession = (view) => {
    if (!view || viewSessions.get(view.id) !== view) return false;
    viewSessions.delete(view.id);
    if (view.expiryTimer) clearTimeout(view.expiryTimer);
    view.controller.abort();
    return true;
  };

  const publicView = (view) => Object.freeze({
    id: view.id,
    botId: view.botId,
    channelId: view.channelId,
    streamUrl: `/api/bots/${encodeURIComponent(view.botId)}/computer/view/${encodeURIComponent(view.id)}/stream`,
    startedAt: view.startedAt,
  });

  const controlRequest = async ({ principal, botId, operation, leaseId = null }) => {
    const { bot } = await authorizedBotContext(principal, botId, { operator: true });
    const runtime = await runtimeForBot(bot);
    const actor = controlActor(principal);
    const path = `/v1/control/${operation}`;
    const body = operation === 'take'
      ? actor
      : { ...actor, leaseId: validateBoundedString(leaseId, 'leaseId', { maximum: 160 }) };
    const control = publicControl(await transport.request({ runtime, path, body }));
    await publishControl(`computer.control.${operation}`, bot, { botId: bot.id, control }, principal);
    await audit({
      principal,
      botId: bot.id,
      targetType: 'bot_computer',
      targetId: `bot:${bot.id}`,
      action: `bot.computer.control.${operation}`,
      result: 'success',
      metadata: {
        computerScopeKey: `bot:${bot.id}`,
        controllerUserId: principal.id,
        controlLeaseId: control?.leaseId || leaseId,
        expiresAt: control?.expiresAt || null,
      },
    });
    return Object.freeze({ botId: bot.id, control });
  };

  return Object.freeze({
    loadRunContext,
    ensureRuntime,

    async policyFacts({ run, bot, ownerUserId } = {}) {
      const runtime = await ensureRuntime({ run, bot, ownerUserId });
      const status = await transport.request({ runtime, path: '/v1/status', method: 'GET' });
      const candidate = status?.browser?.url || status?.browser?.currentUrl || status?.url || null;
      if (candidate === null) return Object.freeze({ authoritativeUrl: null });
      if (typeof candidate !== 'string' || Buffer.byteLength(candidate, 'utf8') > 2_048) {
        fail('Bot computer returned an invalid current URL', 'bot_browser_status_invalid', 502);
      }
      let url;
      try {
        url = new URL(candidate);
      } catch {
        fail('Bot computer returned an invalid current URL', 'bot_browser_status_invalid', 502);
      }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        fail('Bot computer returned an invalid current URL', 'bot_browser_status_invalid', 502);
      }
      return Object.freeze({ authoritativeUrl: url.href });
    },

    async executeAction({ run, bot, ownerUserId, command, args, target, limits, decision, signal } = {}) {
      const normalized = validateBotBrowserAction({ command, args, target, limits });
      if (!decision || decision.actionHash === undefined || decision.expiresAt === undefined
        || decision.effect === 'deny' || Date.parse(decision.expiresAt) <= Date.now()) {
        fail('Browser action policy capability is invalid', 'bot_browser_scope_denied', 403);
      }
      if (normalized.operationKind === 'write') {
        const allowed = normalized.limits.allowedOperations;
        if (!Array.isArray(allowed) || allowed.length !== 1 || allowed[0] !== normalized.command
          || normalized.limits.decisionExpiresAt !== decision.expiresAt) {
          fail('Browser interaction capability is not exact', 'bot_browser_scope_denied', 403);
        }
      }
      let runtime = await ensureRuntime({ run, bot, ownerUserId });
      const requestCommand = () => withTransferCapability({
        runtime,
        run,
        command: normalized.command,
        operation: (headers) => transport.request({
          runtime,
          path: '/v1/command',
          body: { command: normalized.command, args: normalized.args },
          headers,
          signal,
        }),
      });
      try {
        let result;
        try {
          result = await requestCommand();
        } catch (error) {
          if (normalized.operationKind !== 'read' || !shouldRecoverRead(error, signal)) throw error;
          runtime = await recoverRuntime({ run, bot, ownerUserId, failedRuntime: runtime });
          try {
            result = await requestCommand();
          } catch (recoveryError) {
            throw new BotBrowserServiceError(
              'Bot computer browser recovery failed',
              'bot_browser_recovery_failed',
              recoveryError?.statusCode || 502,
              { transportUncertain: false, remoteCode: recoveryError?.remoteCode || null },
            );
          }
        }
        return Object.freeze({
          result,
          operationKind: normalized.operationKind,
          nativeExactlyOnce: false,
          writeGuarantee: normalized.operationKind === 'write'
            ? 'unknown_on_transport_loss'
            : 'safe_to_retry',
        });
      } catch (error) {
        if (error instanceof BotBrowserServiceError && normalized.operationKind === 'write'
          && error.transportUncertain) {
          throw new BotBrowserServiceError(
            'The browser may have applied this action; a person must reconcile it',
            'bot_action_needs_reconciliation',
            409,
            { transportUncertain: true, remoteCode: error.remoteCode },
          );
        }
        throw error;
      }
    },

    async capturePng({ run, bot, ownerUserId, signal } = {}) {
      let runtime = await ensureRuntime({ run, bot, ownerUserId });
      const requestScreenshot = () => transport.request({
        runtime,
        path: '/v1/command',
        body: { command: 'screenshot', args: { format: 'png', quality: 100 } },
        signal,
      });
      let result;
      try {
        result = await requestScreenshot();
      } catch (error) {
        if (!shouldRecoverRead(error, signal)) throw error;
        runtime = await recoverRuntime({ run, bot, ownerUserId, failedRuntime: runtime });
        try {
          result = await requestScreenshot();
        } catch (recoveryError) {
          throw new BotBrowserServiceError(
            'Bot computer browser recovery failed',
            'bot_browser_recovery_failed',
            recoveryError?.statusCode || 502,
            { transportUncertain: false, remoteCode: recoveryError?.remoteCode || null },
          );
        }
      }
      if (result?.mimeType !== 'image/png' || typeof result.data !== 'string') {
        fail('Bot computer screenshot is invalid', 'bot_evidence_capture_failed', 502);
      }
      const bytes = Buffer.from(result.data, 'base64');
      if (bytes.toString('base64') !== result.data || bytes.byteLength !== result.bytes) {
        fail('Bot computer screenshot is invalid', 'bot_evidence_capture_failed', 502);
      }
      return bytes;
    },

    async status({ principal, botId } = {}) {
      const { bot } = await authorizedBotContext(principal, botId);
      const runtime = await runtimeForBot(bot);
      const status = await transport.request({ runtime, path: '/v1/status', method: 'GET' });
      return Object.freeze({
        botId: bot.id,
        browser: structuredClone(status.browser || {}),
        control: publicControl(status.control),
        screencast: {
          subscribers: Number(status.screencast?.subscribers || 0),
          lastFrameAt: status.screencast?.lastFrameAt ?? null,
          retainedFrames: 0,
        },
        framesRecorded: false,
        arbitraryWebsiteExactlyOnce: false,
      });
    },

    async startComputerView({ principal, botId, channelId } = {}) {
      const context = await authorizedViewerContext(principal, botId, channelId);
      await runtimeForBot(context.bot);
      const principalId = validateUuid(principal?.id, 'principal.id');
      for (const existing of viewSessions.values()) {
        if (existing.botId === context.bot.id && existing.principalId === principalId) {
          deleteViewSession(existing);
        }
      }
      let id;
      do {
        id = `view_${Buffer.from(randomBytesImpl(18)).toString('base64url')}`;
      } while (viewSessions.has(id));
      const timestamp = now();
      const view = {
        id,
        botId: context.bot.id,
        channelId: context.channel.id,
        scopeKey: `bot:${context.bot.id}`,
        principalId,
        startedAt: new Date(timestamp).toISOString(),
        attachExpiresAt: timestamp + viewAttachTtlMs,
        attached: false,
        controller: new AbortController(),
        expiryTimer: null,
      };
      view.expiryTimer = setTimeout(() => deleteViewSession(view), viewAttachTtlMs);
      view.expiryTimer.unref?.();
      viewSessions.set(id, view);
      try {
        await audit({
          principal,
          botId: context.bot.id,
          targetType: 'bot_computer',
          targetId: `bot:${context.bot.id}`,
          action: 'bot.computer.view.start',
          result: 'success',
          metadata: {
            channelId: context.channel.id,
            viewerUserId: principalId,
          },
        });
      } catch (error) {
        deleteViewSession(view);
        throw error;
      }
      return Object.freeze({ view: publicView(view) });
    },

    async openComputerView({ principal, botId, viewId, signal } = {}) {
      const normalizedBotId = validateUuid(botId, 'botId');
      const normalizedViewId = validateBoundedString(viewId, 'viewId', { maximum: 160 });
      const view = viewSessions.get(normalizedViewId);
      if (!view || view.botId !== normalizedBotId || view.principalId !== principal?.id) {
        fail('Bot computer viewer session was not found', 'bot_browser_view_not_found', 404);
      }
      if (view.attached) {
        fail('Bot computer viewer session is already attached', 'bot_browser_view_attached', 409);
      }
      if (view.attachExpiresAt <= now()) {
        deleteViewSession(view);
        fail('Bot computer viewer session expired', 'bot_browser_view_expired', 410);
      }
      const context = await authorizedViewerContext(principal, normalizedBotId, view.channelId);
      if (context.bot.id !== view.botId || context.channel.id !== view.channelId
        || `bot:${context.bot.id}` !== view.scopeKey) {
        deleteViewSession(view);
        fail('Bot computer viewer session was not found', 'bot_browser_view_not_found', 404);
      }
      const runtime = await runtimeForBot(context.bot);
      view.attached = true;
      clearTimeout(view.expiryTimer);
      view.expiryTimer = null;
      try {
        return await transport.stream({
          runtime,
          path: '/v1/screencast',
          signal: signal
            ? AbortSignal.any([signal, view.controller.signal])
            : view.controller.signal,
        });
      } catch (error) {
        deleteViewSession(view);
        throw error;
      }
    },

    async stopComputerView({ principal, botId, viewId } = {}) {
      const normalizedBotId = validateUuid(botId, 'botId');
      const normalizedViewId = validateBoundedString(viewId, 'viewId', { maximum: 160 });
      const view = viewSessions.get(normalizedViewId);
      if (!view) return Object.freeze({ stopped: false });
      if (view.botId !== normalizedBotId || view.principalId !== principal?.id) {
        fail('Bot computer viewer session was not found', 'bot_browser_view_not_found', 404);
      }
      deleteViewSession(view);
      await audit({
        principal,
        botId: view.botId,
        targetType: 'bot_computer',
        targetId: view.scopeKey,
        action: 'bot.computer.view.stop',
        result: 'success',
        metadata: {
          channelId: view.channelId,
          viewerUserId: principal.id,
        },
      });
      return Object.freeze({ stopped: true });
    },

    onBotDeactivated({ botId } = {}) {
      const normalizedBotId = validateUuid(botId, 'botId');
      let closed = 0;
      for (const view of viewSessions.values()) {
        if (view.botId === normalizedBotId && deleteViewSession(view)) closed += 1;
      }
      const scopeKey = `bot:${normalizedBotId}`;
      const runtime = runtimes.get(scopeKey);
      if (runtime?.gatewayToken) gatewayHost.revokeCapability(runtime.gatewayToken);
      runtimes.delete(scopeKey);
      return closed;
    },

    takeControl: (input) => controlRequest({ ...input, operation: 'take' }),
    heartbeatControl: (input) => controlRequest({ ...input, operation: 'heartbeat' }),
    returnControl: (input) => controlRequest({ ...input, operation: 'return' }),

    async humanCommand({ principal, botId, leaseId, command, args } = {}) {
      const { bot } = await authorizedBotContext(principal, botId, { operator: true });
      const runtime = await runtimeForBot(bot);
      const actor = controlActor(principal);
      const normalizedCommand = validateBoundedString(command, 'command', { maximum: 120 });
      botBrowserOperationKind(normalizedCommand);
      if (normalizedCommand === 'upload' || normalizedCommand === 'download') {
        fail('Human file transfer requires a governed Bot run', 'bot_browser_capability_required', 409);
      }
      const result = await transport.request({
        runtime,
        path: '/v1/control/command',
        body: {
          ...actor,
          leaseId: validateBoundedString(leaseId, 'leaseId', { maximum: 160 }),
          command: normalizedCommand,
          args: validateBoundedJsonObject(args ?? {}, 'args', 64 * 1024),
        },
      });
      await audit({
        principal,
        botId: bot.id,
        targetType: 'bot_computer',
        targetId: `bot:${bot.id}`,
        action: 'bot.computer.human_command',
        result: 'success',
        metadata: {
          computerScopeKey: `bot:${bot.id}`,
          controllerUserId: principal.id,
          commandType: normalizedCommand,
        },
      });
      return result;
    },

    async shutdown() {
      for (const view of viewSessions.values()) deleteViewSession(view);
      const entries = [...runtimes.values()];
      runtimes.clear();
      for (const runtime of entries) {
        if (runtime.gatewayToken) gatewayHost.revokeCapability(runtime.gatewayToken);
      }
    },
  });
}
