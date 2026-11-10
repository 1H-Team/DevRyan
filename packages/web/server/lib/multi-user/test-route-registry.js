// Test-only fixture for route-policy-coverage.test.js. It runs the server's
// real route registrars against a recording app, so the route list comes
// from the registration code and never from a hand-kept copy, and it builds a
// real multi-user runtime on a fake control plane so the managed-user policy
// that decides requests is the production one. Nothing here listens on a
// port, starts OpenCode or the native runtime, or reaches the network.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const THIS_FILE = fileURLToPath(import.meta.url);
export const ROUTE_METHODS = Object.freeze(['get', 'post', 'put', 'patch', 'delete', 'all']);

// ---------------------------------------------------------------------------
// Dependency stubs. A registrar may read any dependency, call it, await it or
// destructure from it while registering; the stub answers all of that with
// another stub and never performs work. It is not thenable, so `await stub`
// settles to the stub itself.
export const createStub = (label = 'stub') => {
  const children = new Map();
  const target = function stub() {};
  return new Proxy(target, {
    get(_target, property) {
      if (property === 'then') return undefined;
      if (property === Symbol.toPrimitive) return (hint) => (hint === 'number' ? 0 : `[${label}]`);
      if (property === Symbol.iterator) return function* empty() {};
      if (property === Symbol.asyncIterator) return async function* empty() {};
      if (property === 'toString' || property === 'valueOf' || property === 'toJSON') return () => `[${label}]`;
      if (!children.has(property)) children.set(property, createStub(`${label}.${String(property)}`));
      return children.get(property);
    },
    apply: () => createStub(`${label}()`),
    construct: () => createStub(`new ${label}`),
    has: () => true,
  });
};

// Dependencies with fixed values; everything else is a stub.
export const createDependencies = (overrides = {}) => new Proxy(overrides, {
  get(target, property) {
    if (Object.hasOwn(target, property)) return target[property];
    if (typeof property === 'symbol') return undefined;
    target[property] = createStub(String(property));
    return target[property];
  },
});

// ---------------------------------------------------------------------------
// Recording app. Each registration records its method, path, order and the
// source line that made it, read from the call stack.
const callerLocation = () => {
  const lines = String(new Error().stack || '').split('\n').slice(1);
  for (const line of lines) {
    const match = line.match(/\(?((?:file:\/\/)?\/[^():]+):(\d+):\d+\)?$/);
    if (!match) continue;
    const file = match[1].startsWith('file://') ? fileURLToPath(match[1]) : match[1];
    if (file === THIS_FILE || !file.startsWith(SERVER_ROOT) || file.includes(`${path.sep}node_modules${path.sep}`)) continue;
    return { file: path.relative(SERVER_ROOT, file), line: Number(match[2]) };
  }
  return { file: '<unknown>', line: 0 };
};

// String patterns stay as written; a RegExp route is recorded by its source.
const pathsOf = (value) => (Array.isArray(value) ? value : [value])
  .filter((entry) => typeof entry === 'string' || entry instanceof RegExp)
  .map((entry) => (entry instanceof RegExp ? `regex:${entry.source}` : entry));

const joinMount = (prefix, routePath) => {
  if (!prefix || prefix === '/') return routePath;
  if (routePath === '/' || routePath === '') return prefix;
  return `${prefix.replace(/\/$/, '')}${routePath}`;
};

// express.Router() registrations. While the registry runs, the Router
// prototype records each router.<verb>(path) and router.use(path, ...) with
// its source line, keyed by the router, so a router mounted with
// app.use(prefix, router) contributes its routes and path mounts.
const routerRecords = new WeakMap();
const withRouterRecording = async (action) => {
  let prototype = Object.getPrototypeOf(express.Router());
  while (prototype && !Object.hasOwn(prototype, 'use')) prototype = Object.getPrototypeOf(prototype);
  if (!prototype) throw new Error('Express Router prototype not found');
  const originals = new Map();
  const record = (router, entry) => {
    if (!routerRecords.has(router)) routerRecords.set(router, []);
    routerRecords.get(router).push({ ...entry, ...callerLocation() });
  };
  for (const method of ROUTE_METHODS) {
    originals.set(method, prototype[method]);
    prototype[method] = function recordedRoute(routePath, ...handlers) {
      for (const entry of pathsOf(routePath)) record(this, { kind: 'route', method: method.toUpperCase(), path: entry });
      return originals.get(method).call(this, routePath, ...handlers);
    };
  }
  originals.set('use', prototype.use);
  prototype.use = function recordedUse(...args) {
    const first = args[0];
    if (typeof first === 'string' || Array.isArray(first)) {
      for (const entry of pathsOf(first)) record(this, { kind: 'mount', method: 'USE', path: entry });
    }
    for (const handler of args) {
      if (typeof handler === 'function' && routerRecords.has(handler)) throw new Error('Nested routers are not enumerated');
    }
    return originals.get('use').apply(this, args);
  };
  try {
    return await action();
  } finally {
    for (const [method, original] of originals) prototype[method] = original;
  }
};

export const createRecordingApp = () => {
  const routes = [];
  const mounts = [];
  const settings = new Map();
  let order = 0;
  const app = {
    locals: {},
    settings: {},
    set(key, value) { settings.set(key, value); return app; },
    enable(key) { settings.set(key, true); return app; },
    disable(key) { settings.set(key, false); return app; },
    enabled: (key) => settings.get(key) === true,
    disabled: (key) => settings.get(key) !== true,
    engine: () => app,
    param: () => app,
    on: () => app,
    once: () => app,
    listen() { throw new Error('The route registry never listens'); },
    use(...args) {
      const location = callerLocation();
      const first = args[0];
      const prefixes = typeof first === 'string' || first instanceof RegExp || Array.isArray(first) ? pathsOf(args.shift()) : [null];
      for (const prefix of prefixes) {
        const index = order++;
        mounts.push({ path: prefix, order: index, ...location, handlers: args, viaRouter: false });
        for (const handler of args) {
          if (typeof handler !== 'function' || !Array.isArray(handler.stack)) continue;
          if (!routerRecords.has(handler)) throw new Error(`Router mounted at ${prefix} was created outside the registry`);
          for (const entry of routerRecords.get(handler)) {
            const target = entry.kind === 'route' ? routes : mounts;
            target.push({
              method: entry.method, path: joinMount(prefix || '', entry.path), order: index,
              file: entry.file, line: entry.line, viaRouter: true, ...(entry.kind === 'mount' ? { handlers: [] } : {}),
            });
          }
        }
      }
      return app;
    },
  };
  for (const method of ROUTE_METHODS) {
    app[method] = (...args) => {
      // app.get(name) with one argument reads a setting.
      if (method === 'get' && args.length === 1 && typeof args[0] === 'string') return settings.get(args[0]);
      if (pathsOf(args[0]).length === 0) throw new Error(`Unreadable route path registered with app.${method}`);
      const location = callerLocation();
      for (const routePath of pathsOf(args[0])) {
        routes.push({ method: method.toUpperCase(), path: routePath, order: order++, ...location, viaRouter: false });
      }
      return app;
    };
  }
  app.route = (routePath) => {
    const chain = {};
    for (const method of ROUTE_METHODS) chain[method] = (...handlers) => { app[method](routePath, ...handlers); return chain; };
    return chain;
  };
  const addSourceOnly = ({ file, method, path: entryPath }) => {
    const entry = { method, path: entryPath, order: order++, file, line: 0, viaRouter: false, sourceOnly: true };
    if (method === 'USE') mounts.push({ ...entry, handlers: [] });
    else routes.push(entry);
  };
  return { app, routes, mounts, addSourceOnly };
};

// ---------------------------------------------------------------------------
// Fake control plane: just enough Supabase for the password-free agent-test
// login of a managed developer, a senior developer and an administrator.
// Both non-administrators are assigned the same fake project and their own
// branch. All identities are fake and every address resolves to an
// in-memory answer.
export const FAKE_USERS = Object.freeze({
  senior_developer: Object.freeze({
    id: '0a0a0a0a-0000-4000-8000-00000000c001',
    email: 'route-policy-senior@example.test',
    display_name: 'Route Policy Senior Developer',
    role: 'senior_developer',
    status: 'active',
    github_account_id: null,
    account_kind: 'agent_test',
  }),
  developer: Object.freeze({
    id: '0a0a0a0a-0000-4000-8000-00000000d001',
    email: 'route-policy-developer@example.test',
    display_name: 'Route Policy Developer',
    role: 'developer',
    status: 'active',
    github_account_id: null,
    account_kind: 'agent_test',
  }),
  admin: Object.freeze({
    id: '0a0a0a0a-0000-4000-8000-00000000a001',
    email: 'route-policy-admin@example.test',
    display_name: 'Route Policy Administrator',
    role: 'admin',
    status: 'active',
    github_account_id: null,
    account_kind: 'agent_test',
  }),
});
export const FAKE_PROJECT_ID = '0a0a0a0a-0000-4000-8000-0000000000f1';

export const branchFor = (role) => role.replace(/_/g, '-');

const jsonResponse = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const createFakeControlPlane = ({ repositoryPath }) => {
  const profiles = Object.values(FAKE_USERS).map((profile) => ({ ...profile }));
  const appSessions = new Map();
  let mintedEmail = '';
  const eq = (value) => (typeof value === 'string' ? value.replace(/^eq\./, '') : value);
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : null;
    if (url.pathname === '/auth/v1/admin/generate_link') {
      mintedEmail = body?.email || '';
      return jsonResponse({ properties: { hashed_token: 'fake-agent-test-link' } });
    }
    if (url.pathname === '/auth/v1/verify') {
      const profile = profiles.find((candidate) => candidate.email === mintedEmail);
      return jsonResponse({
        access_token: 'fake-access',
        refresh_token: 'fake-refresh',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user: { id: profile?.id, email: profile?.email },
      });
    }
    if (!url.pathname.startsWith('/rest/v1/')) return jsonResponse({ message: 'not found' }, 404);
    const table = decodeURIComponent(url.pathname.slice('/rest/v1/'.length));
    const query = url.searchParams;
    if (table === 'user_profiles') {
      if (query.has('account_kind')) return jsonResponse(profiles.filter((profile) => profile.account_kind === eq(query.get('account_kind'))));
      if (query.get('id')?.startsWith('eq.')) return jsonResponse(profiles.filter((profile) => profile.id === eq(query.get('id'))));
      return jsonResponse(profiles);
    }
    if (table === 'managed_projects') {
      return jsonResponse([{ id: FAKE_PROJECT_ID, label: 'Route Policy Project', repository_path: repositoryPath, status: 'active', remote_url: null }]);
    }
    if (table === 'user_project_access' || table === 'user_project_branches') {
      const userId = eq(query.get('user_id'));
      const assigned = profiles.filter((profile) => profile.role !== 'admin' && (!userId || profile.id === userId));
      return jsonResponse(assigned.map((profile) => (table === 'user_project_access'
        ? { user_id: profile.id, project_id: FAKE_PROJECT_ID, is_default: true }
        : { user_id: profile.id, project_id: FAKE_PROJECT_ID, branch_name: branchFor(profile.role), is_default: true })));
    }
    if (table === 'app_sessions') {
      if (method === 'POST') {
        appSessions.set(body.id, { ...body, revoked_at: null });
        return jsonResponse([]);
      }
      if (method === 'PATCH') return jsonResponse([]);
      const hash = eq(query.get('session_token_hash'));
      const id = eq(query.get('id'));
      const match = [...appSessions.values()].find((session) => (
        (!hash || session.session_token_hash === hash) && (!id || session.id === id)
      ));
      return jsonResponse(match ? [match] : []);
    }
    return jsonResponse([]);
  };
  return { fetchImpl };
};

const makeRequest = ({ method = 'GET', url = '/', cookie = '', body = {}, csrf = false, headers = {} }) => {
  const parsed = new URL(url, 'http://127.0.0.1');
  const allHeaders = {
    host: '127.0.0.1:3000',
    cookie,
    'user-agent': 'route-policy-coverage',
    ...(csrf ? { 'x-devryan-csrf': '1' } : {}),
    ...headers,
  };
  return {
    method,
    url,
    originalUrl: url,
    path: parsed.pathname,
    query: Object.fromEntries(parsed.searchParams),
    params: {},
    body,
    headers: allHeaders,
    get: (name) => allHeaders[String(name).toLowerCase()],
    header: (name) => allHeaders[String(name).toLowerCase()],
    ip: '127.0.0.1',
    secure: false,
    protocol: 'http',
    hostname: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    connection: { remoteAddress: '127.0.0.1' },
    on: () => {},
    once: () => {},
  };
};

const makeResponse = () => {
  const headers = new Map();
  const listeners = new Map();
  const emit = (event) => { for (const listener of listeners.get(event) || []) listener(); };
  const response = {
    statusCode: 200,
    payload: undefined,
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    locals: {},
    status(code) { response.statusCode = code; return response; },
    type() { return response; },
    set(name, value) { headers.set(String(name).toLowerCase(), value); return response; },
    json(payload) { response.payload = payload; response.headersSent = true; response.writableEnded = true; emit('finish'); return response; },
    send(payload) { response.payload = payload; response.headersSent = true; response.writableEnded = true; emit('finish'); return response; },
    end() { response.headersSent = true; response.writableEnded = true; emit('finish'); return response; },
    getHeader: (name) => headers.get(String(name).toLowerCase()),
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value); },
    appendHeader(name, value) { headers.set(String(name).toLowerCase(), value); },
    destroy() { response.destroyed = true; emit('close'); },
    on(event, listener) { listeners.set(event, [...(listeners.get(event) || []), listener]); return response; },
    once(event, listener) { return response.on(event, listener); },
    off() { return response; },
    removeListener() { return response; },
  };
  return response;
};

const sessionCookie = (response) => {
  const header = response.getHeader('set-cookie');
  const values = Array.isArray(header) ? header : [header];
  const value = values.find((entry) => String(entry).startsWith('oc_app_session='));
  return String(value || '').split(';')[0];
};

// A real multi-user runtime with a signed-in managed developer and senior developer.
export const createManagedPolicyHarness = async ({ createMultiUserRuntime }) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-route-policy-'));
  const repositoryPath = path.join(directory, 'repository');
  fs.mkdirSync(repositoryPath);
  fs.writeFileSync(path.join(directory, 'supabase.json'), JSON.stringify({
    url: 'https://route-policy.supabase.test',
    publishableKey: 'sb_publishable_fake',
    secretKey: 'sb_secret_fake',
  }), { mode: 0o600 });
  const { fetchImpl } = createFakeControlPlane({ repositoryPath });
  const quiet = { warn: () => {}, error: () => {}, info: () => {}, log: () => {} };
  const runtime = await createMultiUserRuntime({ dataDirectory: directory, fetchImpl, logger: quiet });
  const login = async (role) => {
    const response = makeResponse();
    // The agent-test login picks a senior developer by email; its role selector names only developer and admin.
    await runtime.authController.handleAgentTestSession(makeRequest({ method: 'POST', body: { email: FAKE_USERS[role].email } }), response);
    if (response.statusCode !== 200) throw new Error(`Agent-test login for ${role} failed: ${JSON.stringify(response.payload)}`);
    return { cookie: sessionCookie(response), principal: response.payload.principal };
  };
  const principals = {
    developer: await login('developer'),
    senior_developer: await login('senior_developer'),
  };
  return {
    runtime,
    repositoryPath,
    principals,
    makeRequest,
    makeResponse,
    async dispose() {
      await runtime.authController.dispose();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
};


// ---------------------------------------------------------------------------
// Route enumeration. The registrars run in the order constructWebHost
// (application.js) calls them. constructWebHost itself cannot run here: it
// verifies the native bundle at module load and starts OpenCode, so its
// sequence of registrar calls is mirrored below. A registration call site the
// mirror misses is caught by the source cross-check in the test, so this list
// cannot silently fall behind.
export const enumerateServerRoutes = ({ multiUserRuntime, dataDirectory }) => withRouterRecording(async () => {
  const [
    { registerIndexingPolicy },
    { registerLocalOwnerBootstrap },
    { registerTunnelAccessBoundary },
    { attachSupabaseConnectionBoundary, registerSupabaseConnectionRoutes },
    { createBootstrapRuntime },
    coreRoutes,
    { createUiAuth },
    { registerTtsRoutes },
    { registerNotificationRoutes },
    { registerDevRyanRoutes },
    { createBrowserCdpDiscoveryRuntime },
    { createBrowserLeaseRuntime },
    { registerRuntimeServiceRoutes },
    { registerRuntimeBundleLifecycleRoutes },
    { createBrowserObservationRuntime },
    { registerDiagnosticsRoutes },
    { registerMemoryDebugRoutes },
    { registerEvidenceRoutes },
    { registerSessionRetentionRoutes },
    { registerManagedOrchestrationRoutes },
    { createTunnelWiringRuntime },
    { registerTurnTimingRoutes },
    { registerAgentRuntimeWarmupRoute },
    { registerHarnessPreflightRoute },
    { createFeatureRoutesRuntime },
    { createLocalInstanceStatusRuntime },
    { createProjectPreviewInstancesRuntime },
    { createPreviewProxyRuntime },
    { createTerminalRuntime },
    { createServerUtilsRuntime },
    { createStaticRoutesRuntime },
  ] = await Promise.all([
    import('../indexing-policy.js'),
    import('./local-owner-bootstrap.js'),
    import('../tunnels/access-control.js'),
    import('./connection-routes.js'),
    import('../opencode/bootstrap-runtime.js'),
    import('../opencode/core-routes.js'),
    import('../ui-auth/ui-auth.js'),
    import('../tts/routes.js'),
    import('../notifications/routes.js'),
    import('../opencode/devryan-routes.js'),
    import('../browser-cdp/discovery-runtime.js'),
    import('../browser-cdp/lease-runtime.js'),
    import('../runtime-service/routes.js'),
    import('../opencode/runtime-host/runtime-bundle-lifecycle.js'),
    import('../browser-cdp/observation-runtime.js'),
    import('../diagnostics/routes.js'),
    import('../debug/memory-routes.js'),
    import('../evidence/routes.js'),
    import('../opencode/session-retention.js'),
    import('../orchestration/routes.js'),
    import('../opencode/tunnel-wiring-runtime.js'),
    import('../opencode/turn-timing.js'),
    import('../opencode/agent-runtime-warmup.js'),
    import('../opencode/harness-preflight.js'),
    import('../opencode/feature-routes-runtime.js'),
    import('../preview/local-instances-runtime.js'),
    import('../preview/project-instances-runtime.js'),
    import('../preview/proxy-runtime.js'),
    import('../terminal/runtime.js'),
    import('../opencode/server-utils-runtime.js'),
    import('../opencode/static-routes-runtime.js'),
  ]);

  const { app, routes, mounts, addSourceOnly } = createRecordingApp();
  const server = createStub('server');
  // Real values for the dependencies a registrar uses as values while
  // registering (paths, modules); every other dependency is a stub.
  const real = {
    express, fs, os, path, crypto, fsPromises: fs.promises, process, URL, __dirname: SERVER_ROOT,
    devryanDataDir: dataDirectory, dataDirectory, dataDir: dataDirectory,
  };
  const deps = (extra = {}) => createDependencies({ ...real, ...extra });
  // Inline registrations in code the registry cannot run are recorded at
  // their place in the sequence, so they land before or after the gate as
  // they do on the server.
  const inline = (file, method, routePath) => () => addSourceOnly({ file, method, path: routePath });
  const nothing = () => {};
  let uiAuthController = null;

  const bootstrapRuntime = createBootstrapRuntime({
    createUiAuth,
    registerServerStatusRoutes: coreRoutes.registerServerStatusRoutes,
    registerCommonRequestMiddleware: coreRoutes.registerCommonRequestMiddleware,
    registerAuthAndAccessRoutes: coreRoutes.registerAuthAndAccessRoutes,
    registerTtsRoutes,
    registerNotificationRoutes,
    registerDevRyanRoutes,
    express,
  });
  const privateCapabilitySteps = [
    ['browserCdpDiscoveryRuntime.attach(privateApp', (privateApp) => createBrowserCdpDiscoveryRuntime(deps()).attach(privateApp)],
    ['browserLeaseRuntime.attach(privateApp', (privateApp) => createBrowserLeaseRuntime(deps()).attach(privateApp)],
    // Registered when the Electron runtime service controller is present.
    ['registerRuntimeServiceRoutes(privateApp', (privateApp) => registerRuntimeServiceRoutes(privateApp, deps({ server }))],
    ['registerSupabaseConnectionRoutes(privateApp', (privateApp) => registerSupabaseConnectionRoutes(privateApp, deps({ runtime: multiUserRuntime }))],
  ];
  const A = 'application.js';
  const P = 'lib/opencode/startup-pipeline-runtime.js';
  const steps = [
    ['app.use(', nothing], // legacyApiPathRewrite
    ['app.use(', nothing], // bundleAdmission.middleware
    ['registerIndexingPolicy(app', () => registerIndexingPolicy(app)],
    ['app.use(', nothing], // dynamicNoStoreMiddleware
    ['app.use(', nothing], // compression
    ['http.createServer(app', nothing],
    ['registerLocalOwnerBootstrap(app', () => registerLocalOwnerBootstrap(app, deps({ connection: multiUserRuntime.connection }))],
    ['registerTunnelAccessBoundary(app', () => registerTunnelAccessBoundary(app, server, deps({ connection: multiUserRuntime.connection }))],
    ['attachSupabaseConnectionBoundary(app', () => attachSupabaseConnectionBoundary(app, server, multiUserRuntime.connection, deps())],
    // Mounts the managed-user policy gate (registerAuthAndAccessRoutes).
    ['bootstrapRuntime.setupBaseRoutes(app', () => {
      ({ uiAuthController } = bootstrapRuntime.setupBaseRoutes(app, deps({
        multiUserRuntime,
        server,
        uiPassword: null,
        verboseRequestLogs: false,
        registerPrivateCapabilityRoutes: (privateApp) => {
          for (const [, run] of privateCapabilitySteps) run(privateApp);
        },
      })));
    }],
    ...privateCapabilitySteps.map(([token]) => [token, nothing]),
    ['registerRuntimeBundleLifecycleRoutes(app', () => registerRuntimeBundleLifecycleRoutes(app, deps())],
    ["app.get('/api/diagnostics/execution-runtime'", inline(A, 'GET', '/api/diagnostics/execution-runtime')],
    ['app.use(', nothing], // executionReadinessMiddleware
    ["app.use('/api/devryan/interviews'", inline(A, 'USE', '/api/devryan/interviews')],
    ["app.use('/api/session'", inline(A, 'USE', '/api/session')],
    ['multiUserRuntime.registerRoutes(app', () => multiUserRuntime.registerRoutes(app, deps())],
    ['browserObservationRuntime.registerRoutes(app', () => createBrowserObservationRuntime(deps()).registerRoutes(app)],
    ["app.use('/api/devryan/session/:sessionID/changes'", inline(A, 'USE', '/api/devryan/session/:sessionID/changes')],
    ["app.use('/api/session/:sessionID'", inline(A, 'USE', '/api/session/:sessionID')],
    ["app.use('/api/session/:sessionID/prompt_async'", inline(A, 'USE', '/api/session/:sessionID/prompt_async')],
    ['registerDiagnosticsRoutes(app', () => registerDiagnosticsRoutes(app, deps())],
    ['registerMemoryDebugRoutes(app', () => registerMemoryDebugRoutes(app, deps())],
    ['registerEvidenceRoutes(app', () => registerEvidenceRoutes(app, deps())],
    ['registerSessionRetentionRoutes(app', () => registerSessionRetentionRoutes(app, deps())],
    ['registerManagedOrchestrationRoutes(app', () => registerManagedOrchestrationRoutes(app, deps())],
    ['tunnelWiringRuntime.initialize(app', () => createTunnelWiringRuntime(deps()).initialize(app, 0, deps())],
    ['registerTurnTimingRoutes(app', () => registerTurnTimingRoutes(app, createStub('turnTimingRuntime'), deps())],
    ['registerAgentRuntimeWarmupRoute(app', () => registerAgentRuntimeWarmupRoute(app, createStub('agentRuntimeWarmup'))],
    ['registerHarnessPreflightRoute(app', () => registerHarnessPreflightRoute(app, createStub('harnessPreflight'))],
    ['featureRoutesRuntime.registerRoutes(app', () => createFeatureRoutesRuntime(deps()).registerRoutes(app, deps())],
    ['projectPreviewInstancesRuntime.attach(app', () => createProjectPreviewInstancesRuntime(deps()).attach(app, deps({ uiAuthController }))],
    ['previewProxyRuntime.attach(app', () => createPreviewProxyRuntime(deps()).attach(app, deps({ server, uiAuthController }))],
    ['localInstanceStatusRuntime.attach(app', () => createLocalInstanceStatusRuntime(deps()).attach(app, deps({ uiAuthController }))],
    // startupPipelineRuntime.run registers the rest and then listens.
    ['startupPipelineRuntime.run(', nothing],
  ];
  const pipelineSteps = [
    ['createTerminalRuntime({app', () => createTerminalRuntime(deps({ app, server, uiAuthController, multiUserRuntime }))],
    ["app.get('/api/global/event'", inline(P, 'GET', '/api/global/event')],
    ['setupProxy(app', () => createServerUtilsRuntime(deps()).setupProxy(app)],
    ['staticRoutesRuntime.registerStaticRoutes(app', () => createStaticRoutesRuntime(deps()).registerStaticRoutes(app)],
  ];
  for (const [, run] of [...steps, ...pipelineSteps]) await run();

  return {
    routes,
    mounts,
    // The mirrored call order, for the source-order check in the test.
    sequences: {
      [A]: steps.map(([token]) => token),
      [P]: pipelineSteps.map(([token]) => token),
    },
  };
});

// ---------------------------------------------------------------------------
// Policy probe. The gate is the real `/api` middleware that
// registerAuthAndAccessRoutes mounts; it hands the request to the multi-user
// runtime's requireAuth, which runs authorizeManagedRequest. A probe passes
// the gate when the gate calls next() without an error.
// Path parameters take values that belong to the probing principal (its
// assigned project and branch, its own user id, a session id), so a refusal
// is the policy's and never a lookup miss on a made-up id.
export const FAKE_SESSION_ID = 'ses_routePolicyOwned';
const parameterValue = (name, principal) => {
  if (/^project(?:ID|Id)$/.test(name)) return FAKE_PROJECT_ID;
  if (/^user(?:ID|Id)$/.test(name)) return principal.principal?.id ?? 'fake-user';
  if (/^session(?:ID|Id)$/.test(name) || name === 'id') return FAKE_SESSION_ID;
  if (name === 'branchName') return branchFor(principal.principal?.role ?? 'developer');
  return `fake-${name}`;
};
export const concretePath = (pattern, principal) => pattern
  .replace(/\{\*([A-Za-z0-9_]+)\}/g, 'fake-$1')
  .replace(/\*([A-Za-z0-9_]+)/g, 'fake-$1')
  .replace(/:([A-Za-z0-9_]+)\??/g, (_match, name) => parameterValue(name, principal))
  .replace(/[{}]/g, '');

export const probeManagedDecision = async ({ harness, gate, method, routePath, principal }) => {
  const stateChanging = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  const fullPath = concretePath(routePath, principal);
  const request = makeRequest({ method, url: fullPath, cookie: principal.cookie, csrf: stateChanging, body: {} });
  // Mounted at /api, Express hands the gate the path below the mount.
  request.baseUrl = '/api';
  request.url = fullPath.slice('/api'.length) || '/';
  request.path = request.url;
  const response = makeResponse();
  let passed = false;
  let forwardedError = null;
  await gate(request, response, (error) => {
    if (error) forwardedError = error;
    else passed = true;
    response.end();
  });
  if (passed) return { decision: 'allow', status: null, reason: null };
  if (forwardedError) {
    return { decision: 'deny', status: forwardedError.statusCode ?? 500, reason: String(forwardedError.message || forwardedError) };
  }
  const reason = response.payload?.error ?? response.payload?.message ?? null;
  return { decision: 'deny', status: response.statusCode, reason: typeof reason === 'string' ? reason : JSON.stringify(reason) };
};
