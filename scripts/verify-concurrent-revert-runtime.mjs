import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { reservePort, startOwnedProcess } from './qa/process.mjs';
import { git } from '../packages/harness-runtime/lib/session-changes-git.js';
import { createSessionMutationRuntime } from '../packages/harness-runtime/lib/session-mutations.js';
import { createSessionExecutionOwner } from '../packages/harness-runtime/lib/session-execution-owner.js';
import { verifySessionExecutionLauncher } from '../packages/harness-runtime/lib/session-execution.js';
import { createScopedRevertCoordinator } from '../packages/web/server/lib/opencode/session-revert-coordinator.js';
import { registerScopedSessionRevertRoute } from '../packages/web/server/lib/opencode/session-scoped-revert.js';

// Explicit native acceptance check. This never uses a running app, credentials,
// or a provider: noReply creates real legacy messages without generating text.
const binary = process.env.DEVRYAN_TEST_OPENCODE_BINARY;
const launcher = process.env.DEVRYAN_TEST_EXECUTION_LAUNCHER;
if (!path.isAbsolute(binary ?? '') || !await verifySessionExecutionLauncher({ launcher })) {
  throw new Error('Set DEVRYAN_TEST_OPENCODE_BINARY and DEVRYAN_TEST_EXECUTION_LAUNCHER to the built compatible artifacts');
}
const express = createRequire(new URL('../packages/web/package.json', import.meta.url))('express');
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-native-revert-')));
const directory = path.join(root, 'project');
const port = await reservePort();
const origin = `http://127.0.0.1:${port}`;
const childEnv = { PATH: process.env.PATH, HOME: path.join(root, 'home'),
  XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
  XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state'),
  OPENCODE_TEST_HOME: path.join(root, 'home'), OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(root, 'managed'),
  OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true',
  OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true', OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
  OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: 'true',
  OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [], mcp: {}, snapshot: false }),
};
let upstream, server, writer;
const cancel = new AbortController();
const launch = () => startOwnedProcess(binary, ['serve', '--hostname', '127.0.0.1', '--port', String(port), '--print-logs', '--log-level', 'ERROR'], {
  cwd: directory, env: childEnv,
});
const request = async (route, body, base = origin) => {
  const url = new URL(route, base); url.searchParams.set('directory', directory);
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
  const value = await response.json();
  assert.equal(response.status, 200, `${route}: ${JSON.stringify(value)}`);
  return value;
};
const ready = async () => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    upstream.check();
    try {
      const capability = await request('/session/revert-capabilities');
      assert.equal(capability.legacyConversationRevert, 1); return;
    } catch (cause) {
      if (cause.code === 'ERR_ASSERTION') throw cause;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('Compatible runtime readiness timed out');
};
try {
  await fs.mkdir(directory); await fs.mkdir(childEnv.HOME); await git(directory, ['init', '--quiet']);
  const file = path.join(directory, 'example'); await fs.writeFile(file, 'a=1; b=2');
  upstream = launch(); await ready();
  const a = await request('/session', { title: 'Disposable rollback A' });
  const b = await request('/session', { title: 'Disposable rollback B' });
  const message = (id) => request(`/session/${id}/message`, { noReply: true,
    model: { providerID: 'opencode', modelID: 'big-pickle' }, parts: [{ type: 'text', text: 'Disposable ownership fixture' }] });
  const pa = await message(a.id), pb = await message(b.id);
  const runtime = createSessionMutationRuntime({ directory: path.join(root, 'ledger') });
  const executions = createSessionExecutionOwner({ runtime, launcher, verifyLauncher: verifySessionExecutionLauncher,
    stopSessions: async ({ sessions }) => {
      for (const id of sessions) await request(`/session/${id}/abort`, {});
      const statuses = await request('/session/status');
      if (sessions.some((id) => statuses[id] && statuses[id].type !== 'idle')) throw new Error('Native task has not stopped');
      return { terminated: true, sessions };
    } });
  const scope = (session, prompt) => ({ directory, sessionID: session.id, userMessageID: prompt.info.id,
    messageID: prompt.info.id, callID: `fixture_${prompt.info.id}`, command: process.execPath,
    env: { PATH: process.env.PATH }, signal: cancel.signal });
  await executions.execute({ ...scope(a, pa), args: ['-e', "require('node:fs').writeFileSync('example', 'a=3; b=2')"] });
  const started = Promise.withResolvers(); const release = path.join(root, 'release');
  writer = executions.execute({ ...scope(b, pb), args: ['-e', `const fs = require('node:fs');
    const base = fs.readFileSync('example', 'utf8'); console.log('ready');
    const timer = setInterval(() => { if (!fs.existsSync(${JSON.stringify(release)})) return;
      clearInterval(timer); fs.writeFileSync('example', base.replace('b=2', 'b=4')); }, 10);`],
    onOutput: ({ data }) => { if (data.toString().includes('ready')) started.resolve(); } });
  writer.catch(started.reject);
  await Promise.race([started.promise, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Native writer readiness timed out')), 15_000); timer.unref();
    void started.promise.then(() => clearTimeout(timer), () => clearTimeout(timer));
  })]);
  const coordinator = createScopedRevertCoordinator({ runtime, executions, openchamberDataDir: root,
    buildOpenCodeUrl: (route) => origin + route });
  const app = express(); registerScopedSessionRevertRoute(app, { sessionRevertCoordinator: coordinator });
  server = await new Promise((resolve) => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const route = `/api/openchamber/session/${a.id}`;
  const reverted = await request(`${route}/scoped-revert`, { messageID: pa.info.id }, base);
  assert.equal(reverted.session.revert.fileRestore, false);
  assert.equal(await fs.readFile(file, 'utf8'), 'a=1; b=2');
  await fs.writeFile(release, 'go'); await writer;
  assert.equal(await fs.readFile(file, 'utf8'), 'a=1; b=4');
  await upstream.stop(); upstream = launch(); await ready();
  assert.equal((await request(`/session/${a.id}`)).revert.fileRestore, false);
  const redone = await request(`${route}/scoped-unrevert`, {}, base);
  assert.equal(await fs.readFile(file, 'utf8'), 'a=3; b=4');
  assert.deepEqual((await request(`${route}/scoped-unrevert`, {}, base)).verification, redone.verification);
  await request(`${route}/scoped-revert`, { messageID: pa.info.id }, base);
  await message(a.id); // Real legacy cleanup must not restore files.
  assert.equal(await fs.readFile(file, 'utf8'), 'a=1; b=4');
  console.log('PASS: compatible legacy HTTP rollback, concurrent native command, durable restart, Redo retry, and prompt cleanup');
} catch (cause) {
  // This fixture's environment and messages contain no credentials or user data.
  console.error(upstream?.getLog());
  throw cause;
} finally {
  cancel.abort(); await writer?.catch(() => {});
  if (server) await new Promise((resolve) => server.close(resolve));
  await upstream?.stop(); await fs.rm(root, { recursive: true, force: true });
}
