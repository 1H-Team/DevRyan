import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import request from '../../test-supertest.js';
import { registerSessionPlanRoutes, resolveSessionPlanRevision } from './routes.js';

const identity = {
  directory: '/Users/example/Repositories/Test',
  sessionCreated: 1_721_234_567_890,
  sessionSlug: 'Add clamp / helper',
};

const createApp = ({
  dataDirectory,
  ownsSession = async () => true,
  resolveOwnedSessionPlanContext = async (_principal, _sessionID, requestedDirectory) => ({
    directory: requestedDirectory,
  }),
  fsPromises = fs,
} = {}) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.principal = { scope: 'managed', id: 'developer-a', role: 'developer' };
    next();
  });
  registerSessionPlanRoutes(app, {
    dataDirectory,
    fsPromises,
    path,
    ownsSession,
    resolveOwnedSessionPlanContext,
  });
  return app;
};

describe('session plan revision routes', () => {
  let dataDirectory;

  beforeEach(async () => {
    dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-plan-routes-'));
  });

  afterEach(async () => {
    await fs.rm(dataDirectory, { recursive: true, force: true });
  });

  it('creates once, reads, and updates an owned revision without overwriting edits on ensure', async () => {
    const app = createApp({ dataDirectory });
    const route = '/api/session/session-a/plan-revisions/msg-plan-1';

    const created = await request(app).post(route).send({ ...identity, markdown: '# Original plan' });
    expect(created.status).toBe(200);
    expect(created.body.created).toBe(true);
    expect(created.body.path).toContain('/projects/path_');
    expect(created.body.path.endsWith('/plans/1721234567890-Add-clamp-helper-msg-plan-1.md')).toBe(true);

    const ensured = await request(app).post(route).send({ ...identity, markdown: '# Must not overwrite' });
    expect(ensured.body).toEqual({ path: created.body.path, created: false });

    const query = new URLSearchParams({
      directory: identity.directory,
      sessionCreated: String(identity.sessionCreated),
      sessionSlug: identity.sessionSlug,
    });
    const readOriginal = await request(app).get(`${route}?${query.toString()}`);
    expect(readOriginal.body.content).toBe('# Original plan');

    const updated = await request(app).put(route).send({ ...identity, markdown: '# Edited plan' });
    expect(updated.body).toEqual({ path: created.body.path, saved: true });
    const readEdited = await request(app).get(`${route}?${query.toString()}`);
    expect(readEdited.body.content).toBe('# Edited plan');
  });

  it('returns 404 for a foreign managed session', async () => {
    const response = await request(createApp({ dataDirectory, ownsSession: async () => false }))
      .post('/api/session/session-foreign/plan-revisions/msg-plan-1')
      .send({ ...identity, markdown: '# Plan' });

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('Session not found');
  });

  it('creates, reads and updates a revision for a project whose encoded path exceeds a filesystem component', async () => {
    const app = createApp({ dataDirectory });
    const longIdentity = { ...identity, directory: `/repo/${'nested-project/'.repeat(16)}feature` };
    const route = '/api/session/session-a/plan-revisions/msg-long-plan';
    const created = await request(app).post(route).send({ ...longIdentity, markdown: '# Long project plan' });
    expect(created.status).toBe(200);
    expect(created.body.path).toMatch(/\/projects\/path_sha256_[a-f0-9]{64}\/plans\//);
    const query = new URLSearchParams({ ...longIdentity, sessionCreated: String(identity.sessionCreated) });
    const read = await request(app).get(`${route}?${query}`);
    expect(read.body).toEqual({ path: created.body.path, content: '# Long project plan' });
    const updated = await request(app).put(route).send({ ...longIdentity, markdown: '# Revised long project plan' });
    expect(updated.body).toEqual({ path: created.body.path, saved: true });
    expect(await fs.readFile(created.body.path, 'utf8')).toBe('# Revised long project plan');
  });

  it('uses the ownership-derived project root instead of a managed worktree path', async () => {
    const canonicalDirectory = '/Users/example/Repositories/Canonical';
    const worktreeDirectory = '/Users/example/.local/share/opencode/worktree/project/feature';
    const app = createApp({
      dataDirectory,
      resolveOwnedSessionPlanContext: async () => ({ directory: canonicalDirectory }),
    });
    const route = '/api/session/session-a/plan-revisions/msg-plan-worktree';

    const created = await request(app).post(route).send({
      ...identity,
      directory: worktreeDirectory,
      markdown: '# Worktree plan',
    });
    expect(created.status).toBe(200);

    const query = new URLSearchParams({
      directory: worktreeDirectory,
      sessionCreated: String(identity.sessionCreated),
      sessionSlug: identity.sessionSlug,
    });
    const read = await request(app).get(`${route}?${query.toString()}`);
    expect(read.status).toBe(200);
    expect(read.body.content).toBe('# Worktree plan');

    const canonical = await resolveSessionPlanRevision({
      dataDirectory,
      ...identity,
      directory: canonicalDirectory,
      sourceMessageID: 'msg-plan-worktree',
      path,
    });
    expect(created.body.path).toBe(canonical.path);
  });

  it('fails closed when managed ownership cannot resolve a plan project', async () => {
    const response = await request(createApp({
      dataDirectory,
      resolveOwnedSessionPlanContext: async () => null,
    }))
      .get('/api/session/session-a/plan-revisions/msg-plan-1')
      .query(identity);

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('Session not found');
  });

  it('rejects malformed identities and traversal attempts before touching storage', async () => {
    const app = createApp({ dataDirectory });
    const invalidSource = await request(app)
      .post('/api/session/session-a/plan-revisions/..%2Fescape')
      .send({ ...identity, markdown: '# Plan' });
    expect(invalidSource.status).toBe(400);
    expect(invalidSource.body.error).toMatch(/source message ID/i);

    const invalidSession = await request(app)
      .post('/api/session/..%2Fescape/plan-revisions/msg-plan-1')
      .send({ ...identity, markdown: '# Plan' });
    expect(invalidSession.status).toBe(400);
    expect(invalidSession.body.error).toMatch(/session ID/i);

    const invalidDirectory = await request(app)
      .post('/api/session/session-a/plan-revisions/msg-plan-1')
      .send({ ...identity, directory: '../escape', markdown: '# Plan' });
    expect(invalidDirectory.status).toBe(400);
    expect(invalidDirectory.body.error).toMatch(/absolute path/i);

    await expect(resolveSessionPlanRevision({
      dataDirectory,
      ...identity,
      sourceMessageID: '../escape',
      path,
    })).rejects.toThrow(/source message ID/i);
  });

  it('surfaces real storage failures and non-file collisions', async () => {
    const failingFs = {
      ...fs,
      mkdir: vi.fn(async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); }),
    };
    const failed = await request(createApp({ dataDirectory, fsPromises: failingFs }))
      .post('/api/session/session-a/plan-revisions/msg-plan-1')
      .send({ ...identity, markdown: '# Plan' });
    expect(failed.status).toBe(500);
    expect(failed.body.error).toBe('disk full');

    const revision = await resolveSessionPlanRevision({
      dataDirectory,
      ...identity,
      sourceMessageID: 'msg-plan-directory',
      path,
    });
    await fs.mkdir(revision.path, { recursive: true });
    const collision = await request(createApp({ dataDirectory }))
      .post('/api/session/session-a/plan-revisions/msg-plan-directory')
      .send({ ...identity, markdown: '# Plan' });
    expect(collision.status).toBe(409);
  });
});
