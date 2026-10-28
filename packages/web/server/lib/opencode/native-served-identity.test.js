import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSessionMutationRuntime } from '@devryan/harness-runtime/lib/session-mutations.js';
import { git } from '@devryan/harness-runtime/lib/session-changes-git.js';
import { EXECUTION_VIEW_ENV, executionViewMarker } from '@devryan/harness-runtime/lib/session-execution.js';
import { browserOpenTargets, createServedIdentity, loopbackPorts, previewStaleMessage, publicServedIdentity, servedFreshness } from './native-served-identity.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe('loopback addresses a call names', () => {
  it('finds loopback URLs and host:port pairs, with default ports, and nothing else', () => {
    expect(loopbackPorts('PLAYWRIGHT_BASE_URL=http://127.0.0.1:8090 npx playwright test && curl localhost:5173/health')).toEqual([8090, 5173]);
    expect(loopbackPorts('curl http://localhost/ https://localhost/ ws://[::1]:9229 http://0.0.0.0:3000')).toEqual([80, 443, 9229, 3000]);
    expect(loopbackPorts('vite --host localhost --port 4173; curl https://example.com:8443 http://mylocalhost:1 localhost.example.com:2')).toEqual([]);
    expect(loopbackPorts('curl http://127.0.0.1:99999 http://localhost:0')).toEqual([]);
    expect(loopbackPorts(Array.from({ length: 12 }, (_, index) => `localhost:${3000 + index}`).join(' '))).toHaveLength(8);
    expect(loopbackPorts(undefined)).toEqual([]);
  });

  it('reads the URLs devryan_browser would open, alone or in a sequence', () => {
    expect(browserOpenTargets({ command: 'open', args: ['--headed', 'http://localhost:8090/booking'] })).toBe('http://localhost:8090/booking');
    expect(browserOpenTargets({ command: 'sequence', steps: [{ command: 'open', args: ['http://127.0.0.1:3000'] },
      { command: 'click', args: ['http://localhost:9999'] }, { command: 'OPEN', args: ['localhost:4173'] }] })).toBe('http://127.0.0.1:3000\nlocalhost:4173');
    expect(browserOpenTargets({ command: 'open' })).toBe('');
    expect(browserOpenTargets({ command: 'snapshot', args: ['http://localhost:1'] })).toBe('');
  });
});

describe('who serves a port', () => {
  const view = { token: 'lease_a', directory: '/project', sessionID: 'ses_a', callID: 'call_a' };
  const marker = executionViewMarker(view.token);
  const exec = (outputs) => async (command, args) => {
    const output = outputs[command];
    if (output instanceof Error) throw output;
    return typeof output === 'function' ? output(args) : output ?? '';
  };

  it('ties a listener to the lease that started it and asks the ledger whether its view is current', async () => {
    const asked = [];
    const resolve = createServedIdentity({ platform: 'darwin', views: new Map([[marker, view]]),
      freshness: async (entry) => { asked.push(entry); return { state: 'stale', behind: 2 }; },
      exec: exec({ lsof: (args) => { expect(args).toEqual(['-nP', '-iTCP:8090', '-sTCP:LISTEN', '-Fpn']); return 'p4242\nf12\nn127.0.0.1:8090\n'; },
        // A command line that spells the marker does not hide the environment's value.
        ps: (args) => { expect(args).toEqual(['-E', '-ww', '-o', 'command=', '-p', '4242']); return `node serve.js ${EXECUTION_VIEW_ENV}=0000000000000000 PATH=/bin ${EXECUTION_VIEW_ENV}=${marker}\n`; } }) });
    const target = await resolve(8090);
    expect(target).toEqual({ port: 8090, pid: 4242, identity: 'owned', sessionID: 'ses_a', callID: 'call_a', view, freshness: 'stale', behind: 2 });
    expect(asked).toEqual([view]);
    expect(publicServedIdentity([target])).toEqual([{ port: 8090, pid: 4242, identity: 'owned', sessionID: 'ses_a', callID: 'call_a', freshness: 'stale', behind: 2 }]);
    expect(previewStaleMessage(target)).toMatch(/^preview_stale: the server on port 8090 was started by call call_a .* 2 changes have been published since/);
    expect(previewStaleMessage({ ...target, behind: 1 })).toContain('1 change has been published since');
  });

  it('names external, orphaned, absent and unresolvable listeners without guessing their freshness', async () => {
    const views = new Map([[marker, view]]), freshness = async () => ({ state: 'fresh' });
    expect(await createServedIdentity({ platform: 'darwin', views, freshness, exec: exec({ lsof: 'p77\nn*:3000\n', ps: '/usr/bin/python3 -m http.server\n' }) })(3000))
      .toEqual({ port: 3000, pid: 77, identity: 'external', freshness: 'unknown' });
    expect(await createServedIdentity({ platform: 'darwin', views, freshness, exec: exec({ lsof: 'p78\nn*:3000\n', ps: `node ${EXECUTION_VIEW_ENV}=${'f'.repeat(16)}\n` }) })(3000))
      .toEqual({ port: 3000, pid: 78, identity: 'orphaned', freshness: 'unknown' });
    expect(await createServedIdentity({ platform: 'darwin', views, freshness, exec: exec({ lsof: '' }) })(3000)).toEqual({ port: 3000, identity: 'none' });
    expect(await createServedIdentity({ platform: 'darwin', views, freshness, exec: exec({ lsof: Object.assign(new Error('missing'), { code: 'ENOENT' }) }) })(3000))
      .toEqual({ port: 3000, identity: 'unresolved', freshness: 'unknown' });
    expect(await createServedIdentity({ platform: 'win32', views, freshness, exec: exec({}) })(3000)).toEqual({ port: 3000, identity: 'external', freshness: 'unknown' });
    // A ledger that cannot answer leaves an owned server unknown.
    expect(await createServedIdentity({ platform: 'darwin', views, freshness: async () => { throw new Error('busy'); },
      exec: exec({ lsof: 'p79\nn*:3000\n', ps: `node ${EXECUTION_VIEW_ENV}=${marker}\n` }) })(3000)).toMatchObject({ identity: 'owned', freshness: 'unknown' });
  });

  it('reads the marker from /proc on Linux', async () => {
    const resolve = createServedIdentity({ platform: 'linux', views: new Map([[marker, view]]), freshness: async () => ({ state: 'fresh' }),
      exec: exec({ lsof: 'p91\nn127.0.0.1:5173\n' }),
      readFile: async (file) => { expect(file).toBe('/proc/91/environ'); return Buffer.from(`PATH=/bin\0${EXECUTION_VIEW_ENV}=${marker}\0HOME=/tmp\0`); } });
    expect(await resolve(5173)).toMatchObject({ identity: 'owned', callID: 'call_a', freshness: 'fresh' });
  });

  it('summarizes a call: stale beats unknown beats fresh; a port nothing listens on is the call\'s own server', () => {
    expect(servedFreshness([])).toBeUndefined();
    expect(servedFreshness([{ identity: 'none' }])).toBe('fresh');
    expect(servedFreshness([{ identity: 'owned', freshness: 'fresh' }, { identity: 'none' }])).toBe('fresh');
    expect(servedFreshness([{ identity: 'owned', freshness: 'fresh' }, { identity: 'external', freshness: 'unknown' }])).toBe('unknown');
    expect(servedFreshness([{ identity: 'external', freshness: 'unknown' }, { identity: 'owned', freshness: 'stale' }])).toBe('stale');
  });
});

// The required regression with real processes, real lsof/ps and the real
// ledger: a server started in one call's view is stale once another call
// publishes a change, and a server started afterwards serves the change.
describe.skipIf(process.platform !== 'darwin')('a server started in an earlier call', () => {
  const serve = async (directory, token) => {
    const child = spawn(process.execPath, ['-e', `
      const http = require('node:http'), fs = require('node:fs');
      const server = http.createServer((request, response) => response.end(fs.readFileSync('fixture.txt')));
      server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'));
      process.stdin.on('end', () => process.exit(0)); process.stdin.resume();`],
    { cwd: directory, env: { ...process.env, [EXECUTION_VIEW_ENV]: executionViewMarker(token) }, stdio: ['pipe', 'pipe', 'inherit'] });
    cleanups.push(async () => { child.stdin.end(); child.kill(); await new Promise((resolve) => child.exitCode !== null ? resolve() : child.once('exit', resolve)); });
    const port = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('exit', (code) => reject(new Error(`server exited ${code}`)));
      child.stdout.once('data', (data) => resolve(Number(String(data).trim())));
    });
    return port;
  };

  it('is refused as stale after a later publication; a fresh server serves the new content', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-served-')));
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const directory = path.join(root, 'project');
    await fs.mkdir(directory); await git(directory, ['init', '--quiet']);
    await fs.writeFile(path.join(directory, 'fixture.txt'), 'before');
    await git(directory, ['add', 'fixture.txt']);
    await git(directory, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
    const runtime = createSessionMutationRuntime({ directory: path.join(root, 'private') });
    cleanups.push(() => runtime.drain());
    const begin = (sessionID, callID) => runtime.begin({ directory, sessionID, userMessageID: `msg_${callID}`, messageID: `msg_${callID}_assistant`, callID });
    const finish = async (lease) => {
      await fs.writeFile(path.join(path.dirname(lease.viewDirectory), 'termination.json'),
        JSON.stringify({ terminated: true, confined: true, cancelled: false, exitCode: 0 }), { flag: 'wx', mode: 0o600 });
      await runtime.claimLease({ directory, token: lease.token, kind: 'process' });
      return runtime.finish({ directory, token: lease.token });
    };
    const views = new Map();
    const remember = (lease, sessionID, callID) => views.set(executionViewMarker(lease.token), { token: lease.token, directory, sessionID, callID });
    const resolve = createServedIdentity({ views, freshness: (view) => runtime.viewFreshness({ directory: view.directory, token: view.token }) });

    // Job A serves fixture.txt from its view, like a background dev server.
    const a = await begin('ses_designer', 'call_a'); remember(a, 'ses_designer', 'call_a');
    const portA = await serve(a.viewDirectory, a.token);
    expect(await resolve(portA)).toMatchObject({ identity: 'owned', callID: 'call_a', freshness: 'fresh' });

    // Job B publishes a change to the file A serves.
    const b = await begin('ses_fixer', 'call_b');
    await fs.writeFile(path.join(b.viewDirectory, 'fixture.txt'), 'after');
    expect((await finish(b)).files).toEqual([{ path: 'fixture.txt', status: 'modified' }]);
    expect(await fs.readFile(path.join(directory, 'fixture.txt'), 'utf8')).toBe('after');

    // A still answers with the old bytes, and is now identified as stale,
    // whichever way a check names it (browser URL or PLAYWRIGHT_BASE_URL).
    expect(await (await fetch(`http://127.0.0.1:${portA}/`)).text()).toBe('before');
    for (const text of [browserOpenTargets({ command: 'open', args: [`http://localhost:${portA}/`] }),
      `PLAYWRIGHT_BASE_URL=http://127.0.0.1:${portA} npx playwright test`]) {
      const [port] = loopbackPorts(text);
      const target = await resolve(port);
      expect(target).toMatchObject({ identity: 'owned', callID: 'call_a', freshness: 'stale', behind: 1 });
      expect(previewStaleMessage(target)).toContain(`port ${portA} was started by call call_a`);
    }

    // A fresh call starts its own server: current, and it serves the change.
    const c = await begin('ses_fixer', 'call_c'); remember(c, 'ses_fixer', 'call_c');
    const portC = await serve(c.viewDirectory, c.token);
    expect(await resolve(portC)).toMatchObject({ identity: 'owned', callID: 'call_c', freshness: 'fresh' });
    expect(await (await fetch(`http://127.0.0.1:${portC}/`)).text()).toBe('after');
  }, 60_000);
});
