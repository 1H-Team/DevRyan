import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readQaProcessSnapshot } from './process-ownership.mjs';
import { runtimeServiceOwnerPath, readRuntimeServiceOwner } from '../../packages/electron/runtime-service.mjs';

const exec = promisify(execFile);
export async function captureReleaseLocks(profile, app, sanitizer) {
  const dataDirectory = profile.env.OPENCHAMBER_DATA_DIR;
  const ownerPath = runtimeServiceOwnerPath(dataDirectory);
  const processes = await readQaProcessSnapshot();
  const tracked = app?.getCleanupEvidence().observedProcesses ?? [];
  const locks = {};
  for (const [kind, file] of [['owner', ownerPath], ['mutation', `${ownerPath}.mutation`]]) {
    let handle;
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile()) { locks[kind] = { state: 'unsafe', size: stat.size, mtimeMs: stat.mtimeMs }; continue; }
      handle = await fs.open(file, 'r');
      const bytes = Buffer.alloc(4096);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      const raw = bytes.subarray(0, bytesRead).toString('utf8');
      let parsed;
      try { parsed = JSON.parse(raw); } catch { /* Retain malformed lock evidence. */ }
      const valid = kind === 'owner' ? (await readRuntimeServiceOwner({ dataDirectory })).state === 'valid'
        : parsed && typeof parsed.ownerToken === 'string' && parsed.ownerToken.length > 0
          && Number.isInteger(parsed.pid) && parsed.pid > 0 && Number.isFinite(parsed.createdAt) && parsed.createdAt >= 0;
      const pid = Number.isSafeInteger(parsed?.pid) && parsed.pid > 0 ? parsed.pid : null;
      const process = processes.find(row => row.pid === pid);
      let name = null;
      if (process) {
        const result = await exec('ps', ['-p', String(pid), '-o', 'comm='], { timeout: 5000, maxBuffer: 4096 }).catch(error => {
          if (error.code === 1) return { stdout: '' }; throw error;
        });
        name = path.basename(result.stdout.trim()).slice(0, 128);
      }
      locks[kind] = { state: valid ? 'valid' : 'malformed', size: stat.size, mtimeMs: stat.mtimeMs,
        content: sanitizer.sanitizeText(raw.replace(/("ownerToken"\s*:\s*")[^"]*/g, '$1<redacted>'), { highEntropy: true }).slice(0, 4096),
        truncated: stat.size > bytesRead, pid, alive: process?.running === true, processName: name,
        startIdentity: process?.startIdentity ?? null,
        relation: process && tracked.some(row => row.pid === pid && row.startIdentity === process.startIdentity) ? 'tracked' : process ? 'unrelated' : 'absent' };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      locks[kind] = { state: 'missing' };
    } finally { await handle?.close(); }
  }
  return { observedAt: new Date().toISOString(), locks, process: app?.getCleanupEvidence() ?? null };
}

export const acceptableReleaseLocks = evidence => evidence && Object.values(evidence.locks).every(lock =>
  lock.state === 'missing' || lock.state === 'valid' && !lock.alive);
