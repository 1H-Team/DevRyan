import { readAuthFile } from '../../opencode/auth.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
} from '../utils/index.js';

export const providerId = 'opencode-go';
export const providerName = 'OpenCode Go';
export const aliases = ['opencode-go', 'opencodego', 'go'];

const DASHBOARD_USAGE_ERROR = 'OpenCode Go usage tracking requires OPENCODE_GO_WORKSPACE_ID and OPENCODE_GO_AUTH_COOKIE, or usageWorkspaceId and usageAuthCookie in auth["opencode-go"].';
const AUTH_COOKIE_ERROR = 'OpenCode Go dashboard authentication failed. Update OPENCODE_GO_AUTH_COOKIE or auth["opencode-go"].usageAuthCookie.';
const WORKSPACE_ID_PATTERN = /^wrk_[a-zA-Z0-9]+$/;
const GO_WINDOW_DEFINITIONS = {
  rolling: {
    label: 'rolling',
    windowSeconds: 5 * 60 * 60,
    description: '$12 of usage every 5 hours.',
  },
  weekly: {
    label: 'weekly',
    windowSeconds: 7 * 24 * 60 * 60,
    description: '$30 of usage per week.',
  },
  monthly: {
    label: 'monthly',
    windowSeconds: 30 * 24 * 60 * 60,
    description: '$60 of usage per month.',
  },
};

const trimString = (value) => (typeof value === 'string' ? value.trim() : '');

const extractBalancedObjectLiteral = (source, openBraceIndex) => {
  let depth = 0;
  let stringQuote = null;
  let escaped = false;

  for (let index = openBraceIndex; index < source.length; index += 1) {
    const char = source[index];

    if (stringQuote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === stringQuote) {
        stringQuote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      stringQuote = char;
      continue;
    }

    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openBraceIndex, index + 1);
      }
    }
  }

  return null;
};

const parseObjectLiteral = (objectLiteral) => {
  try {
    const jsonLike = objectLiteral.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)(\s*:)/g, '$1"$2"$3');
    return JSON.parse(jsonLike);
  } catch {
    return null;
  }
};

const resolveCredentials = ({ readAuth = readAuthFile, env = process.env } = {}) => {
  const auth = readAuth();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  const apiKey = trimString(entry?.key) || trimString(entry?.token) || trimString(entry?.access);
  const workspaceId = trimString(env.OPENCODE_GO_WORKSPACE_ID) || trimString(entry?.usageWorkspaceId);
  const authCookie = trimString(env.OPENCODE_GO_AUTH_COOKIE) || trimString(entry?.usageAuthCookie);

  return {
    apiConfigured: Boolean(apiKey),
    usageConfigured: Boolean(workspaceId && authCookie),
    workspaceId,
    authCookie,
  };
};

export const isConfigured = (options = {}) => {
  const credentials = resolveCredentials(options);
  return credentials.apiConfigured || credentials.usageConfigured;
};

const extractUsageObject = (html, key) => {
  const pattern = new RegExp(`["']?${key}Usage["']?\\s*[:=]?\\s*(?:\\$R\\[\\d+\\]\\s*=\\s*)?\\{`, 'g');
  let match;

  while ((match = pattern.exec(html)) !== null) {
    const openBraceIndex = match.index + match[0].lastIndexOf('{');
    const objectLiteral = extractBalancedObjectLiteral(html, openBraceIndex);
    if (!objectLiteral) {
      continue;
    }

    const usage = parseObjectLiteral(objectLiteral);
    if (usage) {
      return usage;
    }
  }

  return null;
};

export const parseOpenCodeGoUsageHtml = (html, now = Date.now()) => {
  const windows = {};

  for (const [key, definition] of Object.entries(GO_WINDOW_DEFINITIONS)) {
    const usage = extractUsageObject(html, key);
    if (!usage) {
      continue;
    }

    const usedPercent = toNumber(usage.usagePercent);
    const resetInSec = toNumber(usage.resetInSec);
    const resetAt = resetInSec === null ? null : now + resetInSec * 1000;

    windows[definition.label] = toUsageWindow({
      usedPercent,
      windowSeconds: definition.windowSeconds,
      resetAt,
      description: definition.description,
    });
  }

  if (Object.keys(windows).length === 0) {
    throw new Error('OpenCode Go dashboard usage fields were not found. The website structure may have changed.');
  }

  return { windows };
};

export const fetchQuota = async ({
  readAuth = readAuthFile,
  fetchImpl = globalThis.fetch,
  env = process.env,
} = {}) => {
  const credentials = resolveCredentials({ readAuth, env });

  if (!credentials.apiConfigured && !credentials.usageConfigured) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  if (!credentials.usageConfigured) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: DASHBOARD_USAGE_ERROR,
    });
  }

  if (!WORKSPACE_ID_PATTERN.test(credentials.workspaceId)) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: 'Invalid OpenCode Go workspace ID format.',
    });
  }

  try {
    const response = await fetchImpl(`https://opencode.ai/workspace/${encodeURIComponent(credentials.workspaceId)}/go`, {
      method: 'GET',
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Cookie: `auth=${credentials.authCookie}`,
      },
    });

    if (!response.ok) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: response.status === 401 || response.status === 403
          ? AUTH_COOKIE_ERROR
          : `OpenCode Go dashboard request failed: ${response.status}`,
      });
    }

    const html = await response.text();
    const usage = parseOpenCodeGoUsageHtml(html);

    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage,
    });
  } catch (error) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
};
