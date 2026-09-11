import crypto from 'node:crypto';
import { createSessionVault } from './vault.js';
import { writeSupabaseConnectionPreference } from './connection-preference.js';
import { createSupabaseServerClient } from './supabase-client.js';
import { createSupabaseTraffic } from './supabase-traffic.js';
import { PRODUCTION_BOTS_MIGRATION } from './auth-compat.js';

const OWNER_KEY = 'supabase-local-owner';
const LOCAL_SESSIONS_KEY = 'supabase-local-sessions';
const COOKIE = 'devryan_local_owner';
const OWNER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const failure = (message, code, statusCode = 503) => Object.assign(new Error(message), { code, statusCode });
const cookies = (req) => Object.fromEntries(String(req.headers?.cookie || '').split(';').map((part) => {
  const i = part.indexOf('=');
  return i < 0 ? ['', ''] : [part.slice(0, i).trim(), part.slice(i + 1).trim()];
}));

// Socket, authority and proxy headers must all agree. A tunnel commonly reaches
// the server through a loopback socket; that socket alone is never owner proof.
export function isDirectLocalRequest(req) {
  const address = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  const rawHost = String(req.headers?.host || '').toLowerCase();
  const host = rawHost.startsWith('[') ? rawHost.slice(1, rawHost.indexOf(']')) : rawHost.split(':')[0];
  if (!['127.0.0.1', '::1'].includes(address) || !['localhost', '127.0.0.1', '::1'].includes(host)) return false;
  if (['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'cf-connecting-ip'].some((key) => req.headers?.[key])) return false;
  const origin = req.headers?.origin;
  if (origin) {
    try {
      const parsed = new URL(origin);
      if (parsed.host !== rawHost || !['http:', 'https:'].includes(parsed.protocol)) return false;
    } catch { return false; }
  }
  return true;
}

export async function createSupabaseConnection({ config, fetchImpl = fetch, now = Date.now } = {}) {
  const configured = config.configured ?? config.enabled;
  const vault = configured ? await createSessionVault({ dataDirectory: config.dataDirectory }) : null;
  const traffic = createSupabaseTraffic({ now });
  let effectiveEnabled = configured && config.enabled;
  let desiredEnabled = effectiveEnabled;
  let state = effectiveEnabled ? 'connected' : 'disconnected';
  let errorCode = null;
  let blockers = [];
  let restarting = false;
  let changing = null;
  let timer = null;
  let disposed = false;
  let driver = null;
  let owner = vault?.get(OWNER_KEY) || null;
  const localSessions = new Map(Object.entries(vault?.get(LOCAL_SESSIONS_KEY) || {}));

  const status = () => ({
    configured, desiredEnabled, effectiveEnabled, state, errorCode,
    restartRequired: desiredEnabled !== effectiveEnabled,
    restartAvailable: typeof driver?.restart === 'function',
    blockers: [...blockers], traffic: traffic.snapshot(),
  });
  const ownerPrincipal = () => owner?.principal?.role === 'admin'
    ? { ...structuredClone(owner.principal), scope: 'local-admin', localOwner: true, offlineGrace: false }
    : null;
  const authenticateLocalOwner = (req) => {
    if (!isDirectLocalRequest(req) || !ownerPrincipal()) return null;
    const token = cookies(req)[COOKIE];
    if (!token || token.length > 256) return null;
    const tokenHash = hash(token);
    if (!(owner.sessions || []).some((session) => session.expiresAt > now() && session.tokenHash === tokenHash)) return null;
    return ownerPrincipal();
  };
  const issueLocalOwnerSession = async () => {
    if (!ownerPrincipal()) return null;
    const token = crypto.randomBytes(32).toString('base64url');
    const sessions = (owner.sessions || []).filter((session) => session.expiresAt > now()).slice(-31);
    owner = { ...owner, sessions: [...sessions, { tokenHash: hash(token), expiresAt: now() + OWNER_TTL_MS }] };
    await vault.set(OWNER_KEY, owner);
    return { name: COOKIE, value: token, maxAge: OWNER_TTL_MS / 1000 };
  };
  const setOwnerCookie = (res, cookie) => {
    if (!cookie) return;
    const value = `${cookie.name}=${cookie.value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${cookie.maxAge}`;
    const previous = res.getHeader?.('Set-Cookie');
    res.setHeader('Set-Cookie', [...(Array.isArray(previous) ? previous : previous ? [previous] : []), value]);
  };
  const validateConnection = async () => {
    if (!configured || !owner?.principal?.id) throw failure('A local administrator must configure Supabase first', 'supabase_owner_required', 403);
    const client = createSupabaseServerClient({ ...config, fetchImpl, traffic });
    const profile = await client.rest('user_profiles', {
      query: { id: `eq.${owner.principal.id}`, limit: 1 }, select: 'id,role,status', maybeSingle: true,
    });
    if (profile?.role !== 'admin' || profile.status !== 'active') throw failure('The saved administrator no longer has access', 'supabase_owner_revoked', 403);
    const version = await client.rpc('devryan_bot_schema_version');
    if (typeof version !== 'string' || !/^\d{14}$/.test(version) || version < PRODUCTION_BOTS_MIGRATION) {
      throw failure('The Supabase schema must be updated before reconnecting', 'bot_schema_migration_required');
    }
  };
  const recordFailure = async (error) => {
    effectiveEnabled = false;
    desiredEnabled = false;
    state = 'connection_failed';
    errorCode = Number(error?.status) === 402 ? 'supabase_quota_exceeded'
      : ['supabase_owner_revoked', 'bot_schema_migration_required'].includes(error?.code)
        ? error.code : 'supabase_connection_failed';
    await writeSupabaseConnectionPreference(config.dataDirectory, false);
  };
  // Only explicitly enrolled installations validate before reconnect startup.
  // Original configured installations retain their established bootstrap path.
  if (effectiveEnabled && owner) {
    try { await validateConnection(); } catch (error) { await recordFailure(error); }
  }
  const schedule = () => {
    if (disposed || timer || restarting || desiredEnabled === effectiveEnabled) return;
    timer = setTimeout(() => {
      timer = null;
      void applyWhenIdle();
    }, 5_000);
    timer.unref?.();
  };
  const applyWhenIdle = async () => {
    if (disposed || restarting || errorCode === 'supabase_restart_failed' || desiredEnabled === effectiveEnabled || !driver) return;
    try {
      blockers = await driver.getBlockers();
      if (blockers.length) { schedule(); return; }
      if (typeof driver.restart !== 'function') { blockers = ['restart_required']; return; }
      // Recheck after admission is closed, immediately before handing off.
      await driver.prepare();
      blockers = await driver.getBlockers();
      if (blockers.length) { schedule(); return; }
      restarting = true;
      await driver.restart();
    } catch {
      if (timer) clearTimeout(timer);
      timer = null;
      restarting = false;
      state = 'connection_failed';
      errorCode = 'supabase_restart_failed';
      blockers = ['restart_required'];
      // Explicit retry only; never restart a host repeatedly.
    }
  };

  return Object.freeze({
    traffic, status, vault,
    get enabled() { return effectiveEnabled; },
    get configured() { return configured; },
    get admissionPaused() { return desiredEnabled !== effectiveEnabled || !effectiveEnabled; },
    authenticateLocalOwner, ownerPrincipal, setOwnerCookie,
    localSessionOwner: (sessionId) => localSessions.get(sessionId) || null,
    async recordLocalSession(info) {
      if (effectiveEnabled || !owner?.principal?.id || typeof info?.id !== 'string'
        || !/^ses_[a-zA-Z0-9_-]+$/.test(info.id) || typeof info.directory !== 'string'
        || !info.directory || localSessions.has(info.id)) return false;
      localSessions.set(info.id, { userId: owner.principal.id, directory: info.directory });
      await vault.set(LOCAL_SESSIONS_KEY, Object.fromEntries(localSessions));
      return true;
    },
    issueLocalOwnerSession,
    async rememberOwner(principal, res) {
      if (principal?.role !== 'admin' || principal?.scope !== 'managed' || !principal?.id) {
        throw failure('An authenticated local administrator is required', 'supabase_owner_required', 403);
      }
      owner = { principal: structuredClone(principal), sessions: owner?.principal?.id === principal.id ? owner.sessions || [] : [] };
      await vault.set(OWNER_KEY, owner);
      setOwnerCookie(res, await issueLocalOwnerSession());
    },
    async logoutLocalOwner(res, req = null) {
      if (owner) {
        const tokenHash = req ? hash(cookies(req)[COOKIE] || '') : null;
        owner = { ...owner, sessions: tokenHash ? (owner.sessions || []).filter((session) => session.tokenHash !== tokenHash) : [] };
        await vault.set(OWNER_KEY, owner);
      }
      setOwnerCookie(res, { name: COOKIE, value: '', maxAge: 0 });
    },
    configureDriver(value) { driver = value; },
    async change(enabled) {
      if (typeof enabled !== 'boolean') throw failure('enabled must be boolean', 'supabase_mode_invalid', 400);
      if (!configured) throw failure('Supabase is not configured', 'supabase_not_configured', 409);
      if (changing) throw failure('A connection change is already in progress', 'supabase_change_pending', 409);
      if (restarting) throw failure('The host is restarting', 'supabase_change_pending', 409);
      changing = (async () => {
        if (enabled && !effectiveEnabled) {
          state = 'connecting';
          try { await validateConnection(); }
          catch (error) { await recordFailure(error); return status(); }
        }
        await writeSupabaseConnectionPreference(config.dataDirectory, enabled);
        desiredEnabled = enabled;
        state = desiredEnabled === effectiveEnabled ? enabled ? 'connected' : 'disconnected'
          : enabled ? 'connecting' : 'disconnecting';
        errorCode = null;
        blockers = [];
        if (desiredEnabled !== effectiveEnabled) {
          await driver?.pauseAdmissions?.();
          // Give the PATCH response time to flush before an idle restart.
          schedule();
        } else await driver?.resumeAdmissions?.();
        return status();
      })().finally(() => { changing = null; });
      return changing;
    },
    async dispose() { disposed = true; if (timer) clearTimeout(timer); timer = null; await vault?.drain(); },
    applyWhenIdle,
  });
}
