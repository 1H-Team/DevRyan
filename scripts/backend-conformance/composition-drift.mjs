// The composition table of the real server and its drift check (BH1; the
// fix round's decisions 1 and 2). The group host re-states the server's
// composition (edge.mjs); this file says, statement by statement, what the
// re-statement covers, and checks the server's files against it.
//
// The span of application.js runs from `const app = express();` to the end of
// the feature-routes call; the span of feature-routes-runtime.js runs through
// its registerRoutes body up to the group's own call. Every statement there
// that mentions the app, the HTTP server or the edge's state (or any alias
// assigned from them), and every binding a classified statement reads, is an
// entry below, pinned by its text as printed without comments:
//   composed        the group host composes it (its `step` is an EDGE_STEPS id)
//   not-applicable  it installs layers that do not apply to the group's paths,
//                   proven by the reach check (reach.mjs, by the router's own matching)
//   no-request      it touches no request
// Names a classified statement reads from outside the span are pinned in
// `definitions`. Any unclassified statement, changed text or changed order
// is drift (composition.mjs). A run on a drifted composition judges nothing:
// it is inconclusive (exit 2) and names each statement.
//
// The self-test never loads this file: it proves the detector on synthetic
// compositions, so an edit to the server's composition neither selects nor
// fails it. The real files are checked by every harness run and by
//   node scripts/test-isolation-guard.mjs node scripts/backend-conformance/composition-drift.mjs --group=<name> [--text-only] [--server-root=<dir>]
// which exits 0 when the composition matches, 2 on drift, 64 when refused.
// When the table must change: read the new statement, decide its class (and,
// for a composed one, change edge.mjs to match), then replace its digest; the
// draft printed with --draft lists every statement and digest as they are now.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkSpan, draftTable } from './composition.mjs';
import { EDGE_STEPS, SERVER_ROOT } from './edge.mjs';

const entry = (cls, step, digest, text, reads, reason) => Object.freeze({ class: cls, ...(step ? { step } : {}), digest, text, reads: Object.freeze(reads), reason });
const def = (digests, reads, reason, text) => Object.freeze({ digests: Object.freeze(digests), reads: Object.freeze(reads), reason, text });

/** application.js: the edge in front of every group, from the app to the feature-routes call. */
export const APPLICATION_TABLE = Object.freeze({
  file: 'application.js',
  spec: Object.freeze({ start: 'const app = express();', endCall: 'featureRoutesRuntime.registerRoutes' }),
  roots: Object.freeze(['app', 'server', 'expressApp', 'multiUserRuntime', 'tunnelAuthController', 'bootstrapRuntime', 'uiAuthController']),
  entries: Object.freeze([
    entry("composed", "express-app", "0ba021d569ddf3ab", "const app = express();", ["express"], "the host creates its app with the product's express"),
    entry("composed", "legacy-path", "cecc4cfbe7ec768d", "app.use(legacyApiPathRewrite);", ["legacyApiPathRewrite"], "composed as is"),
    entry("composed", "bundle-admission", "1d6f08e0e59eadb6", "app.use(bundleAdmission.middleware);", ["bundleAdmission"], "composed: a fresh admission gate, as the server creates it"),
    entry("composed", "runtime-instance", "214e06add2f269aa", "const runtimeInstanceId = crypto.randomUUID();", [], "the host draws its own instance id the same way"),
    entry("composed", "trust-proxy", "c117ba93e7ea3ac6", "app.set('trust proxy', true);", [], "composed as is"),
    entry("composed", "indexing-policy", "7599b5c28164a7cf", "registerIndexingPolicy(app);", ["registerIndexingPolicy"], "composed as is"),
    entry("composed", "no-store", "3ad0615577db6d89", "app.use(dynamicNoStoreMiddleware);", ["dynamicNoStoreMiddleware"], "composed as is"),
    entry("composed", "compression", "9b3ce0445e42a0ab", "app.use(compression({ filter: (req, res) => { if (shouldSkipCompression(req, res)) return …", ["compression","shouldSkipCompression"], "composed with the same filter and threshold"),
    entry("no-request", null, "a8bb70d344141f61", "expressApp = app;", [], "keeps the app for later use; every later use of the alias in the span is a relevant statement"),
    entry("composed", "http-server", "e58b9b4ace82188a", "server = http.createServer(app);", ["http"], "composed as is"),
    entry("composed", "multi-user-runtime", "17d93a27629b2a65", "const multiUserRuntimePromise = createMultiUserRuntime({ dataDirectory: DEVRYAN_DATA_DIR, …", ["createMultiUserRuntime","DEVRYAN_DATA_DIR"], "composed on the harness data root; its fetch, tunnel config and broadcast callbacks are absent dependencies (they serve managed principals and Supabase only)"),
    entry("composed", "multi-user-runtime", "95df7fd4e444f26c", "const [nextMultiUserRuntime, sayTTSCapability] = await Promise.all([ multiUserRuntimePromi…", ["multiUserRuntimePromise"], "the runtime the edge uses (sayTTSCapability serves the TTS routes only)"),
    entry("composed", "multi-user-runtime", "cb0bddcab1c37aad", "multiUserRuntime = nextMultiUserRuntime;", ["nextMultiUserRuntime"], "the runtime the edge uses"),
    entry("composed", "tunnel-auth-initialize", "46511a8cfdff7e28", "await tunnelAuthController.initialize({ connection: multiUserRuntime.connection, passwordP…", ["tunnelAuthController","multiUserRuntime","configuredUiPassword"], "composed with passwordProtected false: the web composition without a UI password"),
    entry("no-request", null, "0dc13b945b07761c", "if (!startupTunnelRequest) { const resumeProfile = tunnelAuthController.getResumeProfile()…", [], "chooses a tunnel to resume at startup; touches no request"),
    entry("composed", "local-owner-bootstrap", "12244ede7c08a929", "registerLocalOwnerBootstrap(app, { dataDirectory: DEVRYAN_DATA_DIR, connection: multiUserR…", ["registerLocalOwnerBootstrap","DEVRYAN_DATA_DIR","multiUserRuntime"], "composed on the harness data root"),
    entry("composed", "tunnel-boundary", "4ed9071e605bbe29", "registerTunnelAccessBoundary(app, server, { controller: tunnelAuthController, connection: …", ["registerTunnelAccessBoundary","server","tunnelAuthController","multiUserRuntime","runtimeInstanceId"], "composed; declared difference: getRuntimeReady answers true (the host has no OpenCode)"),
    entry("composed", "supabase-boundary", "31714d3cc7909cb6", "const getConnectionActiveRequests = attachSupabaseConnectionBoundary(app, server, multiUse…", ["attachSupabaseConnectionBoundary","server","multiUserRuntime","hasTunnelBoundaryAuthorization"], "composed as is"),
    entry("no-request", null, "2c30357a2d3ac014", "if (multiUserRuntime.enabled) { console.log('Supabase multi-user identity and policy enfor…", [], "a startup log line"),
    entry("no-request", null, "caa76373eab7085f", "pushRuntime.setSessionVisibilityFilter((tokenHash, sessionId) => (multiUserRuntime.canSess…", [], "filters push notifications; touches no request"),
    entry("no-request", null, "1f2d37c9d3bb8483", "browserLeaseRuntime = createBrowserLeaseRuntime({ openCodeClient, getDiscoveryToken: typeo…", [], "creates the browser lease runtime; its routes are attached by the private capability steps, which install no layer on the group's paths (reach check)"),
    entry("no-request", null, "1507807398c94f83", "browserObservationRuntime = createBrowserObservationRuntime({ getLeaseRecords: () => brows…", [], "creates the browser observation runtime; its routes are registered by a not-applicable statement below"),
    entry("composed", "base-routes", "a52f805be8da6a95", "const uiPassword = typeof options.uiPassword === 'string' ? options.uiPassword : null;", [], "composed as null: the web composition without a UI password"),
    entry("composed", "base-routes", "0e44bee288bbbe28", "const bootstrapResult = bootstrapRuntime.setupBaseRoutes(app, { process, openchamberVersio…", ["bootstrapRuntime","DEVRYAN_VERBOSE_REQUEST_LOGS","uiPassword","tunnelAuthController","multiUserRuntime","server","fs","path","DEVRYAN_DATA_DIR","runtimeInstanceId"], "composed with these dependencies real and the rest absent (they serve other paths); registerPrivateCapabilityRoutes is not passed: its registrars install no layer on the group's paths (reach check)"),
    entry("not-applicable", null, "2c484ad57c866ad6", "registerRuntimeBundleLifecycleRoutes(app, { lifecycle: runtimeBundleLifecycle, isAdministr…", ["registerRuntimeBundleLifecycleRoutes"], "registers the runtime bundle routes only; the reach check proves none of its layers applies to the group's paths"),
    entry("composed", "base-routes", "e1fbc103ca1dbea7", "uiAuthController = bootstrapResult.uiAuthController;", ["bootstrapResult"], "the host keeps the UI auth controller the same way"),
    entry("not-applicable", null, "8d318a3f0a64be6b", "app.get('/api/diagnostics/execution-runtime', (_req, res) => res.json({ state: executionRe…", [], "registers one diagnostics route only; the reach check proves none of its layers applies to the group's paths"),
    entry("composed", "execution-readiness", "f239fcb91c046233", "app.use(executionReadinessMiddleware(executionReadiness));", ["executionReadinessMiddleware","executionReadiness"], "composed with the state of a verified bundle (active, no diagnostic)"),
    entry("not-applicable", null, "cb342e40ebea129a", "app.use('/api/devryan/interviews', async (req, res, next) => { if (!nativeRuntime) return …", [], "registers a mount on /api/devryan/interviews only; the reach check proves none of its layers applies to the group's paths"),
    entry("not-applicable", null, "8dcecdf37eca6af6", "app.use('/api/session', (req, res, next) => { if (isSessionCreateRequest(req)) { const tra…", [], "registers a mount on /api/session only; the reach check proves none of its layers applies to the group's paths"),
    entry("composed", "multi-user-routes", "0b4fd808abeec2ad", "multiUserRuntime.registerRoutes(app, { openCodeClient, isSessionCreationRestarting: () => …", ["multiUserRuntime"], "composed; its dependencies are absent (they serve managed sessions only)"),
    entry("not-applicable", null, "0ec9f32185b70d93", "browserObservationRuntime.registerRoutes(app);", [], "registers the browser observation routes only; the reach check proves none of its layers applies to the group's paths"),
    entry("not-applicable", null, "ce7814c9ebd5e54f", "app.use('/api/devryan/session/:sessionID/changes', express.json({ limit: '16kb' }), async …", [], "registers a mount on /api/devryan/session/:sessionID/changes only; the reach check proves none of its layers applies to the group's paths"),
    entry("not-applicable", null, "964a11e95c35eb9d", "app.use('/api/session/:sessionID', express.json({ limit: '50mb', verify: (req, _res, buf) …", [], "registers a mount on /api/session/:sessionID only; the reach check proves none of its layers applies to the group's paths"),
    entry("not-applicable", null, "ca1b50ad34f02c5f", "app.use('/api/session/:sessionID/prompt_async', express.json({ limit: '50mb', verify: (req…", [], "registers a mount on /api/session/:sessionID/prompt_async only; the reach check proves none of its layers applies to the group's paths"),
    entry("not-applicable", null, "6ce80a02bb10db30", "registerDiagnosticsRoutes(app, { runtime: harnessRuntime, getEvidenceRecords: (scope) => e…", ["registerDiagnosticsRoutes"], "registers the diagnostics routes only; the reach check proves none of its layers applies to the group's paths"),
    entry("not-applicable", null, "a3d17a26a167447f", "registerMemoryDebugRoutes(app, { getAppMetrics: typeof options.getAppMetrics === 'function…", ["registerMemoryDebugRoutes"], "registers the memory debug routes only; the reach check proves none of its layers applies to the group's paths"),
    entry("not-applicable", null, "e2fe57d4aa85f581", "registerEvidenceRoutes(app, { runtime: evidenceRuntime });", ["registerEvidenceRoutes"], "registers the evidence routes only; the reach check proves none of its layers applies to the group's paths"),
    entry("no-request", null, "f2ec6d5346ca0b33", "const resolveManagedAgentExecutionForOwner = (params) => { if (typeof multiUserRuntime.res…", [], "a resolver for managed agent execution; touches no request"),
    entry("no-request", null, "f64c4b8a4f2d1125", "managedOrchestrationRuntime = createWebManagedOrchestrationRuntime({ windowsLedgerOwner: p…", [], "creates the orchestration runtime; its routes are registered by a not-applicable statement below"),
    entry("no-request", null, "12b1d3098e857c8e", "setAgentPromptPolicySource(() => managedOrchestrationRuntime?.getHarnessPolicies?.() ?? nu…", [], "agent prompt policy; touches no request"),
    entry("no-request", null, "33c9bde33eed8a2c", "const retention = createSessionRetention({ openCodeClient, getNativeRuntime: () => nativeR…", [], "creates session retention; its routes are registered by a not-applicable statement below"),
    entry("not-applicable", null, "0ac26b825a3bf854", "registerSessionRetentionRoutes(app, { retention, gate: sessionActivityGate });", ["registerSessionRetentionRoutes"], "registers the session retention routes only; the reach check proves none of its layers applies to the group's paths"),
    entry("not-applicable", null, "bce172ee20c9660b", "registerManagedOrchestrationRoutes(app, { runtime: managedOrchestrationRuntime, express, a…", ["registerManagedOrchestrationRoutes"], "registers the managed orchestration routes only; the reach check proves none of its layers applies to the group's paths"),
    entry("not-applicable", null, "56de23bd66cbf077", "const tunnelRuntimeContext = tunnelWiringRuntime.initialize(app, port, { runtimeInstanceId…", ["tunnelWiringRuntime"], "registers the tunnel wiring routes only; the reach check proves none of its layers applies to the group's paths"),
    entry("no-request", null, "cf22572d231e101f", "const { tunnelService, startTunnelWithNormalizedRequest } = tunnelRuntimeContext;", [], "keeps the tunnel service for startup"),
    entry("not-applicable", null, "658000631e4a59c1", "registerTurnTimingRoutes(app, turnTimingRuntime, { authorize: async (req, sessionId) => { …", ["registerTurnTimingRoutes"], "registers the turn timing routes only; the reach check proves none of its layers applies to the group's paths"),
    entry("not-applicable", null, "e5d1d70e7e8762a3", "registerAgentRuntimeWarmupRoute(app, agentRuntimeWarmup);", ["registerAgentRuntimeWarmupRoute"], "registers one warmup route only; the reach check proves none of its layers applies to the group's paths"),
    entry("not-applicable", null, "e1028b7c8661dfa2", "registerHarnessPreflightRoute(app, createHarnessPreflight({ openCodeClient, getAgents: ({ …", ["registerHarnessPreflightRoute"], "registers one preflight route only; the reach check proves none of its layers applies to the group's paths"),
    entry("composed", "group", "cf4e52d3321ef69e", "await featureRoutesRuntime.registerRoutes(app, { openCodeClient, recordDiagnostic: (entry)…", ["featureRoutesRuntime","fsPromises","path","DEVRYAN_DATA_DIR"], "the group slot: the feature routes registrar, whose span up to the group's own call is the second table"),
    entry("no-request", null, "95521a7ecd8f7ec2", "const localInstanceStatusRuntime = createLocalInstanceStatusRuntime({ net, URL });", ["createLocalInstanceStatusRuntime"], "creates the local instance status runtime; its routes are attached after the group by a not-applicable statement below"),
    entry("no-request", null, "b6985f00acabdff8", "const projectPreviewInstancesRuntime = createProjectPreviewInstancesRuntime({ crypto, fs, …", ["createProjectPreviewInstancesRuntime"], "creates the project preview instances runtime; its routes are attached after the group by a not-applicable statement below"),
    entry("no-request", null, "79bf3709aa29aab4", "const previewProxyRuntime = createPreviewProxyRuntime({ crypto, URL, createProxyMiddleware…", ["createPreviewProxyRuntime"], "creates the preview proxy runtime; its routes are attached after the group by a not-applicable statement below"),
    entry("no-request", null, "817f6d66d473a088", "projectPreviewInstancesRuntime.setGrantRemovalHandler(({ id }) => { previewProxyRuntime.re…", [], "connects two preview runtimes; touches no request"),
    entry("not-applicable", null, "df44c25329089e4a", "projectPreviewInstancesRuntime.attach(app, { express, uiAuthController, isRequestOriginAll…", ["projectPreviewInstancesRuntime"], "registered after the group's call: Express runs it for the group's paths only when the group passes a request on, which the group host answers with its tail stand-in (599, kind tail)"),
    entry("not-applicable", null, "ccf1e7239fadc307", "previewProxyRuntime.attach(app, { server, express, uiAuthController, isRequestOriginAllowe…", ["previewProxyRuntime"], "registered after the group's call: Express runs it for the group's paths only when the group passes a request on, which the group host answers with its tail stand-in (599, kind tail)"),
    entry("not-applicable", null, "7aba0ec2cca7853b", "localInstanceStatusRuntime.attach(app, { express, uiAuthController, isRequestOriginAllowed…", ["localInstanceStatusRuntime"], "registered after the group's call: Express runs it for the group's paths only when the group passes a request on, which the group host answers with its tail stand-in (599, kind tail)"),
    entry("no-request", null, "d219705ab2361a05", "server.once('close', () => { void openAiOAuthBridge.close().catch(() => undefined); void P…", [], "cleanup when the server closes; touches no request"),
    entry("not-applicable", null, "28fba87f294bd640", "const startupPipelineResult = await startupPipelineRuntime.run({ openCodeClient, app, serv…", ["startupPipelineRuntime"], "the startup pipeline: static, proxy and websocket layers after the group, then listening. " + "registered after the group's call: Express runs it for the group's paths only when the group passes a request on, which the group host answers with its tail stand-in (599, kind tail)"),
    entry("no-request", null, "05ad4dec5a754714", "terminalRuntime = startupPipelineResult.terminalRuntime;", [], "keeps the terminal runtime the startup pipeline made"),
    entry("no-request", null, "3d226da357084ed1", "messageStreamRuntime = startupPipelineResult.messageStreamRuntime;", [], "keeps the message stream runtime the startup pipeline made"),
    entry("no-request", null, "2e4d4c152e6b7066", "multiUserRuntime.connection?.configureDriver({ pauseAdmissions: () => scheduledTasksRuntim…", [], "configures the Supabase connection driver; touches no request"),
    entry("no-request", null, "c6aad90f18f45cd7", "return { runtimeBundle: runtimeBundleLifecycle, issueLocalOwnerSession: async () => { if (…", [], "the host handle returned to the caller; what the caller does with the app is outside this file (docs/TESTING.md, the drift check's limits)"),
  ]),
  definitions: Object.freeze({
    DEVRYAN_DATA_DIR: def(["2f8c4879d489ca2a"], ["resolveDevRyanDataRoot"], "the data root; the host substitutes the harness data root", "const DEVRYAN_DATA_DIR = resolveDevRyanDataRoot();"),
    DEVRYAN_VERBOSE_REQUEST_LOGS: def(["229766b54099f254"], ["isEnvFlagEnabled"], "re-stated in the host", "const DEVRYAN_VERBOSE_REQUEST_LOGS = isEnvFlagEnabled(process.env.DEVR"),
    attachSupabaseConnectionBoundary: def(["c3fff60f6532c076"], [], "imported from the module the host imports", "import { attachSupabaseConnectionBoundary, registerSupabaseConnectionR"),
    bootstrapRuntime: def(["11e0f8b93267c9dd"], ["createBootstrapRuntime","createUiAuth","registerServerStatusRoutes","registerCommonRequestMiddleware","registerAuthAndAccessRoutes","registerTtsRoutes","registerNotificationRoutes","registerDevRyanRoutes","express"], "re-stated in the host with the same registrars", "const bootstrapRuntime = createBootstrapRuntime({ createUiAuth, regist"),
    bundleAdmission: def(["a61f7dc972a6048b"], ["createRuntimeBundleAdmissionGate"], "a gate created without options, as the host creates it", "const bundleAdmission = createRuntimeBundleAdmissionGate();"),
    compression: def(["c9ad00f000b7701a"], [], "the product's compression", "import compression from 'compression';"),
    configuredUiPassword: def(["0464f2a920585216"], [], "the UI password option; the host composes without one", "const configuredUiPassword = typeof options.uiPassword === 'string' ? "),
    createMultiUserRuntime: def(["22ab8b89366d0e6c"], [], "imported from the module the host imports", "import { createMultiUserRuntime, getRequestPrincipal } from './lib/mul"),
    dynamicNoStoreMiddleware: def(["c253b5010c91d5a0"], [], "imported from the module the host imports", "import { dynamicNoStoreMiddleware } from './lib/http-cache-policy.js';"),
    executionReadiness: def(["dc0bb352a70bff00"], [], "the readiness of a verified bundle; the host composes its state (active, no diagnostic)", "const executionReadiness = { state: 'active', diagnostic: null, compan"),
    executionReadinessMiddleware: def(["c8da95ef25a2b488"], [], "imported from the module the host imports", "import { executionArtifacts, executionReadinessMiddleware } from './li"),
    express: def(["c25cf86a5391bc26"], [], "the product's express", "import express from 'express';"),
    featureRoutesRuntime: def(["b75e75eefd95969a"], ["createFeatureRoutesRuntime"], "the feature routes runtime", "const featureRoutesRuntime = createFeatureRoutesRuntime({ clientReload"),
    fs: def(["efe173bd171f6a00"], [], "node:fs", "import fs from 'fs';"),
    fsPromises: def(["64dccf27632b2046"], ["fs"], "the host passes fs.promises", "const fsPromises = fs.promises;"),
    hasTunnelBoundaryAuthorization: def(["7f12dafa506a9f5e"], [], "imported from the module the host imports", "import { createTunnelAccessControl as createTunnelAuth, registerTunnel"),
    http: def(["104e5b4f1df3462c"], [], "node:http", "import http from 'http';"),
    legacyApiPathRewrite: def(["209cd3a1c5535222"], [], "imported from the module the host imports", "import { legacyApiPathRewrite } from './lib/legacy-api-path.js';"),
    path: def(["3fc2db591253a5d5"], [], "node:path", "import path from 'path';"),
    registerIndexingPolicy: def(["b2d71807c5c9959f"], [], "imported from the module the host imports", "import { registerIndexingPolicy } from './lib/indexing-policy.js';"),
    registerLocalOwnerBootstrap: def(["900a3ae798dc044d"], [], "imported from the module the host imports", "import { registerLocalOwnerBootstrap } from './lib/multi-user/local-ow"),
    registerTunnelAccessBoundary: def(["7f12dafa506a9f5e"], [], "imported from the module the host imports", "import { createTunnelAccessControl as createTunnelAuth, registerTunnel"),
    shouldSkipCompression: def(["e2702a4f7f04be07"], ["createCompressionPolicy","shouldSkipApiCompression"], "re-stated in the host with the same argument", "const { shouldSkipCompression } = createCompressionPolicy({ shouldSkip"),
    tunnelAuthController: def(["21187bd8d4a87559"], ["createTunnelAuth"], "created without options, as the host creates it", "const tunnelAuthController = createTunnelAuth();"),
    resolveDevRyanDataRoot: def(["0eb8661b62a14d56"], [], "the data root resolver the host replaces by the harness data root", "import { resolveDevRyanDataRoot } from '@devryan/shared-runtime/node/d"),
    isEnvFlagEnabled: def(["4e9b4666c5ac1e15"], [], "re-stated in the host", "const isEnvFlagEnabled = (value) => { if (value === true || value === "),
    createBootstrapRuntime: def(["d1318afd15ae9cc2"], [], "imported from the module the host imports", "import { createBootstrapRuntime } from './lib/opencode/bootstrap-runti"),
    createUiAuth: def(["f9777367b6764ecc"], [], "imported from the module the host imports", "import { createUiAuth } from './lib/ui-auth/ui-auth.js';"),
    registerServerStatusRoutes: def(["34faed7a3f23d3e3"], [], "imported from the module the host imports", "import { registerAuthAndAccessRoutes, registerCommonRequestMiddleware,"),
    registerCommonRequestMiddleware: def(["34faed7a3f23d3e3"], [], "imported from the module the host imports", "import { registerAuthAndAccessRoutes, registerCommonRequestMiddleware,"),
    registerAuthAndAccessRoutes: def(["34faed7a3f23d3e3"], [], "imported from the module the host imports", "import { registerAuthAndAccessRoutes, registerCommonRequestMiddleware,"),
    registerTtsRoutes: def(["16b46579d62a9e29"], [], "imported from the module the host imports", "import { registerTtsRoutes } from './lib/tts/routes.js';"),
    registerNotificationRoutes: def(["a31f3220724d4bd2"], [], "imported from the module the host imports", "import { registerNotificationRoutes } from './lib/notifications/routes"),
    registerDevRyanRoutes: def(["92fcd5f0f6032829"], [], "imported from the module the host imports", "import { registerDevRyanRoutes } from './lib/opencode/devryan-routes.j"),
    createRuntimeBundleAdmissionGate: def(["d812b83c923c4201"], [], "imported from the module the host imports", "import { createRuntimeBundleLifecycle, createRuntimeBundleAdmissionGat"),
    createFeatureRoutesRuntime: def(["d2397a0d4a5ec5d6"], [], "imported from the module whose span is the second table", "import { createFeatureRoutesRuntime } from './lib/opencode/feature-rou"),
    createCompressionPolicy: def(["44d5eae17a210a3c"], [], "imported from the module the host imports", "import { createCompressionPolicy } from './lib/http-compression-policy"),
    shouldSkipApiCompression: def(["22a746e6b83ed000"], ["isEnvFlagEnabled","isEnvFlagDisabled"], "re-stated in the host", "const shouldSkipApiCompression = () => { if (isEnvFlagEnabled(process."),
    createTunnelAuth: def(["7f12dafa506a9f5e"], [], "imported from the module the host imports", "import { createTunnelAccessControl as createTunnelAuth, registerTunnel"),
    isEnvFlagDisabled: def(["719cab2b14d1cc9e"], [], "re-stated in the host", "const isEnvFlagDisabled = (value) => { if (value === false || value =="),
    createProjectPreviewInstancesRuntime: def(["af4294cf2c37c30c"], [], "the registrar's module, pinned: the reach check reads the census, which imports its own copy of it", "import { createProjectPreviewInstancesRuntime } from './lib/preview/pr"),
    createPreviewProxyRuntime: def(["9bf4c40a986857b1"], [], "the registrar's module, pinned: the reach check reads the census, which imports its own copy of it", "import { classifyPreviewRequestScope, createPreviewProxyRuntime } from"),
    createLocalInstanceStatusRuntime: def(["826f9566c9ebd1cf"], [], "the registrar's module, pinned: the reach check reads the census, which imports its own copy of it", "import { createLocalInstanceStatusRuntime } from './lib/preview/local-"),
    registerAgentRuntimeWarmupRoute: def(["4bd7a99114eeec6d"], [], "the registrar's module, pinned: the reach check reads the census, which imports its own copy of it", "import { createAgentRuntimeWarmup, registerAgentRuntimeWarmupRoute } f"),
    registerDiagnosticsRoutes: def(["2c8d72ca4921e78d"], [], "the registrar's module, pinned: the reach check reads the census, which imports its own copy of it", "import { registerDiagnosticsRoutes } from './lib/diagnostics/routes.js"),
    registerEvidenceRoutes: def(["0007768b0e4efc77"], [], "the registrar's module, pinned: the reach check reads the census, which imports its own copy of it", "import { registerEvidenceRoutes } from './lib/evidence/routes.js';"),
    registerHarnessPreflightRoute: def(["24c52be884888a9f"], [], "the registrar's module, pinned: the reach check reads the census, which imports its own copy of it", "import { createHarnessPreflight, registerHarnessPreflightRoute } from "),
    registerManagedOrchestrationRoutes: def(["7cfcfee0e483e041"], [], "the registrar's module, pinned: the reach check reads the census, which imports its own copy of it", "import { registerManagedOrchestrationRoutes, captureRequiredCheckUserA"),
    registerMemoryDebugRoutes: def(["f43db226f45f1dec"], [], "the registrar's module, pinned: the reach check reads the census, which imports its own copy of it", "import { registerMemoryDebugRoutes } from './lib/debug/memory-routes.j"),
    registerRuntimeBundleLifecycleRoutes: def(["d812b83c923c4201"], [], "the registrar's module, pinned: the reach check reads the census, which imports its own copy of it", "import { createRuntimeBundleLifecycle, createRuntimeBundleAdmissionGat"),
    registerSessionRetentionRoutes: def(["3e22120790f95db3"], [], "the registrar's module, pinned: the reach check reads the census, which imports its own copy of it", "import { createSessionRetention, registerSessionRetentionRoutes } from"),
    registerTurnTimingRoutes: def(["6117a48603913759"], [], "the registrar's module, pinned: the reach check reads the census, which imports its own copy of it", "import { createTurnTimingRuntime, registerTurnTimingRoutes } from './l"),
    startupPipelineRuntime: def(["3dd2b2e15eb8959e"], ["createStartupPipelineRuntime"], "the startup pipeline runtime", "const startupPipelineRuntime = createStartupPipelineRuntime({ createTe"),
    tunnelWiringRuntime: def(["619372e2f15f3f68"], ["createTunnelWiringRuntime"], "the tunnel wiring runtime", "const tunnelWiringRuntime = createTunnelWiringRuntime({ crypto, URL, t"),
    createStartupPipelineRuntime: def(["a982e641cbedf6e8"], [], "the registrar's module, pinned: the reach check reads the census, which imports its own copy of it", "import { createStartupPipelineRuntime } from './lib/opencode/startup-p"),
    createTunnelWiringRuntime: def(["4359dfd726734889"], [], "the registrar's module, pinned: the reach check reads the census, which imports its own copy of it", "import { createTunnelWiringRuntime } from './lib/opencode/tunnel-wirin"),
  }),
});

/** feature-routes-runtime.js up to each group's own call, per group. */
export const GROUP_TABLES = Object.freeze({
  'magic-prompts': Object.freeze({
    file: 'lib/opencode/feature-routes-runtime.js',
    spec: Object.freeze({ functionNamed: 'registerRoutes', endCall: 'registerMagicPromptRoutes' }),
    roots: 'first-parameter',
    entries: Object.freeze([
      entry("composed", "group", "962dc2618e6225ea", "const { crypto, fs, os, path, fsPromises, spawn, resolveGitBinaryForSpawn, createFsSearchR…", ["routeDependencies"], "the dependencies the group's call reads"),
      entry("not-applicable", null, "2a12ac760744fb44", "registerSettingsUtilityRoutes(app, { readCustomThemesFromDisk, });", ["registerSettingsUtilityRoutes"], "registers the settings utility routes only; the reach check proves none of its layers applies to the group's paths"),
      entry("not-applicable", null, "63e9d91868057add", "registerConfigApplyRoutes(app, { coordinator: configApplyCoordinator, markConfigChange, ca…", ["registerConfigApplyRoutes"], "registers the config apply routes only; the reach check proves none of its layers applies to the group's paths"),
      entry("not-applicable", null, "24f232f8fb1dabc1", "registerOpenCodeRoutes(app, { openCodeClient, recordDiagnostic: routeDependencies.recordDi…", ["registerOpenCodeRoutes"], "registers the OpenCode routes only; the reach check proves none of its layers applies to the group's paths"),
      entry("not-applicable", null, "13944067baab9018", "registerProjectIconRoutes(app, { fsPromises, path, crypto, devryanDataDir, projectIconStor…", ["registerProjectIconRoutes"], "registers the project icon routes only; the reach check proves none of its layers applies to the group's paths"),
      entry("not-applicable", null, "e50ddb0673378db9", "registerScheduledTaskRoutes(app, { readSettingsFromDiskMigrated, sanitizeProjects, project…", ["registerScheduledTaskRoutes"], "registers the scheduled task routes only; the reach check proves none of its layers applies to the group's paths"),
      entry("not-applicable", null, "423ee6dbb68f1b7f", "registerReadonlyPluginRoutes(app, { resolveOptionalProjectDirectory, listPlugins: pluginRe…", ["registerReadonlyPluginRoutes"], "registers the read-only plugin routes only; the reach check proves none of its layers applies to the group's paths"),
      entry("not-applicable", null, "1aa62910ee82ecf1", "registerConfigEntityRoutes(app, { readAgentModelCatalog: directory => openCodeClient.catal…", ["registerConfigEntityRoutes"], "registers the config entity routes only; the reach check proves none of its layers applies to the group's paths"),
      entry("not-applicable", null, "dc421942d49f8241", "registerSkillRoutes(app, { openCodeClient, fs, path, os, resolveProjectDirectory, resolveO…", ["registerSkillRoutes"], "registers the skill routes only; the reach check proves none of its layers applies to the group's paths"),
      entry("not-applicable", null, "2810f83ed142a461", "registerQuotaRoutes(app, { devryanDataDir, recordDiagnostic: routeDependencies.recordDiagn…", ["registerQuotaRoutes"], "registers the quota routes only; the reach check proves none of its layers applies to the group's paths"),
      entry("not-applicable", null, "2366bd5207e03324", "registerGitHubRoutes(app);", ["registerGitHubRoutes"], "registers the GitHub routes only; the reach check proves none of its layers applies to the group's paths"),
      entry("not-applicable", null, "227f1dde2639c163", "registerProcessesRoutes(app, { runtime: processesRuntime });", ["registerProcessesRoutes"], "registers the processes routes only; the reach check proves none of its layers applies to the group's paths"),
      entry("not-applicable", null, "49e53178fee20d0d", "registerGitRoutes(app, { openCodeClient, broadcastEvent: broadcastGlobalUiEvent, generateH…", ["registerGitRoutes"], "registers the git routes only; the reach check proves none of its layers applies to the group's paths"),
      entry("composed", "group-call", "da21242b613e57e7", "registerMagicPromptRoutes(app, { fsPromises, path, devryanDataDir, });", ["registerMagicPromptRoutes","fsPromises","path","devryanDataDir"], "the group's own call, composed by the group table"),
      entry("not-applicable", null, "d9f166918827ed58", "registerSessionFoldersRoutes(app, { fsPromises, path, devryanDataDir, });", ["registerSessionFoldersRoutes"], "registered after the group's call: Express runs it for the group's paths only when the group passes a request on, which the group host answers with its tail stand-in (599, kind tail)"),
      entry("not-applicable", null, "63ad587c7369a090", "registerSessionPlanRoutes(app, { dataDirectory: devryanDataDir, fsPromises, path, ownsSess…", ["registerSessionPlanRoutes"], "registered after the group's call: Express runs it for the group's paths only when the group passes a request on, which the group host answers with its tail stand-in (599, kind tail)"),
      entry("no-request", null, "faea4d13595beabc", "const imageAssetsRuntime = createImageAssetsRuntime({ openCodeClient, fsPromises, path, os…", ["createImageAssetsRuntime"], "creates the image assets runtime; its routes are registered after the group by a not-applicable statement below"),
      entry("not-applicable", null, "8d5d6b01f6ca7848", "imageAssetsRuntime.registerRoutes(app);", ["imageAssetsRuntime"], "registered after the group's call: Express runs it for the group's paths only when the group passes a request on, which the group host answers with its tail stand-in (599, kind tail)"),
      entry("not-applicable", null, "7d78e1dc6fb88bcc", "registerFsRoutes(app, { os, path, fsPromises, spawn, crypto, normalizeDirectoryPath, resol…", ["registerFsRoutes"], "registered after the group's call: Express runs it for the group's paths only when the group passes a request on, which the group host answers with its tail stand-in (599, kind tail)"),
    ]),
    definitions: Object.freeze({
      registerMagicPromptRoutes: def(["a3047d3c7290e132"], [], "imported from the registrar the group table names", "import { registerMagicPromptRoutes } from '../magic-prompts/routes.js'"),
      routeDependencies: def(["66648dcc399c6914"], [], "the parameter the server's call fills", "routeDependencies"),
      createImageAssetsRuntime: def(["ab0c53379ffcf6da"], [], "the registrar's module, pinned: the reach check reads the census, which imports its own copy of it", "import { createImageAssetsRuntime } from '../image-assets/runtime.js';"),
      registerConfigApplyRoutes: def(["4d72f502bbed2f99"], [], "the registrar's module, pinned: the reach check reads the census, which imports its own copy of it", "import { registerConfigApplyRoutes } from './config-apply-runtime.js';"),
      registerConfigEntityRoutes: def(["9071d283143201c1"], [], "the registrar's module, pinned: the reach check reads the census, which imports its own copy of it", "import { registerConfigEntityRoutes } from './config-entity-routes.js'"),
      registerFsRoutes: def(["7120b61a0676e254"], [], "the registrar's module, pinned: the reach check reads the census, which imports its own copy of it", "import { registerFsRoutes } from '../fs/routes.js';"),
      registerGitHubRoutes: def(["9cf76418e9b2951d"], [], "the registrar's module, pinned: the reach check reads the census, which imports its own copy of it", "import { registerGitHubRoutes } from '../github/routes.js';"),
      registerGitRoutes: def(["9ff1af7009b6a596"], [], "the registrar's module, pinned: the reach check reads the census, which imports its own copy of it", "import { registerGitRoutes } from '../git/routes.js';"),
      registerOpenCodeRoutes: def(["d91ec94ac32364c8"], [], "the registrar's module, pinned: the reach check reads the census, which imports its own copy of it", "import { registerOpenCodeRoutes } from './routes.js';"),
      registerProcessesRoutes: def(["b407af537289a714"], [], "the registrar's module, pinned: the reach check reads the census, which imports its own copy of it", "import { registerProcessesRoutes } from '../processes/routes.js';"),
      registerProjectIconRoutes: def(["b5f2c0d3d1830efe"], [], "the registrar's module, pinned: the reach check reads the census, which imports its own copy of it", "import { registerProjectIconRoutes } from './project-icon-routes.js';"),
      registerQuotaRoutes: def(["4e032753e7854a7d"], [], "the registrar's module, pinned: the reach check reads the census, which imports its own copy of it", "import { registerQuotaRoutes } from '../quota/routes.js';"),
      registerReadonlyPluginRoutes: def(["925a677222456b41"], [], "the registrar's module, pinned: the reach check reads the census, which imports its own copy of it", "import { createPluginReadModel, registerReadonlyPluginRoutes } from '."),
      registerScheduledTaskRoutes: def(["dda8ea11ff1679bf"], [], "the registrar's module, pinned: the reach check reads the census, which imports its own copy of it", "import { registerScheduledTaskRoutes } from '../scheduled-tasks/routes"),
      registerSessionFoldersRoutes: def(["43cddbd6656da7d5"], [], "the registrar's module, pinned: the reach check reads the census, which imports its own copy of it", "import { registerSessionFoldersRoutes } from '../session-folders/route"),
      registerSessionPlanRoutes: def(["2365845dc276b991"], [], "the registrar's module, pinned: the reach check reads the census, which imports its own copy of it", "import { registerSessionPlanRoutes } from '../plans/routes.js';"),
      registerSettingsUtilityRoutes: def(["5f9023eea8a76969"], [], "the registrar's module, pinned: the reach check reads the census, which imports its own copy of it", "import { registerSettingsUtilityRoutes } from './core-routes.js';"),
      registerSkillRoutes: def(["24dff5c71e62496e"], [], "the registrar's module, pinned: the reach check reads the census, which imports its own copy of it", "import { registerSkillRoutes } from './skill-routes.js';"),
    }),
  }),
});

/** The composed steps of a table, in order, each once. */
export const composedSteps = (table) => table.entries.filter((item) => item.class === 'composed').map((item) => item.step).filter((step, index, all) => step !== all[index - 1]);

/**
 * Problems of the re-statement against the server's files as text: the two
 * spans, their definitions, and the composed steps against EDGE_STEPS.
 * `serverRoot` is the server directory to read (a scratch copy for a planted
 * check). Empty when the composition matches the table.
 */
export function compositionTextDrift({ group, serverRoot = SERVER_ROOT, readFile = (file) => fs.readFileSync(file, 'utf8') }) {
  const problems = [];
  const groupTable = Object.hasOwn(GROUP_TABLES, group) ? GROUP_TABLES[group] : null;
  if (!groupTable) return [`no composition table for group ${group}`];
  for (const table of [APPLICATION_TABLE, groupTable]) {
    let text;
    try { text = readFile(path.join(serverRoot, table.file)); } catch (error) { problems.push(`${table.file}: cannot be read (${error.code ?? error.message})`); continue; }
    problems.push(...checkSpan({ table, text }).problems);
  }
  const steps = composedSteps(APPLICATION_TABLE);
  const hostSteps = EDGE_STEPS.map((step) => step.id);
  if (JSON.stringify(steps) !== JSON.stringify(hostSteps)) problems.push(`table: the composed steps of application.js are ${steps.join(', ')}; the group host composes ${hostSteps.join(', ')}`);
  return problems;
}

/** The statements of each span as they are now, with digests (for re-reviewing the table). */
export function compositionDraft({ group, serverRoot = SERVER_ROOT }) {
  return [APPLICATION_TABLE, GROUP_TABLES[group]].map((table) => ({ file: table.file, statements: draftTable({ table, text: fs.readFileSync(path.join(serverRoot, table.file), 'utf8') }) }));
}

/** The probes' expectations must be the server's own text (the statements the table classifies as those steps). */
export function expectationProblems({ expected, serverRoot = SERVER_ROOT, readFile = (file) => fs.readFileSync(file, 'utf8') }) {
  const problems = [];
  let statements;
  try { statements = checkSpan({ table: APPLICATION_TABLE, text: readFile(path.join(serverRoot, APPLICATION_TABLE.file)) }).statements; } catch { return problems; }
  const text = (step) => statements.filter((statement) => statement.entry?.step === step).map((statement) => statement.text).join(' ');
  if (!text('compression').includes(`threshold: ${expected.compressionThreshold}`)) problems.push(`probes: the compression probe expects threshold ${expected.compressionThreshold}; the server's compression statement does not say so`);
  if (!text('trust-proxy').includes(`app.set('trust proxy', ${expected.trustProxy})`)) problems.push(`probes: the trust proxy probe expects ${expected.trustProxy}; the server's statement does not say so`);
  return problems;
}

/**
 * The whole composition check of a harness run (decisions 1-4): the server's
 * text against the table, the census's reach and layer stack against the
 * group host, and the edge probes against a toy host. `run` is the run root
 * (run-scratch.mjs). Returns problems; any problem makes the run inconclusive.
 */
export async function checkComposition({ run, name, group, textOnly = false, serverRoot = SERVER_ROOT, log = () => {} }) {
  const problems = compositionTextDrift({ group: name, serverRoot }).map((problem) => `composition: ${problem}`);
  const { EXPECTED } = await import('./edge-probes.mjs');
  problems.push(...expectationProblems({ expected: EXPECTED, serverRoot }));
  log(`composition: text ${problems.length ? `${problems.length} problems` : 'matches the table'}`);
  if (textOnly) return problems;
  const [{ runCensus }, { layerStackProblems, reachProblems }, { startGroupHost }, { edgeProbeProblems }, { GROUPS: TOY_GROUPS }] = await Promise.all([
    import('./census.mjs'), import('./reach.mjs'), import('./host-launch.mjs'), import('./edge-probes.mjs'), import('./toy/toy-groups.mjs'),
  ]);
  const census = await runCensus({ dataDirectory: run.makeDirectory('composition/census') });
  const reach = await reachProblems({ group, census, values: group.parameterValues ?? {} });
  problems.push(...reach);
  log(`composition: reach ${reach.length ? `${reach.length} problems` : 'clean'}`);
  const host = await startGroupHost({ run, name, group, label: 'composition/host' });
  try {
    const { body } = await host.control('/registrations');
    const stack = await layerStackProblems({ group, census, hostRegistrations: body.registrations, values: group.parameterValues ?? {} });
    problems.push(...stack);
    log(`composition: layer stack ${stack.length ? `${stack.length} problems` : 'equals the census'}`);
  } finally { await host.stop(); }
  const toy = await startGroupHost({ run, name: 'toy', group: TOY_GROUPS.toy, label: 'composition/toy', table: path.join(path.dirname(fileURLToPath(import.meta.url)), 'toy/toy-groups.mjs') });
  try {
    const probed = await edgeProbeProblems({ port: toy.ready.listen });
    problems.push(...probed.problems);
    log(`composition: ${probed.probes.length} edge probes, ${probed.problems.length} problems`);
  } finally { await toy.stop(); }
  return problems;
}

const USAGE = 'usage: composition-drift.mjs --group=<name> [--text-only] [--server-root=<dir>] [--draft] [--keep-artifacts]';
export const EXIT = Object.freeze({ matches: 0, drift: 2, refused: 64 });

async function main(argv = process.argv.slice(2)) {
  const { isolationRefusal, createBackendRun, RunRefused } = await import('./run-scratch.mjs');
  const { GROUPS } = await import('./groups.mjs');
  const refusal = isolationRefusal();
  if (refusal) { process.stderr.write(`composition drift: ${refusal}\n`); return EXIT.refused; }
  const options = { textOnly: false, draft: false, serverRoot: SERVER_ROOT, group: null };
  for (const argument of argv) {
    if (argument === '--text-only') options.textOnly = true;
    else if (argument === '--draft') options.draft = true;
    else if (argument === '--keep-artifacts') continue;
    else if (/^--group=.+$/.test(argument)) options.group = argument.slice(8);
    else if (/^--server-root=.+$/.test(argument)) options.serverRoot = path.resolve(argument.slice(14));
    else { process.stderr.write(`composition drift: unknown option ${argument}\n${USAGE}\n`); return EXIT.refused; }
  }
  if (!options.group || !Object.hasOwn(GROUPS, options.group) || !Object.hasOwn(GROUP_TABLES, options.group)) { process.stderr.write(`composition drift: --group must name a group with a composition table (${Object.keys(GROUP_TABLES).join(', ')})\n${USAGE}\n`); return EXIT.refused; }
  if (options.draft) {
    for (const part of compositionDraft({ group: options.group, serverRoot: options.serverRoot })) {
      console.log(`# ${part.file}`);
      for (const statement of part.statements) console.log(`${statement.digest} line ${statement.line} ${statement.entry ? `[${statement.entry.class}${statement.entry.step ? ` ${statement.entry.step}` : ''}]` : '[UNCLASSIFIED]'} ${statement.text.slice(0, 160)}`);
    }
    return EXIT.matches;
  }
  if (options.textOnly) {
    const problems = await checkComposition({ name: options.group, group: GROUPS[options.group], textOnly: true, serverRoot: options.serverRoot });
    for (const problem of problems) console.log(`DRIFT ${problem}`);
    console.log(`composition drift (${options.group}, text): ${problems.length ? `DRIFT, ${problems.length} problems` : 'matches the table'} exit ${problems.length ? EXIT.drift : EXIT.matches}`);
    return problems.length ? EXIT.drift : EXIT.matches;
  }
  let run;
  try { run = createBackendRun({ owner: 'backend-conformance-composition', keepArtifacts: argv.includes('--keep-artifacts') }); } catch (error) {
    if (error instanceof RunRefused) { process.stderr.write(`composition drift: ${error.message}\n`); return EXIT.refused; }
    throw error;
  }
  let exit = EXIT.drift;
  try {
    const problems = await checkComposition({ run, name: options.group, group: GROUPS[options.group], serverRoot: options.serverRoot, log: (line) => console.log(line) });
    for (const problem of problems) console.log(`DRIFT ${problem}`);
    exit = problems.length ? EXIT.drift : EXIT.matches;
    console.log(`composition drift (${options.group}): ${problems.length ? `DRIFT, ${problems.length} problems` : 'matches'} exit ${exit}`);
    return exit;
  } catch (error) {
    console.log(`composition drift (${options.group}): the check could not complete: ${error.stack ?? error}`);
    return EXIT.drift;
  } finally { run.finish(exit === EXIT.matches ? 'passed' : 'failed'); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
  process.exit();
}
