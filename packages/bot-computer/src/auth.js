import crypto from 'node:crypto';

const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{32,8192}$/;

export class ComputerAuthError extends Error {
  constructor(message = 'Computer authentication failed') {
    super(message);
    this.name = 'ComputerAuthError';
    this.code = 'DEVRYAN_BOT_COMPUTER_UNAUTHORIZED';
    this.statusCode = 401;
  }
}

export function createComputerAuthenticator({ token } = {}) {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
    throw new ComputerAuthError('Computer authentication configuration is invalid');
  }
  const expected = Buffer.from(token, 'utf8');
  return (authorization) => {
    if (typeof authorization !== 'string' || authorization.length > 8210) {
      throw new ComputerAuthError();
    }
    const match = /^Bearer ([^\s]+)$/.exec(authorization);
    if (!match) throw new ComputerAuthError();
    const supplied = Buffer.from(match[1], 'utf8');
    const accepted = supplied.byteLength === expected.byteLength
      && crypto.timingSafeEqual(supplied, expected);
    supplied.fill(0);
    if (!accepted) throw new ComputerAuthError();
    return true;
  };
}
