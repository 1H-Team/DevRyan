#!/usr/bin/env node
// Predicts the packaged macOS app without packaging it: which files electron-builder
// would put into Resources (app.asar, app.asar.unpacked, extraResources) and how
// large they would be, checked against the forbidden rules and ceilings of
// scripts/packaged-app.config.mjs that check-packaged-app.mjs enforces after
// packaging. The file selection runs electron-builder's own selection code
// (app-builder-lib, the version packages/electron installs): the file matchers,
// the Bun node_modules collector and hoister, the node_modules copy filter, the
// package.json transformer and the smart-unpack detector. Nothing is copied,
// rebuilt, signed or written.
//
//   node scripts/predict-packaged-app.mjs [--electron-dir <dir>] [--config <file>] [--json] [--verbose]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { SIZE_KEYS, findForbiddenPaths, loadPackagedAppConfig, megabytes, validatePackagedAppConfig } from './check-packaged-app.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_ELECTRON_DIR = path.join(repositoryRoot, 'packages', 'electron');
// The release ships one DMG for this target; the prediction is always for it,
// whatever host runs it.
export const TARGET = Object.freeze({ platform: 'darwin', arch: 'arm64' });
/**
 * Sizes whose estimate fails over its ceiling; any other is printed only. Each one
 * here matched the app the release dry run measured to within 0.02% (calibration in
 * docs/OPENCODE_UPGRADES.md, "Predict the packaged app"); keep a size here only
 * while its estimate stays within 2% of the real app.
 */
export const FAILING_SIZE_KEYS = Object.freeze(['resourcesBytes', 'asarBytes', 'unpackedBytes']);
/**
 * The app-builder-lib the size estimates were calibrated against (dry run
 * 42803641451). Another installed version fails until it is re-calibrated.
 */
export const CALIBRATED_BUILDER_VERSION = '26.15.3';
/**
 * Repository-relative build outputs the package takes from a source directory.
 * Every other file a module or the app takes from the repository counts only when
 * git tracks it: a clean release checkout has no untracked files.
 */
export const KNOWN_BUILD_OUTPUTS = Object.freeze(['packages/electron/dist-bundle/']);
const LISTED = 10;
const BREAKDOWN_PACKAGES = 15;
// @electron/asar header: one SHA-256 per 4 MiB block plus one for the tail.
const ASAR_BLOCK_SIZE = 4 * 1024 * 1024;
const HASH = '0'.repeat(64);
const PLATFORM_IN_NAME = /(?:^|[-_/@])(darwin|linux|win32|freebsd|openbsd|android|sunos|aix)(?:$|[-_])/;

/** app-builder-lib internals, resolved the way packages/electron resolves electron-builder. */
export function loadBuilder(electronDir = DEFAULT_ELECTRON_DIR, { calibratedVersion = CALIBRATED_BUILDER_VERSION } = {}) {
  const fromElectron = createRequire(path.join(electronDir, 'package.json'));
  const builderManifest = fs.realpathSync(fromElectron.resolve('electron-builder/package.json'));
  const fromBuilder = createRequire(builderManifest);
  const libManifest = fs.realpathSync(fromBuilder.resolve('app-builder-lib/package.json'));
  const fromLib = createRequire(libManifest);
  const lib = (subpath) => fromLib(`./out/${subpath}`);
  const version = JSON.parse(fs.readFileSync(libManifest, 'utf8')).version;
  if (version !== calibratedVersion) {
    throw new Error(`app-builder-lib ${version} is installed but the packaged-app prediction was calibrated against ${calibratedVersion}: `
      + 're-calibrate against a dry run (docs/OPENCODE_UPGRADES.md, "4. Predict the packaged app") and update CALIBRATED_BUILDER_VERSION');
  }
  return {
    version,
    fileMatcher: lib('fileMatcher.js'),
    appFileCopier: lib('util/appFileCopier.js'),
    fileTransformer: lib('fileTransformer.js'),
    unpackDetector: lib('asar/unpackDetector.js'),
    expandMacro: lib('util/macroExpander.js').expandMacro,
    Platform: lib('core.js').Platform,
    PM: lib('node-module-collector/packageManager.js').PM,
    log: fromLib('builder-util').log,
  };
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const toPosix = (file) => file.split(path.sep).join('/');

/** The PlatformPackager fields the selection code reads, for a mac build of `arch`. */
function createPackager({ builder, electronDir, workspaceRoot, metadata, arch }) {
  const config = metadata.build ?? {};
  const platform = builder.Platform.MAC;
  const productName = config.productName ?? metadata.productName ?? metadata.name;
  const appInfo = {
    productName, sanitizedProductName: productName, productFilename: productName,
    version: metadata.version, companyName: metadata.author, type: metadata.type === 'module' ? 'module' : 'commonjs',
  };
  const outDir = path.resolve(electronDir, config.directories?.output ?? 'dist');
  const info = {
    appDir: electronDir,
    projectDir: electronDir,
    buildResourcesDir: path.resolve(electronDir, config.directories?.buildResources ?? 'build'),
    config,
    metadata,
    appInfo,
    nodePackageName: metadata.name,
    isPrepackedAppAsar: false,
    areNodeModulesHandledExternally: false,
    debugLogger: { isEnabled: false, add() {} },
    // The Bun collector traverses node_modules and never needs a temp file.
    tempDirManager: { getTempFile: async () => { throw new Error('the dependency collector asked for a temp file'); } },
    getWorkspaceRoot: async () => workspaceRoot,
    getPackageManager: async () => builder.PM.BUN,
  };
  const platformSpecific = config[platform.buildConfigurationKey] ?? {};
  const expandMacro = (pattern, extra = {}) => builder.expandMacro(pattern, arch, appInfo, { os: platform.buildConfigurationKey, ...extra });
  const options = { macroExpander: (pattern) => expandMacro(pattern, { '/*': '{,/**/*}' }), customBuildOptions: platformSpecific, globalOutDir: outDir };
  return { info, config, platform, platformSpecific, outDir, options };
}

/**
 * Walks one extraResources matcher the way copyFiles copies it; `visit` gets each
 * file with its Resources-relative path. Returns how many files it selected: none
 * means the input is missing (a filter can select nothing from a source that exists).
 */
function walkMatcher(matcher, resourcesDestination, visit) {
  const from = matcher.from;
  const to = toPosix(path.relative(resourcesDestination, matcher.to));
  let stat;
  try { stat = fs.statSync(from); } catch { return 0; }
  if (stat.isFile()) { visit(to, stat); return 1; }
  let count = 0;
  if (matcher.isEmpty() || matcher.containsOnlyIgnore()) matcher.prependPattern('**/*');
  const filter = matcher.createFilter();
  const descend = (directory) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      const entry = fs.statSync(file);
      if (!filter(file, entry)) continue;
      if (entry.isDirectory()) descend(file);
      else if (entry.isFile()) { visit(path.posix.join(to, toPosix(path.relative(from, file))), entry); count += 1; }
    }
  };
  descend(from);
  return count;
}

/** Repository files a clean checkout has (git-tracked), or null when `root` is not a git checkout. */
function trackedFiles(root) {
  try {
    const listing = execFileSync('git', ['ls-files', '-z', '--full-name'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return { top: fs.realpathSync(top), files: new Set(listing.split('\0').filter(Boolean)) };
  } catch { return null; }
}

/** Whether a package's `os` field allows `platform`. */
function allowsPlatform(manifest, platform) {
  const list = Array.isArray(manifest?.os) ? manifest.os : null;
  if (!list || list.length === 0) return true;
  if (list.includes(`!${platform}`)) return false;
  const positive = list.filter((entry) => !entry.startsWith('!'));
  return positive.length === 0 || positive.includes(platform);
}

/**
 * Asar header JSON length, built the way @electron/asar builds it, with placeholder
 * hashes: directories (marked unpacked inside an auto-unpacked module), files with
 * size, offset or unpacked flag, integrity and executable bit, and links.
 */
function asarHeaderLength(entries, isUnpackedDirectory) {
  const root = { files: {} };
  let offset = 0;
  const directory = (segments) => {
    let node = root;
    for (let index = 0; index < segments.length; index += 1) {
      if (!node.files[segments[index]]) {
        node.files[segments[index]] = isUnpackedDirectory(segments.slice(0, index + 1).join('/')) ? { unpacked: true, files: {} } : { files: {} };
      }
      node = node.files[segments[index]];
    }
    return node;
  };
  for (const entry of entries) {
    const segments = entry.path.split('/');
    const name = segments.pop();
    const parent = directory(segments);
    if (entry.link != null) {
      parent.files[name] = entry.unpacked ? { unpacked: true, link: entry.link } : { link: entry.link };
      continue;
    }
    const blocks = Array.from({ length: Math.floor(entry.size / ASAR_BLOCK_SIZE) + 1 }, () => HASH);
    const integrity = { algorithm: 'SHA256', hash: HASH, blockSize: ASAR_BLOCK_SIZE, blocks };
    if (entry.unpacked) {
      parent.files[name] = { size: entry.size, unpacked: true, integrity };
    } else {
      parent.files[name] = { size: entry.size, offset: String(offset), integrity, ...(entry.executable ? { executable: true } : {}) };
      offset += entry.size;
    }
  }
  return Buffer.byteLength(JSON.stringify(root), 'utf8');
}

/**
 * electron-builder's selection for the app: the app's own files and every
 * production module as file sets (src, destination, files, stat metadata), with
 * package.json files transformed, plus the asarUnpack filter, the extraResources
 * matchers and the node_modules filter. Builder log output is captured, not printed.
 */
async function selectFileSets({ builder, packager, electronDir, defaultDestination }) {
  const { fileMatcher, appFileCopier, fileTransformer } = builder;
  const { info, config, platformSpecific, outDir, options } = packager;
  const matchers = (name, destination) => fileMatcher.getFileMatchers(config, name, destination, { ...options, defaultSrc: electronDir }) ?? [];
  const resourcesDestination = path.dirname(defaultDestination);
  const builderLog = [];
  const stream = builder.log.stream;
  builder.log.stream = { write: (chunk) => { builderLog.push(String(chunk)); return true; } };
  try {
    // extraResources and extraFiles sources never enter the app itself.
    const excludePatterns = [];
    for (const matcher of [...matchers('extraResources', resourcesDestination), ...matchers('extraFiles', resourcesDestination)]) {
      matcher.computeParsedPatterns(excludePatterns, electronDir);
    }
    const mainMatchers = fileMatcher.getMainFileMatchers(electronDir, defaultDestination, options.macroExpander, platformSpecific, packager, outDir, false);
    if (excludePatterns.length > 0) for (const matcher of mainMatchers) matcher.excludePatterns = excludePatterns;
    const transformer = fileTransformer.createTransformer(electronDir, config, config.extraMetadata, null);
    const moduleMatcher = fileMatcher.getNodeModuleFileMatcher(electronDir, defaultDestination, options.macroExpander, platformSpecific, info);
    const appSets = await appFileCopier.computeFileSets(mainMatchers, transformer, packager, false);
    const moduleSets = await appFileCopier.computeNodeModuleFileSets(packager, moduleMatcher);
    const selected = [...appSets, ...moduleSets].filter((set) => set.files.length > 0);
    const dropped = dropForeignPlatformSets(selected, TARGET.platform, defaultDestination);
    const fileSets = selected.filter((set) => !dropped.sets.has(set));
    for (const set of fileSets) await appFileCopier.transformFiles(transformer, set);
    return {
      fileSets,
      droppedForeignPlatform: dropped.names,
      notInstalled: missingOptionalPackages(fileSets, moduleMatcher, defaultDestination),
      unpackFilter: matchers('asarUnpack', defaultDestination)[0]?.createFilter() ?? null,
      extraResourceMatchers: matchers('extraResources', resourcesDestination),
      builderLog,
    };
  } finally {
    builder.log.stream = stream;
  }
}

/**
 * The files electron-builder would place under DevRyan.app/Contents/Resources for
 * TARGET, with sizes, and what the prediction could not see on this host.
 * `metadata` replaces packages/electron/package.json (its `build` field is the
 * packaging configuration).
 */
export async function predictPackagedApp({
  electronDir = DEFAULT_ELECTRON_DIR, workspaceRoot = repositoryRoot, arch = TARGET.arch,
  metadata = readJson(path.join(electronDir, 'package.json')), builder = loadBuilder(electronDir),
} = {}) {
  const started = performance.now();
  const packager = createPackager({ builder, electronDir, workspaceRoot, metadata, arch });
  const { config, platformSpecific } = packager;
  // A virtual Resources/app path: the matchers need a destination, nothing is written there.
  const defaultDestination = path.join(os.tmpdir(), 'devryan-predicted-app', 'Resources', 'app');
  const selection = await selectFileSets({ builder, packager, electronDir, defaultDestination });
  const { fileSets, unpackFilter } = selection;

  // Smart unpack: a module holding a native library or binary is unpacked whole.
  const autoUnpacked = new Set();
  if ((platformSpecific.asar ?? config.asar)?.smartUnpack !== false) {
    for (const set of fileSets) builder.unpackDetector.detectUnpackedDirs(set, autoUnpacked);
  }
  const autoUnpackedDirs = [...autoUnpacked].map((directory) => path.normalize(directory));
  const withinAutoUnpacked = (directory) => autoUnpackedDirs.some((root) => directory === root || directory.startsWith(root + path.sep));

  // Files taken from the repository itself (the app, workspace packages) count when
  // tracked or a known build output; installed modules always count.
  const tracked = trackedFiles(workspaceRoot);
  const workspaceRoots = [...new Set([path.resolve(workspaceRoot), fs.realpathSync(workspaceRoot)])];
  const workspaceRealPath = workspaceRoots.at(-1);
  const untracked = { files: 0, bytes: 0 };
  const inCleanCheckout = (file) => {
    if (tracked == null) return true;
    // Module sources are real paths; the app's own files keep the path it was given.
    const base = workspaceRoots.find((root) => file.startsWith(root + path.sep));
    if (base == null) return true;
    const relative = toPosix(path.relative(base, file));
    if (relative.split('/').includes('node_modules')) return true;
    const repositoryPath = toPosix(path.relative(tracked.top, path.join(workspaceRealPath, relative)));
    return tracked.files.has(repositoryPath) || KNOWN_BUILD_OUTPUTS.some((prefix) => relative.startsWith(prefix));
  };
  const asarEntries = [];
  const seen = new Set();
  for (const set of fileSets) {
    for (const [index, file] of set.files.entries()) {
      const stat = set.metadata.get(file);
      if (stat == null || stat.isDirectory()) continue;
      if (!inCleanCheckout(file)) {
        untracked.files += 1;
        untracked.bytes += stat.size;
        continue;
      }
      const destination = path.relative(defaultDestination, builder.appFileCopier.getDestinationPath(file, set));
      if (seen.has(destination)) continue;
      seen.add(destination);
      const unpacked = Boolean(unpackFilter?.(file, stat)) || withinAutoUnpacked(path.dirname(destination));
      if (stat.isSymbolicLink()) {
        asarEntries.push({ path: toPosix(destination), link: fs.readlinkSync(file), unpacked });
        continue;
      }
      const transformed = set.transformedFiles?.get(index);
      const size = transformed == null ? stat.size : Buffer.byteLength(transformed);
      asarEntries.push({ path: toPosix(destination), size, unpacked, executable: (stat.mode & 0o100) !== 0 });
    }
  }

  const resourceFiles = [];
  const missingInputs = { app: [], resources: [] };
  for (const matcher of selection.extraResourceMatchers) {
    const selected = walkMatcher(matcher, path.dirname(defaultDestination), (resourcePath, stat) => resourceFiles.push({ path: resourcePath, size: stat.size }));
    if (selected === 0) {
      const filter = matcher.patterns.length > 0 && matcher.patterns[0] !== '**/*' ? ` (${matcher.patterns.join(', ')})` : '';
      missingInputs.resources.push(`extraResources ${toPosix(path.relative(workspaceRoot, matcher.from))}${filter} not built`);
    }
  }
  for (const pattern of config.files ?? []) {
    if (typeof pattern === 'string' && !pattern.startsWith('!') && !/[*?{[]/.test(pattern) && !fs.existsSync(path.join(electronDir, pattern))) {
      missingInputs.app.push(`files ${toPosix(path.relative(workspaceRoot, path.join(electronDir, pattern)))} not built`);
    }
  }
  const electronBase = electronBaseResources(electronDir, platformSpecific.icon);
  if (electronBase == null) missingInputs.resources.push('Electron.app base resources (the macOS Electron install)');
  else resourceFiles.push(...electronBase);

  const packed = asarEntries.filter((entry) => !entry.unpacked && entry.link == null);
  const unpackedFiles = asarEntries.filter((entry) => entry.unpacked && entry.link == null);
  const sum = (files) => files.reduce((total, file) => total + file.size, 0);
  const headerLength = asarHeaderLength(asarEntries, (directory) => withinAutoUnpacked(path.normalize(directory)));
  const asarBytes = 16 + Math.ceil(headerLength / 4) * 4 + sum(packed);
  const unpackedBytes = sum(unpackedFiles);
  const sizes = { asarBytes, unpackedBytes, resourcesBytes: asarBytes + unpackedBytes + sum(resourceFiles) };
  // What this host could not see makes an estimate a lower bound, never an overestimate.
  const unseenModules = selection.notInstalled.map((name) => `${name} not installed`);
  const lowerBound = {
    asarBytes: [...missingInputs.app, ...unseenModules],
    unpackedBytes: [...unseenModules],
    resourcesBytes: [...missingInputs.app, ...unseenModules, ...missingInputs.resources],
  };

  return {
    target: { ...TARGET, arch },
    builderVersion: builder.version,
    sizes,
    lowerBound,
    checkedPaths: [
      'app.asar',
      ...unpackedFiles.map((entry) => `app.asar.unpacked/${entry.path}`),
      ...resourceFiles.map((file) => file.path),
      ...packed.map((entry) => `app.asar/${entry.path}`),
    ],
    counts: { packed: packed.length, unpacked: unpackedFiles.length, links: asarEntries.length - packed.length - unpackedFiles.length, resources: resourceFiles.length, fileSets: fileSets.length },
    headerLength,
    breakdown: sizeBreakdown({ packed, unpackedFiles, resourceFiles, headerBytes: asarBytes - sum(packed) }),
    untracked,
    droppedForeignPlatform: selection.droppedForeignPlatform,
    notInstalled: selection.notInstalled,
    builderLog: selection.builderLog.join(''),
    elapsedMs: Math.round(performance.now() - started),
  };
}

/**
 * Bytes per top-level Resources entry, per top-level directory inside app.asar and
 * app.asar.unpacked, and for node_modules per package (the largest few, the rest
 * summed), so a wrong estimate can be traced to the part that is off.
 */
function sizeBreakdown({ packed, unpackedFiles, resourceFiles, headerBytes }) {
  const rows = new Map();
  const add = (key, size) => {
    const row = rows.get(key) ?? { path: key, files: 0, bytes: 0 };
    row.files += 1;
    row.bytes += size;
    rows.set(key, row);
  };
  const group = (area, entryPath) => {
    const segments = entryPath.split('/');
    if (segments[0] !== 'node_modules' || segments.length < 3) return `${area}/${segments.length > 1 ? `${segments[0]}/` : segments[0]}`;
    return `${area}/node_modules/${segments[1].startsWith('@') ? `${segments[1]}/${segments[2]}` : segments[1]}`;
  };
  rows.set('app.asar (header)', { path: 'app.asar (header)', files: 0, bytes: headerBytes });
  for (const entry of packed) add(group('app.asar', entry.path), entry.size);
  for (const entry of unpackedFiles) add(group('app.asar.unpacked', entry.path), entry.size);
  for (const file of resourceFiles) {
    const segments = file.path.split('/');
    add(segments.length > 1 ? `${segments[0]}/` : segments[0], file.size);
  }
  // Keep the largest packages of each area; sum the rest so the total stays exact.
  const result = [];
  for (const area of ['app.asar', 'app.asar.unpacked']) {
    const packages = [...rows.values()].filter((row) => row.path.startsWith(`${area}/node_modules/`)).sort((a, b) => b.bytes - a.bytes);
    for (const row of packages.slice(BREAKDOWN_PACKAGES)) {
      rows.delete(row.path);
      const rest = rows.get(`${area}/node_modules/(${packages.length - BREAKDOWN_PACKAGES} other packages)`) ?? { path: `${area}/node_modules/(${packages.length - BREAKDOWN_PACKAGES} other packages)`, files: 0, bytes: 0 };
      rest.files += row.files;
      rest.bytes += row.bytes;
      rows.set(rest.path, rest);
    }
  }
  result.push(...[...rows.values()].sort((a, b) => a.path.localeCompare(b.path)));
  return result;
}

/**
 * Packages installed only because this host is not the target (Bun installs the
 * host's `os` optionals): the macOS packaging host never has them. Their nested
 * file sets go with them.
 */
function dropForeignPlatformSets(fileSets, platform, defaultDestination) {
  const sets = new Set();
  const names = [];
  const roots = [];
  for (const set of fileSets) {
    const manifestPath = path.join(set.src, 'package.json');
    if (!set.destination.startsWith(path.join(defaultDestination, 'node_modules')) || !fs.existsSync(manifestPath)) continue;
    if (!allowsPlatform(readJson(manifestPath), platform)) {
      roots.push(set.destination);
      names.push(toPosix(path.relative(defaultDestination, set.destination)));
    }
  }
  for (const set of fileSets) {
    if (roots.some((root) => set.destination === root || set.destination.startsWith(root + path.sep))) sets.add(set);
  }
  return { sets, names: names.sort() };
}

/**
 * Optional dependencies of packaged modules that are not installed on this host
 * and that build.files would keep: their content and size are unseen. Names
 * naming another platform than the target are expected to be absent.
 */
function missingOptionalPackages(fileSets, moduleMatcher, defaultDestination) {
  const installed = new Set();
  const manifests = [];
  for (const set of fileSets) {
    const relative = toPosix(path.relative(defaultDestination, set.destination));
    if (!relative.startsWith('node_modules/')) continue;
    installed.add(relative.slice(relative.lastIndexOf('node_modules/') + 'node_modules/'.length));
    const manifestPath = path.join(set.src, 'package.json');
    if (fs.existsSync(manifestPath)) manifests.push(readJson(manifestPath));
  }
  const filter = moduleMatcher.createFilter();
  const directoryStat = (destination) => ({ isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false, moduleFullFilePath: destination });
  const missing = new Set();
  for (const manifest of manifests) {
    for (const name of Object.keys(manifest.optionalDependencies ?? {})) {
      if (installed.has(name)) continue;
      const platform = PLATFORM_IN_NAME.exec(name)?.[1];
      if (platform && platform !== TARGET.platform) continue;
      const destination = `node_modules/${name}`;
      if (!filter(path.join(defaultDestination, destination), directoryStat(destination))) continue;
      missing.add(name);
    }
  }
  return [...missing].sort();
}

/** Electron.app's own Resources for the mac app (locales, icon), or null off macOS installs. */
function electronBaseResources(electronDir, icon) {
  let electronPath;
  try {
    electronPath = path.dirname(fs.realpathSync(createRequire(path.join(electronDir, 'package.json')).resolve('electron/package.json')));
  } catch { return null; }
  const resources = path.join(electronPath, 'dist', 'Electron.app', 'Contents', 'Resources');
  if (!fs.existsSync(resources)) return null;
  const files = [];
  const visit = (directory, prefix) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!prefix && (entry.name === 'default_app.asar' || entry.name === 'electron.icns')) continue;
      if (entry.isDirectory()) visit(path.join(directory, entry.name), relative);
      else if (entry.isFile()) files.push({ path: relative, size: fs.statSync(path.join(directory, entry.name)).size });
    }
  };
  visit(resources, '');
  if (icon && fs.existsSync(path.join(electronDir, icon))) files.push({ path: path.basename(icon), size: fs.statSync(path.join(electronDir, icon)).size });
  return files;
}

/**
 * The prediction judged against the config: forbidden content fails, and so does
 * every size in `failingSizeKeys` over its ceiling. A lower-bound estimate over its
 * ceiling fails too (the real size is at least that); one under it passes with the
 * reasons printed.
 */
export function checkPrediction(prediction, config, { failingSizeKeys = FAILING_SIZE_KEYS } = {}) {
  validatePackagedAppConfig(config);
  const violations = findForbiddenPaths(prediction.checkedPaths, config, prediction.target.arch);
  const oversized = failingSizeKeys.filter((key) => prediction.sizes[key] > config.ceiling[key]);
  const informational = SIZE_KEYS.filter((key) => !failingSizeKeys.includes(key));
  return { ok: violations.length === 0 && oversized.length === 0, violations, oversized, informational, ceiling: { ...config.ceiling } };
}

export function formatPredictionReport(prediction, verdict, { verbose = false } = {}) {
  const { target, sizes, lowerBound, counts } = prediction;
  const lines = [`${verdict.ok ? 'PASS' : 'FAIL'} predicted ${target.platform}-${target.arch} app (app-builder-lib ${prediction.builderVersion}, ${prediction.elapsedMs} ms, nothing packaged)`];
  for (const key of SIZE_KEYS) {
    const status = verdict.oversized.includes(key) ? 'over ceiling' : verdict.informational.includes(key) ? 'informational' : 'ok';
    const bound = lowerBound[key].length > 0 ? ` (lower bound: ${lowerBound[key].join('; ')})` : '';
    lines.push(`  ${key} ~${sizes[key]} (${megabytes(sizes[key])}) / ceiling ${verdict.ceiling[key]} (${megabytes(verdict.ceiling[key])}): ${status}${bound}`);
  }
  lines.push(`  ${counts.packed} packed and ${counts.unpacked} unpacked files from ${counts.fileSets} file sets, ${counts.resources} other Resources files`);
  for (const violation of verdict.violations) {
    lines.push(`  [${violation.id}] ${violation.paths.length} forbidden file(s) would be packaged:`);
    for (const forbiddenPath of violation.paths.slice(0, LISTED)) lines.push(`    ${forbiddenPath}`);
    if (violation.paths.length > LISTED) lines.push(`    … ${violation.paths.length - LISTED} more`);
  }
  if (prediction.untracked.files > 0) lines.push(`  left out as untracked repository files: ${prediction.untracked.files} (${megabytes(prediction.untracked.bytes)})`);
  if (prediction.droppedForeignPlatform.length > 0) lines.push(`  left out as this host's own platform packages: ${prediction.droppedForeignPlatform.join(', ')}`);
  if (verbose) {
    lines.push('  breakdown (bytes, files):');
    const width = Math.max(...prediction.breakdown.map((row) => row.path.length));
    for (const row of prediction.breakdown) lines.push(`    ${row.path.padEnd(width)}  ${String(row.bytes).padStart(11)}  ${String(row.files).padStart(6)}`);
  }
  return `${lines.join('\n')}\n`;
}

const parseArguments = (argv) => {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--json' || flag === '--verbose') { options[flag.slice(2)] = true; continue; }
    if (flag !== '--electron-dir' && flag !== '--config') throw new Error(`Unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (!value) throw new Error(`${flag} requires a value`);
    options[flag === '--config' ? 'configPath' : 'electronDir'] = path.resolve(process.cwd(), value);
    index += 1;
  }
  return options;
};

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const { json, verbose, configPath, electronDir } = parseArguments(process.argv.slice(2));
    const config = await loadPackagedAppConfig(configPath);
    const prediction = await predictPackagedApp({ electronDir });
    const verdict = checkPrediction(prediction, config);
    if (json) process.stdout.write(`${JSON.stringify({ ...prediction, checkedPaths: undefined, verdict }, null, 2)}\n`);
    else (verdict.ok ? process.stdout : process.stderr).write(formatPredictionReport(prediction, verdict, { verbose }));
    if (!verdict.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
