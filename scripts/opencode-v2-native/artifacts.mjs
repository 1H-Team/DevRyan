import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifySessionExecutionLauncher } from '../../packages/harness-runtime/lib/session-execution.js';

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DEFAULT_RG = path.join(repositoryRoot, '.cache/v2-spike/homes/g2-01-seam-smoke/cache/opencode/bin/rg');
export const DEFAULT_LAUNCHER = path.join(repositoryRoot, 'packages/web/runtime/darwin-arm64/DevRyan-execution-darwin-arm64');
export const RG_SHA256 = '2a6f27b8be5df4cc93183328cbe91bb82ce358966f8ecc6f65823ce4f8a0323f';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const hashNativeFixtureValue = value => hash(JSON.stringify(value));

const cohortInputs = [
  'packages/web/server/lib/opencode', 'packages/web/server/index.js', 'packages/web/server/application.js',
  'packages/web/server/lib/multi-user', 'packages/web/server/lib/ui-auth', 'packages/web/server/lib/tunnels',
  'packages/web/server/lib/orchestration',
  'packages/web/server/lib/harness', 'packages/harness-runtime', 'packages/orchestration-runtime', 'packages/shared-runtime',
  'packages/web/server/lib/opencode/session-execution-host.js', 'packages/web/server/lib/opencode/session-revert-coordinator.js',
  'packages/web/server/lib/opencode/harness-task-context.js', 'scripts/opencode-v2-native', 'scripts/verify-opencode-v2-native.mjs',
  'scripts/build-native-runtime.mjs', 'scripts/native-runtime-assets.mjs', 'scripts/native-compaction-observation-transform.mjs',
  'package.json', 'bun.lock',
];
export const captureNativeAcceptanceSource = async () => {
  const files = new Map();
  const visit = async relative => {
    const resolved = await repositoryPath(path.join(repositoryRoot, relative));
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) {
      for (const entry of await fs.readdir(resolved, { withFileTypes: true })) {
        if (['node_modules', '.cache', 'target', 'dist'].includes(entry.name)) continue;
        if (entry.isDirectory() || entry.isFile()) await visit(path.join(relative, entry.name));
        else throw new Error(`Native acceptance source contains a link: ${relative}/${entry.name}`);
      }
    } else if ((relative === 'bun.lock' || /\.(?:[cm]?[jt]s|c|h|rs|json)$/.test(relative)) && !/\.(?:test|spec)\./.test(relative)) {
      files.set(relative, hash(await fs.readFile(resolved)));
    }
  };
  for (const input of cohortInputs) await visit(input);
  const sources = Object.fromEntries([...files].sort(([left], [right]) => left.localeCompare(right)));
  return { sourceDigest: hashNativeFixtureValue(sources), sources };
};

export const repositoryPath = async input => {
  assert.ok(path.isAbsolute(input), 'Native acceptance paths must be absolute');
  const canonical = await fs.realpath(input);
  assert.ok(canonical.startsWith(`${repositoryRoot}${path.sep}`), 'Native acceptance input escaped repository');
  return canonical;
};

const installedTreeDigest = async directory => {
  const files = [];
  const visit = async relative => {
    const current = await repositoryPath(path.join(directory, relative));
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const file = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) files.push([file, hash(await fs.readFile(await repositoryPath(path.join(directory, file))))]);
      else throw new Error(`Unreviewed installed package link: ${file}`);
    }
  };
  await visit('');
  files.sort(([left], [right]) => left.localeCompare(right));
  return hashNativeFixtureValue(files);
};

export const verifyNativeAcceptanceArtifacts = async ({ rg = DEFAULT_RG, launcher = DEFAULT_LAUNCHER } = {}) => {
  assert.equal(process.platform, 'darwin', 'Captured native acceptance requires qualified Darwin');
  assert.equal(process.arch, 'arm64', 'Captured native acceptance requires qualified arm64');
  const [canonicalRg, canonicalLauncher] = await Promise.all([repositoryPath(rg), repositoryPath(launcher)]);
  const rgBytes = await fs.readFile(canonicalRg);
  assert.equal(hash(rgBytes), RG_SHA256, 'Unreviewed ripgrep artifact');
  assert.ok((await fs.stat(canonicalRg)).mode & 0o111, 'Ripgrep is not executable');
  assert.equal(await verifySessionExecutionLauncher({ launcher: canonicalLauncher }), true, 'Accepted native supervisor required');
  const packages = {};
  for (const [name, entry] of [
    ['core', 'dist/tool.js'], ['plugin', 'dist/effect/index.js'], ['schema', 'dist/tool.js'],
    ['sdk', 'dist/index.js'], ['server', 'dist/fetch.js'], ['simulation', 'dist/backend/index.js'], ['util', 'dist/effect/layer-node.js'],
  ]) {
    // These packages publish import-only exports. Inspect their installed
    // manifests without invoking Node's incompatible require conditions.
    let manifest;
    for (const base of ['packages/web/node_modules', 'node_modules']) {
      const directory = path.join(repositoryRoot, base, '@opencode', name);
      const file = path.join(directory, 'package.json');
      const canonicalFile = await repositoryPath(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      const bytes = canonicalFile ? await fs.readFile(canonicalFile) : null;
      if (bytes) {
        const value = JSON.parse(bytes.toString());
        assert.equal(value.name, `@opencode/${name}`);
        const resolved = await repositoryPath(path.join(directory, entry));
        manifest = { name: value.name, version: value.version, manifestSha256: hash(bytes), entrySha256: hash(await fs.readFile(resolved)),
          installedTreeSha256: await installedTreeDigest(directory) };
        if (name === 'simulation') manifest.providerSha256 = hash(await fs.readFile(
          await repositoryPath(path.join(directory, 'dist/backend/simulated-provider.js'))));
        break;
      }
    }
    assert.equal(manifest?.version, '2.0.24', `Native ${name} pin mismatch`);
    packages[name] = manifest;
  }
  const effectDirectory = path.join(repositoryRoot, 'node_modules/effect');
  const effectBytes = await fs.readFile(await repositoryPath(path.join(effectDirectory, 'package.json')));
  const effectManifest = JSON.parse(effectBytes.toString());
  const dependencyPin = JSON.parse(await fs.readFile(path.join(repositoryRoot, 'package.json'), 'utf8')).devDependencies.effect;
  assert.equal(effectManifest.version, dependencyPin, 'Native Effect engine pin mismatch');
  packages.effect = { name: effectManifest.name, version: effectManifest.version, manifestSha256: hash(effectBytes), installedTreeSha256: await installedTreeDigest(effectDirectory) };
  return { rg: canonicalRg, launcher: canonicalLauncher,
    rgSha256: RG_SHA256, launcherSha256: hash(await fs.readFile(canonicalLauncher)), packages };
};
