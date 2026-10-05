import express from 'express';
import http from 'node:http';
import {resumeRuntimeBundle} from './runtime-bundle-resume.js';
import { selectedRuntimeBundle } from './runtime-bundle-binding.js';
import { parseServeCliOptions } from '../cli-options.js';
import { runCliEntryIfMain } from '../cli-entry-runtime.js';

const fail = () => Object.assign(new Error('bundle_rollback_reconciliation_required'), { code: 'bundle_rollback_reconciliation_required', status: 503 });
const emptySchedule = Object.freeze({ hasEnabledScheduledTasks: false, hasPendingScheduledTasks: false,
  hasRunningScheduledTasks: false, enabledScheduledTasksCount: 0, pendingScheduledTasksCount: 0, runningScheduledTasksCount: 0 });

// This page renders before shared UI assets or theme settings are available.
const recoveryStyles = `
:root{color-scheme:light dark;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--page:#f8fafc;--surface:#ffffff;--text:#0f172a;--muted:#334155;--border:#cbd5e1;--link:#1d4ed8;--button:#1d4ed8;--button-text:#ffffff}
@media(prefers-color-scheme:dark){:root{--page:#0f172a;--surface:#172033;--text:#f1f5f9;--muted:#cbd5e1;--border:#475569;--link:#93c5fd;--button:#93c5fd;--button-text:#0f172a}}
*{box-sizing:border-box}html{min-height:100%;background:var(--page);color:var(--text)}body{margin:0;padding:clamp(1rem,4vw,3rem);font-size:1rem;line-height:1.6;background:var(--page);color:var(--text)}main{max-width:48rem;margin:0 auto;padding:clamp(1rem,4vw,2rem);background:var(--surface);border:1px solid var(--border);border-radius:1rem}h1{font-size:clamp(1.5rem,4vw,2rem);line-height:1.25;margin:0 0 1rem}p{margin:1rem 0;color:var(--muted)}a{color:var(--link);text-underline-offset:.2em}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:1rem;border:1px solid var(--border);border-radius:.5rem}code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.9rem;color:var(--text)}button{min-height:44px;max-width:100%;padding:.625rem 1rem;font:inherit;font-weight:600;line-height:1.4;color:var(--button-text);background:var(--button);border:1px solid var(--button);border-radius:.5rem;cursor:pointer}button:disabled{cursor:wait}a:focus-visible,button:focus-visible{outline:3px solid var(--link);outline-offset:3px}#result{overflow-wrap:anywhere}
`;

/** No normal application import, store owner, provider, session, tunnel or
 * controller starts here. A cold process cannot manufacture an original ACK. */
export function createRuntimeBundleRecoveryApplication({ binding = selectedRuntimeBundle, processLike = process,resume=resumeRuntimeBundle } = {}) {
  if (binding?.admission!=='held'&&!binding?.selection.reconciliationRequired) throw fail();
  let server, app, exitOnShutdown = false;
  const inspect = async () => ({ state: 'held', reason: 'bundle_rollback_reconciliation_required',
    bundleID: binding.descriptor.bundleID, previousBundleID: binding.selection.previousBundleID,
    revision: binding.selection.revision, reconciliationRequired: true, restartRequired: false,
    recoveryRequiresOriginalCheckpoint: true, resumeAvailable: Boolean(binding.rollbackRecovery?.candidateBundleID), resumeRequiresOriginalProof:true });
  const stop = async ({ exitProcess = false } = {}) => {
    if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (exitProcess) processLike.exit(0);
  };
  const start = async (options = {}) => {
    if (server) throw Object.assign(new Error('bundle_recovery_already_started'), { code: 'bundle_recovery_already_started' });
    // Inspection contains no paths, user data or credentials, and binds only
    // loopback. Remote interfaces and saved tunnels remain inactive.
    if (options.host && !['127.0.0.1', 'localhost', '::1'].includes(options.host)) throw Object.assign(new Error('bundle_recovery_loopback_required'), { code: 'bundle_recovery_loopback_required' });
    const port = options.port ?? 3000;
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('Invalid port');
    app = express(); app.disable('x-powered-by');
    app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    const status = async (_req, res) => res.status(503).json({ ok: false, isOpenCodeReady: false,
      executionRuntime: { state: 'held', code: 'bundle_rollback_reconciliation_required' }, runtimeBundle: await inspect() });
    app.get('/health', status); app.get('/api/health', status);
    app.get('/api/runtime/bundle', async (_req, res) => res.json(await inspect()));
    app.get('/', async (_req, res) => {
      const status=await inspect();
      res.type('html').send('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>DevRyan Runtime Recovery</title><style>' + recoveryStyles + '</style><body><main><h1>Runtime recovery is required</h1><p>Your runtime bundles are retained. Provider and session work is paused while rollback credentials are reconciled.</p><p>Resume the retained candidate with the local owner command:</p><pre><code>openchamber runtime bundle resume --expected-revision ' + binding.selection.revision + '</code></pre><p>The original checkpoint and unchanged candidate are required; no HTTP mutation is available.</p><button id="resume" hidden>Resume retained candidate</button><p id="result" role="status"></p><p><a href="/api/runtime/bundle">Inspect recovery status</a></p></main><script>(()=>{const invoke=window.__TAURI__?.core?.invoke,button=document.getElementById("resume"),result=document.getElementById("result");if(typeof invoke!=="function"||' + JSON.stringify(status.resumeAvailable) + '!==true)return;button.hidden=false;button.addEventListener("click",async()=>{button.disabled=true;try{const response=await invoke("desktop_runtime_bundle_resume",{expectedRevision:' + binding.selection.revision + '});if(response?.state==="cancelled"){result.textContent="Resume cancelled.";button.disabled=false;return;}if(response?.state!=="restart_required")throw Error("bundle_recovery_failed");result.textContent="Retained candidate resumed. Restarting DevRyan.";}catch(error){const serialized=typeof error?.message==="string"&&error.message.length<=256?error.message.match(/^Error invoking remote method \'openchamber:invoke\': Error: (bundle_[a-z0-9_]{1,100})$/)?.[1]:undefined;const code=typeof error?.code==="string"&&/^bundle_[a-z0-9_]{1,100}$/.test(error.code)?error.code:serialized??"bundle_recovery_failed";result.textContent=code;button.disabled=false;}});})();</script></body></html>');
    });
    app.use((_req, res) => res.status(503).json({ code: 'bundle_rollback_reconciliation_required' }));
    server = http.createServer(app);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, options.host ?? '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
    options.onOpenCodeStartupStatus?.('Runtime recovery is required. Both bundles are retained.');
    if (options.attachSignals !== false) {
      const signal = () => { void stop({ exitProcess: exitOnShutdown || options.exitOnShutdown === true }); };
      processLike.once('SIGINT', signal); processLike.once('SIGTERM', signal);
      server.once('close', () => { processLike.removeListener('SIGINT', signal); processLike.removeListener('SIGTERM', signal); });
    }
    return { expressApp: app, httpServer: server, getPort: () => {
      const address = server.address(); return address && typeof address !== 'string' ? address.port : null;
    }, getOpenCodePort: () => null, isReady: () => false, runtimeBundle: { inspect, resume: input=>resume({controlRoot:binding.controlRoot,input}), upgrade: async () => { throw fail(); }, rollback: async () => { throw fail(); } },
    getManagedOrchestrationDiagnostics: () => null, getBrowserLeaseDiagnostics: () => ({ activeLeases: 0 }),
    getQuitRiskStatus: async () => ({ tunnel: { active: false }, scheduledTasks: emptySchedule, scheduledTasksVerified: true }),
    issueLocalOwnerSession: async () => null, issueBotOwnerSession: async () => null,
    prepareBotRuntime: async () => ({ state: 'held', reason: 'bundle_rollback_reconciliation_required' }),
    resumeDeferredOpenCodeStartup: async () => { throw fail(); }, isOpenCodeStartupDeferred: () => false,
    restartOpenCode: async () => { throw fail(); }, stop };
  };
  return { startWebUiServer: start, gracefulShutdown: stop, setupProxy: () => { throw fail(); }, restartOpenCode: async () => { throw fail(); },
    parseArgs: parseServeCliOptions,
    runWebCliEntry: filename => runCliEntryIfMain({ process: processLike, currentFilename: filename,
      parseServeCliOptions, defaultPort: 3000, cloudflareProvider: 'cloudflare', managedLocalMode: 'managed-local',
      setExitOnShutdown: value => { exitOnShutdown = value; }, startServer: start }) };
}

const recovery = (selectedRuntimeBundle?.admission==='held'||selectedRuntimeBundle?.selection.reconciliationRequired) ? createRuntimeBundleRecoveryApplication() : null;
export const startWebUiServer = (...args) => recovery.startWebUiServer(...args);
export const gracefulShutdown = (...args) => recovery.gracefulShutdown(...args);
export const setupProxy = (...args) => recovery.setupProxy(...args);
export const restartOpenCode = (...args) => recovery.restartOpenCode(...args);
export const parseArgs = parseServeCliOptions;
export const runWebCliEntry = (...args) => recovery.runWebCliEntry(...args);
