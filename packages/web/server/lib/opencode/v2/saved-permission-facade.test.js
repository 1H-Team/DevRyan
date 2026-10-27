import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from '../../../test-supertest.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenCodeV2FacadeRouter } from './facade-routes.js';
import { authorizeSavedApprovalDirectory, createSavedPermissionFacade, parseSavedApprovalUpdate, toSavedApproval } from './saved-permission-facade.js';

const PROJECT = '/repo/alpha';
const OTHER = '/repo/beta';
const row = (id, overrides = {}) => ({ id, projectID: 'prj_alpha', action: 'bash', resource: 'git status*',
  time: { created: 1_700_000_000_000, updated: 1_700_000_100_000 }, ...overrides });

const managed = { scope: 'managed', role: 'developer', assignments: [{ projectId: 'p1', publicDirectory: '/workspace/alpha',
  repositoryPath: PROJECT, worktreeContainerPath: null }] };

/**
 * The real facade router and server-audience requester against a fake native
 * host: `/api/location` answers by directory header, saved rows live in `rows`.
 */
const setup = ({ principal, rows = [row('psv_a'), row('psv_mcp', { action: 'github_create_issue', resource: '*' })],
  projects = { [PROJECT]: 'prj_alpha', [OTHER]: 'prj_beta' }, patch, savedRows } = {}) => {
  const calls = [];
  const fetchImpl = vi.fn(async (url, init = {}) => {
    const target = new URL(url);
    const method = init.method ?? 'GET';
    calls.push({ method, path: target.pathname, search: target.search, headers: init.headers, body: init.body });
    if (target.pathname === '/api/location') {
      const directory = decodeURIComponent(init.headers?.['x-opencode-directory'] ?? '');
      const id = projects[directory];
      return id ? Response.json({ data: { directory, project: { id } } }) : Response.json({ _tag: 'LocationNotFoundError', message: 'no' }, { status: 404 });
    }
    if (target.pathname === '/api/permission/saved' && method === 'GET') {
      const projectID = target.searchParams.get('projectID');
      return Response.json({ data: savedRows ?? rows.filter((entry) => entry.projectID === projectID) });
    }
    const match = /^\/api\/permission\/saved\/([^/]+)$/.exec(target.pathname);
    if (match && method === 'PATCH') {
      if (patch) return patch(match[1], JSON.parse(init.body));
      const current = rows.find((entry) => entry.id === match[1]);
      return Response.json({ data: { ...current, ...JSON.parse(init.body), time: { ...current.time, updated: 1_700_000_200_000 } } });
    }
    if (match && method === 'DELETE') return new Response(null, { status: 204 });
    return Response.json({ message: 'unexpected' }, { status: 500 });
  });
  const app = express();
  app.use((req, _res, next) => { if (principal) req.principal = principal; next(); });
  app.use('/api', createOpenCodeV2FacadeRouter({ openCodeClient: { generation: () => 2 },
    getOpenCodeRuntime: () => ({ generation: 2, baseUrl: 'http://127.0.0.1:12345' }),
    resolveRequestDirectory: () => OTHER, fetchImpl }));
  const writes = () => calls.filter((call) => call.method !== 'GET');
  return { app, fetchImpl, calls, writes };
};

const q = (directory) => `?directory=${encodeURIComponent(directory)}`;

afterEach(() => { vi.unstubAllEnvs(); });

describe('saved approvals route', () => {
  it('lists the directory project rows, sorted, with any-input flagged', async () => {
    const { app, calls } = setup();
    const response = await request(app).get(`/api/permission/saved${q(PROJECT)}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ projectID: 'prj_alpha', approvals: [
      { id: 'psv_a', projectID: 'prj_alpha', action: 'bash', resource: 'git status*', anyInput: false,
        time: { created: 1_700_000_000_000, updated: 1_700_000_100_000 } },
      { id: 'psv_mcp', projectID: 'prj_alpha', action: 'github_create_issue', resource: '*', anyInput: true,
        time: { created: 1_700_000_000_000, updated: 1_700_000_100_000 } },
    ] });
    expect(calls.find((call) => call.path === '/api/permission/saved').search).toBe('?projectID=prj_alpha');
  });

  it('requires an explicit absolute directory and never uses the fallback workspace', async () => {
    const { app, fetchImpl } = setup();
    expect((await request(app).get('/api/permission/saved')).status).toBe(400);
    expect((await request(app).get('/api/permission/saved?directory=relative/path')).status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('confines a managed developer to assigned directories and refuses the global bucket', async () => {
    const { app, fetchImpl } = setup({ principal: managed, projects: { [PROJECT]: 'global', [OTHER]: 'prj_beta' } });
    const outside = await request(app).get(`/api/permission/saved${q(OTHER)}`);
    expect(outside.status).toBe(403);
    expect(outside.body.code).toBe('saved_approval_forbidden');
    expect(fetchImpl).not.toHaveBeenCalled();
    const global = await request(app).get(`/api/permission/saved${q(PROJECT)}`);
    expect(global.status).toBe(403);
    expect(fetchImpl.mock.calls.every(([url]) => !String(url).includes('/api/permission/saved'))).toBe(true);
  });

  it('lets a managed developer read an assigned project and administrators pass through', async () => {
    expect((await request(setup({ principal: managed }).app).get(`/api/permission/saved${q(PROJECT)}`)).status).toBe(200);
    const admin = { ...managed, role: 'admin', assignments: [] };
    expect((await request(setup({ principal: admin }).app).get(`/api/permission/saved${q(OTHER)}`)).status).toBe(200);
    expect((await request(setup({ principal: { scope: 'local-admin', role: 'admin' } }).app)
      .get(`/api/permission/saved${q(OTHER)}`)).status).toBe(200);
  });

  it('refuses edits from a managed non-administrator before any native call, but keeps list and revoke', async () => {
    const { app, calls, writes } = setup({ principal: managed });
    for (const body of [{ resource: '*' }, { action: 'read' }, { effect: 'deny' }]) {
      const response = await request(app).patch(`/api/permission/saved/psv_a${q(PROJECT)}`).send(body);
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: 'saved_approval_edit_forbidden' });
    }
    // A senior developer is still a managed non-administrator.
    const senior = setup({ principal: { ...managed, role: 'senior_developer' } });
    expect((await request(senior.app).patch(`/api/permission/saved/psv_a${q(PROJECT)}`).send({ resource: '*' })).body.code)
      .toBe('saved_approval_edit_forbidden');
    expect(senior.calls).toEqual([]);
    expect(calls).toEqual([]);
    expect((await request(app).get(`/api/permission/saved${q(PROJECT)}`)).status).toBe(200);
    expect((await request(app).delete(`/api/permission/saved/psv_a${q(PROJECT)}`)).status).toBe(200);
    expect(writes()).toEqual([expect.objectContaining({ method: 'DELETE', path: '/api/permission/saved/psv_a' })]);
  });

  it('refuses a restricted scope in the owner itself', async () => {
    const native = vi.fn();
    const facade = createSavedPermissionFacade({ request: native });
    await expect(facade.update('psv_a', { resource: '*' }, { directory: PROJECT, restricted: true }))
      .rejects.toMatchObject({ statusCode: 403, code: 'saved_approval_edit_forbidden' });
    expect(native).not.toHaveBeenCalled();
  });

  it.each([
    ['administrator', { ...managed, role: 'admin' }],
    ['local administrator', { scope: 'local-admin', role: 'admin' }],
  ])('lets an %s edit', async (_label, principal) => {
    const { app } = setup({ principal });
    const response = await request(app).patch(`/api/permission/saved/psv_a${q(PROJECT)}`).send({ resource: 'git log*' });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: 'psv_a', resource: 'git log*' });
  });

  it('updates the resource and action of an owned row', async () => {
    const { app, writes } = setup({ principal: { scope: 'local-admin', role: 'admin' } });
    const response = await request(app).patch(`/api/permission/saved/psv_mcp${q(PROJECT)}`).send({ resource: 'repo:alpha' });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: 'psv_mcp', resource: 'repo:alpha', anyInput: false });
    expect(writes()).toEqual([expect.objectContaining({ method: 'PATCH', path: '/api/permission/saved/psv_mcp', body: JSON.stringify({ resource: 'repo:alpha' }) })]);
    const renamed = await request(app).patch(`/api/permission/saved/psv_a${q(PROJECT)}`).send({ action: 'read', resource: '*' });
    expect(renamed.body).toMatchObject({ action: 'read', resource: '*', anyInput: true });
  });

  it.each([
    [{}, 'Provide an action or a resource'],
    [{ resource: '' }, 'resource must be a non-empty string'],
    [{ resource: '  ' }, 'resource must be a non-empty string'],
    [{ resource: 'a\nb' }, 'resource must not contain control characters'],
    [{ resource: 'x'.repeat(4097) }, 'resource must be at most 4096 characters'],
    [{ resource: 1 }, 'resource must be a non-empty string'],
    [{ action: 'allow me' }, 'action must be a permission name'],
    [{ action: null }, 'action must be a permission name'],
    [{ effect: 'deny' }, 'Request body contains unsupported fields'],
    [{ resource: '*', projectID: 'prj_beta' }, 'Request body contains unsupported fields'],
  ])('rejects the update body %j without any write', async (body, error) => {
    const { app, writes } = setup();
    const response = await request(app).patch(`/api/permission/saved/psv_a${q(PROJECT)}`).send(body);
    expect(response.status).toBe(400);
    expect(response.body.error).toBe(error);
    expect(writes()).toEqual([]);
  });

  it('removes an owned row and refuses a body', async () => {
    const { app, writes } = setup();
    const response = await request(app).delete(`/api/permission/saved/psv_a${q(PROJECT)}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ id: 'psv_a', removed: true });
    expect(writes()).toEqual([expect.objectContaining({ method: 'DELETE', path: '/api/permission/saved/psv_a' })]);
    expect((await request(app).delete(`/api/permission/saved/psv_a${q(PROJECT)}`).send({ force: true })).status).toBe(400);
  });

  it('answers not found for an unknown, malformed or other-project ID without writing', async () => {
    const rows = [row('psv_a'), row('psv_beta', { projectID: 'prj_beta' })];
    const { app, writes } = setup({ rows });
    for (const id of ['psv_missing', 'psv_beta', 'bad%20id']) {
      const patched = await request(app).patch(`/api/permission/saved/${id}${q(PROJECT)}`).send({ resource: '*' });
      expect(patched.status).toBe(404);
      expect(patched.body.code).toBe('saved_approval_not_found');
      expect((await request(app).delete(`/api/permission/saved/${id}${q(PROJECT)}`)).status).toBe(404);
    }
    expect(writes()).toEqual([]);
  });

  it('maps native not-found and conflict answers to stable codes', async () => {
    const conflict = setup({ patch: () => Response.json({ _tag: 'ConflictError', message: 'dup' }, { status: 409 }) });
    const response = await request(conflict.app).patch(`/api/permission/saved/psv_a${q(PROJECT)}`).send({ resource: '*' });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'saved_approval_conflict' });
    const gone = setup({ patch: (id) => Response.json({ _tag: 'PermissionSavedNotFoundError', id, message: 'gone' }, { status: 404 }) });
    expect((await request(gone.app).patch(`/api/permission/saved/psv_a${q(PROJECT)}`).send({ resource: '*' })).body.code)
      .toBe('saved_approval_not_found');
  });

  it('fails closed when native returns a row from another project', async () => {
    const { app, writes } = setup({ savedRows: [row('psv_a'), row('psv_x', { projectID: 'prj_beta' })] });
    expect((await request(app).get(`/api/permission/saved${q(PROJECT)}`)).status).toBe(502);
    expect((await request(app).delete(`/api/permission/saved/psv_a${q(PROJECT)}`)).status).toBe(502);
    expect(writes()).toEqual([]);
  });

  it('is disabled by DEVRYAN_SAVED_APPROVALS=0 on each request', async () => {
    const { app, fetchImpl } = setup();
    vi.stubEnv('DEVRYAN_SAVED_APPROVALS', '0');
    const response = await request(app).get(`/api/permission/saved${q(PROJECT)}`);
    expect(response.status).toBe(501);
    expect(response.body).toMatchObject({ code: 'capability_unavailable', capability: 'savedApprovals' });
    expect(fetchImpl).not.toHaveBeenCalled();
    vi.stubEnv('DEVRYAN_SAVED_APPROVALS', '1');
    expect((await request(app).get(`/api/permission/saved${q(PROJECT)}`)).status).toBe(200);
  });

  it('keeps the raw browser pass-through closed for saved-approval writes', async () => {
    const { app, fetchImpl } = setup();
    expect((await request(app).patch('/api/opencode-v2/permission/saved/psv_a').send({ resource: '*' })).status).toBe(404);
    expect((await request(app).delete('/api/opencode-v2/permission/saved/psv_a')).status).toBe(404);
    expect((await request(app).get('/api/opencode-v2/permission/saved')).status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('saved approval boundaries', () => {
  it('parses only typed update fields', () => {
    expect(parseSavedApprovalUpdate({ resource: 'src/**' })).toEqual({ resource: 'src/**' });
    expect(parseSavedApprovalUpdate({ action: 'github_create_issue' })).toEqual({ action: 'github_create_issue' });
    expect(() => parseSavedApprovalUpdate(null)).toThrow('Request body must be an object');
    expect(() => parseSavedApprovalUpdate(['resource'])).toThrow('Request body must be an object');
  });

  it('compares a symlinked assignment root canonically and still refuses siblings', async () => {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-saved-approvals-'));
    try {
      const real = path.join(scratch, 'real-repo');
      await fs.mkdir(path.join(real, 'pkg'), { recursive: true });
      await fs.mkdir(path.join(scratch, 'other'));
      await fs.symlink(real, path.join(scratch, 'linked-repo'));
      const canonicalReal = await fs.realpath(real);
      const principal = { scope: 'managed', role: 'developer',
        assignments: [{ publicDirectory: '/workspace/linked', repositoryPath: path.join(scratch, 'linked-repo'), worktreeContainerPath: null }] };
      await expect(authorizeSavedApprovalDirectory(principal, path.join(canonicalReal, 'pkg'))).resolves.toBe(path.join(canonicalReal, 'pkg'));
      await expect(authorizeSavedApprovalDirectory(principal, await fs.realpath(path.join(scratch, 'other'))))
        .rejects.toMatchObject({ statusCode: 403, code: 'saved_approval_forbidden' });
      await expect(authorizeSavedApprovalDirectory({ ...principal, role: 'admin' }, '/anywhere')).resolves.toBe('/anywhere');
    } finally {
      await fs.rm(scratch, { recursive: true, force: true });
    }
  });

  it('validates native rows', () => {
    expect(() => toSavedApproval({ ...row('psv_a'), time: { created: 'x', updated: 1 } }, 'prj_alpha')).toThrow();
    expect(() => toSavedApproval({ ...row('psv_a'), action: 3 }, 'prj_alpha')).toThrow();
    expect(toSavedApproval(row('psv_a'), 'prj_alpha').anyInput).toBe(false);
  });
});
