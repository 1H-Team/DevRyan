import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const EMPTY_VAULT = Object.freeze({ version: 1, sessions: {} });
const OWNER_KEYS = ['supabase-local-owner', 'bots-local-owner'];
const ownerId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const ownerFailure = () => Object.assign(new Error('native_setup_local_owner_invalid'), { code: 'native_setup_local_owner_invalid', status: 503 });
/** Durable identities only. Session tokens, policies and membership grants do not transfer. */
export function validateSetupOwners(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !OWNER_KEYS.includes(key))) throw ownerFailure();
  const owners = {};
  for (const [key, owner] of Object.entries(value)) {
    const fields = key === 'bots-local-owner' ? ['id', 'createdAt'] : ['id', 'scope'];
    if (!owner || typeof owner !== 'object' || Array.isArray(owner) || !ownerId(owner.id)
      || Object.keys(owner).some(field => !fields.includes(field))) throw ownerFailure();
    if (key === 'bots-local-owner') {
      if (typeof owner.createdAt !== 'string' || !Number.isFinite(Date.parse(owner.createdAt))) throw ownerFailure();
      owners[key] = { id: owner.id, createdAt: owner.createdAt };
    } else {
      if (!['managed', 'local-admin'].includes(owner.scope)) throw ownerFailure();
      owners[key] = { id: owner.id, scope: owner.scope };
    }
  }
  return owners;
}

const atomicWrite = async (filePath, content, mode = 0o600) => {
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(tempPath, content, { mode });
  await fs.rename(tempPath, filePath);
  await fs.chmod(filePath, mode);
};

const readOrCreateKey = async (keyPath) => {
  try {
    const encoded = (await fs.readFile(keyPath, 'utf8')).trim();
    const key = Buffer.from(encoded, 'base64');
    if (key.byteLength !== 32) throw new Error('invalid key length');
    return key;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const key = crypto.randomBytes(32);
    await atomicWrite(keyPath, `${key.toString('base64')}\n`);
    return key;
  }
};

const encrypt = (key, value) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    version: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
};

const decrypt = (key, envelope) => {
  if (!envelope || envelope.version !== 1) throw new Error('Unsupported multi-user vault format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8'));
};

const vaultFingerprintFailure = () => Object.assign(new Error('session_vault_fingerprint_invalid'), { code: 'session_vault_fingerprint_invalid' });
const plainRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonicalCredentialState = value => Array.isArray(value) ? value.map(canonicalCredentialState)
  : plainRecord(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalCredentialState(value[key])])) : value;
/** Read-only projection through the original authenticated vault codec. Root
 * session ownership is runtime data; every other record remains credential state. */
export function fingerprintSessionVaultCredentials({ keyBytes, vaultBytes }) {
  try {
    if (!Buffer.isBuffer(keyBytes) || !Buffer.isBuffer(vaultBytes) || keyBytes.length > 1024 || vaultBytes.length > 32 * 1024 * 1024) throw vaultFingerprintFailure();
    const key = Buffer.from(keyBytes.toString('utf8').trim(), 'base64');
    if (key.length !== 32) throw vaultFingerprintFailure();
    const envelope = JSON.parse(vaultBytes.toString('utf8'));
    if (!plainRecord(envelope) || Object.keys(envelope).length !== 4
      || !['version', 'iv', 'tag', 'ciphertext'].every(field => Object.hasOwn(envelope, field))
      || envelope.version !== 1 || !['iv', 'tag', 'ciphertext'].every(field => typeof envelope[field] === 'string')) throw vaultFingerprintFailure();
    const state = decrypt(key, envelope);
    if (!plainRecord(state) || state.version !== 1 || !plainRecord(state.sessions)) throw vaultFingerprintFailure();
    const sessions = { ...state.sessions };
    if (Object.hasOwn(sessions, 'supabase-local-sessions')) {
      const ownership = sessions['supabase-local-sessions'], owner = sessions['supabase-local-owner'];
      if (!plainRecord(ownership) || Object.keys(ownership).length > 20_000 || !plainRecord(owner?.principal)
        || owner.principal.role !== 'admin' || !ownerId(owner.principal.id)
        || !['managed', 'local-admin'].includes(owner.principal.scope)) throw vaultFingerprintFailure();
      for (const [sessionID, value] of Object.entries(ownership)) {
        if (sessionID.length > 160 || !/^ses_[a-zA-Z0-9_-]+$/.test(sessionID) || !plainRecord(value) || Object.keys(value).length !== 2
          || !Object.hasOwn(value, 'userId') || !Object.hasOwn(value, 'directory') || value.userId !== owner.principal.id
          || typeof value.directory !== 'string' || /[\x00-\x1f\x7f]/.test(value.directory) || !path.isAbsolute(value.directory) || path.normalize(value.directory) !== value.directory) throw vaultFingerprintFailure();
      }
      delete sessions['supabase-local-sessions'];
    }
    return crypto.createHash('sha256').update(JSON.stringify(canonicalCredentialState({ ...state, sessions }))).digest('hex');
  } catch { throw vaultFingerprintFailure(); }
}

export async function createSessionVault({ dataDirectory }) {
  const keyPath = path.join(dataDirectory, 'multi-user-vault.key');
  const vaultPath = path.join(dataDirectory, 'multi-user-vault.json');
  const exists = async (file) => {
    try { await fs.stat(file); return true; }
    catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  };
  const [hasKey, hasVault] = await Promise.all([exists(keyPath), exists(vaultPath)]);
  if (hasKey !== hasVault) throw new Error('Local authorization storage is incomplete; restore the matching vault and key');
  const key = await readOrCreateKey(keyPath);
  let state = { ...EMPTY_VAULT, sessions: {} };
  let mutation = Promise.resolve();

  try {
    const raw = JSON.parse(await fs.readFile(vaultPath, 'utf8'));
    const decoded = decrypt(key, raw);
    if (decoded?.version !== 1 || !decoded.sessions || typeof decoded.sessions !== 'object' || Array.isArray(decoded.sessions)) throw new Error('Invalid local authorization storage');
    state = decoded;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const persist = (next = state) => atomicWrite(vaultPath, `${JSON.stringify(encrypt(key, next))}\n`);
  if (!hasVault) await persist();
  const mutate = (operation) => {
    const next = mutation.then(operation, operation);
    mutation = next.catch(() => {});
    return next;
  };

  return {
    captureSetupOwners() {
      const owners = {};
      for (const key of OWNER_KEYS) {
        const owner = state.sessions[key];
        if (!owner) continue;
        if (key === 'bots-local-owner') {
          if (owner.version !== 1) throw ownerFailure();
          owners[key] = { id: owner.id, createdAt: owner.createdAt };
        } else {
          if (owner.principal?.role !== 'admin') throw ownerFailure();
          owners[key] = { id: owner.principal.id, scope: owner.principal.scope };
        }
      }
      return validateSetupOwners(owners);
    },
    restoreSetupOwners(value) {
      const owners = validateSetupOwners(value);
      return mutate(async () => {
        const sessions = { ...state.sessions };
        let changed = false;
        for (const [key, owner] of Object.entries(owners)) {
          const existing = sessions[key];
          if (existing) {
            const identity = key === 'bots-local-owner' ? { id: existing.id, createdAt: existing.createdAt }
              : { id: existing.principal?.id, scope: existing.principal?.scope };
            if (JSON.stringify(identity) !== JSON.stringify(owner)) throw ownerFailure();
            continue;
          }
          sessions[key] = key === 'bots-local-owner' ? { version: 1, ...owner, sessions: [] }
            : { principal: { id: owner.id, role: 'admin', scope: owner.scope, assignments: [], policy: {} }, sessions: [] };
          changed = true;
        }
        if (changed) {
          const next = { ...state, sessions };
          await persist(next); state = next;
        }
      });
    },
    get(sessionId) {
      const value = state.sessions[sessionId];
      return value ? structuredClone(value) : null;
    },
    findByTokenHash(sessionTokenHash) {
      const expected = String(sessionTokenHash || '');
      if (!expected) return null;
      for (const [sessionId, value] of Object.entries(state.sessions)) {
        if (value?.sessionTokenHash === expected) {
          return { sessionId, value: structuredClone(value) };
        }
      }
      return null;
    },
    set(sessionId, value) {
      return mutate(async () => {
        const next = { ...state, sessions: { ...state.sessions, [sessionId]: structuredClone(value) } };
        await persist(next);
        state = next;
      });
    },
    delete(sessionId) {
      return mutate(async () => {
        if (!Object.prototype.hasOwnProperty.call(state.sessions, sessionId)) return;
        const sessions = { ...state.sessions };
        delete sessions[sessionId];
        const next = { ...state, sessions };
        await persist(next);
        state = next;
      });
    },
    drain: () => mutation,
    paths: { keyPath, vaultPath },
  };
}
