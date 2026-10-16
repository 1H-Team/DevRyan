import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { captureQaSourceIdentity } from './artifact-evidence.mjs';
import { createRunRoot, removeRunPayloads, scratchParent } from './run-root.mjs';
import { withCrossProcessFileLock } from '../../packages/harness-runtime/lib/atomic-file.js';

const repository = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const paths = ['packages/electron/entry.mjs', 'packages/ui/src/stores/useConfigStore.ts', 'packages/web/server/lib/opencode/runtime-host/runtime-bundle-lifecycle.js'];

export function baselineStartupSources(entry, config, lifecycle) {
  const early = '  if (!service && !probe && !await showEarlyStartupWindow({ app, BrowserWindow, nativeTheme })) return;';
  const overlap = '                            const [, agentsReady] = await Promise.all([\n                                providersReady,\n                                get().loadAgents({ directory, providersReady, signal }),\n                            ]);';
  assert.equal(entry.split(early).length, 2, 'Early-window optimization changed; review baseline transformation');
  assert.equal(config.split(overlap).length, 2, 'Catalog overlap changed; review baseline transformation');
  const reuse = "      const { source: original } = await compatible({ source: current.descriptor, artifacts: launchArtifacts });";
  assert.equal(lifecycle.split(reuse).length, 2, 'Source verification reuse changed; review baseline transformation');
  return [entry.replace(early, '  // Comparison baseline: main creates the same window after its import.'),
    config.replace(overlap, '                            await providersReady;\n                            const agentsReady = await get().loadAgents({ directory, providersReady, signal });'),
    lifecycle.replace(reuse, "      await compatible({ source: current.descriptor, artifacts: launchArtifacts });\n      const original = await verifyLaunch(current.descriptor.launch,'bundle-source');")];
}

/** Restore only the exact variant we wrote; conflicting human edits are preserved. */
export async function restoreStartupSources(root, originals, variants) {
  const conflicts = [];
  for (let index = 0; index < paths.length; index++) {
    const file = path.join(root, paths[index]);
    const current = await fs.readFile(file);
    if (current.equals(originals[index])) continue;
    if (!current.equals(Buffer.from(variants[index]))) { conflicts.push(paths[index]); continue; }
    await fs.writeFile(file, originals[index]);
  }
  assert.deepEqual(conflicts, [], 'Source restoration conflict; original bytes remain in the run sources directory');
}

export async function withStartupBaselineSources({ root, runDirectory, operation, captureIdentity = captureQaSourceIdentity, onRestoreReady = () => {} }) {
  const originals = await Promise.all(paths.map(file => fs.readFile(path.join(root, file))));
  const variants = baselineStartupSources(...originals.map(bytes => bytes.toString('utf8')));
  const before = await captureIdentity(root);
  const expectedEntries = before.entries.map(row => ({ ...row,
    ...(paths.includes(row.file) ? { sha256: digest(variants[paths.indexOf(row.file)]) } : {}) }));
  const expected = digest(JSON.stringify(expectedEntries));
  await fs.mkdir(path.join(runDirectory, 'sources'), { recursive: true, mode: 0o700 });
  for (let index = 0; index < paths.length; index++) await fs.writeFile(path.join(runDirectory, 'sources', path.basename(paths[index])), originals[index], { mode: 0o600 });
  const restore = () => restoreStartupSources(root, originals, variants);
  onRestoreReady(restore);
  try {
    assert.equal((await captureIdentity(root)).sha256, before.sha256, 'Source changed before baseline mutation');
    for (let index = 0; index < paths.length; index++) await fs.writeFile(path.join(root, paths[index]), variants[index]);
    assert.equal((await captureIdentity(root)).sha256, expected, 'Concurrent source change while preparing baseline');
    const result = await operation();
    assert.equal((await captureIdentity(root)).sha256, expected, 'Concurrent source change during baseline build');
    return { result, source: before };
  } finally {
    await restore();
    onRestoreReady(() => Promise.resolve());
  }
}

async function buildWeb(outdir, signal) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['run', '--cwd', 'packages/web', 'build', '--outDir', outdir, '--emptyOutDir'],
      { cwd: repository, stdio: 'inherit', signal });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Comparison web build failed (${code})`)));
  });
}

export async function buildStartupRepairComparison({ artifactRoot, nativeSourceApp, baselineArtifactRoot }) {
  assert.ok(globalThis.Bun && process.platform === 'darwin' && process.arch === 'arm64', 'Run with repository Bun on macOS arm64');
  for (const directory of [artifactRoot, nativeSourceApp, baselineArtifactRoot].filter(value => value !== undefined)) {
    assert.ok(path.isAbsolute(directory) && directory.startsWith(repository + path.sep), 'Comparison inputs must stay inside repository');
    assert.equal(await fs.realpath(directory), directory, 'Comparison inputs must be canonical');
  }
  execFileSync('df', ['-h', '.'], { cwd: repository, stdio: 'inherit' });
  await fs.mkdir(scratchParent('qa'), { recursive: true, mode: 0o700 });
  assert.equal(await fs.realpath(scratchParent('qa')), scratchParent('qa'), 'Comparison cache must not follow a symlink');
  return withCrossProcessFileLock(path.join(repository, '.cache/qa/startup-repair-comparison.lock'), async () => {
    let restore = () => Promise.resolve();
    const abort = new AbortController();
    const run = createRunRoot({ parent: scratchParent('qa'), prefix: 'startup-repair-comparison-',
      owner: 'scripts/qa/startup-repair-comparison.mjs', extraPayloads: ['baseline-web', 'candidate-web', 'sources'],
      onInterrupt: async () => {
        abort.abort();
        try { await restore(); } catch (error) { run.finish('failed'); throw error; }
        for (const output of packages) removeRunPayloads(output, { extra: ['staging', 'app'] });
      } });
    const packages = [];
    const build = async label => {
      abort.signal.throwIfAborted();
      const webDist = path.join(run.dir, `${label}-web`);
      await buildWeb(webDist, abort.signal);
      const { packageQaElectron } = await import('./package-electron.mjs');
      const evidence = await packageQaElectron({ webDist, nativeSourceApp, nativeRuntimeRoot: artifactRoot });
      packages.push(evidence.output);
      return path.join(evidence.output, 'package-evidence.json');
    };
    try {
      const baseline = await withStartupBaselineSources({ root: repository, runDirectory: run.dir,
        operation: () => build('baseline'), onRestoreReady: callback => { restore = callback; } });
      assert.equal((await captureQaSourceIdentity(repository)).sha256, baseline.source.sha256, 'Candidate source changed after restoration');
      const candidate = await build('candidate');
      assert.equal((await captureQaSourceIdentity(repository)).sha256, baseline.source.sha256, 'Concurrent source change during candidate build');
      const { runNativeStartupComparison } = await import('./native-startup-benchmark.mjs');
      const result = await runNativeStartupComparison({ baselinePackageEvidence: baseline.result,
        candidatePackageEvidence: candidate, artifactRoot, ...(baselineArtifactRoot ? { baselineArtifactRoot } : {}) });
      await fs.writeFile(path.join(run.dir, 'comparison.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
      run.finish(result.outcome === 'passed' ? 'passed' : 'failed');
      return { evidence: path.join(run.dir, 'comparison.json'), result };
    } catch (error) { run.finish('failed'); throw error; }
    finally {
      try { await restore(); } finally {
        for (const output of packages) removeRunPayloads(output, { extra: ['staging', 'app'] });
      }
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert.ok([4, 6].includes(args.length) && args[0] === '--artifact-root' && args[2] === '--native-source-app'
    && (args.length === 4 || args[4] === '--baseline-artifact-root'),
    'Usage: bun scripts/qa/startup-repair-comparison.mjs --artifact-root <absolute> --native-source-app <absolute> [--baseline-artifact-root <absolute>]');
  const output = await buildStartupRepairComparison({ artifactRoot: args[1], nativeSourceApp: args[3], ...(args.length === 6 ? { baselineArtifactRoot: args[5] } : {}) });
  console.log(JSON.stringify(output));
  if (output.result.outcome !== 'passed' || output.result.summary?.accepted !== true) process.exitCode = 1;
}
