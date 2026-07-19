import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import {
  checkBundleBudgets,
  collectStartupGraph,
  formatBundleJson,
  formatBundleReport,
} from './check-bundle-budgets.mjs';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    force: true,
    recursive: true,
  })));
});

const createBundleFixture = async ({ manifest, files }) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'devryan-bundle-budget-'));
  temporaryDirectories.push(rootDir);

  const distDir = path.join(rootDir, 'dist');
  await mkdir(path.join(distDir, '.vite'), { recursive: true });
  await writeFile(
    path.join(distDir, '.vite', 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(distDir, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents);
  }

  return rootDir;
};

const createBuildConfig = (overrides = {}) => ({
  id: 'fixture',
  distDir: 'dist',
  manifestPath: '.vite/manifest.json',
  entry: 'src/main.ts',
  immediateDynamicRoots: ['src/app.ts'],
  prohibitedStartupChunks: [],
  baseline: {
    rawBytes: 10_000,
    gzipBytes: 10_000,
  },
  budgets: {
    rawBytes: 10_000,
    gzipBytes: 10_000,
  },
  minimumGzipReductionPercent: 0,
  ...overrides,
});

const startupManifest = {
  'src/main.ts': {
    file: 'assets/main.js',
    isEntry: true,
    imports: ['_shared.js'],
    dynamicImports: ['src/app.ts', 'src/lazy.ts'],
  },
  '_shared.js': {
    file: 'assets/shared.js',
  },
  'src/app.ts': {
    file: 'assets/app.js',
    name: 'app',
    imports: ['_app-shared.js'],
  },
  '_app-shared.js': {
    file: 'assets/app-shared.js',
  },
  'src/lazy.ts': {
    file: 'assets/OptionalFeature.js',
  },
};

const startupFiles = {
  'assets/main.js': 'main();\n',
  'assets/shared.js': 'shared();\n',
  'assets/app.js': 'app();\n',
  'assets/app-shared.js': 'appShared();\n',
  'assets/OptionalFeature.js': 'optional();\n',
};

describe('collectStartupGraph', () => {
  it('traverses static imports from the entry and configured immediate dynamic roots', () => {
    assert.deepEqual(
      collectStartupGraph(startupManifest, createBuildConfig()),
      ['_app-shared.js', '_shared.js', 'src/app.ts', 'src/main.ts'],
    );
  });

  it('rejects an immediate dynamic root that is not declared by the entry static graph', () => {
    assert.throws(
      () => collectStartupGraph(startupManifest, createBuildConfig({
        immediateDynamicRoots: ['src/not-immediate.ts'],
      })),
      /Immediate dynamic root "src\/not-immediate\.ts" is not declared by the entry static graph/,
    );
  });

  it('resolves a configured immediate dynamic root by its stable manifest name', () => {
    assert.deepEqual(
      collectStartupGraph(startupManifest, createBuildConfig({
        immediateDynamicRoots: [{ name: 'app' }],
      })),
      ['_app-shared.js', '_shared.js', 'src/app.ts', 'src/main.ts'],
    );
  });

  it('resolves configured immediate roots incrementally beneath an earlier app root', () => {
    const manifest = {
      ...startupManifest,
      'src/app.ts': {
        ...startupManifest['src/app.ts'],
        dynamicImports: ['src/rendered.ts', 'src/still-lazy.ts'],
      },
      'src/rendered.ts': {
        file: 'assets/rendered.js',
        name: 'rendered',
      },
      'src/still-lazy.ts': {
        file: 'assets/still-lazy.js',
        name: 'still-lazy',
      },
    };

    assert.deepEqual(
      collectStartupGraph(manifest, createBuildConfig({
        immediateDynamicRoots: [{ name: 'app' }, { name: 'rendered' }],
      })),
      ['_app-shared.js', '_shared.js', 'src/app.ts', 'src/main.ts', 'src/rendered.ts'],
    );
  });
});

describe('checkBundleBudgets', () => {
  it('computes unique raw and default-gzip bytes without following unconfigured lazy roots', async () => {
    const rootDir = await createBundleFixture({
      manifest: startupManifest,
      files: startupFiles,
    });

    const report = await checkBundleBudgets({
      schemaVersion: 1,
      builds: [createBuildConfig()],
    }, { rootDir });

    const measuredContents = [
      startupFiles['assets/main.js'],
      startupFiles['assets/shared.js'],
      startupFiles['assets/app.js'],
      startupFiles['assets/app-shared.js'],
    ];
    const expectedRawBytes = measuredContents.reduce(
      (total, contents) => total + Buffer.byteLength(contents),
      0,
    );
    const expectedGzipBytes = measuredContents.reduce(
      (total, contents) => total + gzipSync(Buffer.from(contents)).byteLength,
      0,
    );

    assert.equal(report.ok, true);
    assert.deepEqual(report.builds[0].totals, {
      rawBytes: expectedRawBytes,
      gzipBytes: expectedGzipBytes,
    });
    assert.deepEqual(
      report.builds[0].files.map((file) => file.path),
      [
        'assets/app-shared.js',
        'assets/app.js',
        'assets/main.js',
        'assets/shared.js',
      ],
    );
  });

  it('fails when the startup graph contains a Bun virtual-store chunk', async () => {
    const rootDir = await createBundleFixture({
      manifest: {
        ...startupManifest,
        '_shared.js': { file: 'assets/vendor-.bun-deadbeef.js' },
      },
      files: {
        ...startupFiles,
        'assets/vendor-.bun-deadbeef.js': 'bunStore();\n',
      },
    });

    const report = await checkBundleBudgets({
      schemaVersion: 1,
      builds: [createBuildConfig()],
    }, { rootDir });

    assert.equal(report.ok, false);
    assert.deepEqual(report.builds[0].errors.map((error) => error.code), ['bun-chunk']);
  });

  it('fails when a configured prohibited chunk identity enters startup', async () => {
    const rootDir = await createBundleFixture({
      manifest: {
        ...startupManifest,
        'src/app.ts': {
          file: 'assets/OptionalFeature.js',
          name: 'OptionalFeature',
          imports: ['_app-shared.js'],
        },
      },
      files: startupFiles,
    });

    const report = await checkBundleBudgets({
      schemaVersion: 1,
      builds: [createBuildConfig({
        prohibitedStartupChunks: [{
          id: 'optional-chunk',
          identities: ['OptionalFeature'],
        }],
      })],
    }, { rootDir });

    assert.equal(report.ok, false);
    assert.deepEqual(report.builds[0].errors.map((error) => error.code), ['prohibited-startup-chunk']);
  });

  it('fails when a prohibited configured root is declared beneath the measured app root', async () => {
    const manifest = {
      ...startupManifest,
      'src/app.ts': {
        ...startupManifest['src/app.ts'],
        dynamicImports: ['src/rendered.ts', 'src/still-lazy.ts'],
      },
      'src/rendered.ts': {
        file: 'assets/rendered.js',
        name: 'rendered',
      },
      'src/still-lazy.ts': {
        file: 'assets/still-lazy.js',
        name: 'still-lazy',
      },
    };
    const rootDir = await createBundleFixture({
      manifest,
      files: {
        ...startupFiles,
        'assets/rendered.js': 'rendered();\n',
        'assets/still-lazy.js': 'stillLazy();\n',
      },
    });

    const report = await checkBundleBudgets({
      schemaVersion: 1,
      builds: [createBuildConfig({
        immediateDynamicRoots: [{ name: 'app' }, { name: 'rendered' }],
        prohibitedStartupChunks: [{
          id: 'rendered-chunk',
          identities: ['rendered'],
        }],
      })],
    }, { rootDir });

    assert.equal(report.ok, false);
    assert.deepEqual(report.builds[0].errors.map((error) => error.code), ['prohibited-startup-chunk']);
    assert.deepEqual(
      report.builds[0].files.map((file) => file.path),
      [
        'assets/app-shared.js',
        'assets/app.js',
        'assets/main.js',
        'assets/rendered.js',
        'assets/shared.js',
      ],
    );
  });

  it('does not infer source-module or worker exclusion from generic startup chunk labels', async () => {
    const rootDir = await createBundleFixture({
      manifest: {
        ...startupManifest,
        'src/app.ts': {
          file: 'assets/app.js',
          name: 'app',
          src: 'src/OptionalFeature.ts',
          imports: ['_app-shared.js'],
        },
      },
      files: {
        ...startupFiles,
        'assets/OptionalWorker.js': 'optionalWorker();\n',
      },
    });

    const report = await checkBundleBudgets({
      schemaVersion: 1,
      builds: [createBuildConfig({
        prohibitedStartupChunks: [{
          id: 'optional-chunk',
          identities: ['OptionalFeature', 'OptionalWorker'],
        }],
      })],
    }, { rootDir });

    assert.equal(report.ok, true);
    assert.deepEqual(report.builds[0].errors, []);
  });

  it('rejects unsupported source-module and worker guard fields', async () => {
    const rootDir = await createBundleFixture({
      manifest: startupManifest,
      files: startupFiles,
    });

    const report = await checkBundleBudgets({
      schemaVersion: 1,
      builds: [createBuildConfig({
        prohibitedStartupChunks: [{
          id: 'unsupported-guard',
          identities: ['app'],
          sourcePatterns: ['OptionalFeature'],
          workerPatterns: ['OptionalWorker'],
        }],
      })],
    }, { rootDir });

    assert.equal(report.ok, false);
    assert.deepEqual(report.builds[0].errors.map((error) => error.code), ['measurement-error']);
    assert.match(
      report.builds[0].errors[0].message,
      /only accepts id and identities/,
    );
  });

  it('enforces byte budgets and the configured baseline reduction', async () => {
    const rootDir = await createBundleFixture({
      manifest: startupManifest,
      files: startupFiles,
    });

    const report = await checkBundleBudgets({
      schemaVersion: 1,
      builds: [createBuildConfig({
        baseline: { rawBytes: 200, gzipBytes: 200 },
        budgets: { rawBytes: 1, gzipBytes: 1 },
        minimumGzipReductionPercent: 90,
      })],
    }, { rootDir });

    assert.equal(report.ok, false);
    assert.deepEqual(
      report.builds[0].errors.map((error) => error.code),
      ['gzip-budget', 'gzip-reduction', 'raw-budget'],
    );
  });

  it('rejects budget headroom above the recorded baseline', async () => {
    const rootDir = await createBundleFixture({
      manifest: startupManifest,
      files: startupFiles,
    });

    const report = await checkBundleBudgets({
      schemaVersion: 1,
      builds: [createBuildConfig({
        baseline: { rawBytes: 1_000, gzipBytes: 1_000 },
        budgets: { rawBytes: 1_001, gzipBytes: 1_001 },
      })],
    }, { rootDir });

    assert.equal(report.ok, false);
    assert.deepEqual(
      report.builds[0].errors.map((error) => error.code),
      ['gzip-budget-above-baseline', 'raw-budget-above-baseline'],
    );
  });
});

describe('bundle budget output', () => {
  it('emits deterministic JSON and report text regardless of input object key order', () => {
    const report = {
      builds: [{
        totals: { gzipBytes: 40, rawBytes: 100 },
        ok: true,
        id: 'fixture',
        errors: [],
        budgets: { gzipBytes: 50, rawBytes: 120 },
        files: [],
        baseline: { gzipBytes: 80, rawBytes: 200 },
        minimumGzipReductionPercent: 0,
      }],
      ok: true,
      schemaVersion: 1,
    };

    assert.equal(formatBundleJson(report), `${JSON.stringify({
      builds: [{
        baseline: { gzipBytes: 80, rawBytes: 200 },
        budgets: { gzipBytes: 50, rawBytes: 120 },
        errors: [],
        files: [],
        id: 'fixture',
        minimumGzipReductionPercent: 0,
        ok: true,
        totals: { gzipBytes: 40, rawBytes: 100 },
      }],
      ok: true,
      schemaVersion: 1,
    }, null, 2)}\n`);
    assert.equal(
      formatBundleReport(report),
      'PASS bundle budgets\nPASS fixture raw=100/120 gzip=40/50 files=0 baseline-gzip=80 reduction=50.00%\n',
    );
  });
});
