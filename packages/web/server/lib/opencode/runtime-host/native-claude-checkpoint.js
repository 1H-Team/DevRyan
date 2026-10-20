import path from 'node:path';
import { createHash } from 'node:crypto';

export const CLAUDE_CHECKPOINT_EVENTS = Object.freeze(['passthrough.checkpoint_settling', 'passthrough.checkpoint_settled',
  'passthrough.checkpoint_rejected', 'passthrough.checkpoint_interrupt_failed', 'passthrough.checkpoint_retained', 'passthrough.checkpoint_replay']);
export const CLAUDE_CHECKPOINT_REASONS = Object.freeze(['tool_results_complete', 'invalid_boundary', 'control_failed',
  'drain_timeout', 'client_abort', 'sdk_terminal', 'missing_terminal', 'unrecognized_sdk_exit', 'incomplete_boundary',
  'persisted_boundary_unverified', 'persisted_tool_boundary', 'verified_handoff', 'incomplete_or_mismatched_results']);
const fail = () => Object.assign(new Error('native_claude_transport_invalid'), { code: 'native_claude_transport_invalid' });

/** Both sides derive this from the same immutable provider boot, never SDK environment claims. */
export function nativeClaudeStateDirectory({ storage, home, profile, directory }) {
  const account = profile.claudeConfigDir || path.join(home, '.claude');
  if (![storage, home, account, directory].every(value => typeof value === 'string' && path.isAbsolute(value))) throw fail();
  return path.join(storage, 'state', createHash('sha256').update(JSON.stringify([account, directory])).digest('hex'));
}

export function createNativeClaudeCheckpointOwner({ boot, assertAttempt, publish = () => {} }) {
  const snapshot = structuredClone(boot);
  const counts = new Map(), transports = new Map();
  const scope = (raw, cwd) => {
    if (typeof raw !== 'string' || raw.length > 16384) throw fail();
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['attemptID', 'sessionID', 'directory', 'profileID'].includes(key))
      || typeof value.attemptID !== 'string' || !/^[a-f0-9]{64}$/.test(value.attemptID)
      || typeof value.sessionID !== 'string' || !/^ses[0-9A-Za-z_-]{1,128}$/.test(value.sessionID)
      || !snapshot.transport.directories.includes(value.directory) || cwd !== value.directory) throw fail();
    const profile = snapshot.profiles.find(profile => profile.id === value.profileID)
      ?? (!snapshot.profiles.length && value.profileID === 'default' ? { id: 'default' } : undefined);
    if (!profile) throw fail();
    assertAttempt(value);
    return { value, profile };
  };
  return {
    bindTransport(raw, cwd) {
      const { value } = scope(raw, cwd), previous = transports.get(value.attemptID);
      if (previous !== undefined && previous !== value.profileID || previous === undefined && transports.size >= 128) throw fail();
      transports.set(value.attemptID, value.profileID);
    },
    directory(raw, cwd) {
      const { value, profile } = scope(raw, cwd);
      if (transports.get(value.attemptID) !== value.profileID) throw fail();
      return nativeClaudeStateDirectory({ ...snapshot.transport, home: snapshot.globals.home, profile, directory: value.directory });
    },
    release(attemptID) { transports.delete(attemptID); counts.delete(attemptID); },
    close() { transports.clear(); counts.clear(); },
    diagnostic(raw, event, detail) {
      try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : null;
        const { value } = scope(raw, parsed?.directory);
        if (!CLAUDE_CHECKPOINT_EVENTS.includes(event) || !detail || typeof detail !== 'object'
          || Object.keys(detail).some(key => !['reason', 'toolCount'].includes(key))
          || !CLAUDE_CHECKPOINT_REASONS.includes(detail.reason)
          || !Number.isSafeInteger(detail.toolCount) || detail.toolCount < 0 || detail.toolCount > 4096) return;
        const count = counts.get(value.attemptID) ?? 0;
        if (count >= 64) return;
        if (counts.size >= 128 && !counts.has(value.attemptID)) counts.delete(counts.keys().next().value);
        counts.set(value.attemptID, count + 1);
        publish({ protocol: 1, type: 'claude-checkpoint-diagnostic', instanceID: snapshot.instanceID,
          attemptID: value.attemptID, sessionID: value.sessionID, directory: value.directory,
          checkpoint: { event, reason: detail.reason, toolCount: detail.toolCount } });
      } catch { /* Bounded observations never change checkpoint settlement. */ }
    },
  };
}
