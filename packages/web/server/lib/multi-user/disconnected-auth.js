import { runWithRequestPrincipal } from './request-context.js';
import { publicPrincipal } from './policy.js';
import { isDirectLocalRequest } from './supabase-connection.js';

const unavailable = (res) => res.status(503).json({
  code: 'supabase_disconnected', error: 'Supabase is disconnected on this host',
});

export function createDisconnectedAuth(connection) {
  const resolvePrincipal = async (req) => connection.authenticateLocalOwner(req);
  const requireAuth = async (req, res, next) => {
    const principal = await resolvePrincipal(req);
    if (!principal) return res.status(401).json({ authenticated: false, error: 'Local owner authentication required' });
    req.principal = principal;
    return runWithRequestPrincipal(principal, next);
  };
  return {
    enabled: true, multiUser: false,
    resolvePrincipal, requireAuth, authorizeSystemRequest: requireAuth,
    async handleSessionStatus(req, res) {
      const principal = await resolvePrincipal(req);
      if (!principal) return res.status(401).json({ authenticated: false, locked: true, mode: 'local', supabaseDisconnected: true });
      return res.json({ authenticated: true, mode: 'local', supabaseDisconnected: true, principal: publicPrincipal(principal) });
    },
    handleSessionCreate: (_req, res) => unavailable(res),
    async handleLogout(req, res) {
      if (!isDirectLocalRequest(req) || req.headers?.['x-devryan-csrf'] !== '1') return res.status(403).json({ error: 'Local owner CSRF check failed' });
      await connection.logoutLocalOwner(res, req);
      return res.json({ authenticated: false });
    },
    handlePasskeyStatus: (_req, res) => res.json({ enabled: false, hasPasskeys: false, passkeyCount: 0, rpID: null }),
    handlePasskeyAuthenticationOptions: (_req, res) => unavailable(res),
    handlePasskeyAuthenticationVerify: (_req, res) => unavailable(res),
    handlePasskeyRegistrationOptions: (_req, res) => unavailable(res),
    handlePasskeyRegistrationVerify: (_req, res) => unavailable(res),
    handlePasskeyList: (_req, res) => unavailable(res),
    handlePasskeyRevoke: (_req, res) => unavailable(res),
    async ensureSessionToken(req) {
      const principal = await resolvePrincipal(req);
      if (!principal) return null;
      req.principal = principal;
      return String(req.headers.cookie).split(';').find((part) => part.trim().startsWith('devryan_local_owner='))?.trim().slice('devryan_local_owner='.length) || null;
    },
    registerConnection: () => () => {},
    dispose: () => connection.dispose(),
  };
}
