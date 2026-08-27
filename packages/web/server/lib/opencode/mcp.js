import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  OPENCODE_CONFIG_DIR,
  CONFIG_FILE,
  CUSTOM_CONFIG_FILE,
  AGENT_SCOPE,
  readConfigFile,
  isPlainObject,
  mergeConfigs,
  writeConfig,
} from './shared.js';
import { isInvalidJsoncError, parseConfigJsonc } from './jsonc-config.js';

// ============== MCP CONFIG HELPERS ==============

/**
 * Validate MCP server name
 */
function validateMcpName(name) {
  if (!name || typeof name !== 'string') {
    throw new Error('MCP server name is required');
  }
  if (!/^[a-z0-9][a-z0-9_-]*[a-z0-9]$|^[a-z0-9]$/.test(name)) {
    throw new Error('MCP server name must be lowercase alphanumeric with hyphens/underscores');
  }
}

/**
 * List all MCP server configs from user-level opencode.json
 */
const OFFICIAL_USER_CONFIG_FILE = path.join(OPENCODE_CONFIG_DIR, 'opencode.json');
const OPENCODE_DATA_DIR = path.join(os.homedir(), '.local', 'share', 'opencode');
const MCP_AUTH_FILE = path.join(OPENCODE_DATA_DIR, 'mcp-auth.json');
const USER_CONFIG_PATHS = [
  CONFIG_FILE,
  OFFICIAL_USER_CONFIG_FILE,
  path.join(OPENCODE_CONFIG_DIR, 'opencode.jsonc'),
];
const MCP_RECOVERY_MANIFEST_PATH = path.join(OPENCODE_CONFIG_DIR, '.openchamber', 'mcp-recovery.json');

function readJsonFileIfPresent(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  try {
    return parseConfigJsonc(fs.readFileSync(filePath, 'utf8'), filePath);
  } catch (error) {
    if (isInvalidJsoncError(error)) throw error;
    throw new Error(`Failed to read ${path.basename(filePath)}`);
  }
}

function writeJsonFileAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);
}

function removeMcpAuthCacheEntry(name) {
  if (!name || typeof name !== 'string' || !fs.existsSync(MCP_AUTH_FILE)) {
    return { ok: true, removed: false };
  }

  try {
    const auth = readJsonFileIfPresent(MCP_AUTH_FILE);
    if (!Object.prototype.hasOwnProperty.call(auth, name)) {
      return { ok: true, removed: false };
    }
    const next = { ...auth };
    delete next[name];
    writeJsonFileAtomic(MCP_AUTH_FILE, next);
    return { ok: true, removed: true };
  } catch (error) {
    return {
      ok: false,
      removed: false,
      error: error.message || 'Failed to reset MCP OAuth cache',
    };
  }
}

function getMcpOAuthCredential(name, serverUrl, now = Date.now()) {
  if (typeof name !== 'string' || !name || typeof serverUrl !== 'string' || !serverUrl) return null;
  if (!Number.isFinite(now) || !fs.existsSync(MCP_AUTH_FILE)) return null;

  const auth = readJsonFileIfPresent(MCP_AUTH_FILE);
  const entry = auth?.[name];
  const tokens = entry?.tokens;
  if (!isPlainObject(entry) || entry.serverUrl !== serverUrl || !isPlainObject(tokens)
    || typeof tokens.accessToken !== 'string' || !tokens.accessToken) {
    return null;
  }
  const expiresAt = Number.isFinite(tokens.expiresAt) ? Number(tokens.expiresAt) : null;
  return Object.freeze({
    authorization: `Bearer ${tokens.accessToken}`,
    expired: expiresAt !== null && (expiresAt * 1_000) <= now,
  });
}

function identityRelevantMcpFields(entry) {
  const normalized = buildMcpEntry(entry);
  return {
    type: normalized.type,
    url: normalized.type === 'remote' ? normalized.url ?? null : null,
    oauth: normalized.type === 'remote' ? normalized.oauth ?? null : null,
  };
}

function didMcpAuthIdentityChange(before, after) {
  return JSON.stringify(identityRelevantMcpFields(before)) !== JSON.stringify(identityRelevantMcpFields(after));
}

function hasMeaningfulOauthFields(oauth) {
  return ['clientId', 'clientSecret', 'scope', 'redirectUri']
    .some((key) => typeof oauth[key] === 'string' && oauth[key].trim());
}

function formatAuthResetResult(result) {
  if (!result || result.ok !== false) {
    return result ?? { ok: true, removed: false };
  }
  return {
    ...result,
    authResetFailed: true,
    warning: result.error || 'MCP OAuth cache could not be reset',
  };
}

function resolveMcpScopeFromPath(layers, sourcePath) {
  if (!sourcePath) return null;
  return layers.projectPaths?.has(sourcePath) ? AGENT_SCOPE.PROJECT : AGENT_SCOPE.USER;
}

function getProjectOfficialConfigPaths(workingDirectory) {
  if (!workingDirectory) return [];
  return [
    path.join(workingDirectory, 'opencode.json'),
    path.join(workingDirectory, 'opencode.jsonc'),
  ];
}

function getProjectLegacyConfigPaths(workingDirectory) {
  if (!workingDirectory) return [];
  return [
    path.join(workingDirectory, '.opencode', 'opencode.json'),
    path.join(workingDirectory, '.opencode', 'opencode.jsonc'),
  ];
}

function getProjectMcpWritePath(workingDirectory) {
  if (!workingDirectory) return null;
  for (const candidate of getProjectLegacyConfigPaths(workingDirectory)) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  for (const candidate of getProjectOfficialConfigPaths(workingDirectory)) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return path.join(workingDirectory, '.opencode', 'opencode.json');
}

function readMcpConfigLayers(workingDirectory) {
  const sources = [];
  const projectPaths = new Set();

  for (const userPath of USER_CONFIG_PATHS) {
    sources.push({
      path: userPath,
      scope: AGENT_SCOPE.USER,
      config: readConfigFile(userPath),
    });
  }

  for (const projectPath of getProjectLegacyConfigPaths(workingDirectory)) {
    projectPaths.add(projectPath);
    sources.push({
      path: projectPath,
      scope: AGENT_SCOPE.PROJECT,
      config: readConfigFile(projectPath),
    });
  }

  for (const projectPath of getProjectOfficialConfigPaths(workingDirectory)) {
    projectPaths.add(projectPath);
    sources.push({
      path: projectPath,
      scope: AGENT_SCOPE.PROJECT,
      config: readConfigFile(projectPath),
    });
  }

  if (CUSTOM_CONFIG_FILE) {
    sources.push({
      path: CUSTOM_CONFIG_FILE,
      scope: AGENT_SCOPE.USER,
      config: readConfigFile(CUSTOM_CONFIG_FILE),
    });
  }

  let mergedConfig = {};
  const sourceByName = new Map();
  for (const source of sources) {
    mergedConfig = mergeConfigs(mergedConfig, source.config || {});
    const mcp = source.config?.mcp;
    if (!isPlainObject(mcp)) continue;
    for (const [name, section] of Object.entries(mcp)) {
      if (section !== undefined) {
        sourceByName.set(name, {
          section,
          config: source.config,
          path: source.path,
          scope: source.scope,
          exists: true,
        });
      }
    }
  }

  return {
    mergedConfig,
    sources,
    sourceByName,
    projectPaths,
    paths: {
      userPath: OFFICIAL_USER_CONFIG_FILE,
      projectPath: getProjectMcpWritePath(workingDirectory),
      customPath: CUSTOM_CONFIG_FILE,
    },
  };
}

function getMcpEntrySource(layers, name) {
  return layers.sourceByName.get(name) || {
    section: null,
    config: null,
    path: null,
    scope: null,
    exists: false,
  };
}

function listMcpConfigs(workingDirectory) {
  const layers = readMcpConfigLayers(workingDirectory);
  const mcp = layers?.mergedConfig?.mcp || {};

  return Object.entries(mcp)
    .filter(([, entry]) => entry && typeof entry === 'object' && !Array.isArray(entry))
    .map(([name, entry]) => {
      const source = getMcpEntrySource(layers, name);
      return {
        name,
        ...buildMcpEntry(entry),
        scope: resolveMcpScopeFromPath(layers, source.path),
      };
    });
}

/**
 * Get a single MCP server config by name
 */
function getMcpConfig(name, workingDirectory) {
  const layers = readMcpConfigLayers(workingDirectory);
  const entry = layers?.mergedConfig?.mcp?.[name];

  if (!entry) {
    return null;
  }
  const source = getMcpEntrySource(layers, name);
  return {
    name,
    ...buildMcpEntry(entry),
    scope: resolveMcpScopeFromPath(layers, source.path),
  };
}

/**
 * Create a new MCP server config entry
 */
function createMcpConfig(name, mcpConfig, workingDirectory, scope) {
  validateMcpName(name);

  const layers = readMcpConfigLayers(workingDirectory);
  const source = getMcpEntrySource(layers, name);
  if (source.exists) {
    throw new Error(`MCP server "${name}" already exists`);
  }

  let targetPath = OFFICIAL_USER_CONFIG_FILE;
  let config = {};

  if (scope === AGENT_SCOPE.PROJECT) {
    if (!workingDirectory) {
      throw new Error('Project scope requires working directory');
    }
    targetPath = getProjectMcpWritePath(workingDirectory);
    config = fs.existsSync(targetPath) ? readConfigFile(targetPath) : {};
  } else {
    config = fs.existsSync(targetPath) ? readConfigFile(targetPath) : {};
  }

  if (!config.mcp || typeof config.mcp !== 'object' || Array.isArray(config.mcp)) {
    config.mcp = {};
  }

  const { name: _ignoredName, ...entryData } = mcpConfig;
  config.mcp[name] = buildMcpEntry(entryData);

  writeConfig(config, targetPath);
  console.log(`Created MCP server config: ${name}`);
  return { changed: true, authReset: formatAuthResetResult(removeMcpAuthCacheEntry(name)) };
}

/**
 * Update an existing MCP server config entry
 */
function updateMcpConfig(name, updates, workingDirectory) {
  const layers = readMcpConfigLayers(workingDirectory);
  const source = getMcpEntrySource(layers, name);

  if (!source.exists) {
    throw new Error(`MCP server "${name}" not found`);
  }

  const targetPath = source.path || OFFICIAL_USER_CONFIG_FILE;
  const config = source.config || (fs.existsSync(targetPath) ? readConfigFile(targetPath) : {});

  if (!config.mcp || typeof config.mcp !== 'object' || Array.isArray(config.mcp)) {
    config.mcp = {};
  }

  const existing = config.mcp[name];
  const { name: _ignoredName, ...updateData } = updates;

  // A bare `{}` oauth payload (every field blank) is a no-op, not a request to
  // clear oauth: merging it would erase the stored oauth object and read as an
  // identity change, wiping the cached OAuth tokens. Explicit `oauth: false`
  // still clears.
  if (
    updateData.oauth
    && typeof updateData.oauth === 'object'
    && !Array.isArray(updateData.oauth)
    && !hasMeaningfulOauthFields(updateData.oauth)
  ) {
    delete updateData.oauth;
  }

  const currentEntry = buildMcpEntry(existing);
  const nextEntry = buildMcpEntry({ ...existing, ...updateData });
  if (isDeepStrictEqual(currentEntry, nextEntry)) {
    return { changed: false, authReset: { ok: true, removed: false } };
  }

  const shouldResetAuth = didMcpAuthIdentityChange(currentEntry, nextEntry);
  config.mcp[name] = nextEntry;

  writeConfig(config, targetPath);
  console.log(`Updated MCP server config: ${name}`);
  return {
    changed: true,
    authReset: shouldResetAuth
      ? formatAuthResetResult(removeMcpAuthCacheEntry(name))
      : { ok: true, removed: false },
  };
}

/**
 * Delete an MCP server config entry
 */
function deleteMcpConfig(name, workingDirectory) {
  const layers = readMcpConfigLayers(workingDirectory);
  const source = getMcpEntrySource(layers, name);
  if (!source.exists) {
    throw new Error(`MCP server "${name}" not found`);
  }

  for (const candidate of layers.sources) {
    const config = candidate.config || {};
    if (!config.mcp || typeof config.mcp !== 'object' || config.mcp[name] === undefined) {
      continue;
    }

    delete config.mcp[name];

    if (Object.keys(config.mcp).length === 0) {
      delete config.mcp;
    }

    writeConfig(config, candidate.path);
  }
  console.log(`Deleted MCP server config: ${name}`);
  markMcpRecoveryDeleted(name);
  return { changed: true, authReset: formatAuthResetResult(removeMcpAuthCacheEntry(name)) };
}

/**
 * Build a clean MCP entry object, omitting undefined/null values
 */
function buildMcpEntry(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    data = {};
  }
  const entry = (data && typeof data === 'object' && !Array.isArray(data))
    ? { ...data }
    : {};

  delete entry.name;
  delete entry.scope;

  // type is required
  entry.type = data.type === 'remote' || (data.type !== 'local' && typeof data.url === 'string' && data.url.trim())
    ? 'remote'
    : 'local';

  if (entry.type === 'local') {
    // command must be a non-empty array of strings
    if (Array.isArray(data.command) && data.command.length > 0) {
      entry.command = data.command.map(String);
    } else {
      delete entry.command;
    }

    delete entry.url;
    delete entry.headers;
    delete entry.oauth;
    delete entry.timeout;
  } else {
    // remote: url required
    if (data.url && typeof data.url === 'string') {
      entry.url = data.url.trim();
    } else {
      delete entry.url;
    }

    delete entry.command;

    if (data.headers && typeof data.headers === 'object' && !Array.isArray(data.headers)) {
      const cleaned = {};
      for (const [k, v] of Object.entries(data.headers)) {
        if (k && v !== undefined && v !== null) {
          cleaned[k] = String(v);
        }
      }
      if (Object.keys(cleaned).length > 0) {
        entry.headers = cleaned;
      } else {
        delete entry.headers;
      }
    } else if (data.headers === undefined) {
      delete entry.headers;
    }

    if (data.oauth === false) {
      entry.oauth = false;
    } else if (data.oauth && typeof data.oauth === 'object' && !Array.isArray(data.oauth)) {
      const oauth = {};
      if (typeof data.oauth.clientId === 'string' && data.oauth.clientId.trim()) {
        oauth.clientId = data.oauth.clientId.trim();
      }
      if (typeof data.oauth.clientSecret === 'string' && data.oauth.clientSecret.trim()) {
        oauth.clientSecret = data.oauth.clientSecret.trim();
      }
      if (typeof data.oauth.scope === 'string' && data.oauth.scope.trim()) {
        oauth.scope = data.oauth.scope.trim();
      }
      if (typeof data.oauth.redirectUri === 'string' && data.oauth.redirectUri.trim()) {
        oauth.redirectUri = data.oauth.redirectUri.trim();
      }
      if (Object.keys(oauth).length > 0) {
        entry.oauth = oauth;
      } else {
        delete entry.oauth;
      }
    } else if (data.oauth === undefined) {
      delete entry.oauth;
    }

    if (typeof data.timeout === 'number' && Number.isFinite(data.timeout) && data.timeout > 0) {
      entry.timeout = data.timeout;
    } else if (data.timeout === undefined || data.timeout === null || data.timeout === '') {
      delete entry.timeout;
    }
  }

  // environment: flat Record<string, string>
  if (data.environment && typeof data.environment === 'object' && !Array.isArray(data.environment)) {
    const cleaned = {};
    for (const [k, v] of Object.entries(data.environment)) {
      if (k && v !== undefined && v !== null) {
        cleaned[k] = String(v);
      }
    }
    if (Object.keys(cleaned).length > 0) {
      entry.environment = cleaned;
    } else {
      delete entry.environment;
    }
  } else if (data.environment === undefined) {
    delete entry.environment;
  }

  // enabled defaults to true
  entry.enabled = data.enabled !== false;

  return entry;
}

function splitCommandString(value) {
  return value.trim().split(/\s+/).filter(Boolean);
}

function normalizeLegacyMcpServer(raw) {
  if (!isPlainObject(raw)) return null;

  const command = [];
  if (Array.isArray(raw.command)) {
    command.push(...raw.command.map(String).filter((value) => value.trim()));
  } else if (typeof raw.command === 'string' && raw.command.trim()) {
    command.push(...splitCommandString(raw.command));
  }

  if (Array.isArray(raw.args)) {
    command.push(...raw.args.map(String).filter((value) => value.trim()));
  }

  const entry = {
    ...raw,
    type: raw.type === 'remote' || (typeof raw.url === 'string' && raw.url.trim()) ? 'remote' : 'local',
  };

  if (command.length > 0) {
    entry.command = command;
  }

  if (!entry.environment && isPlainObject(raw.env)) {
    entry.environment = raw.env;
  }

  delete entry.args;
  delete entry.env;

  return entry;
}

function isRecoverableMcpEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  if (entry.type === 'remote') {
    return typeof entry.url === 'string' && entry.url.trim().length > 0;
  }
  return Array.isArray(entry.command) && entry.command.length > 0;
}

function recoveryFingerprint(sourcePath, name, raw) {
  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify(raw))
    .digest('hex');
  return `${sourcePath}::${name}::${hash}`;
}

function readRecoveryManifest() {
  try {
    const parsed = readConfigFile(MCP_RECOVERY_MANIFEST_PATH);
    return {
      version: 1,
      considered: isPlainObject(parsed?.considered) ? parsed.considered : {},
      deleted: isPlainObject(parsed?.deleted) ? parsed.deleted : {},
    };
  } catch {
    // Treat an unreadable manifest as empty. Recovery still never overwrites active entries.
  }
  return { version: 1, considered: {}, deleted: {} };
}

function writeRecoveryManifest(manifest) {
  fs.mkdirSync(path.dirname(MCP_RECOVERY_MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MCP_RECOVERY_MANIFEST_PATH, JSON.stringify({
    version: 1,
    considered: isPlainObject(manifest?.considered) ? manifest.considered : {},
    deleted: isPlainObject(manifest?.deleted) ? manifest.deleted : {},
  }, null, 2), 'utf8');
}

function markMcpRecoveryDeleted(name) {
  if (!name || typeof name !== 'string') return;
  const manifest = readRecoveryManifest();
  manifest.deleted[name] = { deletedAt: Date.now() };
  writeRecoveryManifest(manifest);
}

function backupPathsFor(configPath) {
  return [
    `${configPath}.openchamber.backup`,
    `${configPath}.bak`,
  ];
}

function addRecoverySource(sources, filePath, scope, targetPath) {
  if (!filePath || !fs.existsSync(filePath)) return;
  sources.push({ filePath, scope, targetPath });
}

function writeRecoveredConfig(config, filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf8');
}

function getRecoverySources(workingDirectory) {
  const sources = [];

  for (const userPath of USER_CONFIG_PATHS) {
    for (const backupPath of backupPathsFor(userPath)) {
      addRecoverySource(sources, backupPath, AGENT_SCOPE.USER, OFFICIAL_USER_CONFIG_FILE);
    }
  }

  if (workingDirectory) {
    const projectTargetPath = getProjectMcpWritePath(workingDirectory);
    for (const projectPath of getProjectOfficialConfigPaths(workingDirectory)) {
      for (const backupPath of backupPathsFor(projectPath)) {
        addRecoverySource(sources, backupPath, AGENT_SCOPE.PROJECT, projectTargetPath);
      }
    }

    for (const legacyPath of getProjectLegacyConfigPaths(workingDirectory)) {
      addRecoverySource(sources, legacyPath, AGENT_SCOPE.PROJECT, projectTargetPath);
      for (const backupPath of backupPathsFor(legacyPath)) {
        addRecoverySource(sources, backupPath, AGENT_SCOPE.PROJECT, projectTargetPath);
      }
    }
  }

  return sources;
}

function collectRecoveryEntries(source) {
  const config = readConfigFile(source.filePath);
  const entries = [];

  if (isPlainObject(config.mcp)) {
    for (const [name, raw] of Object.entries(config.mcp)) {
      if (isPlainObject(raw)) {
        entries.push({ name, raw, entry: buildMcpEntry(raw) });
      }
    }
  }

  if (isPlainObject(config.mcpServers)) {
    for (const [name, raw] of Object.entries(config.mcpServers)) {
      const normalized = normalizeLegacyMcpServer(raw);
      if (normalized) {
        entries.push({ name, raw: normalized, entry: buildMcpEntry(normalized) });
      }
    }
  }

  return entries;
}

function recoverMcpConfigs(workingDirectory) {
  const manifest = readRecoveryManifest();
  const migrated = [];
  const skipped = [];
  let manifestChanged = false;
  const layers = readMcpConfigLayers(workingDirectory);
  const legacyProjectPaths = new Set(getProjectLegacyConfigPaths(workingDirectory));
  const projectTargetPath = getProjectMcpWritePath(workingDirectory);
  const activeNames = new Set();
  for (const [name, source] of layers.sourceByName.entries()) {
    if (!legacyProjectPaths.has(source.path) || source.path === projectTargetPath) {
      activeNames.add(name);
    }
  }

  for (const source of getRecoverySources(workingDirectory)) {
    for (const candidate of collectRecoveryEntries(source)) {
      const name = candidate.name;
      const fingerprint = recoveryFingerprint(source.filePath, name, candidate.raw);

      if (manifest.considered[fingerprint]) {
        skipped.push({ name, reason: 'already considered' });
        continue;
      }

      try {
        validateMcpName(name);
      } catch {
        skipped.push({ name, reason: 'invalid name' });
        continue;
      }

      if (manifest.deleted[name]) {
        skipped.push({ name, reason: 'deleted' });
        if (!manifest.considered[fingerprint]) {
          manifest.considered[fingerprint] = {
            name,
            sourcePath: source.filePath,
            targetPath: source.targetPath,
            skippedAt: Date.now(),
            reason: 'deleted',
          };
          manifestChanged = true;
        }
        continue;
      }

      if (activeNames.has(name)) {
        skipped.push({ name, reason: 'already configured' });
        continue;
      }

      if (!isRecoverableMcpEntry(candidate.entry)) {
        skipped.push({ name, reason: 'invalid config' });
        continue;
      }

      const targetPath = source.targetPath;
      const targetConfig = readConfigFile(targetPath);
      const targetMcp = isPlainObject(targetConfig.mcp) ? targetConfig.mcp : {};
      targetConfig.mcp = {
        ...targetMcp,
        [name]: candidate.entry,
      };
      writeRecoveredConfig(targetConfig, targetPath);

      manifest.considered[fingerprint] = {
        name,
        sourcePath: source.filePath,
        targetPath,
        recoveredAt: Date.now(),
      };
      manifestChanged = true;
      activeNames.add(name);
      migrated.push({ name, scope: source.scope, targetPath });
    }
  }

  if (manifestChanged) {
    writeRecoveryManifest(manifest);
  }

  return { migrated, skipped };
}

export {
  listMcpConfigs,
  getMcpConfig,
  getMcpOAuthCredential,
  createMcpConfig,
  updateMcpConfig,
  deleteMcpConfig,
  recoverMcpConfigs,
};
