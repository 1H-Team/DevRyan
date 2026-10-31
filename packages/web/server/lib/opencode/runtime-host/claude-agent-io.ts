import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeIO } from '@opencode/core/plugin/provider/claude-agent/claude/io';
import { CLAUDE_AGENT_CHUNK_BYTES, CLAUDE_AGENT_EXECUTABLE, parseClaudeAgentReply, parseClaudeAgentRequest, type ClaudeAgentForkResult } from './claude-agent-protocol.js';

type Pending = { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void };
const fail = (code: string) => Object.assign(new Error(code), { code });
// OpenCode surfaces the SDK's error message as the integration status.
const MESSAGES: Readonly<Record<string, string>> = {
  claude_agent_missing: 'Claude Code is not installed. Install it from https://code.claude.com/docs/en/setup, then run `claude auth login`.',
  claude_agent_argument_refused: 'DevRyan refused a Claude Code option outside the reviewed tool-less invocation.',
  claude_agent_directory_invalid: 'The session directory is not available to Claude Code.',
  claude_agent_limit: 'Too many Claude Code processes are running.',
};
const isForkResult = (value: unknown): value is ClaudeAgentForkResult => typeof value === 'object' && value !== null && 'sessionID' in value;
const processError = (code: string) => Object.assign(new Error(MESSAGES[code] ?? `Claude Code could not start (${code}).`), { code });

/** One relayed Claude Code process: SDK-facing streams over host-owned stdio. */
class RelayedProcess extends EventEmitter implements SpawnedProcess {
  readonly stdout = new PassThrough();
  readonly stdin: Writable;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  constructor(private readonly id: string, private readonly send: (value: unknown) => void) {
    super();
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, done) => {
        for (let offset = 0; offset < chunk.length; offset += CLAUDE_AGENT_CHUNK_BYTES) {
          this.frame('stdin', { chunk: chunk.subarray(offset, offset + CLAUDE_AGENT_CHUNK_BYTES).toString('base64') });
        }
        done();
      },
      final: done => { this.frame('end', {}); done(); },
    });
  }
  frame(action: string, fields: Record<string, unknown>) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.send(parseClaudeAgentRequest({ protocol: 1, type: 'claude-agent', action, id: this.id, ...fields }));
  }
  kill(signal: NodeJS.Signals = 'SIGTERM') {
    if (this.exitCode !== null || this.signalCode !== null) return false;
    this.killed = true;
    this.frame('kill', { signal: ['SIGTERM', 'SIGKILL', 'SIGINT'].includes(signal) ? signal : 'SIGTERM' });
    return true;
  }
  settle(code: number | null, signal: string | null, error?: string) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.signalCode = (signal as NodeJS.Signals | null) ?? null;
    this.exitCode = code ?? (signal ? null : 1);
    this.stdout.end();
    if (error && this.listenerCount('error')) this.emit('error', processError(error));
    this.emit('exit', this.exitCode, this.signalCode);
  }
}

/** The confined controller's Claude Code IO: every process and session-file write runs on the host. */
export function createClaudeAgentChannel(write: (value: unknown) => void) {
  const processes = new Map<string, RelayedProcess>(), requests = new Map<string, Pending>();
  let closed = false;
  const request = (fields: Record<string, unknown>) => new Promise<unknown>((resolve, reject) => {
    if (closed) return reject(fail('claude_agent_closed'));
    const id = randomUUID();
    requests.set(id, { resolve, reject });
    write(parseClaudeAgentRequest({ protocol: 1, type: 'claude-agent', action: 'session', id, ...fields }));
  });
  const spawn = (options: SpawnOptions): SpawnedProcess => {
    const id = randomUUID(), child = new RelayedProcess(id, write);
    if (closed) { queueMicrotask(() => child.settle(null, null, 'claude_agent_closed')); return child; }
    processes.set(id, child);
    // The host resolves the executable; the SDK's command is only the controller sentinel.
    const env = Object.fromEntries(Object.entries(options.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    child.frame('spawn', { args: options.args, cwd: options.cwd ?? process.cwd(), env });
    options.signal?.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
    return child;
  };
  const io: ClaudeIO.Interface = {
    which: () => CLAUDE_AGENT_EXECUTABLE,
    // Host environment only; the controller's isolated HOME and XDG roots never reach Claude Code.
    env: () => ({}),
    spawn,
    sessionExists: async sessionID => await request({ operation: 'exists', sessionID }) === true,
    remove: async sessionID => { await request({ operation: 'remove', sessionID }); },
    fork: async (sessionID, messageID) => {
      const result = await request({ operation: 'fork', sessionID, messageID });
      return isForkResult(result) ? { sessionID: result.sessionID, messages: new Map(result.messages) } : undefined;
    },
  };
  return {
    io,
    /** Accepts one host reply frame from the controller's stdin. */
    accept(value: unknown) {
      const reply = parseClaudeAgentReply(value);
      const pending = requests.get(reply.id);
      if (pending) {
        requests.delete(reply.id);
        if (reply.action === 'result') pending.resolve(reply.result);
        else pending.reject(fail(reply.action === 'error' ? reply.error : 'claude_agent_session_failed'));
        return;
      }
      const child = processes.get(reply.id);
      if (!child) return;
      if (reply.action === 'stdout') child.stdout.write(Buffer.from(reply.chunk, 'base64'));
      else if (reply.action === 'exit') { processes.delete(reply.id); child.settle(reply.code, reply.signal, reply.error); }
    },
    close() {
      closed = true;
      for (const child of processes.values()) child.settle(null, 'SIGTERM', 'claude_agent_closed');
      processes.clear();
      for (const pending of requests.values()) pending.reject(fail('claude_agent_closed'));
      requests.clear();
    },
  };
}
