import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createOpenCodeClient } from '../opencode-client/index.js';
import { createV2Requester } from '../opencode-client/v2.js';
import { createOpenCodeAdmission } from '../v2/admission.js';
import { createOpenCodeV2FacadeRouter, resolveFacadeDirectory, sendOpenCodeFacadeError } from '../v2/facade-routes.js';
import { createOpenCodeV2SseHandler } from '../v2/sse-routes.js';
import { createGlobalMessageStreamHub } from '../../event-stream/global-hub.js';
import { registerFsRoutes } from '../../fs/routes.js';
import { createStaticRoutesRuntime } from '../static-routes-runtime.js';
import { createSettingsNormalizationRuntime } from '../settings-normalization-runtime.js';
import { createSettingsHelpers } from '../settings-helpers.js';
import { createProjectIdFromPath } from '../../projects/project-id.js';
import { isDirectLocalRequest } from '../../security/direct-local-request.js';
import { uiSessionCookieName } from '../../ui-auth/session-cookie.js';
import { dynamicNoStoreMiddleware } from '../../http-cache-policy.js';
import { registerIndexingPolicy } from '../../indexing-policy.js';
import { parseServeCliOptions } from '../cli-options.js';
import { createStandardPreviewLifecycle } from './lifecycle.js';
import { createStandardPreviewProviders } from './providers.js';
import { STANDARD_PREVIEW_CAPABILITIES, previewUnavailable } from './capabilities.js';

let activeHandle;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = message => Object.assign(new Error(message), { code: 'opencode_invalid_input', statusCode: 400 });
export const parseArgs = () => parseServeCliOptions({ argv: process.argv.slice(2), env: process.env, defaultPort: 3000 });
export const setupProxy = () => {}; // The explicit v2 facade owns every upstream route.
export const restartOpenCode = () => activeHandle?.restartOpenCode();
export const gracefulShutdown = options => activeHandle?.stop(options);

/** In-process desktop feature backend; the only subprocess is the supported stock OpenCode runtime. */
export async function startWebUiServer(options = {}) {
  if (activeHandle) throw Object.assign(new Error('Preview server is already running'), { code: 'standard_preview_server_started' });
  const dataDirectory = options.dataDirectory ?? process.env.OPENCHAMBER_DATA_DIR;
  if (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory)) throw invalid('An isolated preview data directory is required');
  const binary = options.runtimeBinary ?? process.env.DEVRYAN_STANDARD_OPENCODE_BINARY;
  const bindHost = options.host ?? '127.0.0.1';
  if (bindHost !== '127.0.0.1') throw invalid('The desktop preview binds only to 127.0.0.1');
  const normalizers = createSettingsNormalizationRuntime({ os, path, processLike: process });
  const settingsHelpers = createSettingsHelpers({ ...normalizers,
    normalizeTunnelProvider: () => undefined, normalizeTunnelMode: () => undefined, normalizeOptionalPath: () => undefined });
  const settingsFile = path.join(dataDirectory, 'settings.json');
  await fs.promises.mkdir(dataDirectory, { recursive: true });
  let settings = { projects: [] };
  try {
    const parsed = JSON.parse(await fs.promises.readFile(settingsFile, 'utf8'));
    if (!record(parsed)) throw invalid('Invalid preview settings');
    settings = { ...settings, ...settingsHelpers.sanitizeSettingsUpdate(parsed) };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let workingDirectory = options.runtimeWorkingDirectory ?? settings.lastDirectory ?? path.join(dataDirectory, 'workspace');
  if (typeof workingDirectory !== 'string' || !path.isAbsolute(workingDirectory)) throw invalid('Invalid preview project directory');
  await fs.promises.mkdir(workingDirectory, { recursive: true });
  workingDirectory = await fs.promises.realpath(workingDirectory);
  let settingsQueue = Promise.resolve(), stopping = false, readyPromise;
  const formatSettings = () => ({ ...settingsHelpers.formatSettingsResponse(settings),
    runtimeMode: 'standard-preview', desktopLanAccessEnabled: false, agentBrowserControlEnabled: false });
  const persistSettings = input => {
    const write = settingsQueue.catch(() => {}).then(async () => {
      if (stopping) throw Object.assign(new Error('Preview server is stopping'), { statusCode: 503 });
      if (!record(input)) throw invalid('Settings must be an object');
      if (Object.keys(input).some(key => /^(?:opencodeBinary|desktopLanAccessEnabled|agentBrowserControlEnabled|tunnel|managedRemote|productionBots|supabase)/i.test(key))) {
        throw previewUnavailable('runtimeConfiguration');
      }
      const next = settingsHelpers.mergePersistedSettings(settings, settingsHelpers.sanitizeSettingsUpdate(input));
      const temporary = `${settingsFile}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.promises.writeFile(temporary, JSON.stringify(next), { flag: 'wx', mode: 0o600 });
        await fs.promises.rename(temporary, settingsFile);
      } finally { await fs.promises.rm(temporary, { force: true }); }
      settings = next; return formatSettings();
    });
    settingsQueue = write; return write;
  };
  const resolveDirectory = async req => {
    const query = req.query?.directory, header = req.headers?.['x-opencode-directory'];
    if (query !== undefined && typeof query !== 'string' || header !== undefined && typeof header !== 'string') throw invalid('Invalid project directory');
    let decoded;
    try { decoded = header ? decodeURIComponent(header) : undefined; } catch { throw invalid('Invalid project directory'); }
    if (query && decoded && query !== decoded) throw invalid('Project directories do not agree');
    const candidate = normalizers.normalizeDirectoryPath(query || decoded || workingDirectory);
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || candidate.includes('\0')) throw invalid('An absolute project directory is required');
    const directory = await fs.promises.realpath(candidate);
    if (!(await fs.promises.stat(directory)).isDirectory()) throw invalid('Project directory is not a directory');
    return { directory };
  };
  const app = express(), server = http.createServer(app);
  let hub;
  const lifecycle = createStandardPreviewLifecycle({ binary, dataDirectory, workingDirectory,
    configFile: options.runtimeConfigFile,
    ...(options.lifecycleDependencies ?? {}),
    isCatalogReady: async () => {
      const agents = await baseClient.catalog.agents({ directory: workingDirectory });
      await integrations.providerMethods({ directory: workingDirectory });
      return agents.some(agent => agent.mode === 'primary' || agent.mode === 'all' || agent.name === 'build');
    },
    onChanged: () => { if (!lifecycle.snapshot().ready) hub?.stop(); },
    onBeforeStop: () => hub?.stop(),
  });
  let admission;
  const deps = { getRuntime: lifecycle.getRuntime, getAuthHeaders: lifecycle.getAuthHeaders,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}), getAdmission: () => admission,
    projector: () => hub?.getProjector() };
  const ordinaryRequest = createV2Requester(deps), baseClient = createOpenCodeClient(deps);
  // Stock session removal owns its own database effects; no native removal authority is fabricated.
  const openCodeClient = { ...baseClient, sessions: { ...baseClient.sessions,
    remove: async (sessionID, requestOptions) => {
      await ordinaryRequest({ ...requestOptions, label: 'preview.sessions.remove', method: 'DELETE', path: `/api/session/${encodeURIComponent(sessionID)}` }); return true;
    } }, catalog: { ...baseClient.catalog, tools: async () => ({ ids: [], definitions: [] }) },
    health: { ...baseClient.health, probe: async () => ({ ready: await lifecycle.probe(), generation: 2,
      runtimeMode: 'standard-preview', version: '2.0.20' }) } };
  admission = createOpenCodeAdmission(deps);
  const integrations = createStandardPreviewProviders(deps);
  hub = createGlobalMessageStreamHub({ getOpenCodeAuthHeaders: lifecycle.getAuthHeaders,
    openCodeClient, getOpenCodeRuntime: lifecycle.getRuntime, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
  const ownerToken = crypto.randomBytes(32).toString('base64url');
  const authenticated = req => {
    const name = uiSessionCookieName(req.socket.localPort);
    return String(req.headers.cookie ?? '').split(';').some(part => part.trim() === `${name}=${ownerToken}`);
  };
  registerIndexingPolicy(app); app.use(dynamicNoStoreMiddleware);
  app.use((req, res, next) => {
    if (!isDirectLocalRequest(req)) return res.status(403).json({ code: 'direct_local_request_required' });
    const requestPort = new URL(`http://${req.headers.host}`).port;
    if (Number(requestPort || 80) !== req.socket.localPort) return res.sendStatus(403);
    res.setHeader('X-Content-Type-Options', 'nosniff'); next();
  });
  const health = (_req, res) => {
    const snapshot = lifecycle.snapshot();
    res.json({ status: 'ok', runtimeMode: 'standard-preview', isOpenCodeReady: snapshot.ready, openCodeRunning: snapshot.ready,
      openCodeVersion: snapshot.version, openCodeGeneration: 2, openCodeSecureConnection: snapshot.ready,
      lastOpenCodeError: snapshot.lastError, executionRuntime: { state: 'disabled', code: 'standard_preview_feature_unavailable' },
      openCode: { generation: 2, runtimeMode: 'standard-preview', ordinaryUserPermissions: true,
        ready: snapshot.ready, version: snapshot.version, runtimeIdentity: `standard-preview:${snapshot.epoch}`,
        capabilities: STANDARD_PREVIEW_CAPABILITIES } });
  };
  app.get('/health', health); app.get('/api/health', health);
  app.get('/auth/session', (req, res) => res.status(authenticated(req) ? 200 : 401).json({ authenticated: authenticated(req), locked: !authenticated(req), scope: 'local' }));
  app.get('/auth/passkey/status', (_req, res) => res.json({ enabled: false, available: false }));
  app.use(['/api', '/auth'], (req, res, next) => authenticated(req) ? next() : res.status(401).json({ code: 'local_owner_session_required' }));
  app.use(express.json({ limit: '25mb' }));
  const unavailable = capability => (_req, res) => sendOpenCodeFacadeError(res, previewUnavailable(capability));
  app.get('/api/terminal/capabilities', (_req, res) => res.json({ available: false, code: 'standard_preview_feature_unavailable' }));
  // Refuse both application contracts and raw v2 variants before generic facade routing.
  app.use((req, res, next) => {
    const pathname = req.path;
    let capability;
    if (/^\/api\/(?:bots?|scheduled-tasks|orchestration|tasks|session-execution|execution-runtime|runtime-bundle|runtime-service)(?:\/|$)/i.test(pathname)) capability = 'managedChildTasks';
    else if (/^\/api\/(?:browser|agent-browser|browser-cdp|preview|instances)(?:\/|$)/i.test(pathname)) capability = 'browser';
    else if (/^\/api\/(?:media|tts|image-assets|images|image-generation)(?:\/|$)/i.test(pathname)) capability = 'media';
    else if (/^\/api\/(?:terminal|pty)(?:\/|$)/i.test(pathname)) capability = 'terminal';
    else if (/^\/api\/(?:cursor|claude|anthropic|openai\/oauth|chatgpt|mcp|credential)(?:\/|$)/i.test(pathname)
      || /^\/api\/provider\/[^/]+\/oauth(?:\/|$)/i.test(pathname)) capability = 'providerOAuth';
    else if (/^\/api\/session\/[^/]+\/(?:revert|unrevert|scoped-revert|scoped-unrevert|changes|change-summary|shell|execution|task)(?:\/|$)/i.test(pathname)) capability = 'revert';
    else if (/^\/api\/fs\/(?:exec|clone|reveal)(?:\/|$)/i.test(pathname)) capability = 'nativeExecution';
    else if (req.method === 'POST' && pathname === '/api/session' && req.body?.parentID) capability = 'managedChildTasks';
    else if (pathname.startsWith('/api/opencode-v2/')) capability = 'nativeExecution';
    if (capability) return unavailable(capability)(req, res);
    next();
  });
  app.get('/api/config/settings', (_req, res) => res.json(formatSettings()));
  app.put('/api/config/settings', async (req, res) => res.json(await persistSettings(req.body)));
  app.get('/api/config/opencode-resolution', (_req, res) => res.json({ targetVersion: '2.0.20', detectedVersion: lifecycle.snapshot().version,
    source: 'bundled-stock-preview', resolved: binary, launchBinary: binary, viaWsl: false }));
  app.post('/api/config/reload', async (_req, res) => { await restart(); res.json({ success: true, runtimeApplied: true, requiresReload: false }); });
  app.post('/api/opencode/directory', async (req, res) => {
    const candidate = normalizers.normalizeDirectoryPath(req.body?.path);
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) throw invalid('An absolute project path is required');
    const directory = await fs.promises.realpath(candidate);
    if (!(await fs.promises.stat(directory)).isDirectory()) throw invalid('Project directory is not a directory');
    const projects = settings.projects ?? [], existing = projects.find(project => project.path === directory);
    const project = existing ?? { id: createProjectIdFromPath(directory), path: directory, addedAt: Date.now(), lastOpenedAt: Date.now() };
    const updated = await persistSettings({ projects: existing ? projects : [...projects, project], activeProjectId: project.id, lastDirectory: directory });
    workingDirectory = directory;
    res.json({ success: true, restarted: false, path: directory, settings: updated });
  });
  app.get('/api/provider/:providerID/source', async (req, res) => res.json(await integrations.source(req.params.providerID,
    { directory: await resolveFacadeDirectory(req, resolveDirectory) })));
  registerFsRoutes(app, { os, path, fsPromises: fs.promises, spawn, crypto,
    normalizeDirectoryPath: normalizers.normalizeDirectoryPath, resolveProjectDirectory: resolveDirectory,
    buildAugmentedPath: () => process.env.PATH ?? '', resolveGitBinaryForSpawn: () => process.platform === 'win32' ? 'git.exe' : 'git',
    openchamberUserConfigRoot: path.join(dataDirectory, 'runtime', 'config', 'opencode') });
  const stream = createOpenCodeV2SseHandler({ globalMessageStreamHub: hub, resolveRequestDirectory: resolveDirectory });
  app.get(['/api/event', '/api/global/event'], stream);
  app.use('/api', (req, res, next) => lifecycle.snapshot().ready ? next() : res.status(503).json({ code: 'opencode_unavailable', retryable: true }));
  app.use('/api', createOpenCodeV2FacadeRouter({ openCodeClient, getOpenCodeRuntime: lifecycle.getRuntime,
    getOpenCodeAuthHeaders: lifecycle.getAuthHeaders, resolveRequestDirectory: resolveDirectory, integrations,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) }));
  createStaticRoutesRuntime({ fs, path, process, express, __dirname: fileURLToPath(new URL('../../../', import.meta.url)),
    resolveProjectDirectory: resolveDirectory, openCodeClient, readSettingsFromDiskMigrated: async () => settings,
    normalizePwaAppName: settingsHelpers.normalizePwaAppName, normalizePwaOrientation: settingsHelpers.normalizePwaOrientation,
  }).registerStaticRoutes(app);
  app.use((error, _req, res, _next) => sendOpenCodeFacadeError(res, error));
  const startRuntime = () => readyPromise ??= lifecycle.start().then(() => { hub.start(); options.onOpenCodeStartupStatus?.('DevRyan preview is ready.'); })
    .catch(error => { readyPromise = undefined; throw error; });
  const restart = async () => { readyPromise = undefined; await lifecycle.stop(); return startRuntime(); };
  let shutdownPromise, signals = [];
  const stop = ({ exitProcess = false } = {}) => shutdownPromise ??= (async () => {
    stopping = true;
    for (const [signal, handler] of signals) process.off(signal, handler);
    signals = []; hub.stop();
    await settingsQueue.catch(() => {});
    let failure;
    try { await lifecycle.close(); } catch (error) { failure = error; }
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    if (failure) { shutdownPromise = undefined; throw failure; }
    if (activeHandle === handle) activeHandle = undefined;
    if (exitProcess) process.exit(0);
  })();
  const handle = { expressApp: app, httpServer: server, getPort: () => server.address()?.port,
    getOpenCodePort: () => lifecycle.snapshot().port, isReady: () => lifecycle.snapshot().ready,
    isOpenCodeStartupDeferred: () => !readyPromise, resumeDeferredOpenCodeStartup: startRuntime,
    restartOpenCode: restart, stop,
    issueLocalOwnerSession: async () => ({ name: uiSessionCookieName(server.address().port), value: ownerToken, maxAge: 24 * 60 * 60 }),
    getQuitRiskStatus: async () => ({ tunnel: { active: false }, scheduledTasks: { runningScheduledTasksCount: 0, verified: true }, scheduledTasksVerified: true }),
    prepareBotRuntime: async () => ({ state: 'skipped', reason: 'bots_unavailable' }), getTunnelUrl: () => null };
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 3000, bindHost, resolve); });
  activeHandle = handle;
  if (options.attachSignals !== false) for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => { void stop({ exitProcess: options.exitOnShutdown === true }); };
    process.on(signal, handler); signals.push([signal, handler]);
  }
  try { if (!options.deferOpenCodeStartup) await startRuntime(); }
  catch (error) { await stop(); throw error; }
  return handle;
}

export function runWebCliEntry(currentFilename) {
  if (process.argv[1] !== currentFilename) return;
  void startWebUiServer({ ...parseArgs(), attachSignals: true, exitOnShutdown: true }).catch(error => {
    console.error(error.code ?? 'standard_preview_start_failed'); process.exitCode = 1;
  });
}
