import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { canonicalApiUrl, legacyApiPathRewrite } from './legacy-api-path.js';

describe('legacy /api/openchamber alias', () => {
  it('maps only the exact prefix', () => {
    expect(canonicalApiUrl('/api/openchamber/tunnel/status?x=1')).toBe('/api/devryan/tunnel/status?x=1');
    expect(canonicalApiUrl('/api/openchamber?x=1')).toBe('/api/devryan?x=1');
    expect(canonicalApiUrl('/api/openchamber')).toBe('/api/devryan');
    expect(canonicalApiUrl('/api/openchamberx/a')).toBe('/api/openchamberx/a');
    expect(canonicalApiUrl('/api/devryan/a')).toBe('/api/devryan/a');
    expect(canonicalApiUrl('/api/session')).toBe('/api/session');
  });

  it('runs before every later guard, which sees only the canonical path', async () => {
    const app = express();
    app.use(legacyApiPathRewrite);
    const seen = [];
    app.use((req, _res, next) => { seen.push([req.url, req.originalUrl, req.path]); next(); });
    app.use('/api/devryan/guarded', (req, res, next) => (req.headers['x-allow'] === '1' ? next() : res.status(403).end()));
    app.get('/api/devryan/guarded/status', (_req, res) => res.json({ ok: true }));
    expect((await request(app).get('/api/openchamber/guarded/status')).status).toBe(403);
    expect((await request(app).get('/api/openchamber/guarded/status').set('x-allow', '1')).body).toEqual({ ok: true });
    expect((await request(app).get('/api/devryan/guarded/status').set('x-allow', '1')).body).toEqual({ ok: true });
    expect(seen[0]).toEqual(['/api/devryan/guarded/status', '/api/devryan/guarded/status', '/api/devryan/guarded/status']);
  });
});
