#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(fixtureDirectory, '../../../..');
const requireElectron = createRequire(path.join(repositoryRoot, 'packages/electron/package.json'));
const cacheRoot = path.join(repositoryRoot, '.cache/browser-inspect');
const MAX_LOG_BYTES = 16 * 1024;

await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
const temporaryRoot = await mkdtemp(path.join(cacheRoot, 'acceptance-'));
const resultPath = path.join(temporaryRoot, 'result.json');
let child;
let shutdownTimer;
let forceShutdownTimer;
let logs = '';
let timedOut = false;
let interruptedSignal = null;
const stop = (signal) => {
  interruptedSignal = signal;
  child?.kill('SIGTERM');
  clearTimeout(forceShutdownTimer);
  forceShutdownTimer = setTimeout(() => child?.kill('SIGKILL'), 3_000);
};
const interrupt = () => stop('SIGINT');
const terminate = () => stop('SIGTERM');
process.once('SIGINT', interrupt);
process.once('SIGTERM', terminate);

try {
  const environment = {};
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'SYSTEMROOT', 'WINDIR']) {
    if (typeof process.env[key] === 'string') environment[key] = process.env[key];
  }
  environment.DEVRYAN_BROWSER_INSPECTION_ROOT = temporaryRoot;
  environment.DEVRYAN_BROWSER_INSPECTION_RESULT = resultPath;
  child = spawn(requireElectron('electron'), [
    `--user-data-dir=${path.join(temporaryRoot, 'user-data')}`,
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-domain-reliability',
    '--no-first-run',
    path.join(fixtureDirectory, 'electron-main.mjs'),
  ], {
    cwd: repositoryRoot,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const captureLog = (chunk) => { logs = `${logs}${chunk}`.slice(-MAX_LOG_BYTES); };
  child.stdout.on('data', captureLog);
  child.stderr.on('data', captureLog);
  shutdownTimer = setTimeout(() => {
    timedOut = true;
    stop(null);
  }, 30_000);
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const failure = timedOut ? 'timed out after 30 seconds' : interruptedSignal || `exit code ${exitCode}`;
  assert.equal(exitCode, 0, `Isolated Electron acceptance failed (${failure}): ${logs.replaceAll(temporaryRoot, '<FIXTURE>')}`);
  const evidence = JSON.parse(await readFile(resultPath, 'utf8'));
  assert.equal(evidence.status, 'passed');
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', terminate);
  clearTimeout(shutdownTimer);
  clearTimeout(forceShutdownTimer);
  if (child && child.exitCode === null && child.signalCode === null) {
    const closed = new Promise((resolve) => child.once('close', resolve));
    child.kill('SIGKILL');
    await closed;
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}
