import path from 'node:path';

/** Frames between the confined controller and the host that owns Claude Code processes. */
export const CLAUDE_AGENT_CHUNK_BYTES = 16384;
/** Sentinel executable the controller reports to OpenCode; the host always resolves the real `claude`. */
export const CLAUDE_AGENT_EXECUTABLE = '/devryan/claude-agent/claude';
export const CLAUDE_AGENT_ERRORS = Object.freeze([
  'claude_agent_invalid', 'claude_agent_missing', 'claude_agent_argument_refused', 'claude_agent_directory_invalid',
  'claude_agent_launch_failed', 'claude_agent_limit', 'claude_agent_closed', 'claude_agent_session_failed',
]);
const SESSION_OPERATIONS = Object.freeze(['exists', 'fork', 'remove']);
const SIGNALS = Object.freeze(['SIGTERM', 'SIGKILL', 'SIGINT']);

const fail = () => Object.assign(new Error('claude_agent_invalid'), { code: 'claude_agent_invalid' });
const keys = (value, allowed) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw fail();
};
const id = value => { if (typeof value !== 'string' || !/^[a-f0-9-]{32,64}$/.test(value)) throw fail(); };
const text = (value, max) => { if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw fail(); };
const chunk = value => {
  if (typeof value !== 'string' || !value.length || value.length > 21848
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw fail();
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value || decoded.length > CLAUDE_AGENT_CHUNK_BYTES) throw fail();
};
const claudeSession = value => {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw fail();
};

export function parseClaudeAgentRequest(value) {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > 60 * 1024) throw fail();
  const action = value?.action;
  const fields = action === 'spawn' ? ['args', 'cwd', 'env'] : action === 'stdin' ? ['chunk'] : action === 'kill' ? ['signal']
    : action === 'session' ? ['operation', 'sessionID', 'messageID'] : [];
  keys(value, ['protocol', 'type', 'action', 'id', ...fields]);
  if (value.protocol !== 1 || value.type !== 'claude-agent' || !['spawn', 'stdin', 'end', 'kill', 'session'].includes(action)) throw fail();
  id(value.id);
  if (action === 'spawn') {
    if (!Array.isArray(value.args) || value.args.length > 128) throw fail();
    for (const arg of value.args) text(arg, 16384);
    text(value.cwd, 8192);
    if (!path.isAbsolute(value.cwd) || /[\u0000-\u001f]/.test(value.cwd)) throw fail();
    keys(value.env, Object.keys(value.env ?? {}));
    if (Object.keys(value.env).length > 256) throw fail();
    for (const [name, entry] of Object.entries(value.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) throw fail();
      text(entry, 16384);
    }
  }
  if (action === 'stdin') chunk(value.chunk);
  if (action === 'kill' && !SIGNALS.includes(value.signal)) throw fail();
  if (action === 'session') {
    if (!SESSION_OPERATIONS.includes(value.operation)) throw fail();
    claudeSession(value.sessionID);
    if (value.operation === 'fork') claudeSession(value.messageID);
    else if (value.messageID !== undefined) throw fail();
  }
  return value;
}

export function parseClaudeAgentReply(value) {
  // Host-to-controller lines share the controller's record bound; a fork maps every copied message.
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > 8 * 1024 * 1024) throw fail();
  const action = value?.action;
  const fields = action === 'stdout' ? ['chunk'] : action === 'exit' ? ['code', 'signal', 'error'] : action === 'result' ? ['result'] : action === 'error' ? ['error'] : [];
  keys(value, ['protocol', 'type', 'action', 'id', ...fields]);
  if (value.protocol !== 1 || value.type !== 'claude-agent-reply' || !['started', 'stdout', 'exit', 'result', 'error'].includes(action)) throw fail();
  id(value.id);
  if (action === 'stdout') chunk(value.chunk);
  if (action === 'exit') {
    if (value.code !== null && (!Number.isSafeInteger(value.code) || value.code < 0 || value.code > 255)) throw fail();
    if (value.signal !== null && (typeof value.signal !== 'string' || !/^SIG[A-Z0-9]{1,16}$/.test(value.signal))) throw fail();
    if (value.error !== undefined && !CLAUDE_AGENT_ERRORS.includes(value.error)) throw fail();
  }
  if (action === 'error' && !CLAUDE_AGENT_ERRORS.includes(value.error)) throw fail();
  if (action === 'result') {
    const result = value.result;
    if (typeof result === 'boolean' || result === null) return value;
    keys(result, ['sessionID', 'messages']);
    claudeSession(result.sessionID);
    if (!Array.isArray(result.messages) || result.messages.length > 100_000) throw fail();
    for (const pair of result.messages) {
      if (!Array.isArray(pair) || pair.length !== 2) throw fail();
      pair.forEach(claudeSession);
    }
  }
  return value;
}
