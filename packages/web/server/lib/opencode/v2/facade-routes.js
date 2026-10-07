import express from 'express';
import { beginSessionCreationTrace, creationNotDispatchedPayload, creationUnknownPayload, isSessionCreateRequest } from '../session-creation.js';
import { resolveOpenCodeGeneration } from '../opencode-generation.js';
import { createUnknownOpenCodeRoutePayload } from '../opencode-routes.js';
import { stripMessageDiffContent } from '../diff-summary.js';
import { createV2Requester } from '../opencode-client/v2.js';
import { unwrapList } from '../opencode-client/envelope.js';
import { createNativeIntegrationFacade } from './native-integration-facade.js';
import { toV1Projects } from './projection/catalog.js';
import { checkBrowserSessionPatchBody, evaluateOpenCodeV2Request, normalizeOpenCodeV2Path } from './route-policy.js';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = (message) => Object.assign(new Error(message), { statusCode: 400, code: 'opencode_invalid_input' });
const unavailable = (capability) => Object.assign(new Error(`OpenCode 2 does not provide ${capability}`), {
  statusCode: 501, code: 'capability_unavailable', capability,
});

export const sendOpenCodeFacadeError = (res, error) => {
  if (res.headersSent || res.destroyed) return;
  const candidate = error?.statusCode ?? error?.status;
  const status = Number.isInteger(candidate) && candidate >= 400 && candidate <= 599 ? candidate : 502;
  res.status(status).json({
    error: status === 502 && !error?.code ? 'OpenCode service unavailable' : error.message,
    code: typeof error?.code === 'string' ? error.code : 'opencode_unavailable',
    ...(typeof error?.capability === 'string' ? { capability: error.capability } : {}),
    retryable: error?.retryable === true,
  });
};

export const resolveFacadeClient = (source) => typeof source === 'function' ? source() : source;

/** Resolve only explicit request locations or the host's authoritative workspace. */
export const resolveFacadeDirectory = async (req, resolveRequestDirectory) => {
  const query = req.query?.directory;
  const header = req.headers?.['x-opencode-directory'];
  if (query !== undefined && typeof query !== 'string') throw invalid('directory must be a string');
  if (header !== undefined && typeof header !== 'string') throw invalid('x-opencode-directory must be a string');
  let decoded;
  try { decoded = header === undefined ? undefined : decodeURIComponent(header); }
  catch { throw invalid('x-opencode-directory is malformed'); }
  if (query && decoded && query !== decoded) throw invalid('Request directories do not agree');
  const explicit = query || decoded;
  if (explicit) return explicit;
  const resolved = typeof resolveRequestDirectory === 'function' ? await resolveRequestDirectory(req) : undefined;
  return typeof resolved === 'string' ? resolved : resolved?.directory;
};

const stringQuery = (req, key) => {
  const value = req.query?.[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalid(`${key} must be a string`);
  return value;
};
const numberQuery = (req, key, positive = false) => {
  const value = stringQuery(req, key);
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!value || !Number.isSafeInteger(number) || number < (positive ? 1 : 0)) throw invalid(`${key} must be ${positive ? 'a positive' : 'a nonnegative'} integer`);
  return number;
};
const booleanQuery = (req, key) => {
  const value = stringQuery(req, key);
  if (value === undefined) return undefined;
  if (value !== 'true' && value !== 'false') throw invalid(`${key} must be true or false`);
  return value === 'true';
};
export const validateFacadeBody = (body, allowed) => {
  if (!isRecord(body) || Object.keys(body).some((key) => !allowed.includes(key))) throw invalid('Request body contains unsupported fields');
  return body;
};

export const readFacadeSessionQuery = (req) => ({
  directory: stringQuery(req, 'directory'), parentID: stringQuery(req, 'parentID'), roots: booleanQuery(req, 'roots'),
  archived: booleanQuery(req, 'archived'), search: stringQuery(req, 'search'), limit: numberQuery(req, 'limit', true),
});

export const readFacadeMessagePage = (req) => ({ limit: numberQuery(req, 'limit', true), before: stringQuery(req, 'before') });

/** Keep each timestamp cohort together for legacy strict-before cursors. */
export const listFacadeSessionPage = async (client, req, options = {}) => {
  const { limit = 100, ...query } = readFacadeSessionQuery(req);
  const before = numberQuery(req, 'cursor');
  const start = numberQuery(req, 'start');
  if (stringQuery(req, 'workspace')) throw unavailable('workspaceSessionFilter');
  const all = await client.sessions.list(query, options);
  const sorted = all.filter((session) => (before === undefined || session.time?.updated < before)
    && (start === undefined || session.time?.updated >= start))
    .sort((left, right) => (right.time?.updated ?? 0) - (left.time?.updated ?? 0) || left.id.localeCompare(right.id));
  let end = Math.min(limit, sorted.length);
  while (end < sorted.length && sorted[end].time?.updated === sorted[end - 1].time?.updated) end++;
  const sessions = sorted.slice(0, end);
  return { sessions, nextCursor: end < sorted.length ? sessions.at(-1).time.updated : null };
};

/**
 * Mount at `/api`, after DevRyan's ownership/Cursor/config shadows and before
 * this native facade. Unknown routes terminate here.
 * No privileged client or arbitrary upstream URL is accepted by this boundary.
 */
export const createOpenCodeV2FacadeRouter = (deps) => {
  const router = express.Router({ caseSensitive: true });
  const request = createV2Requester({
    getRuntime: deps.getOpenCodeRuntime,
    getAuthHeaders: deps.getOpenCodeAuthHeaders,
    fetchImpl: deps.fetchImpl,
    policy: deps.policy,
    recordDiagnostic: deps.recordDiagnostic,
  });
  const integrations = deps.integrations ?? createNativeIntegrationFacade({ getNativeRuntimeOwner: deps.getNativeRuntimeOwner, getOpenCodeRuntime: deps.getOpenCodeRuntime, request });
  router.use((req, res, next) => {
    try {
      const client = resolveFacadeClient(deps.openCodeClient);
      resolveOpenCodeGeneration(client);
      // Express matches case-insensitively and decodes parameters by default.
      // Reject ambiguous targets before any facade path can elevate an operation.
      const normalized = normalizeOpenCodeV2Path(req.url);
      if (!normalized.ok || normalized.canonicalPath !== req.path.replace(/\/$/, '')) {
        return res.status(404).json(createUnknownOpenCodeRoutePayload());
      }
      req.openCodeFacadeClient = client;
      next();
    } catch (error) { sendOpenCodeFacadeError(res, error); }
  });
  router.use(express.json({ limit: '50mb' }));
  router.use((req, _res, next) => {
    if (isSessionCreateRequest(req)) beginSessionCreationTrace(req, deps.recordCreationTiming);
    next();
  });

  const route = (method, path, operation) => router[method](path, async (req, res) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once('aborted', abort);
    res.once('close', abort);
    try {
      const directory = await resolveFacadeDirectory(req, deps.resolveRequestDirectory);
      const options = { directory, signal: controller.signal, headers: {
        'x-openchamber-message-id': req.headers['x-openchamber-message-id'],
      } };
      const result = await operation(req.openCodeFacadeClient, req, res, options);
      if (!res.headersSent && !res.writableEnded && !res.destroyed) res.json(result);
    } catch (error) { sendOpenCodeFacadeError(res, error); }
    finally { req.off('aborted', abort); res.off('close', abort); }
  });

  router.use('/opencode-v2', async (req, res) => {
    // Evaluate the canonical upstream path as browser, even though the narrow
    // requester below also enforces server policy. Never forward browser auth.
    const decision = evaluateOpenCodeV2Request({ audience: 'browser', method: req.method, path: `/api${req.url}`, body: req.body });
    if (!decision.allowed) return res.status(404).json(createUnknownOpenCodeRoutePayload());
    try {
      const result = await request({ label: 'browser.raw', method: req.method, path: decision.canonicalPath });
      return res.json(result);
    } catch (error) { return sendOpenCodeFacadeError(res, error); }
  });

  route('get', '/session/status', (client, _req, _res, options) => client.sessions.status({ directory: options.directory }, options));
  route('get', '/session', (client, req, _res, options) => client.sessions.list(readFacadeSessionQuery(req), options));
  route('get', '/experimental/session', async (client, req, res, options) => {
    const page = await listFacadeSessionPage(client, req, options);
    if (page.nextCursor !== null) res.setHeader('x-next-cursor', String(page.nextCursor));
    return page.sessions;
  });
  route('post', '/session', async (client, req, res, options) => {
    const input = validateFacadeBody(req.body ?? {}, ['id', 'title', 'parentID', 'agent', 'model']);
    const trace = beginSessionCreationTrace(req);
    const remainingMs = trace.remainingMs();
    if (remainingMs <= 0) return res.status(408).json(creationNotDispatchedPayload());
    options.signal.throwIfAborted();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), remainingMs);
    try {
      trace.mark('upstream_create_started');
      const result = await client.sessions.create(input, {
        ...options, timeoutMs: remainingMs, signal: AbortSignal.any([options.signal, deadline.signal]),
      });
      if (!result || typeof result.id !== 'string' || !result.id.trim()) {
        trace.mark('outcome_unknown');
        return res.status(502).json(creationUnknownPayload());
      }
      trace.mark('acknowledged', result.id);
      return result;
    } catch (error) {
      const status = error?.statusCode ?? error?.status;
      if (Number.isInteger(status) && status >= 400 && status < 500) throw error;
      trace.mark('outcome_unknown');
      if (!res.destroyed) res.status(Number.isInteger(status) && status >= 500 && status <= 599 ? status : 502).json(creationUnknownPayload());
    } finally { clearTimeout(timer); }
  });
  route('get', '/session/:sessionID', (client, req, _res, options) => client.sessions.get(req.params.sessionID, options));
  route('patch', '/session/:sessionID', (client, req, _res, options) => {
    if (!checkBrowserSessionPatchBody(req.body).ok) throw invalid('Only title may be updated through the session facade');
    return client.sessions.update(req.params.sessionID, req.body, options);
  });
  route('delete', '/session/:sessionID', (client, req, _res, options) => client.sessions.remove(req.params.sessionID, options));
  route('get', '/session/:sessionID/children', (client, req, _res, options) => client.sessions.children(req.params.sessionID, options));
  route('post', '/session/:sessionID/fork', (client, req, _res, options) => client.sessions.fork(req.params.sessionID, validateFacadeBody(req.body ?? {}, ['messageID']), options));
  route('post', '/session/:sessionID/abort', (client, req, _res, options) => client.sessions.abort(req.params.sessionID, options));
  route('get', '/session/:sessionID/message', async (client, req, res, options) => {
    const page = await client.sessions.messages(req.params.sessionID, readFacadeMessagePage(req), options);
    if (page.cursor) res.setHeader('x-next-cursor', page.cursor);
    return page.records.map(stripMessageDiffContent);
  });
  route('get', '/session/:sessionID/message/:messageID', async (client, req, _res, options) => stripMessageDiffContent(await client.sessions.message(req.params.sessionID, req.params.messageID, options)));
  route('get', '/session/:sessionID/diff', (client, req, _res, options) => client.sessions.diff(req.params.sessionID, { messageID: stringQuery(req, 'messageID') }, options));
  route('get', '/session/:sessionID/todo', (client, req, _res, options) => client.sessions.todo(req.params.sessionID, options));
  route('post', '/session/:sessionID/prompt_async', async (client, req, res, options) => {
    await client.prompts.prompt(req.params.sessionID, req.body, options);
    res.status(204).end();
  });
  route('post', '/session/:sessionID/command', (client, req, _res, options) => client.prompts.command(req.params.sessionID, req.body, options));
  route('post', '/session/:sessionID/summarize', (client, req, _res, options) => client.prompts.compact(req.params.sessionID, req.body ?? {}, options));
  for (const [path, group] of [['permission', 'permissions'], ['question', 'questions']]) {
    route('get', `/${path}`, (client, _req, _res, options) => client.interaction[group].list({ directory: options.directory }, options));
    route('post', `/${path}/:requestID/reply`, (client, req, _res, options) => client.interaction[group].reply(req.params.requestID, req.body, options));
  }
  route('post', '/question/:requestID/reject', (client, req, _res, options) => client.interaction.questions.reject(req.params.requestID, options));
  route('post', '/session/:sessionID/permissions/:permissionID', (client, req, _res, options) => client.interaction.permissions.reply(
    req.params.permissionID, { reply: req.body?.response }, { ...options, sessionID: req.params.sessionID },
  ));
  for (const [path, operation] of Object.entries({
    agent: 'agents', command: 'commands', skill: 'skills', provider: 'providerList', 'config/providers': 'providers',
    config: 'config', 'global/config': 'config', mcp: 'mcp', path: 'path', 'project/current': 'project', vcs: 'vcs',
  })) route('get', `/${path}`, (client, _req, _res, options) => client.catalog[operation]({ directory: options.directory }, options));
  route('get', '/project', async (_client, _req, _res, options) => toV1Projects(unwrapList(await request({ ...options, label: 'browser.projects', path: '/api/project' }))));
  route('get', '/lsp', () => []);
  for (const suffix of ['', '/ids']) route('get', `/experimental/tool${suffix}`, async (client, req, _res, options) => {
    const tools = await client.catalog.tools({ directory: options.directory, providerID: stringQuery(req, 'provider'), modelID: stringQuery(req, 'model') }, options);
    return suffix ? tools.ids : tools.definitions;
  });
  for (const action of ['connect', 'disconnect']) route('post', `/mcp/:name/${action}`, (_client, req, _res, options) => {
    validateFacadeBody(req.body ?? {}, []);
    return integrations.mcpConnect(req.params.name, action, options);
  });
  for (const suffix of ['/auth', '/auth/authenticate', '/authenticate']) route('post', `/mcp/:name${suffix}`, (_client, req, _res, options) => {
    validateFacadeBody(req.body ?? {}, []);
    return integrations.mcpStart(req.params.name, options);
  });
  route('post', '/mcp/:name/auth/callback', (_client, req, _res, options) => integrations.mcpComplete(req.params.name, req.body ?? {}, options));
  route('delete', '/mcp/:name/auth', (_client, req, _res, options) => {
    validateFacadeBody(req.body ?? {}, []); return integrations.mcpRemove(req.params.name, options);
  });
  route('get', '/provider/auth', (_client, _req, _res, options) => integrations.providerMethods(options));
  route('post', '/provider/:providerID/oauth/authorize', (_client, req, _res, options) => integrations.providerStart(req.params.providerID, req.body ?? {}, options));
  route('post', '/provider/:providerID/oauth/callback', (_client, req, _res, options) => integrations.providerComplete(req.params.providerID, req.body ?? {}, options));
  route('put', '/auth/:providerID', (_client, req, _res, options) => integrations.saveKey(req.params.providerID, req.body ?? {}, options));
  route('delete', '/provider/:providerID/auth', (_client, req, _res, options) => {
    validateFacadeBody(req.body ?? {}, []);
    return integrations.providerDisconnect(req.params.providerID, stringQuery(req, 'scope') ?? 'auth', options);
  });
  route('patch', '/credential/:credentialID', (_client, req, _res, options) => integrations.credentialMutation(req.params.credentialID, 'update', req.body, options));
  route('post', '/credential/:credentialID/activate', (_client, req, _res, options) => integrations.credentialMutation(req.params.credentialID, 'activate', req.body, options));
  route('delete', '/credential/:credentialID', (_client, req, _res, options) => integrations.credentialMutation(req.params.credentialID, 'remove', req.body, options));

  const disabled = (capability) => (_req, res) => sendOpenCodeFacadeError(res, unavailable(capability));
  router.all('/session/:sessionID/share', disabled('share'));
  router.all('/session/:sessionID/shell', disabled('sessionShell'));
  router.patch('/session/:sessionID/message/:messageID/part/:partID', disabled('messageEdit'));
  router.delete('/session/:sessionID/message/:messageID', disabled('messageEdit'));
  router.delete('/session/:sessionID/message/:messageID/part/:partID', disabled('messageEdit'));
  router.post('/session/:sessionID/message', disabled('synchronousPrompt'));
  router.all(['/file', '/file/{*rest}', '/find/file'], disabled('upstreamFiles'));
  router.all(['/provider/:providerID/oauth/{*rest}', '/auth/:providerID'], disabled('providerAuthentication'));
  router.use((_req, res) => res.status(404).json(createUnknownOpenCodeRoutePayload()));
  router.use((error, _req, res, _next) => sendOpenCodeFacadeError(res, error));
  return router;
};
