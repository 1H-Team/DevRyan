// The edge in front of a route group, composed as the real server composes it
// (BH1; design file 31 §2.1, §5.1 arm R).
//
// The real web server builds its Express app in constructWebHost, from
// `const app = express();` to the feature routes. That function cannot run
// here: it verifies the native bundle at module load and starts OpenCode. So
// the group host re-states the composition, step by step, calling the
// product's own registrars and middleware. What keeps the re-statement honest:
//   - the composition table (the drift module named in docs/TESTING.md): every
//     statement of the server's composition span is classified (composed here,
//     not applicable to the group, or touching no request) and pinned by its
//     text; the composed steps must be EDGE_STEPS, in order. The self-test never
//     loads it, and nothing the self-test loads names it or the server file it reads.
//   - reach.mjs: the product route census must record no layer that applies to
//     a group route before it, by the router's own matching, except from a
//     composed step or a listed omission.
//   - edge-probes.mjs: the host's layer stack as the tap saw it against the
//     census's, and one probe per composed layer whose effect a client can see.
// After the group, the real server composes its tail (preview, terminal, the
// OpenCode proxy, static files). The host composes none of it: a stand-in
// answers 599 and marks the exchange "tail", which is never compared and never
// counts as covered.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SERVER_ROOT = path.join(REPOSITORY_ROOT, 'packages/web/server');
/** The directory the product resolves its packages from (express, compression, router). */
export const SERVER_REQUIRE_BASE = `${SERVER_ROOT}${path.sep}`;
const serverModule = (relative) => import(pathToFileURL(path.join(SERVER_ROOT, relative)).href);

/** A package as the server resolves it (its default export when it has one). */
export const importFromServer = async (specifier) => {
  const resolved = createRequire(SERVER_REQUIRE_BASE).resolve(specifier);
  const loaded = await import(pathToFileURL(resolved).href);
  return loaded.default ?? loaded;
};

// ------------------------------------------------------------------ absent dependencies
/**
 * Dependencies the edge registrars take but the group's paths never use. Like
 * the route census stubs, a dependency answers anything while the edge is
 * being registered. Once the host is sealed, calling one throws and is
 * recorded, so a request that reaches one is loud, never silently stubbed.
 */
export function createAbsentDependencies() {
  const calls = [];
  let sealed = false;
  const make = (label) => {
    const target = function absent() {};
    return new Proxy(target, {
      get(_target, property) {
        if (property === 'then') return undefined;
        if (property === Symbol.toPrimitive) return (hint) => (hint === 'number' ? 0 : `[absent ${label}]`);
        if (property === Symbol.iterator) return function* empty() {};
        if (property === Symbol.asyncIterator) return async function* empty() {};
        if (property === 'toString' || property === 'valueOf' || property === 'toJSON') return () => `[absent ${label}]`;
        if (typeof property === 'symbol') return undefined;
        return make(`${label}.${String(property)}`);
      },
      apply() {
        if (sealed) {
          calls.push(label);
          throw new Error(`group host: the edge called ${label}, which the group host does not provide`);
        }
        return make(`${label}()`);
      },
      construct() { return make(`new ${label}`); },
    });
  };
  const deps = (fixed = {}) => new Proxy({ ...fixed }, {
    get(target, property) {
      if (Object.hasOwn(target, property)) return target[property];
      if (typeof property === 'symbol') return undefined;
      return make(String(property));
    },
    has: () => true,
  });
  return { deps, make, seal() { sealed = true; }, calls: () => [...calls] };
}

// ------------------------------------------------------------------ re-stated helpers
// The server's environment flag helpers, as it defines them (pinned by the composition table).
const isEnvFlagEnabled = (value) => {
  if (value === true || value === 1) return true;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
};
const isEnvFlagDisabled = (value) => {
  if (value === false || value === 0) return true;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '0' || normalized === 'false';
};
const shouldSkipApiCompression = () => {
  if (isEnvFlagEnabled(process.env.DEVRYAN_SKIP_API_COMPRESSION)) return true;
  if (isEnvFlagEnabled(process.env.DEVRYAN_COMPRESS_API)) return false;
  if (isEnvFlagDisabled(process.env.DEVRYAN_COMPRESS_API)) return true;
  return process.env.DEVRYAN_RUNTIME === 'desktop';
};

/** The re-statement's declared differences: what it composes where the server reads run-time state. */
export const COMPOSED_VALUES = Object.freeze({
  uiPassword: null,
  executionReadiness: Object.freeze({ state: 'active', diagnostic: null }),
  runtimeReady: true,
});

// ------------------------------------------------------------------ the composition
/**
 * The composed steps of the server's composition span, in its order. Each id
 * is the `step` of the composed statements of the composition table (checked
 * there). `layers` names the product files whose layers the step installs
 * (for the layer-stack check: those layers must be the census's, in order).
 */
export const EDGE_STEPS = Object.freeze([
  { id: 'express-app', compose: async () => {} /* the host creates the app with the product's express */ },
  { id: 'legacy-path', compose: async ({ app }) => app.use((await serverModule('lib/legacy-api-path.js')).legacyApiPathRewrite) },
  { id: 'bundle-admission', compose: async ({ app, state }) => {
    state.bundleAdmission = (await serverModule('lib/opencode/runtime-host/runtime-bundle-lifecycle.js')).createRuntimeBundleAdmissionGate();
    app.use(state.bundleAdmission.middleware);
  } },
  { id: 'runtime-instance', compose: async ({ state }) => { state.runtimeInstanceId = crypto.randomUUID(); } },
  { id: 'trust-proxy', compose: async ({ app }) => { app.set('trust proxy', true); } },
  { id: 'indexing-policy', layers: ['lib/indexing-policy.js'], compose: async ({ app }) => (await serverModule('lib/indexing-policy.js')).registerIndexingPolicy(app) },
  { id: 'no-store', compose: async ({ app }) => app.use((await serverModule('lib/http-cache-policy.js')).dynamicNoStoreMiddleware) },
  { id: 'compression', compose: async ({ app }) => {
    const { createCompressionPolicy } = await serverModule('lib/http-compression-policy.js');
    const { shouldSkipCompression } = createCompressionPolicy({ shouldSkipApiCompression: () => shouldSkipApiCompression() });
    const compression = await importFromServer('compression');
    app.use(compression({
      filter: (req, res) => {
        if (shouldSkipCompression(req, res)) return false;
        return compression.filter(req, res);
      },
      threshold: 1024,
    }));
  } },
  { id: 'http-server', compose: async ({ state, app, http }) => { state.server = http.createServer(app); } },
  { id: 'multi-user-runtime', compose: async ({ state, absent, dataRoot }) => {
    const { createMultiUserRuntime } = await serverModule('lib/multi-user/runtime.js');
    state.multiUserRuntime = await createMultiUserRuntime({
      dataDirectory: dataRoot,
      fetchImpl: absent.make('fetchImpl'),
      logger: console,
      readManagedTunnelConfig: absent.make('readManagedRemoteTunnelConfigFromDisk'),
      onManagedProjectMetadataChanged: absent.make('broadcastManagedProjectMetadataChanged'),
      onManagedSessionOwnershipCommitted: absent.make('broadcastManagedSessionOwnershipCommitted'),
      onScheduledTaskAccessChanged: absent.make('onScheduledTaskAccessChanged'),
    });
  } },
  { id: 'tunnel-auth-initialize', compose: async ({ state, values }) => {
    await state.tunnelAuthController.initialize({ connection: state.multiUserRuntime.connection, passwordProtected: values.uiPassword !== null });
  } },
  { id: 'local-owner-bootstrap', layers: ['lib/multi-user/local-owner-bootstrap.js'], compose: async ({ app, state, dataRoot }) => {
    const { registerLocalOwnerBootstrap } = await serverModule('lib/multi-user/local-owner-bootstrap.js');
    registerLocalOwnerBootstrap(app, { dataDirectory: dataRoot, connection: state.multiUserRuntime.connection });
  } },
  { id: 'tunnel-boundary', layers: ['lib/tunnels/access-control.js'], compose: async ({ app, state, values }) => {
    const { registerTunnelAccessBoundary } = await serverModule('lib/tunnels/access-control.js');
    const multiUserRuntime = state.multiUserRuntime;
    registerTunnelAccessBoundary(app, state.server, { controller: state.tunnelAuthController, connection: multiUserRuntime.connection, runtimeInstanceId: state.runtimeInstanceId,
      // The real server answers with its OpenCode readiness; the group host has no OpenCode and is always ready.
      getRuntimeReady: () => values.runtimeReady,
      authenticateOwner: async (req, res) => {
        const owner = multiUserRuntime.connection.authenticateLocalOwner(req);
        if (owner) return owner;
        const principal = await multiUserRuntime.resolvePrincipal?.(req, res);
        if (principal?.role !== 'admin' || principal.scope !== 'managed' || principal.offlineGrace) return null;
        await multiUserRuntime.connection.rememberOwner(principal, res);
        return multiUserRuntime.connection.ownerPrincipal();
      },
    });
  } },
  { id: 'supabase-boundary', layers: ['lib/multi-user/connection-routes.js'], compose: async ({ app, state }) => {
    const { attachSupabaseConnectionBoundary } = await serverModule('lib/multi-user/connection-routes.js');
    const { hasTunnelBoundaryAuthorization } = await serverModule('lib/tunnels/access-control.js');
    attachSupabaseConnectionBoundary(app, state.server, state.multiUserRuntime.connection, {
      allowRemoteRequest: hasTunnelBoundaryAuthorization,
    });
  } },
  { id: 'base-routes', layers: ['lib/opencode/core-routes.js', 'lib/opencode/bootstrap-runtime.js', 'lib/ui-auth/ui-auth.js', 'lib/tts/routes.js', 'lib/notifications/routes.js', 'lib/opencode/devryan-routes.js'],
    compose: async ({ app, state, absent, dataRoot, express, values }) => {
      const [{ createBootstrapRuntime }, coreRoutes, { createUiAuth }, { registerTtsRoutes }, { registerNotificationRoutes }, { registerDevRyanRoutes }] = await Promise.all([
        serverModule('lib/opencode/bootstrap-runtime.js'), serverModule('lib/opencode/core-routes.js'), serverModule('lib/ui-auth/ui-auth.js'),
        serverModule('lib/tts/routes.js'), serverModule('lib/notifications/routes.js'), serverModule('lib/opencode/devryan-routes.js'),
      ]);
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
      // Only what the edge uses on the group's paths is real: the auth
      // controllers and the multi-user runtime, the body parser's settings and
      // the paths. registerPrivateCapabilityRoutes is not passed: the reach check
      // proves its registrars install nothing on the group's paths.
      const result = bootstrapRuntime.setupBaseRoutes(app, absent.deps({
        process,
        verboseRequestLogs: isEnvFlagEnabled(process.env.DEVRYAN_VERBOSE_REQUEST_LOGS),
        // The web composition without a UI password (options.uiPassword unset).
        uiPassword: values.uiPassword,
        tunnelAuthController: state.tunnelAuthController,
        multiUserRuntime: state.multiUserRuntime,
        server: state.server,
        fs, path,
        devryanDataDir: dataRoot,
        runtimeInstanceId: state.runtimeInstanceId,
        registerPrivateCapabilityRoutes: undefined,
      }));
      state.uiAuthController = result.uiAuthController;
    } },
  { id: 'execution-readiness', compose: async ({ app, values }) => {
    const { executionReadinessMiddleware } = await serverModule('lib/opencode/execution-artifacts.js');
    // The middleware reads `state` and `diagnostic` only; a verified bundle runs 'active' with no diagnostic.
    app.use(executionReadinessMiddleware({ ...values.executionReadiness }));
  } },
  { id: 'multi-user-routes', layers: ['lib/multi-user/runtime.js'], compose: async ({ app, state, absent }) => {
    // Without Supabase this registers nothing; with it, the managed routes and overrides.
    state.multiUserRuntime.registerRoutes(app, absent.deps({}));
  } },
  { id: 'group', group: true },
]);

/** Layers the census records on the group's paths that no composed step installs, each with why. */
export const REACH_OMISSIONS = Object.freeze([
  { file: 'lib/runtime-service/routes.js', reason: 'requireRuntimeSession: the Electron runtime service only (registered when options.runtimeServiceController is passed; the group host is the web composition)' },
]);

export const TAIL_STATUS = 599;
export const TAIL_BODY = 'harness: the server tail (preview, terminal, OpenCode proxy, static files) is not composed\n';
/**
 * The stand-in for the server's tail: a request no composed layer answered
 * gets 599 and is marked "tail" (never compared, never counted as covered).
 * Errors pass it, as the real tail has no error handler.
 */
export const tailStandIn = (onTail) => function harnessTailStandIn(req, res) {
  onTail?.(req, res);
  res.statusCode = TAIL_STATUS;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(TAIL_BODY));
  res.end(TAIL_BODY);
};

/**
 * Builds the edge on `app` in the server's order, hands the app to
 * `registerGroup` where the feature routes would be registered, then adds the
 * tail stand-in. `replace` maps step ids to other compose functions (the
 * self-test's planted variants; a toy table names them) or to null (skipped).
 * Returns the host state (server, controllers).
 */
export async function composeEdge({ app, express, http, dataRoot, absent, registerGroup, onTail, replace = {} }) {
  for (const id of Object.keys(replace)) if (!EDGE_STEPS.some((step) => step.id === id)) throw new Error(`no edge step ${id} to replace`);
  const state = {};
  const { createTunnelAccessControl } = await serverModule('lib/tunnels/access-control.js');
  state.tunnelAuthController = createTunnelAccessControl();
  for (const step of EDGE_STEPS) {
    const compose = Object.hasOwn(replace, step.id) ? replace[step.id] : step.group ? async () => registerGroup(app, state) : step.compose;
    if (compose) await compose({ app, state, absent, dataRoot, express, http, values: COMPOSED_VALUES, original: step.compose });
  }
  app.use(tailStandIn(onTail));
  return state;
}
