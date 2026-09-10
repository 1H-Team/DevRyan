import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { cursorToolReceiptMetadata } from './cursor-tool-receipts.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const storageError = (cause) => ['ENOSPC', 'EDQUOT', 'EIO', 'EROFS', 'EACCES'].includes(cause?.code)
  ? 'storage_unavailable' : 'execution_delivery_failed';

/** Extract only execution evidence; never retain arbitrary args, outputs or
 * provider transcript paths on this private channel. Called before UI trims. */
export function cursorSessionChangeObservation(message) {
  if (!message || typeof message.call_id !== 'string' || !message.call_id
    || !['running', 'completed', 'error', 'cancelled'].includes(message.status)) return null;
  const file = message.args?.path ?? message.args?.filePath;
  return { phase: 'tool', callID: message.call_id, tool: message.name, state: message.status,
    ...(typeof file === 'string' ? { path: file } : {}), metadata: cursorToolReceiptMetadata(message) };
}

/** Durable, acknowledged provider-to-harness delivery. File bodies are read
 * one at a time; pending names are selected in bounded batches. Delivery never
 * holds the append queue or places source contents in public events/logs. */
export function createCursorChangeOutbox({ directory, deliver }) {
  const writes = new Map(), deliveries = new Map(), failures = new Map(), deleted = new Set();
  const root = (id) => path.join(directory, hash(id));
  const atomic = async (file, value) => {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
      await fs.rename(temp, file);
    } finally { await fs.rm(temp, { force: true }); }
  };
  const batch = async (id) => {
    let entries;
    try { entries = await fs.opendir(root(id)); } catch (cause) { if (cause.code === 'ENOENT') return []; throw cause; }
    const names = [];
    for await (const entry of entries) {
      if (!entry.isFile() || !/^\d{16}\.json$/.test(entry.name)) continue;
      names.push(entry.name); names.sort(); if (names.length > 64) names.pop();
    }
    return names;
  };
  const append = (input) => {
    const id = input.sessionID;
    if (deleted.has(id)) return Promise.resolve(false);
    const write = (writes.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (deleted.has(id)) return false;
      const counter = path.join(root(id), 'next.json');
      let next = 0;
      try { next = JSON.parse(await fs.readFile(counter, 'utf8')).next; } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      if (!Number.isSafeInteger(next) || next < 0) throw new Error('Invalid execution outbox');
      // A crash after the event rename but before the counter rename must not
      // overwrite the unacknowledged event on restart.
      for (;;) {
        try { await fs.access(path.join(root(id), `${String(next).padStart(16, '0')}.json`)); next++; }
        catch (cause) { if (cause.code === 'ENOENT') break; throw cause; }
      }
      await atomic(path.join(root(id), `${String(next).padStart(16, '0')}.json`), input);
      await atomic(counter, { next: next + 1 });
      return true;
    }).catch((cause) => { failures.set(id, storageError(cause)); return false; });
    writes.set(id, write);
    void write.then(() => { if (writes.get(id) === write) writes.delete(id); });
    return write;
  };
  const replay = (id) => {
    if (deliveries.has(id)) return deliveries.get(id);
    const work = (async () => {
      await writes.get(id);
      if (deleted.has(id)) return { pending: false, reasons: [] };
      const deadline = Date.now() + 20_000;
      try {
        for (;;) {
          const names = await batch(id);
          if (!names.length) return { pending: writes.has(id), reasons: failures.has(id) ? [failures.get(id)] : [] };
          for (const name of names) {
            if (Date.now() >= deadline) return { pending: true, reasons: [] };
            const file = path.join(root(id), name);
            const input = JSON.parse(await fs.readFile(file, 'utf8'));
            if (input.sessionID !== id) throw new Error('Execution outbox identity mismatch');
            let timer;
            const result = await Promise.race([deliver(input), new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('Execution receipt delivery timed out')), Math.max(1, deadline - Date.now()));
            })]).finally(() => clearTimeout(timer));
            if (result?.acknowledged !== true) throw new Error('Execution receipt not acknowledged');
            await fs.rm(file, { force: true });
          }
        }
      } catch (cause) { return { pending: false, reasons: [storageError(cause)] }; }
    })();
    deliveries.set(id, work);
    void work.then(() => { if (deliveries.get(id) === work) deliveries.delete(id); });
    return work;
  };
  return {
    append, replay,
    async has(id) {
      try { await fs.access(root(id)); return true; } catch (cause) { if (cause.code === 'ENOENT') return false; throw cause; }
    },
    async remove(id) {
      deleted.add(id); await writes.get(id); await deliveries.get(id);
      failures.delete(id); await fs.rm(root(id), { recursive: true, force: true });
    },
    async drain() { await Promise.all([...writes.values(), ...deliveries.values()]); },
  };
}
