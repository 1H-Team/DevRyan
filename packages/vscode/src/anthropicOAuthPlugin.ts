export const ANTHROPIC_OAUTH_PLUGIN_PACKAGE = 'opencode-with-claude';
export const ANTHROPIC_OAUTH_PLUGIN_VERSION = '1.6.18';
export const ANTHROPIC_OAUTH_PLUGIN_SPEC = `${ANTHROPIC_OAUTH_PLUGIN_PACKAGE}@${ANTHROPIC_OAUTH_PLUGIN_VERSION}`;

export const isAnthropicOAuthPluginSpec = (value: unknown): boolean => {
  const rawSpec = Array.isArray(value) ? value[0] : value;
  if (typeof rawSpec !== 'string') {
    return false;
  }
  const spec = rawSpec.trim();
  const versionPrefix = `${ANTHROPIC_OAUTH_PLUGIN_PACKAGE}@`;
  return spec === ANTHROPIC_OAUTH_PLUGIN_PACKAGE
    || (spec.startsWith(versionPrefix) && spec.length > versionPrefix.length);
};

const getAnthropicPluginSpec = (entry: unknown) => {
  const rawSpec = Array.isArray(entry) ? entry[0] : entry;
  return typeof rawSpec === 'string' ? rawSpec.trim() : '';
};

const replaceAnthropicPluginSpec = (entry: unknown, nextSpec: string): unknown => (
  Array.isArray(entry) ? [nextSpec, ...entry.slice(1)] : nextSpec
);

export const reconcileAnthropicOAuthPluginSpecs = (entries: unknown[]): unknown[] => {
  const explicitPin = entries.find((entry) => (
    isAnthropicOAuthPluginSpec(entry)
    && getAnthropicPluginSpec(entry) !== ANTHROPIC_OAUTH_PLUGIN_PACKAGE
  ));

  if (explicitPin) {
    return entries.filter((entry) => getAnthropicPluginSpec(entry) !== ANTHROPIC_OAUTH_PLUGIN_PACKAGE);
  }

  let added = false;
  const reconciled: unknown[] = [];
  for (const entry of entries) {
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
