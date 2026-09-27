import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEVRYAN_MANAGED_PLUGIN_IDS = Object.freeze({
  OPEN_CURSOR: '@rama_nigg/open-cursor',
  CLAUDE: 'opencode-with-claude',
  GPT_IMAGEGEN: 'opencode-gpt-imagegen',
  SLIM: 'oh-my-opencode-slim',
  SUPERPOWERS: 'superpowers',
  SKILL_CONTEXT: 'devryan-skill-context',
  DOCUMENT_READER: 'devryan-document-reader',
  OPENAI_TOOL_SCHEMA_SANITIZER: 'openai-tool-schema-sanitizer',
});

const definitions = [
  {
    id: DEVRYAN_MANAGED_PLUGIN_IDS.OPEN_CURSOR,
    displayName: 'Open Cursor',
    packageName: '@rama_nigg/open-cursor',
    version: '2.5.8',
    entrypoint: 'dist/plugin-entry.js',
    // The adapter loads the installed package and drops its local tools, which
    // shadow OpenCode built-ins without permission checks.
    registrationPath: './plugins/devryan-open-cursor.mjs',
    legacySpecs: ['@rama_nigg/open-cursor', '@rama_nigg/open-cursor@latest'],
    legacyRegistrationPaths: ['./node_modules/@rama_nigg/open-cursor/dist/plugin-entry.js'],
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
    version: '0.1.12',
    entrypoint: 'dist/index.js',
    registrationPath: './node_modules/opencode-gpt-imagegen/dist/index.js',
    legacySpecs: ['opencode-gpt-imagegen', 'opencode-gpt-imagegen@latest', 'opencode-gpt-imagegen@0.1.10', 'opencode-gpt-imagegen@0.1.12'],
    delivery: 'installed-local',
    sourcePath: 'default-config/user-profile/package.json',
    profileRegistration: true,
    public: true,
  },
  {
    id: DEVRYAN_MANAGED_PLUGIN_IDS.SLIM,
    displayName: 'Oh My OpenCode Slim',
    packageName: 'oh-my-opencode-slim',
    version: '2.2.24',
    entrypoint: 'dist/index.js',
    registrationPath: './plugins/devryan-oh-my-opencode-slim.mjs',
    legacySpecs: [
      'oh-my-opencode-slim',
      'oh-my-opencode-slim@2.0.5',
      'oh-my-opencode-slim@2.2.15',
      'oh-my-opencode-slim@2.2.18',
      'oh-my-opencode-slim@2.2.24',
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
      { packageName: '@opencode-ai/plugin', version: '1.18.32', entrypoint: 'dist/index.js' },
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
  legacyRegistrationPaths: Object.freeze([...(definition.legacyRegistrationPaths || [])]),
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

// Plugins DevRyan used to provision and now actively removes from existing profiles.
// Context Mode (removed 2026-09) was only ever pinned at 1.0.169; any other user-owned version is left alone.
const RETIRED_CONTEXT_MODE_REGISTRATION_PATH = './node_modules/context-mode/build/adapters/opencode/plugin.js';
// Antigravity (removed 2026-09) was pinned at 1.6.0; the same user-owned-version rule applies.
const RETIRED_ANTIGRAVITY_REGISTRATION_PATH = './node_modules/opencode-antigravity-auth/dist/index.js';

export const RETIRED_DEVRYAN_PLUGIN_SPECS = Object.freeze([
  'cursor-acp',
  'context-mode',
  'context-mode@1.0.169',
  RETIRED_CONTEXT_MODE_REGISTRATION_PATH,
  'opencode-antigravity-auth',
  'opencode-antigravity-auth@latest',
  'opencode-antigravity-auth@1.6.0',
  RETIRED_ANTIGRAVITY_REGISTRATION_PATH,
]);

// Registration paths also retired in absolute or file:// form (matched by path suffix).
const RETIRED_DEVRYAN_PLUGIN_REGISTRATION_SUFFIXES = Object.freeze([
  RETIRED_CONTEXT_MODE_REGISTRATION_PATH.replace(/^\.\//, '/'),
  RETIRED_ANTIGRAVITY_REGISTRATION_PATH.replace(/^\.\//, '/'),
]);

// Profile dependencies DevRyan pinned and now removes, keyed by package name with the exact pinned version.
export const RETIRED_DEVRYAN_PROFILE_DEPENDENCIES = Object.freeze({
  'context-mode': '1.0.169',
  'opencode-antigravity-auth': '1.6.0',
});

const normalizeSpec = (value) => {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' ? raw.trim().replace(/\\/g, '/') : '';
};

const replaceEntrySpec = (entry, nextSpec) => (
  Array.isArray(entry) ? [nextSpec, ...entry.slice(1)] : nextSpec
);

const matchesRegistrationPath = (spec, registrationPath) => {
  const normalized = normalizeSpec(spec);
  const registration = registrationPath.replace(/\\/g, '/');
  if (!normalized) return false;
  if (normalized === registration) return true;
  const suffix = registration.replace(/^\.\//, '/');
  return normalized.endsWith(suffix);
};

const isRegistrationPathForPlugin = (spec, plugin) => matchesRegistrationPath(spec, plugin.registrationPath);

// A registration path the plugin used before an adapter replaced it, in its
// relative or absolute (file URL) spelling.
const isLegacyRegistrationPathForPlugin = (spec, plugin) => (
  plugin.legacyRegistrationPaths.some((registrationPath) => matchesRegistrationPath(spec, registrationPath))
);

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
    || isLegacyRegistrationPathForPlugin(spec, plugin)
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
    || isLegacyRegistrationPathForPlugin(spec, plugin)
  )) || null;
};

export const isRetiredDevRyanPluginSpec = (value) => {
  const spec = normalizeSpec(value);
  if (!spec) return false;
  return RETIRED_DEVRYAN_PLUGIN_SPECS.includes(spec)
    || RETIRED_DEVRYAN_PLUGIN_REGISTRATION_SUFFIXES.some((suffix) => spec.endsWith(suffix));
};

export const isDevRyanManagedLegacyPluginSpec = (value) => {
  const spec = normalizeSpec(value);
  if (!spec) return false;
  return isRetiredDevRyanPluginSpec(spec)
    || DEVRYAN_MANAGED_PROFILE_PLUGINS.some((plugin) => plugin.legacySpecs.includes(spec)
      || isLegacyRegistrationPathForPlugin(spec, plugin));
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
