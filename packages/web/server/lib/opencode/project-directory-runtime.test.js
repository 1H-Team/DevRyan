import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createProjectDirectoryRuntime } from './project-directory-runtime.js';

const createRuntime = (overrides = {}) => {
  const fsPromises = {
    stat: vi.fn(async () => ({ isDirectory: () => true })),
    realpath: vi.fn(async (value) => value),
    ...overrides.fsPromises,
  };

  return {
    fsPromises,
    runtime: createProjectDirectoryRuntime({
      fsPromises,
      path,
      normalizeDirectoryPath: (value) => value,
      readSettingsFromDiskMigrated: async () => ({}),
      getReadSettingsFromDiskMigrated: undefined,
      sanitizeProjects: (projects) => projects,
      ...overrides.dependencies,
    }),
  };
};

describe('createProjectDirectoryRuntime', () => {
  it('canonicalizes validated directories to their filesystem realpath', async () => {
    const aliasPath = path.join(path.sep, 'tmp', 'devryan-project');
    const canonicalPath = path.join(path.sep, 'private', 'tmp', 'devryan-project');
    const { fsPromises, runtime } = createRuntime({
      fsPromises: {
        realpath: vi.fn(async () => canonicalPath),
      },
    });

    const result = await runtime.validateDirectoryPath(aliasPath);

    expect(result).toEqual({ ok: true, directory: canonicalPath });
    expect(fsPromises.stat).toHaveBeenCalledWith(path.resolve(aliasPath));
    expect(fsPromises.realpath).toHaveBeenCalledWith(path.resolve(aliasPath));
  });

  it('resolves header directories through the same canonical validation path', async () => {
    const aliasPath = path.join(path.sep, 'tmp', 'devryan-project');
    const canonicalPath = path.join(path.sep, 'private', 'tmp', 'devryan-project');
    const { runtime } = createRuntime({
      fsPromises: {
        realpath: vi.fn(async () => canonicalPath),
      },
    });

    const result = await runtime.resolveProjectDirectory({
      get: (name) => (name === 'x-opencode-directory' ? aliasPath : null),
      query: {},
    });

    expect(result).toEqual({ directory: canonicalPath, error: null });
  });

  it('keeps non-admin managed principals inside their assignments', async () => {
    const { runtime } = createRuntime();
    const requested = path.join(path.sep, 'somewhere', 'else');

    const result = await runtime.resolveProjectDirectory({
      get: () => requested,
      query: {},
      principal: { scope: 'managed', role: 'developer', assignments: [] },
    });

    expect(result).toEqual({ directory: null, error: 'Directory is outside your assigned workspace' });

    const optional = await runtime.resolveOptionalProjectDirectory({
      get: () => requested,
      query: {},
      principal: { scope: 'managed', role: 'developer', assignments: [] },
    });

    expect(optional).toEqual({ directory: null, error: 'Directory is outside your assigned workspace' });
  });

  it('lets managed admins resolve directories outside their assignments', async () => {
    const { runtime } = createRuntime();
    const requested = path.join(path.sep, 'somewhere', 'else');

    const result = await runtime.resolveProjectDirectory({
      get: () => requested,
      query: {},
      principal: { scope: 'managed', role: 'admin', assignments: [] },
    });

    expect(result).toEqual({ directory: requested, error: null });

    const optional = await runtime.resolveOptionalProjectDirectory({
      get: () => requested,
      query: {},
      principal: { scope: 'managed', role: 'admin', assignments: [] },
    });

    expect(optional).toEqual({ directory: requested, error: null });
  });

  it('still resolves a matching assignment for managed admins', async () => {
    const { runtime } = createRuntime();
    const repositoryPath = path.join(path.sep, 'Users', 'example', 'repo');

    const result = await runtime.resolveProjectDirectory({
      get: () => '/projects/project-1/main',
      query: {},
      principal: {
        scope: 'managed',
        role: 'admin',
        assignments: [{
          projectId: 'project-1',
          publicDirectory: '/projects/project-1/main',
          repositoryPath,
          isDefault: true,
        }],
      },
    });

    expect(result).toEqual({ directory: repositoryPath, error: null });
  });

  it.each(['developer', 'admin'])('keeps a missing assigned directory usable for managed %s principals', async (role) => {
    const repositoryPath = path.join(path.sep, 'managed', 'worktrees', role, 'main');
    const { fsPromises, runtime } = createRuntime({
      fsPromises: {
        stat: vi.fn(async () => {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        }),
      },
    });
    const principal = {
      scope: 'managed',
      role,
      assignments: [{
        projectId: 'project-1',
        publicDirectory: '/projects/project-1/main',
        repositoryPath,
        isDefault: true,
      }],
    };

    const required = await runtime.resolveProjectDirectory({
      get: () => '/projects/project-1/main',
      query: {},
      principal,
    });
    const optional = await runtime.resolveOptionalProjectDirectory({
      get: () => '/projects/project-1/main',
      query: {},
      principal,
    });

    expect(required).toEqual({ directory: repositoryPath, error: null });
    expect(optional).toEqual({ directory: repositoryPath, error: null });
    expect(fsPromises.realpath).not.toHaveBeenCalled();
  });
});
