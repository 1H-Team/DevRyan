#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopChildTree, useDetachedChildren } from './dev-child-utils.mjs';
import { resolveDevDataDirectory } from './dev-data-directory.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const webRoot = path.join(repoRoot, 'packages/web');
const devDataDirectory = resolveDevDataDirectory({
  env: process.env,
  repoRoot,
  scope: 'web-hmr',
});

function run(label, command, args, env = {}, options = {}) {
  return spawn(command, args, {
    cwd: options.cwd || repoRoot,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    detached: useDetachedChildren,
  }).on('error', (error) => {
    console.error(`[dev:web:hmr] Failed to start ${label}:`, error);
  });
}

const uiPort = process.env.OPENCHAMBER_HMR_UI_PORT || '5180';
const backendPort = process.env.OPENCHAMBER_HMR_API_PORT || '3902';

function clearViteCache() {
  const cacheDirs = [
    path.join(webRoot, 'node_modules/.vite'),
    path.join(webRoot, 'node_modules/.vite-temp'),
  ];

  for (const cacheDir of cacheDirs) {
    if (!existsSync(cacheDir)) continue;
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

clearViteCache();

const api = run('api', 'bun', ['run', '--cwd', 'packages/web', 'dev:server:watch'], {
  OPENCHAMBER_DATA_DIR: devDataDirectory,
  OPENCHAMBER_PORT: backendPort,
});
const vite = run(
  'vite',
  'bun',
  ['x', 'vite', '--force', '--host', '127.0.0.1', '--port', uiPort, '--strictPort'],
  {
    OPENCHAMBER_DATA_DIR: devDataDirectory,
    OPENCHAMBER_PORT: backendPort,
    OPENCHAMBER_DISABLE_PWA_DEV: '1',
  },
  { cwd: webRoot },
);

console.log(`[dev:web:hmr] UI with HMR: http://127.0.0.1:${uiPort}`);
console.log(`[dev:web:hmr] API: http://127.0.0.1:${backendPort}`);
console.log('[dev:web:hmr] IMPORTANT: open UI URL above for HMR; backend URL has no HMR');

let shuttingDown = false;

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.all([stopChildTree(api), stopChildTree(vite)]);
  process.exit(exitCode);
}

function onChildExit(label) {
  return (code, signal) => {
    if (shuttingDown) return;

    if (code !== 0 || signal) {
      console.error(`[dev:web:hmr] ${label} exited unexpectedly (code=${code ?? 'null'} signal=${signal ?? 'none'})`);
      shutdown(typeof code === 'number' ? code : 1).catch(() => process.exit(1));
      return;
    }

    shutdown(0).catch(() => process.exit(1));
  };
}

api.on('exit', onChildExit('api'));
vite.on('exit', onChildExit('vite'));

process.on('SIGINT', () => {
  shutdown(130).catch(() => process.exit(130));
});
process.on('SIGTERM', () => {
  shutdown(143).catch(() => process.exit(143));
});
process.on('SIGHUP', () => {
  shutdown(129).catch(() => process.exit(129));
});
