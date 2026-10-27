import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import { startReadOnlySessionExecution } from '../../../../../harness-runtime/lib/session-execution.js';
import { createNativeClaudeTransportHost } from './native-claude-transport-host.js';
import { createNativeClaudeCheckpointOwner } from './native-claude-checkpoint.js';
import { captureClaudeTransportIncarnation } from './native-claude-process-incarnation.js';
import { settlePassthroughQuery, sdkProjectDirectory } from '../meridian-passthrough-handoff.js';
vi.mock('../../../../../harness-runtime/lib/session-execution.js', () => ({ startReadOnlySessionExecution: vi.fn() }));
vi.mock('./native-claude-process-incarnation.js', () => ({ captureClaudeTransportIncarnation: vi.fn() }));
let root, boot, host, frames, runs, credential, sendReply;
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const request = (attempt = 'a'.repeat(64), session = 'ses_first') => ({ protocol: 1, type: 'claude-transport', action: 'start',
  id: randomUUID(), attemptID: attempt, sessionID: session, directory: boot.transport.directories[0], profileID: 'selected', args: ['--print', '--output-format', 'stream-json'] });
const sequences = new WeakMap();
const nextSequence = input => { const sequence = (sequences.get(input) ?? 0) + 1; sequences.set(input, sequence); return sequence; };
const frame = (input, action, extra = {}) => ({ protocol: 1, type: 'claude-transport', action, id: input.id, attemptID: input.attemptID,
  ...(action === 'stdin' ? { sequence: nextSequence(input) } : {}), ...extra });
const admit = input => host.authorize({ attemptID: input.attemptID, sessionID: input.sessionID, directory: input.directory });
const started = async input => { await host.accept(input); await vi.waitFor(() => expect(frames.some(f => f.id === input.id && f.action === 'started')).toBe(true)); };
beforeEach(async () => {
  startReadOnlySessionExecution.mockReset();
  captureClaudeTransportIncarnation.mockReset();
  captureClaudeTransportIncarnation.mockImplementation(async child => ({ version: 1, pid: child.pid, hostId: 'a'.repeat(64),
    bootId: '12345678-1234-1234-1234-123456789abc', startId: '12345', startIdKind: 'linux-proc-start-ticks' }));
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-claude-host-')));
  const globals = Object.fromEntries(['home', 'config', 'data', 'state', 'cache', 'bin', 'log', 'repos', 'tmp'].map(k => [k, path.join(root, 'global', k)]));
  await Promise.all(Object.values(globals).map(p => fs.mkdir(p, { recursive: true })));
  const storage = path.join(root, 'transport'); await fs.mkdir(storage);
  const asset = path.join(root, 'owned-claude'), launcher = path.join(root, 'launcher');
  await fs.writeFile(asset, 'owned-claude'); await fs.writeFile(launcher, 'launcher');
  boot = { protocol: 1, type: 'provider-boot', provider: 'anthropic', instanceID: randomUUID(), buildId: 'b'.repeat(64), requestAuthorization: 'c'.repeat(64), globals,
    profiles: [{ id: 'selected', type: 'oauth-token', credentialPolicy: 'access-only', claudeConfigDir: globals.home }],
    assets: { claude: { path: asset, sha256: createHash('sha256').update('owned-claude').digest('hex') }, libsql: { path: asset, sha256: 'd'.repeat(64) } },
    transport: { launcher, storage, directories: [globals.repos] } };
  frames = []; runs = [];
  sendReply = async frame => { frames.push(frame); };
  credential = vi.fn(async () => ({ profileID: 'selected', accessToken: 'owned-access', expiresAt: Date.now() + 3600000, fingerprint: 'e'.repeat(64) }));
  startReadOnlySessionExecution.mockImplementation(async options => {
    const settled = defer(), writes = [];
    const child = { pid: 100 + runs.length, stdin: new Writable({ write(chunk, _encoding, done) { writes.push(chunk.toString()); done(); } }), stdout: new PassThrough(), stderr: new PassThrough() };
    const run = { options, child, settled, writes, cancel: vi.fn() }; runs.push(run);
    options.signal.addEventListener('abort', run.cancel, { once: true });
    return { child, cancel: run.cancel, result: settled.promise };
  });
  host = createNativeClaudeTransportHost({ boot, environment: { PATH: '/usr/bin:/bin', ANTHROPIC_API_KEY: 'ambient-secret', DEVRYAN_PROVIDER_AUTHORIZATION: 'ambient-owner' },
    deniedReadDirectories: [globals.config], resolveCredential: credential, send: frame => sendReply(frame) });
});
afterEach(async () => {
  for (const run of runs) run.settled.resolve({ terminated: true, confined: true, cancelled: true, exitCode: 0 });
  await host.close().catch(() => {}); await fs.rm(root, { recursive: true, force: true });
});

test('host derives immutable launch, credential and private state; streams only matching transport frames', async () => {
  const input = { ...request(), modelPins: { opus: 'claude-opus-5-5' }, toolSearch: true }; admit(input); await started(input);
  expect(captureClaudeTransportIncarnation).toHaveBeenCalledWith(runs[0].child, boot.assets.claude.path);
  expect(frames.find(frame => frame.action === 'started').incarnation.pid).toBe(runs[0].child.pid);
  expect(runs[0].options.env.CLAUDE_CONFIG_DIR).toBe(path.join(boot.transport.storage, 'state', createHash('sha256').update(JSON.stringify([boot.globals.home, input.directory])).digest('hex')));
  expect(runs[0].options).toMatchObject({ command: boot.assets.claude.path, launcher: boot.transport.launcher, logicalDirectory: input.directory,
    socketDirectory: null, workerBrowsers: false, interactive: true, deniedReadDirectories: [boot.globals.config] });
  expect(runs[0].options.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'owned-access', DEVRYAN_EXECUTION_WORKER: '1' });
  expect(runs[0].options.env).toMatchObject({ ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5-5', ENABLE_TOOL_SEARCH: 'true', ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1' });
  expect(runs[0].options.env).not.toHaveProperty('ANTHROPIC_API_KEY'); expect(runs[0].options.env).not.toHaveProperty('DEVRYAN_PROVIDER_AUTHORIZATION');
  expect(runs[0].options.env.CLAUDE_CONFIG_DIR.startsWith(boot.transport.storage + path.sep)).toBe(true);
  await host.accept(frame(input, 'stdin', { chunk: Buffer.from('first-input').toString('base64') })); await host.accept(frame(input, 'end'));
  runs[0].child.stdout.write('owned-output'); runs[0].child.stderr.write('owned-error');
  runs[0].settled.resolve({ terminated: true, confined: true, cancelled: false, exitCode: 0 });
  await vi.waitFor(() => expect(frames.at(-1).action).toBe('settled'));
  expect(runs[0].writes).toEqual(['first-input']);
  expect(frames.filter(f => f.action === 'stdout').map(f => Buffer.from(f.chunk, 'base64').toString())).toEqual(['owned-output']);
  expect(frames.every(f => f.id === input.id)).toBe(true); expect(JSON.stringify(frames)).not.toContain('owned-access');
  await expect(host.accept(input)).rejects.toMatchObject({ code: 'native_claude_transport_expired' });
});

test('six native tool handoffs verify the actual transport state with unchanged structured history and prefix', async () => {
  const hooks = ['__DEVRYAN_CLAUDE_CHECKPOINT_DIRECTORY', '__DEVRYAN_CLAUDE_CHECKPOINT_DIAGNOSTIC'];
  const previous = hooks.map(key => Reflect.get(globalThis, key));
  const admitted = new Map(), diagnostics = [], verified = [];
  const owner = createNativeClaudeCheckpointOwner({ boot, assertAttempt(input) {
    expect(admitted.get(input.attemptID)).toEqual({ sessionID: input.sessionID, directory: input.directory });
  }, publish: value => diagnostics.push(value) });
  Reflect.set(globalThis, hooks[0], owner.directory); Reflect.set(globalThis, hooks[1], owner.diagnostic);
  const sessionId = randomUUID(), history = [], records = [];
  const prefix = { system: [{ type: 'text', text: 'Synthetic stable system prefix' }], tools: [{ name: 'read', input_schema: { type: 'object' } }] };
  let parentUuid;
  try {
    for (let turn = 0; turn < 6; turn++) {
      const input = request(String(turn + 1).repeat(64));
      admitted.set(input.attemptID, { sessionID: input.sessionID, directory: input.directory }); admit(input); await started(input);
      owner.bindTransport(JSON.stringify({ attemptID: input.attemptID, sessionID: input.sessionID, directory: input.directory, profileID: input.profileID }), input.directory);
      const run = runs[turn], assistantUuid = randomUUID(), callIDs = [`call-${turn}-a`, `call-${turn}-b`];
      const assistant = { type: 'assistant', uuid: assistantUuid, session_id: sessionId,
        message: { content: callIDs.map(id => ({ type: 'tool_use', id, name: 'read', input: { path: 'fixture.txt' } })) } };
      const results = { type: 'user', session_id: sessionId,
        message: { content: callIDs.map(id => ({ type: 'tool_result', tool_use_id: id, content: `actual fixture result ${id}` })) } };
      records.push({ uuid: assistantUuid, parentUuid, type: 'assistant', sessionId, cwd: input.directory,
        message: { id: `message-${turn}`, content: assistant.message.content } });
      parentUuid = randomUUID();
      records.push({ uuid: parentUuid, parentUuid: assistantUuid, type: 'user', sessionId, cwd: input.directory, message: results.message });
      const state = run.options.env.CLAUDE_CONFIG_DIR;
      const project = path.join(state, 'projects', sdkProjectDirectory(input.directory)); await fs.mkdir(project, { recursive: true });
      await fs.writeFile(path.join(project, sessionId + '.jsonl'), records.map(row => JSON.stringify(row)).join('\n') + '\n');
      const wire = JSON.stringify({ ...prefix, messages: history });
      await host.accept(frame(input, 'stdin', { chunk: Buffer.from(wire).toString('base64') }));
      expect(JSON.parse(run.writes.join(''))).toEqual({ ...prefix, messages: history });
      const query = (async function* () { yield assistant; yield results; throw new Error('Reached maximum number of turns (4)'); })();
      query.interrupt = vi.fn(); query.close = vi.fn();
      const scope = JSON.stringify({ attemptID: input.attemptID, sessionID: input.sessionID, directory: input.directory, profileID: input.profileID });
      const received = [];
      for await (const value of settlePassthroughQuery(query, { queryOptions: { cwd: input.directory,
        env: { CLAUDE_CONFIG_DIR: boot.globals.home, DEVRYAN_CLAUDE_DIAGNOSTIC_SCOPE: scope } },
        checkpoint: () => ({ assistantUuid, toolCallIds: callIDs }), verified: value => verified.push(value) })) received.push(value);
      expect(received).toEqual([assistant, results]); expect(received.some(value => value.type === 'result')).toBe(false);
      history.push(assistant, results);
      runs[turn].settled.resolve({ terminated: true, confined: true, cancelled: false, exitCode: 0 });
      await host.release(input); owner.release(input.attemptID); admitted.delete(input.attemptID);
    }
    expect(runs).toHaveLength(6); expect(verified).toHaveLength(6);
    expect(verified.every(value => value.sessionId === sessionId)).toBe(true);
    expect(diagnostics.filter(value => value.checkpoint.reason === 'persisted_tool_boundary')).toHaveLength(6);
    expect(JSON.stringify(diagnostics)).not.toMatch(/actual fixture result|Synthetic stable|owned-access|CLAUDE_CONFIG_DIR/);
  } finally {
    hooks.forEach((key, index) => previous[index] === undefined ? Reflect.deleteProperty(globalThis, key) : Reflect.set(globalThis, key, previous[index]));
  }
});

test('revoked and mismatched attempts cannot start; retirement during credentials prevents launch', async () => {
  const input = request(); await expect(host.accept(input)).rejects.toMatchObject({ code: 'native_claude_transport_expired' });
  admit(input); await expect(host.accept({ ...input, sessionID: 'ses_wrong' })).rejects.toMatchObject({ code: 'native_claude_transport_expired' });
  await expect(host.accept({ ...input, env: {} })).rejects.toMatchObject({ code: 'native_claude_transport_invalid' });
  const key = defer(); credential.mockReturnValue(key.promise); await host.accept(input);
  await vi.waitFor(() => expect(credential).toHaveBeenCalledOnce());
  const retirement = host.release(input); key.resolve({ profileID: 'selected', accessToken: 'owned-access', expiresAt: Date.now() + 3600000, fingerprint: 'e'.repeat(64) });
  await retirement; expect(runs).toHaveLength(0); expect(frames.at(-1)).toMatchObject({ action: 'settled', error: 'native_claude_transport_expired' });
});

test('two admitted transports keep frames separate and retirement waits its own receipt without cancelling its sibling', async () => {
  const first = request(), second = request('b'.repeat(64), 'ses_second'); admit(first); admit(second); await started(first); await started(second);
  await Promise.all([host.accept(frame(first, 'stdin', { chunk: Buffer.from('one').toString('base64') })), host.accept(frame(second, 'stdin', { chunk: Buffer.from('two').toString('base64') }))]);
  runs[0].child.stdout.write('one-output'); runs[1].child.stdout.write('two-output');
  let retired = false; const retirement = host.release(first).then(() => { retired = true; });
  expect(runs[0].cancel).toHaveBeenCalledOnce(); expect(runs[1].cancel).not.toHaveBeenCalled(); await Promise.resolve(); expect(retired).toBe(false);
  runs[0].settled.resolve({ terminated: true, confined: true, cancelled: true, exitCode: 143 }); await retirement;
  expect(runs[1].writes).toEqual(['two']);
  await vi.waitFor(() => expect(frames.filter(f => f.action === 'stdout')).toHaveLength(2));
  expect(frames.filter(f => f.action === 'stdout').map(f => [f.id, Buffer.from(f.chunk, 'base64').toString()])).toEqual([[first.id, 'one-output'], [second.id, 'two-output']]);
  let closed = false; const close = host.close().then(() => { closed = true; }); expect(runs[1].cancel).toHaveBeenCalledOnce(); await Promise.resolve(); expect(closed).toBe(false);
  runs[1].settled.resolve({ terminated: true, confined: true, cancelled: true, exitCode: 143 }); await close;
});

test('owner death cancels both transports and cannot close before both receipts', async () => {
  const a = request(), b = request('b'.repeat(64), 'ses_second'); admit(a); admit(b); await started(a); await started(b);
  let done = false; const close = host.close().then(() => { done = true; });
  expect(runs.every(run => run.cancel.mock.calls.length === 1)).toBe(true);
  runs[0].settled.resolve({ terminated: true, confined: true, cancelled: true, exitCode: 143 }); await Promise.resolve(); expect(done).toBe(false);
  runs[1].settled.resolve({ terminated: true, confined: true, cancelled: true, exitCode: 143 }); await close;
});

test('unconfirmed termination fails closed and remains held for owner cleanup', async () => {
  const input = request(); admit(input); await started(input); runs[0].settled.reject(Error('missing receipt'));
  await vi.waitFor(() => expect(frames.at(-1)).toMatchObject({ action: 'settled', error: 'native_claude_transport_unconfirmed' }));
  await expect(host.close()).rejects.toMatchObject({ code: 'native_claude_transport_unconfirmed' });
});

test('pending output overflow requests owned cancellation and publishes no success before the receipt', async () => {
  const input = request(); admit(input); await started(input);
  runs[0].child.stdout.emit('data', Buffer.alloc(1024 * 1024 + 1));
  expect(runs[0].cancel).toHaveBeenCalledOnce(); expect(frames.at(-1).action).toBe('started');
  runs[0].settled.resolve({ terminated: true, confined: true, cancelled: true, exitCode: 143 });
  await vi.waitFor(() => expect(frames.at(-1)).toMatchObject({ action: 'settled', error: 'native_claude_transport_overflow', receipt: { confined: true, terminated: true, cancelled: true } }));
});

test('changed immutable asset and symlinked private state never launch', async () => {
  await fs.writeFile(boot.assets.claude.path, 'changed'); let input = request(); admit(input); await host.accept(input);
  await vi.waitFor(() => expect(frames.at(-1)).toMatchObject({ action: 'settled', error: 'native_claude_transport_invalid' })); expect(runs).toHaveLength(0);
  await fs.writeFile(boot.assets.claude.path, 'owned-claude'); await fs.symlink(boot.globals.home, path.join(boot.transport.storage, 'state'));
  input = request('b'.repeat(64), 'ses_second'); admit(input); await host.accept(input);
  await vi.waitFor(() => expect(frames.filter(f => f.action === 'settled')).toHaveLength(2)); expect(runs).toHaveLength(0); expect(await fs.readdir(boot.globals.home)).toEqual([]);
});

test('queued stdin stays bounded and end follows earlier writes while refusing later input', async () => {
  const input = request(); admit(input); await started(input);
  let finishWrite; const received = [];
  runs[0].child.stdin = new Writable({ write(chunk, _encoding, done) { received.push(chunk.length); finishWrite = done; } });
  const pending = host.accept(frame(input, 'stdin', { chunk: Buffer.from('queued').toString('base64') }));
  await vi.waitFor(() => expect(finishWrite).toBeTypeOf('function'));
  const end = host.accept(frame(input, 'end'));
  expect(runs[0].child.stdin.writableEnded).toBe(false);
  expect(frames.some(f => f.action === 'input-accepted')).toBe(false);
  await expect(host.accept(frame(input, 'stdin', { chunk: 'eA==' }))).rejects.toMatchObject({ code: 'native_claude_transport_invalid' });
  await expect(host.accept(frame(input, 'end'))).rejects.toMatchObject({ code: 'native_claude_transport_invalid' });
  finishWrite(); await pending; await end; expect(runs[0].child.stdin.writableEnded).toBe(true); expect(received).toEqual([6]);
  expect(frames.find(f => f.action === 'input-accepted')).toMatchObject({ id: input.id, attemptID: input.attemptID, sequence: 1 });
});

test('aggregate queued stdin overflow cancels owned work rather than buffering without a bound', async () => {
  const input = request(); admit(input); await started(input);
  let releaseWrite; runs[0].child.stdin = new Writable({ write(_chunk, _encoding, done) { releaseWrite = done; } });
  const chunk = Buffer.alloc(16384).toString('base64'), writes = [];
  for (let index = 0; index < 64; index++) { const work = host.accept(frame(input, 'stdin', { chunk })); void work.catch(() => {}); writes.push(work); }
  await vi.waitFor(() => expect(releaseWrite).toBeTypeOf('function'));
  await expect(host.accept(frame(input, 'stdin', { chunk }))).rejects.toMatchObject({ code: 'native_claude_transport_overflow' });
  expect(runs[0].cancel).toHaveBeenCalledOnce(); releaseWrite(); await Promise.allSettled(writes);
  runs[0].settled.resolve({ terminated: true, confined: true, cancelled: true, exitCode: 143 });
  await vi.waitFor(() => expect(frames.at(-1)).toMatchObject({ action: 'settled', error: 'native_claude_transport_overflow' }));
});

test('constructor snapshot ignores later asset, directory, profile and environment mutation', async () => {
  const input = request(), originalAsset = boot.assets.claude.path; admit(input);
  boot.assets.claude.path = '/unreviewed'; boot.transport.directories = ['/unreviewed']; boot.profiles[0].claudeConfigDir = '/unreviewed';
  await started(input); expect(runs[0].options.command).toBe(originalAsset); expect(runs[0].options.logicalDirectory).toBe(input.directory);
});

test('input sequence rejects duplicate chunks and stale attempts cannot control a reused retired transport ID', async () => {
  const first = request(); admit(first); await started(first);
  await host.accept(frame(first, 'stdin', { chunk: 'eA==' }));
  await expect(host.accept(frame(first, 'stdin', { chunk: 'eA==', sequence: 1 }))).rejects.toMatchObject({ code: 'native_claude_transport_invalid' });
  expect(runs[0].writes).toEqual(['x']); expect(runs[0].cancel).toHaveBeenCalledOnce();
  runs[0].settled.resolve({ terminated: true, confined: true, cancelled: true, exitCode: 143 }); await host.release(first);
  const second = { ...request('b'.repeat(64), 'ses_second'), id: first.id }; admit(second);
  const previousStarted = frames.filter(f => f.action === 'started').length; await host.accept(second);
  await vi.waitFor(() => expect(frames.filter(f => f.action === 'started')).toHaveLength(previousStarted + 1));
  await expect(host.accept(frame(first, 'cancel'))).rejects.toMatchObject({ code: 'native_claude_transport_expired' });
  await expect(host.accept(frame(first, 'stdin', { chunk: 'eA==' }))).rejects.toMatchObject({ code: 'native_claude_transport_expired' });
  expect(runs[1].cancel).not.toHaveBeenCalled(); expect(runs[1].writes).toEqual([]);
});

test('cancel before started retires preparation and cannot launch after the credential returns', async () => {
  const key = defer(), input = request(); credential.mockReturnValue(key.promise); admit(input); await host.accept(input);
  await vi.waitFor(() => expect(credential).toHaveBeenCalledOnce());
  const cancelled = host.accept(frame(input, 'cancel'));
  expect(runs).toHaveLength(0); expect(frames).toHaveLength(0);
  key.resolve({ profileID: 'selected', accessToken: 'owned-access', expiresAt: Date.now() + 3600000, fingerprint: 'e'.repeat(64) });
  await cancelled; expect(runs).toHaveLength(0);
  expect(frames).toEqual([{ protocol: 1, type: 'claude-transport-reply', id: input.id, attemptID: input.attemptID,
    action: 'settled', error: 'native_claude_transport_expired' }]);
});

test('terminal cancellation and a cancelled pending write cannot tear down an admitted sibling', async () => {
  const first = request(), second = request('b'.repeat(64), 'ses_second'); admit(first); admit(second); await started(first); await started(second);
  let callback; const inputErrors = [];
  runs[0].child.stdin = new Writable({ write(_chunk, _encoding, done) { callback = done; } });
  runs[0].child.stdin.on('error', error => inputErrors.push(error));
  const write = host.accept(frame(first, 'stdin', { chunk: 'eA==' }));
  await vi.waitFor(() => expect(callback).toBeTypeOf('function'));
  const cancel = host.accept(frame(first, 'cancel')); callback(Error('closed owned input'));
  await write; expect(runs[1].cancel).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(inputErrors).toHaveLength(1));
  runs[0].settled.resolve({ terminated: true, confined: true, cancelled: true, exitCode: 143 }); await cancel;
  await expect(host.accept(frame(first, 'cancel'))).resolves.toBeUndefined();
  await expect(host.accept({ ...frame(first, 'cancel'), attemptID: second.attemptID })).rejects.toMatchObject({ code: 'native_claude_transport_expired' });
  expect(runs[1].cancel).not.toHaveBeenCalled();
});

test('a fast child finishing behind a blocked started reply retains ordered bounded output before settlement', async () => {
  const announced = defer(); sendReply = async frame => { frames.push(frame); if (frame.action === 'started') await announced.promise; };
  const input = request(); admit(input); await host.accept(input);
  await vi.waitFor(() => expect(frames.at(-1)?.action).toBe('started'));
  runs[0].child.stdout.end('fast final output'); runs[0].child.stderr.end('fast stderr');
  runs[0].settled.resolve({ terminated: true, confined: true, cancelled: false, exitCode: 0 });
  expect(frames.map(f => f.action)).toEqual(['started']); announced.resolve();
  await vi.waitFor(() => expect(frames.at(-1)?.action).toBe('settled'));
  expect(frames.map(f => f.action)).toEqual(['started', 'stdout', 'stderr', 'settled']);
  expect(Buffer.from(frames[1].chunk, 'base64').toString()).toBe('fast final output');
});

test('accepted EOF followed by same-batch cancellation settles only its own transport', async () => {
  const first = request(), second = request('b'.repeat(64), 'ses_second'); admit(first); admit(second); await started(first); await started(second);
  const end = host.accept(frame(first, 'end')), cancelled = host.accept(frame(first, 'cancel'));
  await expect(end).resolves.toBeUndefined(); expect(runs[1].cancel).not.toHaveBeenCalled();
  runs[0].settled.resolve({ terminated: true, confined: true, cancelled: true, exitCode: 143 }); await cancelled;
  expect(runs[1].cancel).not.toHaveBeenCalled();
});

test('early exit drains pending stdin without a post-settled ACK and discards only exact in-flight terminal frames', async () => {
  const first = request(), second = request('b'.repeat(64), 'ses_second'); admit(first); admit(second); await started(first); await started(second);
  let finishWrite; const received = [];
  runs[0].child.stdin = new Writable({ write(chunk, _encoding, done) { received.push(chunk.toString()); finishWrite = done; } });
  const write = host.accept(frame(first, 'stdin', { chunk: Buffer.from('pending').toString('base64') }));
  await vi.waitFor(() => expect(finishWrite).toBeTypeOf('function'));
  runs[0].settled.resolve({ terminated: true, confined: true, cancelled: false, exitCode: 1 }); await Promise.resolve(); await Promise.resolve();
  await expect(host.accept(frame(first, 'stdin', { chunk: Buffer.from('already-in-flight').toString('base64') }))).resolves.toBeUndefined();
  expect(frames.filter(f => f.id === first.id).map(f => f.action)).toEqual(['started']);
  finishWrite(); await write;
  await vi.waitFor(() => expect(frames.filter(f => f.id === first.id).at(-1)?.action).toBe('settled'));
  await expect(host.accept(frame(first, 'stdin', { chunk: 'eA==' }))).resolves.toBeUndefined();
  await expect(host.accept(frame(first, 'end'))).resolves.toBeUndefined();
  await expect(host.accept({ ...frame(first, 'cancel'), attemptID: second.attemptID })).rejects.toMatchObject({ code: 'native_claude_transport_expired' });
  await expect(host.accept(frame(first, 'stdin', { chunk: 'eA==', sequence: 1 }))).rejects.toMatchObject({ code: 'native_claude_transport_invalid' });
  expect(received).toEqual(['pending']); expect(frames.some(f => f.id === first.id && f.action === 'input-accepted')).toBe(false);
  expect(runs[1].cancel).not.toHaveBeenCalled();
});

test('drain waits for the attempt child to exit on its own before release, without cancelling it', async () => {
  const input = request(); admit(input); await started(input);
  let drained = false; const drain = host.drain(input, 5000).then(() => { drained = true; });
  await Promise.resolve(); expect(drained).toBe(false); expect(runs[0].cancel).not.toHaveBeenCalled();
  runs[0].settled.resolve({ terminated: true, confined: true, cancelled: false, exitCode: 0 });
  await drain; expect(runs[0].cancel).not.toHaveBeenCalled();
  expect(frames.at(-1)).toMatchObject({ action: 'settled', receipt: { cancelled: false, exitCode: 0 } });
  await host.release(input); expect(runs[0].cancel).not.toHaveBeenCalled();
});

test('drain is bounded: a child that does not exit is cancelled by the following release', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const input = request(); admit(input); await started(input);
    const drain = host.drain(input, 12_000); await vi.advanceTimersByTimeAsync(12_000); await drain;
    expect(runs[0].cancel).not.toHaveBeenCalled();
    const release = host.release(input); expect(runs[0].cancel).toHaveBeenCalledOnce();
    runs[0].settled.resolve({ terminated: true, confined: true, cancelled: true, exitCode: 143 }); await release;
    await expect(host.drain(input, 1)).rejects.toMatchObject({ code: 'native_claude_transport_expired' });
  } finally { vi.useRealTimers(); }
});

test('a stale or reused executor incarnation cancels before the first SDK byte', async () => {
  const input = request(); admit(input); await started(input);
  captureClaudeTransportIncarnation.mockImplementation(async child => ({ version: 1, pid: child.pid, hostId: 'a'.repeat(64),
    bootId: '12345678-1234-1234-1234-123456789abc', startId: '54321', startIdKind: 'linux-proc-start-ticks' }));
  await expect(host.accept(frame(input, 'stdin', { chunk: Buffer.from('inference').toString('base64') })))
    .rejects.toMatchObject({ code: 'native_claude_transport_unconfirmed' });
  expect(runs[0].writes).toEqual([]); expect(runs[0].cancel).toHaveBeenCalledOnce();
  runs[0].settled.resolve({ terminated: true, confined: true, cancelled: true, exitCode: 137 });
  await host.release(input);
});

test('missing executor attestation reports startup failure only after physical termination is confirmed', async () => {
  captureClaudeTransportIncarnation.mockRejectedValue(Error('unavailable OS observation'));
  const input = request(); admit(input); await host.accept(input);
  await vi.waitFor(() => expect(runs).toHaveLength(1));
  await vi.waitFor(() => expect(runs[0].cancel).toHaveBeenCalledOnce());
  expect(frames).toEqual([]);
  runs[0].settled.resolve({ terminated: true, confined: true, cancelled: true, exitCode: 137 });
  await host.release(input);
  expect(frames).toEqual([expect.objectContaining({ action: 'settled', error: 'native_claude_transport_identity_failed',
    receipt: { terminated: true, confined: true, cancelled: true, exitCode: 137 } })]);
});

test('cancellation during input attestation discards input and still waits for physical termination', async () => {
  const input = request(); admit(input); await started(input);
  const observation = defer();
  captureClaudeTransportIncarnation.mockReturnValue(observation.promise);
  const pending = host.accept(frame(input, 'stdin', { chunk: Buffer.from('inference').toString('base64') }));
  await vi.waitFor(() => expect(captureClaudeTransportIncarnation).toHaveBeenCalledTimes(2));
  let cancelled = false;
  const cancellation = host.accept(frame(input, 'cancel')).then(() => { cancelled = true; });
  observation.reject(Error('executor exited during observation'));
  await pending;
  expect(runs[0].writes).toEqual([]);
  expect(cancelled).toBe(false);
  expect(frames.some(frame => frame.action === 'settled')).toBe(false);
  runs[0].settled.resolve({ terminated: true, confined: true, cancelled: true, exitCode: 137 });
  await cancellation;
  expect(frames.at(-1)).toMatchObject({ action: 'settled', receipt: { terminated: true, confined: true, cancelled: true } });
  expect(frames.at(-1)).not.toHaveProperty('error');
});
