import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { registerSupabaseConnectionRoutes } from './connection-routes.js';

const fixture = (configured = false) => {
  const app = express(); app.set('trust proxy', true);
  const connection = { configured, authenticateLocalOwner: vi.fn(() => null),
    status: vi.fn(() => ({ privateValue: 'must not escape' })), change: vi.fn(), rememberOwner: vi.fn() };
  // Matches the installed app's unconfigured path: legacy session auth yields
  // local-admin, but there is no enrolled owner or managed resolvePrincipal.
  registerSupabaseConnectionRoutes(app, { runtime: { connection } });
  return { app, connection };
};

describe('About connection status authorization', () => {
  it('reproduces and repairs the unconfigured direct-local 403 without enrolling an owner', async () => {
    const { app, connection } = fixture();
    const result = await request(app).get('/api/system/supabase-connection');
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ configured: false, desiredEnabled: false, effectiveEnabled: false,
      state: 'disconnected', errorCode: null, restartRequired: false, restartAvailable: false, blockers: [] });
    expect(result.headers['cache-control']).toBe('no-store');
    expect(connection.status).not.toHaveBeenCalled();
    expect(connection.rememberOwner).not.toHaveBeenCalled();
    expect(connection.change).not.toHaveBeenCalled();
  });
  it('retains the observed 403 for configured hosts lacking owner proof', async () => {
    const { app } = fixture(true);
    const result = await request(app).get('/api/system/supabase-connection');
    expect(result.status).toBe(403);
    expect(result.body.error).toBe('Local administrator authentication required');
  });
  it.each([{ Host: 'remote.invalid' }, { Origin: 'https://remote.invalid' },
    { 'X-Forwarded-Host': 'localhost' }, { 'X-Forwarded-For': '127.0.0.1' }, { 'CF-Connecting-IP': '127.0.0.1' }])(
    'denies unconfigured status through a proxy or foreign origin: %s', async (headers) => {
      const { app } = fixture();
      expect((await request(app).get('/api/system/supabase-connection').set(headers)).status).toBe(403);
    });
  it('does not grant PATCH permission to an unconfigured local visitor', async () => {
    const { app, connection } = fixture();
    expect((await request(app).patch('/api/system/supabase-connection').set('X-DevRyan-CSRF', '1').send({ enabled: true })).status).toBe(403);
    expect(connection.change).not.toHaveBeenCalled();
  });
});
