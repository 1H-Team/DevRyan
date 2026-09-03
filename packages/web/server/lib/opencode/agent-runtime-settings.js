import {
  getOpenchamberSidecarPath,
  readOpenchamberSidecar,
  writeOpenchamberSidecar,
} from './openchamber-sidecar.js';

// Runtime knobs for the managed `opencode serve` process live under their own
// sidecar key (`openchamber.agentRuntime`), next to `agentOverrides` and
// `agentBackupModels`. OpenCode never reads the sidecar; the runtime overlay
// (`runtime-agent-overlays.js`) translates these settings into OpenCode config.
const AGENT_RUNTIME_SETTINGS_KEY = 'agentRuntime';
const DEFAULT_AGENT_RUNTIME_SETTINGS = Object.freeze({
  // Language servers (typescript-language-server, etc.) for agent sessions.
  // Agents run their own type-checkers, and OpenCode's tsserver held ~4.7 GiB
  // across a 15-session run, so this is the switch the UI exposes.
  lsp: true,
});
const AGENT_RUNTIME_SETTING_KEYS = Object.freeze(Object.keys(DEFAULT_AGENT_RUNTIME_SETTINGS));
const READ_CACHE_TTL_MS = 5_000;
// Validation failures carry a code (like `invalid_orchestration_limits`) so the
// settings route can answer 400 for them and 500 for a failed sidecar write.
const INVALID_AGENT_RUNTIME_SETTINGS_CODE = 'invalid_agent_runtime_settings';
const invalidAgentRuntimeSettings = (message) => (
  Object.assign(new Error(message), { code: INVALID_AGENT_RUNTIME_SETTINGS_CODE })
);

const readCache = new Map();

const isPlainObject = (value) => (
  Boolean(value)
  && typeof value === 'object'
  && !Array.isArray(value)
);

const resolveCacheKey = (options = {}) => getOpenchamberSidecarPath(
  typeof options.userConfigPath === 'string' && options.userConfigPath.length > 0
    ? options.userConfigPath
    : undefined,
);

/**
 * Lenient normalization for values read from disk: unknown keys are dropped,
 * anything that is not an explicit boolean falls back to the default.
 */
const normalizeAgentRuntimeSettings = (raw) => {
  const source = isPlainObject(raw) ? raw : {};
  return {
    lsp: typeof source.lsp === 'boolean' ? source.lsp : DEFAULT_AGENT_RUNTIME_SETTINGS.lsp,
  };
};

/**
 * Strict validation for values written by callers (settings routes): only the
 * known keys are accepted and each must be a boolean. Throws on bad input so a
 * route can answer 400 instead of silently persisting garbage.
 */
const validateAgentRuntimeSettingsPatch = (partial) => {
  if (!isPlainObject(partial)) {
    throw invalidAgentRuntimeSettings('Agent runtime settings must be a plain object');
  }
  const patch = {};
  for (const [key, value] of Object.entries(partial)) {
    if (!AGENT_RUNTIME_SETTING_KEYS.includes(key)) {
      throw invalidAgentRuntimeSettings(`Unknown agent runtime setting: ${key}`);
    }
    if (typeof value !== 'boolean') {
      throw invalidAgentRuntimeSettings(`Agent runtime setting "${key}" must be a boolean`);
    }
    patch[key] = value;
  }
  return patch;
};

const clearAgentRuntimeSettingsCache = () => {
  readCache.clear();
};

const readAgentRuntimeSettings = (options = {}) => {
  const cacheKey = resolveCacheKey(options);
  const now = Date.now();
  const cached = readCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return { ...cached.settings };
  }

  const sidecar = readOpenchamberSidecar(options.userConfigPath);
  const settings = normalizeAgentRuntimeSettings(sidecar?.[AGENT_RUNTIME_SETTINGS_KEY]);
  readCache.set(cacheKey, { settings, expiresAt: now + READ_CACHE_TTL_MS });
  return { ...settings };
};

const writeAgentRuntimeSettings = (partial, options = {}) => {
  const patch = validateAgentRuntimeSettingsPatch(partial);
  const sidecar = readOpenchamberSidecar(options.userConfigPath) || {};
  const current = normalizeAgentRuntimeSettings(sidecar[AGENT_RUNTIME_SETTINGS_KEY]);
  const next = { ...current, ...patch };

  writeOpenchamberSidecar({
    ...sidecar,
    [AGENT_RUNTIME_SETTINGS_KEY]: next,
  }, options.userConfigPath);
  // Any cached read (including reads keyed by another sidecar path) is stale
  // relative to the just-written value; the map is tiny, so drop everything.
  clearAgentRuntimeSettingsCache();
  return { ...next };
};

export {
  AGENT_RUNTIME_SETTINGS_KEY,
  DEFAULT_AGENT_RUNTIME_SETTINGS,
  INVALID_AGENT_RUNTIME_SETTINGS_CODE,
  READ_CACHE_TTL_MS as AGENT_RUNTIME_SETTINGS_CACHE_TTL_MS,
  clearAgentRuntimeSettingsCache,
  normalizeAgentRuntimeSettings,
  readAgentRuntimeSettings,
  writeAgentRuntimeSettings,
};
