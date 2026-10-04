import fs from 'node:fs/promises';
import path from 'node:path';
import { createSessionVault, validateSetupOwners } from '../../multi-user/vault.js';

const fail = () => Object.assign(new Error('native_setup_local_owner_invalid'), { code: 'native_setup_local_owner_invalid', status: 503 });
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

/** Runs before the application constructs its account/Bots owners or mints sessions. */
export async function restoreNativeSetupOwners(dataDirectory) {
  const file = path.join(dataDirectory, 'native-setup-local-owners.json');
  const stat = await existing(file);
  if (!stat) return;
  if (stat.size > 16384) throw fail();
  const value = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!value || value.schema !== 1 || Object.keys(value).some(key => !['schema', 'owners'].includes(key))) throw fail();
  const owners = validateSetupOwners(value.owners);
  if (!Object.keys(owners).length) return;
  const vault = await createSessionVault({ dataDirectory });
  await vault.restoreSetupOwners(owners);
  await vault.drain();
}
