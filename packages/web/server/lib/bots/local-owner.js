import crypto from 'node:crypto';

import { isDirectLocalRequest } from '../security/direct-local-request.js';

// The workstation owner's local Bot identity.
//
// `localBotOwnerId` is created once and stored in the host's encrypted
// authorization vault. Supabase configuration, sign-in, owner enrollment and
// account revocation never replace it, and no managed account ever shares it:
// a managed sign-in keeps its cloud identity and ordinary memberships.
//
// The owner authenticates to Bot APIs with a Bot-scoped session that only the
// native shell can mint (in-process), accepted only on direct-local requests
// and only for Bot routes. It grants nothing on unrelated managed APIs.

export const BOT_OWNER_SCOPE = 'bot-owner';
export const BOT_OWNER_COOKIE = 'devryan_bot_owner';
export const BOT_OWNER_RECORD_KEY = 'bots-local-owner';
const RECORD_VERSION = 1;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 16;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BOT_API_PATH = /^\/api\/(?:bots|bot-actions|bot-channels|bot-runs|bot-specs|bot-signers|bot-audit)(?:[/?]|$)/;
const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export class LocalBotOwnerError extends Error {
  constructor(message, code, statusCode = 500) {
    super(message);
    this.name = 'LocalBotOwnerError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

const cookieValue = (req, name) => {
  for (const part of String(req?.headers?.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return '';
};

export const isBotApiPath = (req) => BOT_API_PATH.test(String(req?.originalUrl || req?.url || ''));

const validateRecord = (record) => {
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || record.version !== RECORD_VERSION
    || !UUID_PATTERN.test(record.id || '')
    || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))
    || !Array.isArray(record.sessions)
    || record.sessions.some((session) => !session || typeof session.tokenHash !== 'string'
      || !/^[0-9a-f]{64}$/.test(session.tokenHash) || !Number.isSafeInteger(session.expiresAt))) {
    // Never regenerate: a new identity would orphan every local Bot.
    throw new LocalBotOwnerError(
      'The local Bot owner identity is unreadable; restore the matching host vault',
      'bot_local_owner_invalid',
      503,
    );
  }
  return record;
};

export async function createLocalBotOwner({
  vault,
  now = Date.now,
  randomUUID = () => crypto.randomUUID(),
  randomBytes = (size) => crypto.randomBytes(size),
} = {}) {
  if (typeof vault?.get !== 'function' || typeof vault?.set !== 'function') {
    throw new LocalBotOwnerError('The host authorization vault is unavailable', 'bot_local_owner_unavailable', 503);
  }
  let record = vault.get(BOT_OWNER_RECORD_KEY);
  if (record === null || record === undefined) {
    const created = { version: RECORD_VERSION, id: randomUUID(), createdAt: new Date(now()).toISOString(), sessions: [] };
    validateRecord(created);
    await vault.set(BOT_OWNER_RECORD_KEY, created);
    record = created;
  } else {
    record = validateRecord(record);
  }
  const ownerId = record.id;

  // Only the session list ever changes; the identity is carried over verbatim.
  const persistSessions = async (sessions) => {
    const next = { version: RECORD_VERSION, id: ownerId, createdAt: record.createdAt, sessions };
    validateRecord(next);
    await vault.set(BOT_OWNER_RECORD_KEY, next);
    record = next;
  };

  const principal = Object.freeze({
    id: ownerId,
    email: null,
    displayName: 'Workstation owner',
    role: 'admin',
    scope: BOT_OWNER_SCOPE,
    botOwner: true,
    policy: Object.freeze({ bots: true }),
    assignments: Object.freeze([]),
  });

  return Object.freeze({
    id: ownerId,
    principal,
    // Bot routes only, direct-local only, valid native-issued session only.
    authenticate(req) {
      if (!isBotApiPath(req) || !isDirectLocalRequest(req)) return null;
      const token = cookieValue(req, BOT_OWNER_COOKIE);
      if (!token || token.length > 256) return null;
      const tokenHash = hash(token);
      const at = now();
      return record.sessions.some((session) => session.expiresAt > at && session.tokenHash === tokenHash)
        ? principal
        : null;
    },
    // In-process only (the Electron shell or the runtime-service bootstrap).
    async issueSession() {
      const token = Buffer.from(randomBytes(32)).toString('base64url');
      const at = now();
      const sessions = record.sessions.filter((session) => session.expiresAt > at).slice(-(MAX_SESSIONS - 1));
      await persistSessions([...sessions, { tokenHash: hash(token), expiresAt: at + SESSION_TTL_MS }]);
      return Object.freeze({ name: BOT_OWNER_COOKIE, value: token, maxAge: Math.floor(SESSION_TTL_MS / 1000) });
    },
    async revokeSessions() {
      await persistSessions([]);
    },
    requiresCsrf: (req) => STATE_CHANGING_METHODS.has(String(req?.method || '').toUpperCase()),
    hasCsrf: (req) => {
      const header = typeof req?.get === 'function' ? req.get('x-devryan-csrf') : req?.headers?.['x-devryan-csrf'];
      return header === '1';
    },
  });
}

export const setBotOwnerCookie = (res, cookie) => {
  if (!cookie) return;
  const value = `${cookie.name}=${cookie.value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${cookie.maxAge}`;
  const previous = res.getHeader?.('Set-Cookie');
  res.setHeader('Set-Cookie', [...(Array.isArray(previous) ? previous : previous ? [previous] : []), value]);
};
