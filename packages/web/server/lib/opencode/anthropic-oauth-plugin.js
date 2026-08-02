import {
  DEVRYAN_MANAGED_PLUGIN_IDS,
  getDevRyanManagedPlugin,
  getDevRyanManagedPluginForSpec,
} from './managed-plugins.js';

const definition = getDevRyanManagedPlugin(DEVRYAN_MANAGED_PLUGIN_IDS.CLAUDE);

export const ANTHROPIC_OAUTH_PLUGIN_PACKAGE = definition.packageName;
export const ANTHROPIC_OAUTH_PLUGIN_VERSION = definition.version;
export const ANTHROPIC_OAUTH_PLUGIN_SPEC = definition.registrationPath;

const getPluginSpec = (entry) => {
  const rawSpec = Array.isArray(entry) ? entry[0] : entry;
  return typeof rawSpec === 'string' ? rawSpec.trim().replace(/\\/g, '/') : '';
};

const replacePluginSpec = (entry, nextSpec) => (
  Array.isArray(entry) ? [nextSpec, ...entry.slice(1)] : nextSpec
);

const isManagedAnthropicSpec = (entry) => {
  const spec = getPluginSpec(entry);
  if (!spec) return false;
  return definition.legacySpecs.includes(spec)
    || spec === definition.registrationPath
    || spec.endsWith(definition.registrationPath.replace(/^\.\//, '/'));
};

export const isAnthropicOAuthPluginSpec = (value) => (
  getDevRyanManagedPluginForSpec(value)?.id === DEVRYAN_MANAGED_PLUGIN_IDS.CLAUDE
);

export const reconcileAnthropicOAuthPluginSpecs = (
  entries,
  nextSpec = ANTHROPIC_OAUTH_PLUGIN_SPEC,
) => {
  const plugins = Array.isArray(entries) ? entries : [];
  const hasExplicitCustomSpec = plugins.some((entry) => (
    isAnthropicOAuthPluginSpec(entry) && !isManagedAnthropicSpec(entry)
  ));
  if (hasExplicitCustomSpec) {
    return plugins.filter((entry) => (
      !isAnthropicOAuthPluginSpec(entry) || !isManagedAnthropicSpec(entry)
    ));
  }

  let added = false;
  const reconciled = [];
  for (const entry of plugins) {
    if (!isAnthropicOAuthPluginSpec(entry)) {
      reconciled.push(entry);
      continue;
    }
    if (!added) {
      reconciled.push(replacePluginSpec(entry, nextSpec));
      added = true;
    }
  }
  if (!added) {
    reconciled.push(nextSpec);
  }
  return reconciled;
};
