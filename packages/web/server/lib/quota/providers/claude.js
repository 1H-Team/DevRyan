import { readAuthFile } from '../../opencode/auth.js';
import { isPlainObject, readConfigLayers } from '../../opencode/shared.js';
import { readClaudeCodeStatusUsage } from './claude-code-status.js';
import { refreshClaudeCodeStatusUsage } from './claude-code-status-refresh.js';
import { isAnthropicOAuthPluginSpec } from '../../opencode/anthropic-oauth-plugin.js';
import {
  CLAUDE_CODE_STATUS_LINE_CUSTOM_CODE,
  CLAUDE_CODE_USAGE_PENDING_MESSAGE,
  ensureClaudeCodeStatusLineBridge
} from './claude-code-status-setup.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
  toTimestamp
} from '../utils/index.js';

export const providerId = 'claude';
export const providerName = 'Anthropic';

export const aliases = ['anthropic', 'claude', 'anthropic-oauth', 'opencode-with-claude'];

const FIVE_HOUR_WINDOW_SECONDS = 5 * 60 * 60;
const SEVEN_DAY_WINDOW_SECONDS = 7 * 24 * 60 * 60;

export const isAnthropicOAuthProxyOptions = (options) => {
  if (!isPlainObject(options) || options.apiKey !== 'dummy' || typeof options.baseURL !== 'string') {
    return false;
  }

  try {
    const url = new URL(options.baseURL);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) && Boolean(url.port);
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

export const isConfigured = ({ workingDirectory = null } = {}) => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return Boolean(entry?.access || entry?.token || hasAnthropicOAuthProxyConfig(workingDirectory));
};

export const fetchClaudeQuota = async ({
  readAuth = readAuthFile,
  hasProxyConfig = hasAnthropicOAuthProxyConfig,
  readStatusUsage = readClaudeCodeStatusUsage,
  ensureStatusLineBridge = ensureClaudeCodeStatusLineBridge,
  refreshStatusUsage = refreshClaudeCodeStatusUsage,
  fetchImpl = globalThis.fetch,
  forceRefresh = false,
  workingDirectory = null,
} = {}) => {
  const auth = readAuth();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  const accessToken = entry?.access ?? entry?.token;

  if (!accessToken) {
    const proxyConfigured = hasProxyConfig(workingDirectory);
    if (proxyConfigured) {
      const setup = ensureStatusLineBridge();
      if (!setup.ok) {
        if (setup.code === CLAUDE_CODE_STATUS_LINE_CUSTOM_CODE) {
          const statusUsage = readStatusUsage();
          if (statusUsage.ok) {
            return buildResult({
              providerId,
              providerName,
              ok: true,
              configured: true,
              usage: statusUsage.usage
            });
          }
        }

        return buildResult({
          providerId,
          providerName,
          ok: false,
          configured: true,
          error: setup.error || 'Claude Code usage bridge could not be configured.',
          errorCode: setup.code
        });
      }

      if (forceRefresh) {
        const refreshResult = await refreshStatusUsage();
        const refreshedStatusUsage = readStatusUsage();
        if (refreshedStatusUsage.ok) {
          return buildResult({
            providerId,
            providerName,
            ok: true,
            configured: true,
            usage: refreshedStatusUsage.usage
          });
        }

        if (!refreshResult.ok) {
          return buildResult({
            providerId,
            providerName,
            ok: false,
            configured: true,
            error: refreshResult.error || refreshedStatusUsage.error || CLAUDE_CODE_USAGE_PENDING_MESSAGE,
            errorCode: refreshResult.code || refreshedStatusUsage.code
          });
        }

        return buildResult({
          providerId,
          providerName,
          ok: false,
          configured: true,
          error: refreshedStatusUsage.error || 'Claude CLI ran successfully, but Claude Code did not emit usage data for OpenChamber to read.',
          errorCode: refreshedStatusUsage.code
        });
      }

      const statusUsage = readStatusUsage();
      if (statusUsage.ok) {
        return buildResult({
          providerId,
          providerName,
          ok: true,
          configured: true,
          usage: statusUsage.usage
        });
      }

      const refreshResult = await refreshStatusUsage();
      if (refreshResult.ok) {
        const refreshedStatusUsage = readStatusUsage();
        if (refreshedStatusUsage.ok) {
          return buildResult({
            providerId,
            providerName,
            ok: true,
            configured: true,
            usage: refreshedStatusUsage.usage
          });
        }

        return buildResult({
          providerId,
          providerName,
          ok: false,
          configured: true,
          error: refreshedStatusUsage.error || 'Claude CLI ran successfully, but Claude Code did not emit usage data for OpenChamber to read.',
          errorCode: refreshedStatusUsage.code
        });
      }

      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: refreshResult.error || statusUsage.error || CLAUDE_CODE_USAGE_PENDING_MESSAGE,
        errorCode: refreshResult.code || statusUsage.code
      });
    }

    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  try {
    const response = await fetchImpl('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20'
      }
    });

    if (!response.ok) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: `API error: ${response.status}`
      });
    }

    const payload = await response.json();
    const windows = {};
    const fiveHour = payload?.five_hour ?? null;
    const sevenDay = payload?.seven_day ?? null;
    const sevenDaySonnet = payload?.seven_day_sonnet ?? null;
    const sevenDayOpus = payload?.seven_day_opus ?? null;

    if (fiveHour) {
      windows['5h'] = toUsageWindow({
        usedPercent: toNumber(fiveHour.utilization),
        windowSeconds: FIVE_HOUR_WINDOW_SECONDS,
        resetAt: toTimestamp(fiveHour.resets_at)
      });
    }
    if (sevenDay) {
      windows['7d'] = toUsageWindow({
        usedPercent: toNumber(sevenDay.utilization),
        windowSeconds: SEVEN_DAY_WINDOW_SECONDS,
        resetAt: toTimestamp(sevenDay.resets_at)
      });
    }
    if (sevenDaySonnet) {
      windows['7d-sonnet'] = toUsageWindow({
        usedPercent: toNumber(sevenDaySonnet.utilization),
        windowSeconds: SEVEN_DAY_WINDOW_SECONDS,
        resetAt: toTimestamp(sevenDaySonnet.resets_at)
      });
    }
    if (sevenDayOpus) {
      windows['7d-opus'] = toUsageWindow({
        usedPercent: toNumber(sevenDayOpus.utilization),
        windowSeconds: SEVEN_DAY_WINDOW_SECONDS,
        resetAt: toTimestamp(sevenDayOpus.resets_at)
      });
    }

    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows }
    });
  } catch (error) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed'
    });
  }
};

export const fetchQuota = fetchClaudeQuota;
