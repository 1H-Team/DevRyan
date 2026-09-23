import fs from 'node:fs/promises';
import path from 'node:path';

// New immutable objects are linked into `<root>/objects` with their data
// already synced. Their directory entries become durable before the next
// ledger commit under that root can reference them: one directory sync per
// commit instead of one per object.
const pending = new Set();
const running = new Map();
const syncStarted = new Map();

export const markObjectDirectoryPending = (directory) => { pending.add(directory); };

// An existing object may have been linked by another process, or by one that
// exited before its commit; neither marked it here. A link changes the
// object's ctime, so anything linked since this process's last directory sync
// began (or since it started) is treated as pending. The slack covers coarse
// filesystem timestamps and small clock steps; it costs at most one extra sync.
const CTIME_SLACK_MS = 1_000;
export const markObjectIfUnsynced = (directory, ctimeMs) => {
  if (ctimeMs >= (syncStarted.get(directory) ?? 0) - CTIME_SLACK_MS) pending.add(directory);
};

export async function syncPendingObjectDirectory(root) {
  const directory = path.join(root, 'objects');
  for (;;) {
    // A sync already in flight may predate this caller's objects: wait for it,
    // then re-check instead of committing while it is still running.
    const current = running.get(directory);
    if (current) { await current.catch(() => {}); continue; }
    if (!pending.has(directory)) return;
    pending.delete(directory);
    syncStarted.set(directory, Date.now());
    const work = (async () => {
      const handle = await fs.open(directory, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
    })();
    running.set(directory, work);
    try { await work; return; }
    catch (error) { pending.add(directory); throw error; }
    finally { if (running.get(directory) === work) running.delete(directory); }
  }
}
