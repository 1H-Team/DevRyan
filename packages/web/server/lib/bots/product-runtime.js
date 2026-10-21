import { BOTS_ENABLED, BOTS_RETIRED, assertBotsEnabled } from '@devryan/shared-runtime/lib/product-capabilities.js';
import { createBotsRuntime } from './runtime.js';

// Do not construct the retained control plane: even executionEnabled:false
// initializes its catalog, retention and Docker probes.
export function createProductBotsRuntime(options) {
  if (BOTS_ENABLED) return createBotsRuntime(options);
  const idle = async () => {};
  return Object.freeze({
    enabled: false,
    start: idle,
    shutdown: idle,
    resumeAdmissions: idle,
    stopDispatcher: idle,
    getRestartBlockers: () => [],
    checkpointBotRuns: async () => ({ status: 'idle' }),
    prepareStartup: async () => ({ state: 'skipped', reason: BOTS_RETIRED.code }),
    validateTunnelBotSelection: async () => { assertBotsEnabled(); },
    getQuitRiskStatus: async () => ({ activeRunCount: 0, pendingApprovalCount: 0,
      activeRoutineCount: 0, pendingRoutineCount: 0, schedulerStatus: 'idle', checkpointStatus: 'idle' }),
    registerRoutes(app) {
      app.use(/^\/api\/(?:bots|bot-actions|bot-channels|bot-runs|bot-specs|bot-signers|bot-audit)(?:\/|$)/,
        (_req, res) => res.status(410).json(BOTS_RETIRED));
    },
  });
}
