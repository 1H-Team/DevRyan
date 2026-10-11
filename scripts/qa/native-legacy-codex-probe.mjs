// Attended live probe, never part of deterministic validation or installed-account discovery.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRunRoot } from './run-root.mjs';
import { createQaHostLaunchEnvironment } from './launch-environment.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
if (process.argv[2] !== '--child') {
  assert.equal(process.argv.length, 2, 'This attended probe takes no credential/profile arguments');
  const run = createRunRoot({ parent: path.join(repository, '.cache/sessions/2026-10-11-native-legacy-codex'),
    prefix: 'probe-', owner: 'scripts/qa/native-legacy-codex-probe.mjs', signals: 'exit' });
  const runtime = path.join(run.dir, 'runtime');
  const globals = Object.fromEntries(['home', 'config', 'data', 'state', 'cache', 'tmp', 'bin', 'log', 'repos'].map(key => [key, path.join(runtime, key)]));
  for (const value of Object.values(globals)) await fs.mkdir(value, { recursive: true, mode: 0o700 });
  const child = spawn('bun', [fileURLToPath(import.meta.url), '--child', run.dir], { cwd: repository, stdio: 'inherit',
    env: createQaHostLaunchEnvironment({ HOME: globals.home, XDG_CONFIG_HOME: globals.config, XDG_DATA_HOME: globals.data,
      XDG_STATE_HOME: globals.state, XDG_CACHE_HOME: globals.cache, TMPDIR: globals.tmp,
      OPENCODE_CONFIG_DIR: globals.config, GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: runtime }) });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  const code = await new Promise(resolve => child.once('exit', code => resolve(code ?? 130)));
  // OAuth material is disposable even when a provider rejects the probe.
  await fs.rm(runtime, { recursive: true, force: true });
  run.finish(code === 0 ? 'passed' : code === 130 ? 'interrupted' : 'failed');
  process.exitCode = code;
} else {
  const root = await fs.realpath(process.argv[3]);
  assert.ok(root.startsWith(path.join(repository, '.cache/sessions/2026-10-11-native-legacy-codex') + path.sep));
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'run.json'), 'utf8'));
  assert.equal(manifest.owner, 'scripts/qa/native-legacy-codex-probe.mjs');
  const runtime = path.join(root, 'runtime');
  const globals = Object.fromEntries(['home', 'config', 'data', 'state', 'cache', 'tmp', 'bin', 'log', 'repos'].map(key => [key, path.join(runtime, key)]));
  assert.equal(process.env.HOME, globals.home);
  const workspace = path.join(runtime, 'workspace');
  await fs.mkdir(path.join(workspace, '.git'), { recursive: true, mode: 0o700 });
  // The native browser method tries to cancel an existing listener: never let it touch another owner.
  await new Promise((resolve, reject) => {
    const server = net.createServer(); server.once('error', () => reject(Error('legacy_callback_port_busy')));
    server.listen(1455, 'localhost', () => server.close(resolve));
  });
  const { Effect, Layer, Logger } = await import('effect');
  const { Global } = await import('@opencode/util/global');
  const { Credential } = await import('@opencode/core/credential');
  const { Plugin } = await import('@opencode/core/plugin');
  const { Integration } = await import('@opencode/core/integration');
  const { Location } = await import('@opencode/core/location');
  const { EmbeddedHost } = await import('../../packages/web/node_modules/@opencode/sdk/dist/internal/host.js');
  const { configurationOverrides } = await import('../../packages/web/server/lib/opencode/runtime-host/configuration.ts');
  let credentials, plugins, integration, location;
  const model = { providerID: 'openai', id: 'gpt-5.5' };
  const configuration = { model: 'openai/gpt-5.5', providers: { openai: { package: '@opencode/ai/providers/openai', env: [],
    settings: { transport: 'http' }, models: { 'gpt-5.5': { capabilities: { tools: true, input: ['text'], output: ['text'] },
      limit: { context: 400000, input: 272000, output: 4096 } } } } }, agents: { build: { mode: 'primary', model: 'openai/gpt-5.5' } } };
  const quiet = action => action.pipe(Effect.provide(Logger.layer([], { mergeWithExisting: false })));
  const host = await Effect.runPromise(quiet(EmbeddedHost.create({ database: { path: path.join(runtime, 'opencode.db') },
    config: { project: false }, models: { fetch: false, snapshot: false }, fs: { filewatcher: false, fff: false }, events: { persist: false } },
  { overrides: [Global.node.replace(Global.layerWith(globals)), ...configurationOverrides(configuration),
    Credential.node.replace(Credential.node.mapLayer(original => Layer.effect(Credential.Service, Effect.gen(function* () {
      credentials = yield* Credential.Service; return credentials;
    })).pipe(Layer.provide(original)))),
    Plugin.node.replace(Plugin.node.mapLayer(original => Layer.effect(Plugin.Service, Effect.gen(function* () {
      plugins = yield* Plugin.Service; return plugins;
    })).pipe(Layer.provide(original)))),
    Integration.node.replace(Integration.node.mapLayer(original => Layer.effect(Integration.Service, Effect.gen(function* () {
      location = yield* Location.Service; integration = yield* Integration.Service; return integration;
    })).pipe(Layer.provide(original))))] })));
  const call = async (route, method = 'GET', body) => {
    const response = await host.fetch(new Request('http://127.0.0.1' + route + '?directory=' + encodeURIComponent(workspace), {
      method, headers: { 'content-type': 'application/json', 'x-opencode-directory': encodeURIComponent(workspace) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    assert.ok(response.ok, `native_route_refused_${response.status}`);
    const value = await response.json(); return value?.location && Object.hasOwn(value, 'data') ? value.data : value;
  };
  const report = { qualification: 'isolated-native-sdk-live-provider-probe', nativeVersion: '2.0.26', methodID: 'chatgpt-browser',
    transport: 'http', enrollment: 'pending', chat: 'not-run', usage: 'not-run', installedStateAccess: false };
  let attempt;
  try {
    report.stage = 'native_catalog';
    await call('/api/agent');
    report.stage = 'native_plugin_activation';
    await host.runtime.runPromise(quiet(plugins.awaitActivation));
    report.stage = 'native_integration_catalog';
    await call('/api/integration/openai');
    report.stage = 'native_enrollment_start';
    attempt = await call('/api/integration/openai/connect/oauth', 'POST', { methodID: 'chatgpt-browser' });
    assert.equal(attempt.mode, 'auto');
    const url = new URL(attempt.url); assert.equal(url.origin, 'https://auth.openai.com');
    process.stdout.write(JSON.stringify({ status: 'awaiting-consent', url: url.href, evidence: root }) + '\n');
    const deadline = Date.now() + 10 * 60 * 1000;
    let status;
    do {
      status = await call('/api/integration/openai/connect/oauth/' + attempt.attemptID);
      if (status.status !== 'pending') break;
      await new Promise(resolve => setTimeout(resolve, 1500));
    } while (Date.now() < deadline);
    report.enrollment = status.status;
    assert.equal(status.status, 'complete', 'legacy_enrollment_incomplete');
    report.stage = 'credential_selection';
    const selected = await host.runtime.runPromise(quiet(integration.connection.active('openai').pipe(Effect.provideService(Location.Service, location))));
    assert.equal(selected?.type, 'credential');
    const record = await host.runtime.runPromise(quiet(credentials.get(selected.id)));
    assert.equal(record?.integrationID, 'openai');
    const value = record.value;
    assert.equal(value.type, 'oauth'); assert.equal(value.methodID, 'chatgpt-browser');
    assert.ok(value.expires > Date.now());
    report.stage = 'usage';
    const headers = { Authorization: `Bearer ${value.access}`, 'Content-Type': 'application/json' };
    if (typeof value.metadata?.accountID === 'string') headers['ChatGPT-Account-Id'] = value.metadata.accountID;
    const usage = await fetch('https://chatgpt.com/backend-api/wham/usage', { headers, redirect: 'error', signal: AbortSignal.timeout(20000) });
    report.usageStatus = usage.status;
    const reader = usage.body?.getReader(), chunks = []; let size = 0;
    try { if (reader) for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; assert.ok(size <= 64 * 1024, 'usage_response_too_large'); chunks.push(value); } }
    finally { await reader?.cancel().catch(() => {}); }
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    report.usageWindowsPresent = [payload.rate_limit?.primary_window, payload.rate_limit?.secondary_window]
      .filter(window => Number.isFinite(window?.used_percent) && [18000, 604800].includes(window?.limit_window_seconds)).length;
    report.usage = usage.ok && report.usageWindowsPresent >= 1 ? 'passed' : 'failed';
    report.weeklyWindowPresent = [payload.rate_limit?.primary_window, payload.rate_limit?.secondary_window].some(window => Number.isFinite(window?.used_percent) && window?.limit_window_seconds === 604800);
    report.stage = 'chat';
    const session = await host.runtime.runPromise(quiet(host.sessions.create({ location: { directory: workspace }, model })));
    const text = await host.runtime.runPromise(quiet(host.sessions.generate({ sessionID: session.id,
      prompt: 'Reply with exactly LEGACY_CODEX_PROBE_OK.' }).pipe(Effect.timeout('90 seconds'))));
    report.chat = text.trim() === 'LEGACY_CODEX_PROBE_OK' ? 'passed' : 'failed';
    assert.equal(report.chat, 'passed', 'legacy_chat_failed'); assert.equal(report.usage, 'passed', 'legacy_usage_failed');
    process.stdout.write(JSON.stringify(report) + '\n');
  } catch (error) {
    report.failureCode = /^native_route_refused_\d+$/.test(error.message) ? error.message : error.name;
    report.result = 'incomplete-or-failed'; process.stdout.write(JSON.stringify(report) + '\n'); process.exitCode = 1;
  } finally {
    if (attempt) await call('/api/integration/openai/connect/oauth/' + attempt.attemptID, 'DELETE').catch(() => {});
    await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    await host.close();
  }
}
