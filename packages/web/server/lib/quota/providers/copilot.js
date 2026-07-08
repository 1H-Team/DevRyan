import { readAuthFile } from '../../opencode/auth.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
  toTimestamp
} from '../utils/index.js';

const COPILOT_AI_CREDITS_DESCRIPTION = 'AI Credits are consumed from token usage, including input, output, and cached tokens.';

const isTokenBasedBillingPayload = (payload) => (
  payload?.token_based_billing !== undefined
  || payload?.billing_model === 'usage_based'
  || payload?.billing_model === 'token_based'
  || payload?.usage_based_billing === true
);

const resolveResetAt = (payload) => (
  toTimestamp(payload?.quota_reset_date_utc)
  ?? toTimestamp(payload?.quota_reset_date)
);

const buildCopilotWindows = (payload) => {
  const quota = payload?.quota_snapshots ?? {};
  const resetAt = resolveResetAt(payload);
  const isTokenBasedBilling = isTokenBasedBillingPayload(payload);
  const windows = {};

  const addWindow = (label, snapshot, options = {}) => {
    if (!snapshot) return;
    const entitlement = toNumber(snapshot.entitlement);
    const remaining = toNumber(snapshot.remaining) ?? toNumber(snapshot.quota_remaining);
    const percentRemaining = toNumber(snapshot.percent_remaining);
    const usedPercent = entitlement && remaining !== null
      ? Math.max(0, 100 - (remaining / entitlement) * 100)
      : percentRemaining !== null
        ? Math.max(0, 100 - percentRemaining)
      : null;
    const valueLabel = entitlement !== null && remaining !== null && options.unit
      ? `${remaining.toFixed(0)} / ${entitlement.toFixed(0)} ${options.unit} left`
      : entitlement !== null && remaining !== null
        ? `${remaining.toFixed(0)} / ${entitlement.toFixed(0)} left`
      : null;
    windows[label] = toUsageWindow({
      usedPercent,
      windowSeconds: null,
      resetAt,
      valueLabel,
      description: options.description
    });
  };

  if (isTokenBasedBilling) {
    addWindow('ai-credits', quota.premium_interactions ?? quota.ai_credits ?? quota.credits, {
      unit: 'credits',
      description: COPILOT_AI_CREDITS_DESCRIPTION
    });
    return windows;
  }

  addWindow('chat', quota.chat, { unit: 'requests' });
  addWindow('completions', quota.completions, { unit: 'requests' });
  addWindow('premium', quota.premium_interactions, { unit: 'requests' });

  return windows;
};

export const providerId = 'github-copilot';
export const providerName = 'GitHub Copilot';
export const aliases = ['github-copilot', 'copilot'];

export const isConfigured = () => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return Boolean(entry?.access || entry?.token);
};

export const fetchQuota = async (options = {}) => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  const accessToken = entry?.access ?? entry?.token;
  const fetchImpl = options.fetchImpl ?? fetch;

  if (!accessToken) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  try {
    const response = await fetchImpl('https://api.github.com/copilot_internal/user', {
      method: 'GET',
      headers: {
        Authorization: `token ${accessToken}`,
        Accept: 'application/json',
        'Editor-Version': 'vscode/1.96.2',
        'X-Github-Api-Version': '2025-04-01'
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
    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows: buildCopilotWindows(payload) }
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

export const providerIdAddon = 'github-copilot-addon';
export const providerNameAddon = 'GitHub Copilot Add-on';

export const fetchQuotaAddon = async (options = {}) => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  const accessToken = entry?.access ?? entry?.token;
  const fetchImpl = options.fetchImpl ?? fetch;

  if (!accessToken) {
    return buildResult({
      providerId: providerIdAddon,
      providerName: providerNameAddon,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  try {
    const response = await fetchImpl('https://api.github.com/copilot_internal/user', {
      method: 'GET',
      headers: {
        Authorization: `token ${accessToken}`,
        Accept: 'application/json',
        'Editor-Version': 'vscode/1.96.2',
        'X-Github-Api-Version': '2025-04-01'
      }
    });

    if (!response.ok) {
      return buildResult({
        providerId: providerIdAddon,
        providerName: providerNameAddon,
        ok: false,
        configured: true,
        error: `API error: ${response.status}`
      });
    }

    const payload = await response.json();
    const windows = buildCopilotWindows(payload);
    const premium = windows['ai-credits']
      ? { 'ai-credits': windows['ai-credits'] }
      : windows.premium
        ? { premium: windows.premium }
        : windows;

    return buildResult({
      providerId: providerIdAddon,
      providerName: providerNameAddon,
      ok: true,
      configured: true,
      usage: { windows: premium }
    });
  } catch (error) {
    return buildResult({
      providerId: providerIdAddon,
      providerName: providerNameAddon,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed'
    });
  }
};
