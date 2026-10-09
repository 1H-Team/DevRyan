import express from 'express';

import { normalizeOpenCodeDbMaintenanceSettings } from './db-maintenance-core.js';

const sendError = (res, error, fallback) => {
  res.status(error?.statusCode || 500).json({
    error: error?.message || fallback,
    code: error?.code || undefined,
  });
};

/**
 * Settings → Storage backing routes.
 *
 * `GET  /api/storage/opencode-db`          -> inspect() + maintenance settings
 * `POST /api/storage/opencode-db/compact`  -> `{ dryRun: true }` runs a
 *   read-only pass and reports counts. Anything else answers
 *   `409 maintenance_not_applicable`: a mutating pass needs an OpenCode 1
 *   runtime, and runtime selection accepts native OpenCode 2 only, so there is
 *   nothing to schedule and no reason to restart OpenCode.
 */
export const registerOpenCodeDbMaintenanceRoutes = (app, options = {}) => {
  const { maintenance, readMaintenanceSettings } = options;
  if (!maintenance) throw new TypeError('OpenCode db maintenance runtime is required');

  const settings = async () => normalizeOpenCodeDbMaintenanceSettings(
    typeof readMaintenanceSettings === 'function' ? await readMaintenanceSettings() : null,
  );

  app.get('/api/storage/opencode-db', async (_req, res) => {
    try {
      const [status, maintenanceSettings] = await Promise.all([maintenance.inspect(), settings()]);
      res.json({ ...status, maintenance: maintenanceSettings });
    } catch (error) {
      sendError(res, error, 'Failed to inspect OpenCode storage');
    }
  });

  app.post('/api/storage/opencode-db/compact', express.json({ limit: '16kb' }), async (req, res) => {
    try {
      if (req.body?.dryRun !== true) {
        res.status(409).json({
          error: 'OpenCode storage maintenance only edits an OpenCode 1 runtime\'s database; only a dry run is available',
          code: 'maintenance_not_applicable',
        });
        return;
      }
      const maintenanceSettings = await settings();
      const run = await maintenance.run({
        dryRun: true,
        reason: 'dry_run',
        // Evaluated, never executed: reports whether a compaction would VACUUM.
        vacuum: 'force',
        idleHours: maintenanceSettings.idleHours,
        keepSeqPerAggregate: maintenanceSettings.keepSeqPerAggregate,
      });
      res.json({ dryRun: true, run });
    } catch (error) {
      sendError(res, error, 'OpenCode storage dry run failed');
    }
  });
};
