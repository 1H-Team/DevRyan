import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { startReadOnlySessionExecution } from '../../../../../harness-runtime/lib/session-execution.js';
import { parseProviderBoot, parseProviderCommand, parseProviderCredentialResult } from './native-provider-worker-protocol.js';
import { parseClaudeTransportRequest, parseClaudeTransportReply, CLAUDE_TRANSPORT_CHUNK_BYTES } from './native-claude-transport-protocol.js';
import { nativeClaudeStateDirectory } from './native-claude-checkpoint.js';
const fail = code => Object.assign(new Error(code), { code });
const binding = input => JSON.stringify([input.attemptID, input.sessionID, input.directory]);
const inside = (directory, root) => directory === root || directory.startsWith(root + path.sep);
const MAX_QUEUED_BYTES = 1024 * 1024;

/** The unsandboxed host launches an exact reviewed asset into a new read-only supervisor. */
export function createNativeClaudeTransportHost({ boot: input, environment, resolveCredential, send, deniedReadDirectories = [] }) {
  // Only the constructor's manifest-bound snapshot may choose executable, roots or credentials.
  const boot = parseProviderBoot(input), attempts = new Map(), jobs = new Map(), used = new Map();
  environment = { ...environment }; deniedReadDirectories = [...deniedReadDirectories];
  let closed = false;
  const reply = (id, action, fields) => send(parseClaudeTransportReply({ protocol: 1, type: 'claude-transport-reply', id, attemptID: used.get(id)?.attemptID, action, ...fields }));
  const assert = job => {
    if (closed || job.abort.signal.aborted || attempts.get(job.input.attemptID) !== binding(job.input)) throw fail('native_claude_transport_expired');
  };
  const cancel = job => { job.abort.abort(fail('native_claude_transport_expired')); };
  const directory = async value => {
    if (!path.isAbsolute(value) || await fs.realpath(value) !== value || !(await fs.lstat(value)).isDirectory()) throw fail('native_claude_transport_invalid');
  };
  const launch = async job => {
    let handle, error;
    try {
      assert(job);
      const asset = boot.assets.claude;
      await Promise.all([directory(job.input.directory), directory(boot.transport.storage)]);
      for (const file of [asset.path, boot.transport.launcher]) {
        if (await fs.realpath(file) !== file || !(await fs.lstat(file)).isFile()) throw fail('native_claude_transport_invalid');
      }
      const hash = createHash('sha256');
      for await (const bytes of createReadStream(asset.path)) { assert(job); hash.update(bytes); }
      if (hash.digest('hex') !== asset.sha256) throw fail('native_claude_transport_invalid');
      const profile = boot.profiles.find(profile => profile.id === job.input.profileID)
        ?? (!boot.profiles.length && job.input.profileID === 'default' ? { id: 'default', type: 'claude-max' } : undefined);
      if (!profile) throw fail('native_claude_transport_invalid');
      if (profile.claudeConfigDir) {
        if (![boot.globals.home, boot.globals.config, boot.globals.data].some(root => inside(profile.claudeConfigDir, root))) throw fail('native_claude_transport_invalid');
        await directory(profile.claudeConfigDir);
      }
      const env = { ...environment };
      for (const name of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_|MERIDIAN_|CLAUDE_PROXY_|DEVRYAN_PROVIDER_|OPENCODE_SERVER_)/.test(name)) delete env[name];
      Object.assign(env, { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
        DISABLE_FEEDBACK_COMMAND: '1', CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1', DISABLE_AUTOUPDATER: '1',
        CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1', CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1', ENABLE_CLAUDEAI_MCP_SERVERS: 'false' });
      for (const [family, model] of Object.entries(job.input.modelPins ?? {})) env[`ANTHROPIC_DEFAULT_${family.toUpperCase()}_MODEL`] = model;
      if (job.input.toolSearch !== undefined) env.ENABLE_TOOL_SEARCH = String(job.input.toolSearch);
      if (profile.type === 'api') {
        if (!profile.apiKey) throw fail('native_claude_transport_invalid');
        env.ANTHROPIC_API_KEY = profile.apiKey;
        if (profile.baseUrl) env.ANTHROPIC_BASE_URL = profile.baseUrl;
      } else if (profile.credentialPolicy !== 'access-only' && profile.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = profile.oauthToken;
      else {
        if (!resolveCredential) throw fail('native_claude_transport_invalid');
        const credential = parseProviderCredentialResult(await resolveCredential({ protocol: 1, type: 'credential-request', id: randomUUID(),
          attemptID: job.input.attemptID, sessionID: job.input.sessionID, directory: job.input.directory, profileID: profile.id, purpose: 'request' }, { signal: job.abort.signal }));
        assert(job);
        if (credential.profileID !== profile.id || credential.expiresAt <= Date.now() + 60_000) throw fail('native_claude_transport_expired');
        env.CLAUDE_CODE_OAUTH_TOKEN = credential.accessToken;
      }
      const stateParent = path.join(boot.transport.storage, 'state');
      await fs.mkdir(stateParent, { mode: 0o700 }).catch(cause => { if (cause.code !== 'EEXIST') throw cause; });
      await directory(stateParent); assert(job);
      const state = nativeClaudeStateDirectory({ ...boot.transport, home: boot.globals.home, profile, directory: job.input.directory });
      await fs.mkdir(state, { mode: 0o700 }).catch(cause => { if (cause.code !== 'EEXIST') throw cause; });
      await directory(state); assert(job);
      env.CLAUDE_CONFIG_DIR = state; env.DEVRYAN_EXECUTION_WORKER = '1';
      handle = await startReadOnlySessionExecution({ launcher: boot.transport.launcher, storage: boot.transport.storage,
        auxiliaryDirectory: state, logicalDirectory: job.input.directory, command: asset.path, args: job.input.args,
        signal: job.abort.signal, interactive: true, env, socketDirectory: null, workerBrowsers: false, deniedReadDirectories });
      job.handle = handle;
      void handle.result.catch(() => {});
      handle.child.stdin.on('error', () => { cancel(job); });
      const announced = reply(job.input.id, 'started', { pid: handle.child.pid });
      const output = (action, data) => {
        const bytes = Buffer.from(data);
        if (job.outputBytes + bytes.length > MAX_QUEUED_BYTES) { job.failure = 'native_claude_transport_overflow'; cancel(job); return; }
        job.outputBytes += bytes.length;
        job.output = job.output.then(async () => {
          await announced;
          for (let offset = 0; offset < bytes.length; offset += CLAUDE_TRANSPORT_CHUNK_BYTES) {
            await reply(job.input.id, action, { chunk: bytes.subarray(offset, offset + CLAUDE_TRANSPORT_CHUNK_BYTES).toString('base64') });
          }
        }).catch(() => { job.failure = 'native_claude_transport_failed'; cancel(job); }).finally(() => { job.outputBytes -= bytes.length; });
      };
      handle.child.stdout.on('data', data => output('stdout', data));
      handle.child.stderr.on('data', data => output('stderr', data));
      await announced;
      if (job.abort.signal.aborted) handle.cancel();
      let receipt;
      try { receipt = await handle.result; }
      catch { throw fail('native_claude_transport_unconfirmed'); }
      job.closing = true; used.get(job.input.id).terminal = true;
      await job.writes;
      await job.output;
      const settled = parseClaudeTransportReply({ protocol: 1, type: 'claude-transport-reply', action: 'settled', id: job.input.id, attemptID: job.input.attemptID,
        receipt: { terminated: receipt.terminated, confined: receipt.confined, cancelled: receipt.cancelled, exitCode: receipt.exitCode },
        ...(job.failure ? { error: job.failure } : {}) });
      await send(settled);
    } catch (cause) {
      job.closing = true; used.get(job.input.id).terminal = true;
      error = handle ? 'native_claude_transport_unconfirmed' : cause.code === 'native_claude_transport_expired' ? cause.code : 'native_claude_transport_invalid';
      if (handle) {
        cancel(job);
        try {
          const receipt = await handle.result;
          const settled = parseClaudeTransportReply({ protocol: 1, type: 'claude-transport-reply', action: 'settled', id: job.input.id, attemptID: job.input.attemptID,
            receipt: { terminated: receipt.terminated, confined: receipt.confined, cancelled: receipt.cancelled, exitCode: receipt.exitCode }, error: 'native_claude_transport_failed' });
          await send(settled).catch(() => {}); error = null;
        } catch { /* A lost provider pipe cannot substitute for a termination receipt. */ }
      } else await reply(job.input.id, 'settled', { error }).catch(() => {});
      if (error && handle) { await reply(job.input.id, 'settled', { error }).catch(() => {}); throw fail(error); }
    } finally { if (!handle || !error) jobs.delete(job.input.id); }
  };
  return {
    authorize(input) {
      parseProviderCommand({ protocol: 1, id: randomUUID(), action: 'authorize-attempt', ...input });
      if (closed || !boot.transport.directories.includes(input.directory) || attempts.size >= 64 || attempts.has(input.attemptID)) throw fail('native_claude_transport_expired');
      attempts.set(input.attemptID, binding(input));
    },
    async release(input) {
      if (attempts.get(input.attemptID) !== binding(input)) throw fail('native_claude_transport_expired');
      attempts.delete(input.attemptID);
      const active = [...jobs.values()].filter(job => job.input.attemptID === input.attemptID);
      for (const job of active) cancel(job);
      await Promise.all(active.map(job => job.work));
      for (const [id, retired] of used) if (retired.attemptID === input.attemptID) used.delete(id);
    },
    async accept(raw) {
      const input = parseClaudeTransportRequest(raw);
      if (input.action === 'start') {
        if (closed || used.has(input.id) || used.size >= 4096 || jobs.size >= 64 || attempts.get(input.attemptID) !== binding(input)) throw fail('native_claude_transport_expired');
        used.set(input.id, { attemptID: input.attemptID, sequence: 0, ended: false, terminal: false });
        const job = { input: structuredClone(input), abort: new AbortController(), inputBytes: 0, inputSequence: 0, outputBytes: 0, output: Promise.resolve(), writes: Promise.resolve() };
        jobs.set(input.id, job); job.work = launch(job); void job.work.catch(() => {}); return;
      }
      const job = jobs.get(input.id);
      const retired = used.get(input.id);
      if (retired?.attemptID === input.attemptID && (retired.terminal || job?.abort.signal.aborted)) {
        if (input.action === 'cancel') return;
        if (retired.ended) throw fail('native_claude_transport_invalid');
        if (input.action === 'end') { retired.ended = true; return; }
        if (input.sequence !== retired.sequence + 1) throw fail('native_claude_transport_invalid');
        retired.sequence = input.sequence; return;
      }
      if (!job || job.input.attemptID !== input.attemptID) throw fail('native_claude_transport_expired');
      if (input.action === 'cancel') { cancel(job); await job.work; return; }
      assert(job);
      if (!job.handle) throw fail('native_claude_transport_invalid');
      if (job.ended) throw fail('native_claude_transport_invalid');
      if (input.action === 'end') { job.ended = true; retired.ended = true; await job.writes; if (job.abort.signal.aborted || job.closing) return; assert(job); job.handle.child.stdin.end(); return; }
      if (input.sequence !== job.inputSequence + 1) { job.failure = 'native_claude_transport_invalid'; cancel(job); throw fail(job.failure); }
      job.inputSequence = input.sequence;
      retired.sequence = input.sequence;
      const bytes = Buffer.from(input.chunk, 'base64');
      if (job.inputBytes + bytes.length > MAX_QUEUED_BYTES) { job.failure = 'native_claude_transport_overflow'; cancel(job); throw fail(job.failure); }
      job.inputBytes += bytes.length;
      const write = job.writes.then(() => new Promise((resolve, reject) => {
        try { if (job.closing) { resolve(); return; } assert(job); job.handle.child.stdin.write(bytes, error => error ? reject(error) : resolve()); } catch (error) { reject(error); }
      })).finally(() => { job.inputBytes -= bytes.length; });
      job.writes = write.then(async () => {
        if (!job.abort.signal.aborted && !job.closing) await reply(input.id, 'input-accepted', { sequence: input.sequence });
      }).catch(() => { if (!job.abort.signal.aborted) job.failure = 'native_claude_transport_failed'; cancel(job); });
      await job.writes;
    },
    async close() {
      closed = true; attempts.clear(); const active = [...jobs.values()];
      for (const job of active) cancel(job);
      await Promise.all(active.map(job => job.work));
    },
  };
}
