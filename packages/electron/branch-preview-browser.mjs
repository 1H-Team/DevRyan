import crypto from 'node:crypto';

export const AGENT_PREVIEW_PARTITION_PREFIX = 'persist:openchamber-browser-agent-';

const safeString = (value, maxLength) => (
  typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
);

export const normalizeAgentPreviewOrigin = (value) => {
  const raw = safeString(value, 4_096);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.origin !== raw) return '';
    return parsed.origin;
  } catch {
    return '';
  }
};

export const createAgentPreviewPartition = ({ ownerUserId, previewOrigin } = {}) => {
  const owner = safeString(ownerUserId, 256);
  const origin = normalizeAgentPreviewOrigin(previewOrigin);
  if (!owner || !origin || owner.includes('\u0000')) return null;
  const identity = crypto.createHash('sha256').update(`${owner}\u0000${origin}`).digest('hex').slice(0, 40);
  return `${AGENT_PREVIEW_PARTITION_PREFIX}${identity}`;
};

const comparableRequestOrigin = (value) => {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'https:') return parsed.origin;
    if (parsed.protocol === 'wss:') return `https://${parsed.host}`;
    return '';
  } catch {
    return '';
  }
};

const removeHeader = (headers, name) => {
  const lowerName = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowerName) delete headers[key];
  }
};

export const injectBranchPreviewHeaders = ({ url, requestHeaders }, credential) => {
  const headers = { ...(requestHeaders || {}) };
  const origin = normalizeAgentPreviewOrigin(credential?.origin);
  const clientId = safeString(credential?.clientId, 512);
  const clientSecret = safeString(credential?.clientSecret, 2_048);
  if (!origin || !clientId || !clientSecret || comparableRequestOrigin(url) !== origin) return headers;
  removeHeader(headers, 'CF-Access-Client-Id');
  removeHeader(headers, 'CF-Access-Client-Secret');
  headers['CF-Access-Client-Id'] = clientId;
  headers['CF-Access-Client-Secret'] = clientSecret;
  return headers;
};

export const normalizeAgentPreviewCredential = (credential, expectedOrigin) => {
  if (!credential) return null;
  const origin = normalizeAgentPreviewOrigin(credential.origin);
  const clientId = safeString(credential.clientId, 512);
  const clientSecret = safeString(credential.clientSecret, 2_048);
  if (!origin || origin !== normalizeAgentPreviewOrigin(expectedOrigin) || !clientId || !clientSecret) {
    throw new Error('branch_preview_credential_invalid');
  }
  return Object.freeze({ origin, clientId, clientSecret });
};
