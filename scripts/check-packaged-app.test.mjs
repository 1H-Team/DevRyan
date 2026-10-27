import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  checkPackagedApp,
  formatPackagedAppReport,
  listAsarFiles,
  loadPackagedAppConfig,
  readAsarHeader,
  validatePackagedAppConfig,
} from './check-packaged-app.mjs';
import packagedAppConfig from './packaged-app.config.mjs';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

/** Writes an asar the way @electron/asar does: size pickle, header pickle, then file bytes. */
const asarBytes = (header, contents = Buffer.alloc(0)) => {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const padded = Math.ceil(json.length / 4) * 4;
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(padded + 8, 4);
  prefix.writeUInt32LE(padded + 4, 8);
  prefix.writeUInt32LE(json.length, 12);
  return Buffer.concat([prefix, json, Buffer.alloc(padded - json.length), contents]);
};

const createApp = async ({ asar, resources = {} }) => {
  const root = await mkdtemp(path.join(tmpdir(), 'devryan-packaged-app-'));
  temporaryDirectories.push(root);
  const appPath = path.join(root, 'DevRyan.app');
  const resourcesRoot = path.join(appPath, 'Contents', 'Resources');
  await mkdir(resourcesRoot, { recursive: true });
  await writeFile(path.join(resourcesRoot, 'app.asar'), asarBytes(asar));
  for (const [relativePath, contents] of Object.entries(resources)) {
    const filePath = path.join(resourcesRoot, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents);
  }
  return appPath;
};

const file = (size, extra = {}) => ({ size, offset: '0', ...extra });
const config = (overrides = {}) => ({
  ...packagedAppConfig,
  baseline: { resourcesBytes: 10_000, asarBytes: 10_000, unpackedBytes: 10_000 },
  ceiling: { resourcesBytes: 10_000, asarBytes: 10_000, unpackedBytes: 10_000 },
  ...overrides,
});

describe('asar header', () => {
  it('reads nested entries, unpacked flags and skips links', async () => {
    const appPath = await createApp({
      asar: { files: {
        'package.json': file(20),
        node_modules: { files: {
          a: { files: { 'index.js': file(5), 'native.node': file(7, { unpacked: true }) } },
          b: { link: 'node_modules/a' },
        } },
      } },
    });
    const files = listAsarFiles(readAsarHeader(path.join(appPath, 'Contents', 'Resources', 'app.asar')));
    assert.deepEqual(files, [
      { path: 'package.json', size: 20, unpacked: false },
      { path: 'node_modules/a/index.js', size: 5, unpacked: false },
      { path: 'node_modules/a/native.node', size: 7, unpacked: true },
    ]);
  });

  it('rejects a file that is not an asar archive', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'devryan-packaged-app-'));
    temporaryDirectories.push(root);
    const archive = path.join(root, 'app.asar');
    await writeFile(archive, Buffer.from('not an asar archive at all'));
    assert.throws(() => readAsarHeader(archive), /invalid asar header/);
  });
});

describe('packaged app check', () => {
  it('passes a clean app and reports sizes', async () => {
    const appPath = await createApp({
      asar: { files: { 'main.mjs': file(10), node_modules: { files: { w: { files: { 'run.js': file(3, { unpacked: true }) } } } } } },
      resources: { 'app.asar.unpacked/node_modules/w/run.js': 'abc', 'web-dist/index.html': '<html>' },
    });
    const report = checkPackagedApp({ appPath, config: config() });
    assert.equal(report.ok, true, formatPackagedAppReport(report));
    assert.equal(report.sizes.unpackedBytes, 3);
    assert.ok(report.sizes.asarBytes > 16);
    assert.equal(report.sizes.resourcesBytes, report.sizes.asarBytes + 3 + 6);
    assert.deepEqual(report.violations, []);
  });

  it('fails on every forbidden pattern, inside the asar and in the unpacked tree', async () => {
    const appPath = await createApp({
      asar: { files: { resources: { files: { 'web-dist': { files: { 'index.html': file(1) } } } }, node_modules: { files: {
        effect: { files: { 'index.js.map': file(1), src: { files: { 'index.ts': file(1), 'types.d.mts': file(1) } } } },
        zod: { files: { __tests__: { files: { 'helper.js': file(1) } }, 'index.spec.js': file(1) } },
        'better-sqlite3': { files: { deps: { files: { 'sqlite3.c': file(1) } }, build: { files: { Release: { files: { obj: { files: { 'sqlite3.o': file(1) } } } } } } } },
      } } } },
      resources: {
        'app.asar.unpacked/node_modules/@devryan/web/server/app.test.js': '',
        'app.asar.unpacked/node_modules/@devryan/web/dist/index.html': '',
        'app.asar.unpacked/node_modules/@devryan/web/runtime/reviewed-inputs/manifest.json': '',
        'app.asar.unpacked/node_modules/tree-sitter-bash/prebuilds/linux-x64/tree-sitter-bash.node': '',
      },
    });
    const report = checkPackagedApp({ appPath, config: config() });
    assert.equal(report.ok, false);
    assert.deepEqual(Object.fromEntries(report.violations.map((violation) => [violation.id, violation.paths])), {
      'source-map': ['app.asar/node_modules/effect/index.js.map'],
      'test-file': [
        'app.asar.unpacked/node_modules/@devryan/web/server/app.test.js',
        'app.asar/node_modules/zod/__tests__/helper.js',
        'app.asar/node_modules/zod/index.spec.js',
      ],
      'typescript-source': ['app.asar/node_modules/effect/src/index.ts', 'app.asar/node_modules/effect/src/types.d.mts'],
      'native-build-leftover': ['app.asar/node_modules/better-sqlite3/build/Release/obj/sqlite3.o', 'app.asar/node_modules/better-sqlite3/deps/sqlite3.c'],
      'linux-prebuild': ['app.asar.unpacked/node_modules/tree-sitter-bash/prebuilds/linux-x64/tree-sitter-bash.node'],
      'shell-source-tree': ['app.asar/resources/web-dist/index.html'],
      'duplicate-web-dist': ['app.asar.unpacked/node_modules/@devryan/web/dist/index.html'],
      'duplicate-native-runtime': ['app.asar.unpacked/node_modules/@devryan/web/runtime/reviewed-inputs/manifest.json'],
    });
    assert.match(formatPackagedAppReport(report), /\[duplicate-web-dist\] 1 forbidden file/);
  });

  it('keeps runtime files whose names only resemble forbidden ones', async () => {
    const appPath = await createApp({
      asar: { files: { node_modules: { files: { x: { files: {
        'sourcemap.js': file(1), 'testing.js': file(1), 'contest.js': file(1), 'tests.json': file(1), 'types.tsbuildinfo.json': file(1),
        'binding.cjs': file(1), 'header.html': file(1),
      } } } } } },
      resources: {
        'app.asar.unpacked/node_modules/@devryan/web/server/lib/opencode/runtime-host/native-artifacts.js': '',
        'app.asar.unpacked/node_modules/tree-sitter-bash/prebuilds/darwin-arm64/tree-sitter-bash.node': '',
        'app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node': '',
      },
    });
    const report = checkPackagedApp({ appPath, config: config() });
    assert.deepEqual(report.violations, []);
  });

  it('fails on natives of the other macOS arch and of Windows, for the app\'s own arch', async () => {
    const resources = Object.fromEntries([
      'app.asar.unpacked/node_modules/@cursor/sdk-darwin-arm64/bin/rg',
      'app.asar.unpacked/node_modules/@cursor/sdk-darwin-x64/bin/rg',
      'app.asar.unpacked/node_modules/@esbuild/darwin-x64/bin/esbuild',
      'app.asar.unpacked/node_modules/@parcel/watcher-win32-x64/watcher.node',
      'app.asar.unpacked/node_modules/node-pty/bin/darwin-arm64-145/node-pty.node',
      'app.asar.unpacked/node_modules/node-pty/bin/darwin-x64-145/node-pty.node',
      'app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/pty.node',
      'app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-x64/pty.node',
      'app.asar.unpacked/node_modules/tree-sitter-bash/prebuilds/win32-arm64/tree-sitter-bash.node',
      // Names that only mention a platform are runtime code.
      'app.asar.unpacked/node_modules/@devryan/web/server/lib/win32-paths.js',
      'app.asar.unpacked/node_modules/node-pty/lib/windowsPtyAgent.js',
      'revert-runtime/darwin-arm64/native-bundle.json',
    ].map((resourcePath) => [resourcePath, '']));
    const appPath = await createApp({ asar: { files: { 'main.mjs': file(1) } }, resources });
    const foreign = (arch) => checkPackagedApp({ appPath, arch, config: config() }).violations;
    assert.deepEqual(foreign('arm64'), [{ id: 'foreign-native', paths: [
      'app.asar.unpacked/node_modules/@cursor/sdk-darwin-x64/bin/rg',
      'app.asar.unpacked/node_modules/@esbuild/darwin-x64/bin/esbuild',
      'app.asar.unpacked/node_modules/@parcel/watcher-win32-x64/watcher.node',
      'app.asar.unpacked/node_modules/node-pty/bin/darwin-x64-145/node-pty.node',
      'app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-x64/pty.node',
      'app.asar.unpacked/node_modules/tree-sitter-bash/prebuilds/win32-arm64/tree-sitter-bash.node',
    ] }]);
    assert.deepEqual(foreign('x64'), [{ id: 'foreign-native', paths: [
      'app.asar.unpacked/node_modules/@cursor/sdk-darwin-arm64/bin/rg',
      'app.asar.unpacked/node_modules/@parcel/watcher-win32-x64/watcher.node',
      'app.asar.unpacked/node_modules/node-pty/bin/darwin-arm64-145/node-pty.node',
      'app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/pty.node',
      'app.asar.unpacked/node_modules/tree-sitter-bash/prebuilds/win32-arm64/tree-sitter-bash.node',
    ] }]);
    assert.match(formatPackagedAppReport(checkPackagedApp({ appPath, arch: 'arm64', config: config() })), /^FAIL packaged arm64 app /);
    assert.throws(() => checkPackagedApp({ appPath, arch: 'universal', config: config() }), /Unsupported packaged app arch: universal/);
  });

  it('fails when a size grows past its ceiling and suggests lowering a slack one', async () => {
    const appPath = await createApp({ asar: { files: { 'main.mjs': file(10) } }, resources: { 'app.asar.unpacked/big.bin': Buffer.alloc(600) } });
    const report = checkPackagedApp({ appPath, config: config({
      baseline: { resourcesBytes: 100_000, asarBytes: 100_000, unpackedBytes: 100_000 },
      ceiling: { resourcesBytes: 100_000, asarBytes: 100_000, unpackedBytes: 500 },
    }) });
    assert.equal(report.ok, false);
    assert.deepEqual(report.oversized, ['unpackedBytes']);
    assert.deepEqual(report.lowerable, ['resourcesBytes', 'asarBytes']);
    assert.match(formatPackagedAppReport(report), /unpackedBytes 600 .*over ceiling/);
  });
});

describe('packaged app config', () => {
  it('rejects a function rule that returns no RegExp', async () => {
    const appPath = await createApp({ asar: { files: { 'main.mjs': file(1) } } });
    assert.throws(() => checkPackagedApp({ appPath, config: config({ forbidden: [{ id: 'broken', pattern: () => 'x64' }] }) }),
      /rule broken did not return a RegExp for arm64/);
  });

  it('rejects a ceiling above the frozen baseline', () => {
    assert.throws(() => validatePackagedAppConfig(config({
      ceiling: { resourcesBytes: 10_001, asarBytes: 10_000, unpackedBytes: 10_000 },
    })), /ceilings can only be lowered/);
  });

  it('ships a valid config whose ceilings meet the 850 MB Resources target', async () => {
    const shipped = await loadPackagedAppConfig();
    assert.ok(shipped.ceiling.resourcesBytes <= 850_000_000);
    for (const key of ['resourcesBytes', 'asarBytes', 'unpackedBytes']) {
      assert.ok(shipped.ceiling[key] < shipped.baseline[key], key);
    }
    assert.deepEqual(shipped.forbidden.map((rule) => rule.id).sort(),
      ['duplicate-native-runtime', 'duplicate-web-dist', 'foreign-native', 'linux-prebuild', 'native-build-leftover', 'shell-source-tree', 'source-map', 'test-file', 'typescript-source']);
  });
});
