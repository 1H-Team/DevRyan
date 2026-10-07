// Local Bot catalog status and recovery routes. They are registered before the
// catalog readiness gate so status, backup inspection, Restore, Start Empty,
// activation resume and cloud import stay reachable while the catalog is
// unavailable or needs recovery. Every mutation requires the workstation
// owner's Bot session (direct-local, CSRF-checked at the /api boundary).

const isWorkstationOwner = (principal) => principal?.scope === 'bot-owner' && principal?.botOwner === true;

const sendError = (res, error, fallbackStatus = 503) => {
  const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode
    : Number.isInteger(error?.status) ? error.status : fallbackStatus;
  const code = typeof error?.code === 'string' && /^[a-z][a-z0-9_]{0,119}$/.test(error.code)
    ? error.code
    : 'bot_catalog_operation_failed';
  return res.status(statusCode >= 400 && statusCode < 600 ? statusCode : fallbackStatus).json({
    error: typeof error?.message === 'string' ? error.message.replace(/[\r\n\0]/g, ' ').slice(0, 300) : 'Bot catalog operation failed',
    code,
    retryable: error?.retryable === true || code === 'bots_maintenance_busy',
    ...(Array.isArray(error?.blockers) ? { blockers: error.blockers.filter((value) => typeof value === 'string').slice(0, 8) } : {}),
  });
};

const requireOwner = (req, res) => {
  if (isWorkstationOwner(req.principal)) return true;
  res.status(403).json({
    error: 'Only this computer\'s owner can change the local Bot catalog',
    code: 'bot_catalog_owner_required',
  });
  return false;
};

export function registerBotCatalogRoutes(app, {
  getStatus,
  maintenance = null,
  catalogImport = null,
} = {}) {
  if (typeof getStatus !== 'function') throw new TypeError('Bot catalog routes require a status provider');

  app.get('/api/bots/database', async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const owner = isWorkstationOwner(req.principal);
      const status = await getStatus({ owner });
      return res.json({
        ...status,
        viewerIsOwner: owner,
        ...(owner && maintenance ? { backups: maintenance.status() } : {}),
        ...(owner && catalogImport ? { import: catalogImport.status() } : {}),
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.get('/api/bots/database/backups', async (req, res) => {
    if (!requireOwner(req, res)) return undefined;
    try {
      if (!maintenance) throw Object.assign(new Error('Bot backups are unavailable'), { code: 'bot_backup_unavailable', statusCode: 503 });
      return res.json({ backups: await maintenance.listBackups() });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/bots/database/backups', async (req, res) => {
    if (!requireOwner(req, res)) return undefined;
    try {
      if (!maintenance) throw Object.assign(new Error('Bot backups are unavailable'), { code: 'bot_backup_unavailable', statusCode: 503 });
      return res.status(201).json({ backup: await maintenance.backupNow({ kind: 'manual' }) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/bots/database/restore', async (req, res) => {
    if (!requireOwner(req, res)) return undefined;
    try {
      if (!maintenance) throw Object.assign(new Error('Bot restore is unavailable'), { code: 'bot_backup_unavailable', statusCode: 503 });
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      return res.json(await maintenance.restore({ backupId: body.backupId, confirmation: body.confirmation }));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/bots/database/start-empty', async (req, res) => {
    if (!requireOwner(req, res)) return undefined;
    try {
      if (!maintenance) throw Object.assign(new Error('Bot recovery is unavailable'), { code: 'bot_backup_unavailable', statusCode: 503 });
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      return res.json(await maintenance.startEmpty({ confirmation: body.confirmation }));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/bots/database/activation/resume', async (req, res) => {
    if (!requireOwner(req, res)) return undefined;
    try {
      if (!maintenance) throw Object.assign(new Error('Bot recovery is unavailable'), { code: 'bot_backup_unavailable', statusCode: 503 });
      return res.json(await maintenance.resumeActivation());
    } catch (error) {
      return sendError(res, error);
    }
  });

  if (catalogImport) {
    app.get('/api/bots/database/import', async (req, res) => {
      if (!requireOwner(req, res)) return undefined;
      res.setHeader('Cache-Control', 'no-store');
      return res.json(catalogImport.status());
    });
    app.post('/api/bots/database/import', async (req, res) => {
      if (!requireOwner(req, res)) return undefined;
      try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        return res.status(202).json(await catalogImport.start({
          mode: body.mode,
          ...(body.scope === undefined ? {} : { scope: body.scope }),
          writersStopped: body.writersStopped === true,
          principal: req.principal,
          request: req,
        }));
      } catch (error) {
        return sendError(res, error);
      }
    });
    // The owner asks again after restoring the hosted project; automatic
    // discovery otherwise runs at most once an hour.
    app.post('/api/bots/database/import/check', async (req, res) => {
      if (!requireOwner(req, res)) return undefined;
      try {
        res.setHeader('Cache-Control', 'no-store');
        return res.json(await catalogImport.probeCloud({ requested: true }));
      } catch (error) {
        return sendError(res, error);
      }
    });
    app.post('/api/bots/database/import/cancel', async (req, res) => {
      if (!requireOwner(req, res)) return undefined;
      try {
        return res.json(await catalogImport.cancel());
      } catch (error) {
        return sendError(res, error);
      }
    });
    app.post('/api/bots/database/import/dismiss', async (req, res) => {
      if (!requireOwner(req, res)) return undefined;
      try {
        return res.json(await catalogImport.dismiss());
      } catch (error) {
        return sendError(res, error);
      }
    });
  }
}
