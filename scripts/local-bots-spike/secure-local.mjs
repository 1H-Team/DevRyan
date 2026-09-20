import assert from 'node:assert/strict';
import path from 'node:path';
import { command, localDatabase, prepareLocalCompose, sql, workspace } from './fixtures.mjs';

// A kernel-verified Unix peer, not a password/trust connection, authenticates
// the unprivileged PostgREST process. It cannot select the postgres role.
const hba = 'local all postgres peer\nlocal all authenticator peer map=bot_postgrest\nlocal all all reject\nhost all all 0.0.0.0/0 reject\nhost all all ::/0 reject\n';
const ident = 'bot_postgrest nobody authenticator\n';
for (const [file, contents] of [['pg_hba.conf', hba], ['pg_ident.conf', ident]]) {
  command('docker', ['exec', '--user', 'postgres', '-i', localDatabase, 'sh', '-c', `cat > /var/lib/postgresql/data/${file}`], { input: contents });
}
sql(localDatabase, 'select pg_reload_conf();');
assert.throws(() => command('docker', ['exec', '--user', 'nobody', localDatabase, 'psql', '-XAt', '-U', 'postgres', '-c', 'select 1;']));
assert.equal(command('docker', ['exec', '--user', 'nobody', localDatabase, 'psql', '-XAt', '-U', 'authenticator', '-d', 'postgres', '-c', 'select current_user;']).trim(), 'authenticator');
prepareLocalCompose();
command('docker', ['compose', '-f', path.join(workspace, 'compose.json'), 'up', '-d', 'rest'], { timeout: 90_000 });
console.log('PASS: peer authentication admits only the unprivileged PostgREST identity; database administrator impersonation rejected');
