import os from 'os';
import path from 'path';

import { buildDevRyanDefaultPluginInventory } from './default-plugins.js';
import { readConfigFile as defaultReadConfigFile } from './shared.js';

const PLUGIN_FILE_NAME_PATTERN = /^[a-z0-9][a-z0-9-_.]*\.(js|ts|mjs|cjs)$/;

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const encodePluginId = (prefix, value) => Buffer.from(`${prefix}:${value}`).toString('base64url');

const isPathSpec = (spec) => (
  spec.startsWith('/')
  || spec.startsWith('./')
  || spec.startsWith('../')
  || spec.startsWith('~')
  || path.win32.isAbsolute(spec)
);

const parsedKindForSpec = (spec) => (isPathSpec(spec) ? 'path' : 'npm');

const validatePluginSpec = (spec) => {
  if (typeof spec !== 'string' || !spec.trim()) {
    throw new Error('Plugin spec must be a non-empty string');
  }
  if (spec.includes('\0')) {
    throw new Error('Plugin spec cannot contain null bytes');
  }
  return spec.trim();
};

const parsePluginRaw = (raw) => {
  if (typeof raw === 'string') {
    return { spec: validatePluginSpec(raw) };
  }
  if (Array.isArray(raw) && raw.length === 2 && isRecord(raw[1])) {
    return { spec: validatePluginSpec(raw[0]), options: { ...raw[1] } };
  }
  throw new Error('Plugin entry must be a string or [string, object]');
};

const getUserConfigPaths = (homeDir, pathApi) => {
  const configDir = pathApi.join(homeDir, '.config', 'opencode');
  return [
    pathApi.join(configDir, 'config.json'),
    pathApi.join(configDir, 'opencode.json'),
    pathApi.join(configDir, 'opencode.jsonc'),
  ];
};

const getFirstExistingPath = (fs, candidates) => candidates.find((candidate) => {
  try {
    return fs.existsSync(candidate);
  } catch {
    return false;
  }
}) || null;

const getProjectConfigPath = (fs, pathApi, workingDirectory) => {
  if (!workingDirectory) {
    return null;
  }
  const candidates = [
    pathApi.join(workingDirectory, 'opencode.json'),
    pathApi.join(workingDirectory, 'opencode.jsonc'),
    pathApi.join(workingDirectory, '.opencode', 'opencode.json'),
    pathApi.join(workingDirectory, '.opencode', 'opencode.jsonc'),
  ];
  return getFirstExistingPath(fs, candidates);
};

const readConfigSafe = (readConfigFile, source, errors) => {
  try {
    return readConfigFile(source.path) || {};
  } catch (error) {
    errors.push({
      scope: source.scope,
      sourcePath: source.path,
      index: null,
      message: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
};

const listEntriesFromSource = (source, config, errors) => {
  if (!Array.isArray(config?.plugin)) {
    return [];
  }

  const entries = [];
  config.plugin.forEach((raw, index) => {
    try {
      const parsed = parsePluginRaw(raw);
      entries.push({
        id: encodePluginId('config', `${source.scope}:${source.path}:${index}:${parsed.spec}`),
        spec: parsed.spec,
        ...(parsed.options !== undefined ? { options: parsed.options } : {}),
        scope: source.scope,
        kind: 'config',
        parsedKind: parsedKindForSpec(parsed.spec),
        sourcePath: source.path,
      });
    } catch (error) {
      errors.push({
        scope: source.scope,
        sourcePath: source.path,
        index,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
  return entries;
};

const listPluginFilesForScope = (fs, pathApi, scope, pluginDir) => {
  try {
    if (!fs.existsSync(pluginDir)) {
      return [];
    }
    return fs.readdirSync(pluginDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && PLUGIN_FILE_NAME_PATTERN.test(entry.name))
      .map((entry) => ({
        id: encodePluginId('file', `${scope}:${pluginDir}:${entry.name}`),
        fileName: entry.name,
        scope,
        kind: 'file',
        absolutePath: pathApi.join(pluginDir, entry.name),
      }));
  } catch {
    return [];
  }
};

export const createPluginReadModel = (dependencies = {}) => {
  const fs = dependencies.fs;
  const pathApi = dependencies.path || path;
  const homedir = dependencies.homedir || (() => os.homedir());
  const env = dependencies.env || process.env;
  const readConfigFile = dependencies.readConfigFile || defaultReadConfigFile;

  if (!fs) {
    throw new Error('createPluginReadModel requires fs dependency');
  }

  const listPlugins = (workingDirectory) => {
    const errors = [];
    const homeDir = homedir();
    const customConfigPath = env.OPENCODE_CONFIG ? pathApi.resolve(env.OPENCODE_CONFIG) : null;
    const userConfigPath = customConfigPath || getFirstExistingPath(fs, getUserConfigPaths(homeDir, pathApi));
    const userConfigDir = customConfigPath ? pathApi.dirname(customConfigPath) : pathApi.join(homeDir, '.config', 'opencode');
    const projectConfigPath = getProjectConfigPath(fs, pathApi, workingDirectory);

    const sources = [];
    if (userConfigPath) {
      sources.push({ scope: 'user', path: userConfigPath });
    }
    if (projectConfigPath) {
      sources.push({ scope: 'project', path: projectConfigPath });
    }

    const entries = sources.flatMap((source) => {
      const config = readConfigSafe(readConfigFile, source, errors);
      return listEntriesFromSource(source, config, errors);
    });

    const files = [
      ...listPluginFilesForScope(fs, pathApi, 'user', pathApi.join(userConfigDir, 'plugin')),
      ...listPluginFilesForScope(fs, pathApi, 'user', pathApi.join(userConfigDir, 'plugins')),
      ...(workingDirectory
        ? [
            ...listPluginFilesForScope(fs, pathApi, 'project', pathApi.join(workingDirectory, '.opencode', 'plugin')),
            ...listPluginFilesForScope(fs, pathApi, 'project', pathApi.join(workingDirectory, '.opencode', 'plugins')),
          ]
        : []),
    ];

    return { ...buildDevRyanDefaultPluginInventory({ entries, files }), errors };
  };

  return { listPlugins };
};

export const registerReadonlyPluginRoutes = (app, dependencies) => {
  const {
    resolveOptionalProjectDirectory,
    listPlugins,
  } = dependencies;

  app.get('/api/config/plugins', async (req, res) => {
    try {
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      return res.json(listPlugins(directory || null));
    } catch (error) {
      console.error('[API:GET /api/config/plugins] Failed:', error);
      return res.status(500).json({ error: 'Failed to list plugins' });
    }
  });
};
