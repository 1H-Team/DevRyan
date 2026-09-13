import express from 'express';
import { isDirectLocalRequest } from './supabase-connection.js';

const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
const unavailable = (res) => res.status(503).json({ code: 'supabase_disconnected', error: 'Supabase is disconnected on this host' });

export function registerSupabaseConnectionRoutes(app, { runtime, preserveLocalContext = async () => {} }) {
  const connection = runtime.connection;
  if (!connection) return;
  const authorize = async (req, res) => {
    if (!isDirectLocalRequest(req)) { res.status(403).json({ error: 'Only the local host owner can control Supabase' }); return null; }
    // The enrolled local credential also works during a failed reconnect.
    const local = connection.authenticateLocalOwner(req);
    if (local) return local;
    const principal = await runtime.resolvePrincipal?.(req, res);
    if (principal?.role === 'admin' && principal.scope === 'managed' && !principal.offlineGrace) return principal;
    res.status(403).json({ error: 'Local administrator authentication required' });
    return null;
  };
  app.get('/api/system/supabase-connection', async (req, res) => {
    try {
      if (!await authorize(req, res)) return;
      res.setHeader('Cache-Control', 'no-store');
      return res.json(connection.status());
    } catch { return res.status(503).json({ error: 'Local owner could not be verified' }); }
  });
  // /api/system is not in the shared body-parser allowlist, so parse inline.
  app.patch('/api/system/supabase-connection', express.json({ limit: '16kb' }), async (req, res) => {
    if (req.headers?.['x-devryan-csrf'] !== '1') return res.status(403).json({ error: 'Missing CSRF request header' });
    if (!req.body || Object.keys(req.body).length !== 1 || typeof req.body.enabled !== 'boolean') {
      return res.status(400).json({ error: 'Expected an enabled boolean' });
    }
    try {
      let principal = await authorize(req, res);
      if (!principal) return;
      if (!principal.localOwner) {
        principal = { ...principal, settingsOverrides: await runtime.readOwnerSettings?.(principal.id) || {} };
        await connection.rememberOwner(principal, res);
      }
      if (req.body.enabled === false) await preserveLocalContext(principal);
      return res.status(202).json(await connection.change(req.body.enabled));
    } catch (error) {
      return res.status(error?.statusCode || 503).json({
        error: 'Supabase connection could not be changed',
        code: typeof error?.code === 'string' && /^supabase_[a-z_]+$/.test(error.code) ? error.code : 'supabase_connection_failed',
      });
    }
  });
}

// Runs before any private routes, auth bootstrap or public HTTP proxy. It also
// covers reconnect startup failures: those never silently become public local mode.
export function attachSupabaseConnectionBoundary(app, server, connection) {
  if (!connection?.configured) return () => 0;
  let activeRequests = 0;
  app.use((req, res, next) => {
    if (!connection.enabled && !isDirectLocalRequest(req)) return unavailable(res);
    if (!connection.enabled && /^\/api\/(?:admin|bots|bot-actions|bot-channels|bot-runs|bug-reports|user-analytics)(?:\/|$)/.test(req.path)) return unavailable(res);
    if (connection.status().restartRequired && !safeMethods.has(req.method)) {
      // Completion, cancellation and approval for admitted work remain usable.
      const startsWork = /\/(?:prompt_async|message|command|shell|enqueue|retry|prewarm|fork|run-now|execute)$/.test(req.path)
        || (req.method === 'POST' && /^\/api\/session\/?$/.test(req.path));
      if (startsWork) return res.status(503).json({ code: 'supabase_change_pending', error: 'Waiting for active work before restarting DevRyan' });
    }
    if (!safeMethods.has(req.method) && req.path !== '/api/system/supabase-connection') {
      activeRequests += 1;
      let done = false;
      const finish = () => { if (!done) { done = true; activeRequests -= 1; } };
      res.once('finish', finish);
      res.once('close', finish);
    }
    return next();
  });
  server?.prependListener('upgrade', (req, socket) => {
    if (connection.enabled || connection.authenticateLocalOwner(req)) return;
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
  });
  return () => activeRequests;
}
