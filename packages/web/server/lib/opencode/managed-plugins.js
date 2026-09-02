import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEVRYAN_MANAGED_PLUGIN_IDS = Object.freeze({
  ANTIGRAVITY: 'opencode-antigravity-auth',
  OPEN_CURSOR: '@rama_nigg/open-cursor',
  CLAUDE: 'opencode-with-claude',
  GPT_IMAGEGEN: 'opencode-gpt-imagegen',
  CONTEXT_MODE: 'context-mode',
  SLIM: 'oh-my-opencode-slim',
  SUPERPOWERS: 'superpowers',
  SKILL_CONTEXT: 'devryan-skill-context',
  DOCUMENT_READER: 'devryan-document-reader',
  OPENAI_TOOL_SCHEMA_SANITIZER: 'openai-tool-schema-sanitizer',
});

const definitions = [
  {
    id: DEVRYAN_MANAGED_PLUGIN_IDS.ANTIGRAVITY,
    displayName: 'OpenCode Antigravity Auth',
    packageName: 'opencode-antigravity-auth',
    version: '1.6.0',
    entrypoint: 'dist/index.js',
    registrationPath: './node_modules/opencode-antigravity-auth/dist/index.js',
    legacySpecs: ['opencode-antigravity-auth', 'opencode-antigravity-auth@latest'],
    delivery: 'installed-local',
    sourcePath: 'default-config/user-profile/package.json',
    profileRegistration: true,
    public: true,
  },
  {
    id: DEVRYAN_MANAGED_PLUGIN_IDS.OPEN_CURSOR,
    displayName: 'Open Cursor',
    packageName: '@rama_nigg/open-cursor',
    version: '2.5.4',
    entrypoint: 'dist/plugin-entry.js',
    registrationPath: './node_modules/@rama_nigg/open-cursor/dist/plugin-entry.js',
    legacySpecs: ['@rama_nigg/open-cursor', '@rama_nigg/open-cursor@latest'],
    delivery: 'installed-local',
    sourcePath: 'default-config/user-profile/package.json',
    profileRegistration: true,
    public: true,
  },
  {
    id: DEVRYAN_MANAGED_PLUGIN_IDS.CLAUDE,
    displayName: 'OpenCode with Claude',
    packageName: 'opencode-with-claude',
    version: '1.8.0',
    entrypoint: 'dist/index.js',
    registrationPath: './node_modules/opencode-with-claude/dist/index.js',
    legacySpecs: ['opencode-with-claude', 'opencode-with-claude@1.6.18', 'opencode-with-claude@1.8.0'],
    delivery: 'installed-local',
    sourcePath: 'default-config/user-profile/package.json',
    profileRegistration: true,
    public: true,
  },
  {
    id: DEVRYAN_MANAGED_PLUGIN_IDS.GPT_IMAGEGEN,
    displayName: 'GPT Image Generation',
    packageName: 'opencode-gpt-imagegen',
    version: '0.1.10',
    entrypoint: 'dist/index.js',
    registrationPath: './node_modules/opencode-gpt-imagegen/dist/index.js',
    legacySpecs: ['opencode-gpt-imagegen', 'opencode-gpt-imagegen@latest', 'opencode-gpt-imagegen@0.1.10'],
    delivery: 'installed-local',
    sourcePath: 'default-config/user-profile/package.json',
    profileRegistration: true,
    public: true,
  },
  {
    id: DEVRYAN_MANAGED_PLUGIN_IDS.CONTEXT_MODE,
    displayName: 'Context Mode',
    packageName: 'context-mode',
    version: '1.0.169',
    entrypoint: 'build/adapters/opencode/plugin.js',
    registrationPath: './node_modules/context-mode/build/adapters/opencode/plugin.js',
    legacySpecs: ['context-mode', 'context-mode@1.0.169'],
    delivery: 'installed-local',
    sourcePath: 'default-config/user-profile/package.json',
    profileRegistration: true,
    public: true,
  },
  {
    id: DEVRYAN_MANAGED_PLUGIN_IDS.SLIM,
    displayName: 'Oh My OpenCode Slim',
    packageName: 'oh-my-opencode-slim',
    version: '2.2.15',
    entrypoint: 'dist/index.js',
    registrationPath: './plugins/devryan-oh-my-opencode-slim.mjs',
    legacySpecs: [
      'oh-my-opencode-slim',
      'oh-my-opencode-slim@2.0.5',
      'oh-my-opencode-slim@2.2.15',
    ],
    delivery: 'installed-local',
    sourcePath: 'default-config/user-profile/package.json',
    profileRegistration: true,
    public: true,
  },
  {
    id: DEVRYAN_MANAGED_PLUGIN_IDS.SUPERPOWERS,
    displayName: 'Superpowers',
    packageName: null,
    version: null,
    entrypoint: null,
    registrationPath: './plugins/devryan-superpowers.mjs',
    legacySpecs: ['superpowers@git+https://github.com/obra/superpowers.git'],
    delivery: 'bundled-file',
    sourcePath: 'default-config/plugins/devryan-superpowers.mjs',
    profileRegistration: true,
    public: true,
  },
  {
    id: DEVRYAN_MANAGED_PLUGIN_IDS.SKILL_CONTEXT,
    displayName: 'DevRyan Skill Context',
    packageName: null,
    version: null,
    entrypoint: null,
    registrationPath: './plugins/devryan-skill-context.mjs',
    legacySpecs: [],
    delivery: 'bundled-file',
    sourcePath: 'default-config/plugins/devryan-skill-context.mjs',
    profileRegistration: true,
    public: true,
  },
  {
    id: DEVRYAN_MANAGED_PLUGIN_IDS.DOCUMENT_READER,
    displayName: 'DevRyan Document Reader',
    packageName: null,
    version: null,
    entrypoint: null,
    registrationPath: './plugins/devryan-document-reader.mjs',
    legacySpecs: [],
    delivery: 'bundled-file',
    sourcePath: 'default-config/plugins/devryan-document-reader.mjs',
    profileRegistration: true,
    runtimeDependencies: [
      { packageName: '@opencode-ai/plugin', version: '1.18.26', entrypoint: 'dist/index.js' },
      { packageName: 'adm-zip', version: '0.6.0', entrypoint: 'adm-zip.js' },
      { packageName: 'mammoth', version: '1.12.1', entrypoint: 'lib/index.js' },
      { packageName: 'unpdf', version: '1.8.0', entrypoint: 'dist/index.mjs' },
    ],
    public: true,
  },
  {
    id: DEVRYAN_MANAGED_PLUGIN_IDS.OPENAI_TOOL_SCHEMA_SANITIZER,
    displayName: 'OpenAI Tool Schema Sanitizer',
    packageName: null,
    version: null,
    entrypoint: null,
    registrationPath: './plugins/openai-tool-schema-sanitizer.mjs',
    legacySpecs: [],
    delivery: 'bundled-file',
    sourcePath: 'default-config/plugins/openai-tool-schema-sanitizer.mjs',
    profileRegistration: false,
    public: true,
  },
];

export const DEVRYAN_MANAGED_PLUGINS = Object.freeze(definitions.map((definition) => Object.freeze({
  ...definition,
  legacySpecs: Object.freeze([...definition.legacySpecs]),
  runtimeDependencies: Object.freeze((definition.runtimeDependencies || []).map((dependency) => Object.freeze({ ...dependency }))),
})));

export const DEVRYAN_MANAGED_PROFILE_PLUGINS = Object.freeze(
  DEVRYAN_MANAGED_PLUGINS.filter((plugin) => plugin.profileRegistration),
);

export const DEVRYAN_MANAGED_PROFILE_PLUGIN_SPECS = Object.freeze(
  DEVRYAN_MANAGED_PROFILE_PLUGINS.map((plugin) => plugin.registrationPath),
);

export const DEVRYAN_MANAGED_PROFILE_DEPENDENCIES = Object.freeze(Object.fromEntries(
  DEVRYAN_MANAGED_PLUGINS
    .flatMap((plugin) => [
      ...(plugin.packageName && plugin.version ? [[plugin.packageName, plugin.version]] : []),
      ...plugin.runtimeDependencies.map((dependency) => [dependency.packageName, dependency.version]),
    ]),
));

export const DEVRYAN_MANAGED_PROFILE_PLUGIN_FILES = Object.freeze(
  DEVRYAN_MANAGED_PROFILE_PLUGINS
    .map((plugin) => plugin.registrationPath)
    .filter((spec) => spec.startsWith('./plugins/'))
    .map((spec) => spec.slice('./plugins/'.length)),
);

export const RETIRED_DEVRYAN_PLUGIN_SPECS = Object.freeze(['cursor-acp']);

const normalizeSpec = (value) => {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' ? raw.trim().replace(/\\/g, '/') : '';
};

const replaceEntrySpec = (entry, nextSpec) => (
  Array.isArray(entry) ? [nextSpec, ...entry.slice(1)] : nextSpec
);

const isRegistrationPathForPlugin = (spec, plugin) => {
  const normalized = normalizeSpec(spec);
  const registration = plugin.registrationPath.replace(/\\/g, '/');
  if (!normalized) return false;
  if (normalized === registration) return true;
  const suffix = registration.replace(/^\.\//, '/');
  return normalized.endsWith(suffix);
};

const isPackageSpecForPlugin = (spec, plugin) => {
  const normalized = normalizeSpec(spec);
  if (!normalized || !plugin.packageName) return false;
  const versionPrefix = `${plugin.packageName}@`;
  return normalized === plugin.packageName
    || (normalized.startsWith(versionPrefix) && normalized.length > versionPrefix.length);
};

export const getDevRyanManagedPlugin = (pluginId) => (
  DEVRYAN_MANAGED_PLUGINS.find((plugin) => plugin.id === pluginId) || null
);

export const getDevRyanManagedPluginForSpec = (value) => {
  const spec = normalizeSpec(value);
  if (!spec) return null;
  return DEVRYAN_MANAGED_PLUGINS.find((plugin) => (
    isRegistrationPathForPlugin(spec, plugin)
    || isPackageSpecForPlugin(spec, plugin)
    || plugin.legacySpecs.includes(spec)
  )) || null;
};

export const getDevRyanManagedPluginForFile = (fileName) => {
  const normalized = normalizeSpec(fileName).toLowerCase();
  if (!normalized) return null;
  return DEVRYAN_MANAGED_PLUGINS.find((plugin) => (
    path.posix.basename(plugin.registrationPath).toLowerCase() === normalized
  )) || null;
};

const getManagedMigrationPlugin = (value) => {
  const spec = normalizeSpec(value);
  if (!spec) return null;
  return DEVRYAN_MANAGED_PROFILE_PLUGINS.find((plugin) => (
    isRegistrationPathForPlugin(spec, plugin)
    || plugin.legacySpecs.includes(spec)
  )) || null;
};

export const isRetiredDevRyanPluginSpec = (value) => (
  RETIRED_DEVRYAN_PLUGIN_SPECS.includes(normalizeSpec(value))
);

export const isDevRyanManagedLegacyPluginSpec = (value) => {
  const spec = normalizeSpec(value);
  if (!spec) return false;
  return isRetiredDevRyanPluginSpec(spec)
    || DEVRYAN_MANAGED_PROFILE_PLUGINS.some((plugin) => plugin.legacySpecs.includes(spec));
};

export const removeDevRyanManagedLegacyPluginSpecs = (entries) => (
  (Array.isArray(entries) ? entries : []).filter((entry) => (
    !isDevRyanManagedLegacyPluginSpec(entry)
  ))
);

export const reconcileDevRyanManagedPluginSpecs = (
  currentEntries,
  baselineEntries = DEVRYAN_MANAGED_PROFILE_PLUGIN_SPECS,
) => {
  const current = Array.isArray(currentEntries) ? currentEntries : [];
  const baseline = Array.isArray(baselineEntries) ? baselineEntries : [];
  const baselineById = new Map();
  for (const entry of baseline) {
    const plugin = getDevRyanManagedPluginForSpec(entry);
    if (plugin?.profileRegistration && !baselineById.has(plugin.id)) {
      baselineById.set(plugin.id, normalizeSpec(entry));
    }
  }

  const seenManagedIds = new Set();
  const reconciled = [];
  for (const entry of current) {
    if (isRetiredDevRyanPluginSpec(entry)) {
      continue;
    }
    const plugin = getDevRyanManagedPluginForSpec(entry);
    const migrationPlugin = getManagedMigrationPlugin(entry);
    if (!plugin?.profileRegistration) {
      reconciled.push(entry);
      continue;
    }
    if (seenManagedIds.has(plugin.id)) {
      continue;
    }
    seenManagedIds.add(plugin.id);
    const managedSpec = baselineById.get(plugin.id);
    if (migrationPlugin && managedSpec) {
      reconciled.push(replaceEntrySpec(entry, managedSpec));
      continue;
    }
    reconciled.push(entry);
  }

  for (const [pluginId, spec] of baselineById) {
    if (!seenManagedIds.has(pluginId)) {
      reconciled.push(spec);
    }
  }
  return reconciled;
};

export const getDevRyanManagedPluginRegistrationForConfigPath = (
  pluginId,
  { configDirectory, configPath } = {},
) => {
  const plugin = getDevRyanManagedPlugin(pluginId);
  if (!plugin?.registrationPath) return null;
  if (!configDirectory || !configPath) return plugin.registrationPath;
  const managedRoot = path.resolve(configDirectory);
  const targetDirectory = path.dirname(path.resolve(configPath));
  if (managedRoot === targetDirectory) {
    return plugin.registrationPath;
  }
  return pathToFileURL(path.join(managedRoot, plugin.registrationPath.replace(/^\.\//, ''))).href;
};

export const inspectDevRyanManagedPluginInstallation = ({
  configDirectory,
  fs,
  path: pathApi = path,
}) => {
  const issues = [];
  for (const plugin of DEVRYAN_MANAGED_PLUGINS) {
    const dependencies = [
      ...(plugin.packageName && plugin.version && plugin.entrypoint
        ? [{ packageName: plugin.packageName, version: plugin.version, entrypoint: plugin.entrypoint }]
        : []),
      ...plugin.runtimeDependencies,
    ];
    for (const dependency of dependencies) {
      const packageRoot = pathApi.join(configDirectory, 'node_modules', ...dependency.packageName.split('/'));
      const packageJsonPath = pathApi.join(packageRoot, 'package.json');
      let installedVersion = null;
      try {
        installedVersion = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))?.version || null;
      } catch {
        issues.push({
          pluginId: plugin.id,
          packageName: dependency.packageName,
          kind: 'missing-package',
          path: packageJsonPath,
          expectedVersion: dependency.version,
          installedVersion: null,
        });
        continue;
      }
      if (installedVersion !== dependency.version) {
        issues.push({
          pluginId: plugin.id,
          packageName: dependency.packageName,
          kind: 'version-mismatch',
          path: packageJsonPath,
          expectedVersion: dependency.version,
          installedVersion,
        });
      }
      const entrypointPath = pathApi.join(packageRoot, ...dependency.entrypoint.split('/'));
      if (!fs.existsSync(entrypointPath)) {
        issues.push({
          pluginId: plugin.id,
          packageName: dependency.packageName,
          kind: 'missing-entrypoint',
          path: entrypointPath,
          expectedVersion: dependency.version,
          installedVersion,
        });
      }
    }
  }
  return issues;
};
