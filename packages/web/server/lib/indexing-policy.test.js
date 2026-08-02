import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import {
  INDEXING_POLICY_HEADER,
  ROBOTS_POLICY,
  registerIndexingPolicy,
} from './indexing-policy.js';

const makeApp = () => {
  const app = express();
  app.set('trust proxy', true);
  registerIndexingPolicy(app);
  app.get('/api/example', (_req, res) => res.json({ ok: true }));
  return app;
};

describe('server indexing policy', () => {
  it('serves the exact no-index robots policy as non-cacheable plain text', async () => {
    const response = await request(makeApp()).get('/robots.txt').expect(200);

    expect(response.text).toBe(ROBOTS_POLICY);
    expect(response.text).toBe('User-agent: *\nDisallow: /');
    expect(response.headers['content-type']).toMatch(/^text\/plain\b/);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-robots-tag']).toBe(INDEXING_POLICY_HEADER);
  });

  it('adds the indexing header to API responses', async () => {
    const response = await request(makeApp()).get('/api/example').expect(200);
    expect(response.headers['x-robots-tag']).toBe(INDEXING_POLICY_HEADER);
  });

  it('adds the indexing header to 404 responses', async () => {
    const response = await request(makeApp()).get('/missing').expect(404);
    expect(response.headers['x-robots-tag']).toBe(INDEXING_POLICY_HEADER);
  });
});
