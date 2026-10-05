import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSessionVault, validateSetupOwners } from '../../multi-user/vault.js';
import { withCrossProcessFileLock } from '../../../../../harness-runtime/lib/atomic-file.js';

const fail = () => Object.assign(new Error('native_setup_local_owner_invalid'), { code: 'native_setup_local_owner_invalid', status: 503 });
const sync = async file => { const handle = await fs.open(file, 'r'); try { await handle.sync(); } finally { await handle.close(); } };
const existing = async file => {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || await fs.realpath(file) !== file) throw fail();
    return stat;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};

// Restore holds the lock for milliseconds, so an older lock belongs to a crashed start
// whose pid a live unrelated process may since have reused (the shared lock trusts it).
const LOCK_STALE_MS = 60_000;
const reclaimStaleLock = async lock => {
  let stat, raw;
  try { stat = await fs.lstat(lock); raw = await fs.readFile(lock, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  let createdAt; try { createdAt = JSON.parse(raw)?.createdAt; } catch {}
  if (Date.now() - (Number.isFinite(createdAt) ? createdAt : stat.mtimeMs) < LOCK_STALE_MS) return false;
  // Rename is the atomic claim: only one start takes the file. A start that took a lock
  // another start re-created after reclaiming the same stale one hands it back.
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
  await reclaimStaleLock(lock);
  try { await withCrossProcessFileLock(lock, restore); }
  catch (error) {
    // A lock that turned stale while this start waited is reclaimed once.
    if (error.code !== 'LOCK_TIMEOUT' || !await reclaimStaleLock(lock)) throw error;
    await withCrossProcessFileLock(lock, restore);
  }
}
