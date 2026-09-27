// Real-Docker harness for the local Bot catalog. Every resource uses an
// isolated namespace and Compose project; production names are refused before
// any mutation. Used by bot-catalog.docker.test.mjs (opt-in).
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { loadBotDatabaseSql } from '@openchamber/bot-db';

import { createBotCatalogBackups } from '../bot-catalog-backup.mjs';
import { createBotDatabaseManager, createFileBotDatabaseStateStore } from '../bot-database-manager.mjs';
import { assertIsolatedBotResourceNames, deriveBotRuntimeServiceEnvironment } from '../bot-runtime-manager.mjs';

const execFileAsync = promisify(execFile);
export const REPOSITORY_ROOT = path.resolve(import.meta.dir ?? path.dirname(new URL(import.meta.url).pathname), '../../..');
export const COMPOSE_PATH = path.join(REPOSITORY_ROOT, 'docker/bots/compose.yml');
export const DATABASE_IMAGE = process.env.DEVRYAN_BOT_DATABASE_TEST_IMAGE || 'devryan/bot-database:dev';
export const REST_IMAGE = process.env.DEVRYAN_BOT_REST_TEST_IMAGE || 'devryan/bot-rest:dev';

export const runProcess = async (file, args, { env, input, maxBuffer = 64 * 1024 * 1024, timeoutMs = 180_000 } = {}) => {
  try {
    const pending = execFileAsync(file, args, { env, maxBuffer, timeout: timeoutMs, shell: false });
    if (input !== undefined) {
      pending.child.stdin.on('error', () => undefined);
      pending.child.stdin.end(input);
    }
    const result = await pending;
    return { exitCode: 0, stdout: result.stdout || '', stderr: result.stderr || '' };
  } catch (error) {
    return {
      exitCode: Number.isInteger(error?.code) ? error.code : 1,
      stdout: typeof error?.stdout === 'string' ? error.stdout : '',
      stderr: typeof error?.stderr === 'string' ? error.stderr : '',
    };
  }
};

export const streamProcess = (file, args, { env, input = null, output = null, timeoutMs = 300_000 } = {}) => (
  new Promise((resolve) => {
    import('node:child_process').then(({ spawn }) => {
      const child = spawn(file, args, { env, shell: false, stdio: [input ? 'pipe' : 'ignore', output ? 'pipe' : 'ignore', 'pipe'] });
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      if (input) {
        child.stdin.on('error', () => undefined);
        input.pipe(child.stdin);
      }
      if (output) child.stdout.pipe(output);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ exitCode: Number.isInteger(code) ? code : 1, stderr });
      });
    });
  })
);

export async function createCatalogHarness() {
  const suffix = crypto.randomBytes(4).toString('hex');
  const resourceNamespace = `devryan-it-${suffix}`;
  const projectName = `devryan-it-${suffix}`;
  assertIsolatedBotResourceNames({ projectName, resourceNamespace });
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-bot-catalog-it-'));
  const deploymentKey = crypto.randomBytes(32);
  const serviceEnvironment = deriveBotRuntimeServiceEnvironment(deploymentKey, {
    hostRuntimeRoot: path.join(dataDirectory, 'bots', 'runtime'),
  });
  const environment = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DOCKER_CONFIG: process.env.DOCKER_CONFIG || path.join(os.homedir(), '.docker'),
    ...serviceEnvironment,
    DEVRYAN_BOT_RESOURCE_NAMESPACE: resourceNamespace,
    DEVRYAN_BOT_ACTIVE_REVISIONS: '',
    DEVRYAN_BOT_DATABASE_IMAGE: DATABASE_IMAGE,
    DEVRYAN_BOT_REST_IMAGE: REST_IMAGE,
    // Services this harness never starts still need interpolation values.
    DEVRYAN_BOT_SUPERVISOR_IMAGE: 'devryan/unused:it',
    DEVRYAN_BOT_ENGINE_PROXY_IMAGE: 'devryan/unused:it',
    DEVRYAN_BOT_EGRESS_IMAGE: 'devryan/unused:it',
    DEVRYAN_BOT_INDEXER_IMAGE: 'devryan/unused:it',
    DEVRYAN_BOT_OPENCODE_IMAGE: 'devryan/unused:it',
    DEVRYAN_BOT_COMPUTER_IMAGE: 'devryan/unused:it',
  };
  const composeArgs = (action) => ['compose', '--project-name', projectName, '--file', COMPOSE_PATH, ...action];
  const run = (dockerPath, args, env = environment, _deadlineAt = null, options = {}) => runProcess(dockerPath, args, { env, ...options });
  const loadSql = () => loadBotDatabaseSql({
    supabaseMigrationsDirectory: path.join(REPOSITORY_ROOT, 'supabase/migrations'),
    sqlDirectory: path.join(REPOSITORY_ROOT, 'packages/bot-db/sql'),
  });
  const databaseManager = createBotDatabaseManager({
    run,
    composeArgs,
    resourceNamespace,
    stateStore: createFileBotDatabaseStateStore({ dataDirectory }),
    loadSql,
  });
  const backupKey = crypto.createHmac('sha256', deploymentKey).update('devryan-production-bots/catalog-backup/v1').digest();
  const backups = createBotCatalogBackups({
    dataDirectory,
    loadBackupKey: async () => Buffer.from(backupKey),
    databaseManager,
    composeArgs,
    streamProcess: (dockerPath, args, env, { input, output } = {}) => streamProcess(dockerPath, args, { env, input, output }),
  });
  const context = Object.freeze({
    dockerPath: 'docker',
    environment,
    baseEnvironment: environment,
    deadlineAt: null,
    failureCode: 'bot_it_failed',
    publishProgress: () => {},
  });
  const startRest = async () => {
    const started = await runProcess('docker', composeArgs(['up', '--detach', '--no-deps', '--wait', '--wait-timeout', '90', 'database-rest']), { env: environment });
    if (started.exitCode !== 0) throw new Error(`REST failed to start: ${started.stderr}`);
    databaseManager.markReady(await databaseManager.resolveRestEndpoint(context));
  };
  const stopRest = async () => {
    databaseManager.markUnavailable();
    await runProcess('docker', composeArgs(['stop', 'database-rest']), { env: environment });
  };
  const cleanup = async () => {
    await runProcess('docker', composeArgs(['down', '--remove-orphans']), { env: environment });
    for (const volume of [`${resourceNamespace}-bot-database-data`, `${resourceNamespace}-bot-database-socket`]) {
      await runProcess('docker', ['volume', 'rm', volume], { env: environment });
    }
    await fs.rm(dataDirectory, { recursive: true, force: true });
  };
  return {
    resourceNamespace,
    projectName,
    dataDirectory,
    deploymentKey,
    serviceEnvironment,
    backupKey,
    environment,
    context,
    databaseManager,
    backups,
    composeArgs,
    startRest,
    stopRest,
    cleanup,
    encryption: { getKey: async () => Buffer.from(deploymentKey) },
  };
}
