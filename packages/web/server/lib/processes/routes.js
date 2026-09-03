const sendError = (res, error, fallback) => {
  res.status(error?.statusCode || 500).json({
    error: error?.message || fallback,
    code: error?.code || undefined,
  });
};

const readDirectory = (req) => {
  if (typeof req.query?.directory === 'string' && req.query.directory.trim()) return req.query.directory.trim();
  if (typeof req.body?.directory === 'string' && req.body.directory.trim()) return req.body.directory.trim();
  return '';
};

// Process inspection and termination act on the host machine, so they are
// reserved for the local administrator; managed (multi-user) principals get 403.
const ensureLocalAdmin = (req, res) => {
  if (req.principal?.scope === 'managed') {
    res.status(403).json({ error: 'Process management is available to the local administrator only', code: 'forbidden' });
    return false;
  }
  return true;
};

export const registerProcessesRoutes = (app, options = {}) => {
  const runtime = options.runtime;
  if (!runtime) throw new TypeError('processes runtime is required');

  app.get('/api/processes/project', async (req, res) => {
    if (!ensureLocalAdmin(req, res)) return;
    try {
      res.json(await runtime.getProjectSetting(readDirectory(req)));
    } catch (error) {
      sendError(res, error, 'Failed to read process tracking settings');
    }
  });

  app.put('/api/processes/project', async (req, res) => {
    if (!ensureLocalAdmin(req, res)) return;
    try {
      res.json(await runtime.setProjectSetting(readDirectory(req), {
        trackAgentProcesses: typeof req.body?.trackAgentProcesses === 'boolean' ? req.body.trackAgentProcesses : undefined,
        heavyCheckSlots: Number.isFinite(req.body?.heavyCheckSlots) ? req.body.heavyCheckSlots : undefined,
      }));
    } catch (error) {
      sendError(res, error, 'Failed to update process tracking settings');
    }
  });

  app.get('/api/processes', async (req, res) => {
    if (!ensureLocalAdmin(req, res)) return;
    try {
      res.json(await runtime.snapshot({ directory: readDirectory(req) || undefined }));
    } catch (error) {
      sendError(res, error, 'Failed to list processes');
    }
  });

  app.post('/api/processes/:pid/stop', async (req, res) => {
    if (!ensureLocalAdmin(req, res)) return;
    try {
      res.json(await runtime.stopProcess({
        pid: Number(req.params.pid),
        startedAt: req.body?.startedAt,
      }));
    } catch (error) {
      sendError(res, error, 'Failed to stop process');
    }
  });
};
