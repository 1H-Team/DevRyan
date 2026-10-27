#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONFIG_PATH = path.join(repositoryRoot, 'scripts', 'packaged-app.config.mjs');
const DEFAULT_APP_PATH = path.join(repositoryRoot, 'packages', 'electron', 'dist', 'mac-arm64', 'DevRyan.app');
const SIZE_KEYS = Object.freeze(['resourcesBytes', 'asarBytes', 'unpackedBytes']);
const ARCHES = Object.freeze(['arm64', 'x64']);
const LISTED_VIOLATIONS = 10;
// The report suggests lowering a ceiling once the app is this far below it.
const RATCHET_SLACK = 0.05;

/**
 * app.asar starts with two Chromium pickles: an 8-byte one whose payload is the
 * header pickle's size, then the header pickle (payload size, string length,
 * UTF-8 JSON). File contents follow; only the header is read.
 */
export function readAsarHeader(asarPath) {
  const descriptor = fs.openSync(asarPath, 'r');
  try {
    const prefix = Buffer.alloc(16);
    if (fs.readSync(descriptor, prefix, 0, prefix.length, 0) !== prefix.length) {
      throw new Error(`${asarPath}: truncated asar header`);
    }
    const headerPickleSize = prefix.readUInt32LE(4);
    const headerPayloadSize = prefix.readUInt32LE(8);
    const jsonSize = prefix.readUInt32LE(12);
    if (prefix.readUInt32LE(0) !== 4 || headerPayloadSize + 4 > headerPickleSize || jsonSize + 4 > headerPayloadSize) {
      throw new Error(`${asarPath}: invalid asar header`);
    }
    const json = Buffer.alloc(jsonSize);
    if (fs.readSync(descriptor, json, 0, jsonSize, prefix.length) !== jsonSize) {
      throw new Error(`${asarPath}: truncated asar header`);
    }
    return JSON.parse(json.toString('utf8'));
  } finally {
    fs.closeSync(descriptor);
  }
}

/** Every file in an asar header as `{ path, size, unpacked }`; links are skipped. */
export function listAsarFiles(header) {
  const files = [];
  const visit = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const relativePath = prefix ? `${prefix}/${name}` : name;
      if (entry.files) visit(entry, relativePath);
      else if (!entry.link) files.push({ path: relativePath, size: Number(entry.size) || 0, unpacked: entry.unpacked === true });
    }
  };
  visit(header, '');
  return files;
}

/** Every regular file under a directory as `{ path, size }` with `/` separators. */
export function listTreeFiles(root) {
  const files = [];
  const visit = (relative) => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(next);
      else if (entry.isFile()) files.push({ path: next, size: fs.statSync(path.join(root, next)).size });
    }
  };
  visit('');
  return files;
}

export function validatePackagedAppConfig(config) {
  if (config?.schemaVersion !== 1) throw new Error('Packaged app config schemaVersion must be 1');
  if (!Array.isArray(config.forbidden) || config.forbidden.some((rule) => typeof rule?.id !== 'string'
    || !(rule.pattern instanceof RegExp || typeof rule.pattern === 'function'))) {
    throw new Error('Packaged app config forbidden rules need an id and a RegExp pattern or a function of { arch }');
  }
  for (const key of SIZE_KEYS) {
    for (const group of ['baseline', 'ceiling']) {
      if (!Number.isSafeInteger(config[group]?.[key]) || config[group][key] <= 0) {
        throw new Error(`Packaged app config ${group}.${key} must be a positive integer`);
      }
    }
    if (config.ceiling[key] > config.baseline[key]) {
      throw new Error(`Packaged app ceiling.${key} ${config.ceiling[key]} exceeds baseline ${config.baseline[key]}: ceilings can only be lowered`);
    }
  }
  return config;
}

/** The rule's pattern for this arch; a function rule must return a RegExp. */
const resolveRulePattern = (rule, arch) => {
  if (rule.pattern instanceof RegExp) return rule.pattern;
  const pattern = rule.pattern({ arch });
  if (!(pattern instanceof RegExp)) throw new Error(`Packaged app config forbidden rule ${rule.id} did not return a RegExp for ${arch}`);
  return pattern;
};

export function checkPackagedApp({ appPath = DEFAULT_APP_PATH, config, arch = 'arm64' }) {
  validatePackagedAppConfig(config);
  if (!ARCHES.includes(arch)) throw new Error(`Unsupported packaged app arch: ${String(arch)}`);
  const resourcesRoot = path.join(appPath, 'Contents', 'Resources');
  const asarPath = path.join(resourcesRoot, 'app.asar');
  if (!fs.existsSync(asarPath)) throw new Error(`${asarPath} not found`);

  const resourceFiles = listTreeFiles(resourcesRoot);
  const asarEntries = listAsarFiles(readAsarHeader(asarPath)).filter((entry) => !entry.unpacked);
  const sum = (files) => files.reduce((total, file) => total + file.size, 0);
  const sizes = {
    resourcesBytes: sum(resourceFiles),
    asarBytes: fs.statSync(asarPath).size,
    unpackedBytes: sum(resourceFiles.filter((file) => file.path.startsWith('app.asar.unpacked/'))),
  };

  const checkedPaths = [...resourceFiles.map((file) => file.path), ...asarEntries.map((entry) => `app.asar/${entry.path}`)];
  const violations = config.forbidden.map((rule) => {
    const pattern = resolveRulePattern(rule, arch);
    return { id: rule.id, paths: checkedPaths.filter((checkedPath) => pattern.test(checkedPath)).sort() };
  }).filter((violation) => violation.paths.length > 0);
  const oversized = SIZE_KEYS.filter((key) => sizes[key] > config.ceiling[key]);
  const lowerable = SIZE_KEYS.filter((key) => sizes[key] < config.ceiling[key] * (1 - RATCHET_SLACK));

  return { ok: violations.length === 0 && oversized.length === 0, appPath, arch, sizes, ceiling: { ...config.ceiling }, violations, oversized, lowerable };
}

const megabytes = (bytes) => `${(bytes / 1_000_000).toFixed(1)} MB`;

export function formatPackagedAppReport(report) {
  const lines = [`${report.ok ? 'PASS' : 'FAIL'} packaged ${report.arch} app ${report.appPath}`];
  for (const key of SIZE_KEYS) {
    const status = report.oversized.includes(key) ? 'over ceiling' : report.lowerable.includes(key) ? 'lower the ceiling' : 'ok';
    lines.push(`  ${key} ${report.sizes[key]} (${megabytes(report.sizes[key])}) / ceiling ${report.ceiling[key]} (${megabytes(report.ceiling[key])}): ${status}`);
  }
  for (const violation of report.violations) {
    lines.push(`  [${violation.id}] ${violation.paths.length} forbidden file(s):`);
    for (const forbiddenPath of violation.paths.slice(0, LISTED_VIOLATIONS)) lines.push(`    ${forbiddenPath}`);
    if (violation.paths.length > LISTED_VIOLATIONS) lines.push(`    … ${violation.paths.length - LISTED_VIOLATIONS} more`);
  }
  if (report.lowerable.length > 0) {
    lines.push(`  Lower ${report.lowerable.join(', ')} in scripts/packaged-app.config.mjs to lock in the smaller app.`);
  }
  return `${lines.join('\n')}\n`;
}

export async function loadPackagedAppConfig(configPath = DEFAULT_CONFIG_PATH) {
  return validatePackagedAppConfig((await import(pathToFileURL(configPath).href)).default);
}

/** Throws with the report when the packaged app has forbidden content or outgrew its ceiling. */
export async function assertPackagedApp({ appPath, configPath, arch } = {}) {
  const report = checkPackagedApp({ appPath, arch, config: await loadPackagedAppConfig(configPath) });
  const text = formatPackagedAppReport(report);
  if (!report.ok) throw new Error(text);
  process.stdout.write(text);
  return report;
}

const parseArguments = (argv) => {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== '--app' && flag !== '--config' && flag !== '--arch') throw new Error(`Unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (!value) throw new Error(`${flag} requires a value`);
    if (flag === '--arch') options.arch = value;
    else options[flag === '--app' ? 'appPath' : 'configPath'] = path.resolve(process.cwd(), value);
    index += 1;
  }
  return options;
};

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    await assertPackagedApp(parseArguments(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
