// Direct packaged --runtime-service qualification in a repository-owned profile.
// No launchd registration, owner account, provider sign-in or installed app state.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { captureQaSourceIdentity } from './artifact-evidence.mjs';
import { loadQaPackagedArtifact } from './packaged-artifact.mjs';
import { prepareRuntimeUiProfile } from './native-backend-ui-diagnostic.mjs';
import { reservePort, startOwnedProcess } from './process.mjs';
import {
  assertRuntimeServiceDescriptorOwner, readRuntimeProcessStartIdentity, readRuntimeServiceDescriptor, readRuntimeServiceOwner,
} from '../../packages/electron/runtime-service.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function runPackagedServiceSmoke({ packageEvidence, artifactRoot }) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Packaged service qualification requires Darwin ARM64');
  if (!globalThis.Bun) throw new Error('Run the packaged service fixture with pinned Bun');
  const before = await captureQaSourceIdentity(repository);
  const packaged = await loadQaPackagedArtifact({ root: repository, evidencePath: packageEvidence });
  assert.equal(packaged.evidence.source.sha256, before.sha256, 'Package source differs from the candidate');
  const fixtures = path.join(repository, '.cache/test-fixtures');
  assert.equal(await fs.realpath(fixtures), fixtures);
  await fs.mkdir(path.join(repository, '.cache/qa'), { recursive: true, mode: 0o700 });
  const output = await fs.mkdtemp(path.join(repository, '.cache/qa/packaged-service-'));
  const runtimeRoot = await fs.mkdtemp(path.join(fixtures, 'packaged-service-'));
  await fs.chmod(runtimeRoot, 0o700);
  const workspace = path.join(runtimeRoot, 'workspace');
  await fs.mkdir(workspace, { mode: 0o700 });
  execFileSync('git', ['init', '--quiet', workspace], { cwd: repository, env: {
    PATH: process.env.PATH, GIT_CEILING_DIRECTORIES: fixtures,
  } });
  const evidence = { schemaVersion: 1, kind: 'packaged-direct-runtime-service', outcome: 'failed',
    sourceSha256: before.sha256, archiveSha256: packaged.evidence.archiveSha256,
    scope: 'direct headless launch, private owner, loopback refusal, physical shutdown and restart',
    excluded: ['launchd-registration', 'desktop-host-lease', 'paid-providers', 'managed-user', 'three-acceptance-journal-roots'],
    runs: [], cleanupErrors: [] };
  let prepared, app;
  try {
    prepared = await prepareRuntimeUiProfile({ cell: { transport: 'runtime-fixture' }, runtimeRoot, workspace,
      targetGeneration: 2, artifactRoot });
    const dataDirectory = prepared.env.OPENCHAMBER_DATA_DIR;
    const profile = path.join(runtimeRoot, 'profile');
    await fs.mkdir(profile, { mode: 0o700 });
    const settingsPath = path.join(dataDirectory, 'settings.json');
    const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    for (let iteration = 0; iteration < 2; iteration++) {
      const port = await reservePort();
      await fs.writeFile(settingsPath, JSON.stringify({ ...settings, desktopLocalPort: port,
        desktopLanAccessEnabled: false, productionBotsRuntimeMode: 'disabled' }) + '\n', { mode: 0o600 });
      const env = { ...prepared.env, DEVRYAN_QA_RUNTIME: 'electron',
        OPENCHAMBER_ELECTRON_USER_DATA_DIR: profile, OPENCHAMBER_DIST_DIR: packaged.artifactDirectory,
        OPENCHAMBER_PORT: String(port), GIT_CEILING_DIRECTORIES: fixtures };
      delete env.NODE_OPTIONS;
      app = startOwnedProcess(packaged.binary, ['--runtime-service', `--user-data-dir=${profile}`], { cwd: workspace, env });
      const deadline = performance.now() + 90_000;
      let descriptor;
      for (;;) {
        app.check();
        try { descriptor = await readRuntimeServiceDescriptor({ dataDirectory }); } catch { descriptor = null; }
        if (descriptor?.pid === app.child.pid && descriptor.port === port && descriptor.health === 'healthy') break;
        if (performance.now() > deadline) throw new Error('packaged_service_start_timeout');
        await pause(100);
      }
      const owner = await readRuntimeServiceOwner({ dataDirectory });
      assert.equal(owner.state, 'valid');
      assert.equal(owner.owner.mode, 'service');
      assert.equal(owner.owner.pid, app.child.pid);
      assert.equal(owner.owner.instanceId, descriptor.instanceId);
      assert.equal(owner.owner.generation, descriptor.ownerGeneration);
      await assertRuntimeServiceDescriptorOwner({ dataDirectory, descriptor });
      const processIdentity = JSON.parse(await fs.readFile(path.join(dataDirectory, 'runtime-service/owner-process.v1.json'), 'utf8'));
      assert.equal(processIdentity.instanceId, owner.owner.instanceId);
      assert.equal(processIdentity.pid, app.child.pid);
      assert.equal(processIdentity.generation, owner.owner.generation);
      assert.ok(processIdentity.processStartIdentity);
      assert.equal(processIdentity.processStartIdentity, await readRuntimeProcessStartIdentity(app.child.pid));
      assert.equal(descriptor.desktopHost.state, 'unavailable');
      assert.equal(descriptor.appVersion, '2.0.2');
      assert.equal(owner.stat.mode & 0o777, 0o600);
      const base = `http://127.0.0.1:${port}`;
      const request = (url, options) => fetch(base + url, { ...options, signal: AbortSignal.timeout(5_000) });
      const handshake = await request('/api/runtime-service/handshake');
      assert.equal(handshake.status, 401);
      assert.equal((await handshake.json()).code, 'runtime_service_session_required');
      const bootstrap = await request('/auth/runtime-service-bootstrap', { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-devryan-csrf': '1' }, body: JSON.stringify({ token: 'invalid-fixture-token' }) });
      assert.equal(bootstrap.status, 401);
      assert.equal((await bootstrap.json()).code, 'runtime_service_bootstrap_rejected');
      assert.equal((await request('/api/runtime-service/desktop-host', { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-devryan-csrf': '1' }, body: '{}' })).status, 401);
      assert.equal(prepared.evidence.providerRequests.length, 0, 'Headless startup sent a model request without a desktop lease');
      await prepared.verifyInputs();
      const run = { iteration, pid: descriptor.pid, instanceId: descriptor.instanceId, generation: descriptor.ownerGeneration,
        ownerStartIdentity: processIdentity.processStartIdentity, health: descriptor.health, desktopHost: descriptor.desktopHost.state,
        handshakeRefusal: handshake.status, bootstrapRefusal: bootstrap.status, providerRequests: 0 };
      if (iteration) assert.notEqual(run.instanceId, evidence.runs[0].instanceId);
      await app.stop();
      run.cleanup = app.getCleanupEvidence();
      assert.equal(app.child.exitCode, 0);
      assert.equal((await readRuntimeServiceOwner({ dataDirectory })).state, 'missing');
      const stopped = await readRuntimeServiceDescriptor({ dataDirectory });
      assert.equal(stopped.health, 'disabled');
      assert.equal(stopped.instanceId, run.instanceId);
      assert.equal(await readRuntimeProcessStartIdentity(run.pid), null);
      evidence.runs.push(run);
      app = null;
    }
    assert.equal((await captureQaSourceIdentity(repository)).sha256, before.sha256, 'Source changed during service qualification');
    assert.equal((await loadQaPackagedArtifact({ root: repository, evidencePath: packageEvidence })).evidence.archiveSha256,
      packaged.evidence.archiveSha256);
    evidence.outcome = 'passed';
  } catch (error) {
    evidence.error = typeof error.code === 'string' ? error.code : String(error.message).replaceAll(runtimeRoot, '<QA_RUNTIME>');
  } finally {
    if (app) {
      try { await app.stop(); } catch (error) { evidence.cleanupErrors.push(error.code ?? 'owned_service_cleanup_failed'); }
    }
    if (prepared) {
      try { await prepared.close(); } catch (error) { evidence.cleanupErrors.push(error.code ?? 'fixture_provider_cleanup_failed'); }
    }
    if (evidence.cleanupErrors.length) evidence.outcome = 'failed';
    await fs.writeFile(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
    // Retain failure state; successful fixtures contain no account snapshots.
    if (evidence.outcome === 'passed') await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
  return { ...evidence, output };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--package-evidence' || args[2] !== '--artifact-root'
    || !path.isAbsolute(args[1]) || !path.isAbsolute(args[3])) throw new Error('Usage: bun scripts/qa/packaged-service-smoke.mjs --package-evidence <absolute> --artifact-root <absolute>');
  const result = await runPackagedServiceSmoke({ packageEvidence: args[1], artifactRoot: args[3] });
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = result.outcome === 'passed' ? 0 : 1;
}
