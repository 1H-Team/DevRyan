import { createHmac, randomBytes } from 'node:crypto';

import { validateUuid } from './validation.js';
import { createBotPeriodicJob } from './periodic-job.js';

const DEFAULT_SWEEP_INTERVAL_MS = 30_000;
// Domain-separated derivation label; bump the version to invalidate every derived
// computer runtime token at once.
const RUNTIME_TOKEN_DERIVATION_LABEL = 'computer-runtime-token:v1';
const MINIMUM_DERIVATION_KEY_BYTES = 16;

export function createBotComputerRuntimeManager({
  store,
  computerBackend,
  gatewayHost,
  encryption = null,
  recordDiagnostic = () => {},
  sweepIntervalMs = DEFAULT_SWEEP_INTERVAL_MS,
  randomBytesImpl = randomBytes,
  logger = console,
} = {}) {
  if (!store?.repositories?.bots || !store?.repositories?.bot_revisions || !computerBackend
    || computerBackend.version !== 1
    || typeof computerBackend.ensure !== 'function'
    || typeof computerBackend.inspect !== 'function'
    || typeof computerBackend.stop !== 'function'
    || !gatewayHost || typeof gatewayHost.getAddress !== 'function'
    || !Number.isInteger(sweepIntervalMs) || sweepIntervalMs < 1_000
    || typeof randomBytesImpl !== 'function'
    || (encryption !== null && (typeof encryption !== 'object'
      || (encryption.getKey != null && typeof encryption.getKey !== 'function')))) {
    throw new TypeError('Bot computer runtime manager is misconfigured');
  }

  const runtimes = new Map();
  const failures = new Map();
  const locks = new Map();
  let timer = null;
  let started = false;
  let sweepPromise = null;

  const withLock = (botId, operation) => {
    const previous = locks.get(botId) || Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    locks.set(botId, current);
    return current.finally(() => {
      if (locks.get(botId) === current) locks.delete(botId);
    });
  };

  const loadBot = async (botId) => store.repositories.bots.get({
    id: validateUuid(botId, 'botId'),
  });

  const mintToken = () => Buffer.from(randomBytesImpl(32)).toString('base64url');

  // The computer container is labelled with a hash of its runtime token, so a
  // token minted on every DevRyan start would recreate the container (restarting
  // Chromium and dropping session logins) at every start. Deriving the token
  // from the sealed deployment key keeps it stable across restarts without
  // storing it anywhere; an explicit rotation still mints a fresh random token.
  const deriveToken = async (botId) => {
    if (typeof encryption?.getKey !== 'function') return null;
    let key = null;
    try {
      key = await encryption.getKey();
    } catch (error) {
      logger?.warn?.('[bots] computer runtime token derivation is unavailable; using a per-start token', {
        code: typeof error?.code === 'string' ? error.code : 'bot_os_encryption_unavailable',
      });
      return null;
    }
    const usable = (Buffer.isBuffer(key) || key instanceof Uint8Array)
      && key.byteLength >= MINIMUM_DERIVATION_KEY_BYTES;
    try {
      if (!usable) return null;
      return createHmac('sha256', key)
        .update(`${RUNTIME_TOKEN_DERIVATION_LABEL}:${botId}`)
        .digest('base64url');
    } finally {
      // The accessor hands out a copy; zero it like every other key consumer.
      if (Buffer.isBuffer(key) || key instanceof Uint8Array) key.fill(0);
    }
  };

  const resolveToken = async (botId, current) => current?.token || await deriveToken(botId) || mintToken();

  const requireActiveBot = async (botId, botInput) => {
    const storedBot = await loadBot(botId);
    const bot = storedBot ? { ...storedBot, ...botInput } : null;
    if (!bot || bot.lifecycle !== 'active' || !bot.active_revision_id) {
      throw Object.assign(new Error('Only an Active Bot owns a running computer'), {
        code: 'bot_computer_lifecycle_inactive', statusCode: 409,
      });
    }
    return bot;
  };

  const revisionComputerPolicy = async (bot) => {
    const revision = await store.repositories.bot_revisions.get({
      id: validateUuid(bot.active_revision_id, 'revisionId'),
      bot_id: bot.id,
    });
    if (!revision) {
      throw Object.assign(new Error('The active Bot revision is unavailable'), {
        code: 'bot_revision_not_found', statusCode: 409,
      });
    }
    const mode = revision.contract?.browserPolicy?.networkAccess?.mode || 'public_only';
    const hosts = revision.contract?.browserPolicy?.networkAccess?.hosts || [];
    const isolationTier = revision.contract?.computerPolicy?.isolationTier || 'standard';
    if (!['public_only', 'allowlist'].includes(mode) || !Array.isArray(hosts)
      || (mode === 'public_only' && hosts.length !== 0)
      || (mode === 'allowlist' && hosts.length === 0)
      || !['standard', 'runsc'].includes(isolationTier)) {
      throw Object.assign(new Error('The active computer policy is invalid'), {
        code: 'bot_computer_policy_invalid', statusCode: 409,
      });
    }
    return Object.freeze({
      revisionId: revision.id,
      browserNetworkMode: mode,
      browserEgressHosts: Object.freeze([...hosts]),
      isolationTier,
    });
  };

  const provisionBot = async (bot, token) => {
    const gateway = gatewayHost.getAddress();
    if (!gateway) {
      throw Object.assign(new Error('Bot private gateway is unavailable'), {
        code: 'bot_gateway_unavailable', statusCode: 503,
      });
    }
    const policy = await revisionComputerPolicy(bot);
    const reason = runtimes.has(bot.id) ? 'refresh' : 'provision';
    const diagnostic = (phase, code = null) => recordDiagnostic({
      type: 'lifecycle', event: 'bot.computer.provision',
      payload: { botId: bot.id, phase, reason, ...(code ? { code } : {}) },
    });
    diagnostic('started');
    let ensured;
    try {
      ensured = await computerBackend.ensure({
        botId: bot.id,
        runId: bot.id,
        channelId: bot.id,
        revisionId: policy.revisionId,
        runtimeToken: token,
        tenancy: 'team',
        ownerUserId: bot.created_by,
        gatewayUrl: gateway.dockerGatewayUrl,
        browserNetworkMode: policy.browserNetworkMode,
        browserEgressHosts: policy.browserEgressHosts,
        isolationTier: policy.isolationTier,
      });
    } catch (error) {
      diagnostic('failed', typeof error?.code === 'string' && /^bot_[a-z0-9_]{1,96}$/u.test(error.code)
        ? error.code : 'bot_computer_provision_failed');
      if (['bot_runtime_browser_refresh_failed', 'bot_runtime_computer_stop_unconfirmed'].includes(error?.code)) {
        recordDiagnostic({ type: 'lifecycle', event: 'bot.computer.stop', payload: {
          botId: bot.id, reason: 'egress_refresh_failed',
          status: error.code === 'bot_runtime_browser_refresh_failed' ? 'completed' : 'unconfirmed',
        } });
      }
      throw error;
    }
    diagnostic('completed');
    const runtime = Object.freeze({
      botId: bot.id,
      scopeKey: `bot:${bot.id}`,
      ownerUserId: bot.created_by,
      token,
      endpoint: ensured.endpoint,
      revisionId: policy.revisionId,
      tokenRefreshAt: Date.now() + 12 * 60 * 1_000,
    });
    runtimes.set(bot.id, runtime);
    failures.delete(bot.id);
    return runtime;
  };

  const ensureBot = (botInput, { verifyHealth = false } = {}) => {
    const botId = validateUuid(botInput?.id, 'bot.id');
    return withLock(botId, async () => {
      const current = runtimes.get(botId);
      if (!verifyHealth && current
        && botInput?.lifecycle === 'active'
        && botInput.active_revision_id === current.revisionId
        && Date.now() < current.tokenRefreshAt) {
        return current;
      }
      const bot = await requireActiveBot(botId, botInput);
      if (current) {
        const inspected = await computerBackend.inspect({
          botId,
          tenancy: 'team',
          ownerUserId: bot.created_by,
        });
        if (inspected.state === 'running'
          && current.revisionId === bot.active_revision_id
          && Date.now() < current.tokenRefreshAt) {
          failures.delete(botId);
          // The computer is reached through the supervisor's runtime proxy, and
          // that proxy path is reissued when the supervisor restarts. Adopt the
          // address the inspection just reported instead of a remembered one.
          if (inspected.endpoint?.baseUrl === current.endpoint?.baseUrl) return current;
          const refreshed = Object.freeze({ ...current, endpoint: inspected.endpoint });
          runtimes.set(botId, refreshed);
          return refreshed;
        }
      }
      return provisionBot(bot, await resolveToken(botId, current));
    }).catch((error) => {
      failures.set(botId, Object.freeze({
        code: typeof error?.code === 'string' ? error.code : 'bot_computer_start_failed',
        at: new Date().toISOString(),
      }));
      throw error;
    });
  };

  // Recovery restarts (the default) keep the runtime token so the supervisor sees
  // the same capability and the persistent computer keeps its identity; only an
  // explicit rotation mints a new token, which recreates the container.
  const restartBot = (botInput, { rotate = false } = {}) => {
    const botId = validateUuid(botInput?.id, 'bot.id');
    if (typeof rotate !== 'boolean') {
      throw new TypeError('Bot computer restart options are invalid');
    }
    return withLock(botId, async () => {
      const bot = await requireActiveBot(botId, botInput);
      const current = runtimes.get(botId);
      await computerBackend.stop({
        botId,
        tenancy: 'team',
        ownerUserId: current?.ownerUserId || bot.created_by,
      });
      runtimes.delete(botId);
      const token = rotate ? mintToken() : await resolveToken(botId, current);
      return provisionBot(bot, token);
    }).catch((error) => {
      failures.set(botId, Object.freeze({
        code: typeof error?.code === 'string' ? error.code : 'bot_computer_restart_failed',
        at: new Date().toISOString(),
      }));
      throw error;
    });
  };

  const stopBot = (botIdInput) => {
    const botId = validateUuid(botIdInput, 'botId');
    return withLock(botId, async () => {
      const current = runtimes.get(botId);
      const bot = current ? null : await loadBot(botId);
      const result = await computerBackend.stop({
        botId,
        tenancy: 'team',
        ownerUserId: current?.ownerUserId || bot?.created_by || botId,
      });
      runtimes.delete(botId);
      failures.delete(botId);
      return result;
    });
  };

  const listActiveBots = async () => {
    const bots = [];
    let cursor = null;
    do {
      const page = await store.repositories.bots.list({
        filters: { lifecycle: 'active' }, cursor, limit: 100,
      });
      bots.push(...page.items.filter((bot) => bot.active_revision_id));
      cursor = page.nextCursor;
    } while (cursor);
    return bots;
  };

  const sweep = async () => {
    if (sweepPromise) return sweepPromise;
    sweepPromise = (async () => {
      const activeBots = await listActiveBots();
      const activeIds = new Set(activeBots.map((bot) => bot.id));
      await Promise.allSettled(activeBots.map((bot) => ensureBot(bot, { verifyHealth: true })));
      await Promise.allSettled([...runtimes.keys()]
        .filter((botId) => !activeIds.has(botId))
        .map(stopBot));
    })().finally(() => {
      sweepPromise = null;
    });
    return sweepPromise;
  };

  return Object.freeze({
    async start() {
      if (started) return;
      started = true;
      await sweep();
      timer = createBotPeriodicJob({
        name: 'computer_health_sweep',
        intervalMs: sweepIntervalMs,
        maxBackoffMs: sweepIntervalMs * 5,
        logger,
        run: sweep,
      });
      timer.start({ immediate: false });
    },
    ensureBot,
    restartBot,
    stopBot,
    getRuntime: (botId) => runtimes.get(validateUuid(botId, 'botId')) || null,
    getFailure: (botId) => failures.get(validateUuid(botId, 'botId')) || null,
    sweep,
    async shutdown() {
      started = false;
      if (timer) await timer.stop();
      timer = null;
      await Promise.allSettled([...runtimes.keys()].map(stopBot));
      runtimes.clear();
    },
  });
}
