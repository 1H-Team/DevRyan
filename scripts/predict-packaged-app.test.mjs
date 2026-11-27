import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPackagedAppConfig } from './check-packaged-app.mjs';
import packagedAppConfig from './packaged-app.config.mjs';
import { CALIBRATED_BUILDER_VERSION, FAILING_SIZE_KEYS, checkPrediction, formatPredictionReport, loadBuilder, predictPackagedApp } from './predict-packaged-app.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronDir = path.join(repositoryRoot, 'packages', 'electron');
// The prediction reads the installed tree that this lockfile pins: a lockfile-only
// change (a transitive or in-range electron-builder bump) must run these tests.
const lockfile = path.join(repositoryRoot, 'bun.lock');
const builder = loadBuilder(electronDir);
const shippedBuild = JSON.parse(await readFile(path.join(electronDir, 'package.json'), 'utf8')).build;
// The shipped build.files exclusions, applied to every fixture app.
const shippedExclusions = shippedBuild.files.filter((pattern) => pattern.startsWith('!'));
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

const write = async (root, files) => {
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, typeof contents === 'string' || Buffer.isBuffer(contents) ? contents : JSON.stringify(contents));
  }
};

const manifest = (name, version, extra = {}) => ({ name, version, main: 'index.js', ...extra });

/** A fixture app: package.json with `build`, its own files and a hoisted node_modules tree. */
const createApp = async ({ dependencies = {}, files = ['main.mjs'], exclusions = shippedExclusions, tree = {}, extra = {}, build = {} }) => {
  const root = await mkdtemp(path.join(tmpdir(), 'devryan-predict-app-'));
  temporaryDirectories.push(root);
  const appDir = path.join(root, 'app');
  const metadata = {
    ...manifest('fixture-app', '1.0.0', { type: 'module', main: 'main.mjs', author: 'Fixture' }),
    dependencies,
    build: {
      productName: 'Fixture',
      files: [...files, ...exclusions],
      directories: { buildResources: 'resources/icons', output: 'dist' },
      asarUnpack: ['node_modules/unpacked-by-config/**'],
      mac: { extraResources: [{ from: 'resources/extra', to: 'extra' }] },
      ...build,
    },
  };
  await write(root, { 'package.json': { name: 'fixture-workspace', private: true, workspaces: ['app'] } });
  await write(appDir, { 'package.json': metadata, 'main.mjs': 'export {};\n', 'resources/extra/data.bin': Buffer.alloc(100), ...extra });
  await write(appDir, tree);
  return { appDir, root, metadata };
};

const predict = ({ appDir, root, metadata }) => predictPackagedApp({ electronDir: appDir, workspaceRoot: root, metadata, builder });
const config = (overrides = {}) => ({
  ...packagedAppConfig,
  baseline: { resourcesBytes: 1_000_000_000, asarBytes: 1_000_000_000, unpackedBytes: 1_000_000_000 },
  ceiling: { resourcesBytes: 1_000_000_000, asarBytes: 1_000_000_000, unpackedBytes: 1_000_000_000 },
  ...overrides,
});
const violationsById = (verdict) => Object.fromEntries(verdict.violations.map((violation) => [violation.id, violation.paths]));

describe('predicted packaged app content', () => {
  it('fails on a forbidden file that build.files keeps', async () => {
    const app = await createApp({
      dependencies: { lib: '1.0.0' },
      exclusions: [],
      tree: { 'node_modules/lib/package.json': manifest('lib', '1.0.0'), 'node_modules/lib/index.js': '', 'node_modules/lib/index.js.map': '{}' },
    });
    const verdict = checkPrediction(await predict(app), config());
    assert.equal(verdict.ok, false);
    assert.deepEqual(violationsById(verdict), { 'source-map': ['app.asar/node_modules/lib/index.js.map'] });
    assert.match(formatPredictionReport(await predict(app), verdict), /\[source-map\] 1 forbidden file\(s\) would be packaged/);
  });

  it('passes when the shipped exclusions drop the forbidden file', async () => {
    const app = await createApp({
      dependencies: { lib: '1.0.0' },
      tree: { 'node_modules/lib/package.json': manifest('lib', '1.0.0'), 'node_modules/lib/index.js': '', 'node_modules/lib/index.js.map': '{}' },
    });
    const prediction = await predict(app);
    const verdict = checkPrediction(prediction, config());
    assert.equal(verdict.ok, true, formatPredictionReport(prediction, verdict));
    assert.ok(prediction.checkedPaths.includes('app.asar/node_modules/lib/index.js'));
    assert.ok(prediction.checkedPaths.includes('app.asar/main.mjs'));
    assert.ok(prediction.checkedPaths.includes('extra/data.bin'));
    assert.ok(!prediction.checkedPaths.some((checkedPath) => checkedPath.endsWith('.map')));
  });

  it('honours the shipped exclusions for nested dependencies', async () => {
    // Two node-gyp versions: one is hoisted, the other stays nested under its parent.
    const tree = {
      'node_modules/node-gyp/package.json': manifest('node-gyp', '2.0.0'), 'node_modules/node-gyp/index.js': '',
      'node_modules/parent/package.json': manifest('parent', '1.0.0', { dependencies: { 'node-gyp': '1.0.0' } }),
      'node_modules/parent/index.js': '',
      'node_modules/parent/node_modules/node-gyp/package.json': manifest('node-gyp', '1.0.0', { dependencies: { leaf: '1.0.0' } }),
      'node_modules/parent/node_modules/node-gyp/index.js': '',
      'node_modules/parent/node_modules/node-gyp/lib/util.js.map': '{}',
      'node_modules/leaf/package.json': manifest('leaf', '1.0.0'), 'node_modules/leaf/index.js': '', 'node_modules/leaf/src/index.ts': '',
    };
    const dependencies = { parent: '1.0.0', 'node-gyp': '2.0.0' };
    const unexcluded = checkPrediction(await predict(await createApp({ dependencies, tree, exclusions: [] })), config());
    const buildTool = violationsById(unexcluded)['build-tool'];
    assert.ok(buildTool.includes('app.asar/node_modules/node-gyp/index.js'), buildTool.join('\n'));
    assert.ok(buildTool.includes('app.asar/node_modules/parent/node_modules/node-gyp/index.js'), buildTool.join('\n'));
    assert.deepEqual(violationsById(unexcluded)['typescript-source'], ['app.asar/node_modules/leaf/src/index.ts']);

    const prediction = await predict(await createApp({ dependencies, tree }));
    const verdict = checkPrediction(prediction, config());
    assert.equal(verdict.ok, true, formatPredictionReport(prediction, verdict));
    assert.ok(!prediction.checkedPaths.some((checkedPath) => checkedPath.includes('node-gyp')), 'node-gyp is excluded wherever it is placed');
    assert.ok(prediction.checkedPaths.includes('app.asar/node_modules/leaf/index.js'), 'a dependency of an excluded module is still collected');
    assert.ok(prediction.checkedPaths.includes('app.asar/node_modules/parent/index.js'));
  });

  it('keeps only the target\'s platform packages and reports target packages this host lacks', async () => {
    const platformPackage = (name, os, cpu) => ({
      [`node_modules/${name}/package.json`]: manifest(name, '1.0.0', { os: [os], cpu: [cpu] }),
      [`node_modules/${name}/tool.node`]: Buffer.alloc(64),
    });
    const tree = {
      'node_modules/tool/package.json': manifest('tool', '1.0.0', { optionalDependencies: {
        '@scope/tool-darwin-arm64': '1.0.0', '@scope/tool-darwin-x64': '1.0.0', '@scope/tool-linux-x64': '1.0.0', '@scope/tool-win32-x64': '1.0.0',
      } }),
      'node_modules/tool/index.js': '',
      // The packaging host installs every darwin arch; a Linux CI host installs its own.
      ...platformPackage('@scope/tool-darwin-arm64', 'darwin', 'arm64'),
      ...platformPackage('@scope/tool-darwin-x64', 'darwin', 'x64'),
      ...platformPackage('@scope/tool-linux-x64', 'linux', 'x64'),
      'node_modules/other/package.json': manifest('other', '1.0.0', { optionalDependencies: { 'other-darwin-arm64': '1.0.0', 'other-linux-x64': '1.0.0' } }),
      'node_modules/other/index.js': '',
    };
    const dependencies = { tool: '1.0.0', other: '1.0.0' };
    const prediction = await predict(await createApp({ dependencies, tree }));
    const verdict = checkPrediction(prediction, config());
    assert.equal(verdict.ok, true, formatPredictionReport(prediction, verdict));
    assert.ok(prediction.checkedPaths.includes('app.asar.unpacked/node_modules/@scope/tool-darwin-arm64/tool.node'), 'native target packages are unpacked whole');
    assert.ok(prediction.checkedPaths.includes('app.asar.unpacked/node_modules/@scope/tool-darwin-arm64/package.json'));
    assert.ok(!prediction.checkedPaths.some((checkedPath) => /tool-(?:darwin-x64|linux-x64|win32)/.test(checkedPath)), prediction.checkedPaths.join('\n'));
    assert.deepEqual(prediction.droppedForeignPlatform, ['node_modules/@scope/tool-linux-x64']);
    assert.deepEqual(prediction.notInstalled, ['other-darwin-arm64']);
    assert.ok(prediction.lowerBound.unpackedBytes.includes('other-darwin-arm64 not installed'));

    // Without the arch exclusions the other macOS arch ships.
    const unexcluded = checkPrediction(await predict(await createApp({ dependencies, tree, exclusions: [] })), config());
    assert.deepEqual(violationsById(unexcluded), { 'foreign-native': [
      'app.asar.unpacked/node_modules/@scope/tool-darwin-x64/package.json',
      'app.asar.unpacked/node_modules/@scope/tool-darwin-x64/tool.node',
    ] });
  });
});

const sizedApp = () => createApp({
  dependencies: { lib: '1.0.0', 'unpacked-by-config': '1.0.0' },
  tree: {
    'node_modules/lib/package.json': manifest('lib', '1.0.0'), 'node_modules/lib/index.js': 'x'.repeat(5000),
    'node_modules/unpacked-by-config/package.json': manifest('unpacked-by-config', '1.0.0'),
    'node_modules/unpacked-by-config/index.js': 'y'.repeat(3000),
  },
});

describe('predicted packaged app sizes', () => {
  it('splits packed, unpacked and Resources bytes the way the packaged check measures them', async () => {
    const prediction = await predict(await sizedApp());
    const { sizes } = prediction;
    assert.ok(prediction.checkedPaths.includes('app.asar.unpacked/node_modules/unpacked-by-config/index.js'));
    assert.ok(sizes.unpackedBytes >= 3000 && sizes.unpackedBytes < 3200, String(sizes.unpackedBytes));
    // The asar holds the header, main.mjs, package.json and lib.
    assert.ok(sizes.asarBytes > 5000 + 16 + prediction.headerLength, String(sizes.asarBytes));
    assert.equal(sizes.resourcesBytes, sizes.asarBytes + sizes.unpackedBytes + 100);
    // No Electron install for the fixture: Resources is a lower bound.
    assert.ok(prediction.lowerBound.resourcesBytes.some((reason) => reason.includes('Electron.app')));
  });

  it('fails each failing size over its ceiling, a lower bound included', async () => {
    assert.deepEqual([...FAILING_SIZE_KEYS].sort(), ['asarBytes', 'resourcesBytes', 'unpackedBytes']);
    const prediction = await predict(await sizedApp());
    const ceiling = { resourcesBytes: prediction.sizes.resourcesBytes - 1, asarBytes: prediction.sizes.asarBytes - 1, unpackedBytes: prediction.sizes.unpackedBytes - 1 };
    const verdict = checkPrediction(prediction, config({ baseline: ceiling, ceiling }));
    assert.equal(verdict.ok, false);
    assert.deepEqual(verdict.oversized, ['resourcesBytes', 'asarBytes', 'unpackedBytes']);
    assert.match(formatPredictionReport(prediction, verdict), /resourcesBytes ~\d+ \(.*\) \/ ceiling .*: over ceiling \(lower bound: Electron\.app base resources/);

    const exact = { resourcesBytes: prediction.sizes.resourcesBytes, asarBytes: prediction.sizes.asarBytes, unpackedBytes: prediction.sizes.unpackedBytes };
    assert.equal(checkPrediction(prediction, config({ baseline: exact, ceiling: exact })).ok, true);
    // A size left out of the failing set is printed, never failed.
    const informational = checkPrediction(prediction, config({ baseline: ceiling, ceiling }), { failingSizeKeys: ['asarBytes'] });
    assert.deepEqual(informational.oversized, ['asarBytes']);
    assert.deepEqual(informational.informational, ['resourcesBytes', 'unpackedBytes']);
  });
});

describe('predicted packaged app inputs', () => {
  it('reports an extraResources source whose filter selects nothing as a missing input', async () => {
    // Like ../web/runtime without darwin-arm64: the directory exists for its reviewed inputs.
    const app = await createApp({
      extra: { 'runtime/reviewed-inputs/manifest.json': '{}' },
      build: { mac: { extraResources: [{ from: 'resources/extra', to: 'extra' }, { from: 'runtime', to: 'revert-runtime', filter: ['darwin-arm64/native-bundle.json', 'darwin-arm64/DevRyan-*'] }] } },
    });
    const prediction = await predict(app);
    const verdict = checkPrediction(prediction, config());
    assert.equal(verdict.ok, true);
    const missing = prediction.lowerBound.resourcesBytes.find((reason) => reason.startsWith('extraResources app/runtime'));
    assert.ok(missing, prediction.lowerBound.resourcesBytes.join('\n'));
    assert.match(missing, /darwin-arm64\/native-bundle\.json.*not built/);
    assert.deepEqual(prediction.lowerBound.asarBytes, []);
    // The bound is stated on the size line itself, not only further down.
    const report = formatPredictionReport(prediction, verdict);
    assert.match(report, /resourcesBytes ~\d+ .*: ok \(lower bound: .*extraResources app\/runtime/);
    assert.match(report, /asarBytes ~\d+ .*: ok\n/);
  });

  it('counts only git-tracked files and known build outputs from the repository', async () => {
    const app = await createApp({ files: ['main.mjs', 'lib/**'], extra: { 'lib/tracked.js': 'a'.repeat(10), 'lib/stray.js': 'b'.repeat(4000) } });
    const git = (...args) => execFileSync('git', args, { cwd: app.root, stdio: 'ignore' });
    git('init', '-q');
    git('add', 'app/package.json', 'app/main.mjs', 'app/lib/tracked.js');
    const prediction = await predict(app);
    assert.ok(prediction.checkedPaths.includes('app.asar/lib/tracked.js'));
    assert.ok(!prediction.checkedPaths.includes('app.asar/lib/stray.js'), 'an untracked file is not in a clean checkout');
    assert.deepEqual(prediction.untracked, { files: 1, bytes: 4000 });
    assert.match(formatPredictionReport(prediction, checkPrediction(prediction, config())), /left out as untracked repository files: 1/);
  });

  it('refuses an app-builder-lib other than the calibrated one', () => {
    assert.equal(builder.version, CALIBRATED_BUILDER_VERSION);
    assert.throws(() => loadBuilder(electronDir, { calibratedVersion: '0.0.0-other' }),
      new RegExp(`app-builder-lib ${CALIBRATED_BUILDER_VERSION.replaceAll('.', '\\.')} is installed but .* calibrated against 0\\.0\\.0-other: re-calibrate against a dry run`));
  });

  it('breaks the sizes down so that the parts add up to the totals', async () => {
    const prediction = await predict(await sizedApp());
    const total = (prefix) => prediction.breakdown.filter((row) => row.path.startsWith(prefix)).reduce((sum, row) => sum + row.bytes, 0);
    assert.equal(total('app.asar/') + total('app.asar (header)'), prediction.sizes.asarBytes);
    assert.equal(total('app.asar.unpacked/'), prediction.sizes.unpackedBytes);
    assert.equal(prediction.breakdown.reduce((sum, row) => sum + row.bytes, 0), prediction.sizes.resourcesBytes);
    assert.match(formatPredictionReport(prediction, checkPrediction(prediction, config()), { verbose: true }), /breakdown[^\n]*\n(?:.*\n)*\s+app\.asar\.unpacked\/node_modules\/unpacked-by-config\s+\d+\s+2\n/);
  });
});

describe('predicted packaged app for the installed tree', () => {
  it('has no forbidden content and fits the ceilings', async (t) => {
    await readFile(lockfile, 'utf8');
    const prediction = await predictPackagedApp({ builder });
    const verdict = checkPrediction(prediction, await loadPackagedAppConfig());
    // Sizes with unseen inputs say "lower bound: …" on their own line here too.
    t.diagnostic(formatPredictionReport(prediction, verdict).trimEnd());
    assert.equal(verdict.ok, true, formatPredictionReport(prediction, verdict));
    assert.ok(prediction.counts.packed > 1000 && prediction.counts.unpacked > 100, 'the dependency tree was collected');
    assert.ok(prediction.checkedPaths.includes('app.asar/package.json'));
    assert.ok(prediction.checkedPaths.some((checkedPath) => checkedPath.startsWith('app.asar.unpacked/node_modules/@devryan/web/server/')));
  });
});
