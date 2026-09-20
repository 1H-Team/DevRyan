import crypto from 'node:crypto';
import express from 'express';
import { isDirectLocalRequest } from '../security/direct-local-request.js';
import { runWithRequestPrincipal } from '../multi-user/request-context.js';
import { isBotTunnelRoute } from './bot-grants.js';

export const TUNNEL_LINK_TTL_MS = 15 * 60 * 1000;
export const TUNNEL_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STATE_KEY = 'bot-tunnel-authorization-v1';
const COOKIE = 'oc_tunnel_session';
const authorizedRequests = new WeakSet();
export const hasTunnelBoundaryAuthorization = (req) => authorizedRequests.has(req);
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const failure = (code, message, statusCode = 403) => Object.assign(new Error(message), { code, statusCode });
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const validBotIds = (ids) => Array.isArray(ids) && ids.length > 0 && ids.length <= 100
  && ids.every((id) => typeof id === 'string' && uuid.test(id)) && new Set(ids).size === ids.length;
const validHash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validHostname = (value) => typeof value === 'string' && /^[a-z0-9.-]+$/.test(value)
  && value.length <= 253 && !value.startsWith('.') && !value.endsWith('.') && !value.includes('..');
const validSavedState = (saved) => saved?.version === 1 && uuid.test(saved.generation)
  && (saved.ownerId === null || (typeof saved.ownerId === 'string' && saved.ownerId.length > 0))
  && ['managed-accounts', 'local-owner'].includes(saved.authMode)
  && ['password', 'passwordless'].includes(saved.localUiAuthMode)
  && (saved.profile === null || (uuid.test(saved.profile?.id) && validHostname(saved.profile.hostname)
    && ['quick', 'managed-local', 'managed-remote'].includes(saved.profile.mode) && typeof saved.profile.resume === 'boolean'))
  && Array.isArray(saved.links) && saved.links.length <= 32
  && saved.links.every((row) => uuid.test(row?.id) && validHash(row.tokenHash) && validBotIds(row.botIds)
    && Number.isFinite(row.expiresAt) && (row.usedAt === null || Number.isFinite(row.usedAt)))
  && Array.isArray(saved.sessions) && saved.sessions.length <= 128
  && saved.sessions.every((row) => uuid.test(row?.sessionId) && uuid.test(row.grantId) && uuid.test(row.generation)
    && validHash(row.tokenHash) && validBotIds(row.botIds) && row.ownerId === saved.ownerId
    && row.profileId === saved.profile?.id && row.hostname === saved.profile?.hostname && row.generation === saved.generation
    && Number.isFinite(row.createdAt) && row.expiresAt - row.createdAt === TUNNEL_SESSION_TTL_MS);
const cookieToken = (req) => {
  const matches = String(req.headers?.cookie || '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${COOKIE}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
};
const remoteHost = (req) => typeof req.headers?.host === 'string' ? req.headers.host.toLowerCase() : '';
const sameRemoteOrigin = (req, hostname, required = false) => {
  if (remoteHost(req) !== hostname) return false;
  if (!req.headers.origin) return !required;
  return req.headers.origin === `https://${hostname}`;
};
const setCookie = (res, value, maxAge) => {
  const previous = res.getHeader?.('Set-Cookie');
  res.setHeader('Set-Cookie', [...(Array.isArray(previous) ? previous : previous ? [previous] : []),
    `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`]);
};

// All credentials below are random bearer values hashed before persistence.
// The enclosing private encrypted vault owns atomic writes and disk permissions.
export function createTunnelAccessControl({ now = Date.now } = {}) {
  let state = null;
  let connection = null;
  let vault = null;
  let active = false;
  let localUiAuthMode = 'passwordless';
  let blocked = true;
  let unsubscribe = () => {};
  let validateBots = async () => { throw failure('bots_unavailable', 'Bots are unavailable on this host', 503); };
  let mutation = Promise.resolve();
  const connections = new Set();
  const attempts = new Map();
  const currentOwner = () => connection?.ownerPrincipal()?.id || null;
  const currentMode = () => connection?.authenticationMode || (connection?.enabled ? 'managed-accounts' : 'local-owner');
  const bound = () => !blocked && state && state.ownerId === currentOwner() && state.authMode === currentMode()
    && state.localUiAuthMode === localUiAuthMode;
  const closeConnections = () => {
    for (const entry of connections) { clearTimeout(entry.timer); entry.close(); }
    connections.clear();
  };
  const update = (operation) => {
    const job = mutation.then(async () => {
      if (blocked || !state) throw failure('tunnel_auth_unavailable', 'Tunnel authorization is unavailable', 503);
      const next = structuredClone(state);
      const result = await operation(next);
      try { await vault.set(STATE_KEY, next); }
      catch (error) { blocked = true; closeConnections(); throw error; }
      state = next;
      return result;
    });
    mutation = job.catch(() => {});
    return job;
  };
  const invalidate = (next) => {
    next.generation = crypto.randomUUID(); next.links = []; next.sessions = [];
    closeConnections();
  };
  const assertBound = () => {
    if (!bound() || !state.ownerId) throw failure('local_owner_required', 'Enroll and authenticate the local owner before issuing a tunnel link');
  };
  const initialize = async (options) => {
    connection = options.connection; vault = connection.vault; validateBots = options.validateBots || validateBots;
    localUiAuthMode = options.passwordProtected === true ? 'password' : 'passwordless';
    if (!vault) throw failure('tunnel_auth_unavailable', 'Private authorization storage is unavailable', 503);
    const saved = vault.get(STATE_KEY);
    if (saved && !validSavedState(saved)) {
      throw failure('tunnel_auth_corrupt', 'Tunnel authorization state is damaged', 503);
    }
    state = saved || { version: 1, generation: crypto.randomUUID(), ownerId: currentOwner(), authMode: currentMode(), localUiAuthMode, profile: null, links: [], sessions: [] };
    blocked = false;
    await update((next) => {
      if (!saved || next.ownerId !== currentOwner() || next.authMode !== currentMode() || next.localUiAuthMode !== localUiAuthMode) {
        invalidate(next); next.ownerId = currentOwner(); next.authMode = currentMode(); next.localUiAuthMode = localUiAuthMode;
      }
      next.links = next.links.filter((link) => link.expiresAt > now() && !link.usedAt);
      next.sessions = next.sessions.filter((session) => session.expiresAt > now());
    });
    unsubscribe = connection.onAuthorizationChange?.(async () => {
      await revokeTunnelArtifacts();
      await refreshOwner();
    }) || (() => {});
  };
  const refreshOwner = async () => update((next) => {
    if (next.ownerId !== currentOwner() || next.authMode !== currentMode()) {
      invalidate(next); next.ownerId = currentOwner(); next.authMode = currentMode();
    }
  });
  const classifyRequestScope = (req) => isDirectLocalRequest(req) ? 'local'
    : active && state?.profile?.hostname === remoteHost(req) ? 'tunnel' : 'unknown-public';
  const setActiveTunnel = async ({ publicUrl, mode }) => {
    const url = new URL(publicUrl);
    if (url.protocol !== 'https:' || url.port || url.username || url.password) throw failure('tunnel_origin_invalid', 'A public HTTPS hostname is required');
    await refreshOwner();
    await update((next) => {
      if (!next.profile || next.profile.hostname !== url.hostname || next.profile.mode !== mode) {
        invalidate(next);
        next.profile = { id: crypto.randomUUID(), hostname: url.hostname, mode, resume: true };
      }
      next.profile.resume = true;
    });
    active = true;
  };
  const revokeTunnelArtifacts = async () => update((next) => {
    const result = { revokedBootstrapCount: next.links.length, invalidatedSessionCount: next.sessions.length };
    invalidate(next); return result;
  });
  const clearActiveTunnel = async () => {
    active = false;
    return update((next) => { invalidate(next); if (next.profile) next.profile.resume = false; });
  };
  const suspendActiveTunnel = () => { active = false; closeConnections(); };
  const validateSelection = async (botIds) => {
    assertBound();
    if (!Array.isArray(botIds) || !botIds.length || botIds.length > 100 || !botIds.every((id) => typeof id === 'string' && uuid.test(id))) {
      throw failure('tunnel_bots_required', 'Select the Bot workspaces this link may access', 400);
    }
    const ids = [...new Set(botIds)];
    await validateBots(connection.ownerPrincipal(), ids);
    return ids;
  };
  const issueBootstrapToken = async ({ botIds, ttlMs = TUNNEL_LINK_TTL_MS } = {}) => {
    if (!active) throw failure('tunnel_inactive', 'Start the tunnel before creating a link', 409);
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > TUNNEL_LINK_TTL_MS) throw failure('tunnel_link_expiry_invalid', 'Tunnel links expire within 15 minutes', 400);
    const ids = await validateSelection(botIds);
    const token = crypto.randomBytes(32).toString('base64url');
    return update((next) => {
      assertBound();
      const expiresAt = now() + ttlMs;
      next.links = next.links.filter((link) => link.expiresAt > now() && !link.usedAt).slice(-31);
      next.links.push({ id: crypto.randomUUID(), tokenHash: digest(token), botIds: ids, expiresAt, usedAt: null });
      return { token, expiresAt };
    });
  };
  const revokeGrant = async (grantId) => update((next) => {
    if (!uuid.test(grantId)) throw failure('tunnel_grant_invalid', 'Invalid tunnel grant', 400);
    next.links = next.links.filter((link) => link.id !== grantId);
    next.sessions = next.sessions.filter((session) => session.grantId !== grantId);
    for (const entry of connections) if (entry.grantId === grantId) {
      clearTimeout(entry.timer); connections.delete(entry); entry.close();
    }
  });
  const getTunnelSessionFromRequest = (req) => {
    if (!bound() || !active || !state.profile || !sameRemoteOrigin(req, state.profile.hostname)) return null;
    const token = cookieToken(req);
    if (!token) return null;
    const tokenHash = digest(token);
    return state.sessions.find((session) => session.tokenHash === tokenHash && session.expiresAt > now()
      && session.generation === state.generation && session.ownerId === state.ownerId
      && session.profileId === state.profile.id && session.hostname === state.profile.hostname) || null;
  };
  const principalFor = (session) => Object.freeze({
    id: session.ownerId, role: 'developer', scope: 'tunnel-bot', localOwner: false,
    displayName: 'Bot workspace guest', email: null, assignments: [],
    policy: { bots: true, settingsPages: [], files: false, terminal: false, browser: false,
      createWorktrees: false, createBranches: false, manageProjects: false, manageUsers: false,
      manageGlobalSettings: false, manageGit: false, push: false, github: false },
    tunnelGrant: Object.freeze({ id: session.grantId, sessionId: session.sessionId, ownerId: session.ownerId,
      profileId: session.profileId, generation: session.generation, botIds: Object.freeze([...session.botIds]), expiresAt: session.expiresAt }),
  });
  const requireTunnelSession = (req, res, next) => {
    const session = getTunnelSessionFromRequest(req);
    if (!session) { setCookie(res, '', 0); return res.status(401).json({ error: 'Tunnel authentication required', tunnelLocked: true }); }
    req.principal = principalFor(session);
    return next();
  };
  const rateAllowed = () => {
    // Two fixed buckets per installation; no addresses supplied by callers and
    // no unbounded map allocation. Successful exchanges count too.
    const keys = ['installation', 'tunnel'];
    let allowed = true;
    for (const key of keys) {
      let bucket = attempts.get(key);
      if (!bucket || now() >= bucket.until) { bucket = { count: 0, until: now() + 60_000 }; attempts.set(key, bucket); }
      bucket.count += 1;
      if (bucket.count > (key === 'installation' ? 60 : 20)) allowed = false;
    }
    return allowed;
  };
  const exchangeBootstrapToken = async ({ req, res, token, beforeCommit }) => {
    if (!rateAllowed()) return { ok: false, reason: 'rate-limited', retryAfter: 60 };
    if (!bound() || !active || !state.profile) return { ok: false, reason: 'inactive' };
    if (req.method !== 'POST' || req.headers?.['x-devryan-csrf'] !== '1'
      || !sameRemoteOrigin(req, state.profile.hostname, true)) return { ok: false, reason: 'origin' };
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return { ok: false, reason: 'invalid-token' };
    const expectedGeneration = state.generation;
    return update(async (next) => {
      if (!bound() || !active || next.generation !== expectedGeneration) return { ok: false, reason: 'inactive' };
      const link = next.links.find((row) => row.tokenHash === digest(token) && !row.usedAt && row.expiresAt > now());
      if (!link) return { ok: false, reason: 'expired' };
      try { await beforeCommit?.(); await validateBots(connection.ownerPrincipal(), link.botIds); }
      catch { return { ok: false, reason: 'precondition-failed' }; }
      if (!bound() || !active) return { ok: false, reason: 'inactive' };
      const credential = crypto.randomBytes(32).toString('base64url');
      const createdAt = now();
      const expiresAt = createdAt + TUNNEL_SESSION_TTL_MS;
      link.usedAt = now();
      next.sessions = next.sessions.filter((session) => session.expiresAt > now()).slice(-127);
      next.sessions.push({ sessionId: crypto.randomUUID(), tokenHash: digest(credential), grantId: link.id,
        botIds: link.botIds, ownerId: next.ownerId, profileId: next.profile.id, hostname: next.profile.hostname,
        generation: next.generation, expiresAt, createdAt });
      // The cookie is added only after the enclosing persistence operation.
      return { ok: true, sessionExpiresAt: expiresAt, credential };
    }).then((result) => {
      if (result.ok) setCookie(res, result.credential, TUNNEL_SESSION_TTL_MS / 1000);
      return { ok: result.ok, reason: result.reason, sessionExpiresAt: result.sessionExpiresAt };
    });
  };
  const registerConnection = (principal, close) => {
    const expiresAt = principal?.tunnelGrant?.expiresAt;
    if (!expiresAt) return () => {};
    const entry = { close, grantId: principal.tunnelGrant.id, timer: setTimeout(() => { connections.delete(entry); close(); }, Math.max(0, expiresAt - now())) };
    entry.timer.unref?.(); connections.add(entry);
    return () => { clearTimeout(entry.timer); connections.delete(entry); };
  };
  return {
    initialize, refreshOwner, classifyRequestScope, setActiveTunnel, clearActiveTunnel, suspendActiveTunnel,
    revokeTunnelArtifacts, revokeGrant, validateSelection, issueBootstrapToken, exchangeBootstrapToken, getTunnelSessionFromRequest, requireTunnelSession,
    registerConnection, principalFor, isDirectLocalRequest,
    getActiveTunnelId: () => active ? state?.profile?.id : null,
    getActiveTunnelHost: () => active ? state?.profile?.hostname : null,
    getActiveTunnelMode: () => active ? state?.profile?.mode : null,
    getBootstrapStatus: () => ({ hasBootstrapToken: active && !!state?.links.some((link) => !link.usedAt && link.expiresAt > now()),
      bootstrapExpiresAt: active ? state?.links.findLast((link) => !link.usedAt && link.expiresAt > now())?.expiresAt || null : null }),
    recognizesBootstrapToken: (token) => typeof token === 'string' && token.length <= 128 && !!state?.links.some((link) => link.tokenHash === digest(token)),
    clearTunnelSessionCookie: (_req, res) => setCookie(res, '', 0),
    listTunnelSessions: () => state?.sessions.map(({ tokenHash: _tokenHash, ...session }) => ({ ...session,
      status: active && session.expiresAt > now() ? 'active' : 'inactive', mode: state.profile?.mode,
      publicUrl: `https://${session.hostname}` })) || [],
    hasOwner: () => !!currentOwner(),
    getResumeProfile: () => bound() && state.profile?.resume && state.profile.mode === 'managed-remote' ? { ...state.profile } : null,
    async dispose() { unsubscribe(); suspendActiveTunnel(); await mutation; },
  };
}

export function registerTunnelAccessBoundary(app, server, { controller, connection, runtimeInstanceId, getRuntimeReady = () => true, authenticateOwner = (req) => connection.authenticateLocalOwner(req) }) {
  const json = express.json({ limit: '2kb' });
  app.use(async (req, res, next) => {
    if (isDirectLocalRequest(req)) {
      if (/^\/api\/openchamber\/tunnel(?:\/|$)/.test(req.path)) {
        if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-devryan-csrf'] !== '1') return res.sendStatus(403);
        try {
          if (!await authenticateOwner(req, res)) return res.status(403).json({ code: 'local_owner_required', error: 'Authenticate the local owner to control tunnels' });
          await controller.refreshOwner();
        } catch { return res.status(503).json({ error: 'Local owner could not be verified' }); }
      }
      return next();
    }
    const pathname = req.path;
    // Public connector verification needs a content-free liveness response
    // before the connector is marked active. Never expose the host snapshot.
    if (req.method === 'GET' && ['/health', '/api/health'].includes(pathname)) {
      if (runtimeInstanceId) res.setHeader('X-DevRyan-Instance-ID', runtimeInstanceId);
      return res.json({ status: 'ok' });
    }
    if (connection.authenticationMode === 'managed-accounts' && !connection.enabled) {
      return res.status(503).json({ error: 'Managed authentication is temporarily unavailable' });
    }
    const remoteSession = controller.getTunnelSessionFromRequest(req);
    const hasTunnelCookie = String(req.headers.cookie || '').includes(`${COOKIE}=`);
    if (/^\/(?:api\/(?:desktop|runtime-service|browser\/agent-leases)(?:\/|$)|auth\/runtime-service-bootstrap$)/.test(pathname)) return res.sendStatus(403);
    if (req.headers.origin && req.headers.origin !== `https://${remoteHost(req)}`) return res.sendStatus(403);
    if (pathname === '/tunnel/connect') {
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
      if (req.method === 'GET') {
        const nonce = crypto.randomBytes(16).toString('base64');
        res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
        return res.type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect to DevRyan Bots</title><h1>Connect to Bot workspaces</h1><p>This link grants access to selected Bots. It expires after 15 minutes.</p><button id="connect">Connect</button><p id="status" role="status"></p><script nonce="${nonce}">let token=new URLSearchParams(location.hash.slice(1)).get('t');history.replaceState(null,'',location.pathname);document.getElementById('connect').onclick=async()=>{const button=document.getElementById('connect');button.disabled=true;try{const response=await fetch('/tunnel/connect',{method:'POST',headers:{'Content-Type':'application/json','X-DevRyan-CSRF':'1'},body:JSON.stringify({token})});if(!response.ok)throw new Error('Connection failed. The link may have expired or already been used.');token=null;location.replace('/?view=bots');}catch(error){document.getElementById('status').textContent=error.message;button.disabled=false;}};</script></html>`);
      }
      if (req.method !== 'POST') return res.sendStatus(405);
      return json(req, res, async (error) => {
        if (error) return res.sendStatus(400);
        try {
          const result = await controller.exchangeBootstrapToken({ req, res, token: req.body?.token,
            beforeCommit: () => { if (!getRuntimeReady()) throw new Error('Runtime starting'); } });
          if (!result.ok) return res.status(result.reason === 'rate-limited' ? 429 : result.reason === 'origin' ? 403 : result.reason === 'precondition-failed' ? 503 : 401).json({ error: 'Connection link unavailable' });
          return res.json({ ok: true });
        } catch { return res.status(503).json({ error: 'Tunnel authorization unavailable' }); }
      });
    }
    // Managed account login is an explicit startup policy, never an outage
    // fallback. A tunnel cookie always stays in its restricted authority.
    if (connection.enabled && !hasTunnelCookie) return next();
    if (pathname === '/auth/session' && req.method === 'GET') {
      return res.status(remoteSession ? 200 : 401).json(remoteSession
        ? { authenticated: true, mode: 'local', scope: 'tunnel-bot', principal: controller.principalFor(remoteSession) }
        : { authenticated: false, locked: true, tunnelLocked: true });
    }
    if (req.method === 'GET' && /^(?:\/|\/assets\/[A-Za-z0-9_./-]+|\/favicon\.ico|\/manifest\.webmanifest|\/sw\.js)$/.test(pathname)) { authorizedRequests.add(req); return next(); }
    if (!remoteSession) return res.status(401).json({ error: 'Tunnel authentication required', tunnelLocked: true });
    if (!isBotTunnelRoute(req)) return res.status(403).json({ code: 'tunnel_bot_only', error: 'This link grants access only to selected Bot workspaces' });
    if (!['GET', 'HEAD'].includes(req.method) && (req.headers['x-devryan-csrf'] !== '1' || req.headers.origin !== `https://${remoteSession.hostname}`)) return res.sendStatus(403);
    req.principal = controller.principalFor(remoteSession);
    authorizedRequests.add(req);
    const unregister = controller.registerConnection(req.principal, () => res.destroy());
    res.once('close', unregister); res.once('finish', unregister);
    return runWithRequestPrincipal(req.principal, next);
  });
  const upgrade = (req, socket) => {
    if (socket.destroyed) return;
    if (isDirectLocalRequest(req)) return;
    if (connection.enabled && !String(req.headers?.cookie || '').includes(`${COOKIE}=`)) return;
    req.tunnelAccessDenied = true;
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); socket.destroy();
  };
  server?.prependListener('upgrade', upgrade);
  return () => server?.off('upgrade', upgrade);
}
