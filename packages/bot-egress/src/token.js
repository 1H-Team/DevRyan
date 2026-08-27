import crypto from 'node:crypto';

const TOKEN_VERSION = 1;
const TOKEN_PREFIX = 'drb1';
const MAX_TOKEN_LENGTH = 8192;
const MAX_CAPABILITY_TTL_MS = 15 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 30_000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
export const EGRESS_TOKEN_PURPOSES = Object.freeze(['model', 'agent', 'browser']);
export const BROWSER_NETWORK_MODES = Object.freeze(['public_only', 'allowlist']);
export const AGENT_ACTIVATION_MODES = Object.freeze(['required', 'connection_health']);

export class EgressTokenError extends Error {
  constructor(message = 'Model egress token is invalid', code = 'bot_egress_token_invalid') {
    super(message);
    this.name = 'EgressTokenError';
    this.code = code;
    this.statusCode = 407;
  }
}

const fail = (message, code) => {
  throw new EgressTokenError(message, code);
};

const assertExactKeys = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    fail('Model egress token claims are invalid');
  }
};

const normalizeSecret = (secret) => {
  const value = Buffer.isBuffer(secret) ? Buffer.from(secret) : Buffer.from(secret || '', 'utf8');
  if (value.byteLength < 32 || value.byteLength > 128) {
    value.fill(0);
    fail('Model egress signing key is invalid', 'bot_egress_configuration_invalid');
  }
  return value;
};

const renderAuthority = (hostname, port) => (
  hostname.includes(':') ? `[${hostname}]:${port}` : `${hostname}:${port}`
);

const normalizeHosts = (hosts, maximum) => {
  if (!Array.isArray(hosts) || hosts.length === 0 || hosts.length > maximum) {
    fail('Model host allowlist is invalid');
  }
  const normalized = new Set();
  for (const candidate of hosts) {
    if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 2048
      || /[\u0000-\u001f\u007f\s]/u.test(candidate)) {
      fail('Model host allowlist is invalid');
    }
    const withScheme = candidate.includes('://') ? candidate : `https://${candidate}`;
    let url;
    try {
      url = new URL(withScheme);
    } catch {
      fail('Model host allowlist is invalid');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.search || url.hash || (!candidate.includes('://') && url.pathname !== '/')) {
      fail('Model host allowlist is invalid');
    }
    const rawHostname = url.hostname.toLowerCase().replace(/\.$/, '');
    const hostname = rawHostname.startsWith('[') && rawHostname.endsWith(']')
      ? rawHostname.slice(1, -1)
      : rawHostname;
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    let hostnameValid;
    if (hostname.includes(':')) {
      hostnameValid = /^[0-9a-f:.]+$/.test(hostname);
    } else {
      hostnameValid = hostname.length <= 253
        && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(hostname)
        && !hostname.includes('..')
        && hostname.split('.').every((label) => (
          label.length <= 63 && !label.startsWith('-') && !label.endsWith('-')
        ));
    }
    if (!hostnameValid || !/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
      fail('Model host allowlist is invalid');
    }
    normalized.add(renderAuthority(hostname, port));
  }
  return Object.freeze([...normalized].sort());
};

export const normalizeModelHosts = (hosts) => normalizeHosts(hosts, 32);
export const normalizeBrowserHosts = (hosts) => normalizeHosts(hosts, 64);

const validateClaims = (claims) => {
  const legacy = claims && typeof claims === 'object' && !Object.hasOwn(claims, 'purpose');
  const purpose = legacy ? 'model' : claims?.purpose;
  const browser = purpose === 'browser';
  const agent = purpose === 'agent';
  assertExactKeys(claims, [
    'version',
    'deploymentId',
    'botId',
    'revisionId',
    'hosts',
    'issuedAt',
    'expiresAt',
    'nonce',
    ...(legacy ? [] : ['purpose']),
    ...(browser ? ['networkMode'] : []),
    ...(agent ? ['activationMode'] : []),
  ]);
  if (claims.version !== TOKEN_VERSION || !ID_PATTERN.test(claims.deploymentId)
    || !ID_PATTERN.test(claims.botId)
    || !ID_PATTERN.test(claims.revisionId) || !NONCE_PATTERN.test(claims.nonce)
    || !EGRESS_TOKEN_PURPOSES.includes(purpose)
    || !Number.isSafeInteger(claims.issuedAt) || !Number.isSafeInteger(claims.expiresAt)) {
    fail('Model egress token claims are invalid');
  }
  const networkMode = browser ? claims.networkMode : null;
  const activationMode = agent ? claims.activationMode : null;
  if (browser && !BROWSER_NETWORK_MODES.includes(networkMode)) {
    fail('Browser egress network mode is invalid');
  }
  if (agent && (!AGENT_ACTIVATION_MODES.includes(activationMode)
    || (activationMode === 'connection_health' && claims.revisionId !== claims.botId))) {
    fail('Agent egress activation mode is invalid');
  }
  const hosts = browser && networkMode === 'public_only' && Array.isArray(claims.hosts)
    && claims.hosts.length === 0
    ? Object.freeze([])
    : browser ? normalizeBrowserHosts(claims.hosts) : normalizeModelHosts(claims.hosts);
  if (browser && networkMode === 'allowlist' && hosts.length === 0) {
    fail('Browser host allowlist is invalid');
  }
  if (browser && networkMode === 'public_only' && hosts.length !== 0) {
    fail('Public-only browser tokens cannot carry a host allowlist');
  }
  if (hosts.join('\0') !== claims.hosts.join('\0')) {
    fail('Model egress token hosts are not normalized');
  }
  if (claims.expiresAt <= claims.issuedAt
    || claims.expiresAt - claims.issuedAt > MAX_CAPABILITY_TTL_MS) {
    fail('Model egress token lifetime is invalid');
  }
  return Object.freeze({
    ...claims,
    purpose,
    hosts,
    ...(browser ? { networkMode } : {}),
    ...(agent ? { activationMode } : {}),
  });
};

const sign = (encodedPayload, secret) => (
  crypto.createHmac('sha256', secret).update(encodedPayload, 'ascii').digest()
);

export function createRuntimeToken({
  secret,
  deploymentId,
  botId,
  revisionId,
  hosts,
  purpose = 'model',
  networkMode,
  activationMode = purpose === 'agent' ? 'required' : undefined,
  issuedAt = Date.now(),
  expiresAt = issuedAt + 5 * 60 * 1000,
  nonce = crypto.randomBytes(18).toString('base64url'),
} = {}) {
  const key = normalizeSecret(secret);
  try {
    const normalizedHosts = purpose === 'browser' && networkMode === 'public_only'
      && Array.isArray(hosts) && hosts.length === 0
      ? Object.freeze([])
      : purpose === 'browser' ? normalizeBrowserHosts(hosts) : normalizeModelHosts(hosts);
    const claims = validateClaims({
      version: TOKEN_VERSION,
      deploymentId,
      botId,
      revisionId,
      hosts: normalizedHosts,
      purpose,
      ...(purpose === 'browser' ? { networkMode } : {}),
      ...(purpose === 'agent' ? { activationMode } : {}),
      issuedAt,
      expiresAt,
      nonce,
    });
    const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
    const signature = sign(payload, key).toString('base64url');
    return `${TOKEN_PREFIX}.${payload}.${signature}`;
  } finally {
    key.fill(0);
  }
}

const parseToken = (token, secret) => {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) fail();
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX || !parts[1] || !parts[2]) fail();
  let supplied;
  try {
    supplied = Buffer.from(parts[2], 'base64url');
  } catch {
    fail();
  }
  const expected = sign(parts[1], secret);
  const signatureValid = supplied.byteLength === expected.byteLength
    && crypto.timingSafeEqual(supplied, expected);
  supplied.fill(0);
  expected.fill(0);
  if (!signatureValid) fail();
  let raw;
  try {
    raw = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    fail();
  }
  return validateClaims(raw);
};

export async function verifyRuntimeToken(token, {
  secret,
  deploymentId,
  isRevisionActive,
  now = Date.now(),
} = {}) {
  if (!ID_PATTERN.test(deploymentId) || typeof isRevisionActive !== 'function'
    || !Number.isSafeInteger(now)) {
    fail('Model egress verifier is invalid', 'bot_egress_configuration_invalid');
  }
  const key = normalizeSecret(secret);
  let claims;
  try {
    claims = parseToken(token, key);
  } finally {
    key.fill(0);
  }
  if (claims.deploymentId !== deploymentId) {
    fail('Model egress token belongs to another deployment');
  }
  if (claims.issuedAt > now + MAX_CLOCK_SKEW_MS || claims.expiresAt <= now) {
    fail('Model egress token has expired', 'bot_egress_token_expired');
  }
  if (claims.purpose !== 'agent' || claims.activationMode === 'required') {
    let active = false;
    try {
      active = await isRevisionActive(claims.revisionId, claims.botId);
    } catch {
      fail('Active revision could not be verified', 'bot_egress_revision_unavailable');
    }
    if (active !== true) {
      fail('Model egress token revision is not active', 'bot_egress_revision_inactive');
    }
  }
  return claims;
}

export function createRuntimeTokenAuthorizer(options = {}) {
  return async (token) => {
    const claims = await verifyRuntimeToken(token, options);
    return Object.freeze({
      active: true,
      botId: claims.botId,
      revisionId: claims.revisionId,
      purpose: claims.purpose,
      ...(claims.purpose === 'browser' ? { networkMode: claims.networkMode } : {}),
      hosts: claims.hosts,
      expiresAt: claims.expiresAt,
    });
  };
}
