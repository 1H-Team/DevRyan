import { createHmac, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const repository = path.resolve(import.meta.dirname, '../..');
export const workspace = path.join(repository, '.cache/local-bots-spike');
export const localProject = 'devryan-bots-spike-local-20260920';
export const parityProject = 'devryan-bots-spike-parity-20260920';
export const parityDirectory = path.join(workspace, 'supabase-parity');
export const localDatabase = `${localProject}-db-1`;
export const parityDatabase = `supabase_db_${parityProject}`;
export const localPort = 56330;
export const parityPort = 56321;
export const images = Object.freeze({
  postgres: 'postgres:17.9-bookworm@sha256:47f917f7409eacd22fc5dfb1dee634e1b55cf0c01d1a7eb701be2227a03e0641',
  postgrest: 'postgrest/postgrest:v14.5@sha256:b574528fe109c8343c1247155734d03df8c34b462f342dca0ccc20244fc36ef9',
});

export function command(executable, args, { input, timeout = 30_000 } = {}) {
  return execFileSync(executable, args, { cwd: repository, input, timeout,
    maxBuffer: 32 * 1024 * 1024, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

export function sql(database, input) {
  if (![localDatabase, parityDatabase].includes(database)) throw new Error('Not a disposable spike database');
  return command('docker', ['exec', '--user', 'postgres', '-i', database, 'psql', '-XAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'], { input });
}

export function signToken(secret, role) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ role, exp: Math.floor(Date.now() / 1000) + 86_400 })).toString('base64url');
  const input = `${header}.${payload}`;
  return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
}

export function prepareLocalCompose() {
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const secretPath = path.join(workspace, 'local-credentials.json');
  let credentials;
  try { credentials = JSON.parse(readFileSync(secretPath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const secret = randomBytes(48).toString('base64url');
    credentials = { secret, serviceKey: signToken(secret, 'service_role') };
    writeFileSync(secretPath, JSON.stringify(credentials), { mode: 0o600, flag: 'wx' });
  }
  const compose = {
    name: localProject,
    services: {
      db: {
        image: 'devryan-bots-spike-pg:20260920',
        // No TCP listener: only PostgREST's private shared Unix socket can connect.
        command: ['postgres', '-c', 'listen_addresses=', '-c', 'max_connections=30'],
        environment: { POSTGRES_HOST_AUTH_METHOD: 'trust' },
        volumes: ['data:/var/lib/postgresql/data', 'socket:/var/run/postgresql'],
        networks: ['private'], mem_limit: '512m', cpus: 1,
        healthcheck: { test: ['CMD-SHELL', 'pg_isready -U postgres'], interval: '1s', timeout: '3s', retries: 30 },
      },
      rest: {
        image: images.postgrest, user: '65534:65534', depends_on: { db: { condition: 'service_healthy' } },
        environment: {
          PGRST_DB_URI: 'postgresql:///postgres?host=/var/run/postgresql&user=authenticator',
          PGRST_DB_SCHEMAS: 'public', PGRST_DB_EXTRA_SEARCH_PATH: 'extensions',
          PGRST_DB_POOL: '5', PGRST_DB_MAX_ROWS: '1000',
          PGRST_JWT_SECRET: credentials.secret, PGRST_SERVER_PORT: '3000',
        },
        ports: [`127.0.0.1:${localPort}:3000`], volumes: ['socket:/var/run/postgresql'],
        networks: ['private', 'host_control'], read_only: true, cap_drop: ['ALL'],
        security_opt: ['no-new-privileges:true'], mem_limit: '128m', cpus: 1,
      },
    },
    volumes: { data: {}, socket: {} },
    networks: {
      private: { internal: true },
      host_control: { driver_opts: { 'com.docker.network.bridge.host_binding_ipv4': '127.0.0.1' } },
    },
  };
  const filename = path.join(workspace, 'compose.json');
  writeFileSync(filename, JSON.stringify(compose, null, 2), { mode: 0o600 });
  return filename;
}
