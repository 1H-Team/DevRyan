import { randomBytes } from 'node:crypto';

import { validateUuid } from './validation.js';
import { createBotPeriodicJob } from './periodic-job.js';

const DEFAULT_SWEEP_INTERVAL_MS = 30_000;

export function createBotComputerRuntimeManager({
  store,
  computerBackend,
  gatewayHost,
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
    || typeof randomBytesImpl !== 'function') {
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
    const ensured = await computerBackend.ensure({
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
          return current;
        }
      }
      const token = current?.token || Buffer.from(randomBytesImpl(32)).toString('base64url');
      return provisionBot(bot, token);
    }).catch((error) => {
      failures.set(botId, Object.freeze({
        code: typeof error?.code === 'string' ? error.code : 'bot_computer_start_failed',
        at: new Date().toISOString(),
      }));
      throw error;
    });
  };

  const restartBot = (botInput) => {
    const botId = validateUuid(botInput?.id, 'bot.id');
    return withLock(botId, async () => {
      const bot = await requireActiveBot(botId, botInput);
      const current = runtimes.get(botId);
      await computerBackend.stop({
        botId,
        tenancy: 'team',
        ownerUserId: current?.ownerUserId || bot.created_by,
      });
      runtimes.delete(botId);
      const token = Buffer.from(randomBytesImpl(32)).toString('base64url');
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
