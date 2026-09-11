import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const supabaseConnectionPath = (dataDirectory) => path.join(dataDirectory, 'supabase-connection.json');

export function readSupabaseConnectionPreference(dataDirectory) {
  const filename = supabaseConnectionPath(dataDirectory);
  if (!fs.existsSync(filename)) return { version: 1, enabled: true };
  if ((fs.statSync(filename).mode & 0o077) !== 0) throw new Error('Supabase connection preference must be private (chmod 600)');
  const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (value?.version !== 1 || typeof value.enabled !== 'boolean') {
    throw new Error('Supabase connection preference is invalid');
  }
  return { version: 1, enabled: value.enabled };
}

export async function writeSupabaseConnectionPreference(dataDirectory, enabled) {
  if (typeof enabled !== 'boolean') throw new TypeError('Supabase connection mode must be boolean');
  const filename = supabaseConnectionPath(dataDirectory);
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  await fsp.mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  try {
    await fsp.writeFile(temporary, `${JSON.stringify({ version: 1, enabled })}\n`, { mode: 0o600, flag: 'wx' });
    await fsp.rename(temporary, filename);
  } finally {
    await fsp.unlink(temporary).catch(() => undefined);
  }
}
