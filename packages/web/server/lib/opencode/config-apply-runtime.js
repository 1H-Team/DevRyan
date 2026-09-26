import { ConfigApplyError } from '@openchamber/shared-runtime';

const sendApplyError = (res, error, getStatus, canForceRestart) => {
  if (error instanceof ConfigApplyError) {
    return res.status(error.statusCode).json({
      error: error.message,
      code: error.code,
      applyStatus: error.status || getStatus({ canForceRestart }),
    });
  }
  console.error('[ConfigApply] Apply request failed:', error);
  return res.status(500).json({
    error: 'Configuration apply failed. The saved changes remain pending.',
    code: 'CONFIG_APPLY_FAILED',
    applyStatus: getStatus({ canForceRestart }),
  });
};

export const registerConfigApplyRoutes = (app, {
  coordinator,
  markConfigChange,
  canForceRestart = () => false,
  abortActiveSessions = async () => {},
  auditForceRestart = async () => {},
  retireLegacyCursorPlugin = null,
}) => {
  app.get('/api/config/apply-status', (req, res) => {
    const canForce = canForceRestart(req.principal);
    res.json(coordinator.getStatus({ canForceRestart: canForce }));
  });

  app.post('/api/config/apply', async (req, res) => {
    const expectedRevision = req.body?.expectedRevision;
    const mode = req.body?.mode;
    const canForce = canForceRestart(req.principal);
    try {
      const result = await coordinator.apply(expectedRevision, mode, {
        canForceRestart: canForce,
        onForceRestart: ({ revision, activeSessionCount }) => auditForceRestart(req.principal, {
          revision,
          activeSessionCount,
        }),
        abortActiveSessions,
      });
      res.json(result);
    } catch (error) {
      sendApplyError(res, error, coordinator.getStatus, canForce);
    }
  });

  app.post('/api/config/apply/acknowledge-external', async (req, res) => {
    const canForce = canForceRestart(req.principal);
    try {
      const result = await coordinator.acknowledgeExternal(req.body?.expectedRevision, {
        canForceRestart: canForce,
      });
      res.json(result);
    } catch (error) {
      sendApplyError(res, error, coordinator.getStatus, canForce);
    }
  });

  // The user's explicit choice to retire a legacy cursor-acp.js that startup
  // could not retire safely. Copies are moved to verified backups, never
  // deleted, and OpenCode restarts through the idle-aware apply coordinator.
  app.post('/api/config/legacy-cursor-plugin/retire', async (req, res) => {
    const canForce = canForceRestart(req.principal);
    if (!canForce || typeof retireLegacyCursorPlugin !== 'function') {
      return res.status(403).json({ error: 'Only an administrator can change the OpenCode profile.', code: 'FORBIDDEN' });
    }
    const retirement = retireLegacyCursorPlugin();
    if (!retirement.ok) {
      return res.status(409).json({
        error: retirement.error || 'The legacy Cursor plugin could not be retired.',
        code: 'LEGACY_CURSOR_PLUGIN_RETIRE_FAILED',
        conflicts: retirement.conflicts,
      });
    }
    try {
      const mutation = await markConfigChange('retire legacy Cursor plugin');
      const result = await coordinator.apply(mutation.applyRevision, 'when-idle', { canForceRestart: canForce });
      res.json({
        success: true,
        removed: retirement.removed,
        backups: retirement.backups,
        applyStatus: result.status,
      });
    } catch (error) {
      sendApplyError(res, error, coordinator.getStatus, canForce);
    }
  });

  // Compatibility alias for clients that still expose the old manual reload action.
  app.post('/api/config/reload', async (req, res) => {
    const canForce = canForceRestart(req.principal);
    try {
      const mutation = await markConfigChange('manual configuration reload');
      const result = await coordinator.apply(mutation.applyRevision, 'when-idle', {
        canForceRestart: canForce,
      });
      res.json({
        success: true,
        ...mutation,
        applyStatus: result.status,
        requiresReload: false,
        message: result.status.state === 'waiting_for_idle'
          ? 'Configuration saved. OpenCode will restart after active chats finish.'
          : 'Configuration apply request accepted.',
      });
    } catch (error) {
      sendApplyError(res, error, coordinator.getStatus, canForce);
    }
  });
};
