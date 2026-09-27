#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readAndVerifyBotRuntimeImagesManifest } from './verify-bot-runtime-images.mjs';
import { loadBotDatabaseSql, renderMigrationTransaction } from '../packages/bot-db/index.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const composePath = path.join(repositoryRoot, 'docker', 'bots', 'compose.yml');
// The fixed services plus the local Bot catalog (database and its REST view).
const FIXED_SERVICE_NAMES = Object.freeze([
  'supervisor', 'engine-proxy', 'egress', 'indexer', 'database', 'database-rest',
]);
const IMAGE_ENVIRONMENT_KEYS = Object.freeze({
  supervisor: 'DEVRYAN_BOT_SUPERVISOR_IMAGE',
  'engine-proxy': 'DEVRYAN_BOT_ENGINE_PROXY_IMAGE',
  egress: 'DEVRYAN_BOT_EGRESS_IMAGE',
  indexer: 'DEVRYAN_BOT_INDEXER_IMAGE',
  opencode: 'DEVRYAN_BOT_OPENCODE_IMAGE',
  computer: 'DEVRYAN_BOT_COMPUTER_IMAGE',
  database: 'DEVRYAN_BOT_DATABASE_IMAGE',
  rest: 'DEVRYAN_BOT_REST_IMAGE',
});
const PRODUCTION_PREFIXES = Object.freeze(['devryan-bots', 'devryan-bot', 'devryan']);
const SMOKE_NAME_PATTERN = /^devryan-smoke-[0-9a-f]{12}$/;

// Every smoke resource (project, networks, volumes) lives in a namespace of
// its own, so a smoke run can never touch an installed runtime's resources.
export const createBotRuntimeImageSmokeNames = (suffix = crypto.randomBytes(6).toString('hex')) => {
  const name = `devryan-smoke-${suffix}`;
  if (!SMOKE_NAME_PATTERN.test(name) || PRODUCTION_PREFIXES.includes(name)) {
    fail('Bot runtime image smoke names are invalid', 'bot_runtime_image_smoke_input_invalid');
  }
  return Object.freeze({
    projectName: name,
    resourceNamespace: name,
    databaseVolume: `${name}-bot-database-data`,
  });
};

export class BotRuntimeImageSmokeError extends Error {
  constructor(message, code = 'bot_runtime_image_smoke_failed') {
    super(message);
    this.name = 'BotRuntimeImageSmokeError';
    this.code = code;
  }
}

const fail = (message, code) => {
  throw new BotRuntimeImageSmokeError(message, code);
};

const platformKey = (architecture = process.arch) => {
  if (architecture === 'x64') return 'linux/amd64';
  if (architecture === 'arm64') return 'linux/arm64';
  fail('Bot runtime image smoke architecture is unsupported', 'bot_runtime_image_smoke_architecture_unsupported');
};

const secret = () => crypto.randomBytes(32).toString('base64url');

export const createBotRuntimeImageSmokeEnvironment = ({
  manifest,
  architecture = process.arch,
  hostRuntimeRoot,
  dockerSocketGid = 0,
  environment = process.env,
  names = createBotRuntimeImageSmokeNames(),
} = {}) => {
  const platform = platformKey(architecture);
  if (!manifest?.images || typeof hostRuntimeRoot !== 'string' || !path.isAbsolute(hostRuntimeRoot)
    || !Number.isSafeInteger(dockerSocketGid) || dockerSocketGid < 0
    || !SMOKE_NAME_PATTERN.test(names?.resourceNamespace || '')) {
    fail('Bot runtime image smoke environment is invalid', 'bot_runtime_image_smoke_input_invalid');
  }
  const imageEnvironment = {};
  for (const [key, environmentKey] of Object.entries(IMAGE_ENVIRONMENT_KEYS)) {
    const image = manifest.images[key];
    const digest = image?.platforms?.[platform]?.digest;
    if (typeof image?.repository !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(digest || '')) {
      fail('Bot runtime image smoke manifest is incomplete', 'bot_runtime_image_smoke_manifest_invalid');
    }
    imageEnvironment[environmentKey] = `${image.repository}@${digest}`;
  }
  return Object.freeze({
    ...environment,
    ...imageEnvironment,
    DEVRYAN_BOT_SUPERVISOR_TOKEN: secret(),
    DEVRYAN_BOT_ENGINE_PROXY_TOKEN: secret(),
    DEVRYAN_BOT_EGRESS_SIGNING_KEY: secret(),
    DEVRYAN_BOT_EGRESS_CONTROL_TOKEN: secret(),
    DEVRYAN_BOT_INDEXER_TOKEN: secret(),
    DEVRYAN_BOT_DEPLOYMENT_ID: `deployment-${crypto.randomBytes(12).toString('hex')}`,
    DEVRYAN_BOT_DATABASE_JWT_SECRET: secret(),
    DEVRYAN_DOCKER_SOCKET_GID: String(dockerSocketGid),
    DEVRYAN_BOT_HOST_RUNTIME_ROOT: hostRuntimeRoot,
    DEVRYAN_BOT_RESOURCE_NAMESPACE: names.resourceNamespace,
  });
};

const defaultRunner = (args, { environment, timeoutMs = 180_000, input } = {}) => {
  const result = spawnSync('docker', args, {
    cwd: repositoryRoot,
    env: environment,
    input,
    stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
    timeout: timeoutMs,
  });
  if (result.error || result.status !== 0) {
    fail('Published Bot runtime images did not become healthy');
  }
};

const composeArgs = (projectName, action) => [
  'compose',
  '--project-name',
  projectName,
  '--file',
  composePath,
  ...action,
];

export async function smokeBotRuntimeImages({
  manifestPath,
  architecture = process.arch,
  runner = defaultRunner,
  fsPromises = fs,
  environment = process.env,
  dockerSocketPath = '/var/run/docker.sock',
  names = createBotRuntimeImageSmokeNames(),
} = {}) {
  if (typeof manifestPath !== 'string' || !manifestPath || typeof runner !== 'function'
    || typeof dockerSocketPath !== 'string' || !path.isAbsolute(dockerSocketPath)) {
    fail('Bot runtime image smoke input is invalid', 'bot_runtime_image_smoke_input_invalid');
  }
  const manifest = await readAndVerifyBotRuntimeImagesManifest({ manifestPath, fsPromises });
  const temporaryDirectory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'devryan-bot-smoke-'));
  const hostRuntimeRoot = path.join(temporaryDirectory, 'runtime');
  await fsPromises.mkdir(hostRuntimeRoot, { recursive: true, mode: 0o700 });
  const socket = await fsPromises.stat(dockerSocketPath);
  const smokeEnvironment = createBotRuntimeImageSmokeEnvironment({
    manifest,
    architecture,
    hostRuntimeRoot,
    dockerSocketGid: socket.gid,
    environment,
    names,
  });
  let volumeCreated = false;
  try {
    // The host lifecycle creates the database volume and runs the one-off
    // initialization; Compose never creates or initializes it on its own.
    runner([
      'volume', 'create',
      '--label', 'devryan.runtime=production-bots',
      '--label', 'devryan.owner=release-smoke',
      '--label', `devryan.deployment=${smokeEnvironment.DEVRYAN_BOT_DEPLOYMENT_ID}`,
      '--label', 'devryan.volume-role=database-data',
      names.databaseVolume,
    ], { environment: smokeEnvironment, timeoutMs: 60_000 });
    volumeCreated = true;
    runner(composeArgs(names.projectName, [
      'run', '--rm', '--no-deps', '-T',
      '--env', 'DEVRYAN_BOT_DATABASE_INITIALIZE=allow',
      'database', '--initialize-only',
    ]), { environment: smokeEnvironment, timeoutMs: 180_000 });
    runner(composeArgs(names.projectName, [
      'up', '--detach', '--wait', '--wait-timeout', '120', 'database',
    ]), { environment: smokeEnvironment, timeoutMs: 180_000 });
    const sql = await loadBotDatabaseSql({
      supabaseMigrationsDirectory: path.join(repositoryRoot, 'supabase', 'migrations'),
      sqlDirectory: path.join(repositoryRoot, 'packages', 'bot-db', 'sql'),
    });
    const psql = (database, input) => runner(composeArgs(names.projectName, [
      'exec', '-T', '--user', 'postgres', 'database',
      'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '--dbname', database,
    ]), { environment: smokeEnvironment, timeoutMs: 180_000, input });
    psql('postgres', `${sql.bootstrapCluster}\ncreate database devryan_bots template template0;\nrevoke all on database devryan_bots from public;\ngrant connect on database devryan_bots to authenticator;\n`);
    psql('devryan_bots', `${sql.bootstrapDatabase}\n${sql.migrations.map(renderMigrationTransaction).join('\n')}`);
    runner(composeArgs(names.projectName, [
      'up', '--detach', '--wait', '--wait-timeout', '120', 'database-rest',
    ]), { environment: smokeEnvironment, timeoutMs: 180_000 });
    runner(composeArgs(names.projectName, [
      'up',
      '--detach',
      '--remove-orphans',
      '--wait',
      '--wait-timeout',
      '120',
      ...FIXED_SERVICE_NAMES,
    ]), { environment: smokeEnvironment, timeoutMs: 180_000 });
    return manifest;
  } finally {
    try {
      runner(composeArgs(names.projectName, ['down', '--remove-orphans', '--volumes']), {
        environment: smokeEnvironment,
        timeoutMs: 60_000,
      });
    } catch {
      // The primary health failure remains authoritative; the hosted runner is ephemeral.
    }
    if (volumeCreated) {
      try {
        runner(['volume', 'rm', names.databaseVolume], { environment: smokeEnvironment, timeoutMs: 60_000 });
      } catch {
        // Same as above: cleanup never masks the health result.
      }
    }
    await fsPromises.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

const parseArguments = (argv) => {
  if (argv.length !== 2 || argv[0] !== '--manifest' || !argv[1]) {
    fail('Usage: smoke-bot-runtime-images.mjs --manifest <path>', 'bot_runtime_image_smoke_cli_invalid');
  }
  return { manifestPath: argv[1] };
};

async function main() {
  const result = await smokeBotRuntimeImages(parseArguments(process.argv.slice(2)));
  console.log(`[bots] fixed runtime services and the local catalog are healthy for ${result.releaseId}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(`[bots] runtime image health smoke failed (${error?.code || 'unknown'})`);
    process.exitCode = 1;
  });
}
