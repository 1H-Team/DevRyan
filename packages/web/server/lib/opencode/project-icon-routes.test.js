import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerProjectIconRoutes } from './project-icon-routes.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const makeResponse = () => ({
  statusCode: 200,
  payload: null,
  headers: new Map(),
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.payload = payload; return this; },
  send(payload) { this.payload = payload; return this; },
  setHeader(name, value) { this.headers.set(name, value); },
});

describe('managed project icon routes', () => {
  it('uses the managed UUID fallback for reads and administrator mutations', async () => {
    const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-managed-icon-'));
    temporaryDirectories.push(dataDirectory);
    const projectId = '33333333-3333-4333-8333-333333333333';
    const iconDirectory = path.join(dataDirectory, 'project-icons');
    await fs.mkdir(iconDirectory, { recursive: true });
    const baseName = crypto.createHash('sha1').update(projectId).digest('hex');
    await fs.writeFile(path.join(iconDirectory, `project-${baseName}.png`), Buffer.from('icon-bytes'));

    const handlers = new Map();
    const app = {
      get(route, handler) { handlers.set(`GET ${route}`, handler); },
      put(route, handler) { handlers.set(`PUT ${route}`, handler); },
      delete(route, handler) { handlers.set(`DELETE ${route}`, handler); },
      post(route, handler) { handlers.set(`POST ${route}`, handler); },
    };
    const persistIconImage = vi.fn(async (iconImage) => ({
      id: projectId,
      label: 'Managed',
      path: '/tmp/managed',
      iconImage,
    }));
    const resolveManagedProject = vi.fn(async (req, requestedId) => {
      if (requestedId !== projectId || req.principal === 'unassigned') return null;
      const canMutate = req.principal === 'admin';
      return {
        project: { id: projectId, label: 'Managed', path: '/tmp/managed', iconImage: null },
        canMutate,
        canDiscover: canMutate,
        persistIconImage,
      };
    });
    registerProjectIconRoutes(app, {
      fsPromises: fs,
      path,
      crypto,
      openchamberDataDir: dataDirectory,
      sanitizeProjects: () => [],
      readSettingsFromDiskMigrated: async () => ({ projects: [] }),
      persistSettings: vi.fn(),
      createFsSearchRuntime: () => ({ searchFilesystemFiles: async () => [] }),
      spawn: vi.fn(),
      resolveGitBinaryForSpawn: vi.fn(),
      resolveManagedProject,
    });

    const readResponse = makeResponse();
    await handlers.get('GET /api/projects/:projectId/icon')({
      params: { projectId }, query: {}, principal: 'developer',
    }, readResponse);
    expect(readResponse.statusCode).toBe(200);
    expect(Buffer.from(readResponse.payload).toString()).toBe('icon-bytes');

    const forbiddenResponse = makeResponse();
    await handlers.get('PUT /api/projects/:projectId/icon')({
      params: { projectId },
      body: { dataUrl: `data:image/png;base64,${Buffer.from('replacement').toString('base64')}` },
      principal: 'developer',
    }, forbiddenResponse);
    expect(forbiddenResponse.statusCode).toBe(403);

    const updateResponse = makeResponse();
    await handlers.get('PUT /api/projects/:projectId/icon')({
      params: { projectId },
      body: { dataUrl: `data:image/png;base64,${Buffer.from('replacement').toString('base64')}` },
      principal: 'admin',
    }, updateResponse);
    expect(updateResponse.statusCode).toBe(200);
    expect(persistIconImage).toHaveBeenCalledWith(expect.objectContaining({ mime: 'image/png', source: 'custom' }));

    const missingResponse = makeResponse();
    await handlers.get('GET /api/projects/:projectId/icon')({
      params: { projectId }, query: {}, principal: 'unassigned',
    }, missingResponse);
    expect(missingResponse.statusCode).toBe(404);
  });
});
