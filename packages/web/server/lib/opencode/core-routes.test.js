import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from '../../test-supertest.js';
import { registerServerStatusRoutes } from './core-routes.js';

describe('core-routes', () => {
  const createApp = () => {
    const app = express();
    let shutdownOpts = null;
    const dependencies = {
      express,
      process,
      gracefulShutdown: vi.fn(async (opts) => {
        shutdownOpts = opts;
      }),
      getHealthSnapshot: () => ({ status: 'ok' }),
      openchamberVersion: '1.0.0',
      runtimeName: 'test',
      serverStartedAt: '2026-01-01T00:00:00.000Z',
    };

    registerServerStatusRoutes(app, dependencies);

    return { app, dependencies, getShutdownOpts: () => shutdownOpts };
  };

  it('returns health JSON from the /api/health compatibility route', async () => {
    const { app } = createApp();

    const response = await request(app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.type).toBe('application/json');
    expect(response.body).toMatchObject({ status: 'ok' });
    expect(response.text).not.toContain('<!doctype html>');
  });

  it('allows shutdown requests without an origin header', async () => {
    const { app, dependencies, getShutdownOpts } = createApp();

    const response = await request(app).post('/api/system/shutdown');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(dependencies.gracefulShutdown).toHaveBeenCalledTimes(1);
    expect(getShutdownOpts()).toEqual({ exitProcess: true });
  });

  it('allows same-origin shutdown requests', async () => {
    const { app, dependencies, getShutdownOpts } = createApp();

    const response = await request(app)
      .post('/api/system/shutdown')
      .set('Host', '127.0.0.1:3001')
      .set('Origin', 'http://127.0.0.1:3001');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(dependencies.gracefulShutdown).toHaveBeenCalledTimes(1);
    expect(getShutdownOpts()).toEqual({ exitProcess: true });
  });

  it('rejects foreign-origin shutdown requests without shutting down', async () => {
    const { app, dependencies } = createApp();

    const response = await request(app)
      .post('/api/system/shutdown')
      .set('Host', '127.0.0.1:3001')
      .set('Origin', 'https://example.com');

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ ok: false, error: 'Invalid origin' });
    expect(dependencies.gracefulShutdown).not.toHaveBeenCalled();
  });

  it('rejects shutdown in dev mode', async () => {
    const previous = process.env.OPENCHAMBER_DEV_MODE;
    process.env.OPENCHAMBER_DEV_MODE = 'true';
    try {
      const { app, dependencies } = createApp();
      const response = await request(app)
        .post('/api/system/shutdown')
        .set('Host', '127.0.0.1:3001')
        .set('Origin', 'http://127.0.0.1:3001');

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ ok: false, error: 'Shutdown is disabled in dev mode' });
      expect(dependencies.gracefulShutdown).not.toHaveBeenCalled();
    } finally {
      if (typeof previous === 'undefined') {
        delete process.env.OPENCHAMBER_DEV_MODE;
      } else {
        process.env.OPENCHAMBER_DEV_MODE = previous;
      }
    }
  });

  it('rejects dev-shutdown when allow flag is not set', async () => {
    const previousShutdown = process.env.OPENCHAMBER_DEV_SHUTDOWN;
    const previousAllow = process.env.OPENCHAMBER_ALLOW_DEV_SHUTDOWN;
    process.env.OPENCHAMBER_DEV_SHUTDOWN = 'true';
    delete process.env.OPENCHAMBER_ALLOW_DEV_SHUTDOWN;
    try {
      const { app } = createApp();
      const response = await request(app)
        .post('/api/system/dev-shutdown')
        .set('Host', '127.0.0.1:3001')
        .set('Origin', 'http://127.0.0.1:3001')
        .send({ previewUrls: [] });

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ ok: false, error: 'Dev shutdown is disabled' });
    } finally {
      if (typeof previousShutdown === 'undefined') {
        delete process.env.OPENCHAMBER_DEV_SHUTDOWN;
      } else {
        process.env.OPENCHAMBER_DEV_SHUTDOWN = previousShutdown;
      }
      if (typeof previousAllow === 'undefined') {
        delete process.env.OPENCHAMBER_ALLOW_DEV_SHUTDOWN;
      } else {
        process.env.OPENCHAMBER_ALLOW_DEV_SHUTDOWN = previousAllow;
      }
    }
  });

  it('exposes dev flags on /api/system/info', async () => {
    const previousMode = process.env.OPENCHAMBER_DEV_MODE;
    const previousShutdown = process.env.OPENCHAMBER_DEV_SHUTDOWN;
    const previousAllow = process.env.OPENCHAMBER_ALLOW_DEV_SHUTDOWN;
    process.env.OPENCHAMBER_DEV_MODE = 'true';
    process.env.OPENCHAMBER_DEV_SHUTDOWN = 'true';
    process.env.OPENCHAMBER_ALLOW_DEV_SHUTDOWN = 'true';
    try {
      const { app } = createApp();
      const response = await request(app).get('/api/system/info');
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        devMode: true,
        devShutdownAllowed: true,
      });
    } finally {
      for (const [key, value] of [
        ['OPENCHAMBER_DEV_MODE', previousMode],
        ['OPENCHAMBER_DEV_SHUTDOWN', previousShutdown],
        ['OPENCHAMBER_ALLOW_DEV_SHUTDOWN', previousAllow],
      ]) {
        if (typeof value === 'undefined') {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});
