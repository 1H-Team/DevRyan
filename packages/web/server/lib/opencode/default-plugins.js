import {
  ANTHROPIC_OAUTH_PLUGIN_SPEC,
  ANTHROPIC_OAUTH_PLUGIN_VERSION,
  isAnthropicOAuthPluginSpec,
} from './anthropic-oauth-plugin.js';
import {
  DEVRYAN_SLIM_WRAPPER_PLUGIN_FILE,
  DEVRYAN_SLIM_WRAPPER_PLUGIN_SPEC,
  SLIM_MANAGED_VERSION,
  SLIM_PLUGIN_PACKAGE_NAME,
  isSlimPluginSpec,
} from './slim-config.js';

export const DEVRYAN_DEFAULT_PLUGIN_IDS = Object.freeze({
  SLIM: 'oh-my-opencode-slim',
  CLAUDE: 'opencode-with-claude',
  OPENAI_TOOL_SCHEMA_SANITIZER: 'openai-tool-schema-sanitizer',
});

export const OPENAI_TOOL_SCHEMA_SANITIZER_FILE = 'openai-tool-schema-sanitizer.mjs';
export const OPENAI_TOOL_SCHEMA_SANITIZER_SPEC = `./plugins/${OPENAI_TOOL_SCHEMA_SANITIZER_FILE}`;

const catalog = Object.freeze([
  Object.freeze({
    id: `devryan-default:${DEVRYAN_DEFAULT_PLUGIN_IDS.SLIM}`,
    pluginId: DEVRYAN_DEFAULT_PLUGIN_IDS.SLIM,
    displayName: 'Oh My OpenCode Slim',
    shippedSpec: `${SLIM_PLUGIN_PACKAGE_NAME}@${SLIM_MANAGED_VERSION}`,
    version: SLIM_MANAGED_VERSION,
    delivery: 'npm',
    sourcePath: 'default-config/user-profile/package.json',
  }),
  Object.freeze({
    id: `devryan-default:${DEVRYAN_DEFAULT_PLUGIN_IDS.CLAUDE}`,
    pluginId: DEVRYAN_DEFAULT_PLUGIN_IDS.CLAUDE,
    displayName: 'OpenCode with Claude',
    shippedSpec: ANTHROPIC_OAUTH_PLUGIN_SPEC,
    version: ANTHROPIC_OAUTH_PLUGIN_VERSION,
    delivery: 'npm',
    sourcePath: 'default-config/user-profile/package.json',
  }),
  Object.freeze({
    id: `devryan-default:${DEVRYAN_DEFAULT_PLUGIN_IDS.OPENAI_TOOL_SCHEMA_SANITIZER}`,
    pluginId: DEVRYAN_DEFAULT_PLUGIN_IDS.OPENAI_TOOL_SCHEMA_SANITIZER,
    displayName: 'OpenAI Tool Schema Sanitizer',
    shippedSpec: OPENAI_TOOL_SCHEMA_SANITIZER_SPEC,
    version: null,
    delivery: 'bundled-file',
    sourcePath: `default-config/plugins/${OPENAI_TOOL_SCHEMA_SANITIZER_FILE}`,
  }),
]);

const normalizePluginValue = (value) => (
  typeof value === 'string' ? value.trim().replace(/\\/g, '/') : ''
);

const isSanitizerValue = (value) => {
  const normalized = normalizePluginValue(value).toLowerCase();
  return normalized === OPENAI_TOOL_SCHEMA_SANITIZER_FILE
    || normalized.endsWith(`/plugins/${OPENAI_TOOL_SCHEMA_SANITIZER_FILE}`);
};

export const getDevRyanDefaultPluginIdForSpec = (spec) => {
  const normalized = normalizePluginValue(spec);
  if (!normalized) return null;
  if (isSlimPluginSpec(normalized) || normalized === DEVRYAN_SLIM_WRAPPER_PLUGIN_SPEC) {
    return DEVRYAN_DEFAULT_PLUGIN_IDS.SLIM;
  }
  if (isAnthropicOAuthPluginSpec(normalized)) {
    return DEVRYAN_DEFAULT_PLUGIN_IDS.CLAUDE;
  }
  if (isSanitizerValue(normalized)) {
    return DEVRYAN_DEFAULT_PLUGIN_IDS.OPENAI_TOOL_SCHEMA_SANITIZER;
  }
  return null;
};

export const getDevRyanDefaultPluginIdForFile = (fileName) => {
  const normalized = normalizePluginValue(fileName).toLowerCase();
  if (normalized === DEVRYAN_SLIM_WRAPPER_PLUGIN_FILE) {
    return DEVRYAN_DEFAULT_PLUGIN_IDS.SLIM;
  }
  if (isSanitizerValue(normalized)) {
    return DEVRYAN_DEFAULT_PLUGIN_IDS.OPENAI_TOOL_SCHEMA_SANITIZER;
  }
  return null;
};

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
