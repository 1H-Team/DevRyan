import { randomUUID } from 'node:crypto';
import { resolveSessionPlanRevision, readPlanRevision, writePlanRevision, planError } from './revisions.js';
export { resolveSessionPlanRevision } from './revisions.js';
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

const sendRouteError = (res, error, fallback) => {
  const status = Number(error?.statusCode)
    || (error?.code === 'EACCES' || error?.code === 'EPERM' ? 403 : 500);
  return res.status(status).json({ error: error?.message || fallback,
    ...(error?.code ? { code: error.code } : {}), ...(error?.version ? { version: error.version } : {}),
    // Why a plan source is unsettled (native-plan-settlement.js): waited out or final.
    ...(typeof error?.reason === 'string' && /^[a-z_]{1,64}$/.test(error.reason) ? { reason: error.reason } : {}) });
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
      sourceMessageID: req.params.sourceMessageID, directory, allowSelected: req.method === 'GET' || req.method === 'PUT' });
    if (Number(submitted?.sessionCreated) !== canonical.sessionCreated || submitted?.sessionSlug !== canonical.sessionSlug) {
      throw planError(409, 'plan_identity_mismatch', 'Plan identity does not match its session');
    }
    return { canonical, revision: await resolveSessionPlanRevision({
      dataDirectory,
      directory,
      sessionCreated: canonical.sessionCreated,
      sessionSlug: canonical.sessionSlug,
      sourceMessageID: req.params.sourceMessageID,
      path,
    }) };
  };

  const diagnostic = (req, outcome, result, correlation = {}) => { try { recordDiagnostic({ type: 'lifecycle', event: 'session_plan_write',
    sessionID: req.params.sessionID, payload: { outcome, code: result?.code, version: result?.version, ...correlation } }); } catch { /* Observer only. */ } };
  const publish = (req, sessionContext, result) => publishEvent({ type: 'session.plan.updated', properties: {
    sessionID: req.params.sessionID, sourceMessageID: req.params.sourceMessageID,
    directory: sessionContext?.directory || req.body.directory,
    sessionCreated: req.body.sessionCreated, sessionSlug: req.body.sessionSlug, version: result.version,
  } }, { directory: sessionContext?.directory || req.body.directory });

  for (const method of ['post', 'put']) app[method]('/api/session/:sessionID/plan-revisions/:sourceMessageID', async (req, res) => {
    const requestId = randomUUID(), started = performance.now();
    const correlation = { requestId, sourceMessageID: req.params.sourceMessageID,
      trigger: ['completion', 'retry', 'hydration', 'edit'].includes(req.body?.trigger) ? req.body.trigger : 'unknown' };
    const observe = ({ stage, waitMs, holdMs }) => diagnostic(req, stage, null, { ...correlation,
      elapsedMs: Math.round(performance.now() - started), waitMs, holdMs });
    try {
      observe({ stage: 'received' });
      const sessionContext = await authorizeSession(req);
      observe({ stage: 'authorized' });
      const { revision, canonical } = await resolveFromRequest(req, sessionContext);
      observe({ stage: 'source_validated' });
      const authorize = async () => {
        const current = await authorizeSession(req).catch(error => {
          if (error.code === 'plan_owner_unavailable') throw planError(404, 'plan_owner_changed', 'Session not found');
          throw error;
        });
        const refreshed = await resolveFromRequest(req, current);
        if (current.directory !== sessionContext.directory || current.projectId !== sessionContext.projectId
          || current.branchName !== sessionContext.branchName || refreshed.revision.path !== revision.path
          || JSON.stringify(refreshed.canonical.sourceIdentity) !== JSON.stringify(canonical.sourceIdentity)
          || refreshed.canonical.content !== canonical.content) {
          throw planError(404, 'plan_owner_changed', 'Session not found');
        }
      };
      const result = await writePlanRevision(revision, { text: method === 'post' ? canonical.content ?? req.body?.markdown : req.body?.markdown,
        expectedVersion: req.body?.expectedVersion, create: method === 'post', fsApi: fsPromises, authorize, observe });
      diagnostic(req, 'saved', result, { ...correlation, elapsedMs: Math.round(performance.now() - started) });
      try { if (method === 'put' || result.created) publish(req, sessionContext, result); } catch { /* Saved rename is authoritative. */ }
      let content = method === 'put' ? req.body.markdown : canonical.content;
      if (method === 'post' && !result.created && canonical.sourceIdentity) {
        try { const saved = await readPlanRevision(revision, { fsApi: fsPromises }); content = saved.content; result.version = saved.version; }
        catch { content = undefined; } // The already-saved receipt remains truthful.
      }
      return res.json({ ...result, ...(canonical.sourceIdentity ? { sourceIdentity: canonical.sourceIdentity, ...(content !== undefined ? { content } : {}) } : {}) });
    } catch (error) {
      diagnostic(req, 'refused', error, { ...correlation, elapsedMs: Math.round(performance.now() - started) });
      return sendRouteError(res, error, 'Failed to save plan revision');
    }
  });

  app.get('/api/session/:sessionID/plan-revisions/:sourceMessageID', async (req, res) => {
    try {
      const sessionContext = await authorizeSession(req);
      const { revision, canonical } = await resolveFromRequest(req, sessionContext);
      const current = await authorizeSession(req);
      if (current.directory !== sessionContext.directory || current.projectId !== sessionContext.projectId
        || current.branchName !== sessionContext.branchName) throw planError(404, 'plan_owner_changed', 'Session not found');
      return res.json({ ...await readPlanRevision(revision, { fsApi: fsPromises }), ...(canonical.sourceIdentity ? { sourceIdentity: canonical.sourceIdentity } : {}) });
    } catch (error) {
      return sendRouteError(res, error, 'Failed to read plan revision');
    }
  });
};
