import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTerminalRuntime } from '../../packages/web/server/lib/terminal/runtime.js';

const file = fileURLToPath(import.meta.url);
if (process.argv[2] === '--fixture-child' || process.argv[2] === '--sentinel') {
  process.on('SIGHUP', () => {});
  process.on('SIGTERM', () => {});
  if (process.argv[3]) fs.writeFileSync(process.argv[3], String(process.pid));
  setInterval(() => {}, 1000);
} else {
  if (!['darwin', 'linux'].includes(process.platform)) {
    throw new Error(`Native PTY cleanup unavailable on ${process.platform}`);
  }
  const root = path.resolve(path.dirname(file), '../..');
  fs.mkdirSync(path.join(root, '.cache/qa'), { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, '.cache/qa/terminal-cleanup-'));
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const waitFor = async (predicate) => {
    const until = Date.now() + 5000;
    while (!predicate() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(predicate(), 'Native PTY fixture did not reach the expected state within 5 seconds');
  };
  const sentinel = spawn(process.execPath, [file, '--sentinel'], { cwd: directory, stdio: 'ignore', detached: true });
  const priorShell = process.env.OPENCHAMBER_TERMINAL_SHELL;
  process.env.OPENCHAMBER_TERMINAL_SHELL = '/bin/sh';
  try {
    for (const mode of ['stop', 'restart', 'shutdown']) {
      const routes = new Map();
      const app = { use() {}, ...Object.fromEntries(['post', 'get', 'delete'].map((method) => [method,
        (route, ...handlers) => routes.set(`${method}:${route}`, handlers.at(-1))])) };
      const runtime = createTerminalRuntime({ app, server: http.createServer(), fs, path,
        express: { text: () => (_req, _res, next) => next() },
        buildAugmentedPath: () => process.env.PATH, searchPathFor: () => null,
        isExecutable: (candidate) => candidate === '/bin/sh', isRequestOriginAllowed: async () => true,
        rejectWebSocketUpgrade() {}, TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS: 30000,
        TERMINAL_INPUT_WS_REBIND_WINDOW_MS: 1000, TERMINAL_INPUT_WS_MAX_REBINDS_PER_WINDOW: 3 });
      const invoke = async (method, route, req) => {
        const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
        await routes.get(`${method}:${route}`)(req, res);
        assert.equal(res.statusCode, 200, res.body?.error);
        return res.body;
      };
      let childPid;
      try {
        const { sessionId } = await invoke('post', '/api/terminal/create', { body: { cwd: directory } });
        const marker = path.join(directory, `${mode}.pid`);
        await invoke('post', '/api/terminal/:sessionId/input', { params: { sessionId },
          body: `${quote(process.execPath)} ${quote(file)} --fixture-child ${quote(marker)} &\n` });
        await waitFor(() => fs.existsSync(marker));
        childPid = Number(fs.readFileSync(marker, 'utf8'));
        assert.ok(Number.isSafeInteger(childPid) && childPid > 1 && childPid !== sentinel.pid);
        assert.ok(alive(childPid));
        if (mode === 'shutdown') await runtime.shutdown();
        else if (mode === 'restart') await invoke('post', '/api/terminal/:sessionId/restart', { params: { sessionId }, body: { cwd: directory } });
        else await invoke('delete', '/api/terminal/:sessionId', { params: { sessionId } });
        await waitFor(() => !alive(childPid));
        assert.ok(alive(sentinel.pid), 'Unrelated sentinel must survive terminal cleanup');
        console.log(`PASS native PTY ${mode}: descendant stopped, unrelated sentinel alive`);
      } finally {
        if (childPid && alive(childPid)) process.kill(childPid, 'SIGKILL');
        await runtime.shutdown();
      }
    }
  } finally {
    if (alive(sentinel.pid)) sentinel.kill('SIGKILL');
    if (priorShell === undefined) delete process.env.OPENCHAMBER_TERMINAL_SHELL;
    else process.env.OPENCHAMBER_TERMINAL_SHELL = priorShell;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
