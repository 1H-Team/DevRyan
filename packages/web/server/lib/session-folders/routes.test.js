import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import request from '../../test-supertest.js';
import { registerSessionFoldersRoutes } from './routes.js';

const FILE_NAME = 'sessions-directories.json';

const folderDocument = (label) => ({
  version: 1,
  foldersMap: {
    '/projects/example': [{ id: `folder-${label}`, name: `Folder ${label}`, sessionIds: [`session-${label}`], createdAt: 1, parentId: null }],
  },
  collapsedFolderIds: [],
  updatedAt: 1,
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

// Holds every file-system call the routes make until the test releases it, so
// the interleaving of concurrent requests is chosen by the test, not by timing.
const createScheduledFs = () => {
  const pending = [];
  const written = [];
  const hold = (kind, run) => new Promise((resolve, reject) => {
    pending.push({ kind, run: () => run().then(resolve, reject) });
  });
  const scheduledFs = {
    mkdir: (...args) => hold('mkdir', () => fs.mkdir(...args)),
    readFile: (...args) => hold('readFile', () => fs.readFile(...args)),
    writeFile: (...args) => hold('writeFile', async () => {
      written.push(args[1]);
      return fs.writeFile(...args);
    }),
    rename: (...args) => hold('rename', () => fs.rename(...args)),
    readdir: (...args) => hold('readdir', () => fs.readdir(...args)),
    stat: (...args) => hold('stat', () => fs.stat(...args)),
    rm: (...args) => hold('rm', () => fs.rm(...args)),
    unlink: (...args) => hold('unlink', () => fs.unlink(...args)),
  };

  // Every call other than a rename runs first; renames then run one at a
  // time, oldest first. A handler moves from one call to the next within
  // microtasks, so a macrotask flush after each step registers its next call.
  const drive = async (done) => {
    const started = Date.now();
    while (!done()) {
      if (Date.now() - started > 10_000) throw new Error('scheduled requests did not finish');
      await flush();
      const others = pending.filter((entry) => entry.kind !== 'rename');
      if (others.length > 0) {
        for (const entry of others) pending.splice(pending.indexOf(entry), 1);
        await Promise.allSettled(others.map((entry) => entry.run()));
        continue;
      }
      const next = pending.shift();
      if (next) {
        await next.run().catch(() => undefined);
        continue;
      }
      await flush();
    }
  };

  return { scheduledFs, written, drive };
};

const createApp = ({ dataDirectory, fsPromises = fs, onArrival }) => {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  if (onArrival) {
    app.use((_req, _res, next) => {
      onArrival();
      next();
    });
  }
  registerSessionFoldersRoutes(app, { fsPromises, path, devryanDataDir: dataDirectory });
  return app;
};

describe('session folders routes', () => {
  let dataDirectory;

  beforeEach(async () => {
    dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-session-folders-'));
  });

  afterEach(async () => {
    await fs.rm(dataDirectory, { recursive: true, force: true });
  });

  it('stores one document and reads it back', async () => {
    const app = createApp({ dataDirectory });
    const empty = await request(app).get('/api/session-folders');
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ version: 1, foldersMap: {}, collapsedFolderIds: [], updatedAt: 0 });

    const document = folderDocument('a');
    const saved = await request(app).post('/api/session-folders').send(document);
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ success: true });

    expect(JSON.parse(await fs.readFile(path.join(dataDirectory, FILE_NAME), 'utf8'))).toEqual(document);
    expect(await fs.readFile(path.join(dataDirectory, FILE_NAME), 'utf8')).toBe(JSON.stringify(document, null, 2));
    const readBack = await request(app).get('/api/session-folders');
    expect(readBack.body).toEqual(document);
    expect(await fs.readdir(dataDirectory)).toEqual([FILE_NAME]);
  });

  it('answers every concurrent save with success and keeps the last one whole', async () => {
    const count = 3;
    const { scheduledFs, written, drive } = createScheduledFs();
    let arrived = 0;
    const app = createApp({ dataDirectory, fsPromises: scheduledFs, onArrival: () => { arrived += 1; } });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const documents = Array.from({ length: count }, (_, index) => folderDocument(String(index)));
      let answered = 0;
      const responses = documents.map((document) => request(server).post('/api/session-folders').send(document)
        .then((response) => { answered += 1; return response; }));
      const started = Date.now();
      while (arrived < count) {
        if (Date.now() - started > 10_000) throw new Error(`only ${arrived} of ${count} requests reached the server`);
        await flush();
      }
      await drive(() => answered === count);
      const settled = await Promise.all(responses);

      expect(settled.map((response) => [response.status, response.body])).toEqual(
        documents.map(() => [200, { success: true }]),
      );
      const stored = await fs.readFile(path.join(dataDirectory, FILE_NAME), 'utf8');
      expect(written).toHaveLength(count);
      expect(stored).toBe(written.at(-1));
      expect(documents.map((document) => JSON.stringify(document, null, 2))).toContain(stored);
      expect(await fs.readdir(dataDirectory)).toEqual([FILE_NAME]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('removes a temporary file a crash left a day ago and keeps a fresh one', async () => {
    const stale = path.join(dataDirectory, `${FILE_NAME}.tmp-4242-${'a'.repeat(32)}`);
    const fresh = path.join(dataDirectory, `${FILE_NAME}.tmp-4243-${'b'.repeat(32)}`);
    await fs.writeFile(stale, '{"version":1', 'utf8');
    await fs.writeFile(fresh, '{"version":1', 'utf8');
    const dayAndAMinuteAgo = new Date(Date.now() - (24 * 60 + 1) * 60 * 1000);
    await fs.utimes(stale, dayAndAMinuteAgo, dayAndAMinuteAgo);

    const document = folderDocument('a');
    const saved = await request(createApp({ dataDirectory })).post('/api/session-folders').send(document);

    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ success: true });
    expect((await fs.readdir(dataDirectory)).sort()).toEqual([FILE_NAME, path.basename(fresh)].sort());
    expect(JSON.parse(await fs.readFile(path.join(dataDirectory, FILE_NAME), 'utf8'))).toEqual(document);
  });

  it('removes its temporary file and answers 500 when the replace fails', async () => {
    const failingFs = {
      ...fs,
      mkdir: fs.mkdir,
      writeFile: fs.writeFile,
      rename: async () => { throw Object.assign(new Error('rename refused'), { code: 'EACCES' }); },
      rm: fs.rm,
    };
    const app = createApp({ dataDirectory, fsPromises: failingFs });
    const response = await request(app).post('/api/session-folders').send(folderDocument('a'));
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'rename refused' });
    expect(await fs.readdir(dataDirectory)).toEqual([]);
  });
});
