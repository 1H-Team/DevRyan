#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sleep,
  spawnManagedChild,
  stopChildTree,
} from '../../../scripts/dev-child-utils.mjs';
import { resolveDevDataDirectory } from '../../../scripts/dev-data-directory.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(webRoot, '../..');
const port = process.env.OPENCHAMBER_PORT || '3001';
const restartDelayMs = Number.parseInt(process.env.OPENCHAMBER_DEV_RESTART_DELAY_MS || '1000', 10);
const devDataDirectory = resolveDevDataDirectory({
  env: process.env,
  repoRoot,
  scope: 'web-server',
});

let shuttingDown = false;
let activeChild = null;

function spawnServer() {
  return spawnManagedChild({
    repoRoot: webRoot,
    cwd: webRoot,
    command: 'bun',
    args: ['server/index.js', '--port', String(port)],
    env: {
      OPENCHAMBER_DATA_DIR: devDataDirectory,
      OPENCHAMBER_DEV_MODE: 'true',
    },
  });
}

async function runLoop() {
  while (!shuttingDown) {
    activeChild = spawnServer();
    const child = activeChild;

    const exitInfo = await new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        resolve({ code, signal });
      });
    });

    activeChild = null;

    if (shuttingDown) {
      return;
    }

    const suffix = exitInfo.signal
      ? `signal=${exitInfo.signal}`
      : `code=${exitInfo.code ?? 'null'}`;
    console.error(`[dev:server:watch] server exited (${suffix}); restarting in ${restartDelayMs}ms...`);
    await sleep(restartDelayMs);
  }
}

async function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  await stopChildTree(activeChild);
}

process.on('SIGINT', () => {
  shutdown()
    .then(() => process.exit(130))
    .catch(() => process.exit(130));
});

process.on('SIGTERM', () => {
  shutdown()
    .then(() => process.exit(143))
    .catch(() => process.exit(143));
});

process.on('SIGHUP', () => {
  shutdown()
    .then(() => process.exit(129))
    .catch(() => process.exit(129));
});

runLoop().catch((error) => {
  console.error('[dev:server:watch] Fatal error:', error);
  process.exit(1);
});
