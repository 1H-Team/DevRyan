import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { registerGitRoutes } from './routes.js';

const execFileAsync = promisify(execFile);
const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const makeApp = () => {
  const app = express();
  app.use(express.json());
  registerGitRoutes(app);
  return app;
};

const createRepository = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'devryan-git-routes-'));
  tempDirs.push(directory);
  await execFileAsync('git', ['init'], { cwd: directory });
  return directory;
};

const expectNonRepositoryResponse = (body) => {
  expect(body).toEqual({
    isGitRepository: false,
    files: [],
    branch: null,
    ahead: 0,
    behind: 0,
  });
};

describe('Git project context routes', () => {
  it('serves /api/git/check and /api/git/status for the exact repository root', async () => {
    const directory = await createRepository();
    const app = makeApp();

    const check = await request(app)
      .get('/api/git/check')
      .query({ directory })
      .expect(200);
    expect(check.body).toEqual({ isGitRepository: true });

    const status = await request(app)
      .get('/api/git/status')
      .query({ directory })
      .expect(200);
    expect(status.body).toMatchObject({ files: [], ahead: 0, behind: 0 });
  });

  it('keeps check and status aligned for a nested non-repository project', async () => {
    const repository = await createRepository();
    const nestedProject = join(repository, 'nested-project');
    await mkdir(nestedProject);
    const app = makeApp();

    const check = await request(app)
      .get('/api/git/check')
      .query({ directory: nestedProject })
      .expect(200);
    expect(check.body).toEqual({ isGitRepository: false });

    const status = await request(app)
      .get('/api/git/status')
      .query({ directory: nestedProject })
      .expect(200);
    expectNonRepositoryResponse(status.body);
  });

  it('keeps check and status aligned for a missing project directory', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'devryan-git-routes-missing-'));
    tempDirs.push(parent);
    const missing = join(parent, 'missing');
    const app = makeApp();

    const check = await request(app)
      .get('/api/git/check')
      .query({ directory: missing })
      .expect(200);
    expect(check.body).toEqual({ isGitRepository: false });

    const status = await request(app)
      .get('/api/git/status')
      .query({ directory: missing })
      .expect(200);
    expectNonRepositoryResponse(status.body);
  });
});
