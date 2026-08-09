import { createProjectIdFromPath } from '../projects/project-id.js';

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

const normalizePath = (value) => {
  const normalized = String(value || '').trim().replace(/\\/g, '/').replace(/\/+$/g, '');
  return normalized || (String(value || '').trim().startsWith('/') ? '/' : '');
};

const sanitizePlanPathSegment = (value) => String(value || '')
  .trim()
  .replace(/[\\/]+/g, '-')
  .replace(/\.+/g, '-')
  .replace(/[^A-Za-z0-9_-]+/g, '-')
  .replace(/-+/g, '-')
  .replace(/^-+|-+$/g, '');

const routeError = (statusCode, message) => Object.assign(new Error(message), { statusCode });

export const resolveSessionPlanRevision = ({
  dataDirectory,
  directory,
  sessionCreated,
  sessionSlug,
  sourceMessageID,
  path,
}) => {
  const normalizedDataDirectory = normalizePath(dataDirectory);
  const normalizedDirectory = normalizePath(directory);
  const created = Number(sessionCreated);
  const slug = sanitizePlanPathSegment(sessionSlug);
  const sourceID = String(sourceMessageID || '').trim();

  if (!normalizedDataDirectory || !path.isAbsolute(normalizedDataDirectory)) {
    throw routeError(500, 'Plan storage is unavailable');
  }
  if (!normalizedDirectory || !path.isAbsolute(normalizedDirectory)) {
    throw routeError(400, 'Plan directory must be an absolute path');
  }
  if (!Number.isFinite(created) || created <= 0 || Math.trunc(created) !== created) {
    throw routeError(400, 'Plan session creation time is invalid');
  }
  if (!slug) {
    throw routeError(400, 'Plan session slug is invalid');
  }
  if (!SESSION_ID_PATTERN.test(sourceID)) {
    throw routeError(400, 'Plan source message ID is invalid');
  }

  const projectID = sanitizePlanPathSegment(createProjectIdFromPath(normalizedDirectory));
  if (!projectID) {
    throw routeError(400, 'Plan project identity is invalid');
  }

  const plansDirectory = path.join(normalizedDataDirectory, 'projects', projectID, 'plans');
  const fileName = `${Math.trunc(created)}-${slug}-${sourceID}.md`;
  return {
    directory: plansDirectory,
    path: path.join(plansDirectory, fileName),
  };
};

const sendRouteError = (res, error, fallback) => {
  const status = Number(error?.statusCode)
    || (error?.code === 'EACCES' || error?.code === 'EPERM' ? 403 : 500);
  return res.status(status).json({ error: error?.message || fallback });
};

export const registerSessionPlanRoutes = (app, {
  dataDirectory,
  fsPromises,
  path,
  ownsSession,
  resolveOwnedSessionPlanContext,
}) => {
  const authorizeSession = async (req, res) => {
    const sessionID = String(req.params.sessionID || '').trim();
    if (!SESSION_ID_PATTERN.test(sessionID)) {
      res.status(400).json({ error: 'Plan session ID is invalid' });
      return null;
    }
    if (req.principal?.scope !== 'managed') return { directory: null };
    const requestedDirectory = req.method === 'GET' ? req.query?.directory : req.body?.directory;
    const context = typeof resolveOwnedSessionPlanContext === 'function'
      ? await resolveOwnedSessionPlanContext(req.principal, sessionID, requestedDirectory)
      : null;
    if (!context || typeof ownsSession !== 'function' || !await ownsSession(req.principal, sessionID)) {
      res.status(404).json({ error: 'Session not found' });
      return null;
    }
    return context;
  };

  const resolveFromRequest = (req, sessionContext) => resolveSessionPlanRevision({
    dataDirectory,
    directory: sessionContext?.directory
      || (req.method === 'GET' ? req.query?.directory : req.body?.directory),
    sessionCreated: req.method === 'GET' ? req.query?.sessionCreated : req.body?.sessionCreated,
    sessionSlug: req.method === 'GET' ? req.query?.sessionSlug : req.body?.sessionSlug,
    sourceMessageID: req.params.sourceMessageID,
    path,
  });

  app.post('/api/session/:sessionID/plan-revisions/:sourceMessageID', async (req, res) => {
    try {
      const sessionContext = await authorizeSession(req, res);
      if (!sessionContext) return;
      const markdown = req.body?.markdown;
      if (typeof markdown !== 'string' || !markdown.trim()) {
        throw routeError(400, 'Completed plan Markdown is required');
      }
      const revision = resolveFromRequest(req, sessionContext);
      await fsPromises.mkdir(revision.directory, { recursive: true });

      let handle;
      try {
        handle = await fsPromises.open(revision.path, 'wx');
        try {
          await handle.writeFile(markdown, 'utf8');
        } catch (error) {
          await handle.close().catch(() => {});
          handle = null;
          await fsPromises.unlink(revision.path).catch(() => {});
          throw error;
        }
        return res.json({ path: revision.path, created: true });
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const stat = await fsPromises.stat(revision.path).catch((statError) => {
          throw statError;
        });
        if (!stat.isFile()) throw routeError(409, 'The canonical plan path is not a file');
        return res.json({ path: revision.path, created: false });
      } finally {
        await handle?.close().catch(() => {});
      }
    } catch (error) {
      return sendRouteError(res, error, 'Failed to save plan revision');
    }
  });

  app.get('/api/session/:sessionID/plan-revisions/:sourceMessageID', async (req, res) => {
    try {
      const sessionContext = await authorizeSession(req, res);
      if (!sessionContext) return;
      const revision = resolveFromRequest(req, sessionContext);
      const content = await fsPromises.readFile(revision.path, 'utf8');
      return res.json({ path: revision.path, content });
    } catch (error) {
      if (error?.code === 'ENOENT') return res.status(404).json({ error: 'Plan revision not found' });
      return sendRouteError(res, error, 'Failed to read plan revision');
    }
  });

  app.put('/api/session/:sessionID/plan-revisions/:sourceMessageID', async (req, res) => {
    try {
      const sessionContext = await authorizeSession(req, res);
      if (!sessionContext) return;
      const markdown = req.body?.markdown;
      if (typeof markdown !== 'string') throw routeError(400, 'Plan Markdown is required');
      const revision = resolveFromRequest(req, sessionContext);
      const stat = await fsPromises.stat(revision.path).catch((error) => {
        if (error?.code === 'ENOENT') throw routeError(404, 'Plan revision not found');
        throw error;
      });
      if (!stat.isFile()) throw routeError(409, 'The canonical plan path is not a file');
      const temporaryPath = `${revision.path}.${process.pid}.${Date.now()}.tmp`;
      try {
        await fsPromises.writeFile(temporaryPath, markdown, { encoding: 'utf8', flag: 'wx' });
        await fsPromises.rename(temporaryPath, revision.path);
      } finally {
        await fsPromises.unlink(temporaryPath).catch(() => {});
      }
      return res.json({ path: revision.path, saved: true });
    } catch (error) {
      return sendRouteError(res, error, 'Failed to update plan revision');
    }
  });
};
