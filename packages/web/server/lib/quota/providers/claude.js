import { readAuthFile } from '../../opencode/auth.js';
import { isPlainObject, readConfigLayers } from '../../opencode/shared.js';
import { readClaudeCodeStatusUsage } from './claude-code-status.js';
import { fetchClaudeCodeUsage } from './claude-code-usage.js';
import { fetchMeridianClaudeQuota, resolveSafeClaudeQuotaUrl } from './claude-meridian.js';
import { isAnthropicOAuthPluginSpec } from '../../opencode/anthropic-oauth-plugin.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
  toTimestamp
} from '../utils/index.js';

export const providerId = 'claude';
export const providerName = 'Claude';

export const aliases = ['anthropic', 'claude', 'anthropic-oauth', 'opencode-with-claude'];

const FIVE_HOUR_WINDOW_SECONDS = 5 * 60 * 60;
const SEVEN_DAY_WINDOW_SECONDS = 7 * 24 * 60 * 60;

export const isAnthropicOAuthProxyOptions = (options) => {
  if (!isPlainObject(options) || options.apiKey !== 'dummy' || typeof options.baseURL !== 'string') {
    return false;
  }

  try {
    const url = new URL(options.baseURL);
    return url.protocol === 'http:'
      && ['127.0.0.1', 'localhost'].includes(url.hostname)
      && Boolean(url.port)
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
};

export const hasAnthropicOAuthProxyConfig = (workingDirectory = null) => {
  const { userConfig, projectConfig, customConfig, mergedConfig } = readConfigLayers(workingDirectory);
  return [userConfig, projectConfig, customConfig, mergedConfig].some((config) => {
    const plugins = Array.isArray(config?.plugin) ? config.plugin : [];
    const providers = isPlainObject(config?.provider) ? config.provider : {};
    const anthropic = isPlainObject(providers.anthropic) ? providers.anthropic : null;
    const options = isPlainObject(anthropic?.options) ? anthropic.options : {};

    return plugins.some(isAnthropicOAuthPluginSpec) && isAnthropicOAuthProxyOptions(options);
  });
};

export const isConfigured = ({
  workingDirectory = null,
  isExternalRuntime = false,
  claudeProxyBaseUrl = null,
  readAuth = readAuthFile,
  hasProxyConfig = hasAnthropicOAuthProxyConfig,
} = {}) => {
  if (isExternalRuntime) return false;

  const auth = readAuth();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return Boolean(
    entry?.access
    || entry?.token
    || resolveSafeClaudeQuotaUrl(claudeProxyBaseUrl)
    || hasProxyConfig(workingDirectory)
  );
};

const buildOAuthUsage = (payload) => {
  const windows = {};
  for (const [key, value] of Object.entries(payload ?? {})) {
    if (key !== 'five_hour' && key !== 'seven_day' && !key.startsWith('seven_day_')) continue;
    if (!value || typeof value !== 'object') continue;
    const label = key === 'five_hour'
      ? '5h'
      : key === 'seven_day'
        ? '7d'
        : `7d-${key.slice('seven_day_'.length).replace(/_/g, '-')}`;
    const usedPercent = toNumber(value.utilization);
    if (usedPercent === null || usedPercent < 0) continue;
    windows[label] = toUsageWindow({
      usedPercent,
      windowSeconds: key === 'five_hour' ? FIVE_HOUR_WINDOW_SECONDS : SEVEN_DAY_WINDOW_SECONDS,
      resetAt: toTimestamp(value.resets_at),
    });
  }
  return { windows };
};

const hasPrimaryUsageWindow = (usage) => Boolean(
  usage?.windows?.['5h'] || usage?.windows?.['7d']
);

const buildDegradedStatusResult = (statusUsage, primaryFailure) => buildResult({
  providerId,
  providerName,
  ok: false,
  configured: true,
  usage: statusUsage.ok ? statusUsage.usage : null,
  usageUpdatedAt: statusUsage.ok ? statusUsage.usageUpdatedAt : undefined,
  error: primaryFailure.error || statusUsage.error || 'Claude usage is unavailable.',
  errorCode: primaryFailure.code || statusUsage.code,
});

export const fetchClaudeQuota = async ({
  readAuth = readAuthFile,
  hasProxyConfig = hasAnthropicOAuthProxyConfig,
  resolveProxyBaseUrl = async () => null,
  readStatusUsage = readClaudeCodeStatusUsage,
  fetchCliUsage = fetchClaudeCodeUsage,
  fetchMeridianUsage = fetchMeridianClaudeQuota,
  fetchImpl = globalThis.fetch,
  workingDirectory = null,
  isExternalRuntime = false,
  claudeProxyBaseUrl = null,
} = {}) => {
  if (isExternalRuntime) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  const auth = readAuth();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  const accessToken = entry?.access ?? entry?.token;
  let oauthFailure = null;

  if (accessToken) {
    try {
      const response = await fetchImpl('https://api.anthropic.com/api/oauth/usage', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20'
        }
      });

      if (!response.ok) {
        oauthFailure = {
          code: 'claude_oauth_usage_unavailable',
          error: `Anthropic OAuth usage returned HTTP ${response.status}.`,
        };
      } else {
        const payload = await response.json();
        const usage = buildOAuthUsage(payload);
        if (hasPrimaryUsageWindow(usage)) {
          return buildResult({
            providerId,
            providerName,
            ok: true,
            configured: true,
            usage,
            usageUpdatedAt: Date.now(),
          });
        }
        oauthFailure = {
          code: 'claude_oauth_usage_unavailable',
          error: 'Anthropic OAuth usage did not return subscription limits.',
        };
      }
    } catch (error) {
      oauthFailure = {
        code: 'claude_oauth_usage_unavailable',
        error: error instanceof Error ? error.message : 'Anthropic OAuth usage request failed.',
      };
    }
  }

  let resolvedProxyBaseUrl = claudeProxyBaseUrl;
  if (!resolveSafeClaudeQuotaUrl(resolvedProxyBaseUrl)) {
    try {
      resolvedProxyBaseUrl = await resolveProxyBaseUrl();
    } catch (error) {
      resolvedProxyBaseUrl = null;
      if (!oauthFailure) {
        oauthFailure = {
          code: 'claude_meridian_unavailable',
          error: error instanceof Error ? error.message : 'Failed to resolve the active Claude quota proxy.',
        };
      }
    }
  }

  const proxyConfigured = Boolean(
    resolveSafeClaudeQuotaUrl(resolvedProxyBaseUrl)
    || hasProxyConfig(workingDirectory)
  );
  if (!proxyConfigured) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: Boolean(accessToken),
      error: oauthFailure?.error ?? 'Not configured',
      errorCode: oauthFailure?.code,
    });
  }

  let meridianResult = {
    ok: false,
    code: 'claude_meridian_unavailable',
    error: 'The active Claude quota proxy could not be resolved.',
  };
  try {
    if (resolvedProxyBaseUrl) {
      meridianResult = await fetchMeridianUsage({ baseUrl: resolvedProxyBaseUrl, fetchImpl });
      if (meridianResult.ok) {
        return buildResult({
          providerId,
          providerName,
          ok: true,
          configured: true,
          usage: meridianResult.usage,
          usageUpdatedAt: meridianResult.usageUpdatedAt,
        });
      }
    }
  } catch (error) {
    meridianResult = {
      ok: false,
      code: 'claude_meridian_unavailable',
      error: error instanceof Error ? error.message : 'Failed to resolve the active Claude quota proxy.',
    };
  }

  let cliResult;
  try {
    cliResult = await fetchCliUsage();
  } catch (error) {
    cliResult = {
      ok: false,
      code: 'claude_code_usage_failed',
      error: error instanceof Error ? error.message : 'Failed to read Claude Code usage.',
    };
  }
  if (cliResult.ok) {
    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: cliResult.usage,
      usageUpdatedAt: cliResult.usageUpdatedAt,
    });
  }

  return buildDegradedStatusResult(readStatusUsage(), {
    code: cliResult.code || meridianResult.code || oauthFailure?.code,
    error: cliResult.error || meridianResult.error || oauthFailure?.error,
  });
};

export const fetchQuota = fetchClaudeQuota;
