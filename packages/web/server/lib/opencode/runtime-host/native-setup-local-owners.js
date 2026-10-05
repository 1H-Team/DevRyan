import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createSessionVault, validateSetupOwners } from '../../multi-user/vault.js';
import { withCrossProcessFileLock } from '../../../../../harness-runtime/lib/atomic-file.js';
import { processIdentity } from './bundle-rollback-intent.js';

const fail = () => Object.assign(new Error('native_setup_local_owner_invalid'), { code: 'native_setup_local_owner_invalid', status: 503 });
const sync = async file => { const handle = await fs.open(file, 'r'); try { await handle.sync(); } finally { await handle.close(); } };
const existing = async file => {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || await fs.realpath(file) !== file) throw fail();
    return stat;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};

// A lock's pid is its holder unless a process started after the lock was written now
// owns that pid (a crashed start's pid reused, possibly by another uid). Lock age proves
// nothing: a live holder's createdAt ages across a system sleep. lstart is read in UTC
// and has 1 s resolution; the tolerance absorbs it and small clock steps.
const PID_REUSE_TOLERANCE_MS = 2_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const processStartedAt = pid => {
  const current = processIdentity(pid, (command, args, options) => spawnSync(command, args, { ...options, env: { ...options.env, TZ: 'UTC0' } }));
  if (!current) return null;
  const match = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(current.startIdentity);
  if (!match || !MONTHS.includes(match[1])) throw new Error('process start unreadable');
  return Date.UTC(+match[6], MONTHS.indexOf(match[1]), +match[2], +match[3], +match[4], +match[5]);
};
/** Reclaims a lock whose holder pid was reused or no longer exists; a live original
 * holder, or one whose start time cannot be read, keeps its lock. Returns whether the
 * lock was (or was meanwhile) replaced, so a timed-out waiter knows to retry once. */
export const reclaimReusedLock = async (lock, startedAt = processStartedAt) => {
  let stat, raw;
  try { stat = await fs.lstat(lock); raw = await fs.readFile(lock, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  let owner; try { owner = JSON.parse(raw); } catch {}
  // A malformed lock is the shared lock's own (mtime) reclaim.
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0 || !Number.isFinite(owner.createdAt)) return false;
  let started; try { started = startedAt(owner.pid); } catch { return false; }
  if (started !== null && !(started > owner.createdAt + PID_REUSE_TOLERANCE_MS)) return false;
  // The ps probe blocked; a lock another start re-created meanwhile is left to the wait.
  try { const current = await fs.lstat(lock); if (current.ino !== stat.ino || current.dev !== stat.dev) return true; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  // Rename is the atomic claim: only one start takes the file. A start that took a lock
  // another start re-created after reclaiming the same one hands it back.
  const aside = `${lock}.stale-${process.pid}-${crypto.randomUUID()}`;
  try { await fs.rename(lock, aside); } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  try {
    const taken = await fs.lstat(aside);
    if (taken.ino !== stat.ino || taken.dev !== stat.dev || await fs.readFile(aside, 'utf8') !== raw) {
      await fs.link(aside, lock).catch(error => { if (error.code !== 'EEXIST') throw error; });
    }
  } finally { await fs.rm(aside, { force: true }); }
  return true;
};

export async function captureNativeSetupOwners(dataDirectory) {
  const [key, vault] = await Promise.all(['multi-user-vault.key', 'multi-user-vault.json'].map(name => existing(path.join(dataDirectory, name))));
  if (!key && !vault) return { localOwners: {} };
  if (!key || !vault) throw fail();
  const owner = await createSessionVault({ dataDirectory });
  return { localOwners: owner.captureSetupOwners() };
}

/** Runs before the application constructs its account/Bots owners or mints sessions.
 * One-shot: the app may later replace (rememberOwner) or remove the restored owner,
 * so the snapshot is consumed by an atomic rename once the vault holds it durably.
 * A start that dies before the rename re-runs against identical owners, which passes.
 * The foreground app and the runtime service can both be a first start, so read,
 * restore, drain and consume run under one lock and a vanished snapshot was consumed. */
export async function restoreNativeSetupOwners(dataDirectory) {
  const file = path.join(dataDirectory, 'native-setup-local-owners.json');
  if (!await existing(file)) return;
  const lock = path.join(dataDirectory, 'native-setup-local-owners.lock');
  const restore = async () => {
    const stat = await existing(file);
    if (!stat) return;
    if (stat.size > 16384) throw fail();
    let text;
    try { text = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const value = JSON.parse(text);
    if (!value || value.schema !== 1 || Object.keys(value).some(key => !['schema', 'owners'].includes(key))) throw fail();
    const owners = validateSetupOwners(value.owners);
    if (Object.keys(owners).length) {
      const vault = await createSessionVault({ dataDirectory });
      // The bundle vault starts without owners and this runs before any owner, so a
      // different owner means 2.0.0 restored this snapshot without consuming it and
      // the app later replaced it. Consume it rather than re-apply or refuse.
      const replaced = Object.entries(owners).some(([key, owner]) => {
        const current = vault.get(key);
        return current && JSON.stringify(key === 'bots-local-owner' ? { id: current.id, createdAt: current.createdAt }
          : { id: current.principal?.id, scope: current.principal?.scope }) !== JSON.stringify(owner);
      });
      if (!replaced) await vault.restoreSetupOwners(owners);
      await vault.drain();
      for (const owned of [vault.paths.keyPath, vault.paths.vaultPath]) await sync(owned);
    }
    // Bundle verification hashes only descriptor, sources/ and config/reviewed-*, never web-data.
    try { await fs.rename(file, path.join(dataDirectory, 'native-setup-local-owners.restored.json')); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    await sync(dataDirectory).catch(() => {});
  };
  await reclaimReusedLock(lock);
  try { await withCrossProcessFileLock(lock, restore); }
  catch (error) {
    // A holder pid reused while this start waited is reclaimed once.
    if (error.code !== 'LOCK_TIMEOUT' || !await reclaimReusedLock(lock)) throw error;
    await withCrossProcessFileLock(lock, restore);
  }
}
