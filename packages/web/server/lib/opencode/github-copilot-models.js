export const GITHUB_COPILOT_FALLBACK_MODELS = {
  'gpt-5.1-codex': {
    id: 'gpt-5.1-codex',
    name: 'GPT-5.1 Codex',
    api: {
      id: 'gpt-5.1-codex',
      url: 'https://api.githubcopilot.com',
      npm: '@ai-sdk/github-copilot',
    },
  },
};

const GITHUB_COPILOT_MODEL_URL = 'https://api.githubcopilot.com/models';
const GITHUB_COPILOT_AUTH_ALIASES = ['github-copilot', 'copilot'];
const GITHUB_COPILOT_API_BASE = 'https://api.githubcopilot.com';
const GITHUB_COPILOT_NPM = '@ai-sdk/github-copilot';
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
      : typeof entry?.refresh === 'string'
        ? entry.refresh
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

const isEmbeddingModelId = (id) => /embedding/i.test(String(id || ''));

const hasCapabilityShape = (row) => (
  isPlainObject(row?.capabilities)
  && (isPlainObject(row.capabilities.limits) || isPlainObject(row.capabilities.supports))
);

const isUsableChatModel = (row) => {
  if (!isPlainObject(row)) {
    return false;
  }
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  if (!id || isEmbeddingModelId(id)) {
    return false;
  }
  if (row.policy?.state === 'disabled') {
    return false;
  }
  // Legacy/minimal payloads without capability metadata stay selectable so
  // emergency fallbacks and older fixtures keep working.
  if (!hasCapabilityShape(row)) {
    return true;
  }
  const limits = row.capabilities.limits;
  const supports = row.capabilities.supports;
  if (!isPlainObject(limits) || !isPlainObject(supports)) {
    return false;
  }
  if (typeof limits.max_output_tokens !== 'number') {
    return false;
  }
  if (typeof limits.max_prompt_tokens !== 'number') {
    return false;
  }
  if (typeof supports.tool_calls !== 'boolean') {
    return false;
  }
  return true;
};

const buildModelApi = (row, id) => {
  const endpoints = Array.isArray(row?.supported_endpoints) ? row.supported_endpoints : [];
  const isMsgApi = endpoints.includes('/v1/messages');
  const endpoint = isMsgApi
    ? 'messages'
    : endpoints.includes('/responses')
      ? 'responses'
      : endpoints.includes('/chat/completions')
        ? 'chat'
        : undefined;
  return {
    id,
    url: isMsgApi ? `${GITHUB_COPILOT_API_BASE}/v1` : GITHUB_COPILOT_API_BASE,
    npm: isMsgApi ? '@ai-sdk/anthropic' : GITHUB_COPILOT_NPM,
    ...(endpoint ? { endpoint } : {}),
  };
};

export const enrichGitHubCopilotModelEntry = (entry, modelId) => {
  const id = typeof modelId === 'string' && modelId.trim()
    ? modelId.trim()
    : (typeof entry?.id === 'string' ? entry.id.trim() : '');
  if (!id) {
    return null;
  }
  const name = typeof entry?.name === 'string' && entry.name.trim()
    ? entry.name.trim()
    : formatModelName(id);
  const existingApi = isPlainObject(entry?.api) ? entry.api : null;
  return {
    ...(isPlainObject(entry) ? entry : {}),
    id,
    name,
    api: existingApi && typeof existingApi.id === 'string' && existingApi.id.trim()
      ? {
        id: existingApi.id.trim(),
        url: typeof existingApi.url === 'string' && existingApi.url.trim()
          ? existingApi.url.trim()
          : GITHUB_COPILOT_API_BASE,
        npm: typeof existingApi.npm === 'string' && existingApi.npm.trim()
          ? existingApi.npm.trim()
          : GITHUB_COPILOT_NPM,
        ...(typeof existingApi.endpoint === 'string' && existingApi.endpoint.trim()
          ? { endpoint: existingApi.endpoint.trim() }
          : {}),
      }
      : buildModelApi(entry, id),
  };
};

export const enrichGitHubCopilotModels = (models) => {
  if (!isPlainObject(models)) {
    return {};
  }
  const next = {};
  for (const [modelId, entry] of Object.entries(models)) {
    const enriched = enrichGitHubCopilotModelEntry(entry, modelId);
    if (enriched) {
      next[enriched.id] = enriched;
    }
  }
  return next;
};

const normalizeCopilotModelsPayload = (payload) => {
  const rows = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : [];
  const usable = rows.filter(isUsableChatModel);
  const hasCapabilityRows = usable.some(hasCapabilityShape);
  const pickerEnabled = hasCapabilityRows
    ? usable.filter((row) => row.model_picker_enabled === true)
    : [];
  const selected = pickerEnabled.length > 0 ? pickerEnabled : usable;
  const models = {};

  for (const row of selected) {
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    if (!id || Object.prototype.hasOwnProperty.call(models, id)) {
      continue;
    }
    const enriched = enrichGitHubCopilotModelEntry(row, id);
    if (enriched) {
      models[id] = enriched;
    }
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
