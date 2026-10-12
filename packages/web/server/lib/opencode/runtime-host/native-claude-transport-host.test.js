import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import { startReadOnlySessionExecution } from '../../../../../harness-runtime/lib/session-execution.js';
import { createNativeClaudeTransportHost } from './native-claude-transport-host.js';
vi.mock('../../../../../harness-runtime/lib/session-execution.js', () => ({ startReadOnlySessionExecution: vi.fn() }));
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
  const family = path.resolve(import.meta.dirname, '../../../../../../.cache/v2-validation'); await fs.mkdir(family, { recursive: true });
  root = await fs.mkdtemp(path.join(family, 'claude-host-'));
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
