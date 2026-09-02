// Deliberately narrower than the presentation/error-wording classifier.
export const PROVIDER_RECOVERY_POLICY_VERSION = 1;
export const PROVIDER_PROGRESS_TIMEOUT_MS = 300_000;
export const RECOVERY_READ_TOOLS = Object.freeze(['read', 'glob', 'grep']);
export const RECOVERY_CONTINUATION = 'Continue from the existing progress and completed tool results. This automatic recovery is read-only. Do not repeat completed actions. Finish the response, or explain what requires explicit user continuation.';
// OpenCode versions whose plugin hooks, request preparation, tool registry and
// lossy `UnknownError` timeout shape were verified for automatic primary
// recovery (docs/PROVIDER_RECOVERY.md). Extend only with transport and hook
// conformance evidence; the host target pin lives in
// packages/web/server/lib/opencode/version-policy.js and must stay listed here.
export const PROVIDER_RECOVERY_SUPPORTED_OPENCODE_VERSIONS = Object.freeze(['1.18.25', '1.18.26']);
export const isProviderRecoverySupportedRuntimeVersion = (version) => (
  typeof version === 'string' && PROVIDER_RECOVERY_SUPPORTED_OPENCODE_VERSIONS.includes(version)
);

export const recoveryError = (code, statusCode = 409) => Object.assign(
  new Error(code.replaceAll('_', ' ')), { code, statusCode },
);

export function classifyPrimaryTransportError(error, runtimeVersion) {
  if (!error || typeof error !== 'object') return null;
  const name = String(error.name ?? '');
  const code = String(error.code ?? error.data?.code ?? '');
  const message = String(error.data?.message ?? error.message ?? '');
  const status = error.statusCode ?? error.status ?? error.data?.statusCode;
  if (Number.isInteger(status) && status >= 400 && status < 500) return null;
  if (/auth|certificate|cert_|quota|policy|model.?not.?found|abort|cancel|usage.?limit/i.test(`${name} ${code} ${message}`)) return null;
  const codes = {
    ETIMEDOUT: 'request_timeout', ECONNRESET: 'connection_reset', EPIPE: 'connection_reset',
    UND_ERR_HEADERS_TIMEOUT: 'header_timeout', UND_ERR_SOCKET: 'connection_reset',
  };
  if (codes[code]) return { kind: codes[code], source: 'transport_code' };
  if (name === 'TimeoutError') return { kind: 'request_timeout', source: 'error_type' };
  if (name === 'ProviderHeaderTimeoutError') return { kind: 'header_timeout', source: 'error_type' };
  if (name === 'ProviderResponseStreamError' && message === 'SSE read timed out') {
    return { kind: 'chunk_timeout', source: 'error_type' };
  }
  if (isProviderRecoverySupportedRuntimeVersion(runtimeVersion) && name === 'UnknownError' && message === 'The operation timed out.') {
    return { kind: 'request_timeout', source: `opencode_${runtimeVersion}_compatibility` };
  }
  return null;
}

export function validatePrimaryRecoveryRecord(value) {
  if (!value || value.version !== 1 || typeof value !== 'object') throw recoveryError('invalid_recovery_record');
  for (const key of ['sessionID', 'anchorID', 'directory', 'providerID', 'modelID', 'agent', 'state']) {
    if (typeof value[key] !== 'string' || !value[key] || (key !== 'directory' && value[key].length > 256)) throw recoveryError('invalid_recovery_record');
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 1
    || ![0, 1].includes(value.attemptCount) || !Number.isFinite(value.updatedAt)
    || !Number.isFinite(value.createdAt) || !Array.isArray(value.guardedIDs)
    || value.guardedIDs.some((id) => typeof id !== 'string')
    || !['observing', 'stopping', 'reconciling', 'recovery_reserved', 'recovering', 'completed', 'needs_attention', 'cancelled', 'superseded'].includes(value.state)
    || !value.tools || typeof value.tools !== 'object'
    || Object.values(value.tools).some((enabled) => typeof enabled !== 'boolean')
    || (value.allowedReadTools !== undefined && (!Array.isArray(value.allowedReadTools)
      || value.allowedReadTools.some((tool) => !RECOVERY_READ_TOOLS.includes(tool))))
    || (value.attemptCount === 1 && typeof value.recoveryID !== 'string')
    || (['recovery_reserved', 'recovering'].includes(value.state) && value.attemptCount !== 1)
    || (value.recoveryID && (value.attemptCount !== 1 || !value.guardedIDs.includes(value.recoveryID)))) throw recoveryError('invalid_recovery_record');
  return value;
}

// All records from the anchor to the current tail are required, not a UI page.
export function inspectRecoveryTurn(record, observation) {
  if (!observation || observation.session?.id !== record.sessionID || observation.session.parentID
    || observation.session.directory !== record.directory || observation.session.time?.archived
    || !Array.isArray(observation.messages) || observation.complete !== true
    || !['idle', 'busy', 'retry'].includes(observation.status)) throw recoveryError('invalid_recovery_observation');
  const messages = observation.messages;
  const anchorIndex = messages.findIndex((m) => m.info?.id === record.anchorID && m.info.role === 'user');
  if (anchorIndex < 0) throw recoveryError('recovery_anchor_unavailable');
  const tail = messages.slice(anchorIndex);
  const users = tail.filter((m) => m.info.role === 'user');
  const currentUser = users.at(-1)?.info.id;
  const originalUser = record.continuationID ?? record.anchorID;
  const expectedUser = record.recoveryID ?? originalUser;
  const recoveryAccepted = Boolean(record.recoveryID && currentUser === record.recoveryID);
  const superseded = currentUser !== expectedUser && !(record.recoveryID && currentUser === originalUser);
  const assistants = tail.filter((m) => m.info.role === 'assistant' && m.info.parentID === expectedUser);
  const last = assistants.at(-1);
  const failed = record.failedID ? tail.find((m) => m.info.id === record.failedID
    && m.info.role === 'assistant' && m.info.parentID === originalUser) : last;
  const parts = tail.flatMap((m) => m.parts ?? []);
  // Terminal errors on tools may hide an applied side effect: automatic recovery
  // must not decide its outcome from an error label.
  const unresolved = parts.some((p) => p.type === 'tool' && p.state?.status !== 'completed');
  const hasWork = tail.some((m) => m.info.role === 'assistant' && (m.parts ?? []).some((p) => (
    p.type === 'tool' || p.type === 'patch'
    || (['text', 'reasoning'].includes(p.type) && Boolean(p.text?.trim()))
  )));
  const settled = observation.status === 'idle' && !observation.blocked && !unresolved
    && Boolean(last?.info.time?.completed) && last.info.parentID === expectedUser
    && (!record.failedID || Boolean(failed?.info.time?.completed));
  const originalParts = tail[0].parts.filter((p) => !p.synthetic && ['text', 'file'].includes(p.type))
    .map((p) => p.type === 'text' ? { type: 'text', text: p.text } : {
      type: 'file', mime: p.mime, filename: p.filename, url: p.url,
    });
  const safeAttachments = originalParts.every((p) => p.type !== 'file' || /^(file:\/\/\/|data:)/.test(p.url ?? ''));
  return { superseded, recoveryAccepted, currentUser, last, failed, settled, unresolved, hasWork,
    recoveryParts: hasWork ? [{ type: 'text', text: RECOVERY_CONTINUATION }] : safeAttachments ? originalParts : [] };
}
