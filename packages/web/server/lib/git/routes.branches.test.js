import express from 'express';
import request from '../../test-supertest.js';
import { describe, expect, it, vi } from 'vitest';

import { registerCommonRequestMiddleware } from '../opencode/core-routes.js';
import { registerGitRoutes } from './routes.js';

const branchList = { all: ['main'], current: 'main', branches: {} };

const makeApp = () => {
  const getBranches = vi.fn(async () => branchList);
  const app = express();
  registerCommonRequestMiddleware(app, { express });
  registerGitRoutes(app, { loadGitLibraries: async () => ({ getBranches }) });
  return { app, getBranches };
};

describe('GET /api/git/branches remote mode', () => {
  it('lists local refs unless the request asks for exactly remote=live', async () => {
    const { app, getBranches } = makeApp();

    for (const query of [{}, { remote: 'local' }, { remote: 'LIVE' }, { remote: 'live ' }, { remote: ['live', 'live'] }]) {
      const response = await request(app)
        .get('/api/git/branches')
        .query({ directory: '/repo', ...query })
        .expect(200);
      expect(response.body).toEqual(branchList);
    }
    expect(getBranches.mock.calls).toEqual(Array.from({ length: 5 }, () => ['/repo', { remote: 'local' }]));

    getBranches.mockClear();
    await request(app)
      .get('/api/git/branches')
      .query({ directory: '/repo', remote: 'live' })
      .expect(200);
    expect(getBranches.mock.calls).toEqual([['/repo', { remote: 'live' }]]);
  });

  it('still requires a directory', async () => {
    const { app, getBranches } = makeApp();

    const response = await request(app)
      .get('/api/git/branches')
      .query({ remote: 'live' })
      .expect(400);

    expect(response.body).toEqual({ error: 'directory parameter is required' });
    expect(getBranches).not.toHaveBeenCalled();
  });
});
