import { isNativeStatusRecord } from '../../shared-runtime/lib/native-message-status.js';
import { validateBuilderTodoGuard, validateObjectiveProgress, validateObjectiveRejections } from './objective-progress.js';
import { currentObjectiveUser, isNativeCompactionRecord } from './objective-identity.js';

// Deliberately narrower than the presentation/error-wording classifier.
export const PROVIDER_RECOVERY_POLICY_VERSION = 1;
export const PROVIDER_PROGRESS_TIMEOUT_MS = 300_000;
export const RECOVERY_READ_TOOLS = Object.freeze(['read', 'glob', 'grep']);
export const RECOVERY_CONTINUATION = 'Continue from the existing progress and completed tool results. This automatic recovery is read-only. Do not repeat completed actions. Finish the response, or explain what requires explicit user continuation.';
// OpenCode versions whose plugin hooks, request preparation, tool registry and
// lossy `UnknownError` timeout shape were verified for automatic primary
// recovery (docs/PROVIDER_RECOVERY.md). Extend only with transport and hook
// conformance evidence. The host target pin is independent of this allow-list.
export const PROVIDER_RECOVERY_SUPPORTED_OPENCODE_VERSIONS = Object.freeze(['1.18.25', '1.18.26', '1.18.27', '1.18.29', '1.18.30', '1.18.31', '1.18.32', '1.18.33']);
// Native Step/continuation ownership has separate conformance from legacy
// transport recovery. Keep exact canonical versions for retained rollback.
export const NATIVE_PRIMARY_SUPPORTED_OPENCODE_VERSIONS = Object.freeze(['2.0.20', '2.0.24']);
export const isNativePrimaryRuntimeVersion = version => NATIVE_PRIMARY_SUPPORTED_OPENCODE_VERSIONS.includes(version);
// The bundled companion runtime is a pinned upstream release plus DevRyan's
// execution patch, which does not touch provider transport; it reports
// `<upstream>-devryan.<n>` and is compatible exactly as its upstream base.
const COMPANION_RUNTIME_VERSION = /^(\d+\.\d+\.\d+)-devryan\.\d+$/;
export const providerRecoveryBaseVersion = (version) => (
  typeof version === 'string' ? version.match(COMPANION_RUNTIME_VERSION)?.[1] ?? version : null
);
export const isProviderRecoverySupportedRuntimeVersion = (version) => (
  PROVIDER_RECOVERY_SUPPORTED_OPENCODE_VERSIONS.includes(providerRecoveryBaseVersion(version))
);

// Claude transport/tool conformance must be established by the composing host.
// A requested enforce mode alone never authorizes an unverified integration.
export const isPrimaryRecoveryProvider = (providerID) => ['openai', 'anthropic'].includes(providerID);
export const primaryRecoveryMode = (providerID, options) => providerID === 'anthropic'
  ? options.anthropicMode ?? options.mode ?? 'enforce'
  : options.mode ?? 'observe';

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
  if (name === 'UnknownError' && isProviderRecoverySupportedRuntimeVersion(runtimeVersion) && message.length <= 4096) {
    try {
      const envelope = JSON.parse(message);
      if (envelope && typeof envelope === 'object' && !Array.isArray(envelope)
        && envelope.type === 'upstream_timeout' && typeof envelope.message === 'string'
        && /^Upstream stalled: no data for [1-9][0-9]{0,12}ms$/.test(envelope.message)) {
        return { kind: 'chunk_timeout', source: 'upstream_timeout_envelope' };
      }
    } catch { /* Unrecognized envelopes cannot authorize recovery. */ }
  }
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
    return { kind: 'request_timeout', source: `opencode_${providerRecoveryBaseVersion(runtimeVersion)}_compatibility` };
  }
  return null;
}

export function validatePrimaryRecoveryRecord(value) {
  const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
  const input=value?.recoveredInput;
  if(input!==undefined&&(!input||Object.keys(input).some(key=>!['inputID','payloadHash','enqueuedSeq','delivery','phase'].includes(key))
    || !/^msg_[A-Za-z0-9]+$/.test(input.inputID??'')||!hash(input.payloadHash)||!Number.isSafeInteger(input.enqueuedSeq)
    ||input.enqueuedSeq<0||!['queue','steer'].includes(input.delivery)||input.phase!=='adopted'))throw recoveryError('invalid_recovered_input');
  const dispositions=value?.recoveredInputDispositions;
  if(dispositions!==undefined&&(!Array.isArray(dispositions)||dispositions.length>128
    ||new Set(dispositions.map(item=>item?.inputID)).size!==dispositions.length
    ||dispositions.some(item=>!item||Object.keys(item).some(key=>!['inputID','payloadHash','enqueuedSeq','type','delivery','phase','eventID','eventSeq'].includes(key))
      ||!/^msg_[A-Za-z0-9]+$/.test(item.inputID??'')||!hash(item.payloadHash)||!Number.isSafeInteger(item.enqueuedSeq)||item.enqueuedSeq<0
      ||!['user','synthetic','compaction','move'].includes(item.type)||!['queue','steer'].includes(item.delivery)
      ||!['requested','cancelled'].includes(item.phase)||item.phase==='requested'&&(item.eventID!==undefined||item.eventSeq!==undefined)||item.phase==='cancelled'&&(!/^evt_[A-Za-z0-9]+$/.test(item.eventID??'')
        ||!Number.isSafeInteger(item.eventSeq)||item.eventSeq<=item.enqueuedSeq))))throw recoveryError('invalid_recovered_input_disposition');
  const fallback = value?.nativeFallback;
  const validExecution = execution => execution && ['providerID','modelID','agent','variant'].every(key => typeof execution[key] === 'string' && execution[key].length > 0 && execution[key].length <= 256) && execution.agent === value.agent;
  const validWitness = witness => witness && Object.keys(witness).every(key => ['attempt','permitSha256'].includes(key))
    && witness.attempt && Object.keys(witness.attempt).length === 2
    && ['traceID','spanID'].every(key => typeof witness.attempt[key] === 'string' && /^[a-f0-9]{1,128}$/.test(witness.attempt[key]))
    && typeof witness.permitSha256 === 'string' && /^[a-f0-9]{64}$/.test(witness.permitSha256);
  const pendingChoice = fallback?.pending;
  if (value?.nativeStepWitness !== undefined && (value.executionGeneration !== 2 || !validWitness(value.nativeStepWitness))) throw recoveryError('invalid_native_fallback');
  if (pendingChoice !== undefined && (!pendingChoice || fallback.stepID !== null
    || Object.keys(pendingChoice).some(key => !['instanceID','cancellationGeneration','previousStepID','attempt','permitSha256','currentExecution'].includes(key))
    || !validWitness({attempt:pendingChoice.attempt,permitSha256:pendingChoice.permitSha256})
    || typeof pendingChoice.instanceID !== 'string' || !pendingChoice.instanceID || pendingChoice.instanceID.length > 256
    || !Number.isSafeInteger(pendingChoice.cancellationGeneration) || pendingChoice.cancellationGeneration < 0
    || pendingChoice.previousStepID !== null && !/^msg_[a-zA-Z0-9]+$/.test(pendingChoice.previousStepID ?? '')
    || !validExecution(pendingChoice.currentExecution)
    || ['providerID','modelID','agent','variant'].some(key => pendingChoice.currentExecution[key] !== value[key]) || value.recoveryID || value.recoveryExecution)) throw recoveryError('invalid_native_fallback');
  if (fallback !== undefined && (value.executionGeneration !== 2 || !fallback || !(pendingChoice ? fallback.stepID === null : /^msg_[a-zA-Z0-9]+$/.test(fallback.stepID ?? ''))
    || !/^msg_[a-zA-Z0-9]+$/.test(fallback.userMessageID ?? '') || !Array.isArray(fallback.tried) || fallback.tried.length > 128
    || fallback.tried.some(item => typeof item !== 'string' || item.length > 512) || ![0,1,2].includes(fallback.exhaustion)
    || (fallback.execution !== undefined && !validExecution(fallback.execution)))) throw recoveryError('invalid_native_fallback');
  if (value?.recoveryExecution !== undefined && (value.executionGeneration !== 2 || !value.recoveryID || !validExecution(value.recoveryExecution)
    || JSON.stringify(value.recoveryExecution) !== JSON.stringify(fallback?.execution)
    || value.recoveryPrompt?.messageID !== value.recoveryID || value.recoveryPrompt?.model?.providerID !== value.recoveryExecution.providerID
    || value.recoveryPrompt?.model?.modelID !== value.recoveryExecution.modelID || value.recoveryPrompt?.agent !== value.agent
    || value.recoveryPrompt?.variant !== value.recoveryExecution.variant || !Array.isArray(value.recoveryPrompt?.parts)
    || !value.recoveryPrompt?.tools || Object.values(value.recoveryPrompt.tools).some(item=>typeof item!=='boolean')
    || Buffer.byteLength(JSON.stringify(value.recoveryPrompt))>64*1024)) throw recoveryError('invalid_native_fallback');
  const pending = value?.nativeContinuation;
  if (pending !== undefined && (!pending || value.executionGeneration !== 2
    || pending.messageID !== value.continuationID || !/^msg_[a-zA-Z0-9]+$/.test(pending.messageID ?? '')
    || !/^msg_[a-zA-Z0-9]+$/.test(pending.sourceUserMessageID ?? '')
    || !/^msg_[a-zA-Z0-9]+$/.test(pending.sourceAssistantMessageID ?? '')
    || !Number.isSafeInteger(pending.cancellationGeneration) || pending.cancellationGeneration < 0
    || !['builder_todo','orchestrator_todo','collect'].includes(pending.kind)
    || pending.prompt?.messageID !== pending.messageID || pending.prompt.agent !== value.agent
    || pending.prompt.model?.providerID !== value.providerID || pending.prompt.model?.modelID !== value.modelID
    || pending.prompt.variant !== value.variant || pending.prompt.objectiveID !== (value.objectiveID ?? value.anchorID)
    || JSON.stringify(pending.prompt.tools) !== JSON.stringify(value.tools)
    || !Array.isArray(pending.prompt.parts) || !pending.prompt.parts.length
    || pending.prompt.parts.some(part => part?.type !== 'text' || part.synthetic !== true || typeof part.text !== 'string')
    || Buffer.byteLength(JSON.stringify(pending.prompt)) > 64 * 1024)) throw recoveryError('invalid_native_primary_continuation');
  if (value?.executionGeneration !== undefined && (value.executionGeneration !== 2
    || typeof value.variant !== 'string' || value.variant.length === 0)) throw recoveryError('invalid_recovery_execution_selection');
  const owned = value?.ownedNativeContinuation;
  if (owned !== undefined && (!owned || !['native-shell', 'native-compaction'].includes(owned.kind)
    || !/^msg_[a-zA-Z0-9]+$/.test(owned.sourceUserMessageID ?? '') || !/^msg_[a-zA-Z0-9]+$/.test(owned.userMessageID ?? '')
    || !/^msg_[a-zA-Z0-9]+$/.test(owned.assistantMessageID ?? ''))) throw recoveryError('invalid_native_continuation');
  const wake = value?.collectionWake;
  if (wake !== undefined && (!wake || !/^dvr_task_[a-zA-Z0-9]+$/.test(wake.taskId)
    || !/^dvr_result_[a-zA-Z0-9_]+$/.test(wake.envelopeId) || !/^msg_[a-zA-Z0-9]+$/.test(wake.messageID)
    || !Number.isFinite(wake.reservedAt) || !Number.isSafeInteger(wake.generation) || wake.generation < 0)) throw recoveryError('invalid_collection_wake');
  const issue = value?.collectionIssue;
  if (issue !== undefined && issue !== null && (!/^dvr_task_[a-zA-Z0-9]+$/.test(issue.taskId)
    || !['managed_continuation_fenced', 'managed_continuation_blocked', 'managed_objective_mismatch',
      'managed_collection_unverified', 'managed_collection_delivery_unconfirmed'].includes(issue.code))) throw recoveryError('invalid_collection_issue');
  validateObjectiveRejections(value?.rejections);
  validateObjectiveProgress(value?.progress);
  validateBuilderTodoGuard(value?.builderTodoGuard);
  if (value?.failureKind !== undefined && value.failureKind !== null && !['provider_transport', 'provider_usage_limit', 'provider_authentication', 'provider_prompt_rejected', 'model_unavailable', 'deadline_exceeded'].includes(value.failureKind)) throw recoveryError('invalid_recovery_failure_kind');
  if (!value || value.version !== 1 || typeof value !== 'object') throw recoveryError('invalid_recovery_record');
  for (const key of ['sessionID', 'anchorID', 'directory', 'providerID', 'modelID', 'agent', 'state']) {
    if (typeof value[key] !== 'string' || !value[key] || (key !== 'directory' && value[key].length > 256)) throw recoveryError('invalid_recovery_record');
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 1
    || (value.todoContinuationCount !== undefined && (!Number.isSafeInteger(value.todoContinuationCount)
      || value.todoContinuationCount < 0 || value.todoContinuationCount > 12))
    || (value.continuationID !== undefined && !/^msg_[a-zA-Z0-9]+$/.test(value.continuationID))
    || (value.activeUserID !== undefined && !/^msg_[a-zA-Z0-9]+$/.test(value.activeUserID))
    || (value.recoverySourceUserID !== undefined && !/^msg_[a-zA-Z0-9]+$/.test(value.recoverySourceUserID))
    || (value.objectiveID !== undefined && !/^msg_[a-zA-Z0-9]+$/.test(value.objectiveID))
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
export function inspectRecoveryTurn(record, observation, { allowSettledToolFailures = false } = {}) {
  if (!observation || observation.session?.id !== record.sessionID || observation.session.parentID
    || observation.session.directory !== record.directory || observation.session.time?.archived
    || !Array.isArray(observation.messages) || observation.complete !== true
    || !['idle', 'busy', 'retry'].includes(observation.status)) throw recoveryError('invalid_recovery_observation');
  const messages = observation.messages;
  const anchorIndex = messages.findIndex((m) => m.info?.id === record.anchorID && m.info.role === 'user');
  if (anchorIndex < 0) throw recoveryError('recovery_anchor_unavailable');
  const tail = messages.slice(anchorIndex);
  const expectedUser = currentObjectiveUser(record);
  const users = tail.filter((m) => m.info.role === 'user' && !isNativeStatusRecord(m) && (!isNativeCompactionRecord(m) || m.info.id === expectedUser));
  const currentUser = users.at(-1)?.info.id;
  const originalUser = record.recoverySourceUserID ?? record.activeUserID ?? record.continuationID ?? record.anchorID;
  const recoveryAccepted = Boolean(record.recoveryID && currentUser === expectedUser);
  const superseded = currentUser !== expectedUser && !(record.recoveryID && currentUser === originalUser);
  const assistants = tail.filter((m) => m.info.role === 'assistant' && m.info.parentID === expectedUser);
  const last = assistants.at(-1);
  const failed = record.failedID ? tail.find((m) => m.info.id === record.failedID
    && m.info.role === 'assistant' && m.info.parentID === originalUser) : last;
  // Terminal errors on tools may hide an applied side effect: automatic recovery
  // must not decide its outcome from an error label.
  const unresolved = tail.some(message => (message.parts ?? []).some(p => p.type === 'tool'
    && p.state?.status !== 'completed'
    && !(allowSettledToolFailures && p.state?.status === 'error'
      && observation.executionOutcomes?.some(receipt => receipt.sessionID === record.sessionID
        && receipt.messageID === message.info.id && receipt.callID === p.callID
        && ['never_started', 'finished'].includes(receipt.outcome)))));
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
