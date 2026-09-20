import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { command, localDatabase, repository, sql, workspace } from './fixtures.mjs';

const directory = path.join(repository, 'supabase/migrations');
const migrations = readdirSync(directory).filter((name) => name.includes('bot') && name.endsWith('.sql')).sort();
const supporting = ['20260802195944_devryan_multi_user.sql', '20260803112512_classify_agent_test_users.sql'];
const manifest = [];

if (sql(localDatabase, "select count(*) from pg_namespace where nspname = 'auth';").trim() !== '0') {
  throw new Error('Replay requires a fresh disposable database; refusing to reset an existing store');
}
sql(localDatabase, readFileSync(path.join(import.meta.dirname, 'bootstrap.sql'), 'utf8'));
for (const filename of [...supporting, ...migrations]) {
  const bytes = readFileSync(path.join(directory, filename));
  sql(localDatabase, bytes);
  manifest.push({ filename, sha256: createHash('sha256').update(bytes).digest('hex'), supporting: supporting.includes(filename) });
  console.log(`Applied ${filename}`);
}
sql(localDatabase, "notify pgrst, 'reload schema';");
writeFileSync(path.join(workspace, 'migration-manifest.json'), JSON.stringify(manifest, null, 2));
command('docker', ['compose', '-f', path.join(workspace, 'compose.json'), 'up', '-d', 'rest']);
console.log(`Replayed ${migrations.length} unchanged Bot migrations and ${supporting.length} supporting migrations.`);
