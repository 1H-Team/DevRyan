const requireDirectory = (req) => {
  const value = typeof req.query?.directory === 'string'
    ? req.query.directory.trim()
    : (typeof req.body?.directory === 'string' ? req.body.directory.trim() : '');
  if (!value) {
    const error = new Error('directory is required');
    error.statusCode = 400;
    throw error;
  }
  return value;
};

const sendError = (res, error, fallback) => {
  res.status(error?.statusCode || 500).json({
    error: error?.message || fallback,
    code: error?.code || undefined,
  });
};

export const registerEvidenceRoutes = (app, options = {}) => {
  const runtime = options.runtime;
  if (!runtime) throw new TypeError('evidence runtime is required');

  app.get('/api/evidence/project', async (req, res) => {
    try {
      res.json(await runtime.getProjectSetting(requireDirectory(req)));
    } catch (error) {
      sendError(res, error, 'Failed to read evidence settings');
    }
  });

  app.put('/api/evidence/project', async (req, res) => {
    try {
      res.json(await runtime.setProjectSetting(requireDirectory(req), {
        enabled: req.body?.enabled === true,
      }));
    } catch (error) {
      sendError(res, error, 'Failed to update evidence settings');
    }
  });

  app.delete('/api/evidence/project', async (req, res) => {
    try {
      const removed = await runtime.clearProject(requireDirectory(req));
      res.json({ removed });
    } catch (error) {
      sendError(res, error, 'Failed to clear project evidence');
    }
  });

  app.get('/api/evidence/turns/:sessionID', async (req, res) => {
    try {
      const directory = typeof req.query?.directory === 'string'
        ? req.query.directory.trim()
        : undefined;
      const userMessageID = typeof req.query?.userMessageID === 'string'
        ? req.query.userMessageID.trim()
        : undefined;
      res.json(await runtime.listBySession({
        sessionID: req.params.sessionID,
        directory,
        userMessageID,
      }));
    } catch (error) {
      sendError(res, error, 'Failed to list turn evidence');
    }
  });

  app.get('/api/evidence/checkpoints/:checkpointID/diff', async (req, res) => {
    try {
      const file = typeof req.query?.file === 'string' ? req.query.file : '';
      res.json(await runtime.getDiff(req.params.checkpointID, file));
    } catch (error) {
      sendError(res, error, 'Failed to read turn evidence');
    }
  });
};
