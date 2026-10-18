import express from 'express';

const code = error => /^(?:claude|bundle)_[a-z0-9_]{1,100}$/.test(error?.code ?? '') ? error.code : 'claude_update_failed';
/** Background ownership survives browser disconnects. Selection remains lifecycle-owned. */
export function createClaudeUpdateController({ lifecycle, supported = process.platform === 'darwin' && process.arch === 'arm64', startupFailure = null }) {
  let phase = startupFailure ? 'failed' : 'idle', reason = startupFailure, operation;
  const inspect = async () => {
    const bundle = await lifecycle.inspect({ checkUpdates: false });
    return { supported, phase, reason, revision: bundle.revision, restartRequired: bundle.restartRequired,
      held: bundle.state === 'held', rollbackAvailable: bundle.rollbackAvailable === true, busy: Boolean(operation) };
  };
  return {
    inspect,
    setPhase: value => { phase = value; },
    start: async (action, input) => {
      if (!supported) throw Object.assign(new Error(), { code: 'claude_update_unavailable', status: 409 });
      if (operation) throw Object.assign(new Error(), { code: 'claude_update_busy', status: 409 });
      if (!input || Object.keys(input).length !== 1 || !Number.isSafeInteger(input.expectedRevision)) throw Object.assign(new Error(), { code: 'bundle_selection_revision_conflict', status: 409 });
      // Reserve before the first await; a second caller cannot overwrite the operation.
      phase = 'checking'; reason = null;
      operation = (async () => {
        const result = await (action === 'install' ? lifecycle.upgradeClaude(input) : lifecycle.rollback(input));
        phase = 'restarting';
        if (result.restartAvailable) await lifecycle.recompose();
      })().catch(error => { phase = 'failed'; reason = code(error); }).finally(() => { operation = undefined; });
      return inspect();
    },
    settled: () => operation,
  };
}

export function registerClaudeUpdateRoutes(app, { controller, isAdministrator }) {
  const guard = (req, res, next) => isAdministrator(req) ? next() : res.status(403).json({ code: 'claude_administrator_required' });
  app.get('/api/config/claude-update', guard, async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try { res.json(await controller.inspect()); } catch (error) { res.status(503).json({ code: code(error) }); }
  });
  for (const action of ['install', 'rollback']) app.post(`/api/config/claude-update/${action}`, guard,
    (req, res, next) => req.headers['x-devryan-csrf'] === '1' ? next() : res.status(403).json({ code: 'claude_csrf_required' }),
    express.json({ limit: '1kb' }), async (req, res) => {
      try { res.status(202).json(await controller.start(action, req.body)); }
      catch (error) { res.status(error.status ?? 503).json({ code: code(error) }); }
    });
}
