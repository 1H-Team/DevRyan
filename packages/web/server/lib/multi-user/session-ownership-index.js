import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const FILE_VERSION = 1;

const normalizeRow = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sessionId = String(value.session_id || '').trim();
  const userId = String(value.user_id || '').trim();
  const projectId = String(value.project_id || '').trim();
  const branchName = String(value.branch_name || '').trim();
  if (!sessionId || !userId || !projectId || !branchName) return null;
  return {
    session_id: sessionId,
    user_id: userId,
    project_id: projectId,
    branch_name: branchName,
    public_directory: String(value.public_directory || '').trim() || null,
    created_at: typeof value.created_at === 'string' ? value.created_at : null,
    archived_at: typeof value.archived_at === 'string' ? value.archived_at : null,
  };
};

export async function createSessionOwnershipIndex({ dataDirectory }) {
  const directory = path.resolve(dataDirectory, 'multi-user');
  const filePath = path.join(directory, 'session-ownership.json');
  const rows = new Map();
  let writeTail = Promise.resolve();

  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stored = await fs.readFile(filePath, 'utf8').then(JSON.parse).catch(() => null);
  for (const value of Array.isArray(stored?.rows) ? stored.rows : []) {
    const row = normalizeRow(value);
    if (row) rows.set(row.session_id, row);
  }

  const persistNow = async () => {
    const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const payload = `${JSON.stringify({ version: FILE_VERSION, rows: [...rows.values()] }, null, 2)}\n`;
    await fs.writeFile(tempPath, payload, { encoding: 'utf8', mode: 0o600 });
    await fs.chmod(tempPath, 0o600);
    await fs.rename(tempPath, filePath);
    await fs.chmod(filePath, 0o600);
  };

  const persist = () => {
    const write = writeTail.catch(() => undefined).then(persistNow);
    writeTail = write;
    return write;
  };

  return {
    get(sessionId) {
      return rows.get(String(sessionId || '').trim()) || null;
    },
    list() {
      return [...rows.values()];
    },
    async set(value) {
      const row = normalizeRow(value);
      if (!row) throw new TypeError('Session ownership row is invalid');
      rows.set(row.session_id, row);
      await persist();
      return row;
    },
    async delete(sessionId) {
      const deleted = rows.delete(String(sessionId || '').trim());
      if (deleted) await persist();
      return deleted;
    },
    async archiveWhere(predicate, archivedAt = new Date().toISOString()) {
      if (typeof predicate !== 'function') throw new TypeError('Session ownership predicate is required');
      let changed = 0;
      for (const [sessionId, row] of rows) {
        if (row.archived_at || !predicate(row)) continue;
        rows.set(sessionId, { ...row, archived_at: archivedAt });
        changed += 1;
      }
      if (changed > 0) await persist();
      return changed;
    },
    async rebuild(values) {
      const next = new Map();
      for (const value of Array.isArray(values) ? values : []) {
        const row = normalizeRow(value);
        if (row) next.set(row.session_id, row);
      }
      rows.clear();
      for (const [sessionId, row] of next) rows.set(sessionId, row);
      await persist();
    },
    async drain() {
      await writeTail;
    },
    filePath,
  };
}
