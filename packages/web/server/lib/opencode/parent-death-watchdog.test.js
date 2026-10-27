import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const watchdogModule = new URL('./parent-death-watchdog.js', import.meta.url).href;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (predicate, timeoutMs = 8_000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) { if (predicate()) return true; await new Promise((resolve) => setTimeout(resolve, 10)); }
  return predicate();
};
const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

// A disposable "server" process owns a fake `serve --port N` child through the
// watchdog, reports both PIDs, then is SIGKILLed like a crashed Electron main.
const startOwner = async ({ port, nativeInstanceID, providerInstanceID, childArgs }) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-watchdog-'));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const script = path.join(directory, 'owner.mjs');
  await fs.writeFile(script, `
    import { spawn } from 'node:child_process';
    import { startParentDeathWatchdog } from ${JSON.stringify(watchdogModule)};
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', ...${JSON.stringify(childArgs)}],
      { detached: true, stdio: 'ignore' });
    child.unref();
    const watchdog = startParentDeathWatchdog({ childPid: child.pid, port: ${port}, nativeInstanceID: ${JSON.stringify(nativeInstanceID)}, providerInstanceID: ${JSON.stringify(providerInstanceID)} });
    process.stdout.write(JSON.stringify({ child: child.pid, watchdog: watchdog.pid }) + '\\n');
    setInterval(() => {}, 1000);
  `);
  const owner = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const line = await new Promise((resolve) => owner.stdout.once('data', (chunk) => resolve(chunk.toString())));
  const { child, watchdog } = JSON.parse(line);
  cleanups.push(() => { try { process.kill(-child, 'SIGKILL'); } catch { /* Gone. */ } });
  return { owner, child, watchdog };
};

describe.skipIf(process.platform === 'win32')('managed OpenCode parent-death watchdog', () => {
  it('reports a watchdog that could not be started instead of failing silently', async () => {
    const { startParentDeathWatchdog } = await import(watchdogModule);
    const throwing = startParentDeathWatchdog({ childPid: 4242, port: 47126,
      spawnImpl: () => { throw Object.assign(new Error('fork failed'), { code: 'EAGAIN' }); } });
    expect(throwing).toMatchObject({ pid: null, error: { code: 'managed_opencode_watchdog_unavailable', cause: 'EAGAIN' } });
    const kill = vi.fn();
    const unstarted = startParentDeathWatchdog({ childPid: 4242, port: 47126,
      spawnImpl: () => ({ on() {}, kill, pid: undefined }) });
    expect(unstarted).toMatchObject({ pid: null, error: { code: 'managed_opencode_watchdog_unavailable', cause: null } });
    expect(kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('stops the owned server group when its owner is killed', async () => {
    const { owner, child } = await startOwner({ port: 47123, childArgs: ['serve', '--hostname', '127.0.0.1', '--port', '47123'] });
    expect(alive(child)).toBe(true);
    owner.kill('SIGKILL');
    expect(await waitFor(() => !alive(child))).toBe(true);
  }, 15_000);

  it('stops only the exact owned provider worker nonce after parent death', async () => {
    const providerInstanceID = 'c'.repeat(32);
    const { owner, child } = await startOwner({ providerInstanceID, childArgs: ['--provider-worker', '--native-instance', providerInstanceID] });
    expect(alive(child)).toBe(true);
    owner.kill('SIGKILL');
    expect(await waitFor(() => !alive(child))).toBe(true);
  });

  it('never signals a process it cannot identify as the owned server', async () => {
    const { owner, child, watchdog } = await startOwner({ port: 47124, childArgs: ['serve', '--port', '47125'] });
    owner.kill('SIGKILL');
    // The watchdog exits without signalling when it cannot identify the child; wait for that verdict, not for time.
    expect(await waitFor(() => !alive(watchdog))).toBe(true);
    expect(alive(child)).toBe(true);
  }, 15_000);

  it('owns a native child before it binds a port using its exact private instance', async () => {
    const nativeInstanceID = 'a'.repeat(32);
    const { owner, child } = await startOwner({ nativeInstanceID, childArgs: ['serve', '--native-instance', nativeInstanceID] });
    owner.kill('SIGKILL');
    expect(await waitFor(() => !alive(child))).toBe(true);
    const other = await startOwner({ nativeInstanceID, childArgs: ['serve', '--native-instance', 'b'.repeat(32)] });
    other.owner.kill('SIGKILL');
    expect(await waitFor(() => !alive(other.watchdog))).toBe(true);
    expect(alive(other.child)).toBe(true);
  }, 15_000);

  // A cloudflared-like child identified by its exact argv rather than a port or nonce.
  const startCommandOwner = async ({ childArgs, watchedArgs }) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-watchdog-'));
    cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
    const script = path.join(directory, 'owner.mjs');
    await fs.writeFile(script, `
      import { spawn } from 'node:child_process';
      import { startCommandParentDeathWatchdog } from ${JSON.stringify(watchdogModule)};
      const argv = ['-e', 'setInterval(() => {}, 1000)', '--', ...${JSON.stringify(childArgs)}];
      const child = spawn(process.execPath, argv, { detached: true, stdio: 'ignore' });
      child.unref();
      const watchdog = startCommandParentDeathWatchdog({ childPid: child.pid,
        argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)', '--', ...${JSON.stringify(watchedArgs)}] });
      process.stdout.write(JSON.stringify({ child: child.pid, watchdog: watchdog.pid }) + '\\n');
      setInterval(() => {}, 1000);
    `);
    const owner = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
    const line = await new Promise((resolve) => owner.stdout.once('data', (chunk) => resolve(chunk.toString())));
    const { child, watchdog } = JSON.parse(line);
    cleanups.push(() => { try { process.kill(-child, 'SIGKILL'); } catch { /* Gone. */ } });
    return { owner, child, watchdog };
  };

  it('stops an argv-identified child when its owner is killed and leaves a different command alone', async () => {
    const args = ['tunnel', '--url', 'http://127.0.0.1:47127'];
    const { owner, child } = await startCommandOwner({ childArgs: args, watchedArgs: args });
    expect(alive(child)).toBe(true);
    owner.kill('SIGKILL');
    expect(await waitFor(() => !alive(child))).toBe(true);
    const other = await startCommandOwner({ childArgs: ['tunnel', '--url', 'http://127.0.0.1:47128'], watchedArgs: args });
    other.owner.kill('SIGKILL');
    expect(await waitFor(() => !alive(other.watchdog))).toBe(true);
    expect(alive(other.child)).toBe(true);
  }, 15_000);

  it('reports an argv watchdog that could not be started and skips invalid identities', async () => {
    const { startCommandParentDeathWatchdog } = await import(watchdogModule);
    expect(startCommandParentDeathWatchdog({ childPid: 4242, argv: ['cloudflared', 'tunnel', 'run'], code: 'cloudflared_watchdog_unavailable',
      spawnImpl: () => { throw Object.assign(new Error('fork failed'), { code: 'EAGAIN' }); } }))
      .toMatchObject({ pid: null, error: { code: 'cloudflared_watchdog_unavailable', cause: 'EAGAIN' } });
    const spawnImpl = vi.fn();
    for (const argv of [[], ['cloudflared', 'line\nbreak'], ['cloudflared', '']]) {
      expect(startCommandParentDeathWatchdog({ childPid: 4242, argv, spawnImpl })).toMatchObject({ pid: null });
    }
    expect(startCommandParentDeathWatchdog({ childPid: 4242, argv: ['cloudflared'], platform: 'win32', spawnImpl })).toMatchObject({ pid: null });
    expect(spawnImpl).not.toHaveBeenCalled();
  });
});
