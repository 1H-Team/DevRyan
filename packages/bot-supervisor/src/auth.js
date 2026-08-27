import crypto from 'node:crypto';

const MIN_TOKEN_BYTES = 32;
const MAX_TOKEN_LENGTH = 1024;

export class SupervisorAuthError extends Error {
  constructor(message = 'Supervisor authentication failed') {
    super(message);
    this.name = 'SupervisorAuthError';
    this.code = 'bot_supervisor_unauthorized';
    this.statusCode = 401;
  }
}

const tokenBuffer = (token) => Buffer.from(token, 'utf8');

export function validateSupervisorToken(token) {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH
    || tokenBuffer(token).byteLength < MIN_TOKEN_BYTES || /[\u0000-\u001f\u007f\s]/u.test(token)) {
    throw new SupervisorAuthError('Supervisor token configuration is invalid');
  }
  return token;
}

export function readBearerToken(header) {
  if (typeof header !== 'string' || header.length > MAX_TOKEN_LENGTH + 16) {
    throw new SupervisorAuthError();
  }
  const match = /^Bearer ([^\s]+)$/.exec(header);
  if (!match) throw new SupervisorAuthError();
  return match[1];
}

export function createSupervisorAuthenticator({ token } = {}) {
  const expected = tokenBuffer(validateSupervisorToken(token));
  return (authorizationHeader) => {
    const supplied = tokenBuffer(readBearerToken(authorizationHeader));
    const valid = supplied.byteLength === expected.byteLength
      && crypto.timingSafeEqual(supplied, expected);
    supplied.fill(0);
    if (!valid) throw new SupervisorAuthError();
    return true;
  };
}
