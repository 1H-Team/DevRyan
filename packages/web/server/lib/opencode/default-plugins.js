import {
  DEVRYAN_MANAGED_PLUGIN_IDS,
  DEVRYAN_MANAGED_PLUGINS,
  getDevRyanManagedPluginForFile,
  getDevRyanManagedPluginForSpec,
} from './managed-plugins.js';

export const DEVRYAN_DEFAULT_PLUGIN_IDS = Object.freeze({
  ANTIGRAVITY: DEVRYAN_MANAGED_PLUGIN_IDS.ANTIGRAVITY,
  OPEN_CURSOR: DEVRYAN_MANAGED_PLUGIN_IDS.OPEN_CURSOR,
  CLAUDE: DEVRYAN_MANAGED_PLUGIN_IDS.CLAUDE,
  CONTEXT_MODE: DEVRYAN_MANAGED_PLUGIN_IDS.CONTEXT_MODE,
  SLIM: DEVRYAN_MANAGED_PLUGIN_IDS.SLIM,
  SUPERPOWERS: DEVRYAN_MANAGED_PLUGIN_IDS.SUPERPOWERS,
  OPENAI_TOOL_SCHEMA_SANITIZER: DEVRYAN_MANAGED_PLUGIN_IDS.OPENAI_TOOL_SCHEMA_SANITIZER,
});

const contextMode = DEVRYAN_MANAGED_PLUGINS.find(
  (plugin) => plugin.id === DEVRYAN_DEFAULT_PLUGIN_IDS.CONTEXT_MODE,
);
const sanitizer = DEVRYAN_MANAGED_PLUGINS.find(
  (plugin) => plugin.id === DEVRYAN_DEFAULT_PLUGIN_IDS.OPENAI_TOOL_SCHEMA_SANITIZER,
);

export const CONTEXT_MODE_PLUGIN_VERSION = contextMode.version;
export const CONTEXT_MODE_PLUGIN_SPEC = contextMode.registrationPath;
export const OPENAI_TOOL_SCHEMA_SANITIZER_FILE = sanitizer.registrationPath.split('/').at(-1);
export const OPENAI_TOOL_SCHEMA_SANITIZER_SPEC = sanitizer.registrationPath;

const catalog = Object.freeze(DEVRYAN_MANAGED_PLUGINS
  .filter((plugin) => plugin.public)
  .map((plugin) => Object.freeze({
    id: `devryan-default:${plugin.id}`,
    pluginId: plugin.id,
    displayName: plugin.displayName,
    shippedSpec: plugin.registrationPath,
    version: plugin.version,
    delivery: plugin.delivery,
    sourcePath: plugin.sourcePath,
  })));

export const getDevRyanDefaultPluginIdForSpec = (spec) => (
  getDevRyanManagedPluginForSpec(spec)?.id || null
);

export const getDevRyanDefaultPluginIdForFile = (fileName) => (
  getDevRyanManagedPluginForFile(fileName)?.id || null
);

export const buildDevRyanDefaultPluginInventory = ({ entries = [], files = [] } = {}) => {
  const annotatedEntries = entries.map((entry) => {
    const defaultPluginId = getDevRyanDefaultPluginIdForSpec(entry?.spec);
    return defaultPluginId ? { ...entry, defaultPluginId } : entry;
  });
  const annotatedFiles = files.map((file) => {
    const defaultPluginId = getDevRyanDefaultPluginIdForFile(file?.fileName);
    return defaultPluginId ? { ...file, defaultPluginId } : file;
  });

  const defaults = catalog.map((plugin) => {
    const configuredEntry = annotatedEntries.findLast((entry) => entry.defaultPluginId === plugin.pluginId);
    const configuredFile = annotatedFiles.findLast((file) => file.defaultPluginId === plugin.pluginId);
    return {
      ...plugin,
      kind: 'default',
      effectiveSpec: configuredEntry?.spec || plugin.shippedSpec,
      ...(configuredEntry?.sourcePath
        ? { configuredSourcePath: configuredEntry.sourcePath }
        : configuredFile?.absolutePath
          ? { configuredSourcePath: configuredFile.absolutePath }
          : {}),
    };
  });

  return { defaults, entries: annotatedEntries, files: annotatedFiles };
};

export const DEVRYAN_DEFAULT_PLUGINS = catalog;
