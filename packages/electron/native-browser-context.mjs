import { createHash } from 'node:crypto';

export const MANUAL_BROWSER_PARTITION_PREFIX = 'persist:openchamber-browser-user-';

const normalizeHttpOrigin = (rawOrigin) => {
  try {
    const parsed = new URL(String(rawOrigin || ''));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.origin;
  } catch {
    return '';
  }
};

export const readAuthorizedBrowserPrincipal = (payload) => {
  if (!payload || typeof payload !== 'object' || payload.authenticated !== true) return null;
  const principal = payload.principal;
  if (!principal || typeof principal !== 'object') return null;
  const id = typeof principal.id === 'string' ? principal.id.trim() : '';
  if (!id || principal.policy?.browser !== true) return null;
  return { id };
};

export const createManualBrowserContext = ({ origin, principalId } = {}) => {
  const normalizedOrigin = normalizeHttpOrigin(origin);
  const normalizedPrincipalId = typeof principalId === 'string' ? principalId.trim() : '';
  if (!normalizedOrigin || !normalizedPrincipalId) {
    throw new Error('Authenticated Browser origin and principal are required');
  }
  const contextKey = createHash('sha256')
    .update(normalizedOrigin)
    .update('\0')
    .update(normalizedPrincipalId)
    .digest('hex');
  return {
    contextKey,
    origin: normalizedOrigin,
    partition: `${MANUAL_BROWSER_PARTITION_PREFIX}${contextKey}`,
  };
};
