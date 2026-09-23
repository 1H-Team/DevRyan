import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const watchdogModule = new URL('./parent-death-watchdog.js', import.meta.url).href;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (predicate, timeoutMs = 8_000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) { if (predicate()) return true; await new Promise((resolve) => setTimeout(resolve, 50)); }
  return predicate();
};
const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

// A disposable "server" process owns a fake `serve --port N` child through the
// watchdog, reports both PIDs, then is SIGKILLed like a crashed Electron main.
const startOwner = async ({ port, childArgs }) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-watchdog-'));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const script = path.join(directory, 'owner.mjs');
  await fs.writeFile(script, `
    import { spawn } from 'node:child_process';
    import { startParentDeathWatchdog } from ${JSON.stringify(watchdogModule)};
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', ...${JSON.stringify(childArgs)}],
      { detached: true, stdio: 'ignore' });
    child.unref();
    startParentDeathWatchdog({ childPid: child.pid, port: ${port} });
    process.stdout.write(JSON.stringify({ child: child.pid }) + '\\n');
    setInterval(() => {}, 1000);
  `);
  const owner = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const line = await new Promise((resolve) => owner.stdout.once('data', (chunk) => resolve(chunk.toString())));
  const { child } = JSON.parse(line);
  cleanups.push(() => { try { process.kill(-child, 'SIGKILL'); } catch { /* Gone. */ } });
  return { owner, child };
};

describe.skipIf(process.platform === 'win32')('managed OpenCode parent-death watchdog', () => {
  it('stops the owned server group when its owner is killed', async () => {
    const { owner, child } = await startOwner({ port: 47123, childArgs: ['serve', '--hostname', '127.0.0.1', '--port', '47123'] });
    expect(alive(child)).toBe(true);
    owner.kill('SIGKILL');
    expect(await waitFor(() => !alive(child))).toBe(true);
  }, 15_000);

  it('never signals a process it cannot identify as the owned server', async () => {
    const { owner, child } = await startOwner({ port: 47124, childArgs: ['serve', '--port', '47125'] });
    owner.kill('SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(alive(child)).toBe(true);
  }, 15_000);
});
