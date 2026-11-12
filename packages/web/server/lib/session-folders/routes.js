import crypto from 'node:crypto';
import { cleanupStaleAtomicFiles } from '@devryan/harness-runtime';

const MAX_BODY_BYTES = 4 * 1024 * 1024;

export const registerSessionFoldersRoutes = (app, dependencies) => {
  const {
    fsPromises,
    path,
    devryanDataDir,
  } = dependencies;

  const filePath = path.join(devryanDataDir, 'sessions-directories.json');

  const ensureDir = async () => {
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  };

  // Saves run one at a time in arrival order, each through its own temporary
  // file, so concurrent saves neither consume each other's file nor finish
  // out of order. A failed save removes its temporary file; one a crash left
  // behind is removed by a later save once it is a day old. That cleanup is
  // best effort: a file it could not remove is tried again on the next save.
  let writeLock = Promise.resolve();
  const persist = (serialized) => {
    const run = async () => {
      await ensureDir();
      await cleanupStaleAtomicFiles(filePath, { fs: fsPromises }).catch(() => undefined);
      const tmp = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
      try {
        await fsPromises.writeFile(tmp, serialized, 'utf8');
        await fsPromises.rename(tmp, filePath);
      } catch (error) {
        await fsPromises.rm(tmp, { force: true }).catch(() => undefined);
        throw error;
      }
    };
    const result = writeLock.then(run, run);
    writeLock = result.catch(() => undefined);
    return result;
  };

  app.get('/api/session-folders', async (_req, res) => {
    try {
      const raw = await fsPromises.readFile(filePath, 'utf8').catch((error) => {
        if (error && error.code === 'ENOENT') return null;
        throw error;
      });
      if (!raw) {
        return res.json({ version: 1, foldersMap: {}, collapsedFolderIds: [], updatedAt: 0 });
      }
      try {
        const parsed = JSON.parse(raw);
        return res.json(parsed);
      } catch {
        return res.json({ version: 1, foldersMap: {}, collapsedFolderIds: [], updatedAt: 0 });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to read session folders';
      return res.status(500).json({ error: message });
    }
  });

  app.post('/api/session-folders', async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'Body must be an object' });
    }
    const serialized = JSON.stringify(body, null, 2);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_BODY_BYTES) {
      return res.status(413).json({ error: 'Payload too large' });
    }
    try {
      await persist(serialized);
      return res.json({ success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to write session folders';
      return res.status(500).json({ error: message });
    }
  });
};
