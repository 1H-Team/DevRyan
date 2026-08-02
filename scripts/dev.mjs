#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sleep,
  spawnManagedChild,
  stopChildTree,
} from './dev-child-utils.mjs';
import { resolveDevDataDirectory } from './dev-data-directory.mjs';
import { shouldRestartDevChild } from './dev-restart-policy.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const restartDelayMs = Number.parseInt(process.env.OPENCHAMBER_DEV_RESTART_DELAY_MS || '1000', 10);
const devDataDirectory = resolveDevDataDirectory({
  env: process.env,
  repoRoot,
  scope: 'web-stack',
});

const baseDevEnv = {
  OPENCHAMBER_DEV_MODE: 'true',
  OPENCHAMBER_DEV_SHUTDOWN: 'true',
  OPENCHAMBER_ALLOW_DEV_SHUTDOWN: 'true',
  OPENCHAMBER_DEV_ORCHESTRATOR_PID: String(process.pid),
  OPENCHAMBER_DATA_DIR: devDataDirectory,
};

/** @type {Array<{ label: string, command: string, args: string[], cwd?: string }>} */
const childSpecs = [
  {
    label: 'server',
    command: 'bun',
    args: ['run', '--cwd', 'packages/web', 'dev:server:watch'],
  },
  {
    label: 'web',
    command: 'bun',
    args: ['run', '--cwd', 'packages/web', 'build:watch'],
  },
  {
    label: 'ui',
    command: 'bun',
    args: ['run', '--cwd', 'packages/ui', 'dev'],
  },
];

/** @type {Map<string, import('node:child_process').ChildProcess>} */
const children = new Map();
/** @type {Map<string, Promise<void>>} */
const restartTasks = new Map();

let shuttingDown = false;

function spawnSpec(spec) {
  const child = spawnManagedChild({
    repoRoot,
    command: spec.command,
    args: spec.args,
    cwd: spec.cwd || repoRoot,
    env: baseDevEnv,
  });
  children.set(spec.label, child);

  child.on('exit', (code, signal) => {
    children.delete(spec.label);
    void handleChildExit(spec, code, signal);
  });

  return child;
}

async function handleChildExit(spec, code, signal) {
  if (!shouldRestartDevChild({ shuttingDown })) {
    return;
  }

  const existing = restartTasks.get(spec.label);
  if (existing) {
    await existing;
    return;
  }

  const suffix = signal ? `signal=${signal}` : `code=${code ?? 'null'}`;
  console.error(`[dev] ${spec.label} exited (${suffix}); restarting in ${restartDelayMs}ms...`);

  const task = (async () => {
    await sleep(restartDelayMs);
    if (!shouldRestartDevChild({ shuttingDown })) {
      return;
    }
    spawnSpec(spec);
  })();

  restartTasks.set(spec.label, task);
  try {
    await task;
  } finally {
    restartTasks.delete(spec.label);
  }
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  await Promise.all([...children.values()].map((child) => stopChildTree(child)));
  process.exit(exitCode);
}

for (const spec of childSpecs) {
  spawnSpec(spec);
}

console.log('[dev] OpenChamber dev stack running (Ctrl+C to stop)');
console.log('[dev] API default: http://127.0.0.1:3001');

process.on('SIGINT', () => {
  shutdown(130).catch(() => process.exit(130));
});
process.on('SIGTERM', () => {
  shutdown(143).catch(() => process.exit(143));
});
process.on('SIGHUP', () => {
  shutdown(129).catch(() => process.exit(129));
});
