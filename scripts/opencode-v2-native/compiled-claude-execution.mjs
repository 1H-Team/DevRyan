import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createNativeProviderProcess } from '../../packages/web/server/lib/opencode/runtime-host/native-provider-process.js';
import { verifyNativeRuntimeArtifacts } from '../../packages/web/server/lib/opencode/runtime-host/native-artifacts.js';
import { readQaPinnedFile, qaHash } from '../qa/live-setup-mirror.mjs';
import { createRunRoot, scratchParent } from '../qa/run-root.mjs';
import { createQaHostLaunchEnvironment } from '../qa/launch-environment.mjs';

const finalText = 'DevRyan compiled Claude final.';
const deadline = async (work, milliseconds, label) => {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); })]); }
  finally { clearTimeout(timer); }
};

export function compiledClaudeReply(body, { held = false } = {}) {
  const usage = { input_tokens: 16, output_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const message = { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: finalText }], stop_reason: 'end_turn', stop_sequence: null, usage };
  if (!body.stream && !held) return { type: 'application/json', body: JSON.stringify(message) };
  const events = [
    { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { ...usage, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: held ? 'Active synthetic response.' : finalText } },
    ...held ? [] : [{ type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } }, { type: 'message_stop' }],
  ];
  return { type: 'text/event-stream', body: events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('') };
}

export async function readCompiledClaudeLeases(home) {
  const file = path.join(home, '.cache/meridian/session-gc.json');
  const value = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(value.version, 2); assert.ok(value.resources && typeof value.resources === 'object' && !Array.isArray(value.resources));
  return Object.values(value.resources).flatMap(resource => Object.values(resource.activeLeases ?? {}));
}

/** Real compiled provider, transformed Meridian, SDK and confined Claude binary.
 * Only the remote Anthropic response is synthetic; no credentials or stores are read. */
export async function runCompiledClaudeExecution({ artifactRoot }) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('compiled_claude_execution_requires_darwin_arm64');
  const manifestPath = path.join(artifactRoot, 'native-bundle.json'), manifestSha256 = qaHash(await readQaPinnedFile(manifestPath, undefined, 4 * 1024 * 1024));
  const artifacts = await verifyNativeRuntimeArtifacts({ manifestPath, manifestSha256, launcher: path.join(artifactRoot, 'DevRyan-execution-darwin-arm64') });
  const run = createRunRoot({ parent: scratchParent('qa'), prefix: 'compiled-claude-execution-', owner: 'scripts/opencode-v2-native/compiled-claude-execution.mjs', signals: 'exit' });
  const root = run.dir, bundle = path.join(root, 'bundle'), global = path.join(bundle, 'global'), databaseDirectory = path.join(bundle, 'opencode');
  const report = { status: 'failed', qualification: 'compiled-Claude-SDK-gate-loopback-only', buildID: artifacts.manifest.buildId, manifestSha256, checks: [], requests: [], diagnostics: [], cleanup: [] };
  const abort = new AbortController(); let worker, server, failure, termination, mode = 'final', heldResolve;
  const heldSeen = new Promise(resolve => { heldResolve = resolve; });
  const attempts = new Map();
  const interrupt = () => { abort.abort(); void worker?.killAndWaitForExit().catch(() => {}); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  const check = async (name, action) => {
    console.log(JSON.stringify({ phase: name, status: 'started' }));
    await action(); report.checks.push({ name, status: 'passed' });
  };
  try {
    await fs.mkdir(global, { recursive: true, mode: 0o700 }); await fs.mkdir(databaseDirectory, { mode: 0o700 });
    const globals = Object.fromEntries(['home', 'config', 'data', 'state', 'cache', 'bin', 'log', 'repos', 'tmp'].map(key => [key, path.join(global, key)]));
    for (const directory of Object.values(globals)) await fs.mkdir(directory, { mode: 0o700 });
    const directory = globals.repos;
    server = createServer(async (request, response) => {
      try {
        assert.equal(request.socket.remoteAddress, '127.0.0.1');
        if (new URL(request.url, 'http://127.0.0.1').pathname === '/api/hello' && request.method === 'HEAD') {
          let metadataBytes = 0; for await (const chunk of request) { metadataBytes += chunk.length; assert.ok(metadataBytes <= 64 * 1024); }
          report.metadataRequests ??= 0; report.metadataRequests++;
          response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}'); return;
        }
        assert.ok(request.url.startsWith('/v1/messages'), 'Unexpected outbound fixture route: ' + request.method + ' ' + new URL(request.url, 'http://127.0.0.1').pathname.slice(0, 160));
        assert.equal(request.method, 'POST');
        let bytes = 0; const chunks = [];
        for await (const chunk of request) { bytes += chunk.length; assert.ok(bytes < 2 * 1024 * 1024); chunks.push(chunk); }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        assert.ok(Array.isArray(body.messages));
        report.requests.push({ mode, model: body.model, stream: body.stream === true, messageCount: body.messages.length });
        const reply = compiledClaudeReply(body, { held: mode === 'cancel' });
        response.writeHead(200, { 'content-type': reply.type }); response.write(reply.body);
        if (mode === 'cancel') { response.flushHeaders(); heldResolve(); } else response.end();
      } catch (error) {
        report.fixtureFailure = error.message;
        if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ type: 'error', error: { type: 'fixture_error', message: 'Synthetic gateway refused' } }));
      }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const requestAuthorization = randomBytes(32).toString('hex');
    const profile = { id: 'compiled-loopback-only', type: 'api', apiKey: 'synthetic-loopback-only', baseUrl: `http://127.0.0.1:${server.address().port}` };
    const boot = { protocol: 1, type: 'provider-boot', provider: 'anthropic', instanceID: randomUUID(), buildId: artifacts.manifest.buildId,
      requestAuthorization, globals, profiles: [profile], defaultProfile: profile.id, assets: artifacts.reviewedClaude,
      transport: { launcher: artifacts.launcher, storage: globals.state, directories: [directory] } };
    await check('compiled worker startup', async () => {
      worker = await createNativeProviderProcess({ binary: artifacts.controller, cwd: directory, databasePath: path.join(databaseDirectory, 'opencode.db'), supervisor: { launcher: artifacts.launcher }, boot,
        environment: createQaHostLaunchEnvironment({ PATH: process.env.PATH, HOME: globals.home, XDG_CONFIG_HOME: globals.config, XDG_DATA_HOME: globals.data,
          XDG_STATE_HOME: globals.state, XDG_CACHE_HOME: globals.cache, TMPDIR: globals.tmp, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }),
        timeoutMs: 15000, onExit: receipt => { termination = receipt; }, onDiagnostic: diagnostic => report.diagnostics.push(diagnostic) });
    });
    const authorize = async sessionID => {
      const attempt = { attemptID: randomBytes(32).toString('hex'), sessionID, directory };
      await worker.authorizeAttempt(attempt); attempts.set(attempt.attemptID, attempt); return attempt;
    };
    const release = async attempt => { await worker.releaseAttempt(attempt, { drainMs: 2000 }); attempts.delete(attempt.attemptID); };
    const send = (attempt, signal) => fetch(worker.bound.url + '/v1/messages', { method: 'POST', signal: AbortSignal.any([abort.signal, signal ?? AbortSignal.timeout(60000)]),
      headers: { authorization: 'Bearer ' + requestAuthorization, 'content-type': 'application/json', 'x-meridian-profile': profile.id,
        'x-devryan-provider-attempt': attempt.attemptID, 'x-devryan-session': attempt.sessionID, 'x-opencode-session': attempt.sessionID,
        'x-devryan-directory': encodeURIComponent(directory), 'x-opencode-directory': encodeURIComponent(directory) },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'Synthetic SDK gate acceptance. Reply briefly.' }], max_tokens: 64, stream: true }) });
    await check('actual SDK final response and native gate settlement', async () => {
      const attempt = await authorize('ses_compiledfinal');
      const response = await send(attempt);
      const text = await response.text();
      assert.equal(response.status, 200, `Compiled SDK request failed: ${text.slice(0, 1000)}`);
      assert.ok(text.includes(finalText), 'Actual compiled SDK did not forward the synthetic final response');
      assert.ok(report.requests.length > 0, 'No real Claude request reached the loopback gateway');
      await release(attempt);
      assert.equal((await readCompiledClaudeLeases(globals.home)).length, 0, 'SDK writer lease survived completed release');
      assert.equal((await fs.readdir(globals.state)).filter(name => name.startsWith('provider-')).length, 0, 'Unconfirmed physical transport receipt left behind');
    });
    await check('active SDK cancellation joins confined receipt and releases writer lease', async () => {
      mode = 'cancel'; const attempt = await authorize('ses_compiledcancel'), cancel = new AbortController();
      const request = send(attempt, cancel.signal).then(async response => { await response.text(); }).catch(error => { if (!cancel.signal.aborted) throw error; });
      void request.catch(() => {});
      await deadline(Promise.race([heldSeen, request.then(() => { throw new Error('SDK ended before active cancellation'); })]), 30000, 'Physical Claude request did not reach synthetic gateway');
      const leases = await readCompiledClaudeLeases(globals.home);
      assert.ok(leases.some(lease => lease.executor?.pid > 0 && lease.executorRecoverable === false), 'No armed nonrecoverable SDK writer lease before cancellation');
      cancel.abort(); await deadline(request, 10000, 'HTTP cancellation did not settle');
      await release(attempt);
      {
        const settleDeadline = Date.now() + 5000;
        for (;;) {
          const remaining = await readCompiledClaudeLeases(globals.home);
          if (!remaining.length) break;
          report.cancelledLeaseCount = remaining.length;
          if (Date.now() >= settleDeadline) throw new Error('Cancelled SDK writer lease survived physical join');
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
      assert.equal((await fs.readdir(globals.state)).filter(name => name.startsWith('provider-')).length, 0, 'Cancelled physical transport lacked confirmed receipt cleanup');
    });
    assert.equal(report.fixtureFailure, undefined);
    await worker.close(); worker = undefined;
    assert.equal(termination.receipt.terminated, true); assert.equal(termination.receipt.confined, true);
    assert.equal(termination.code, 0); assert.equal(termination.signal, null);
    report.workerTermination = { terminated: true, confined: true, code: termination.code, stderrBytes: termination.stderrBytes };
    report.status = 'passed';
  } catch (error) {
    failure = error; report.failure = { code: typeof error.code === 'string' ? error.code : 'compiled_claude_execution_failed', message: String(error.message).replaceAll(root, '<QA_RUN>').slice(0, 2000) };
  } finally {
    abort.abort();
    if (worker) { try { for (const attempt of attempts.values()) await worker.releaseAttempt(attempt); await worker.close(); } catch (error) { report.cleanup.push({ code: error.code ?? 'worker_cleanup_failed' }); } }
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    if (report.cleanup.length) report.status = 'failed';
    await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    run.finish(report.status === 'passed' ? 'passed' : 'failed');
  }
  if (failure) throw Object.assign(failure, { report, evidenceRoot: root });
  assert.equal(report.status, 'passed'); return { root, report };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2).filter(value => value !== '--keep-artifacts');
  if (args.length !== 2 || args[0] !== '--artifact-root') throw new Error('Expected --artifact-root <verified-private-artifacts>');
  try { const result = await runCompiledClaudeExecution({ artifactRoot: path.resolve(args[1]) }); console.log(JSON.stringify({ status: result.report.status, checks: result.report.checks })); }
  catch (error) { console.error(JSON.stringify({ status: 'failed', failure: error.report?.failure ?? { code: error.code ?? 'compiled_claude_execution_failed' }, evidenceRoot: error.evidenceRoot })); process.exitCode = 1; }
}
