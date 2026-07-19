/**
 * Quota Providers Registry
 *
 * Implements quota fetching for various AI providers using a registry pattern.
 * @module quota/providers
 */

import { buildResult } from '../utils/index.js';

import * as claude from './claude.js';
import * as codex from './codex.js';
import * as copilot from './copilot.js';
import * as cursorAcp from './cursor-acp.js';
import * as google from './google/index.js';
import * as kimi from './kimi.js';
import * as nanogpt from './nanogpt.js';
import * as openai from './openai.js';
import * as opencodeGo from './opencode-go.js';
import * as openrouter from './openrouter.js';
import * as zai from './zai.js';
import * as zhipuaiCodingPlan from './zhipuai-coding-plan.js';
import * as minimaxCodingPlan from './minimax-coding-plan.js';
import * as minimaxCnCodingPlan from './minimax-cn-coding-plan.js';
import * as ollamaCloud from './ollama-cloud.js';

const registry = {
  claude: {
    providerId: claude.providerId,
    providerName: claude.providerName,
    isConfigured: claude.isConfigured,
    fetchQuota: claude.fetchQuota
  },
  codex: {
    providerId: codex.providerId,
    providerName: codex.providerName,
    isConfigured: codex.isConfigured,
    fetchQuota: codex.fetchQuota
  },
  'cursor-acp': {
    providerId: cursorAcp.providerId,
    providerName: cursorAcp.providerName,
    isConfigured: cursorAcp.isConfigured,
    fetchQuota: cursorAcp.fetchQuota
  },
  google: {
    providerId: 'google',
    providerName: 'Google',
    isConfigured: () => google.resolveGoogleAuthSources().some((source) => source.sourceId === 'gemini'),
    fetchQuota: google.fetchGoogleQuota
  },
  antigravity: {
    providerId: 'antigravity',
    providerName: 'Antigravity',
    isConfigured: () => google.resolveGoogleAuthSources().some((source) => source.sourceId === 'antigravity'),
    fetchQuota: google.fetchAntigravityQuota
  },
  'zai-coding-plan': {
    providerId: zai.providerId,
    providerName: zai.providerName,
    isConfigured: zai.isConfigured,
    fetchQuota: zai.fetchQuota
  },
  'zhipuai-coding-plan': {
    providerId: zhipuaiCodingPlan.providerId,
    providerName: zhipuaiCodingPlan.providerName,
    isConfigured: zhipuaiCodingPlan.isConfigured,
    fetchQuota: zhipuaiCodingPlan.fetchQuota
  },
  'kimi-for-coding': {
    providerId: kimi.providerId,
    providerName: kimi.providerName,
    isConfigured: kimi.isConfigured,
    fetchQuota: kimi.fetchQuota
  },
  openrouter: {
    providerId: openrouter.providerId,
    providerName: openrouter.providerName,
    isConfigured: openrouter.isConfigured,
    fetchQuota: openrouter.fetchQuota
  },
  'nano-gpt': {
    providerId: nanogpt.providerId,
    providerName: nanogpt.providerName,
    isConfigured: nanogpt.isConfigured,
    fetchQuota: nanogpt.fetchQuota
  },
  'github-copilot': {
    providerId: copilot.providerId,
    providerName: copilot.providerName,
    isConfigured: copilot.isConfigured,
    fetchQuota: copilot.fetchQuota
  },
  'github-copilot-addon': {
    providerId: copilot.providerIdAddon,
    providerName: copilot.providerNameAddon,
    isConfigured: copilot.isConfigured,
    fetchQuota: copilot.fetchQuotaAddon
  },
  'minimax-coding-plan': {
    providerId: minimaxCodingPlan.providerId,
    providerName: minimaxCodingPlan.providerName,
    isConfigured: minimaxCodingPlan.isConfigured,
    fetchQuota: minimaxCodingPlan.fetchQuota
  },
  'minimax-cn-coding-plan': {
    providerId: minimaxCnCodingPlan.providerId,
    providerName: minimaxCnCodingPlan.providerName,
    isConfigured: minimaxCnCodingPlan.isConfigured,
    fetchQuota: minimaxCnCodingPlan.fetchQuota
  },
  'ollama-cloud': {
    providerId: ollamaCloud.providerId,
    providerName: ollamaCloud.providerName,
    isConfigured: ollamaCloud.isConfigured,
    fetchQuota: ollamaCloud.fetchQuota
  },
  'opencode-go': {
    providerId: opencodeGo.providerId,
    providerName: opencodeGo.providerName,
    isConfigured: opencodeGo.isConfigured,
    fetchQuota: opencodeGo.fetchQuota
  }
};

const providerAliases = new Map([
  ['anthropic', 'claude'],
  ['anthropic-oauth', 'claude'],
  ['opencode-with-claude', 'claude'],
  ['zhipuai', 'zhipuai-coding-plan'],
  ['zhipu', 'zhipuai-coding-plan'],
  ['cursor', 'cursor-acp'],
]);

const resolveProviderId = (providerId) => providerAliases.get(providerId) ?? providerId;

export const listConfiguredQuotaProviders = (options = {}) => {
  const configured = [];

  for (const [id, provider] of Object.entries(registry)) {
    try {
      if (provider.isConfigured(options)) {
        configured.push(id);
      }
    } catch {
      // Ignore provider-specific config errors in list API.
    }
  }

  return configured;
};

export const fetchQuotaForProvider = async (providerId, options = {}) => {
  const resolvedProviderId = resolveProviderId(providerId);
  const provider = registry[resolvedProviderId];

  if (!provider) {
    return buildResult({
      providerId,
      providerName: providerId,
      ok: false,
      configured: false,
      error: 'Unsupported provider'
    });
  }

  try {
    return await provider.fetchQuota(options);
  } catch (error) {
    return buildResult({
      providerId: provider.providerId,
      providerName: provider.providerName,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed'
    });
  }
};

export const fetchClaudeQuota = claude.fetchQuota;
export const fetchOpenaiQuota = openai.fetchQuota;
export const fetchGoogleQuota = google.fetchGoogleQuota;
export const fetchAntigravityQuota = google.fetchAntigravityQuota;
export const fetchCodexQuota = codex.fetchQuota;
export const fetchCursorAcpQuota = cursorAcp.fetchQuota;
export const fetchCopilotQuota = copilot.fetchQuota;
export const fetchCopilotAddonQuota = copilot.fetchQuotaAddon;
export const fetchKimiQuota = kimi.fetchQuota;
export const fetchOpenRouterQuota = openrouter.fetchQuota;
export const fetchZaiQuota = zai.fetchQuota;
export const fetchZhipuaiCodingPlanQuota = zhipuaiCodingPlan.fetchQuota;
export const fetchNanoGptQuota = nanogpt.fetchQuota;
export const fetchMinimaxCodingPlanQuota = minimaxCodingPlan.fetchQuota;
export const fetchMinimaxCnCodingPlanQuota = minimaxCnCodingPlan.fetchQuota;
export const fetchOllamaCloudQuota = ollamaCloud.fetchQuota;
export const fetchOpenCodeGoQuota = opencodeGo.fetchQuota;
export const fetchZhipuaiQuota = zhipuaiCodingPlan.fetchQuota;
