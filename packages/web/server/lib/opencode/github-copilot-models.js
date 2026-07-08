export const GITHUB_COPILOT_FALLBACK_MODELS = {
  'gpt-5.1-codex': { id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex' },
};

const GITHUB_COPILOT_MODEL_URL = 'https://api.githubcopilot.com/models';
const GITHUB_COPILOT_AUTH_ALIASES = ['github-copilot', 'copilot'];
const ACCOUNT_MODELS_CACHE_TTL_MS = 5 * 60 * 1000;

let accountModelsCache = null;

const isPlainObject = (value) => (
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
);

const getAuthEntry = (auth) => {
  if (!isPlainObject(auth)) {
    return null;
  }
  for (const providerId of GITHUB_COPILOT_AUTH_ALIASES) {
    const entry = auth[providerId];
    if (isPlainObject(entry)) {
      return entry;
    }
  }
  return null;
};

const getAccessToken = (auth) => {
  const entry = getAuthEntry(auth);
  const token = typeof entry?.access === 'string'
    ? entry.access
    : typeof entry?.token === 'string'
      ? entry.token
      : '';
  return token.trim();
};

const formatModelName = (modelId) => {
  const leaf = String(modelId).split('/').filter(Boolean).pop() || String(modelId);
  return leaf
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => {
      if (/^gpt$/i.test(part)) return 'GPT';
      if (/^ai$/i.test(part)) return 'AI';
      if (/^\d/.test(part)) return part;
      return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
    })
    .join(' ');
};

const normalizeCopilotModelsPayload = (payload) => {
  const rows = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : [];
  const models = {};

  for (const row of rows) {
    if (!isPlainObject(row)) {
      continue;
    }
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    if (!id || Object.prototype.hasOwnProperty.call(models, id)) {
      continue;
    }
    const name = typeof row.name === 'string' && row.name.trim()
      ? row.name.trim()
      : formatModelName(id);
    models[id] = { id, name };
  }

  return models;
};

export const __resetGitHubCopilotModelDiscoveryCache = () => {
  accountModelsCache = null;
};

export const discoverGitHubCopilotModels = async ({
  readAuthFile,
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) => {
  let auth = {};
  if (typeof readAuthFile === 'function') {
    try {
      auth = readAuthFile();
    } catch {
      // A corrupt/unreadable auth file must not crash provider discovery;
      // treat it as "no usable credentials" so the provider payload still builds.
      return { source: 'unavailable', models: {} };
    }
  }
  const accessToken = getAccessToken(auth);

  if (!accessToken) {
    return { source: 'unavailable', models: {} };
  }

  const currentTime = Number(now());
  if (
    accountModelsCache
    && accountModelsCache.accessToken === accessToken
    && accountModelsCache.expiresAt > currentTime
  ) {
    return accountModelsCache.result;
  }

  if (typeof fetchImpl !== 'function') {
    return { source: 'fallback', models: GITHUB_COPILOT_FALLBACK_MODELS };
  }

  try {
    const response = await fetchImpl(GITHUB_COPILOT_MODEL_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Copilot-Integration-Id': 'vscode-chat',
        'Editor-Version': 'vscode/1.96.2',
      },
    });

    if (!response?.ok) {
      throw new Error(`GitHub Copilot models request failed (${response?.status || 'unknown'})`);
    }

    const payload = await response.json();
    const models = normalizeCopilotModelsPayload(payload);
    if (Object.keys(models).length === 0) {
      throw new Error('GitHub Copilot models response did not include models');
    }

    const result = { source: 'account', models };
    accountModelsCache = {
      accessToken,
      expiresAt: currentTime + ACCOUNT_MODELS_CACHE_TTL_MS,
      result,
    };
    return result;
  } catch {
    return { source: 'fallback', models: GITHUB_COPILOT_FALLBACK_MODELS };
  }
};
