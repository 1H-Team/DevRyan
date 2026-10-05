import fs from 'node:fs/promises';
import path from 'node:path';
import { createSessionVault, validateSetupOwners } from '../../multi-user/vault.js';

const fail = () => Object.assign(new Error('native_setup_local_owner_invalid'), { code: 'native_setup_local_owner_invalid', status: 503 });
const sync = async file => { const handle = await fs.open(file, 'r'); try { await handle.sync(); } finally { await handle.close(); } };
const existing = async file => {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || await fs.realpath(file) !== file) throw fail();
    return stat;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
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
 * A start that dies before the rename re-runs against identical owners, which passes. */
export async function restoreNativeSetupOwners(dataDirectory) {
  const file = path.join(dataDirectory, 'native-setup-local-owners.json');
  const stat = await existing(file);
  if (!stat) return;
  if (stat.size > 16384) throw fail();
  const value = JSON.parse(await fs.readFile(file, 'utf8'));
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
  await fs.rename(file, path.join(dataDirectory, 'native-setup-local-owners.restored.json'));
  await sync(dataDirectory).catch(() => {});
}
