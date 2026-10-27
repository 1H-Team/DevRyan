import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBrowserLeaseRuntime } from '../../packages/web/server/lib/browser-cdp/lease-runtime.js';
import { readNativeBrowserAssets } from '../../packages/web/server/lib/opencode/runtime-host/native-browser-assets.js';
import { createDiagnosticSanitizer } from '../../packages/harness-runtime/lib/sanitizer.js';
import { createQaHostLaunchEnvironment } from '../qa/launch-environment.mjs';
import { startOwnedProcess } from '../qa/process.mjs';
import { captureQaSourceIdentity } from '../qa/artifact-evidence.mjs';
import { waitFor } from './process-lanes.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
/** Actual Electron surface/bridge and original Rust CLI; model decisions remain fixture data. */
export async function createCompiledBrowserLane({ root, client, installRoot = path.join(repository, '.cache/browser-upgrade/current') }) {
  root = await fs.realpath(root); installRoot = await fs.realpath(installRoot);
  assert.ok(root.startsWith(repository + path.sep) && installRoot.startsWith(repository + path.sep));
  const environment = { DEVRYAN_AGENT_BROWSER_BIN: path.join(installRoot, 'node_modules/agent-browser/bin', `agent-browser-${process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`) };
  const assets = await readNativeBrowserAssets(environment);
  assert.ok(assets);
  const source = await captureQaSourceIdentity(repository);
  const home = path.join(root, 'browser-host'); await fs.mkdir(home, { mode: 0o700 });
  const certificateConfig = path.join(home, 'preview.cnf'), certificate = path.join(home, 'preview.pem'), key = path.join(home, 'preview-key.pem');
  await fs.writeFile(certificateConfig, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1\n', { mode: 0o600 });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', certificateConfig, '-keyout', key, '-out', certificate], { stdio: 'ignore' });
  await fs.chmod(key, 0o600);
  const token = randomBytes(32).toString('hex');
  const require = createRequire(new URL('../../packages/electron/package.json', import.meta.url));
  const child = startOwnedProcess(require('electron'), [fileURLToPath(new URL('./package-browser-host.mjs', import.meta.url))], {
    cwd: repository, env: createQaHostLaunchEnvironment({ HOME: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home,
      XDG_STATE_HOME: home, XDG_CACHE_HOME: home, TMPDIR: home,
      DEVRYAN_PACKAGE_BROWSER_ROOT: home, DEVRYAN_PACKAGE_BROWSER_TOKEN: token }) });
  const sanitizer = createDiagnosticSanitizer({ homeDir: home, knownSecrets: [token] });
  let runtime, origin, previewOrigin, closing;
  const close = () => closing ??= (async () => {
    const failures = [];
    try { await runtime?.closeAll(); } catch (error) { failures.push(error); }
    try { await child.stop(); } catch (error) { failures.push(error); }
    const cleanup = child.getCleanupEvidence();
    const after = await captureQaSourceIdentity(repository);
    await fs.writeFile(path.join(root, 'browser-host.log'), sanitizer.sanitizeText(child.getLog()), { mode: 0o600 });
    await fs.writeFile(path.join(root, 'browser-host-cleanup.json'), JSON.stringify(cleanup, null, 2), { mode: 0o600 });
    await fs.writeFile(path.join(root, 'browser-source.json'), JSON.stringify({ before: source, after, unchanged: source.sha256 === after.sha256 }, null, 2), { mode: 0o600 });
    if (source.sha256 !== after.sha256) failures.push(Error('Browser qualification production source changed'));
    if (failures.length) throw new AggregateError(failures, 'Compiled browser owner cleanup failed');
    return cleanup;
  })();
  try {
    ({ origin, previewOrigin } = await waitFor(async () => { child.check(); try { return JSON.parse(await fs.readFile(path.join(home, 'ready.json'), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; } }, value => Boolean(value?.origin), 'Owned Electron browser did not become ready', 30000));
    const url = new URL(origin); assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1'); assert.ok(url.port);
    const preview = new URL(previewOrigin); assert.equal(preview.protocol, 'https:'); assert.equal(preview.hostname, '127.0.0.1'); assert.ok(preview.port);
    const request = async (action, input = {}) => {
      child.check(); const response = await fetch(origin + '/' + action, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
        body: JSON.stringify(input), signal: AbortSignal.timeout(10000) });
      assert.equal(response.status, 200, 'Electron qualification operation failed'); return response.json();
    };
    runtime = createBrowserLeaseRuntime({ openCodeClient: client,
      createBrowserLease: ({ leaseId, metadata }) => request('create', { leaseId, metadata }),
      touchBrowserLease: input => request('touch', input), releaseBrowserLease: input => request('release', input),
      resolveBrowserLeaseContext: async () => ({ metadata: { previewUrl: previewOrigin + '/fixture' } }) });
    return { environment, runtime,
      run: async ({ invoke, directory }) => {
        const call = await invoke({ id: 'compiled-original-browser', tool: 'devryan_browser', input: { command: 'sequence', steps: [
          { command: 'open' }, { command: 'snapshot', args: ['-i'] }, { command: 'fill', args: ['#name', 'Native browser verified'] },
          { command: 'click', args: ['#save'] }, { command: 'eval', args: ['document.querySelector("#result").textContent'] },
          { command: 'screenshot' }, { command: 'close' },
        ] } });
        const publicationMarker = '\n\nPublished browser files: ', publicationAt = call.state.output.indexOf(publicationMarker);
        assert.ok(publicationAt > 0, 'Compiled browser omitted its publication evidence');
        const output = JSON.parse(call.state.output.slice(0, publicationAt));
        assert.equal(output.results.length, 7); assert.match(output.results[1].output, /Name|Save/);
        assert.match(output.results[4].output, /Native browser verified/);
        const screenshotDirectory = path.join(directory, '.devryan-browser');
        const files = (await fs.readdir(screenshotDirectory)).filter(file => file.endsWith('.png')); assert.equal(files.length, 1);
        assert.equal(call.state.output.slice(publicationAt + publicationMarker.length), path.join(screenshotDirectory, files[0]) + '.');
        assert.deepEqual(call.state.metadata.browserArtifacts, [path.join(screenshotDirectory, files[0])]);
        const bytes = await fs.readFile(path.join(screenshotDirectory, files[0]));
        assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])); assert.ok(bytes.length > 100);
        const screenshot = path.join(root, 'compiled-browser.png'); await fs.writeFile(screenshot, bytes, { mode: 0o600 });
        const state = await request('status'); assert.equal(state.leaseCount, 0); assert.equal(state.created.length, 1);
        assert.deepEqual(state.released, state.created); assert.ok(state.touches > 0); assert.equal(state.blocked, 0);
        assert.equal(runtime.getSnapshot().length, 0);
        return { id: 'compiled-browser-electron-publication', status: 'passed', source: 'original-rust-cli-production-electron-bridge-and-surface-real-writer-publication',
          versions: state.versions, leasesCreated: state.created.length, leasesReleased: state.released.length,
          browserSha256: assets.sha256, sourceSha256: source.sha256, screenshot, screenshotSha256: createHash('sha256').update(bytes).digest('hex') };
      },
      close,
    };
  } catch (cause) {
    try { await close(); } catch (cleanup) { throw new AggregateError([cause, cleanup], 'Compiled browser startup and cleanup failed'); }
    throw cause;
  }
}
