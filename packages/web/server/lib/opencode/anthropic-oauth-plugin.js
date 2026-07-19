export const ANTHROPIC_OAUTH_PLUGIN_PACKAGE = 'opencode-with-claude';
export const ANTHROPIC_OAUTH_PLUGIN_VERSION = '1.6.18';
export const ANTHROPIC_OAUTH_PLUGIN_SPEC = `${ANTHROPIC_OAUTH_PLUGIN_PACKAGE}@${ANTHROPIC_OAUTH_PLUGIN_VERSION}`;

export const isAnthropicOAuthPluginSpec = (value) => {
  const rawSpec = Array.isArray(value) ? value[0] : value;
  if (typeof rawSpec !== 'string') {
    return false;
  }
  const spec = rawSpec.trim();
  const versionPrefix = `${ANTHROPIC_OAUTH_PLUGIN_PACKAGE}@`;
  return spec === ANTHROPIC_OAUTH_PLUGIN_PACKAGE
    || (spec.startsWith(versionPrefix) && spec.length > versionPrefix.length);
};

const replaceAnthropicPluginSpec = (entry, nextSpec) => (
  Array.isArray(entry) ? [nextSpec, ...entry.slice(1)] : nextSpec
);

const getAnthropicPluginSpec = (entry) => {
  const rawSpec = Array.isArray(entry) ? entry[0] : entry;
  return typeof rawSpec === 'string' ? rawSpec.trim() : '';
};

// DevRyan-owned unversioned entries are upgraded to the reviewed release. An
// explicit user pin remains authoritative, and any old bare duplicate is
// removed so OpenCode cannot load two versions of the same plugin.
export const reconcileAnthropicOAuthPluginSpecs = (entries) => {
  const plugins = Array.isArray(entries) ? entries : [];
  const explicitPin = plugins.find((entry) => (
    isAnthropicOAuthPluginSpec(entry)
    && getAnthropicPluginSpec(entry) !== ANTHROPIC_OAUTH_PLUGIN_PACKAGE
  ));

  if (explicitPin) {
    return plugins.filter((entry) => (
      getAnthropicPluginSpec(entry) !== ANTHROPIC_OAUTH_PLUGIN_PACKAGE
    ));
  }

  let added = false;
  const reconciled = [];
  for (const entry of plugins) {
    if (getAnthropicPluginSpec(entry) === ANTHROPIC_OAUTH_PLUGIN_PACKAGE) {
      if (!added) {
        reconciled.push(replaceAnthropicPluginSpec(entry, ANTHROPIC_OAUTH_PLUGIN_SPEC));
        added = true;
      }
      continue;
    }
    reconciled.push(entry);
  }
  if (!added) {
    reconciled.push(ANTHROPIC_OAUTH_PLUGIN_SPEC);
  }
  return reconciled;
};
