import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const waitForPersistentWorkerReady = () => new Promise((resolve, reject) => {
  const child = spawn('node', ['./persistent-worker.mjs'], {
    cwd: import.meta.dirname,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderr = [];
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    reject(new Error(`Timed out waiting for Cursor SDK worker startup. ${stderr.join('')}`));
  }, 10_000);
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });

  child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
  child.once('error', (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.once('exit', (code, signal) => {
    if (code === 0) return;
    clearTimeout(timer);
    reject(new Error(`Cursor SDK worker exited before ready (${code ?? signal}). ${stderr.join('')}`));
  });
  lines.on('line', (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event?.type !== 'ready') return;
    clearTimeout(timer);
    child.stdin.end(`${JSON.stringify({ type: 'shutdown' })}\n`);
    resolve(child);
  });
});

describe('Cursor SDK startup compatibility', () => {
  test('loads the installed SDK and starts the persistent Node worker', async () => {
    const child = await waitForPersistentWorkerReady();
    const exitCode = await new Promise((resolve) => child.once('exit', resolve));
    expect(exitCode).toBe(0);
  }, 15_000);
});
