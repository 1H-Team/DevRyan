import { collapseRemovalKeyPaths } from './jsonc-config.js';

// Antigravity (opencode-antigravity-auth) is retired. Its interactive
// "configure-models" menu wrote these models into `provider.google.models`;
// they are branded by id prefix or name suffix, so user-authored Google
// models are never matched.
const ANTIGRAVITY_MODEL_ID_PREFIX = 'antigravity-';
const ANTIGRAVITY_PLUGIN_MODEL_NAME_SUFFIX = /\s+\((?:Antigravity|Gemini CLI)\)$/i;

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const isAntigravityPluginGoogleModel = (modelId, model) => {
  if (typeof modelId === 'string' && modelId.startsWith(ANTIGRAVITY_MODEL_ID_PREFIX)) return true;
  const name = isPlainObject(model) && typeof model.name === 'string' ? model.name : '';
  return ANTIGRAVITY_PLUGIN_MODEL_NAME_SUFFIX.test(name);
};

// Key paths removing every plugin-written Google model from a parsed config,
// collapsing `models`, `google`, and the provider container when emptied.
export const getAntigravityPluginGoogleModelKeyPaths = (config) => {
  if (!isPlainObject(config)) return [];
  const keyPaths = [];
  for (const containerKey of ['provider', 'providers']) {
    const models = config[containerKey]?.google?.models;
    if (!isPlainObject(models)) continue;
    const pluginModelIds = Object.keys(models).filter((modelId) => (
      isAntigravityPluginGoogleModel(modelId, models[modelId])
    ));
    if (pluginModelIds.length === 0) continue;
    keyPaths.push(...collapseRemovalKeyPaths(config, [containerKey, 'google', 'models'], pluginModelIds));
  }
  return keyPaths;
};
