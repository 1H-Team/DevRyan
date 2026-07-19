import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('./bundle-budgets.config.mjs', import.meta.url));
const BUN_CHUNK_PATTERN = /(?:^|[/_-])\.bun(?:$|[/_.-])/;
const compareStrings = (left, right) => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const requireManifestRecord = (manifest, manifestKey) => {
  const record = manifest[manifestKey];
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error(`Manifest entry "${manifestKey}" was not found`);
  }
  return record;
};

const collectStaticImports = (manifest, roots, visited = new Set()) => {
  const pending = [...roots];

  while (pending.length > 0) {
    const manifestKey = pending.pop();
    if (visited.has(manifestKey)) continue;

    const record = requireManifestRecord(manifest, manifestKey);
    visited.add(manifestKey);

    for (const importedKey of record.imports ?? []) {
      pending.push(importedKey);
    }
  }

  return visited;
};

export const collectStartupGraph = (manifest, buildConfig) => {
  const startupGraph = collectStaticImports(manifest, [buildConfig.entry]);

  for (const root of buildConfig.immediateDynamicRoots ?? []) {
    const declaredDynamicRoots = new Set();
    for (const manifestKey of startupGraph) {
      const record = requireManifestRecord(manifest, manifestKey);
      for (const dynamicImport of record.dynamicImports ?? []) {
        declaredDynamicRoots.add(dynamicImport);
      }
    }

    let resolvedRoot;
    if (typeof root === 'string') {
      if (!declaredDynamicRoots.has(root)) {
        throw new Error(
          `Immediate dynamic root "${root}" is not declared by the entry static graph`,
        );
      }
      resolvedRoot = root;
    } else {
      const matches = [...declaredDynamicRoots].filter((manifestKey) => (
        requireManifestRecord(manifest, manifestKey).name === root.name
      ));
      if (matches.length === 0) {
        throw new Error(
          `Immediate dynamic root name "${root.name}" is not declared by the entry static graph`,
        );
      }
      if (matches.length > 1) {
        throw new Error(
          `Immediate dynamic root name "${root.name}" is ambiguous: ${matches.sort(compareStrings).join(', ')}`,
        );
      }
      [resolvedRoot] = matches;
    }

    collectStaticImports(manifest, [resolvedRoot], startupGraph);
  }

  return [...startupGraph].sort(compareStrings);
};

const createError = (code, message) => ({ code, message });

const sortErrors = (errors) => errors.sort((left, right) => (
  compareStrings(left.code, right.code) || compareStrings(left.message, right.message)
));

const assertPositiveInteger = (value, label) => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
};

const validateBuildConfig = (buildConfig) => {
  if (!buildConfig || typeof buildConfig !== 'object' || Array.isArray(buildConfig)) {
    throw new Error('Build configuration must be an object');
  }
  if (typeof buildConfig.id !== 'string' || buildConfig.id.length === 0) {
    throw new Error('Build id must be a non-empty string');
  }

  for (const field of ['distDir', 'manifestPath', 'entry']) {
    if (typeof buildConfig[field] !== 'string' || buildConfig[field].length === 0) {
      throw new Error(`${buildConfig.id}.${field} must be a non-empty string`);
    }
  }

  if (!Array.isArray(buildConfig.immediateDynamicRoots)) {
    throw new Error(`${buildConfig.id}.immediateDynamicRoots must be an array`);
  }
  if (buildConfig.immediateDynamicRoots.some((root) => (
    (typeof root === 'string' && root.length === 0)
    || (
      typeof root !== 'string'
      && (
        !root
        || typeof root !== 'object'
        || Array.isArray(root)
        || typeof root.name !== 'string'
        || root.name.length === 0
        || Object.keys(root).some((key) => key !== 'name')
      )
    )
  ))) {
    throw new Error(`${buildConfig.id}.immediateDynamicRoots entries require a manifest key or name`);
  }
  if (!Array.isArray(buildConfig.prohibitedStartupChunks)) {
    throw new Error(`${buildConfig.id}.prohibitedStartupChunks must be an array`);
  }

  for (const guard of buildConfig.prohibitedStartupChunks) {
    if (
      guard
      && typeof guard === 'object'
      && !Array.isArray(guard)
      && Object.keys(guard).some((key) => key !== 'id' && key !== 'identities')
    ) {
      throw new Error(`${buildConfig.id}.prohibitedStartupChunks only accepts id and identities`);
    }
    if (
      !guard
      || typeof guard.id !== 'string'
      || guard.id.length === 0
      || !Array.isArray(guard.identities)
      || guard.identities.length === 0
      || guard.identities.some((identity) => typeof identity !== 'string' || identity.length === 0)
    ) {
      throw new Error(`${buildConfig.id}.prohibitedStartupChunks entries require an id and identities`);
    }
  }

  assertPositiveInteger(buildConfig.baseline?.rawBytes, `${buildConfig.id}.baseline.rawBytes`);
  assertPositiveInteger(buildConfig.baseline?.gzipBytes, `${buildConfig.id}.baseline.gzipBytes`);
  assertPositiveInteger(buildConfig.budgets?.rawBytes, `${buildConfig.id}.budgets.rawBytes`);
  assertPositiveInteger(buildConfig.budgets?.gzipBytes, `${buildConfig.id}.budgets.gzipBytes`);

  if (
    typeof buildConfig.minimumGzipReductionPercent !== 'number'
    || !Number.isFinite(buildConfig.minimumGzipReductionPercent)
    || buildConfig.minimumGzipReductionPercent < 0
    || buildConfig.minimumGzipReductionPercent > 100
  ) {
    throw new Error(`${buildConfig.id}.minimumGzipReductionPercent must be between 0 and 100`);
  }
};

const ensureFileInsideDist = (distDirectory, relativeFile) => {
  const absoluteFile = path.resolve(distDirectory, relativeFile);
  const relativeFromDist = path.relative(distDirectory, absoluteFile);

  if (relativeFromDist.startsWith('..') || path.isAbsolute(relativeFromDist)) {
    throw new Error(`Manifest file escapes dist directory: ${relativeFile}`);
  }

  return absoluteFile;
};

const measureStartupFiles = async (distDirectory, manifest, manifestKeys) => {
  const relativeFiles = new Set();

  for (const manifestKey of manifestKeys) {
    const record = requireManifestRecord(manifest, manifestKey);
    if (typeof record.file !== 'string' || record.file.length === 0) {
      throw new Error(`Manifest entry "${manifestKey}" does not declare an emitted file`);
    }
    relativeFiles.add(record.file);
  }

  const files = [];
  for (const relativeFile of [...relativeFiles].sort(compareStrings)) {
    const contents = await readFile(ensureFileInsideDist(distDirectory, relativeFile));
    files.push({
      path: relativeFile,
      rawBytes: contents.byteLength,
      gzipBytes: gzipSync(contents).byteLength,
    });
  }

  return files;
};

const findBunChunkIdentities = (manifest, manifestKeys) => {
  const matches = new Set();

  for (const manifestKey of manifestKeys) {
    const record = requireManifestRecord(manifest, manifestKey);
    for (const identity of [record.file, record.name]) {
      if (typeof identity === 'string' && BUN_CHUNK_PATTERN.test(identity)) {
        matches.add(identity);
      }
    }
  }

  return [...matches].sort(compareStrings);
};

const findProhibitedStartupChunkMatches = (manifest, manifestKeys, guard) => {
  const matches = new Set();

  for (const manifestKey of manifestKeys) {
    const record = requireManifestRecord(manifest, manifestKey);
    for (const identity of [record.file, record.name]) {
      if (typeof identity === 'string' && guard.identities.includes(identity)) {
        matches.add(identity);
      }
    }
  }

  return [...matches].sort(compareStrings);
};

const sumFileBytes = (files, field) => files.reduce((total, file) => total + file[field], 0);

const checkOneBuild = async (buildConfig, rootDir) => {
  validateBuildConfig(buildConfig);

  const errors = [];
  if (buildConfig.budgets.rawBytes > buildConfig.baseline.rawBytes) {
    errors.push(createError(
      'raw-budget-above-baseline',
      `Raw budget ${buildConfig.budgets.rawBytes} exceeds baseline ${buildConfig.baseline.rawBytes}`,
    ));
  }
  if (buildConfig.budgets.gzipBytes > buildConfig.baseline.gzipBytes) {
    errors.push(createError(
      'gzip-budget-above-baseline',
      `Gzip budget ${buildConfig.budgets.gzipBytes} exceeds baseline ${buildConfig.baseline.gzipBytes}`,
    ));
  }

  const distDirectory = path.resolve(rootDir, buildConfig.distDir);
  const manifestFile = ensureFileInsideDist(distDirectory, buildConfig.manifestPath);
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  const manifestKeys = collectStartupGraph(manifest, buildConfig);
  const files = await measureStartupFiles(distDirectory, manifest, manifestKeys);
  const totals = {
    rawBytes: sumFileBytes(files, 'rawBytes'),
    gzipBytes: sumFileBytes(files, 'gzipBytes'),
  };

  const bunChunkIdentities = findBunChunkIdentities(manifest, manifestKeys);
  if (bunChunkIdentities.length > 0) {
    errors.push(createError(
      'bun-chunk',
      `Startup graph contains Bun virtual-store chunk identities: ${bunChunkIdentities.join(', ')}`,
    ));
  }

  for (const guard of buildConfig.prohibitedStartupChunks) {
    const matches = findProhibitedStartupChunkMatches(manifest, manifestKeys, guard);
    if (matches.length === 0) continue;
    errors.push(createError(
      'prohibited-startup-chunk',
      `Prohibited startup chunk identity "${guard.id}" matched: ${matches.join(', ')}`,
    ));
  }

  if (totals.rawBytes > buildConfig.budgets.rawBytes) {
    errors.push(createError(
      'raw-budget',
      `Raw startup bytes ${totals.rawBytes} exceed budget ${buildConfig.budgets.rawBytes}`,
    ));
  }
  if (totals.gzipBytes > buildConfig.budgets.gzipBytes) {
    errors.push(createError(
      'gzip-budget',
      `Gzip startup bytes ${totals.gzipBytes} exceed budget ${buildConfig.budgets.gzipBytes}`,
    ));
  }

  const maximumGzipBytesForReduction = Math.floor(
    buildConfig.baseline.gzipBytes
      * ((100 - buildConfig.minimumGzipReductionPercent) / 100),
  );
  if (totals.gzipBytes > maximumGzipBytesForReduction) {
    errors.push(createError(
      'gzip-reduction',
      `Gzip startup bytes ${totals.gzipBytes} exceed ${maximumGzipBytesForReduction}, the maximum for a ${buildConfig.minimumGzipReductionPercent}% reduction from baseline ${buildConfig.baseline.gzipBytes}`,
    ));
  }

  sortErrors(errors);
  return {
    id: buildConfig.id,
    ok: errors.length === 0,
    totals,
    budgets: { ...buildConfig.budgets },
    baseline: { ...buildConfig.baseline },
    minimumGzipReductionPercent: buildConfig.minimumGzipReductionPercent,
    files,
    errors,
  };
};

export const checkBundleBudgets = async (config, { rootDir = process.cwd() } = {}) => {
  if (config?.schemaVersion !== 1) {
    throw new Error('Bundle budget config schemaVersion must be 1');
  }
  if (!Array.isArray(config.builds) || config.builds.length === 0) {
    throw new Error('Bundle budget config builds must be a non-empty array');
  }

  const duplicateIds = config.builds
    .map((build) => build?.id)
    .filter((id, index, ids) => typeof id === 'string' && ids.indexOf(id) !== index);
  if (duplicateIds.length > 0) {
    throw new Error(`Bundle budget build ids must be unique: ${[...new Set(duplicateIds)].sort(compareStrings).join(', ')}`);
  }

  const builds = [];
  for (const buildConfig of [...config.builds].sort((left, right) => (
    compareStrings(String(left?.id), String(right?.id))
  ))) {
    try {
      builds.push(await checkOneBuild(buildConfig, rootDir));
    } catch (error) {
      const id = typeof buildConfig?.id === 'string' ? buildConfig.id : '<invalid>';
      builds.push({
        id,
        ok: false,
        totals: { rawBytes: 0, gzipBytes: 0 },
        budgets: buildConfig?.budgets ?? { rawBytes: 0, gzipBytes: 0 },
        baseline: buildConfig?.baseline ?? { rawBytes: 0, gzipBytes: 0 },
        minimumGzipReductionPercent: buildConfig?.minimumGzipReductionPercent ?? 0,
        files: [],
        errors: [createError(
          'measurement-error',
          error instanceof Error ? error.message : String(error),
        )],
      });
    }
  }

  return {
    schemaVersion: 1,
    ok: builds.every((build) => build.ok),
    builds,
  };
};

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.keys(value)
      .sort(compareStrings)
      .map((key) => [key, canonicalize(value[key])]),
  );
};

export const formatBundleJson = (report) => `${JSON.stringify(canonicalize(report), null, 2)}\n`;

export const formatBundleReport = (report) => {
  const lines = [`${report.ok ? 'PASS' : 'FAIL'} bundle budgets`];

  for (const build of report.builds) {
    const baselineGzip = build.baseline.gzipBytes;
    const reduction = baselineGzip > 0
      ? (((baselineGzip - build.totals.gzipBytes) / baselineGzip) * 100).toFixed(2)
      : 'n/a';
    lines.push(
      `${build.ok ? 'PASS' : 'FAIL'} ${build.id} raw=${build.totals.rawBytes}/${build.budgets.rawBytes} gzip=${build.totals.gzipBytes}/${build.budgets.gzipBytes} files=${build.files.length} baseline-gzip=${baselineGzip} reduction=${reduction}%`,
    );
    for (const error of build.errors) {
      lines.push(`  [${error.code}] ${error.message}`);
    }
  }

  return `${lines.join('\n')}\n`;
};

const parseArguments = (argv) => {
  let configPath = DEFAULT_CONFIG_PATH;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      json = true;
      continue;
    }
    if (argument === '--config') {
      const value = argv[index + 1];
      if (!value) throw new Error('--config requires a path');
      configPath = path.resolve(process.cwd(), value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  return { configPath, json };
};

export const runBundleBudgetCli = async (argv = process.argv.slice(2)) => {
  const { configPath, json } = parseArguments(argv);
  const configModule = await import(pathToFileURL(configPath).href);
  const config = configModule.default;
  const rootDir = path.resolve(path.dirname(configPath), config.rootDir ?? '.');
  const report = await checkBundleBudgets(config, { rootDir });
  process.stdout.write(json ? formatBundleJson(report) : formatBundleReport(report));
  return report.ok ? 0 : 1;
};

const isMainModule = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMainModule) {
  runBundleBudgetCli()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(`Bundle budget check failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
