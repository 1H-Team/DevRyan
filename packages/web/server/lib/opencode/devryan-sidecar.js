import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { selectedRuntimeBundle } from './runtime-host/runtime-bundle-binding.js';

const DEVRYAN_CONFIG_KEY = 'devryan';
const LEGACY_CONFIG_KEY = 'openchamber';
const DEFAULT_SIDECAR_DIR = path.join(selectedRuntimeBundle?.descriptor.launch.opencodeConfigDirectory ?? path.join(os.homedir(), '.config', 'opencode'), '.devryan');
const DEFAULT_SIDECAR_PATH = path.join(DEFAULT_SIDECAR_DIR, 'config.json');

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function resolveSidecarPath(userConfigPath) {
  if (typeof userConfigPath !== 'string' || userConfigPath.length === 0) {
    return DEFAULT_SIDECAR_PATH;
  }
  // Derive a colocated sidecar so callers that pass a custom opencode config
  // path (test fixtures, alternate user dirs) get their own isolated sidecar
  // and never touch the real user sidecar.
  return path.join(path.dirname(userConfigPath), '.devryan', 'config.json');
}

function resolveLegacySidecarPath(userConfigPath) {
  return path.join(path.dirname(resolveSidecarPath(userConfigPath)), '..', '.openchamber', 'config.json');
}

function ensureSidecarDir(sidecarPath) {
  const dir = path.dirname(sidecarPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  if (!fs.lstatSync(dir).isDirectory()) throw new Error('DevRyan config sidecar is not a directory');
  fs.chmodSync(dir, 0o700);
}

export function getDevRyanSidecarPath(userConfigPath) {
  return resolveSidecarPath(userConfigPath);
}

// Copy legacy managed state before owners switch to .devryan. Existing
// canonical files win, so an interrupted copy can be retried without loss.
export function migrateDevRyanSidecarDirectory(configDirectory = path.dirname(DEFAULT_SIDECAR_DIR)) {
  const legacyRoot = path.join(configDirectory, '.openchamber');
  const canonicalRoot = path.join(configDirectory, '.devryan');
  const markerPath = path.join(canonicalRoot, '.legacy-openchamber-imported');
  const stat = (file) => { try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  const legacyStat = stat(legacyRoot);
  if (!legacyStat) return;
  if (!legacyStat.isDirectory()) throw new Error('Legacy DevRyan config sidecar is not a directory');
  const canonicalStat = stat(canonicalRoot);
  if (canonicalStat && !canonicalStat.isDirectory()) throw new Error('DevRyan config sidecar is not a directory');
  const markerStat = stat(markerPath);
  if (markerStat) {
    if (!markerStat.isFile()) throw new Error('DevRyan config sidecar migration marker is invalid');
    return;
  }

  const copyEntries = (source, target) => {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(target).isDirectory()) throw new Error(`DevRyan config sidecar conflict: ${target}`);
    fs.chmodSync(target, 0o700);
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      const from = path.join(source, entry.name);
      const to = path.join(target, entry.name);
      if (entry.isDirectory()) {
        const targetStat = stat(to);
        if (targetStat && !targetStat.isDirectory()) throw new Error(`DevRyan config sidecar conflict: ${to}`);
        copyEntries(from, to);
      } else if (entry.isFile()) {
        if (stat(to)) continue;
        const temporaryPath = `${to}.${process.pid}.${crypto.randomUUID()}.tmp`;
        try {
          fs.copyFileSync(from, temporaryPath, fs.constants.COPYFILE_EXCL);
          fs.chmodSync(temporaryPath, 0o600);
          try { fs.linkSync(temporaryPath, to); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        } finally {
          if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
        }
      } else {
        throw new Error(`Unsupported legacy DevRyan config sidecar entry: ${from}`);
      }
    }
  };
  copyEntries(legacyRoot, canonicalRoot);
  const temporaryMarker = `${markerPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryMarker, '', { flag: 'wx', mode: 0o600 });
    try { fs.linkSync(temporaryMarker, markerPath); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  } finally {
    if (fs.existsSync(temporaryMarker)) fs.unlinkSync(temporaryMarker);
  }
}

function readSidecarFile(sidecarPath) {
  if (!fs.existsSync(sidecarPath)) return null;
  try {
    const text = fs.readFileSync(sidecarPath, 'utf8').trim();
    if (!text) return null;
    const parsed = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch (error) {
    console.warn('[devryan-sidecar] Failed to read sidecar config:', error);
    return null;
  }
}

export function readDevRyanSidecar(userConfigPath) {
  const legacy = readSidecarFile(resolveLegacySidecarPath(userConfigPath));
  const canonical = readSidecarFile(resolveSidecarPath(userConfigPath));
  return legacy || canonical ? { ...legacy, ...canonical } : null;
}

export function writeDevRyanSidecar(data, userConfigPath) {
  if (!isPlainObject(data)) {
    throw new Error('DevRyan sidecar data must be a plain object');
  }
  const sidecarPath = resolveSidecarPath(userConfigPath);
  ensureSidecarDir(sidecarPath);
  const serialized = JSON.stringify(data, null, 2);
  const temporaryPath = `${sidecarPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(temporaryPath, sidecarPath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

/**
 * One-way migration: if the user's opencode config.json still has a top-level
 * `openchamber` or `devryan` key, copy those settings into the canonical
 * sidecar. The canonical key wins when both are present. Strip both keys from
 * OpenCode's config because it rejects unknown top-level keys on /config.
 */
export function migrateDevRyanConfigToSidecar({ configFile, readConfigFile, writeConfig }) {
  const config = readConfigFile(configFile);
  if (!isPlainObject(config)) return;
  const legacy = config[LEGACY_CONFIG_KEY];
  const canonical = config[DEVRYAN_CONFIG_KEY];
  if (!isPlainObject(legacy) && !isPlainObject(canonical)) return;

  const existingSidecar = readDevRyanSidecar(configFile) || {};
  const merged = { ...existingSidecar, ...(isPlainObject(legacy) ? legacy : {}), ...(isPlainObject(canonical) ? canonical : {}) };
  writeDevRyanSidecar(merged, configFile);

  const sanitized = { ...config };
  delete sanitized[DEVRYAN_CONFIG_KEY];
  delete sanitized[LEGACY_CONFIG_KEY];
  writeConfig(sanitized, configFile);

  console.log('[OpenCode] Migrated legacy DevRyan config into the canonical sidecar');
}

/**
 * Returns the synthetic top-level config DevRyan sees. Legacy config keys and
 * sidecars are accepted, while callers see the canonical `devryan` key.
 */
export function applyDevRyanSidecarToConfig(config, userConfigPath) {
  const sidecar = readDevRyanSidecar(userConfigPath);
  const baseDevRyanConfig = { ...(isPlainObject(config?.[LEGACY_CONFIG_KEY]) ? config[LEGACY_CONFIG_KEY] : {}),
    ...(isPlainObject(config?.[DEVRYAN_CONFIG_KEY]) ? config[DEVRYAN_CONFIG_KEY] : {}) };
  if (!sidecar && Object.keys(baseDevRyanConfig).length === 0) return config;
  const { [LEGACY_CONFIG_KEY]: _legacy, ...other } = isPlainObject(config) ? config : {};
  return {
    ...other,
    [DEVRYAN_CONFIG_KEY]: { ...baseDevRyanConfig, ...sidecar },
  };
}

/**
 * Writes the DevRyan subtree of a synthetic config back to the sidecar.
 * Returns the config with both DevRyan keys stripped, so callers can write
 * the remainder back to opencode's config file without poisoning it.
 */
export function persistDevRyanFromConfig(config, userConfigPath) {
  if (!isPlainObject(config)) return config;
  const devryanSettings = { ...(isPlainObject(config[LEGACY_CONFIG_KEY]) ? config[LEGACY_CONFIG_KEY] : {}),
    ...(isPlainObject(config[DEVRYAN_CONFIG_KEY]) ? config[DEVRYAN_CONFIG_KEY] : {}) };
  if (Object.keys(devryanSettings).length > 0) {
    writeDevRyanSidecar(devryanSettings, userConfigPath);
  }
  const sanitized = { ...config };
  delete sanitized[DEVRYAN_CONFIG_KEY];
  delete sanitized[LEGACY_CONFIG_KEY];
  return sanitized;
}
