import path from 'node:path';

const fail = () => Object.assign(new Error('native_claude_transport_invalid'), { code: 'native_claude_transport_invalid' });
const keys = (value, allowed) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw fail();
};
const id = value => {
  if (typeof value !== 'string' || !/^[a-f0-9-]{32,64}$/.test(value)) throw fail();
};
const bytes = value => {
  if (typeof value !== 'string' || !value.length || value.length > 21848
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw fail();
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value || decoded.length > CLAUDE_TRANSPORT_CHUNK_BYTES) throw fail();
};
const sequence = value => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 0xffffffff) throw fail();
};

export const CLAUDE_TRANSPORT_CHUNK_BYTES = 16384;
export function parseClaudeTransportIncarnation(value) {
  keys(value, ['version', 'pid', 'hostId', 'bootId', 'startId', 'startIdKind']);
  const validStart = value.startIdKind === 'darwin-ps-lstart'
    ? /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ 0-3][0-9] [0-2][0-9]:[0-5][0-9]:[0-6][0-9] [0-9]{4}$/.test(value.startId)
    : ['linux-proc-start-ticks', 'windows-start-ticks'].includes(value.startIdKind) && /^[1-9][0-9]{0,31}$/.test(value.startId);
  if (value.version !== 1 || !Number.isSafeInteger(value.pid) || value.pid < 1 || value.pid > 0xffffffff
    || typeof value.hostId !== 'string' || !/^[a-f0-9]{64}$/.test(value.hostId)
    || typeof value.bootId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.bootId)
    || typeof value.startId !== 'string' || !validStart) throw fail();
  return value;
}
export const CLAUDE_TRANSPORT_ERRORS = Object.freeze([
  'native_claude_transport_invalid', 'native_claude_transport_expired', 'native_claude_transport_failed',
  'native_claude_transport_overflow', 'native_claude_transport_unconfirmed',
  'native_claude_transport_credential_failed', 'native_claude_transport_state_failed',
  'native_claude_transport_launch_failed', 'native_claude_transport_identity_failed', 'native_claude_transport_attach_failed',
]);

export function parseClaudeTransportRequest(value) {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > 1024 * 1024) throw fail();
  const action = value?.action;
  const fields = action === 'start' ? ['sessionID', 'directory', 'profileID', 'args', 'modelPins', 'toolSearch']
    : action === 'stdin' ? ['chunk', 'sequence'] : [];
  keys(value, ['protocol', 'type', 'action', 'id', 'attemptID', ...fields]);
  id(value.id);
  if (typeof value.attemptID !== 'string' || !/^[a-f0-9]{64}$/.test(value.attemptID)) throw fail();
  if (value.protocol !== 1 || value.type !== 'claude-transport' || !['start', 'stdin', 'end', 'cancel'].includes(action)) throw fail();
  if (action === 'stdin') {
    bytes(value.chunk);
    sequence(value.sequence);
  }
  if (action === 'start') {
    if (typeof value.sessionID !== 'string' || !/^ses[0-9A-Za-z_-]{1,128}$/.test(value.sessionID)
      || typeof value.directory !== 'string' || !path.isAbsolute(value.directory) || value.directory.length > 8192 || /[\u0000-\u001f]/.test(value.directory)
      || typeof value.profileID !== 'string' || !value.profileID || value.profileID.length > 256 || value.profileID.includes('\0')
      || !Array.isArray(value.args) || value.args.length > 4096
      || value.args.some(arg => typeof arg !== 'string' || arg.length > 1024 * 1024 || arg.includes('\0'))) throw fail();
    if (value.modelPins !== undefined) {
      keys(value.modelPins, ['fable', 'opus', 'sonnet', 'haiku']);
      if (Object.values(value.modelPins).some(pin => typeof pin !== 'string' || pin.length > 256
        || !/^claude-(?:fable|opus|sonnet|haiku|mythos)-\d[\w.-]*$/.test(pin))) throw fail();
    }
    if (value.toolSearch !== undefined && typeof value.toolSearch !== 'boolean') throw fail();
  }
  return value;
}

export function parseClaudeTransportReply(value) {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > 32768) throw fail();
  const action = value?.action;
  const fields = action === 'stdout' || action === 'stderr' ? ['chunk'] : action === 'started' ? ['pid', 'incarnation']
    : action === 'input-accepted' ? ['sequence'] : ['receipt', 'error'];
  keys(value, ['protocol', 'type', 'action', 'id', 'attemptID', ...fields]);
  id(value.id);
  if (typeof value.attemptID !== 'string' || !/^[a-f0-9]{64}$/.test(value.attemptID)) throw fail();
  if (value.protocol !== 1 || value.type !== 'claude-transport-reply'
    || !['started', 'input-accepted', 'stdout', 'stderr', 'settled'].includes(action)) throw fail();
  if (action === 'stdout' || action === 'stderr') bytes(value.chunk);
  if (action === 'started' && (!Number.isSafeInteger(value.pid) || value.pid < 1 || value.pid > 0xffffffff)) throw fail();
  if (action === 'started' && parseClaudeTransportIncarnation(value.incarnation).pid !== value.pid) throw fail();
  if (action === 'input-accepted') sequence(value.sequence);
  if (action === 'settled') {
    if (value.receipt !== undefined) {
      keys(value.receipt, ['terminated', 'confined', 'cancelled', 'exitCode']);
      if (value.receipt.terminated !== true || value.receipt.confined !== true || typeof value.receipt.cancelled !== 'boolean'
        || !Number.isSafeInteger(value.receipt.exitCode) || value.receipt.exitCode < 0 || value.receipt.exitCode > 255) throw fail();
    }
    if ((value.error !== undefined && !CLAUDE_TRANSPORT_ERRORS.includes(value.error))
      || (value.receipt === undefined && value.error === undefined)) throw fail();
  }
  return value;
}
