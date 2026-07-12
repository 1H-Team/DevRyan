import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from '../../test-supertest.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile, access } from 'fs/promises';

import { registerFsRoutes } from './routes.js';

const createApp = ({ workspace, configRoot, spawn = vi.fn() }) => {
  const app = express();
  app.use(express.json());
  let jobCounter = 0;
  registerFsRoutes(app, {
    os,
    path,
    fsPromises: fs.promises,
    spawn,
    crypto: { randomUUID: () => `test-job-id-${++jobCounter}` },
    normalizeDirectoryPath: (value) => value,
    resolveProjectDirectory: async () => ({ directory: workspace }),
    buildAugmentedPath: () => process.env.PATH || '',
    resolveGitBinaryForSpawn: () => 'git',
    openchamberUserConfigRoot: configRoot,
  });
  return app;
};

const createDirectoryAwareApp = ({ workspace, configRoot, alternateWorkspace }) => {
  const app = express();
  app.use(express.json());
  registerFsRoutes(app, {
    os,
    path,
    fsPromises: fs.promises,
    spawn: vi.fn(),
    crypto: { randomUUID: () => 'test-job-id' },
    normalizeDirectoryPath: (value) => value,
    resolveProjectDirectory: async (req) => {
      const requested = typeof req.query?.directory === 'string'
        ? req.query.directory
        : (typeof req.body?.directory === 'string' ? req.body.directory : '');
      if (requested === alternateWorkspace) {
        return { directory: alternateWorkspace };
      }
      return { directory: workspace };
    },
    buildAugmentedPath: () => process.env.PATH || '',
    resolveGitBinaryForSpawn: () => 'git',
    openchamberUserConfigRoot: configRoot,
  });
  return app;
};

const createExecSpawn = ({ exitCode = 0, stdout = '', stderr = '', delayMs = 0 } = {}) => {
  return vi.fn(() => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn(() => {
      child.emit('close', null, 'SIGKILL');
    });

    setTimeout(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', exitCode, null);
    }, delayMs);

    return child;
  });
};

describe('fs mutation routes', () => {
  let workspace = '';
  let outsideDir = '';
  let configRoot = '';
  let cleanup = [];
  let originalGitReadCacheTtl;

  beforeEach(async () => {
    originalGitReadCacheTtl = process.env.OPENCHAMBER_GIT_READ_CACHE_TTL_MS;
    delete process.env.OPENCHAMBER_GIT_READ_CACHE_TTL_MS;
    workspace = await mkdtemp(path.join(os.tmpdir(), 'devryan-fs-workspace-'));
    outsideDir = await mkdtemp(path.join(os.tmpdir(), 'devryan-fs-outside-'));
    configRoot = await mkdtemp(path.join(os.tmpdir(), 'devryan-fs-config-'));
    cleanup = [workspace, outsideDir, configRoot];
  });

  afterEach(async () => {
    if (originalGitReadCacheTtl === undefined) {
      delete process.env.OPENCHAMBER_GIT_READ_CACHE_TTL_MS;
    } else {
      process.env.OPENCHAMBER_GIT_READ_CACHE_TTL_MS = originalGitReadCacheTtl;
    }
    await Promise.all(cleanup.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('rejects default mkdir outside the workspace', async () => {
    const target = path.join(outsideDir, 'nested');
    const response = await request(createApp({ workspace, configRoot }))
      .post('/api/fs/mkdir')
      .send({ path: target });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/outside of active workspace/i);
    await expect(access(target)).rejects.toThrow();
  });

  it('rejects default mkdir through a workspace symlink to outside', async () => {
    const linkPath = path.join(workspace, 'escape-link');
    await symlink(outsideDir, linkPath);
    const target = path.join(linkPath, 'nested');

    const response = await request(createApp({ workspace, configRoot }))
      .post('/api/fs/mkdir')
      .send({ path: target });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Access denied');
    await expect(access(target)).rejects.toThrow();
  });

  it('allows allowOutsideWorkspace mkdir for direct outside paths', async () => {
    const target = path.join(outsideDir, 'allowed-outside');
    const response = await request(createApp({ workspace, configRoot }))
      .post('/api/fs/mkdir')
      .send({ path: target, allowOutsideWorkspace: true });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    const canonicalTarget = await fs.promises.realpath(target);
    expect(response.body.path).toBe(canonicalTarget);
    const stat = await fs.promises.stat(canonicalTarget);
    expect(stat.isDirectory()).toBe(true);
  });

  it('rejects allowOutsideWorkspace mkdir through workspace symlink prefixes', async () => {
    const linkPath = path.join(workspace, 'escape-link');
    await symlink(outsideDir, linkPath);
    const target = path.join(linkPath, 'blocked-outside');

    const response = await request(createApp({ workspace, configRoot }))
      .post('/api/fs/mkdir')
      .send({ path: target, allowOutsideWorkspace: true });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Symlink paths are not allowed');
    await expect(access(target)).rejects.toThrow();
  });

  it('rejects write/delete/rename through workspace symlinks without mutating outside files', async () => {
    const outsideFile = path.join(outsideDir, 'victim.txt');
    await writeFile(outsideFile, 'untouched', 'utf8');

    const linkDir = path.join(workspace, 'link-dir');
    await symlink(outsideDir, linkDir);

    const writeTarget = path.join(linkDir, 'written.txt');
    const deleteTarget = path.join(linkDir, 'victim.txt');
    const renameOld = path.join(linkDir, 'victim.txt');
    const renameNew = path.join(linkDir, 'renamed.txt');

    const app = createApp({ workspace, configRoot });

    const writeResponse = await request(app)
      .post('/api/fs/write')
      .send({ path: writeTarget, content: 'escaped' });
    expect(writeResponse.status).toBe(403);

    const deleteResponse = await request(app)
      .post('/api/fs/delete')
      .send({ path: deleteTarget });
    expect(deleteResponse.status).toBe(403);

    const renameResponse = await request(app)
      .post('/api/fs/rename')
      .send({ oldPath: renameOld, newPath: renameNew });
    expect(renameResponse.status).toBe(403);

    expect(await readFile(outsideFile, 'utf8')).toBe('untouched');
    await expect(access(writeTarget)).rejects.toThrow();
    await expect(access(renameNew)).rejects.toThrow();
  });

  it('rejects exec cwd through workspace symlinks before spawning', async () => {
    const linkPath = path.join(workspace, 'exec-link');
    await symlink(outsideDir, linkPath);
    const spawn = vi.fn();

    const response = await request(createApp({ workspace, configRoot, spawn }))
      .post('/api/fs/exec')
      .send({ cwd: linkPath, commands: ['echo hi'] });

    expect(response.status).toBe(403);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('allows config-root mutation', async () => {
    await mkdir(configRoot, { recursive: true });
    const configFile = path.join(configRoot, 'settings.json');
    const content = '{"enabled":true}';

    const response = await request(createApp({ workspace, configRoot }))
      .post('/api/fs/write')
      .send({ path: configFile, content });

    expect(response.status).toBe(200);
    expect(await readFile(configFile, 'utf8')).toBe(content);
  });

  it('returns an optional stat miss without logging failed-resource statuses', async () => {
    const missingFile = path.join(workspace, 'missing.ts');

    const response = await request(createApp({ workspace, configRoot }))
      .get('/api/fs/stat')
      .query({ path: missingFile, optional: 'true' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      path: missingFile,
      exists: false,
      isFile: false,
      size: 0,
    });
  });

  it('keeps non-optional stat misses as 404 errors', async () => {
    const missingFile = path.join(workspace, 'missing.ts');

    const response = await request(createApp({ workspace, configRoot }))
      .get('/api/fs/stat')
      .query({ path: missingFile });

    expect(response.status).toBe(404);
  });

  it('returns an optional stat miss for paths outside the active workspace', async () => {
    const outsideFile = path.join(outsideDir, 'outside.ts');

    const response = await request(createApp({ workspace, configRoot }))
      .get('/api/fs/stat')
      .query({ path: outsideFile, optional: 'true' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      path: outsideFile,
      exists: false,
      isFile: false,
      size: 0,
    });
  });

  it('uses the request directory when reading and statting files', async () => {
    const alternateWorkspace = await mkdtemp(path.join(os.tmpdir(), 'devryan-fs-alt-workspace-'));
    cleanup.push(alternateWorkspace);
    const target = path.join(alternateWorkspace, 'selected.txt');
    await writeFile(target, 'from alternate', 'utf8');
    const app = createDirectoryAwareApp({ workspace, configRoot, alternateWorkspace });

    const readResponse = await request(app)
      .get('/api/fs/read')
      .query({ path: target, directory: alternateWorkspace });
    expect(readResponse.status).toBe(200);
    expect(readResponse.text).toBe('from alternate');

    const statResponse = await request(app)
      .get('/api/fs/stat')
      .query({ path: target, directory: alternateWorkspace });
    expect(statResponse.status).toBe(200);
    expect(statResponse.body.path).toBe(await fs.promises.realpath(target));
    expect(statResponse.body.exists).toBe(true);
  });

  it('serves raw downloads with RFC 5987 filenames for non-latin names', async () => {
    const fileName = 'résumé-資料.txt';
    const target = path.join(workspace, fileName);
    await writeFile(target, 'download me', 'utf8');

    const response = await request(createApp({ workspace, configRoot }))
      .get('/api/fs/raw')
      .query({ path: target, download: 'true' });

    expect(response.status).toBe(200);
    expect(response.headers['content-disposition']).toContain('attachment;');
    expect(response.headers['content-disposition']).toContain('filename="resume-.txt"');
    expect(response.headers['content-disposition']).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9-%E8%B3%87%E6%96%99.txt");
  });

  it('caches repeated foreground allowlisted git read commands by cwd', async () => {
    const spawn = createExecSpawn({ stdout: path.join(workspace, '.git') });
    const app = createApp({ workspace, configRoot, spawn });

    const first = await request(app)
      .post('/api/fs/exec')
      .send({ cwd: workspace, commands: ['git rev-parse --absolute-git-dir'] });
    const second = await request(app)
      .post('/api/fs/exec')
      .send({ cwd: workspace, commands: ['git rev-parse --absolute-git-dir'] });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.results[0].stdout).toBe(path.join(workspace, '.git'));
    expect(second.body.results[0].stdout).toBe(path.join(workspace, '.git'));
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('keeps separate git read cache entries per cwd', async () => {
    const firstDir = path.join(workspace, 'one');
    const secondDir = path.join(workspace, 'two');
    await mkdir(firstDir);
    await mkdir(secondDir);
    const spawn = createExecSpawn({ stdout: path.join(workspace, '.git') });
    const app = createApp({ workspace, configRoot, spawn });

    await request(app)
      .post('/api/fs/exec')
      .send({ cwd: firstDir, commands: ['git rev-parse --absolute-git-dir'] });
    await request(app)
      .post('/api/fs/exec')
      .send({ cwd: secondDir, commands: ['git rev-parse --absolute-git-dir'] });

    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('does not cache failed git read commands', async () => {
    const spawn = createExecSpawn({ exitCode: 1, stderr: 'not a git repo' });
    const app = createApp({ workspace, configRoot, spawn });

    await request(app)
      .post('/api/fs/exec')
      .send({ cwd: workspace, commands: ['git rev-parse --absolute-git-dir'] });
    await request(app)
      .post('/api/fs/exec')
      .send({ cwd: workspace, commands: ['git rev-parse --absolute-git-dir'] });

    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('does not cache non-allowlisted commands', async () => {
    const spawn = createExecSpawn({ stdout: 'M package.json' });
    const app = createApp({ workspace, configRoot, spawn });

    await request(app)
      .post('/api/fs/exec')
      .send({ cwd: workspace, commands: ['git status --porcelain'] });
    await request(app)
      .post('/api/fs/exec')
      .send({ cwd: workspace, commands: ['git status --porcelain'] });

    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('disables git read caching when the TTL is zero', async () => {
    process.env.OPENCHAMBER_GIT_READ_CACHE_TTL_MS = '0';
    const spawn = createExecSpawn({ stdout: path.join(workspace, '.git') });
    const app = createApp({ workspace, configRoot, spawn });

    await request(app)
      .post('/api/fs/exec')
      .send({ cwd: workspace, commands: ['git rev-parse --absolute-git-dir'] });
    await request(app)
      .post('/api/fs/exec')
      .send({ cwd: workspace, commands: ['git rev-parse --absolute-git-dir'] });

    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('dedupes concurrent identical allowlisted git reads', async () => {
    const spawn = createExecSpawn({ stdout: path.join(workspace, '.git'), delayMs: 20 });
    const app = createApp({ workspace, configRoot, spawn });

    const [first, second] = await Promise.all([
      request(app)
        .post('/api/fs/exec')
        .send({ cwd: workspace, commands: ['git rev-parse --absolute-git-dir'] }),
      request(app)
        .post('/api/fs/exec')
        .send({ cwd: workspace, commands: ['git rev-parse --absolute-git-dir'] }),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
