import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { CLAUDE_AGENT_CHUNK_BYTES, parseClaudeAgentReply, parseClaudeAgentRequest } from './claude-agent-protocol.js';

/**
 * OpenCode's claude-agent provider drives Claude Code through the Agent SDK. The
 * controller is confined (no keychain, no writes outside its bundle), so its SDK
 * asks this host to start the user's own `claude`. The host accepts only the
 * tool-less invocation OpenCode builds: Claude Code's built-in tools stay off and
 * every action goes through OpenCode's MCP tools, which DevRyan executes itself.
 */
const fail = code => Object.assign(new Error(code), { code });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,127}$/;
const MAX_PROCESSES = 32;

const FLAGS = new Set(['--verbose', '--strict-mcp-config', '--include-partial-messages', '--no-session-persistence', '--fork-session',
  '--thinking=adaptive', '--thinking=disabled']);
const EXACT = new Map([['--output-format', 'stream-json'], ['--input-format', 'stream-json'], ['--allowedTools', 'mcp__opencode__*'],
  ['--tools', ''], ['--setting-sources', ''], ['--permission-mode', 'dontAsk']]);
const VALUED = new Map([
  ['--model', value => MODEL.test(value)], ['--fallback-model', value => MODEL.test(value)],
  ['--effort', value => ['low', 'medium', 'high', 'xhigh', 'max'].includes(value)],
  ['--thinking-display', value => ['summarized', 'omitted'].includes(value)],
  ['--max-thinking-tokens', value => /^[1-9][0-9]{0,6}$/.test(value)], ['--max-turns', value => /^[1-9][0-9]{0,4}$/.test(value)],
  ['--resume', value => UUID.test(value)], ['--session-id', value => UUID.test(value)], ['--resume-session-at', value => UUID.test(value)],
  ['--settings', value => {
    const settings = JSON.parse(value);
    return settings && typeof settings === 'object' && !Array.isArray(settings) && Object.keys(settings).join() === 'disableAllHooks' && settings.disableAllHooks === true;
  }],
  // Only the SDK's in-process MCP servers: OpenCode's tool bridge, served over this stdio relay.
  ['--mcp-config', value => {
    const config = JSON.parse(value);
    const servers = config?.mcpServers;
    return Object.keys(config ?? {}).join() === 'mcpServers' && servers && typeof servers === 'object' && !Array.isArray(servers)
      && Object.entries(servers).every(([name, server]) => name === 'opencode' && server?.type === 'sdk' && server.name === 'opencode'
        && Object.keys(server).every(key => key === 'type' || key === 'name'));
  }],
]);

/** Refuses any Claude Code argument outside the reviewed tool-less SDK invocation. */
export function assertClaudeAgentArgs(args) {
  const required = new Set(['--tools', '--allowedTools', '--permission-mode', '--setting-sources', '--strict-mcp-config']);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (FLAGS.has(arg)) { required.delete(arg); continue; }
    const equals = arg.indexOf('=');
    const name = equals > 0 ? arg.slice(0, equals) : arg;
    let value;
    if (equals > 0) value = arg.slice(equals + 1);
    else if (EXACT.has(name) || VALUED.has(name)) {
      if (index + 1 >= args.length) throw fail('claude_agent_argument_refused');
      value = args[++index];
    } else throw fail('claude_agent_argument_refused');
    let accepted = false;
    try { accepted = EXACT.has(name) ? EXACT.get(name) === value : VALUED.has(name) && VALUED.get(name)(value) === true; }
    catch { accepted = false; }
    if (!accepted) throw fail('claude_agent_argument_refused');
    required.delete(name);
  }
  if (required.size) throw fail('claude_agent_argument_refused');
  return args;
}

const FORWARDED_ENV = new Set([
  'CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SDK_READS_SESSION_STATE', 'CLAUDE_CODE_DISABLE_CLAUDE_MDS',
  'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'DISABLE_AUTO_COMPACT', 'CLAUDE_CODE_ENABLE_AWAY_SUMMARY', 'ENABLE_TOOL_SEARCH',
  'CLAUDE_CODE_DISABLE_ADVISOR_TOOL', 'MAX_MCP_OUTPUT_TOKENS', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  // Optional claude-agent connection settings (gateway, key, timeouts) the user configured in OpenCode.
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'API_TIMEOUT_MS',
  'CLAUDE_STREAM_IDLE_TIMEOUT_MS', 'CLAUDE_CODE_EXTRA_BODY',
]);
const HOST_ENV = ['PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', '__CF_USER_TEXT_ENCODING'];

/**
 * The account's real home, so macOS finds the login keychain; the controller's isolated
 * globals never reach Claude Code. A host running under another HOME (isolated QA)
 * keeps Claude Code's own state there through CLAUDE_CONFIG_DIR instead.
 */
export function buildClaudeAgentEnvironment(requested, { hostEnv = process.env, home = os.homedir(), accountHome = os.userInfo().homedir,
  tmpdir = os.tmpdir() } = {}) {
  const env = { HOME: accountHome, TMPDIR: tmpdir };
  if (path.resolve(home) !== path.resolve(accountHome)) env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
  for (const name of HOST_ENV) if (typeof hostEnv[name] === 'string') env[name] = hostEnv[name];
  for (const [name, value] of Object.entries(requested)) if (FORWARDED_ENV.has(name)) env[name] = value;
  return env;
}

const isExecutable = file => {
  try { return fs.statSync(file).isFile() && (fs.accessSync(file, fs.constants.X_OK), true); } catch { return false; }
};
/** The user's own Claude Code: explicit override, then PATH, then the official installer locations. */
export function resolveClaudeExecutable({ env = process.env, home = os.userInfo().homedir } = {}) {
  for (const override of [env.DEVRYAN_CLAUDE_PATH, env.OPENCODE_CLAUDE_PATH]) {
    if (override) return path.isAbsolute(override) && isExecutable(override) ? override : undefined;
  }
  const directories = [...String(env.PATH ?? '').split(path.delimiter), path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'),
    '/opt/homebrew/bin', '/usr/local/bin'];
  for (const directory of directories) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, 'claude');
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

const WINDOWS = Object.freeze(['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_overage_included', 'overage']);
const usageWindow = value => {
  if (!value || typeof value !== 'object') return undefined;
  const utilization = typeof value.utilization === 'number' && Number.isFinite(value.utilization) ? Math.min(Math.max(value.utilization, 0), 10) : undefined;
  const resetsAt = Number.isSafeInteger(value.resetsAt) && value.resetsAt > 0 ? value.resetsAt : undefined;
  const status = ['allowed', 'allowed_warning', 'rejected'].includes(value.status) ? value.status : undefined;
  return utilization === undefined && resetsAt === undefined ? undefined : { ...(utilization === undefined ? {} : { utilization }), ...(resetsAt ? { resetsAt } : {}), ...(status ? { status } : {}) };
};
/** Reduces Claude Code's subscription rate-limit event to the reviewed usage record. */
export function claudeAgentUsageFromEvent(info, previous, now = Date.now()) {
  if (!info || typeof info !== 'object') return previous;
  const windows = { ...(previous?.windows ?? {}) };
  if (WINDOWS.includes(info.rateLimitType)) {
    const window = usageWindow(info);
    if (window) windows[info.rateLimitType] = window;
  }
  if (info.unifiedWindows && typeof info.unifiedWindows === 'object') {
    for (const name of WINDOWS) {
      const window = usageWindow(info.unifiedWindows[name]);
      if (window) windows[name] = window;
    }
  }
  const overage = ['allowed', 'allowed_warning', 'rejected'].includes(info.overageStatus)
    ? { status: info.overageStatus, using: info.isUsingOverage === true } : previous?.overage;
  return { version: 1, updatedAt: now, ...(overage ? { overage } : {}), windows };
}

/** Stateless owner of host-launched Claude Code processes for one controller instance. */
export function createClaudeAgentHost({ usageFile, resolveExecutable = resolveClaudeExecutable, spawnImpl = nodeSpawn,
  environment = buildClaudeAgentEnvironment, loadSessions = defaultSessions, onDiagnostic = () => {}, now = Date.now }) {
  const processes = new Map();
  let closed = false, usage, usageWrite = Promise.resolve(), send;
  const reply = value => { const frame = parseClaudeAgentReply({ protocol: 1, type: 'claude-agent-reply', ...value }); send?.(frame); };
  const recordUsage = info => {
    usage = claudeAgentUsageFromEvent(info, usage ?? readClaudeAgentUsage(usageFile), now());
    if (!usageFile) return;
    const snapshot = JSON.stringify(usage);
    usageWrite = usageWrite.then(async () => {
      await fs.promises.mkdir(path.dirname(usageFile), { recursive: true, mode: 0o700 });
      const temporary = `${usageFile}.${process.pid}.tmp`;
      await fs.promises.writeFile(temporary, snapshot, { mode: 0o600 });
      await fs.promises.rename(temporary, usageFile);
    }).catch(() => onDiagnostic({ event: 'claude_agent_usage_write_failed' }));
  };
  const observe = state => text => {
    state.line += text;
    let end;
    while ((end = state.line.indexOf('\n')) !== -1) {
      const line = state.line.slice(0, end); state.line = state.line.slice(end + 1);
      if (!line.includes('"rate_limit_event"')) continue;
      try { const message = JSON.parse(line); if (message?.type === 'rate_limit_event') recordUsage(message.rate_limit_info); }
      catch { /* Claude Code owns its stream; an unparsed line is not usage. */ }
    }
    // Bound the observer, not the relay: oversized lines pass through unobserved.
    if (state.line.length > 1024 * 1024) state.line = '';
  };
  // The SDK writes its initialize frame right after spawn; hold input until the child exists.
  const deliver = (state, frame) => {
    if (!state.child) return void state.queued.push(frame);
    if (frame.action === 'stdin') state.child.stdin.write(Buffer.from(frame.chunk, 'base64'));
    else if (frame.action === 'end') state.child.stdin.end();
    else if (frame.action === 'kill') state.child.kill(frame.signal);
  };
  const spawnProcess = async request => {
    if (processes.size >= MAX_PROCESSES) throw fail('claude_agent_limit');
    const state = { child: undefined, queued: [], line: '', stderr: Buffer.alloc(0), settled: false };
    processes.set(request.id, state);
    try { await launch(request, state); }
    catch (error) { processes.delete(request.id); throw error; }
  };
  const launch = async (request, state) => {
    assertClaudeAgentArgs(request.args);
    const executable = resolveExecutable();
    if (!executable) throw fail('claude_agent_missing');
    let stat;
    try { stat = await fs.promises.stat(request.cwd); } catch { stat = undefined; }
    if (!stat?.isDirectory()) throw fail('claude_agent_directory_invalid');
    if (closed) throw fail('claude_agent_closed');
    // A kill before launch cancels it outright.
    if (state.queued.some(frame => frame.action === 'kill')) throw fail('claude_agent_closed');
    const child = spawnImpl(executable, request.args, { cwd: request.cwd, env: environment(request.env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    state.child = child;
    const watch = observe(state);
    child.stdout.on('data', bytes => {
      watch(bytes.toString('utf8'));
      for (let offset = 0; offset < bytes.length; offset += CLAUDE_AGENT_CHUNK_BYTES) {
        reply({ id: request.id, action: 'stdout', chunk: bytes.subarray(offset, offset + CLAUDE_AGENT_CHUNK_BYTES).toString('base64') });
      }
    });
    // Claude Code's stderr can carry account details; keep only a bounded tail for the diagnostic code.
    child.stderr.on('data', bytes => { state.stderr = Buffer.concat([state.stderr, bytes]).subarray(-4096); });
    child.stdin.on('error', () => {});
    const settle = (code, signal, error) => {
      if (state.settled) return; state.settled = true;
      processes.delete(request.id);
      reply({ id: request.id, action: 'exit', code: Number.isSafeInteger(code) ? Math.min(Math.max(code, 0), 255) : null, signal: signal ?? null, ...(error ? { error } : {}) });
    };
    child.once('error', () => settle(null, null, 'claude_agent_launch_failed'));
    child.once('close', (code, signal) => settle(code, signal));
    reply({ id: request.id, action: 'started' });
    for (const frame of state.queued.splice(0)) deliver(state, frame);
  };
  const sessionOperation = async request => {
    const sessions = await loadSessions();
    try {
      if (request.operation === 'exists') return await sessions.exists(request.sessionID);
      if (request.operation === 'remove') { await sessions.remove(request.sessionID); return true; }
      const fork = await sessions.fork(request.sessionID, request.messageID);
      return fork ? { sessionID: fork.sessionID, messages: [...fork.messages] } : null;
    } catch { throw fail('claude_agent_session_failed'); }
  };
  return {
    /** Binds the controller's stdin; frames before attachment have no reader. */
    attach(writer) { send = writer; },
    /** Accepts one controller frame. Never throws: refusals return to the frame's owner. */
    accept(value) {
      let request;
      try { request = parseClaudeAgentRequest(value); }
      catch { onDiagnostic({ event: 'claude_agent_frame_invalid' }); return; }
      const refuse = error => {
        const code = typeof error?.code === 'string' && error.code.startsWith('claude_agent_') ? error.code : 'claude_agent_launch_failed';
        if (request.action === 'spawn') reply({ id: request.id, action: 'exit', code: null, signal: null, error: code });
        else reply({ id: request.id, action: 'error', error: code });
        onDiagnostic({ event: 'claude_agent_refused', action: request.action, code });
      };
      if (closed) return refuse(fail('claude_agent_closed'));
      if (request.action === 'spawn') return void spawnProcess(request).catch(refuse);
      if (request.action === 'session') return void sessionOperation(request).then(result => reply({ id: request.id, action: 'result', result }), refuse);
      const state = processes.get(request.id);
      if (state) deliver(state, request);
    },
    /** Usage from Claude Code's last reported rate-limit event, in memory or persisted. */
    usage: () => usage ?? readClaudeAgentUsage(usageFile),
    async close() {
      closed = true;
      const children = [...processes.values()].filter(state => state.child);
      for (const { child } of children) child.kill('SIGTERM');
      await Promise.all(children.map(({ child }) => new Promise(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000);
        child.once('close', () => { clearTimeout(timer); resolve(); });
      })));
      await usageWrite;
    },
  };
}

/** Claude Code session files live under the user's real ~/.claude, which only the host can write. */
async function defaultSessions() {
  const [{ getSessionInfo, deleteSession }, { create }] = await Promise.all([
    import('@anthropic-ai/claude-agent-sdk'),
    import('@opencode/core/plugin/provider/claude-agent/claude/fork'),
  ]);
  return {
    exists: async sessionID => await getSessionInfo(sessionID) !== undefined,
    remove: sessionID => deleteSession(sessionID),
    fork: (sessionID, messageID) => create(sessionID, messageID),
  };
}

export function readClaudeAgentUsage(usageFile) {
  if (!usageFile) return undefined;
  try {
    const value = JSON.parse(fs.readFileSync(usageFile, 'utf8'));
    return value?.version === 1 && value.windows && typeof value.windows === 'object' ? value : undefined;
  } catch { return undefined; }
}
