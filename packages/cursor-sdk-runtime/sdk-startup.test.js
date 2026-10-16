import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { copyFile, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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
  test('confined one-shot worker initializes SQLite in its private scratch before sending the prompt', async () => {
    const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'devryan-cursor-confined-worker-')));
    let child;
    try {
      for (const name of await readdir(import.meta.dirname)) {
        if (/\.(mjs|js)$/.test(name) && !name.includes('.test.')) {
          await copyFile(path.join(import.meta.dirname, name), path.join(directory, name));
        }
      }
      const sdk = path.join(directory, 'node_modules/@cursor/sdk');
      await mkdir(sdk, { recursive: true });
      await writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
      await writeFile(path.join(sdk, 'package.json'), JSON.stringify({ type: 'module', exports: { '.': './index.js', './sqlite': './sqlite.js' } }));
      await writeFile(path.join(sdk, 'sqlite.js'), `
        import assert from 'node:assert/strict';
        import path from 'node:path';
        export const SqliteLocalAgentStore = { async open({ workspaceRef, stateRoot }) {
          assert.equal(workspaceRef, process.cwd());
          assert.equal(stateRoot, path.join(process.env.HOME, 'cursor-sdk-state'));
          return { confinedFixture: true };
        } };
      `);
      await writeFile(path.join(sdk, 'index.js'), `
        import assert from 'node:assert/strict';
        let configured = false;
        export function configureCursorSdk({ local: { store } }) { assert.equal(store.confinedFixture, true); configured = true; }
        export const Agent = { async create() {
          assert.equal(configured, true);
          return { agentId: 'fixture-agent', async send({ text }) {
            assert.equal(text, 'confined fixture');
            return { id: 'fixture-run', status: 'finished',
              async *stream() { yield { type: 'assistant', message: { content: [{ type: 'text', text: 'confined ok' }] } }; },
              async wait() { return { status: 'finished', result: 'confined ok' }; },
              async conversation() { return [{type:'agentConversationTurn',turn:{steps:[{type:'assistantMessage',message:{text:'confined ok'}}]}}]; }
            };
          } };
        } };
      `);
      child = spawn('node', [path.join(directory, 'node-worker.mjs')], {
        cwd: directory, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, HOME: directory, TMPDIR: directory, DEVRYAN_EXECUTION_WORKER: '1' },
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      child.stdin.end(JSON.stringify({ apiKey: 'synthetic-fixture', modelID: 'fixture', directory, prompt: 'confined fixture', readOnly: true }));
      expect(await exit).toBe(0);
      expect(stderr).toBe('');
      const events = stdout.trim().split('\n').map(line => JSON.parse(line));
      expect(events.some(event => event.type === 'error')).toBe(false);
      expect(events.find(event => event.type === 'final-result')?.result).toMatchObject({ ok: true, finalText: 'confined ok' });
      expect(events.find(event => event.type === 'done')?.status).toBe('finished');
    } finally {
      if (child?.exitCode === null) child.kill('SIGKILL');
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  test('loads the installed SDK and starts the persistent Node worker', async () => {
    const child = await waitForPersistentWorkerReady();
    const exitCode = await new Promise((resolve) => child.once('exit', resolve));
    expect(exitCode).toBe(0);
  }, 15_000);
});
