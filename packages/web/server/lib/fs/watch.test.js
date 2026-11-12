import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { registerFsRoutes } from './routes.js';
import { createFsWatchHandler, createFsWatchHub, isFsWatchEnabled } from './watch.js';
import { createDotenvVisibilityMiddleware } from '../multi-user/dotenv-visibility.js';

const fsPromises = fs.promises;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (predicate, timeoutMs = 4_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error('Timed out waiting for condition');
};

const createFakeWatch = () => {
  const watchers = [];
  let failNext = null;
  const watch = vi.fn((directory, _options, listener) => {
    if (failNext) {
      const code = failNext;
      failNext = null;
      throw Object.assign(new Error(code), { code });
    }
    const watcher = Object.assign(new EventEmitter(), { directory, listener, closed: false });
    watcher.close = vi.fn(() => { watcher.closed = true; });
    watchers.push(watcher);
    return watcher;
  });
  return {
    watch,
    watchers,
    failNextWith: (code) => { failNext = code; },
    emit: (directory, filename) => {
      for (const watcher of watchers) if (!watcher.closed && watcher.directory === directory) watcher.listener('rename', filename);
    },
  };
};

// Principal header: `<id>:<role>`; no header is the single-user local runtime.
const principalMiddleware = (req, _res, next) => {
  const raw = req.headers['x-test-principal'];
  if (typeof raw === 'string') {
    const [id, role] = raw.split(':');
    req.principal = { id, role, scope: 'managed' };
  }
  next();
};

describe('GET /api/fs/watch', () => {
  let scratch = '';
  let workspace = '';
  let outside = '';
  let configRoot = '';
  const servers = [];
  const streams = [];
  const hubs = [];

  beforeEach(async () => {
    scratch = await fsPromises.realpath(await fsPromises.mkdtemp(path.join(os.tmpdir(), 'devryan-fs-watch-')));
    workspace = path.join(scratch, 'workspace');
    outside = path.join(scratch, 'outside');
    configRoot = path.join(scratch, 'config');
    await Promise.all([workspace, outside, configRoot].map((dir) => fsPromises.mkdir(dir, { recursive: true })));
    await fsPromises.mkdir(path.join(workspace, 'src'));
    await fsPromises.mkdir(path.join(workspace, 'sub'));
    await fsPromises.writeFile(path.join(workspace, 'sub', 'file.txt'), 'one');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const stream of streams.splice(0)) stream.close();
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    })));
    for (const hub of hubs.splice(0)) hub.close();
    if (scratch) await fsPromises.rm(scratch, { recursive: true, force: true });
  });

  const startApp = async ({
    watch,
    resolveProjectDirectory = async () => ({ directory: workspace }),
    hubOptions = {},
    handlerOptions = {},
    dotenvMiddleware = false,
  } = {}) => {
    const hub = createFsWatchHub({ fsPromises, ...(watch ? { watch } : {}), ...hubOptions });
    hubs.push(hub);
    const app = express();
    app.use(principalMiddleware);
    if (dotenvMiddleware) app.use(createDotenvVisibilityMiddleware());
    registerFsRoutes(app, {
      os,
      path,
      fsPromises,
      spawn: vi.fn(),
      crypto: { randomUUID: () => 'job' },
      normalizeDirectoryPath: (value) => value,
      resolveProjectDirectory,
      buildAugmentedPath: () => '',
      resolveGitBinaryForSpawn: () => 'git',
      devryanUserConfigRoot: configRoot,
      fsWatch: { hub, isEnabled: () => true, heartbeatIntervalMs: 60_000, coalesceMs: 40, ...handlerOptions },
    });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    return { hub, server };
  };

  const openWatch = async (server, { directory = workspace, expanded = [], selected, extra = {}, principal } = {}) => {
    const params = new URLSearchParams({ directory });
    for (const entry of expanded) params.append('expanded', entry);
    if (selected !== undefined) params.set('selected', selected);
    for (const [key, value] of Object.entries(extra)) params.set(key, value);
    const { port } = server.address();
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/api/fs/watch?${params}`, {
      signal: controller.signal,
      headers: { Accept: 'text/event-stream', ...(principal ? { 'x-test-principal': principal } : {}) },
    });
    const stream = { response, events: [], heartbeats: 0, ended: false, close: () => controller.abort() };
    streams.push(stream);
    if (!(response.headers.get('content-type') || '').includes('text/event-stream')) {
      stream.body = await response.json();
      stream.ended = true;
      return stream;
    }
    void (async () => {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf('\n\n');
          while (boundary >= 0) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            if (block.startsWith(':')) stream.heartbeats += 1;
            const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
            if (data) stream.events.push(JSON.parse(data));
            boundary = buffer.indexOf('\n\n');
          }
        }
      } catch { /* Aborted by the test. */ }
      stream.ended = true;
    })();
    return stream;
  };

  const waitForEvent = async (stream, predicate, timeoutMs) => {
    await waitFor(() => stream.events.some(predicate), timeoutMs);
    return stream.events.find(predicate);
  };
  const isInvalidate = (kind, index) => (event) => event.type === 'invalidate' && event.slot.kind === kind
    && (index === undefined || event.slot.index === index);

  it('reports create, rename, delete and atomic saves through slot hints that name no files', async () => {
    const { server } = await startApp();
    const stream = await openWatch(server, { expanded: ['src'], selected: 'sub/file.txt' });
    expect(stream.response.status).toBe(200);
    const ready = await waitForEvent(stream, (event) => event.type === 'ready');
    expect(Number.isSafeInteger(ready.epoch)).toBe(true);

    await fsPromises.writeFile(path.join(workspace, 'created.txt'), 'x');
    await waitForEvent(stream, isInvalidate('root'));

    stream.events.length = 0;
    await fsPromises.writeFile(path.join(workspace, 'src', 'a.txt'), 'a');
    await waitForEvent(stream, isInvalidate('expanded', 0));
    stream.events.length = 0;
    await fsPromises.rename(path.join(workspace, 'src', 'a.txt'), path.join(workspace, 'src', 'b.txt'));
    await waitForEvent(stream, isInvalidate('expanded', 0));
    stream.events.length = 0;
    await fsPromises.rm(path.join(workspace, 'src', 'b.txt'));
    await waitForEvent(stream, isInvalidate('expanded', 0));

    // Two atomic saves in a row: the second proves the watch survived the inode swap.
    for (const content of ['two', 'three']) {
      stream.events.length = 0;
      const temp = path.join(workspace, 'sub', `.file.txt.${content}.tmp`);
      await fsPromises.writeFile(temp, content);
      await fsPromises.rename(temp, path.join(workspace, 'sub', 'file.txt'));
      await waitForEvent(stream, isInvalidate('selected'));
    }

    for (const event of stream.events) {
      expect(Object.keys(event).sort()).toEqual(expect.arrayContaining(['epoch', 'type']));
      expect(JSON.stringify(event)).not.toMatch(/file\.txt|created|a\.txt|b\.txt/);
      expect(event.epoch).toBe(ready.epoch);
    }
  });

  it('filters the selected parent by basename and treats a null filename as a generic hint', async () => {
    const fake = createFakeWatch();
    const { hub, server } = await startApp({ watch: fake.watch });
    // src is expanded only to carry the barrier below.
    const stream = await openWatch(server, { expanded: ['src'], selected: 'sub/file.txt' });
    await waitForEvent(stream, (event) => event.type === 'ready');
    // Root, the expanded directory and the selected file's parent; never the file itself.
    expect(fake.watch.mock.calls.map(([directory]) => directory).sort())
      .toEqual([workspace, path.join(workspace, 'src'), path.join(workspace, 'sub')].sort());
    expect(hub.getStats().handles).toBe(3);

    // A src event after the sibling is the barrier: one coalescing window flushes slots in the
    // order they were hinted, so any hint the sibling leaked (selected or root) arrives first.
    fake.emit(path.join(workspace, 'sub'), 'sibling.txt');
    fake.emit(path.join(workspace, 'src'), 'barrier');
    await waitForEvent(stream, isInvalidate('expanded', 0));
    expect(stream.events.filter((event) => event.type === 'invalidate').map((event) => event.slot.kind)).toEqual(['expanded']);
    stream.events.length = 0;

    fake.emit(path.join(workspace, 'sub'), null);
    await waitForEvent(stream, isInvalidate('selected'));
    fake.emit(workspace, null);
    await waitForEvent(stream, isInvalidate('root'));
  });

  it('coalesces bursts per slot and collapses an overflowing window into resync', async () => {
    const fake = createFakeWatch();
    const { server } = await startApp({ watch: fake.watch, handlerOptions: { burstLimit: 20 } });
    const stream = await openWatch(server, { expanded: ['src'] });
    await waitForEvent(stream, (event) => event.type === 'ready');
    for (let index = 0; index < 10; index += 1) fake.emit(workspace, `f${index}`);
    await waitForEvent(stream, isInvalidate('root'));
    // A later window on another slot is the barrier: any second flush of the burst was scheduled
    // before it with the same delay, so it would arrive first.
    fake.emit(path.join(workspace, 'src'), 'barrier');
    await waitForEvent(stream, isInvalidate('expanded', 0));
    expect(stream.events.filter(isInvalidate('root'))).toHaveLength(1);

    stream.events.length = 0;
    for (let index = 0; index < 30; index += 1) fake.emit(path.join(workspace, 'src'), `g${index}`);
    await waitForEvent(stream, (event) => event.type === 'resync');
    expect(stream.events.filter((event) => event.type === 'invalidate')).toEqual([]);
  });

  it('reopens a replaced root on heartbeat and resyncs', async () => {
    const { hub, server } = await startApp({ handlerOptions: { heartbeatIntervalMs: 60 } });
    const stream = await openWatch(server, { expanded: ['src'] });
    await waitForEvent(stream, (event) => event.type === 'ready');
    await fsPromises.rename(path.join(workspace, 'src'), path.join(workspace, 'src-old'));
    await fsPromises.mkdir(path.join(workspace, 'src'));
    await waitForEvent(stream, (event) => event.type === 'resync');
    expect(hub.getStats().openWatchers).toBe(2);
    stream.events.length = 0;
    await fsPromises.writeFile(path.join(workspace, 'src', 'new.txt'), 'n');
    await waitForEvent(stream, isInvalidate('expanded', 0));
    await waitFor(() => stream.heartbeats > 0);
  });

  it('re-authorizes on heartbeat and closes with unavailable when access is gone', async () => {
    let authorized = true;
    const { hub, server } = await startApp({
      handlerOptions: { heartbeatIntervalMs: 50 },
      resolveProjectDirectory: async () => (authorized ? { directory: workspace } : { directory: null, error: 'Directory is outside your assigned workspace' }),
    });
    const stream = await openWatch(server, { expanded: ['src'] });
    await waitForEvent(stream, (event) => event.type === 'ready');
    authorized = false;
    const unavailable = await waitForEvent(stream, (event) => event.type === 'unavailable');
    expect(unavailable.retryable).toBe(false);
    await waitFor(() => stream.ended);
    await waitFor(() => hub.getStats().handles === 0);
  });

  it('rejects the whole scope before streaming for traversal, symlinks and outside directories', async () => {
    await fsPromises.symlink(outside, path.join(workspace, 'link'));
    await fsPromises.writeFile(path.join(outside, 'secret.txt'), 's');
    const fake = createFakeWatch();
    const { server } = await startApp({ watch: fake.watch });
    const cases = [
      [{ expanded: ['src', 'link'] }, 403],
      [{ selected: 'link/secret.txt' }, 403],
      [{ expanded: ['src', '../outside'] }, 403],
      [{ expanded: [outside] }, 400],
      [{ directory: outside }, 400],
      [{ directory: outside, extra: { allowOutsideWorkspace: 'true' } }, 400],
      [{ directory: path.join(workspace, 'link') }, 403],
      [{ expanded: ['sub/file.txt'] }, 400],
      [{ selected: 'src' }, 400],
      [{ expanded: Array.from({ length: 64 }, (_, index) => `d${index}`) }, 400],
    ];
    for (const [scope, status] of cases) {
      const stream = await openWatch(server, scope);
      expect([JSON.stringify(scope), stream.response.status]).toEqual([JSON.stringify(scope), status]);
      expect(stream.response.headers.get('content-type')).toContain('application/json');
    }
    expect(fake.watch).not.toHaveBeenCalled();
  });

  it('confines managed callers to their assignment', async () => {
    const fake = createFakeWatch();
    const { server } = await startApp({
      watch: fake.watch,
      resolveProjectDirectory: async (req) => (req.query.directory === workspace
        ? { directory: workspace }
        : { directory: null, error: 'Directory is outside your assigned workspace' }),
    });
    const denied = await openWatch(server, { directory: outside, principal: 'dev-1:developer' });
    expect(denied.response.status).toBe(400);
    expect(denied.body.error).toBe('Directory is outside your assigned workspace');
    const allowed = await openWatch(server, { principal: 'dev-1:developer' });
    await waitForEvent(allowed, (event) => event.type === 'ready');
  });

  it('hides protected dotenv files per subscriber', async () => {
    await fsPromises.writeFile(path.join(workspace, '.env'), 'SECRET=1');
    await fsPromises.mkdir(path.join(workspace, '.env.d'));
    const fake = createFakeWatch();
    const { server } = await startApp({ watch: fake.watch, dotenvMiddleware: true });
    for (const scope of [{ selected: '.env' }, { expanded: ['.env.d'] }]) {
      const blocked = await openWatch(server, { ...scope, principal: 'dev-1:developer' });
      expect(blocked.response.status).toBe(404);
      expect(blocked.body).toEqual({ error: 'File not found' });
    }

    // The developer also expands src, whose events are the barrier for what the root watch sent.
    const developer = await openWatch(server, { expanded: ['src'], principal: 'dev-1:developer' });
    const admin = await openWatch(server, { selected: '.env', principal: 'admin-1:admin' });
    await waitForEvent(developer, (event) => event.type === 'ready');
    await waitForEvent(admin, (event) => event.type === 'ready');
    // One shared handle serves both subscribers.
    expect(fake.watch.mock.calls.filter(([directory]) => directory === workspace)).toHaveLength(1);

    fake.emit(workspace, '.env.local');
    await waitForEvent(admin, isInvalidate('root'));
    // A later window on the developer's src slot: a leaked root hint was scheduled before it with
    // the same delay, so it would arrive first.
    fake.emit(path.join(workspace, 'src'), 'barrier');
    await waitForEvent(developer, isInvalidate('expanded', 0));
    expect(developer.events.filter((event) => event.type === 'invalidate').map((event) => event.slot.kind)).toEqual(['expanded']);
    developer.events.length = 0;
    fake.emit(workspace, '.env');
    await waitForEvent(admin, isInvalidate('selected'));
    fake.emit(workspace, 'visible.ts');
    await waitForEvent(developer, isInvalidate('root'));
  });

  it('applies the route-level dotenv check even without the response middleware', async () => {
    await fsPromises.writeFile(path.join(workspace, '.env.local'), 'SECRET=1');
    const { server } = await startApp({ watch: createFakeWatch().watch });
    const blocked = await openWatch(server, { selected: '.env.local', principal: 'dev-1:senior_developer' });
    expect(blocked.response.status).toBe(404);
    expect(blocked.body).toEqual({ error: 'File not found' });
  });

  it('enforces shared handle and per-principal limits', async () => {
    for (const name of ['a', 'b', 'c', 'd']) await fsPromises.mkdir(path.join(workspace, name));
    const fake = createFakeWatch();
    const { hub, server } = await startApp({ watch: fake.watch, hubOptions: { maxHandles: 3, maxHandlesPerPrincipal: 2 } });
    const first = await openWatch(server, { expanded: ['a'], principal: 'u1:developer' });
    await waitForEvent(first, (event) => event.type === 'ready');
    const overShare = await openWatch(server, { expanded: ['b'], principal: 'u1:developer' });
    expect([overShare.response.status, overShare.body.code, overShare.body.retryable]).toEqual([503, 'fs_watch_capacity', true]);
    const shared = await openWatch(server, { expanded: ['a'], principal: 'u2:developer' });
    await waitForEvent(shared, (event) => event.type === 'ready');
    expect(fake.watch).toHaveBeenCalledTimes(2);
    const third = await openWatch(server, { directory: path.join(workspace, 'c'), principal: 'u3:developer' });
    await waitForEvent(third, (event) => event.type === 'ready');
    const overGlobal = await openWatch(server, { directory: path.join(workspace, 'd'), principal: 'u4:developer' });
    expect([overGlobal.response.status, overGlobal.body.code]).toEqual([503, 'fs_watch_capacity']);
    expect(hub.getStats()).toEqual({ handles: 3, openWatchers: 3, principals: { 'managed:u1': 2, 'managed:u2': 2, 'managed:u3': 1 } });

    first.close();
    shared.close();
    third.close();
    await waitFor(() => hub.getStats().handles === 0);
    expect(fake.watchers.every((watcher) => watcher.closed)).toBe(true);
  });

  it('falls back on ENOSPC and watcher errors and releases every handle', async () => {
    const fake = createFakeWatch();
    const { hub, server } = await startApp({ watch: fake.watch });
    fake.failNextWith('ENOSPC');
    const rejected = await openWatch(server, { expanded: ['src'] });
    expect([rejected.response.status, rejected.body.code, rejected.body.retryable]).toEqual([503, 'fs_watch_unavailable', true]);
    expect(hub.getStats().handles).toBe(0);

    const stream = await openWatch(server, { expanded: ['src'] });
    await waitForEvent(stream, (event) => event.type === 'ready');
    const rootWatcher = fake.watchers.find((watcher) => !watcher.closed && watcher.directory === workspace);
    rootWatcher.emit('error', Object.assign(new Error('overflow'), { code: 'EIO' }));
    await waitForEvent(stream, (event) => event.type === 'resync');
    expect(rootWatcher.closed).toBe(true);

    fake.failNextWith('ENOSPC');
    fake.watchers.find((watcher) => !watcher.closed && watcher.directory === workspace).emit('error', new Error('again'));
    const unavailable = await waitForEvent(stream, (event) => event.type === 'unavailable');
    expect(unavailable.retryable).toBe(true);
    await waitFor(() => stream.ended);
    await waitFor(() => hub.getStats().handles === 0);
    expect(fake.watchers.every((watcher) => watcher.closed)).toBe(true);
  });

  it('releases handles when the connection is revoked or the client disconnects', async () => {
    const fake = createFakeWatch();
    const { hub, server } = await startApp({ watch: fake.watch });
    const stream = await openWatch(server, { expanded: ['src'] });
    await waitForEvent(stream, (event) => event.type === 'ready');
    expect(hub.getStats().handles).toBe(2);
    // requireAuth's registerConnection revokes by destroying the socket.
    server.closeAllConnections();
    await waitFor(() => hub.getStats().handles === 0);
    expect(fake.watchers.every((watcher) => watcher.closed)).toBe(true);
  });

  it('answers unavailable when DEVRYAN_FS_WATCH=0 and defaults off on win32', async () => {
    expect(isFsWatchEnabled({ env: {}, platform: 'darwin' })).toBe(true);
    expect(isFsWatchEnabled({ env: {}, platform: 'win32' })).toBe(false);
    expect(isFsWatchEnabled({ env: { DEVRYAN_FS_WATCH: '1' }, platform: 'win32' })).toBe(true);
    expect(isFsWatchEnabled({ env: { DEVRYAN_FS_WATCH: '0' }, platform: 'linux' })).toBe(false);

    vi.stubEnv('DEVRYAN_FS_WATCH', '0');
    const fake = createFakeWatch();
    const { server } = await startApp({ watch: fake.watch, handlerOptions: { isEnabled: () => isFsWatchEnabled() } });
    const stream = await openWatch(server, { expanded: ['src'] });
    const unavailable = await waitForEvent(stream, (event) => event.type === 'unavailable');
    expect([unavailable.retryable, unavailable.reason]).toEqual([false, 'disabled']);
    await waitFor(() => stream.ended);
    expect(fake.watch).not.toHaveBeenCalled();
  });
});

describe('fs watch handler stream lifecycle', () => {
  const createContext = ({ write = () => true, writableLength = 0 } = {}) => {
    const release = vi.fn();
    let listener = null;
    const hub = {
      acquire: vi.fn(async (_key, directories, onSignal) => { listener = onSignal; return { directories, release }; }),
      verify: vi.fn(async () => {}),
    };
    const req = Object.assign(new EventEmitter(), { url: '/api/fs/watch?directory=/r', headers: {} });
    const res = Object.assign(new EventEmitter(), {
      headers: {}, chunks: [], statusCode: 0, destroyed: false, writableEnded: false, headersSent: false, writableLength,
      status(code) { this.statusCode = code; return this; },
      setHeader(key, value) { this.headers[key] = value; },
      json(body) { this.body = body; return this; },
      write(chunk) { this.chunks.push(chunk); return write(chunk); },
      end(chunk) { if (chunk) this.chunks.push(chunk); this.writableEnded = true; this.emit('close'); },
      destroy() { if (this.destroyed) return; this.destroyed = true; this.emit('close'); },
    });
    const handler = createFsWatchHandler({
      hub,
      isEnabled: () => true,
      coalesceMs: 5,
      heartbeatIntervalMs: 60_000,
      queueMaxBytes: 256,
      authorizeScope: async () => ({ ok: true, root: '/r', watches: [{ directory: '/r', slots: [{ kind: 'root' }], selectedBasename: null }] }),
    });
    return { req, res, hub, release, handler, signal: (...args) => listener?.(...args) };
  };

  it('closes on backpressure beyond the bound and releases the lease', async () => {
    const context = createContext({ write: () => false, writableLength: 10_000 });
    await context.handler(context.req, context.res);
    await waitFor(() => context.res.destroyed);
    expect(context.release).toHaveBeenCalledTimes(1);
  });

  it('cleans up idempotently across close, abort and error', async () => {
    const context = createContext();
    await context.handler(context.req, context.res);
    expect(context.res.chunks[0]).toMatch(/^data: \{"type":"ready","epoch":\d+\}\n\n$/);
    context.res.on('error', () => {});
    context.res.emit('close');
    context.req.emit('aborted');
    context.res.emit('error', new Error('late'));
    context.signal('/r', { kind: 'change', filename: 'x' });
    await sleep(20);
    expect(context.release).toHaveBeenCalledTimes(1);
    expect(context.res.chunks).toHaveLength(1);
  });

  it('releases a lease acquired after the client already left', async () => {
    const context = createContext();
    context.hub.acquire.mockImplementation(async (_key, directories) => {
      context.res.destroy();
      return { directories, release: context.release };
    });
    await context.handler(context.req, context.res);
    expect(context.release).toHaveBeenCalledTimes(1);
    expect(context.res.chunks).toEqual([]);
  });
});

describe('fs watch hub', () => {
  it('shares handles by directory and closes the watcher once on idempotent release', async () => {
    const scratch = await fsPromises.realpath(await fsPromises.mkdtemp(path.join(os.tmpdir(), 'devryan-fs-watch-hub-')));
    try {
      const fake = createFakeWatch();
      const hub = createFsWatchHub({ fsPromises, watch: fake.watch });
      const first = await hub.acquire('a', [scratch], () => {});
      const second = await hub.acquire('b', [scratch], () => {});
      expect(fake.watch).toHaveBeenCalledTimes(1);
      first.release();
      first.release();
      expect(fake.watchers[0].close).not.toHaveBeenCalled();
      second.release();
      second.release();
      expect(fake.watchers[0].close).toHaveBeenCalledTimes(1);
      expect(hub.getStats()).toEqual({ handles: 0, openWatchers: 0, principals: {} });
    } finally {
      await fsPromises.rm(scratch, { recursive: true, force: true });
    }
  });
});
