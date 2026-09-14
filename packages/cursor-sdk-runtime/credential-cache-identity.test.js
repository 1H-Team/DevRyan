import { test, expect } from 'bun:test';
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// Run the real worker against an SDK stub; no installed provider or credentials.
test('persistent agents resume with changed credentials and reuse unchanged credentials', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cursor-credential-cache-'));
  let child;
  let closed;
  let lines;
  try {
    for (const name of await readdir(import.meta.dirname)) {
      if (!/\.(?:mjs|js)$/.test(name) || name.includes('.test.')) continue;
      await copyFile(path.join(import.meta.dirname, name), path.join(directory, name));
    }
    await writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
    const sdkDirectory = path.join(directory, 'node_modules/@cursor/sdk');
    await mkdir(sdkDirectory, { recursive: true });
    await writeFile(path.join(sdkDirectory, 'package.json'), '{"type":"module","exports":"./index.js"}');
    await writeFile(path.join(sdkDirectory, 'index.js'), `
      let generation = 0;
      const makeAgent = () => ({ agentId: 'fixture-agent-' + ++generation, close() {} });
      export const Agent = {
        async create({ apiKey }) {
          if (apiKey !== 'fixture-key-a') throw new Error('Unexpected initial credential');
          return makeAgent();
        },
        async resume(agentID, { apiKey }) {
          if (agentID !== 'fixture-agent-1' || apiKey !== 'fixture-key-b') {
            throw new Error('Resume did not use the retained agent and new credential');
          }
          return makeAgent();
        },
      };
    `);
    child = spawn('node', [path.join(directory, 'persistent-worker.mjs')], {
      cwd: directory,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH },
    });
    closed = new Promise((resolve, reject) => {
      child.once('close', resolve);
      child.once('error', reject);
    });
    const events = [];
    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => { events.push(JSON.parse(line)); });
    const waitFor = async (matches) => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const event = events.find(matches);
        if (event) return event;
        if (child.exitCode !== null) throw new Error(`Fixture worker exited: ${stderr}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Fixture worker did not respond: ${stderr}`);
    };
    await waitFor((event) => event.type === 'ready');
    const prepare = async (requestID, apiKey) => {
      child.stdin.write(`${JSON.stringify({
        type: 'prepare', requestID, apiKey, sessionID: 'fixture-session', directory,
        agentID: requestID === 'first' ? '' : 'fixture-agent-1', modelID: 'fixture-model',
      })}\n`);
      const event = await waitFor((entry) => entry.requestID === requestID && ['prepared', 'error'].includes(entry.type));
      expect(event.type).toBe('prepared');
      return event;
    };
    expect(await prepare('first', 'fixture-key-a')).toMatchObject({ cacheHit: false, agentID: 'fixture-agent-1' });
    expect(await prepare('same', 'fixture-key-a')).toMatchObject({ cacheHit: true, agentID: 'fixture-agent-1' });
    expect(await prepare('changed', 'fixture-key-b')).toMatchObject({ cacheHit: false, agentID: 'fixture-agent-2' });
    expect(await prepare('same-again', 'fixture-key-b')).toMatchObject({ cacheHit: true, agentID: 'fixture-agent-2' });
    expect(JSON.stringify(events)).not.toContain('fixture-key-');
    expect(stderr).not.toContain('fixture-key-');
  } finally {
    child?.kill('SIGKILL');
    if (closed) await closed;
    lines?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
