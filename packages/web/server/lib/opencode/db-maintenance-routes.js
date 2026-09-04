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
 *   read-only pass and reports counts; otherwise schedules a one-shot forced
 *   VACUUM that the pre-launch hook consumes, restarts OpenCode, and answers
 *   `{ scheduled: true }` immediately (the restart continues in the background).
 */
export const registerOpenCodeDbMaintenanceRoutes = (app, options = {}) => {
  const { maintenance, scheduler, restartOpenCode, isManagedRuntime, readMaintenanceSettings, logger = console } = options;
  if (!maintenance) throw new TypeError('OpenCode db maintenance runtime is required');
  if (!scheduler) throw new TypeError('OpenCode db compaction scheduler is required');
  if (typeof restartOpenCode !== 'function') throw new TypeError('restartOpenCode is required');

  const managed = () => (typeof isManagedRuntime === 'function' ? Boolean(isManagedRuntime()) : true);
  const settings = async () => normalizeOpenCodeDbMaintenanceSettings(
    typeof readMaintenanceSettings === 'function' ? await readMaintenanceSettings() : null,
  );

  app.get('/api/storage/opencode-db', async (_req, res) => {
    try {
      const [status, maintenanceSettings] = await Promise.all([maintenance.inspect(), settings()]);
      res.json({
        ...status,
        maintenance: maintenanceSettings,
        managedRuntime: managed(),
        compactionPending: scheduler.isForcedPending(),
      });
    } catch (error) {
      sendError(res, error, 'Failed to inspect OpenCode storage');
    }
  });

  app.post('/api/storage/opencode-db/compact', express.json({ limit: '16kb' }), async (req, res) => {
    try {
      const dryRun = req.body?.dryRun === true;
      const maintenanceSettings = await settings();
      if (dryRun) {
        const run = await maintenance.run({
          dryRun: true,
          reason: 'dry_run',
          // Evaluated, never executed: tells the user whether Compact would VACUUM.
          vacuum: 'force',
          idleHours: maintenanceSettings.idleHours,
          keepSeqPerAggregate: maintenanceSettings.keepSeqPerAggregate,
        });
        res.json({ dryRun: true, run });
        return;
      }

      if (!managed()) {
        res.status(409).json({
          error: 'OpenCode is not managed by DevRyan on this host; compact its database where it runs',
          code: 'external_runtime',
        });
        return;
      }
      if (scheduler.isForcedPending()) {
        res.status(202).json({ scheduled: true, pending: true });
        return;
      }

      scheduler.scheduleForced();
      Promise.resolve()
        .then(() => restartOpenCode())
        .catch((error) => {
          logger?.warn?.('[OpenCode] Restart for database compaction failed:', error instanceof Error ? error.message : String(error));
        });
      res.status(202).json({ scheduled: true });
    } catch (error) {
      sendError(res, error, 'Failed to compact OpenCode storage');
    }
  });
};
