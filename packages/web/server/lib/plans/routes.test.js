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
  publishEvent,
  recordDiagnostic,
  readCanonicalPlanIdentity = async ({ sourceMessageID }) => {
    if (sourceMessageID === 'msg-foreign') throw Object.assign(new Error('Message not found'), { statusCode: 404 });
    return { sessionCreated: identity.sessionCreated, sessionSlug: identity.sessionSlug };
  },
} = {}) => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
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
    publishEvent,
    recordDiagnostic,
    readCanonicalPlanIdentity,
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

  it.each(['get', 'post', 'put'])('denies foreign source messages and invalid session metadata on %s', async (method) => {
    const app = createApp({ dataDirectory });
    for (const [sourceID, submitted] of [['msg-foreign', identity], ['msg-own', { ...identity, sessionCreated: identity.sessionCreated + 1 }],
      ['msg-own', { ...identity, sessionSlug: 'Another session' }]]) {
      const operation = request(app)[method](`/api/session/session-a/plan-revisions/${sourceID}`);
      const response = method === 'get' ? await operation.query(submitted)
        : await operation.send({ ...submitted, markdown: '# Must not publish', expectedVersion: 'a'.repeat(64) });
      expect(response.status).toBe(sourceID === 'msg-foreign' ? 404 : 409);
    }
    expect(await fs.readdir(dataDirectory)).toEqual([]);
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
    expect(ensured.body).toEqual({ path: created.body.path, created: false, version: created.body.version });
    expect(created.body.version).toMatch(/^[a-f0-9]{64}$/);

    const query = new URLSearchParams({
      directory: identity.directory,
      sessionCreated: String(identity.sessionCreated),
      sessionSlug: identity.sessionSlug,
    });
    const readOriginal = await request(app).get(`${route}?${query.toString()}`);
    expect(readOriginal.body.content).toBe('# Original plan');

    const updated = await request(app).put(route).send({ ...identity, markdown: '# Edited plan', expectedVersion: created.body.version });
    expect(updated.body).toEqual({ path: created.body.path, saved: true, version: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const readEdited = await request(app).get(`${route}?${query.toString()}`);
    expect(readEdited.body.content).toBe('# Edited plan');
  });


  it('requires the version and preserves a concurrent winner', async () => {
    const app = createApp({ dataDirectory });
    const route = '/api/session/session-a/plan-revisions/msg-cas';
    const created = await request(app).post(route).send({ ...identity, markdown: '# Original' });
    const missing = await request(app).put(route).send({ ...identity, markdown: '# Missing' });
    expect(missing.status).toBe(428);
    expect(missing.body.code).toBe('plan_version_required');
    const results = await Promise.all(['# First', '# Second'].map((markdown) => request(app).put(route)
      .send({ ...identity, markdown, expectedVersion: created.body.version })));
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const winner = results.find((result) => result.status === 200);
    const loser = results.find((result) => result.status === 409);
    expect(loser.body).toMatchObject({ code: 'plan_version_conflict', version: winner.body.version });
    const content = await fs.readFile(created.body.path, 'utf8');
    expect(content).toBe(results[0].status === 200 ? '# First' : '# Second');
  });

  it('rejects blank and oversized UTF-8 updates without truncating the revision', async () => {
    const app = createApp({ dataDirectory });
    const route = '/api/session/session-a/plan-revisions/msg-bounded';
    const created = await request(app).post(route).send({ ...identity, markdown: '# Original' });
    for (const markdown of ['  \n', '界'.repeat(90_000)]) {
      const response = await request(app).put(route).send({ ...identity, markdown, expectedVersion: created.body.version });
      expect(response.status).toBe(markdown.trim() ? 413 : 400);
    }
    expect(await fs.readFile(created.body.path, 'utf8')).toBe('# Original');
  });

  it('refuses symlink revisions for reads, ensures and writes', async () => {
    const app = createApp({ dataDirectory });
    const route = '/api/session/session-a/plan-revisions/msg-link';
    const revision = await resolveSessionPlanRevision({ dataDirectory, ...identity, sourceMessageID: 'msg-link', path });
    await fs.mkdir(revision.directory, { recursive: true });
    const outside = path.join(dataDirectory, 'protected.md');
    await fs.writeFile(outside, '# Protected');
    await fs.symlink(outside, revision.path);
    const read = await request(app).get(route).query(identity);
    const ensure = await request(app).post(route).send({ ...identity, markdown: '# Replace' });
    const write = await request(app).put(route).send({ ...identity, markdown: '# Replace', expectedVersion: 'a'.repeat(64) });
    expect([read.status, ensure.status, write.status]).toEqual([409, 409, 409]);
    expect(await fs.readFile(outside, 'utf8')).toBe('# Protected');
  });

  it('leaves the original intact when atomic publication fails', async () => {
    const app = createApp({ dataDirectory });
    const route = '/api/session/session-a/plan-revisions/msg-failed';
    const created = await request(app).post(route).send({ ...identity, markdown: '# Original' });
    const failing = createApp({ dataDirectory, fsPromises: { ...fs, rename: vi.fn(async () => { throw new Error('publish failed'); }) } });
    const response = await request(failing).put(route).send({ ...identity, markdown: '# Replacement', expectedVersion: created.body.version });
    expect(response.status).toBe(500);
    expect(await fs.readFile(created.body.path, 'utf8')).toBe('# Original');
    expect((await fs.readdir(path.dirname(created.body.path))).filter((name) => name.endsWith('.tmp') || name.endsWith('.lock'))).toEqual([]);
  });

  it('rechecks ownership at commit and preserves the original on revocation', async () => {
    const route = '/api/session/session-a/plan-revisions/msg-revoked';
    const created = await request(createApp({ dataDirectory })).post(route).send({ ...identity, markdown: '# Original' });
    let reads = 0;
    const app = createApp({ dataDirectory, resolveOwnedSessionPlanContext: async () => ++reads < 3 ? { directory: identity.directory } : null });
    const updated = await request(app).put(route).send({ ...identity, markdown: '# Replacement', expectedVersion: created.body.version });
    expect(updated.status).toBe(404);
    expect(updated.body.code).toBe('plan_owner_changed');
    expect(reads).toBe(3);
    expect(await fs.readFile(created.body.path, 'utf8')).toBe('# Original');
  });

  it.each(['post', 'put'])('rejects an assignment change during %s staging even if the repository is unchanged', async method => {
    const route = '/api/session/session-a/plan-revisions/msg-assignment';
    let version;
    if (method === 'put') version = (await request(createApp({ dataDirectory })).post(route).send({ ...identity, markdown: '# Original' })).body.version;
    let branchName = 'main';
    const app = createApp({ dataDirectory,
      resolveOwnedSessionPlanContext: async () => ({ directory: identity.directory, projectId: 'project', branchName }),
      fsPromises: { ...fs, async open(file, ...args) {
        const handle = await fs.open(file, ...args);
        if (String(file).endsWith('.tmp')) branchName = 'other';
        return handle;
      } },
    });
    const response = await request(app)[method](route).send({ ...identity, markdown: '# Must not publish', expectedVersion: version });
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('plan_owner_changed');
    if (method === 'put') {
      const revision = await resolveSessionPlanRevision({ dataDirectory, ...identity, sourceMessageID: 'msg-assignment' });
      expect(await fs.readFile(revision.path, 'utf8')).toBe('# Original');
    }
  });

  it('reloads grants immediately before reading and denies a revoked request snapshot', async () => {
    const route = '/api/session/session-a/plan-revisions/msg-read-revocation';
    await request(createApp({ dataDirectory })).post(route).send({ ...identity, markdown: '# Original' });
    let granted = true;
    const app = createApp({ dataDirectory,
      resolveOwnedSessionPlanContext: async () => granted ? { directory: identity.directory } : null,
      readCanonicalPlanIdentity: async () => { granted = false; return identity; },
    });
    expect((await request(app).get(route).query(identity)).status).toBe(404);
  });

  it('refuses a symlinked project plans directory', async () => {
    const revision = await resolveSessionPlanRevision({ dataDirectory, ...identity, sourceMessageID: 'msg-escape', path });
    const destination = path.join(dataDirectory, 'outside');
    await fs.mkdir(destination);
    await fs.mkdir(path.dirname(revision.directory), { recursive: true });
    await fs.symlink(destination, revision.directory);
    const response = await request(createApp({ dataDirectory })).post('/api/session/session-a/plan-revisions/msg-escape')
      .send({ ...identity, markdown: '# Must not write' });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('plan_path_unsafe');
    expect(await fs.readdir(destination)).toEqual([]);
  });

  it('refuses a symlinked storage ancestor before creating directories through it', async () => {
    const destination = path.join(dataDirectory, 'outside');
    await fs.mkdir(destination);
    await fs.symlink(destination, path.join(dataDirectory, 'projects'));
    const response = await request(createApp({ dataDirectory })).post('/api/session/session-a/plan-revisions/msg-ancestor')
      .send({ ...identity, markdown: '# Must not write' });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('plan_path_unsafe');
    expect(await fs.readdir(destination)).toEqual([]);
  });

  it('publishes only revision identity and version and journals writes and refusals without text', async () => {
    const publishEvent = vi.fn(), recordDiagnostic = vi.fn();
    const app = createApp({ dataDirectory, publishEvent, recordDiagnostic });
    const route = '/api/session/session-a/plan-revisions/msg-events';
    const created = await request(app).post(route).send({ ...identity, markdown: '# Private content' });
    const updated = await request(app).put(route).send({ ...identity, markdown: '# Private revision', expectedVersion: created.body.version });
    await request(app).put(route).send({ ...identity, markdown: '# Stale content', expectedVersion: created.body.version });
    expect(publishEvent).toHaveBeenCalledTimes(2);
    expect(publishEvent.mock.calls.at(-1)[0]).toEqual({ type: 'session.plan.updated', properties: {
      sessionID: 'session-a', sourceMessageID: 'msg-events', ...identity, version: updated.body.version,
    } });
    expect(recordDiagnostic.mock.calls.map(([record]) => record.payload.outcome)).toEqual(['saved', 'saved', 'refused']);
    expect(JSON.stringify([...publishEvent.mock.calls, ...recordDiagnostic.mock.calls])).not.toContain('Private');
    expect(JSON.stringify(recordDiagnostic.mock.calls)).not.toContain('Stale content');
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
    expect(read.body).toEqual({ path: created.body.path, content: '# Long project plan', version: created.body.version });
    const updated = await request(app).put(route).send({ ...longIdentity, markdown: '# Revised long project plan', expectedVersion: created.body.version });
    expect(updated.body).toEqual({ path: created.body.path, saved: true, version: expect.stringMatching(/^[a-f0-9]{64}$/) });
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
