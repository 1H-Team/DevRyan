import crypto from 'node:crypto';
import { createSessionVault } from './vault.js';
import { writeSupabaseConnectionPreference } from './connection-preference.js';
import { createSupabaseServerClient } from './supabase-client.js';
import { createSupabaseTraffic } from './supabase-traffic.js';
import { PRODUCTION_BOTS_MIGRATION } from './auth-compat.js';
import { isDirectLocalRequest } from '../security/direct-local-request.js';
export { isDirectLocalRequest } from '../security/direct-local-request.js';

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

export async function createSupabaseConnection({ config, fetchImpl = fetch, now = Date.now } = {}) {
  const configured = config.configured ?? config.enabled;
  const authenticationMode = configured && config.enabled ? 'managed-accounts' : 'local-owner';
  const vault = await createSessionVault({ dataDirectory: config.dataDirectory });
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
  const authorizationListeners = new Set();
  const authorizationChanged = async () => { for (const listener of authorizationListeners) await listener(); };
  const localSessions = new Map(Object.entries(vault?.get(LOCAL_SESSIONS_KEY) || {}));
  const restartRequired = () => desiredEnabled !== effectiveEnabled
    || desiredEnabled !== (authenticationMode === 'managed-accounts');

  const status = () => ({
    configured, desiredEnabled, effectiveEnabled, state, errorCode,
    restartRequired: restartRequired(),
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
    const nextOwner = { ...owner, sessions: [...sessions, { tokenHash: hash(token), expiresAt: now() + OWNER_TTL_MS }] };
    await vault.set(OWNER_KEY, nextOwner);
    owner = nextOwner;
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
    state = 'connection_failed';
    errorCode = Number(error?.status) === 402 ? 'supabase_quota_exceeded'
      : ['supabase_owner_revoked', 'bot_schema_migration_required'].includes(error?.code)
        ? error.code : 'supabase_connection_failed';
    // Availability cannot change the owner's selected authentication policy.
    // A failed explicit reconnect retains Off; a failed On startup retains On.
    await writeSupabaseConnectionPreference(config.dataDirectory, desiredEnabled);
  };
  // Only explicitly enrolled installations validate before reconnect startup.
  // Original configured installations retain their established bootstrap path.
  if (effectiveEnabled && owner) {
    try { await validateConnection(); } catch (error) { await recordFailure(error); }
  }
  const schedule = () => {
    if (disposed || timer || restarting || !restartRequired()) return;
    timer = setTimeout(() => {
      timer = null;
      void applyWhenIdle();
    }, 5_000);
    timer.unref?.();
  };
  const applyWhenIdle = async () => {
    if (disposed || restarting || errorCode || !restartRequired() || !driver) return;
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
    authenticationMode,
    get configured() { return configured; },
    get admissionPaused() { return desiredEnabled !== effectiveEnabled || !effectiveEnabled; },
    authenticateLocalOwner, ownerPrincipal, setOwnerCookie,
    onAuthorizationChange(listener) { authorizationListeners.add(listener); return () => authorizationListeners.delete(listener); },
    // Called only by the host's in-process handle or the filesystem-owner
    // bootstrap exchange. Merely serving a loopback HTTP request never calls it.
    async bootstrapLocalOwner() {
      if (!owner && !configured) {
        const nextOwner = { principal: { id: crypto.randomUUID(), role: 'admin', scope: 'local-admin', assignments: [], policy: {} }, sessions: [] };
        await vault.set(OWNER_KEY, nextOwner);
        owner = nextOwner;
        await authorizationChanged();
      }
      return ownerPrincipal();
    },
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
      const changed = owner?.principal?.id !== principal.id;
      const nextOwner = { principal: structuredClone(principal), sessions: owner?.principal?.id === principal.id ? owner.sessions || [] : [] };
      await vault.set(OWNER_KEY, nextOwner);
      owner = nextOwner;
      if (changed) await authorizationChanged();
      setOwnerCookie(res, await issueLocalOwnerSession());
    },
    async logoutLocalOwner(res, req = null) {
      if (owner) {
        const tokenHash = req ? hash(cookies(req)[COOKIE] || '') : null;
        const nextOwner = { ...owner, sessions: tokenHash ? (owner.sessions || []).filter((session) => session.tokenHash !== tokenHash) : [] };
        await vault.set(OWNER_KEY, nextOwner);
        owner = nextOwner;
        if (!req) await authorizationChanged();
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
        if (enabled !== desiredEnabled) await authorizationChanged();
        desiredEnabled = enabled;
        state = !restartRequired() ? enabled ? 'connected' : 'disconnected'
          : enabled ? 'connecting' : 'disconnecting';
        errorCode = null;
        blockers = [];
        if (restartRequired()) {
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
