import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { captureQaArtifactIdentity, captureQaElectronAppIdentity, captureQaSourceIdentity } from './artifact-evidence.mjs';
import { packageQaElectron } from './package-electron.mjs';
import { createRunRoot } from './run-root.mjs';
import { validateQaMatrixConfig } from './matrix-config.mjs';
import { verifyNativeRuntimeArtifacts } from '../../packages/web/server/lib/opencode/runtime-host/native-artifacts.js';
import { verifyPackageBuildInputs } from '../opencode-v2-native/package-lanes.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Fresh v2-only cells; mobile owns its existing two-theme sweep. */
export function stageFMatrices(evidenceRoot) {
  const cell = (id, runtime, theme, width) => ({ id, runtime, ...(theme ? { theme } : {}),
    ...(width ? { windowSize: { width, height: 800 } } : {}), transport: 'fixture', providerId: 'fixture',
    modelId: 'fixture-model', agent: 'builder', planMode: false, variant: 'high',
    scenarioIds: [theme ? 'core-journey' : 'mobile'], repetitions: 1, timeoutMs: 420000 });
  const wire = { schemaVersion: 1, evidenceRoot: path.join(evidenceRoot, 'wire-g2'), cells: [
    ...['light', 'dark'].flatMap(theme => [cell(`desktop-web-${theme}`, 'web', theme),
      cell(`desktop-electron-1280-${theme}`, 'electron', theme, 1280),
      cell(`desktop-electron-800-${theme}`, 'electron', theme, 800)]), cell('mobile-web-both-themes', 'web'),
  ] };
  const runtime = { schemaVersion: 1, evidenceRoot: path.join(evidenceRoot, 'runtime-g2'),
    cells: [wire.cells[0], wire.cells[1]].map(value => ({ ...value, transport: 'runtime-fixture',
      providerId: 'devryan-smoke', modelId: 'smoke-write' })) };
  validateQaMatrixConfig(wire); validateQaMatrixConfig(runtime);
  return { wire, runtime };
}

/** Preparation only. Every build pin comes from the caller's fresh qualified artifact. */
export async function prepareStageF({ nativeArtifactRoot, nativeManifestSha256, nativeBuildID,
  webDist, webArtifactSha256, nativeSourceApp, nativeSourceAppSha256 }) {
  for (const value of [nativeManifestSha256, nativeBuildID, webArtifactSha256, nativeSourceAppSha256]) assert.ok(validHash(value), 'Explicit fresh artifact pins required');
  const repo = await fs.realpath(repository);
  for (const input of [nativeArtifactRoot, webDist, nativeSourceApp]) {
    assert.equal(await fs.realpath(input), input); assert.ok(input.startsWith(repo + path.sep), 'Stage F inputs must remain repository-owned');
  }
  const verifyNative = async () => {
    const artifacts = await verifyNativeRuntimeArtifacts({ manifestPath: path.join(nativeArtifactRoot, 'native-bundle.json'),
      manifestSha256: nativeManifestSha256, launcher: path.join(nativeArtifactRoot, `DevRyan-execution-${process.platform}-${process.arch}`) });
    assert.equal(artifacts.manifest.buildId, nativeBuildID);
    const linked = await verifyPackageBuildInputs({ manifest: artifacts.manifest });
    return { buildId: nativeBuildID, manifestSha256: nativeManifestSha256, inputCount: linked.inputCount };
  };
  const nativeBefore = await verifyNative(), source = await captureQaSourceIdentity(repo);
  const runner = await captureQaArtifactIdentity(path.join(repo, 'scripts'));
  assert.equal((await captureQaArtifactIdentity(webDist)).sha256, webArtifactSha256);
  assert.equal((await captureQaElectronAppIdentity(nativeSourceApp)).sha256, nativeSourceAppSha256);
  // The prepared web copy and matrices are the deliverable for later Stage F runs; the
  // packaged app lives in its own packaged-electron-* run (rebuildable, pruned by family).
  const run = createRunRoot({ parent: path.join(repo, '.cache/qa'), prefix: 'stage-f-v2-prepared-', owner: 'scripts/qa/stage-f-preparation.mjs', keepOnPass: true });
  const prepared = run.dir;
  try {
    const copy = path.join(prepared, 'web');
    await fs.cp(webDist, copy, { recursive: true, errorOnExist: true, force: false });
    assert.equal((await captureQaArtifactIdentity(copy)).sha256, webArtifactSha256);
    const configs = [];
    for (const [kind, value] of Object.entries(stageFMatrices(prepared))) {
      const file = path.join(prepared, `${kind}-g2-matrix.json`), bytes = JSON.stringify(value, null, 2) + '\n';
      await fs.writeFile(file, bytes, { mode: 0o600, flag: 'wx' });
      configs.push({ kind, generation: 2, path: file, sha256: hash(bytes), cells: value.cells.length, evidenceRoot: value.evidenceRoot });
    }
    const packaged = await packageQaElectron({ webDist: copy, nativeSourceApp });
    assert.equal(packaged.webArtifact.sha256, webArtifactSha256); assert.equal(packaged.packagedWebArtifact.sha256, webArtifactSha256);
    assert.equal(packaged.source.sha256, source.sha256);
    assert.equal((await captureQaElectronAppIdentity(nativeSourceApp)).sha256, nativeSourceAppSha256, 'Electron donor changed during preparation');
    assert.equal((await captureQaSourceIdentity(repo)).sha256, source.sha256, 'Source changed during preparation');
    assert.equal((await captureQaArtifactIdentity(path.join(repo, 'scripts'))).sha256, runner.sha256, 'Runner changed during preparation');
    const nativeAfter = await verifyNative(); assert.deepEqual(nativeAfter, nativeBefore);
    const evidence = { schema: 1, purpose: 'Fresh v2 Stage F preparation; no UI runs', sourceSha256: source.sha256,
      runnerSha256: runner.sha256, webDist: copy, webArtifactSha256, nativeSourceApp, nativeSourceAppSha256,
      nativeArtifactRoot, nativeBefore, nativeAfter, configs, binary: packaged.binary, appPath: packaged.appPath,
      archiveSha256: packaged.archiveSha256, nativeSmoke: packaged.nativeSmoke, uiLaunches: 0,
      requiredProofs: ['empty-history-retained-input', 'lazy-long-details', 'exact-resume-discard', 'attachment-no-fetch',
        'visible-hit-tested-controls', 'no-horizontal-overflow', 'exact-electron-window-geometry'],
      preparationScriptSha256: hash(await fs.readFile(fileURLToPath(import.meta.url))) };
    const manifest = path.join(prepared, 'prepared.json');
    await fs.writeFile(manifest, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    const result = { manifest, manifestSha256: hash(await fs.readFile(manifest)), ...evidence };
    run.finish('passed');
    return result;
  } catch (error) {
    run.finish('failed');
    throw error;
  }
}
