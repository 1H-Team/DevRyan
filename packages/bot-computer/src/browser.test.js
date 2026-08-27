import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, test } from 'bun:test';
import {
  ComputerBrowserError,
  clearStaleChromiumStartupArtifacts,
  createBrowserController,
  REVIEWED_BROWSER_COMMANDS,
} from './browser.js';
import { createAccessibilityRefStore } from './refs.js';
import { createControlLeaseManager } from './control.js';
import { createScreencastBroker } from './screencast.js';

describe('Chromium startup artifact cleanup', () => {
  test('removes only disposable singleton and CDP artifacts before relaunch', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-browser-artifacts-'));
    const outside = path.join(directory, '..', `${path.basename(directory)}-outside`);
    try {
      await fs.writeFile(outside, 'preserve');
      await fs.writeFile(path.join(directory, 'DevToolsActivePort'), 'stale');
      await fs.writeFile(path.join(directory, 'SingletonCookie'), 'stale');
      await fs.symlink(outside, path.join(directory, 'SingletonLock'));
      await fs.writeFile(path.join(directory, 'SingletonSocket'), 'stale');
      await fs.writeFile(path.join(directory, 'Preferences'), 'authoritative');

      await clearStaleChromiumStartupArtifacts({ profileDirectory: directory });

      for (const filename of ['DevToolsActivePort', 'SingletonCookie', 'SingletonLock', 'SingletonSocket']) {
        await expect(fs.lstat(path.join(directory, filename))).rejects.toMatchObject({ code: 'ENOENT' });
      }
      expect(await fs.readFile(path.join(directory, 'Preferences'), 'utf8')).toBe('authoritative');
      expect(await fs.readFile(outside, 'utf8')).toBe('preserve');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
      await fs.rm(outside, { force: true });
    }
  });
});

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0xff, 0xd9]);

const fixture = () => {
  const calls = [];
  let pageHandler = () => undefined;
  let healthy = true;
  const terminationHandlers = new Set();
  const driver = {
    isHealthy: () => healthy,
    onTerminated: (handler) => {
      terminationHandlers.add(handler);
      return () => terminationHandlers.delete(handler);
    },
    setPageChangeHandler: (handler) => { pageHandler = handler; },
    startScreencast: async (onFrame) => {
      calls.push(['startScreencast']);
      onFrame(jpeg, { width: 10, height: 10 });
      return async () => calls.push(['stopScreencast']);
    },
    navigate: async (url) => calls.push(['navigate', url]),
    snapshot: async () => [{ backendNodeId: 12, role: 'button', name: 'Save' }],
    click: async (node) => calls.push(['click', node.backendNodeId]),
    fill: async (node, text) => calls.push(['fill', node.backendNodeId, text]),
    select: async (node, value) => calls.push(['select', node.backendNodeId, value]),
    key: async (key) => calls.push(['key', key]),
    scroll: async (value) => calls.push(['scroll', value]),
    upload: async (node, filePath) => calls.push(['upload', node.backendNodeId, filePath]),
    screenshot: async () => jpeg,
    close: async () => {
      healthy = false;
      calls.push(['close']);
    },
  };
  const refs = createAccessibilityRefStore({ randomBytes: () => Buffer.alloc(8, 5) });
  const control = createControlLeaseManager();
  const workspace = {
    stageUpload: async () => ({ path: '/workspace/input.txt', filename: 'input.txt', size: 4 }),
    publishDownload: async () => ({ artifactId: 'artifact-01', filename: 'out.txt', size: 4 }),
  };
  const profiles = { resetProfile: async ({ closeBrowser }) => { await closeBrowser(); return { reset: true }; } };
  const screencast = createScreencastBroker();
  const controller = createBrowserController({
    launchDriver: async () => { calls.push(['launch']); return driver; },
    refs,
    control,
    workspace,
    profiles,
    screencast,
  });
  return { controller, calls, refs, control, screencast, pageChanged: () => pageHandler() };
};

const recoveryFixture = () => {
  const calls = [];
  const drivers = [];
  const refs = createAccessibilityRefStore({ randomBytes: () => Buffer.alloc(8, 6) });
  const control = createControlLeaseManager();
  const workspace = {
    stageUpload: async () => ({ path: '/workspace/input.txt', filename: 'input.txt', size: 4 }),
    publishDownload: async () => ({ artifactId: 'artifact-01', filename: 'out.txt', size: 4 }),
  };
  const profiles = { resetProfile: async ({ closeBrowser }) => closeBrowser() };
  const screencast = createScreencastBroker();
  let releaseSecondLaunch = null;
  let holdSecondLaunch = false;

  const makeDriver = (number) => {
    let healthy = true;
    let failSnapshot = false;
    let failClick = false;
    const terminationHandlers = new Set();
    const terminate = (code = 'DEVRYAN_BOT_BROWSER_CLOSED') => {
      healthy = false;
      for (const handler of terminationHandlers) handler(code);
    };
    const driver = {
      number,
      isHealthy: () => healthy,
      onTerminated: (handler) => {
        terminationHandlers.add(handler);
        return () => terminationHandlers.delete(handler);
      },
      setPageChangeHandler: () => {},
      startScreencast: async () => async () => {},
      navigate: async () => {},
      async snapshot() {
        calls.push(['snapshot', number]);
        if (failSnapshot) {
          failSnapshot = false;
          terminate();
          throw new ComputerBrowserError(
            'fixture connection closed',
            'DEVRYAN_BOT_BROWSER_CLOSED',
            503,
          );
        }
        return [{ backendNodeId: number, role: 'button', name: `Save ${number}` }];
      },
      async click() {
        calls.push(['click', number]);
        if (failClick) {
          failClick = false;
          terminate();
          throw new ComputerBrowserError(
            'fixture connection closed',
            'DEVRYAN_BOT_BROWSER_CLOSED',
            503,
          );
        }
      },
      fill: async () => {},
      select: async () => {},
      key: async () => {},
      scroll: async () => {},
      upload: async () => {},
      screenshot: async () => jpeg,
      async close() {
        calls.push(['close', number]);
        terminate();
      },
      terminate,
      failNextSnapshot: () => { failSnapshot = true; },
      failNextClick: () => { failClick = true; },
      notifyLateTermination: () => {
        for (const handler of terminationHandlers) handler('DEVRYAN_BOT_BROWSER_CLOSED');
      },
    };
    return driver;
  };

  const controller = createBrowserController({
    async launchDriver() {
      const number = drivers.length + 1;
      calls.push(['launch', number]);
      if (number === 2 && holdSecondLaunch) {
        await new Promise((resolve) => { releaseSecondLaunch = resolve; });
      }
      const driver = makeDriver(number);
      drivers.push(driver);
      return driver;
    },
    refs,
    control,
    workspace,
    profiles,
    screencast,
  });
  return {
    controller,
    calls,
    drivers,
    holdSecondLaunch() { holdSecondLaunch = true; },
    releaseSecondLaunch() { releaseSecondLaunch?.(); },
  };
};

describe('reviewed computer browser commands', () => {
  test('exposes the exact reviewed command inventory and no JavaScript evaluation', () => {
    expect(REVIEWED_BROWSER_COMMANDS).toEqual([
      'navigate', 'snapshot', 'click', 'fill', 'select', 'key', 'scroll', 'wait',
      'upload', 'download', 'screenshot', 'close',
    ]);
    expect(REVIEWED_BROWSER_COMMANDS).not.toContain('evaluate');
    expect(REVIEWED_BROWSER_COMMANDS).not.toContain('javascript');
  });

  test('uses accessibility refs for interaction and invalidates them on page change', async () => {
    const { controller, calls, pageChanged } = fixture();
    await controller.execute('navigate', { url: 'https://example.com/login' });
    const snapshot = await controller.execute('snapshot', {});
    await controller.execute('click', { ref: snapshot.nodes[0].ref });
    expect(calls).toContainEqual(['click', 12]);
    pageChanged();
    await expect(controller.execute('click', { ref: snapshot.nodes[0].ref }))
      .rejects.toMatchObject({ code: 'DEVRYAN_BOT_REF_STALE' });
  });

  test('routes upload/download through the workspace gateway and returns bounded screenshots', async () => {
    const { controller, calls } = fixture();
    const snapshot = await controller.execute('snapshot', {});
    await controller.execute('upload', {
      ref: snapshot.nodes[0].ref,
      artifactId: 'artifact-01',
      filename: 'input.txt',
    });
    expect(calls).toContainEqual(['upload', 12, '/workspace/input.txt']);
    expect(await controller.execute('download', { filename: 'out.txt' })).toMatchObject({
      artifactId: 'artifact-01',
    });
    expect(await controller.execute('screenshot', { format: 'jpeg', quality: 70 })).toMatchObject({
      mimeType: 'image/jpeg',
      bytes: jpeg.byteLength,
    });
  });

  test('pauses agent commands during human control and closes before profile reset', async () => {
    const { controller, control, calls } = fixture();
    const lease = control.take({ actorId: 'user-01', actorType: 'user' });
    let completed = false;
    const pending = controller.execute('snapshot', {}).then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    control.returnControl({ actorId: 'user-01', actorType: 'user', leaseId: lease.leaseId });
    await pending;
    await controller.resetProfile();
    expect(calls).toContainEqual(['close']);
  });

  test('starts capture for the first viewer and stops it after the last viewer', async () => {
    const { controller, calls, screencast } = fixture();
    expect(controller.status().running).toBe(false);
    expect(calls).not.toContainEqual(['startScreencast']);

    const firstFrames = [];
    const secondFrames = [];
    const closeFirst = await controller.subscribeScreencast((frame) => firstFrames.push(frame));
    const closeSecond = await controller.subscribeScreencast((frame) => secondFrames.push(frame));

    expect(calls.filter(([kind]) => kind === 'launch')).toHaveLength(1);
    expect(controller.status().running).toBe(true);
    expect(calls.filter(([kind]) => kind === 'startScreencast')).toHaveLength(1);
    expect(screencast.snapshot().subscribers).toBe(2);
    expect(firstFrames).toHaveLength(1);
    await closeFirst();
    expect(calls).not.toContainEqual(['stopScreencast']);
    await closeSecond();
    expect(calls.filter(([kind]) => kind === 'stopScreencast')).toHaveLength(1);
    expect(screencast.snapshot().subscribers).toBe(0);
  });

  test('rejects arbitrary commands and unexpected argument fields', async () => {
    const { controller } = fixture();
    await expect(controller.execute('evaluate', { script: 'document.cookie' }))
      .rejects.toMatchObject({ code: 'DEVRYAN_BOT_BROWSER_COMMAND_DENIED' });
    await expect(controller.execute('navigate', { url: 'https://example.com', script: 'x' }))
      .rejects.toMatchObject({ code: 'DEVRYAN_BOT_BROWSER_INPUT_INVALID' });
  });

  test('fails an already-aborted wait without starting a timer', async () => {
    const { controller } = fixture();
    const abort = new AbortController();
    abort.abort();
    await expect(controller.execute('wait', { milliseconds: 30_000 }, { signal: abort.signal }))
      .rejects.toMatchObject({ code: 'DEVRYAN_BOT_COMMAND_ABORTED', statusCode: 499 });
  });

  test('relaunches once for a safe read after unexpected CDP closure', async () => {
    const harness = recoveryFixture();
    await harness.controller.execute('snapshot', {});
    harness.drivers[0].failNextSnapshot();

    const recovered = await harness.controller.execute('snapshot', {});

    expect(recovered.nodes[0].name).toBe('Save 2');
    expect(harness.calls.filter(([kind]) => kind === 'launch')).toHaveLength(2);
    expect(harness.controller.status()).toMatchObject({
      running: true,
      healthy: true,
      launching: false,
      generation: 2,
      lastFailureCode: null,
    });
    harness.drivers[0].notifyLateTermination();
    expect(harness.controller.status()).toMatchObject({ running: true, healthy: true, generation: 2 });
  });

  test('never replays a mutating command after browser transport loss', async () => {
    const harness = recoveryFixture();
    const snapshot = await harness.controller.execute('snapshot', {});
    harness.drivers[0].failNextClick();

    await expect(harness.controller.execute('click', { ref: snapshot.nodes[0].ref }))
      .rejects.toMatchObject({ code: 'DEVRYAN_BOT_BROWSER_CLOSED' });
    expect(harness.calls.filter(([kind]) => kind === 'click')).toHaveLength(1);
    expect(harness.calls.filter(([kind]) => kind === 'launch')).toHaveLength(1);

    await harness.controller.execute('snapshot', {});
    expect(harness.calls.filter(([kind]) => kind === 'launch')).toHaveLength(2);
    expect(harness.calls.filter(([kind]) => kind === 'click')).toHaveLength(1);
  });

  test('singleflights relaunch when concurrent reads arrive after a crash', async () => {
    const harness = recoveryFixture();
    await harness.controller.execute('snapshot', {});
    harness.holdSecondLaunch();
    harness.drivers[0].terminate();

    const reads = Promise.all(Array.from({ length: 4 }, () => (
      harness.controller.execute('snapshot', {})
    )));
    await Promise.resolve();
    expect(harness.calls.filter(([kind]) => kind === 'launch')).toHaveLength(2);
    harness.releaseSecondLaunch();
    await reads;

    expect(harness.calls.filter(([kind]) => kind === 'launch')).toHaveLength(2);
    expect(harness.controller.status()).toMatchObject({ running: true, healthy: true, generation: 2 });
  });
});

if (process.env.DEVRYAN_RUN_BROWSER_TESTS === '1') {
  const execFileAsync = promisify(execFile);
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const integrationToken = 'fixture-runtime-token-0123456789abcdef0123456789';

  const docker = async (...args) => execFileAsync('docker', args, {
    cwd: repositoryRoot,
    maxBuffer: 50 * 1024 * 1024,
  });

  const readBody = async (request) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    return Buffer.concat(chunks);
  };

  const startFixtureSite = async () => {
    let publishedDownload = null;
    const server = http.createServer(async (request, response) => {
      const target = new URL(request.url, 'http://fixture.invalid');
      const authorized = request.headers.authorization === `Bearer ${integrationToken}`;
      if (request.method === 'GET'
        && target.pathname === '/api/bots/private/artifacts/artifact-upload/content') {
        if (!authorized) {
          response.writeHead(401).end();
          return;
        }
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('private upload bytes');
        return;
      }
      if (request.method === 'POST' && target.pathname === '/api/bots/private/artifacts') {
        if (!authorized || request.headers['x-devryan-filename'] !== 'browser-download.txt') {
          response.writeHead(401).end();
          return;
        }
        publishedDownload = await readBody(request);
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, artifact: { id: 'artifact-download' } }));
        return;
      }
      if (request.method === 'POST' && target.pathname === '/login') {
        await readBody(request);
        response.writeHead(303, {
          location: '/private',
          'set-cookie': 'fixture_session=accepted; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax',
        });
        response.end();
        return;
      }
      if (request.method === 'GET' && target.pathname === '/private') {
        const signedIn = String(request.headers.cookie || '').includes('fixture_session=accepted');
        response.writeHead(signedIn ? 200 : 302, {
          'content-type': 'text/html; charset=utf-8',
          ...(signedIn ? {} : { location: '/login' }),
        });
        response.end(signedIn
          ? '<!doctype html><title>Private</title><h1>Signed in</h1>'
          : '');
        return;
      }
      if (request.method === 'GET' && target.pathname === '/login') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><title>Login</title><form method="post" action="/login"><label for="username">Username</label><input id="username" name="username" autocomplete="username"><button type="submit">Sign in</button></form>');
        return;
      }
      if (request.method === 'GET' && target.pathname === '/next') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><title>Next</title><h1>Next page</h1>');
        return;
      }
      if (request.method === 'GET' && target.pathname === '/files') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><title>Files</title><label for="upload">Upload file</label><input id="upload" type="file"><a href="/browser-download">Download fixture</a>');
        return;
      }
      if (request.method === 'GET' && target.pathname === '/browser-download') {
        response.writeHead(200, {
          'content-type': 'text/plain',
          'content-disposition': 'attachment; filename="browser-download.txt"',
        });
        response.end('browser download bytes');
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
    const address = server.address();
    return Object.freeze({
      gatewayUrl: `http://host.docker.internal:${address.port}`,
      publishedDownload: () => publishedDownload,
      close: () => new Promise((resolve, reject) => server.close((error) => (
        error ? reject(error) : resolve()
      ))),
    });
  };

  const requestComputer = async ({ baseUrl, pathname = '/v1/command', body }) => {
    const transferCommand = ['upload', 'download'].includes(body?.command);
    const response = await fetch(`${baseUrl}${pathname}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${integrationToken}`,
        'content-type': 'application/json',
        ...(transferCommand ? { 'x-devryan-gateway-token': integrationToken } : {}),
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    return Object.freeze({ response, payload });
  };

  const commandComputer = async (baseUrl, command, args) => (
    requestComputer({ baseUrl, body: { command, args } })
  );

  const receiveFirstScreencastFrame = (baseUrl) => new Promise((resolve, reject) => {
    const target = new URL('/v1/screencast', baseUrl);
    const timer = setTimeout(() => {
      request.destroy();
      reject(new Error('Timed out waiting for the first Docker screencast frame'));
    }, 15_000);
    const request = http.request({
      host: target.hostname,
      port: target.port,
      path: target.pathname,
      headers: { authorization: `Bearer ${integrationToken}` },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => {
        chunks.push(chunk);
        const received = Buffer.concat(chunks);
        if (!received.includes(Buffer.from('Content-Type: image/jpeg'))) return;
        clearTimeout(timer);
        response.destroy();
        resolve({ statusCode: response.statusCode, headers: response.headers, chunk: received });
      });
    });
    request.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.end();
  });

  const waitForScreencastStop = async (baseUrl) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const response = await fetch(`${baseUrl}/v1/status`, {
        headers: { authorization: `Bearer ${integrationToken}` },
      });
      const payload = await response.json();
      if (payload?.browser?.screencastSubscribers === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Docker screencast did not stop after viewer disconnect');
  };

  const findRef = (snapshot, name) => {
    const node = snapshot.payload.result.nodes.find((candidate) => candidate.name === name);
    if (!node) throw new Error(`Fixture accessibility node was not found: ${name}`);
    return node.ref;
  };

  describe('Docker fixture Chromium integration', () => {
    test('persists login, fences refs, arbitrates control, transfers files, resets, and flushes', async () => {
      const suffix = crypto.randomUUID().replaceAll('-', '');
      const image = `devryan/bot-computer:fixture-${suffix}`;
      const container = `devryan-bot-computer-fixture-${suffix}`;
      const profileVolume = `${container}-profile`;
      const scratchVolume = `${container}-scratch`;
      const fixtureSite = await startFixtureSite();
      let containerExists = false;
      let imageExists = false;
      let volumesExist = false;

      const stopContainer = async () => {
        if (!containerExists) return null;
        await docker('stop', '--time', '15', container);
        const { stdout } = await docker('inspect', '--format', '{{.State.ExitCode}}', container);
        await docker('rm', container);
        containerExists = false;
        return Number(stdout.trim());
      };

      const startContainer = async (runId) => {
        await docker(
          'run', '--detach', '--name', container,
          '--init', '--read-only', '--user', '10001:10001',
          '--security-opt', 'no-new-privileges:true', '--cap-drop', 'ALL',
          '--pids-limit', '512', '--memory', '3g', '--cpus', '2', '--shm-size', '1g',
          '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m,mode=1777',
          '--tmpfs', '/run:rw,noexec,nosuid,size=16m,mode=755',
          '--add-host', 'host.docker.internal:host-gateway',
          '--publish', '127.0.0.1::43122',
          '--volume', `${profileVolume}:/data/chromium:rw`,
          '--volume', `${scratchVolume}:/workspace:rw`,
          '--env', `DEVRYAN_BOT_RUNTIME_TOKEN=${integrationToken}`,
          '--env', `DEVRYAN_BOT_RUN_ID=${runId}`,
          '--env', 'DEVRYAN_BOT_SCOPE_MODE=team',
          '--env', `DEVRYAN_BOT_GATEWAY_URL=${fixtureSite.gatewayUrl}`,
          image,
        );
        containerExists = true;
        const { stdout } = await docker('port', container, '43122/tcp');
        const port = Number(/:(\d+)\s*$/.exec(stdout)?.[1]);
        if (!Number.isInteger(port)) throw new Error('Fixture computer port was not published');
        const baseUrl = `http://127.0.0.1:${port}`;
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          try {
            if ((await fetch(`${baseUrl}/healthz`)).ok) return baseUrl;
          } catch {
            // Chromium is lazy, but the Node command service still needs a moment to bind.
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error('Fixture computer service did not become healthy');
      };

      const chromiumProcessCount = async () => {
        const script = [
          "const fs=require('node:fs')",
          "let count=0",
          "for(const name of fs.readdirSync('/proc')){",
          "if(!/^\\d+$/.test(name))continue",
          "try{const executable=fs.readlinkSync('/proc/'+name+'/exe')",
          "const value=fs.readFileSync('/proc/'+name+'/cmdline','utf8')",
          "if(executable.endsWith('/chromium')&&!value.includes('--type='))count+=1}catch{}",
          "}",
          "process.stdout.write(String(count))",
        ].join(';');
        const { stdout } = await docker('exec', container, 'node', '-e', script);
        return Number(stdout.trim());
      };

      const killChromium = async () => {
        const script = [
          "const fs=require('node:fs')",
          "const targets=[]",
          "for(const name of fs.readdirSync('/proc')){",
          "if(!/^\\d+$/.test(name))continue",
          "try{const executable=fs.readlinkSync('/proc/'+name+'/exe')",
          "if(executable.endsWith('/chromium'))targets.push(Number(name))}catch{}",
          "}",
          "for(const pid of targets){try{process.kill(pid,'SIGKILL')}catch{}}",
          "if(targets.length<1)process.exit(2)",
        ].join(';');
        await docker('exec', container, 'node', '-e', script);
      };

      const computerStatus = async (baseUrl) => {
        const response = await fetch(`${baseUrl}/v1/status`, {
          headers: { authorization: `Bearer ${integrationToken}` },
        });
        return response.json();
      };

      try {
        await docker(
          'build', '--quiet', '--file', 'packages/bot-computer/Dockerfile',
          '--tag', image, '.',
        );
        imageExists = true;
        await docker('volume', 'create', profileVolume);
        await docker('volume', 'create', scratchVolume);
        volumesExist = true;

        let baseUrl = await startContainer('run-fixture-01');
        await commandComputer(baseUrl, 'navigate', { url: `${fixtureSite.gatewayUrl}/login` });
        const login = await commandComputer(baseUrl, 'snapshot', {});
        await commandComputer(baseUrl, 'fill', { ref: findRef(login, 'Username'), text: 'agent' });
        await commandComputer(baseUrl, 'click', { ref: findRef(login, 'Sign in') });
        await commandComputer(baseUrl, 'wait', { milliseconds: 500 });
        await commandComputer(baseUrl, 'navigate', { url: `${fixtureSite.gatewayUrl}/private` });
        const signedIn = await commandComputer(baseUrl, 'snapshot', {});
        expect(signedIn.payload.result.nodes.some((node) => node.name === 'Signed in')).toBe(true);
        await commandComputer(baseUrl, 'close', {});
        await commandComputer(baseUrl, 'navigate', { url: `${fixtureSite.gatewayUrl}/private` });
        const persistedBeforeCrash = await commandComputer(baseUrl, 'snapshot', {});
        expect(persistedBeforeCrash.payload.result.nodes.some((node) => node.name === 'Signed in'))
          .toBe(true);
        const beforeCrash = await computerStatus(baseUrl);
        expect(beforeCrash.browser).toMatchObject({ running: true, healthy: true, generation: 2 });
        expect(await chromiumProcessCount()).toBe(1);

        await killChromium();
        expect((await commandComputer(
          baseUrl,
          'navigate',
          { url: `${fixtureSite.gatewayUrl}/private` },
        )).response.status).toBe(200);
        const recovered = await commandComputer(baseUrl, 'snapshot', {});
        expect(recovered.payload.result.nodes.some((node) => node.name === 'Signed in')).toBe(true);
        expect((await computerStatus(baseUrl)).browser).toMatchObject({
          running: true,
          healthy: true,
          generation: 3,
          lastFailureCode: null,
        });
        expect(await chromiumProcessCount()).toBe(1);

        await killChromium();
        const concurrentRecovery = await Promise.all(Array.from({ length: 4 }, () => (
          commandComputer(baseUrl, 'screenshot', { format: 'jpeg', quality: 60 })
        )));
        expect(concurrentRecovery.every(({ response }) => response.status === 200)).toBe(true);
        expect((await computerStatus(baseUrl)).browser).toMatchObject({
          running: true,
          healthy: true,
          generation: 4,
        });
        expect(await chromiumProcessCount()).toBe(1);
        await commandComputer(baseUrl, 'navigate', { url: `${fixtureSite.gatewayUrl}/private` });
        const persistedAfterRepeatedRecovery = await commandComputer(baseUrl, 'snapshot', {});
        expect(persistedAfterRepeatedRecovery.payload.result.nodes
          .some((node) => node.name === 'Signed in')).toBe(true);

        const firstFrame = await receiveFirstScreencastFrame(baseUrl);
        expect(firstFrame.statusCode).toBe(200);
        expect(firstFrame.headers['content-type']).toContain('multipart/x-mixed-replace');
        expect(firstFrame.chunk.includes(Buffer.from('Content-Type: image/jpeg'))).toBe(true);
        await waitForScreencastStop(baseUrl);

        const staleRef = findRef(signedIn, 'Signed in');
        await commandComputer(baseUrl, 'navigate', { url: `${fixtureSite.gatewayUrl}/next` });
        const stale = await commandComputer(baseUrl, 'click', { ref: staleRef });
        expect(stale.response.status).toBe(409);
        expect(stale.payload.error.code).toBe('DEVRYAN_BOT_REF_STALE');

        const firstLease = await requestComputer({
          baseUrl,
          pathname: '/v1/control/take',
          body: { actorId: 'user-01', actorType: 'user' },
        });
        const concurrentLease = await requestComputer({
          baseUrl,
          pathname: '/v1/control/take',
          body: { actorId: 'user-02', actorType: 'user' },
        });
        expect(concurrentLease.response.status).toBe(409);
        const paused = commandComputer(baseUrl, 'snapshot', {});
        expect(await Promise.race([
          paused.then(() => 'completed'),
          new Promise((resolve) => setTimeout(() => resolve('paused'), 150)),
        ])).toBe('paused');
        await requestComputer({
          baseUrl,
          pathname: '/v1/control/return',
          body: {
            actorId: 'user-01',
            actorType: 'user',
            leaseId: firstLease.payload.lease.leaseId,
          },
        });
        expect((await paused).response.status).toBe(200);

        await commandComputer(baseUrl, 'navigate', { url: `${fixtureSite.gatewayUrl}/files` });
        const files = await commandComputer(baseUrl, 'snapshot', {});
        await commandComputer(baseUrl, 'upload', {
          ref: findRef(files, 'Upload file'),
          artifactId: 'artifact-upload',
          filename: 'private-upload.txt',
        });
        await commandComputer(baseUrl, 'click', { ref: findRef(files, 'Download fixture') });
        await commandComputer(baseUrl, 'wait', { milliseconds: 1_000 });
        const downloaded = await commandComputer(baseUrl, 'download', {
          filename: 'browser-download.txt',
        });
        expect(downloaded.response.status).toBe(200);
        expect(downloaded.payload.ok).toBe(true);
        expect(downloaded.payload.result.artifactId).toBe('artifact-download');
        expect(fixtureSite.publishedDownload()?.toString('utf8')).toBe('browser download bytes');

        expect(await stopContainer()).toBe(0);
        baseUrl = await startContainer('run-fixture-02');
        await commandComputer(baseUrl, 'navigate', { url: `${fixtureSite.gatewayUrl}/private` });
        const persisted = await commandComputer(baseUrl, 'snapshot', {});
        expect(persisted.payload.result.nodes.some((node) => node.name === 'Signed in')).toBe(true);
        expect((await commandComputer(baseUrl, 'download', {
          filename: 'browser-download.txt',
        })).response.status).toBe(200);

        const reset = await requestComputer({
          baseUrl,
          pathname: '/v1/profile/reset',
          body: { confirm: true },
        });
        expect(reset.response.status).toBe(200);
        await commandComputer(baseUrl, 'navigate', { url: `${fixtureSite.gatewayUrl}/private` });
        const loggedOut = await commandComputer(baseUrl, 'snapshot', {});
        expect(loggedOut.payload.result.nodes.some((node) => node.name === 'Username')).toBe(true);
        expect(await stopContainer()).toBe(0);
      } finally {
        if (containerExists) await docker('rm', '--force', container).catch(() => undefined);
        if (volumesExist) {
          await docker('volume', 'rm', '--force', profileVolume, scratchVolume).catch(() => undefined);
        }
        if (imageExists) await docker('image', 'rm', '--force', image).catch(() => undefined);
        await fixtureSite.close();
      }
    }, 300_000);
  });
}
