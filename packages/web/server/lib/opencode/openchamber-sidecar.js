import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { selectedRuntimeBundle } from './runtime-host/runtime-bundle-binding.js';

const OPENCHAMBER_CONFIG_KEY = 'openchamber';
const DEFAULT_SIDECAR_DIR = path.join(selectedRuntimeBundle?.descriptor.launch.opencodeConfigDirectory ?? path.join(os.homedir(), '.config', 'opencode'), '.openchamber');
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
  return path.join(path.dirname(userConfigPath), '.openchamber', 'config.json');
}

function ensureSidecarDir(sidecarPath) {
  const dir = path.dirname(sidecarPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function getOpenchamberSidecarPath(userConfigPath) {
  return resolveSidecarPath(userConfigPath);
}

export function readOpenchamberSidecar(userConfigPath) {
  const sidecarPath = resolveSidecarPath(userConfigPath);
  if (!fs.existsSync(sidecarPath)) return null;
  try {
    const text = fs.readFileSync(sidecarPath, 'utf8').trim();
    if (!text) return null;
    const parsed = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch (error) {
    console.warn('[openchamber-sidecar] Failed to read sidecar config:', error);
    return null;
  }
}

export function writeOpenchamberSidecar(data, userConfigPath) {
  if (!isPlainObject(data)) {
    throw new Error('Openchamber sidecar data must be a plain object');
  }
  const sidecarPath = resolveSidecarPath(userConfigPath);
  ensureSidecarDir(sidecarPath);
  const serialized = JSON.stringify(data, null, 2);
  fs.writeFileSync(sidecarPath, serialized, 'utf8');
}

/**
 * One-way migration: if the user's opencode config.json still has a top-level
 * `openchamber` key (legacy storage), copy that subtree into the sidecar (merging
 * with anything already there, with the on-disk legacy value winning on conflict
 * to avoid losing edits the user made while DevRyan wasn't running), then strip
 * the key from opencode's config file. opencode hot-reads that file, so leaving
 * the key in place would cause it to error out at runtime on /config.
 */
export function migrateOpenchamberConfigToSidecar({ configFile, readConfigFile, writeConfig }) {
  const config = readConfigFile(configFile);
  if (!isPlainObject(config)) return;
  const legacy = config[OPENCHAMBER_CONFIG_KEY];
  if (!isPlainObject(legacy)) return;

  const existingSidecar = readOpenchamberSidecar(configFile) || {};
  const merged = { ...existingSidecar, ...legacy };
  writeOpenchamberSidecar(merged, configFile);

  const sanitized = { ...config };
  delete sanitized[OPENCHAMBER_CONFIG_KEY];
  writeConfig(sanitized, configFile);

  console.log(`[OpenCode] Migrated openchamber config key from ${configFile} to sidecar ${resolveSidecarPath(configFile)}`);
}

/**
 * Returns the synthetic top-level config DevRyan sees. Merges the openchamber
 * sidecar into the live opencode config under the `openchamber` key so existing
 * code paths (agents.js' getAgentOverridesContainer etc.) keep working without
 * caring where the data physically lives.
 */
export function applyOpenchamberSidecarToConfig(config, userConfigPath) {
  const sidecar = readOpenchamberSidecar(userConfigPath);
  if (!sidecar) return config;
  const baseOpenchamber = isPlainObject(config?.[OPENCHAMBER_CONFIG_KEY])
    ? config[OPENCHAMBER_CONFIG_KEY]
    : {};
  return {
    ...(isPlainObject(config) ? config : {}),
    [OPENCHAMBER_CONFIG_KEY]: { ...baseOpenchamber, ...sidecar },
  };
}

/**
 * Writes the openchamber subtree of a synthetic config back to the sidecar.
 * Returns the config with the openchamber key stripped, so callers can write
 * the remainder back to opencode's config file without poisoning it.
 */
export function persistOpenchamberFromConfig(config, userConfigPath) {
  if (!isPlainObject(config)) return config;
  const openchamber = config[OPENCHAMBER_CONFIG_KEY];
  if (isPlainObject(openchamber)) {
    writeOpenchamberSidecar(openchamber, userConfigPath);
  }
  const sanitized = { ...config };
  delete sanitized[OPENCHAMBER_CONFIG_KEY];
  return sanitized;
}
