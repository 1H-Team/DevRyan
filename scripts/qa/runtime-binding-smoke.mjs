// Packaged startup regression: synthetic sealed documents, never installed data.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { prepareRuntimeUiProfile, runtimeUiTuple } from './native-backend-ui-diagnostic.mjs';
import { loadQaPackagedArtifact } from './packaged-artifact.mjs';
import { reservePort, startOwnedProcess } from './process.mjs';
import { createRunRoot } from './run-root.mjs';
import { CdpConnection, discoverPageTarget, evaluate } from './cdp.mjs';
import { readRuntimeBundleBinding } from '../../packages/web/server/lib/opencode/runtime-host/runtime-bundle-binding.js';
import { captureFirstDocumentStartup, observeStartupNavigation } from '../perf/electron-lifecycle-benchmark.mjs';
import { observeNativeStartupSubscription } from './native-startup-benchmark.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
assert.equal(process.argv.length, 3, 'Usage: bun scripts/qa/runtime-binding-smoke.mjs <package-evidence>');
const packaged = await loadQaPackagedArtifact({ root, evidencePath: process.argv[2] });
let stop = async () => {};
const run = createRunRoot({ parent: path.join(root, '.cache/qa'), prefix: 'runtime-binding-',
  owner: 'scripts/qa/runtime-binding-smoke.mjs', onInterrupt: () => stop() });
const evidence = { outcome: 'failed', archiveSha256: packaged.evidence.archiveSha256, scenarios: [] };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  const artifactRoot = path.join(run.dir, 'runtime', 'artifacts');
  await fs.cp(path.join(packaged.evidence.appPath, 'Contents/Resources/revert-runtime/darwin-arm64'), artifactRoot, { recursive: true });
  for (const scenario of ['large-manifest', 'invalid-manifest']) {
    const runtimeRoot = path.join(run.dir, 'runtime', scenario), workspace = path.join(runtimeRoot, 'workspace');
    await fs.mkdir(workspace, { recursive: true });
    execFileSync('git', ['init', '--quiet', '--template=', workspace]);
    let prepared, app, cdp, navigation, subscription;
    stop = async () => { navigation?.complete(); subscription?.close(); cdp?.close(); try { await app?.stop(); } finally { await prepared?.close(); } };
    try {
      prepared = await prepareRuntimeUiProfile({ cell: { transport: 'runtime-fixture' }, runtimeRoot, workspace, targetGeneration: 2, artifactRoot });
      const binding = readRuntimeBundleBinding({ DEVRYAN_RUNTIME_BUNDLE_ROOT: prepared.controlRoot });
      const manifest = await fs.readFile(binding.descriptor.preparedManifestPath, 'utf8');
      const bytes = manifest + ' '.repeat(5 * 1024 * 1024);
      await fs.writeFile(binding.descriptor.preparedManifestPath, bytes);
      await fs.writeFile(path.join(prepared.controlRoot, 'selection.json'), JSON.stringify({ ...binding.selection,
        preparedManifestSha256: scenario === 'large-manifest' ? hash(bytes) : '0'.repeat(64) }));
      const port = await reservePort(), debugPort = await reservePort(), profile = path.join(runtimeRoot, 'profile');
      const settingsFile = path.join(binding.descriptor.launch.webDataDirectory, 'settings.json');
      const settings = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
      await fs.writeFile(settingsFile, JSON.stringify({ ...settings, desktopLocalPort: port, desktopLanAccessEnabled: false, productionBotsRuntimeMode: 'disabled' }));
      const env = { ...prepared.env, DEVRYAN_QA_RUNTIME: 'electron', OPENCHAMBER_ELECTRON_USER_DATA_DIR: profile };
      delete env.NODE_OPTIONS;
      const startedAt = performance.now();
      app = startOwnedProcess(packaged.binary, [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`], { cwd: workspace, env });
      const target = await discoverPageTarget(debugPort);
      cdp = await CdpConnection.connect(target.webSocketDebuggerUrl);
      navigation = observeStartupNavigation(cdp, startedAt, target.url);
      subscription = observeNativeStartupSubscription(cdp, startedAt, `http://127.0.0.1:${port}`);
      await Promise.all([cdp.send('Page.enable'), cdp.send('Runtime.enable'), cdp.send('Network.enable')]);
      const deadline = Date.now() + 120_000;
      let result;
      while (Date.now() < deadline) {
        app.check();
        result = await evaluate(cdp, `({ href: location.href, text: document.body?.innerText ?? '',
          retry: !!document.querySelector('a[href="openchamber://retry-startup"]'),
          composer: !!document.querySelector('[contenteditable="true"], textarea') })`).catch(() => null);
        if (scenario === 'invalid-manifest' && result?.retry && result.text.includes('runtime_bundle_binding_invalid')) break;
        if (scenario === 'large-manifest' && result?.href.startsWith('http://127.0.0.1:')) break;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      assert.ok(Date.now() < deadline, `${scenario}: startup deadline exceeded`);
      if (scenario === 'large-manifest') {
        const startup = await captureFirstDocumentStartup({ cdp, origin: `http://127.0.0.1:${port}`, startedAt,
          checkAlive: () => { app.check(); subscription.check(); }, navigationAudit: navigation, startupMode: 'foreground',
          foregroundWindow: { method: 'desktop_focus_main_window', activate: async () => {
            const focused = await evaluate(cdp, 'window.__TAURI__.core.invoke("desktop_focus_main_window", {})');
            assert.equal(focused?.focused, true); return focused;
          } }, runtimeUiTuple: { providerId: runtimeUiTuple.providerID, modelId: runtimeUiTuple.modelID, agent: 'builder' },
          isEventStreamReady: subscription.isReady });
        assert.equal(startup.outcome, 'passed', startup.error);
        assert.equal(readRuntimeBundleBinding({ DEVRYAN_RUNTIME_BUNDLE_ROOT: prepared.controlRoot }).selection.revision, binding.selection.revision);
      }
      const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      await fs.writeFile(path.join(run.dir, `${scenario}.png`), Buffer.from(screenshot.data, 'base64'));
      evidence.scenarios.push({ scenario, outcome: 'passed', manifestBytes: Buffer.byteLength(bytes),
        ...(scenario === 'large-manifest' ? { nativeReady: true, composer: true, model: runtimeUiTuple.modelID } : { originalError: true, retry: true }) });
    } finally { await stop(); stop = async () => {}; }
  }
  assert.equal((await loadQaPackagedArtifact({ root, evidencePath: process.argv[2] })).evidence.archiveSha256, evidence.archiveSha256);
  evidence.outcome = 'passed';
} finally {
  await fs.writeFile(path.join(run.dir, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  run.finish(evidence.outcome);
  console.log(JSON.stringify({ output: run.dir, ...evidence }));
}
