import { describe, expect, it, vi } from 'vitest';

import {
  createDotenvVisibilityMiddleware,
  filterProtectedDotenvReferences,
  isProtectedDotenvPath,
  shouldHideProtectedDotenv,
} from './dotenv-visibility.js';

const restrictedPrincipal = (role = 'developer') => ({ scope: 'managed', role });

const createResponse = () => ({
  statusCode: 200,
  payload: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.payload = payload;
    return this;
  },
});

describe('managed dotenv visibility', () => {
  it('recognizes dotenv secret variants without matching ordinary env-named files', () => {
    expect(isProtectedDotenvPath('.env')).toBe(true);
    expect(isProtectedDotenvPath('/repo/.env.local')).toBe(true);
    expect(isProtectedDotenvPath('C:\\repo\\.ENV.development.local')).toBe(true);
    expect(isProtectedDotenvPath('/repo/src/local.env')).toBe(false);
    expect(isProtectedDotenvPath('/repo/environment.ts')).toBe(false);
  });

  it('applies only to managed developer roles', () => {
    expect(shouldHideProtectedDotenv(restrictedPrincipal('developer'))).toBe(true);
    expect(shouldHideProtectedDotenv(restrictedPrincipal('senior_developer'))).toBe(true);
    expect(shouldHideProtectedDotenv(restrictedPrincipal('admin'))).toBe(false);
    expect(shouldHideProtectedDotenv({ scope: 'local', role: 'admin' })).toBe(false);
  });

  it('removes dotenv entries and keyed diff stats from nested file responses', () => {
    const filtered = filterProtectedDotenvReferences({
      entries: [
        { name: '.env', path: '/repo/.env', type: 'file' },
        { name: 'app.ts', path: '/repo/src/app.ts', type: 'file' },
      ],
      files: [
        { path: '.env.local', index: 'M' },
        { path: 'src/app.ts', index: 'M' },
      ],
      diffStats: {
        '.env.local': { insertions: 1, deletions: 1 },
        'src/app.ts': { insertions: 2, deletions: 0 },
      },
    });

    expect(filtered).toEqual({
      entries: [{ name: 'app.ts', path: '/repo/src/app.ts', type: 'file' }],
      files: [{ path: 'src/app.ts', index: 'M' }],
      diffStats: { 'src/app.ts': { insertions: 2, deletions: 0 } },
    });
  });

  it('returns not found for direct developer access and leaves administrators unchanged', () => {
    const middleware = createDotenvVisibilityMiddleware();
    const developerResponse = createResponse();
    const developerNext = vi.fn();
    middleware({
      originalUrl: '/api/git/file-diff?path=.env.local',
      query: { path: '.env.local' },
      principal: restrictedPrincipal(),
    }, developerResponse, developerNext);
    expect(developerResponse.statusCode).toBe(404);
    expect(developerResponse.payload).toEqual({ error: 'File not found' });
    expect(developerNext).not.toHaveBeenCalled();

    const adminResponse = createResponse();
    const adminNext = vi.fn();
    middleware({
      originalUrl: '/api/git/file-diff?path=.env.local',
      query: { path: '.env.local' },
      principal: restrictedPrincipal('admin'),
    }, adminResponse, adminNext);
    expect(adminNext).toHaveBeenCalledOnce();
  });

  it('filters Git status JSON for senior developers', () => {
    const middleware = createDotenvVisibilityMiddleware();
    const response = createResponse();
    const payload = {
      files: [{ path: '.env', index: 'M' }, { path: 'README.md', index: 'M' }],
      diffStats: { '.env': { insertions: 1, deletions: 0 }, 'README.md': { insertions: 1, deletions: 0 } },
      isClean: false,
    };

    middleware({
      originalUrl: '/api/git/status?directory=/repo',
      principal: restrictedPrincipal('senior_developer'),
    }, response, () => response.json(payload));

    expect(response.payload).toEqual({
      files: [{ path: 'README.md', index: 'M' }],
      diffStats: { 'README.md': { insertions: 1, deletions: 0 } },
      isClean: false,
    });
  });

  it('does not expose a dirty-worktree indicator when dotenv is the only change', () => {
    const middleware = createDotenvVisibilityMiddleware();
    const response = createResponse();
    middleware({
      originalUrl: '/api/git/status?directory=/repo',
      principal: restrictedPrincipal(),
    }, response, () => response.json({
      files: [{ path: '.env.local', index: 'M' }],
      diffStats: { '.env.local': { insertions: 1, deletions: 0 } },
      isClean: false,
    }));

    expect(response.payload).toEqual({ files: [], diffStats: {}, isClean: true });
  });
});
