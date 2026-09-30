import { resolveSessionPlanRevision, readPlanRevision, writePlanRevision, planError } from './revisions.js';
export { resolveSessionPlanRevision } from './revisions.js';
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

const sendRouteError = (res, error, fallback) => {
  const status = Number(error?.statusCode)
    || (error?.code === 'EACCES' || error?.code === 'EPERM' ? 403 : 500);
  return res.status(status).json({ error: error?.message || fallback,
    ...(error?.code ? { code: error.code } : {}), ...(error?.version ? { version: error.version } : {}) });
};

export const registerSessionPlanRoutes = (app, {
  dataDirectory,
  fsPromises,
  path,
  ownsSession,
  resolveOwnedSessionPlanContext,
  publishEvent = () => {},
  recordDiagnostic = () => {},
  readCanonicalPlanIdentity,
}) => {
  const authorizeSession = async (req) => {
    const sessionID = String(req.params.sessionID || '').trim();
    if (!SESSION_ID_PATTERN.test(sessionID)) {
      throw planError(400, 'plan_identity_invalid', 'Plan session ID is invalid');
    }
    if (req.principal?.scope !== 'managed') return { directory: null };
    const requestedDirectory = req.method === 'GET' ? req.query?.directory : req.body?.directory;
    const context = typeof resolveOwnedSessionPlanContext === 'function'
      ? await resolveOwnedSessionPlanContext(req.principal, sessionID, requestedDirectory)
      : null;
    if (!context || typeof ownsSession !== 'function' || !await ownsSession(req.principal, sessionID)) {
      throw planError(404, 'plan_owner_unavailable', 'Session not found');
    }
    return context;
  };

  const resolveFromRequest = async (req, sessionContext) => {
    const submitted = req.method === 'GET' ? req.query : req.body;
    const directory = sessionContext?.directory || submitted?.directory;
    if (typeof readCanonicalPlanIdentity !== 'function') throw planError(503, 'plan_identity_unavailable');
    const canonical = await readCanonicalPlanIdentity({ sessionID: req.params.sessionID,
      sourceMessageID: req.params.sourceMessageID, directory });
    if (Number(submitted?.sessionCreated) !== canonical.sessionCreated || submitted?.sessionSlug !== canonical.sessionSlug) {
      throw planError(409, 'plan_identity_mismatch', 'Plan identity does not match its session');
    }
    return resolveSessionPlanRevision({
      dataDirectory,
      directory,
      sessionCreated: canonical.sessionCreated,
      sessionSlug: canonical.sessionSlug,
      sourceMessageID: req.params.sourceMessageID,
      path,
    });
  };

  const diagnostic = (req, outcome, result) => recordDiagnostic({ type: 'lifecycle', event: 'session_plan_write',
    sessionID: req.params.sessionID, payload: { outcome, code: result?.code, version: result?.version } });
  const publish = (req, sessionContext, result) => publishEvent({ type: 'session.plan.updated', properties: {
    sessionID: req.params.sessionID, sourceMessageID: req.params.sourceMessageID,
    directory: sessionContext?.directory || req.body.directory,
    sessionCreated: req.body.sessionCreated, sessionSlug: req.body.sessionSlug, version: result.version,
  } }, { directory: sessionContext?.directory || req.body.directory });

  for (const method of ['post', 'put']) app[method]('/api/session/:sessionID/plan-revisions/:sourceMessageID', async (req, res) => {
    try {
      const sessionContext = await authorizeSession(req);
      const revision = await resolveFromRequest(req, sessionContext);
      const authorize = async () => {
        const current = await authorizeSession(req).catch(error => {
          if (error.code === 'plan_owner_unavailable') throw planError(404, 'plan_owner_changed', 'Session not found');
          throw error;
        });
        if (current.directory !== sessionContext.directory || current.projectId !== sessionContext.projectId
          || current.branchName !== sessionContext.branchName || (await resolveFromRequest(req, current)).path !== revision.path) {
          throw planError(404, 'plan_owner_changed', 'Session not found');
        }
      };
      const result = await writePlanRevision(revision, { text: req.body?.markdown,
        expectedVersion: req.body?.expectedVersion, create: method === 'post', fsApi: fsPromises, authorize });
      diagnostic(req, 'saved', result);
      if (method === 'put' || result.created) publish(req, sessionContext, result);
      return res.json(result);
    } catch (error) {
      diagnostic(req, 'refused', error);
      return sendRouteError(res, error, 'Failed to save plan revision');
    }
  });

  app.get('/api/session/:sessionID/plan-revisions/:sourceMessageID', async (req, res) => {
    try {
      const sessionContext = await authorizeSession(req);
      const revision = await resolveFromRequest(req, sessionContext);
      const current = await authorizeSession(req);
      if (current.directory !== sessionContext.directory || current.projectId !== sessionContext.projectId
        || current.branchName !== sessionContext.branchName) throw planError(404, 'plan_owner_changed', 'Session not found');
      return res.json(await readPlanRevision(revision, { fsApi: fsPromises }));
    } catch (error) {
      return sendRouteError(res, error, 'Failed to read plan revision');
    }
  });
};
