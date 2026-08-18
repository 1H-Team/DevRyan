import { spawn as spawnChild } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';

import {
  DEVRYAN_SLIM_WRAPPER_PLUGIN_FILE,
  DEVRYAN_SLIM_WRAPPER_PLUGIN_SPEC,
  SLIM_MANAGED_VERSION,
  SLIM_PLUGIN_PACKAGE_NAME,
  isDevRyanSlimWrapperPluginSpec,
  isSlimPluginSpec,
} from './slim-config.js';

const OPEN_CODE_CONFIG_FILE_CANDIDATES = ['opencode.json', 'opencode.jsonc', 'config.json'];

const DEFAULT_SLIM_CONFIG = {
  $schema: 'https://raw.githubusercontent.com/alvinunreal/oh-my-opencode-slim/main/schema.json',
  preset: 'openai',
  companion: { enabled: false },
  presets: {
    openai: {
      orchestrator: { model: 'openai/gpt-5.5', variant: 'medium', skills: ['*'], mcps: [] },
      oracle: { model: 'openai/gpt-5.5', variant: 'high', skills: ['*'], mcps: [] },
      librarian: { model: 'openai/gpt-5.4-mini', variant: 'low', skills: ['codemap'], mcps: [] },
      explorer: { model: 'openai/gpt-5.4-mini', variant: 'low', skills: ['codemap'], mcps: [] },
      designer: { model: 'openai/gpt-5.4-mini', variant: 'medium', skills: [], mcps: [] },
      fixer: { model: 'openai/gpt-5.5', variant: 'low', skills: [], mcps: [] },
    },
    'opencode-go': {
      orchestrator: { model: 'opencode-go/glm-5.1', skills: ['*'], mcps: [] },
      oracle: { model: 'opencode-go/deepseek-v4-pro', variant: 'max', skills: ['*'], mcps: [] },
      council: { model: 'opencode-go/deepseek-v4-pro', variant: 'high', skills: [], mcps: [] },
      librarian: { model: 'opencode-go/minimax-m2.7', skills: ['codemap'], mcps: [] },
      explorer: { model: 'opencode-go/minimax-m2.7', skills: ['codemap'], mcps: [] },
      designer: { model: 'opencode-go/kimi-k2.6', variant: 'medium', skills: [], mcps: [] },
      fixer: { model: 'opencode-go/deepseek-v4-flash', variant: 'high', skills: [], mcps: [] },
      observer: { model: 'opencode-go/kimi-k2.6', skills: [], mcps: [] },
    },
  },
};

const WRAPPER_PLUGIN_SOURCE = `import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const cloneValue = (value) => {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
};

const loadSlimPlugin = async () => {
  const roots = [
    process.env.DEVRYAN_OPENCODE_USER_CONFIG_DIR,
    process.env.OPENCODE_CONFIG_DIR,
    process.cwd(),
  ].filter(Boolean);

  let lastError = null;
  for (const root of roots) {
    try {
      const pluginEntrypoint = path.join(root, 'node_modules', 'oh-my-opencode-slim', 'dist', 'index.js');
      if (!fs.existsSync(pluginEntrypoint)) {
        continue;
      }
      const module = await import(pathToFileURL(pluginEntrypoint).href);
      return module.default || module;
    } catch (error) {
      lastError = error;
    }
  }

  try {
    const module = await import('oh-my-opencode-slim');
    return module.default || module;
  } catch (error) {
    throw lastError || error;
  }
};

export const DevRyanOhMyOpenCodeSlimPlugin = async (context) => {
  const slimPlugin = await loadSlimPlugin();
  const plugin = await slimPlugin(context);
  if (!isRecord(plugin)) {
    return plugin;
  }

  const slimConfigHook = typeof plugin.config === 'function' ? plugin.config : null;
  delete plugin.agent;
  delete plugin['experimental.chat.system.transform'];

  return {
    ...plugin,
    name: 'devryan-oh-my-opencode-slim',
    async config(config) {
      if (!slimConfigHook || !isRecord(config)) {
        return;
      }

      const hadAgent = Object.prototype.hasOwnProperty.call(config, 'agent');
      const previousAgent = hadAgent ? cloneValue(config.agent) : undefined;
      const hadDefaultAgent = Object.prototype.hasOwnProperty.call(config, 'default_agent');
      const previousDefaultAgent = hadDefaultAgent ? config.default_agent : undefined;

      await slimConfigHook(config);

      if (hadAgent) {
        config.agent = previousAgent;
      } else {
        delete config.agent;
      }

      if (hadDefaultAgent) {
        config.default_agent = previousDefaultAgent;
      } else {
        delete config.default_agent;
      }
    },
  };
};

export default DevRyanOhMyOpenCodeSlimPlugin;
`;

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const cloneJson = (value) => JSON.parse(JSON.stringify(value));

const pluginSpecFromEntry = (entry) => {
  if (typeof entry === 'string') return entry.trim();
  if (Array.isArray(entry) && typeof entry[0] === 'string') return entry[0].trim();
  return '';
};

const readJsoncFile = (fsApi, filePath) => {
  if (!filePath || !fsApi.existsSync(filePath)) return {};
  const content = fsApi.readFileSync(filePath, 'utf8').trim();
  if (!content) return {};
  const parsed = parseJsonc(content, [], { allowTrailingComma: true });
  return isRecord(parsed) ? parsed : {};
};

const writeJsonFile = (fsApi, filePath, value) => {
  fsApi.mkdirSync(path.dirname(filePath), { recursive: true });
  fsApi.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

const getConfigDirectory = ({ pathApi, homedir, configDirectory }) => (
  configDirectory ? pathApi.resolve(configDirectory) : pathApi.join(homedir(), '.config', 'opencode')
);

const findOpenCodeConfigPath = ({ fsApi, pathApi, configDirectory }) => {
  for (const fileName of OPEN_CODE_CONFIG_FILE_CANDIDATES) {
    const candidate = pathApi.join(configDirectory, fileName);
    if (fsApi.existsSync(candidate)) return candidate;
  }
  return pathApi.join(configDirectory, 'opencode.json');
};

const findSlimConfigPath = ({ fsApi, pathApi, configDirectory }) => {
  for (const fileName of ['oh-my-opencode-slim.json', 'oh-my-opencode-slim.jsonc']) {
    const candidate = pathApi.join(configDirectory, fileName);
    if (fsApi.existsSync(candidate)) return candidate;
  }
  return null;
};

const makeBackupPath = (filePath, timestamp) => `${filePath}.devryan-slim-backup-${timestamp}`;

const createWriteTracker = ({ fsApi, now }) => {
  const changedFiles = [];
  const backupPaths = [];
  const timestamp = now().toISOString().replace(/[-:.]/g, '').replace('Z', 'Z');

  const backupIfPresent = (filePath) => {
    if (!fsApi.existsSync(filePath)) return null;
    const backupPath = makeBackupPath(filePath, timestamp);
    fsApi.mkdirSync(path.dirname(backupPath), { recursive: true });
    fsApi.copyFileSync(filePath, backupPath);
    backupPaths.push(backupPath);
    return backupPath;
  };

  const writeJsonTracked = (filePath, value) => {
    const nextContent = `${JSON.stringify(value, null, 2)}\n`;
    const currentContent = fsApi.existsSync(filePath) ? fsApi.readFileSync(filePath, 'utf8') : null;
    if (currentContent === nextContent) return false;
    backupIfPresent(filePath);
    fsApi.mkdirSync(path.dirname(filePath), { recursive: true });
    fsApi.writeFileSync(filePath, nextContent, 'utf8');
    changedFiles.push(filePath);
    return true;
  };

  const writeTextTracked = (filePath, content) => {
    const currentContent = fsApi.existsSync(filePath) ? fsApi.readFileSync(filePath, 'utf8') : null;
    if (currentContent === content) return false;
    backupIfPresent(filePath);
    fsApi.mkdirSync(path.dirname(filePath), { recursive: true });
    fsApi.writeFileSync(filePath, content, 'utf8');
    changedFiles.push(filePath);
    return true;
  };

  return {
    changedFiles,
    backupPaths,
    backupIfPresent,
    writeJsonTracked,
    writeTextTracked,
  };
};

const normalizePluginEntries = (entries) => {
  const plugin = Array.isArray(entries) ? entries : [];
  const preserved = [];
  for (const entry of plugin) {
    const spec = pluginSpecFromEntry(entry);
    if (isSlimPluginSpec(spec) || isDevRyanSlimWrapperPluginSpec(spec)) {
      continue;
    }
    preserved.push(entry);
  }
  preserved.push(DEVRYAN_SLIM_WRAPPER_PLUGIN_SPEC);
  return preserved;
};

const updateOpenCodeConfig = (config) => {
  const next = isRecord(config) ? { ...config } : {};
  next.plugin = normalizePluginEntries(next.plugin);
  const agent = isRecord(next.agent) ? { ...next.agent } : {};
  agent.explore = { ...(isRecord(agent.explore) ? agent.explore : {}), disable: true };
  agent.general = { ...(isRecord(agent.general) ? agent.general : {}), disable: true };
  next.agent = agent;
  if (!Object.prototype.hasOwnProperty.call(next, 'lsp')) {
    next.lsp = true;
  }
  return next;
};

const updatePackageJson = (packageJson) => {
  const next = isRecord(packageJson) ? { ...packageJson } : {};
  const dependencies = isRecord(next.dependencies) ? { ...next.dependencies } : {};
  dependencies[SLIM_PLUGIN_PACKAGE_NAME] = SLIM_MANAGED_VERSION;
  next.dependencies = dependencies;
  return next;
};

const runCommandDefault = (command, args, options = {}) => new Promise((resolve) => {
  const child = spawnChild(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  child.on('error', (error) => resolve({
    ok: false,
    exitCode: null,
    stdout,
    stderr: error.message,
  }));
  child.on('close', (exitCode) => resolve({
    ok: exitCode === 0,
    exitCode,
    stdout,
    stderr,
  }));
});

const copyDirectoryRecursive = (fsApi, source, target, changedFiles) => {
  if (!fsApi.existsSync(source)) return;
  fsApi.mkdirSync(target, { recursive: true });
  for (const entry of fsApi.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursive(fsApi, sourcePath, targetPath, changedFiles);
      continue;
    }
    if (!entry.isFile()) continue;
    const content = fsApi.readFileSync(sourcePath);
    const current = fsApi.existsSync(targetPath) ? fsApi.readFileSync(targetPath) : null;
    if (current && Buffer.compare(current, content) === 0) continue;
    fsApi.mkdirSync(path.dirname(targetPath), { recursive: true });
    fsApi.writeFileSync(targetPath, content);
    changedFiles.push(targetPath);
  }
};

const installSlimSkillsIfAvailable = ({ fsApi, pathApi, configDirectory, changedFiles }) => {
  const packageRoot = pathApi.join(configDirectory, 'node_modules', SLIM_PLUGIN_PACKAGE_NAME);
  const source = pathApi.join(packageRoot, 'src', 'skills');
  const target = pathApi.join(configDirectory, 'skills');
  copyDirectoryRecursive(fsApi, source, target, changedFiles);
};

const getPackageDependencyVersion = (packageJson) => {
  const dependencies = isRecord(packageJson.dependencies) ? packageJson.dependencies : {};
  const devDependencies = isRecord(packageJson.devDependencies) ? packageJson.devDependencies : {};
  const version = dependencies[SLIM_PLUGIN_PACKAGE_NAME] ?? devDependencies[SLIM_PLUGIN_PACKAGE_NAME];
  return typeof version === 'string' ? version : null;
};

const getWrapperStatus = ({ fsApi, pathApi, configDirectory, opencodeConfig }) => {
  const wrapperPath = pathApi.join(configDirectory, 'plugins', DEVRYAN_SLIM_WRAPPER_PLUGIN_FILE);
  const plugins = Array.isArray(opencodeConfig.plugin) ? opencodeConfig.plugin : [];
  const wrapperRegistered = plugins.some((entry) => isDevRyanSlimWrapperPluginSpec(pluginSpecFromEntry(entry)));
  const rawRegistered = plugins.some((entry) => isSlimPluginSpec(pluginSpecFromEntry(entry)));
  const wrapperFileExists = fsApi.existsSync(wrapperPath);
  return {
    configured: wrapperRegistered && wrapperFileExists,
    wrapperRegistered,
    wrapperFileExists,
    rawRegistered,
    path: wrapperPath,
    spec: DEVRYAN_SLIM_WRAPPER_PLUGIN_SPEC,
  };
};

export const createSlimSetupRuntime = (dependencies = {}) => {
  const fsApi = dependencies.fs || fs;
  const pathApi = dependencies.path || path;
  const homedir = dependencies.homedir || (() => os.homedir());
  const env = dependencies.env || process.env;
  const now = dependencies.now || (() => new Date());
  const runCommand = dependencies.runCommand || runCommandDefault;
  const configDirectory = getConfigDirectory({
    pathApi,
    homedir,
    configDirectory: dependencies.configDirectory,
  });

  const getPaths = () => {
    const opencodeConfigPath = findOpenCodeConfigPath({ fsApi, pathApi, configDirectory });
    return {
      configDirectory,
      opencodeConfigPath,
      packageJsonPath: pathApi.join(configDirectory, 'package.json'),
      wrapperPath: pathApi.join(configDirectory, 'plugins', DEVRYAN_SLIM_WRAPPER_PLUGIN_FILE),
      slimConfigPath: findSlimConfigPath({ fsApi, pathApi, configDirectory }) || pathApi.join(configDirectory, 'oh-my-opencode-slim.json'),
    };
  };

  const getStatus = async () => {
    const paths = getPaths();
    const opencodeConfig = readJsoncFile(fsApi, paths.opencodeConfigPath);
    const packageJson = readJsoncFile(fsApi, paths.packageJsonPath);
    const dependencyVersion = getPackageDependencyVersion(packageJson);
    const wrapperStatus = getWrapperStatus({ fsApi, pathApi, configDirectory, opencodeConfig });
    const slimConfigExists = fsApi.existsSync(paths.slimConfigPath);
    const packageDependencyInstalled = dependencyVersion === SLIM_MANAGED_VERSION;
    const issues = [];
    if (!packageDependencyInstalled) {
      issues.push({
        code: 'slim-package-missing',
        message: `OpenCode config package.json must depend on ${SLIM_PLUGIN_PACKAGE_NAME}@${SLIM_MANAGED_VERSION}.`,
      });
    }
    if (!wrapperStatus.configured) {
      issues.push({
        code: 'slim-wrapper-missing',
        message: `Register ${DEVRYAN_SLIM_WRAPPER_PLUGIN_SPEC} and ensure the wrapper file exists.`,
      });
    }
    if (wrapperStatus.rawRegistered) {
      issues.push({
        code: 'raw-slim-plugin-registered',
        message: 'Raw oh-my-opencode-slim is registered; DevRyan wrapper mode should replace it.',
      });
    }
    if (!slimConfigExists) {
      issues.push({
        code: 'slim-config-missing',
        message: 'oh-my-opencode-slim.json is missing.',
      });
    }

    return {
      ok: issues.length === 0,
      installedVersion: packageDependencyInstalled ? SLIM_MANAGED_VERSION : null,
      configDirectory,
      configPath: paths.opencodeConfigPath,
      slimConfigPath: paths.slimConfigPath,
      wrapperPath: paths.wrapperPath,
      packageJsonPath: paths.packageJsonPath,
      runtimeEnabled: wrapperStatus.configured,
      wrapperConfigured: wrapperStatus.configured,
      wrapperStatus,
      packageDependencyInstalled,
      slimConfigExists,
      backgroundSubagentsEnv: env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS || 'true',
      issues,
      changedFiles: [],
      backupPaths: [],
    };
  };

  const install = async (options = {}) => {
    const paths = getPaths();
    const tracker = createWriteTracker({ fsApi, now });
    const opencodeConfig = readJsoncFile(fsApi, paths.opencodeConfigPath);
    const packageJson = readJsoncFile(fsApi, paths.packageJsonPath);
    const slimConfigExists = fsApi.existsSync(paths.slimConfigPath);

    tracker.writeJsonTracked(paths.opencodeConfigPath, updateOpenCodeConfig(opencodeConfig));
    tracker.writeTextTracked(paths.wrapperPath, WRAPPER_PLUGIN_SOURCE);
    tracker.writeJsonTracked(paths.packageJsonPath, updatePackageJson(packageJson));
    if (!slimConfigExists || options.resetSlimConfig === true) {
      tracker.writeJsonTracked(paths.slimConfigPath, cloneJson(DEFAULT_SLIM_CONFIG));
    }

    const installResult = await runCommand('bun', ['install', '--ignore-scripts'], {
      cwd: configDirectory,
      env,
    });
    if (!installResult?.ok) {
      return {
        ...(await getStatus()),
        ok: false,
        repair: options.repair === true,
        changedFiles: tracker.changedFiles,
        backupPaths: tracker.backupPaths,
        command: installResult,
        issues: [
          ...(await getStatus()).issues,
          {
            code: 'bun-install-failed',
            message: installResult?.stderr || installResult?.stdout || 'bun install --ignore-scripts failed',
          },
        ],
      };
    }

    installSlimSkillsIfAvailable({
      fsApi,
      pathApi,
      configDirectory,
      changedFiles: tracker.changedFiles,
    });

    return {
      ...(await getStatus()),
      ok: true,
      repair: options.repair === true,
      installedVersion: SLIM_MANAGED_VERSION,
      changedFiles: tracker.changedFiles,
      backupPaths: tracker.backupPaths,
      command: installResult,
    };
  };

  const repair = (options = {}) => install({ ...options, repair: true });

  return {
    getStatus,
    install,
    repair,
  };
};

export const registerSlimSetupRoutes = (app, dependencies = {}) => {
  const runtime = dependencies.slimSetupRuntime || createSlimSetupRuntime(dependencies);
  const markConfigChange = dependencies.markConfigChange;

  app.get('/api/config/slim/status', async (_req, res) => {
    try {
      res.json(await runtime.getStatus());
    } catch (error) {
      console.error('[API:GET /api/config/slim/status] Failed:', error);
      res.status(500).json({ error: 'Failed to inspect Slim runtime setup' });
    }
  });

  const runMutation = (action, reason) => async (req, res) => {
    try {
      const result = await runtime[action]({
        resetSlimConfig: req.body?.resetSlimConfig === true,
      });
      let apply = null;
      if (typeof markConfigChange === 'function') {
        apply = await markConfigChange(reason, { restart: true }, result.ok);
      }
      res.json({ ...result, ...(apply || {}) });
    } catch (error) {
      console.error(`[API:POST /api/config/slim/${action}] Failed:`, error);
      res.status(500).json({ error: `Failed to ${action} Slim runtime` });
    }
  };

  app.post('/api/config/slim/install', runMutation('install', 'Slim runtime install'));
  app.post('/api/config/slim/repair', runMutation('repair', 'Slim runtime repair'));
};

export {
  DEVRYAN_SLIM_WRAPPER_PLUGIN_FILE,
  DEVRYAN_SLIM_WRAPPER_PLUGIN_SPEC,
  SLIM_MANAGED_VERSION,
  WRAPPER_PLUGIN_SOURCE,
};
