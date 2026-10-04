import { isNativeStatusRecord } from '../../shared-runtime/lib/native-message-status.js';
import { applyObjectiveRejection, applyObjectiveProgress, projectObjectiveProgress } from './objective-progress.js';
import { planBuilderTodoContinuation } from './builder-todo-continuation.js';
import { isCollectionTransportFailure, matchesRecoveredCollection, collectionIssueCodes } from './managed-collection-continuation.js';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createRecordStore } from './record-store.js';
import { withCrossProcessFileLock } from './atomic-file.js';
import { currentObjectiveUser, isManagedMaintenancePrompt, observesNativeContinuation } from './objective-identity.js';
import {
  classifyPrimaryTransportError, inspectRecoveryTurn, recoveryError,
  RECOVERY_READ_TOOLS, PROVIDER_PROGRESS_TIMEOUT_MS, validatePrimaryRecoveryRecord,
  isProviderRecoverySupportedRuntimeVersion, isPrimaryRecoveryProvider, primaryRecoveryMode,
} from './provider-recovery-policy.js';

const TERMINAL = new Set(['completed', 'needs_attention', 'cancelled', 'superseded']);
const COLLECTION_EVIDENCE_ISSUE_AFTER = 5;
const ACTIVE_RECOVERY = new Set(['stopping', 'reconciling', 'recovery_reserved', 'recovering']);
const keyFor = (sessionID) => crypto.createHash('sha256').update(sessionID).digest('hex');
const messageID = (now) => `msg_${(BigInt(now) * 4096n).toString(16).slice(-12).padStart(12, '0')}${crypto.randomBytes(7).toString('hex')}`;
const nativeWitnessMatches = (witness, attempt, permitSha256) => witness?.attempt?.traceID === attempt?.traceID
  && witness?.attempt?.spanID === attempt?.spanID && witness?.permitSha256 === permitSha256;
const validNativeWitness = (attempt, permitSha256) => attempt && Object.keys(attempt).length === 2
  && ['traceID','spanID'].every(key => typeof attempt[key] === 'string' && /^[a-f0-9]{1,128}$/.test(attempt[key]))
  && typeof permitSha256 === 'string' && /^[a-f0-9]{64}$/.test(permitSha256);
const progressSignature = (part) => ['text', 'reasoning'].includes(part.type) ? part.text
  : part.type === 'tool' ? JSON.stringify([part.state?.status, part.state?.input, part.state?.raw]) : null;

export function createPrimaryRecoveryController(options) {
  const now = options.now ?? Date.now;
  const store = options.store ?? createRecordStore({ directory: options.directory, validateRecord: validatePrimaryRecoveryRecord, maxReadBytes: 128 * 1024 });
  if ([options.mode, options.anthropicMode].some((value) => value !== undefined && !['off', 'observe', 'enforce'].includes(value))) throw new TypeError('Invalid provider recovery mode');
  const progressTimeoutMs = options.progressTimeoutMs ?? PROVIDER_PROGRESS_TIMEOUT_MS;
  if (progressTimeoutMs !== false && (!Number.isSafeInteger(progressTimeoutMs) || progressTimeoutMs < 1)) {
    throw new TypeError('Invalid provider progress timeout');
  }
  const records = new Map();
  const live = new Map();
  const pending = new Map();
  const reschedule = new Map();
  const generations = new Map();
  // Consecutive unreadable-evidence collection attempts per session and task.
  const evidenceFailures = new Map();
  let handshake = null;
  let draining = false;
  let timer;
  let ownsRuntime = false;
  let releaseOwner;
  let ownerTask;
  let ready;
  let storageHealthy = true;
  // Kill switch, read per use: DEVRYAN_RECOVERY_ADVISORY_PLUGIN=0 restores the
  // one-second poll of every record and the unconditional storage latch.
  const advisory = () => (options.advisory ?? process.env.DEVRYAN_RECOVERY_ADVISORY_PLUGIN !== '0');
  const modeFor = (record) => primaryRecoveryMode(record?.providerID, options);
  const providerSupported = (record) => !record || (isPrimaryRecoveryProvider(record.providerID)
    && (record.providerID !== 'anthropic' || options.isAnthropicConformant?.(record, handshake?.version ?? undefined) === true));
  const supported = (record) => providerSupported(record) && storageHealthy && ownsRuntime && isProviderRecoverySupportedRuntimeVersion(handshake?.version) && options.isManaged()
    && (!record || (record.requestedAt !== null && record.instanceID === handshake.instanceID));
  const active = (record) => !draining && modeFor(record) === 'enforce' && supported() && providerSupported(record);
  const diagnostic = (event, record, detail = {}) => options.recordIncident?.({
    event, sessionID: record?.sessionID, messageID: record?.anchorID,
    assistantMessageID: record?.failedID ?? record?.stepID ?? null, recoveryMessageID: record?.recoveryID ?? null,
    providerID: record?.providerID ?? null, modelID: record?.modelID ?? null,
    runtimeInstanceID: handshake?.instanceID ?? null, runtimeVersion: handshake?.version ?? null,
    mode: modeFor(record), progressTimeoutMs, wireTiming: 'unavailable', providerRequestID: 'unavailable', ...detail,
    hostNodeVersion: process.version, hostBuild: options.buildVersion ?? process.env.npm_package_version ?? 'unavailable',
  });
  const project = (record) => ({
    schemaVersion: 1, mode: modeFor(record), supported: supported(record),
    enforced: active(record) && supported(record), progressTimeoutMs,
    record: record ? {
      sessionID: record.sessionID, anchorID: record.anchorID, failedID: record.failedID,
      recoveryID: record.recoveryID, state: record.state, revision: record.revision,
      attemptCount: record.attemptCount, maxAttempts: 1, readOnly: Boolean(record.recoveryID),
      providerID: record.providerID, modelID: record.modelID, agent: record.agent, variant: record.variant,
      reason: record.reason, updatedAt: record.updatedAt,
      progress: projectObjectiveProgress(record.progress),
      failureKind: record.failureKind ?? null,
      failureObserved: Boolean(record.failureObserved && ['observing', 'needs_attention'].includes(record.state)),
      collectionIssue: record.collectionIssue ?? null,
    } : null,
  });
  const publish = (record) => options.publishEvent?.({
    type: 'openchamber:primary-recovery', properties: { sessionID: record.sessionID, recovery: project(record) },
  }, { directory: record.directory });
  const lock = (id, fn) => (options.withLock
    ? options.withLock(id, fn)
    : withCrossProcessFileLock(path.join(store.directory, `${keyFor(id)}.lock`), fn));
  const mutate = (id, fn, authorizeWrite) => lock(id, async () => {
    const existing = await store.readRecord(keyFor(id));
    const next = await fn(existing);
    if (!next || next === existing) return existing;
    const value = { ...next, revision: (existing?.revision ?? 0) + 1, updatedAt: now() };
    await authorizeWrite?.();
    try { await store.writeRecord(keyFor(id), value); }
    catch (error) { storageHealthy = false; throw error; }
    records.set(id, value);
    publish(value);
    if (existing?.anchorID !== value.anchorID || existing?.state !== value.state) {
      diagnostic('objective_state', value, { state: value.state, createdAt: value.createdAt, updatedAt: value.updatedAt,
        generation: value.cancellationGeneration, attempt: value.attemptCount, reason: value.reason, failureKind: value.failureKind ?? null });
    }
    return value;
  });
  const remember = (record) => {
    if (!live.has(record.sessionID)) live.set(record.sessionID, {
      at: now(), phase: 'preparing', signatures: new Map(), textHashes: new Map(), calls: new Set(), blockers: new Set(),
    });
    return live.get(record.sessionID);
  };
  const prune = async () => {
    if (!ownsRuntime) return false;
    const entries = await store.listRecords();
    let bytes = entries.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e.record)), 0);
    let count = entries.length;
    for (const { key, record } of entries.sort((a, b) => a.record.updatedAt - b.record.updatedAt)) {
      if (!TERMINAL.has(record.state) || (record.guardedIDs.length && record.state !== 'completed')) continue;
      if (count < 1000 && bytes < 10 * 1024 * 1024 && now() - record.updatedAt < 7 * 86400_000) continue;
      const removed = await lock(record.sessionID, async () => {
        const current = await store.readRecord(key);
        if (!current || current.revision !== record.revision || pending.has(record.sessionID)) return false;
        await store.deleteRecord(key);
        records.delete(record.sessionID); live.delete(record.sessionID); generations.delete(record.sessionID);
        return true;
      });
      if (removed) { bytes -= Buffer.byteLength(JSON.stringify(record)); count--; }
    }
    return count < 1000 && bytes < 10 * 1024 * 1024;
  };
  const invalidate = (id) => generations.set(id, (generations.get(id) ?? 0) + 1);
  const attention = (id, reason, expected) => mutate(id, (r) => r && !['cancelled', 'superseded'].includes(r.state)
    && (!expected || (r.anchorID === expected.anchorID && r.cancellationGeneration === expected.cancellationGeneration))
    ? { ...r, state: 'needs_attention', reason } : r);

  async function admit(input, authorizeWrite) {
    await ready;
    const body = input.body ?? {};
    if (!input.primary || !options.isManaged()) return;
    if (isManagedMaintenancePrompt(body)) return;
    // All managed primary objectives share continuation admission. Provider
    // transport recovery remains separately gated by providerSupported/mode.
    if (!storageHealthy || !ownsRuntime) throw recoveryError('recovery_storage_unavailable', 503);
    if (!body.messageID || !body.model?.providerID || !body.model?.modelID || !body.agent) {
      if (records.has(input.sessionID) && active(records.get(input.sessionID))) throw recoveryError('recovery_execution_selection_required', 400);
      return;
    }
    // The host adapter verifies session/directory/ownership before admission.
    if (![body.messageID, body.model.providerID, body.model.modelID, body.agent].every((value) => typeof value === 'string' && value.length > 0 && value.length <= 256)
      || !/^msg_[a-zA-Z0-9]+$/.test(body.messageID)
      || (body.variant !== undefined && (typeof body.variant !== 'string' || body.variant.length > 256))
      || (input.executionGeneration !== undefined && (input.executionGeneration !== 2
        || typeof body.variant !== 'string' || body.variant.length === 0))
      || (body.tools !== undefined && (!body.tools || typeof body.tools !== 'object' || Array.isArray(body.tools)
        || Object.values(body.tools).some((value) => typeof value !== 'boolean')))) throw recoveryError('invalid_recovery_admission', 400);
    if (!records.has(input.sessionID) && !(await prune())) throw recoveryError('recovery_storage_full', 507);
    if (records.get(input.sessionID)?.anchorID === body.messageID) throw recoveryError('prompt_already_admitted');
    return mutate(input.sessionID, async (r) => {
      if (r?.anchorID === body.messageID || r?.guardedIDs.includes(body.messageID)) throw recoveryError('prompt_already_admitted');
      if (r && ['recovery_reserved', 'recovering', 'stopping'].includes(r.state)) throw recoveryError('recovery_in_progress');
      if ((r?.guardedIDs.length ?? 0) >= 128 || Buffer.byteLength(JSON.stringify(body.tools ?? {})) > 16_384) throw recoveryError('recovery_storage_full', 507);
      await authorizeWrite?.();
      invalidate(input.sessionID);
      live.delete(input.sessionID);
      // An explicit continuation is DevRyan-authored text: the objective it
      // continues stays the one compaction re-anchors.
      const objectiveID = typeof input.objectiveID === 'string' && /^msg_[a-zA-Z0-9]+$/.test(input.objectiveID)
        && input.objectiveID !== body.messageID ? input.objectiveID : undefined;
      return {
        version: 1, sessionID: input.sessionID, directory: input.directory, anchorID: body.messageID, ...(objectiveID ? { objectiveID } : {}),
        providerID: body.model.providerID, modelID: body.model.modelID, agent: body.agent,
        variant: body.variant ?? null, tools: body.tools ?? {}, owner: input.owner ?? null,
        ...(input.executionGeneration === 2 ? { executionGeneration: 2 } : {}),
        state: 'observing', reason: null, attemptCount: 0, failedID: null, recoveryID: null,
        stepID: null, requestedAt: null, instanceID: null,
        guardedIDs: r?.guardedIDs ?? [], ...(r?.recoveredInputDispositions?{recoveredInputDispositions:r.recoveredInputDispositions.filter(item=>item.phase==='cancelled'&&r.guardedIDs.includes(item.inputID))}:{}), createdAt: now(), cancellationGeneration: (r?.cancellationGeneration ?? 0) + 1,
      };
    }, authorizeWrite);
  }

  async function control(id, action, expectedRevision) {
    if (expectedRevision !== undefined && records.get(id)?.revision !== expectedRevision) throw recoveryError('recovery_revision_conflict');
    invalidate(id); // Immediately fence outstanding awaits in this owner.
    const r = await mutate(id, (record) => {
      if (!record) return null;
      if (expectedRevision !== undefined && record.revision !== expectedRevision) throw recoveryError('recovery_revision_conflict');
      return { ...record, state: action === 'intent' ? 'observing' : action === 'supersede' ? 'superseded' : 'cancelled', reason: action,
        recoverySuppressed: action === 'intent' || record.recoverySuppressed === true,
        cancellationGeneration: (record.cancellationGeneration ?? 0) + 1 };
    });
    diagnostic('provider_recovery_control', r, { action });
    return project(r);
  }

  const blocked = (record, state) => {
    const l = live.get(record.sessionID);
    const executing = state.messages?.some((message) => message.info?.id === record.stepID
      && message.parts?.some((part) => part.type === 'tool' && part.state?.status === 'running'));
    return state.blocked || executing || l?.calls.size || l?.blockers.size || l?.phase === 'retry';
  };
  const observeBounded = async (record, deadline = now() + 5000, includeTodos = false, includeExecutionOutcomes = false) => {
    const abort = new AbortController();
    let timeout;
    try {
      return await Promise.race([
        options.observeTurn(record, { signal: abort.signal, ...(includeTodos ? { includeTodos: true } : {}),
          ...(includeExecutionOutcomes ? { includeExecutionOutcomes: true } : {}) }),
        new Promise((_, reject) => {
          timeout = setTimeout(() => { abort.abort(); reject(recoveryError('recovery_observation_timeout')); },
            Math.max(1, Math.min(5000, deadline - now())));
        }),
      ]);
    } finally { clearTimeout(timeout); abort.abort(); }
  };
  const authorizeBounded = async (record) => {
    let timeout;
    try {
      return await Promise.race([options.authorize(record), new Promise((_, reject) => {
        timeout = setTimeout(() => reject(recoveryError('recovery_authorization_unavailable')), 5000);
      })]);
    } finally { clearTimeout(timeout); }
  };
  const verifyCollectionBounded = async (record, collection) => {
    let timer;
    try {
      return await Promise.race([options.verifyRecoveredCollection?.(record, collection), new Promise((_, reject) => {
        timer = setTimeout(() => reject(recoveryError('managed_collection_unverified')), 5000);
      })]);
    } finally { clearTimeout(timer); }
  };
  const verifyOwnedNativeContinuation = async (record, observation, targetUserID) => {
    // The trusted host proves the actual ledger/termination chain. Metadata
    // alone never supplies that authority, and partial history cannot do so.
    inspectRecoveryTurn(record, observation);
    if (observation.messages.filter(message => message.info?.role === 'user' && !isNativeStatusRecord(message)).at(-1)?.info.id !== targetUserID) return null;
    const source = currentObjectiveUser(record) === targetUserID && record.ownedNativeContinuation?.userMessageID === targetUserID
      ? { ...record, activeUserID: record.ownedNativeContinuation.sourceUserMessageID } : record;
    if (observesNativeContinuation(source, observation, targetUserID)) return { kind: 'native-compaction' };
    if (typeof options.verifyOwnedNativeContinuation !== 'function') return null;
    let timer;
    try {
      const proof = await Promise.race([
        options.verifyOwnedNativeContinuation(structuredClone(source), structuredClone(observation), targetUserID),
        new Promise((_, reject) => { timer = setTimeout(() => reject(recoveryError('native_continuation_verification_unavailable')), 5000); }),
      ]);
      return proof?.kind === 'native-shell' ? { kind: 'native-shell' } : null;
    } catch { throw recoveryError('native_continuation_verification_unavailable'); }
    finally { clearTimeout(timer); }
  };

  // This direct host method is deliberately absent from the plugin action
  // protocol. It runs at the real next native Step.Started, never on receipt
  // arrival while the previous assistant still owns its execution deadline.
  const adoptOwnedNativeContinuation = async (input) => {
    await ready;
    if (!storageHealthy || !ownsRuntime || !options.isManaged()) throw recoveryError('recovery_owner_unavailable', 503);
    if (!/^msg_[a-zA-Z0-9]+$/.test(input?.userMessageID ?? '') || !/^msg_[a-zA-Z0-9]+$/.test(input?.assistantMessageID ?? '')
      || !handshake || handshake.instanceID !== input.instanceID) throw recoveryError('native_continuation_fenced');
    const generation = generations.get(input.sessionID) ?? 0;
    const current = () => !draining && handshake?.instanceID === input.instanceID && (generations.get(input.sessionID) ?? 0) === generation;
    const result = await mutate(input.sessionID, async (next) => {
      const execution=next?.recoveryID&&next.recoveryExecution?next.recoveryExecution:next;
      if (!next || !current() || next.nativeFallback?.pending || !['observing', 'completed', 'recovering'].includes(next.state)
        || execution.providerID !== input.execution?.providerID || execution.modelID !== input.execution?.modelID
        || execution.agent !== input.execution?.agent || execution.variant !== (input.execution?.variant ?? null)) throw recoveryError('native_continuation_fenced');
      const observation = await observeBounded(next);
      const proof = await verifyOwnedNativeContinuation(next, observation, input.userMessageID);
      const assistant = observation.messages.find(message => message.info?.id === input.assistantMessageID);
      if (!proof || (next.state === 'completed' && proof.kind !== 'native-shell')
        || !assistant || assistant.info.role !== 'assistant' || assistant.info.sessionID !== next.sessionID
        || assistant.info.parentID !== input.userMessageID || assistant.turnOwnership?.source !== 'native-sequence'
        || assistant.turnOwnership.userMessageID !== input.userMessageID || assistant.info.agent !== execution.agent
        || assistant.info.providerID !== execution.providerID || assistant.info.modelID !== execution.modelID
        || (assistant.info.variant ?? null) !== execution.variant || !await authorizeBounded(next) || !current()) throw recoveryError('native_continuation_fenced');
      if (currentObjectiveUser(next) === input.userMessageID) {
        const receipt = next.ownedNativeContinuation;
        if (receipt?.kind !== proof.kind || receipt.userMessageID !== input.userMessageID
          || receipt.assistantMessageID !== input.assistantMessageID) throw recoveryError('native_continuation_fenced');
        return next;
      }
      if (assistant.info.time?.completed || next.guardedIDs.length >= 128) throw recoveryError('native_continuation_fenced');
      if (proof.kind === 'native-shell') {
        const previous = observation.messages.find(message => message.info?.id === next.stepID);
        if (!previous || previous.info.role !== 'assistant' || previous.info.parentID !== currentObjectiveUser(next)
          || !previous.info.time?.completed || observation.messages.indexOf(previous) >= observation.messages.indexOf(assistant)) throw recoveryError('native_continuation_fenced');
      }
      invalidate(next.sessionID);
      live.delete(next.sessionID);
      return { ...next, activeUserID: input.userMessageID, stepID: null, requestedAt: null,
        state: next.recoveryID ? 'recovering' : 'observing',
        ownedNativeContinuation: { kind: proof.kind, sourceUserMessageID: currentObjectiveUser(next), userMessageID: input.userMessageID, assistantMessageID: input.assistantMessageID },
        guardedIDs: next.recoveryID || next.guardedIDs.length ? [...new Set([...next.guardedIDs, input.userMessageID])] : next.guardedIDs };
    });
    diagnostic('objective_owned_native_continued', result, { activeUserMessageID: result.activeUserID });
    return result;
  };

  // Private native hook transition, never a plugin/RPC action. The failed
  // provider step must settle before the ordinary one-attempt owner dispatches.
  const nativeFallbackEligible = r => r?.executionGeneration === 2 && ownsRuntime && storageHealthy && !draining
    && options.isManaged() && handshake?.version === '2.0.20' && r.instanceID === handshake.instanceID;
  const nativeChoiceBound = r => nativeFallbackEligible(r) && !r.nativeFallback?.pending
    && typeof r.nativeFallback?.stepID === 'string' && r.nativeFallback.stepID === r.stepID
    && r.nativeFallback.userMessageID === currentObjectiveUser(r);
  async function reserveNativeFallback(input, owner) {
    await ready;
    const generation = generations.get(input.sessionID) ?? 0;
    const current = () => !draining && generation === (generations.get(input.sessionID) ?? 0);
    const result = await mutate(input.sessionID, async r => {
      const lazy = input.assistantMessageID === null;
      const exact = () => r && current() && ownsRuntime && storageHealthy && options.isManaged()
        && r.executionGeneration === 2 && handshake?.version === '2.0.20' && input.instanceID === handshake.instanceID
        && (lazy || nativeFallbackEligible(r))
        && r.state === 'observing' && !r.recoverySuppressed && !r.attemptCount && !r.recoveryID
        && (lazy ? r.stepID === input.previousStepID && validNativeWitness(input.attempt,input.permitSha256)
          : r.stepID === input.assistantMessageID && r.requestedAt !== null)
        && currentObjectiveUser(r) === input.userMessageID
        && ['providerID','modelID','agent','variant'].every(key => input.currentExecution?.[key] === r[key]);
      if (!exact() || typeof options.isNativeFallbackError !== 'function') throw recoveryError('native_fallback_fenced');
      await owner.authorize();
      const observation = await observeBounded(r), inspected = inspectRecoveryTurn(r, observation);
      const canonical = (state, turn) => !turn.superseded && !blocked(r,state)
        && (lazy ? (r.stepID === null ? !turn.last : turn.last?.info.id === r.stepID
          && Number.isFinite(turn.last?.info.time?.completed) && turn.last.info.time.completed > 0
          && turn.last.turnOwnership?.source === 'native-sequence' && turn.last.turnOwnership.userMessageID === input.userMessageID
          && ['providerID','modelID','agent','variant'].every(key => turn.last.info[key] === r[key])) : turn.last?.info.id === r.stepID);
      if (!exact() || !canonical(observation,inspected)
        || (!lazy && r.nativeStepWitness && !nativeWitnessMatches(r.nativeStepWitness,input.attempt,input.permitSha256))) throw recoveryError('native_fallback_fenced');
      if (r.nativeFallback?.pending) {
        if (!lazy || r.nativeFallback.pending.instanceID !== input.instanceID
          || !nativeWitnessMatches(r.nativeFallback.pending,input.attempt,input.permitSha256)) throw recoveryError('native_fallback_fenced');
        return r;
      }
      if (!lazy && r.nativeFallback?.stepID === r.stepID) return r;
      const choice = await owner.choose({tried:r.nativeFallback?.tried ?? [],exhaustion:r.nativeFallback?.exhaustion ?? 0});
      await owner.authorize();
      const latest = await observeBounded(r);
      if (!exact() || !canonical(latest,inspectRecoveryTurn(r,latest)) || !await authorizeBounded(r) || !current()) throw recoveryError('native_fallback_fenced');
      const execution = choice.execution;
      if (execution && (!['providerID','modelID','agent','variant'].every(key => typeof execution[key] === 'string' && execution[key].length > 0 && execution[key].length <= 256)
        || execution.agent !== r.agent || execution.providerID === r.providerID && execution.modelID === r.modelID)) throw recoveryError('native_fallback_selection_invalid');
      if (!Array.isArray(choice.tried) || choice.tried.length > 128 || choice.tried.some(value => typeof value !== 'string' || value.length > 512)
        || ![0,1,2].includes(choice.exhaustion)) throw recoveryError('native_fallback_selection_invalid');
      return {...r,nativeFallback:{stepID:lazy ? null : r.stepID,userMessageID:input.userMessageID,tried:choice.tried,exhaustion:choice.exhaustion,
        ...(lazy ? {pending:{instanceID:input.instanceID,cancellationGeneration:r.cancellationGeneration,previousStepID:r.stepID,
          attempt:structuredClone(input.attempt),permitSha256:input.permitSha256,currentExecution:structuredClone(input.currentExecution)}} : {}),
        ...(execution ? {execution:structuredClone(execution)} : {})},
        ...(!execution && !lazy ? {state:'needs_attention',reason:choice.exhaustion ? 'native_fallback_exhausted' : 'native_fallback_unavailable'} : {})};
    }, async()=>{await owner.authorize();if(!current() || handshake?.instanceID!==input.instanceID || handshake.version!=='2.0.20'
      || !ownsRuntime || !storageHealthy || !options.isManaged())throw recoveryError('native_fallback_fenced');});
    return {reserved:Boolean(result.nativeFallback?.execution),record:result};
  }

  async function reconcileOne(id, watchdog = false) {
    const before = records.get(id);
    if (!before || draining || TERMINAL.has(before.state)) return;
    if (before.nativeFallback?.pending) {
      if (handshake && before.nativeFallback.pending.instanceID !== handshake.instanceID) await attention(id,'native_fallback_dispatch_uncertain',before);
      return;
    }
    // chat.message handshakes before OpenCode persists the admitted user
    // message. A delayed idle event must not mistake that window for lost work.
    if (before.state === 'observing' && !before.requestedAt && !before.failureObserved && !before.recoveryID) return;
    const generation = generations.get(id) ?? 0;
    const current = () => !draining && (generations.get(id) ?? 0) === generation;
    const liveness = remember(before);
    // A queued watchdog signal may belong to a superseded invocation. Recheck
    // the current step's deadline before any observation or stop decision.
    if (watchdog && (progressTimeoutMs === false || liveness.phase !== 'provider'
      || now() - liveness.at < progressTimeoutMs)) return;
    const progressAt = liveness.at;
    let observation = await observeBounded(before);
    if (!current()) return;
    if (!before.requestedAt && !before.recoveryID
      && !observation.messages?.some((m) => m.info?.id === before.anchorID)) return;
    let inspected = inspectRecoveryTurn(before, observation);
    if (inspected.superseded) {
      const targetUserID = observation.messages.filter(message => message.info?.role === 'user' && !isNativeStatusRecord(message)).at(-1)?.info.id;
      const proof = await verifyOwnedNativeContinuation(before, observation, targetUserID);
      // Keep the original step intact until the native runner actually starts
      // its successor. Shell completion can arrive before that step settles.
      if (proof) return;
      if (current()) await control(id, 'supersede');
      return;
    }
    if (before.recoveryID && !watchdog) {
      if (inspected.settled) {
        await mutate(id, (r) => r && current() ? { ...r, state: inspected.last.info.error ? 'needs_attention' : 'completed',
          reason: inspected.last.info.error ? 'recovery_failed' : 'recovery_completed' } : r);
      } else if (inspected.last?.info.error && inspected.last.info.time?.completed) {
        await attention(id, 'recovery_failed', before);
      } else if (inspected.recoveryAccepted && before.state === 'recovery_reserved') {
        await mutate(id, (r) => current() ? { ...r, state: 'recovering' } : r);
      } else if (!inspected.recoveryAccepted) {
        const dispatch = liveness.recoveryDispatch;
        const liveDispatch = dispatch && dispatch.recoveryID === before.recoveryID
          && dispatch.instanceID === handshake?.instanceID && dispatch.instanceID === before.instanceID
          && dispatch.cancellationGeneration === before.cancellationGeneration && dispatch.owner === before.owner
          ? dispatch : undefined;
        const pendingDispatch = before.executionGeneration === 2 && options.isNativeRecoveryDispatchPending
          && await options.isNativeRecoveryDispatchPending(before, liveDispatch);
        if (!current()) return;
        if (pendingDispatch && await authorizeBounded(before) && current()) return;
        // A canonical read begun before adoption/Step cannot close its successor.
        await mutate(id, r => r && current() && r.revision === before.revision
          && !['cancelled','superseded'].includes(r.state)
          ? {...r,state:'needs_attention',reason:'recovery_dispatch_uncertain'} : r);
      }
      if (inspected.recoveryAccepted) delete liveness.recoveryDispatch;
      return;
    }
    // session.error has no reliable invocation identity. It only requests a
    // canonical read; a stale event cannot stop or recover a newer invocation.
    if (nativeChoiceBound(before) && !before.nativeFallback.execution && inspected.settled
      && inspected.last?.info.id === before.stepID && options.isNativeFallbackError?.(inspected.last.info.error) === true) {
      await attention(id,before.nativeFallback.exhaustion ? 'native_fallback_exhausted' : 'native_fallback_unavailable',before);
      return;
    }
    const nativeFallback = nativeChoiceBound(before) && before.nativeFallback.execution;
    const failure = nativeFallback && options.isNativeFallbackError(inspected.last?.info.error) === true
      ? {kind:'native_model_fallback',source:'owned_native_retry'} : classifyPrimaryTransportError(inspected.last?.info.error, handshake?.version);
    const failureKind = options.classifyFailure?.(inspected.last?.info.error) ?? null;
    if ((before.failureKind ?? null) !== failureKind) await mutate(id, (record) => current()
      && record?.anchorID === before.anchorID ? { ...record, failureKind } : record);
    if ((!failure || before.recoverySuppressed) && !watchdog) {
      if (inspected.settled && !inspected.last.info.error) await mutate(id, (r) => current() ? { ...r, state: 'completed' } : r);
      else if (active(before) && inspected.last?.info.error && inspected.last.info.time?.completed) await attention(id, 'failure_not_eligible', before);
      return;
    }
    if (watchdog) {
      if (inspected.last?.info.id !== before.stepID) return;
      // After sleep/reconnect the canonical transcript may be ahead of SSE.
      // Unseen meaningful content cancels this cutoff and establishes a baseline.
      let advanced = false;
      for (const part of inspected.last.parts) {
        if (!['text', 'reasoning'].includes(part.type) || !part.text) continue;
        const hash = crypto.createHash('sha256').update(part.text).digest('hex');
        if (liveness.signatures.get(part.id) === hash) continue;
        if (liveness.signatures.size >= 256) {
          const oldest = liveness.signatures.keys().next().value;
          liveness.signatures.delete(oldest); liveness.textHashes.delete(oldest);
        }
        liveness.signatures.set(part.id, hash); advanced = true;
        liveness.textHashes.set(part.id, crypto.createHash('sha256').update(part.text));
      }
      if (advanced) { liveness.at = now(); return; }
    }
    const candidateKey = `${watchdog}:${failure?.kind}:${before.stepID}:${liveness.at}`;
    if (liveness.candidateKey !== candidateKey) diagnostic('provider_recovery_candidate', before, { classification: failure, watchdog,
      meaningfulProgressAt: liveness.at, phase: liveness.phase, elapsedWithoutProgressMs: now() - liveness.at,
      executingTools: liveness.calls.size, pendingRequests: liveness.blockers.size, status: observation.status });
    liveness.candidateKey = candidateKey;
    if ((!nativeFallback && (!active(before) || !supported(before))) || inspected.last?.info.id !== before.stepID) return;
    if (watchdog && (liveness.at !== progressAt || blocked(before, observation) || observation.status !== 'busy')) return;
    if (watchdog && inspected.last?.parts.some((part) => part.type === 'tool' && part.state?.status === 'pending')) {
      // 1.18.25 publishes tool-input-start but drops subsequent input deltas.
      // This is provider activity with unknown progress, not executing a tool.
      liveness.phase = 'provider_input_unobservable';
      diagnostic('provider_progress_unobservable', before, { phase: liveness.phase, source: 'opencode_1.18.25_processor' });
      await mutate(id, (r) => current() ? { ...r, reason: 'provider_input_progress_unavailable' } : r);
      return;
    }
    if (!watchdog && inspected.unresolved && inspected.last?.info.time?.completed && observation.status === 'idle') {
      const record = await mutate(id, (r) => r && current() ? { ...r, state: 'needs_attention',
        reason: 'recovery_tool_outcome_unknown', failedID: inspected.last.info.id } : r);
      if (current()) diagnostic('provider_recovery_tool_outcome_unknown', record, { classification: failure });
      return;
    }
    if (!await authorizeBounded(before) || !current()) { await attention(id, 'recovery_authorization_unavailable', before); return; }
    const stopping = await mutate(id, (r) => r && current() && !(watchdog && blocked(r, observation)) ? { ...r, state: watchdog ? 'stopping' : 'reconciling',
      failedID: r.recoveryID ? r.failedID : inspected.last?.info.id ?? r.stepID,
      reason: watchdog ? 'provider_progress_timeout' : failure.kind } : r);
    if (!current() || (watchdog && stopping?.state !== 'stopping')) return;
    if (observation.status !== 'idle') {
      if (watchdog && (liveness.at !== progressAt || blocked(before, observation))) {
        await mutate(id, (r) => current() ? { ...r, state: 'observing', reason: null } : r);
        return;
      }
      diagnostic('provider_stop_requested', before, { reason: watchdog ? 'suspected_stall' : 'transient_failure' });
      await options.abortSession(before);
    }
    const deadline = now() + (options.settlementMs ?? 30_000);
    // An abort acknowledgement is not settlement. Read exact transcript + live state.
    while (current()) {
      if (now() >= deadline) { await attention(id, 'provider_stop_unconfirmed', before); return; }
      observation = await observeBounded(before, deadline);
      if (!current()) return;
      inspected = inspectRecoveryTurn(before, observation);
      if (inspected.superseded) { await control(id, 'supersede'); return; }
      if (inspected.settled && !blocked(before, observation)) break;
      if (now() >= deadline) { await attention(id, 'provider_stop_unconfirmed', before); return; }
      await (options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(250);
    }
    if (!current()) return;
    diagnostic('provider_stop_settled', before, { finalizedMessageID: inspected.last.info.id, status: observation.status,
      finalizedAt: inspected.last.info.time.completed, blockersCleared: true });
    if (watchdog) { await attention(id, 'provider_progress_timeout', before); return; }
    if (!inspected.last.info.error) { await mutate(id, (r) => current() ? { ...r, state: 'completed' } : r); return; }
    if (!inspected.recoveryParts.length) { await attention(id, 'recovery_input_unavailable', before); return; }
    // Reserve under the same lock as ordinary admission. Release it before POST:
    // plugin hooks called during POST must be able to inspect the reservation.
    const reserved = await lock(id, async () => {
      let r = await store.readRecord(keyFor(id));
      if (!r || !current() || r.attemptCount || r.recoverySuppressed || TERMINAL.has(r.state) || (!nativeFallback && !active(r)) || (nativeFallback && !nativeFallbackEligible(r))) return;
      const final = await observeBounded(r);
      const check = inspectRecoveryTurn(r, final);
      if (!current() || !check.settled || check.superseded || blocked(r, final) || !await authorizeBounded(r)
        || !(nativeFallback ? r.nativeFallback?.stepID === check.last?.info.id && options.isNativeFallbackError(check.last?.info.error) === true
          : classifyPrimaryTransportError(check.last?.info.error, handshake?.version))) return;
      const recoveryID = (options.createMessageID ?? (() => messageID(now())))();
      const toolPolicy = options.getToolPolicy ? await options.getToolPolicy(r)
        : { toolIDs: RECOVERY_READ_TOOLS, allowedReadTools: RECOVERY_READ_TOOLS };
      if (!current()) return;
      const execution = nativeFallback ? r.nativeFallback.execution : r;
      const prompt = {messageID:recoveryID,model:{providerID:execution.providerID,modelID:execution.modelID},agent:execution.agent,
        ...(execution.variant ? {variant:execution.variant} : {}),parts:check.recoveryParts,
        tools:{...r.tools,...Object.fromEntries(toolPolicy.toolIDs.map(tool=>[tool,false])),'*':false,
          ...Object.fromEntries(toolPolicy.allowedReadTools.map(tool=>[tool,r.tools['*']!==false&&r.tools[tool]!==false]))}};
      r = { ...r, revision: r.revision + 1, state: 'recovery_reserved', attemptCount: 1,
        activeUserID: undefined, recoverySourceUserID: currentObjectiveUser(r),
        recoveryID, ...(nativeFallback ? {recoveryExecution:r.nativeFallback.execution,recoveryPrompt:prompt} : {}), allowedReadTools: toolPolicy.allowedReadTools, guardedIDs: [...r.guardedIDs, recoveryID], updatedAt: now() };
      await store.writeRecord(keyFor(id), r);
      records.set(id, r); publish(r);
      diagnostic('provider_recovery_reserved', r);
      return {record:r,prompt};
    });
    if (!reserved || !current()) return;
    const r = reserved.record;
    liveness.recoveryDispatch = {recoveryID:r.recoveryID,instanceID:r.instanceID,
      cancellationGeneration:r.cancellationGeneration,owner:r.owner};
    try {
        await options.promptSession(r,reserved.prompt);
        await mutate(id, (next) => current() && next.state === 'recovery_reserved' ? { ...next, state: 'recovering' } : next);
        diagnostic('provider_recovery_dispatch_acknowledged', r);
    } catch {
        delete liveness.recoveryDispatch;
        diagnostic('provider_recovery_dispatch_uncertain', r);
        if (current()) await attention(id, 'recovery_dispatch_uncertain', before);
    }
  }

  function schedule(id, watchdog = false, sweep = null) {
    if (pending.has(id)) {
      // A terminal message may arrive while an earlier idle read is in flight.
      // Coalesce bursts, but always perform a fresh read for the newer signal.
      reschedule.set(id, watchdog || reschedule.get(id) === true);
      return pending.get(id);
    }
    const operation = (async () => {
      let checkWatchdog = watchdog;
      do {
        reschedule.delete(id);
        const expected = records.get(id);
        try { await reconcileOne(id, checkWatchdog); }
        catch (error) {
          if (sweep) sweep.failed += 1;
          else diagnostic('provider_recovery_observation_failed', expected, {
            reason: typeof error?.code === 'string' && /^[a-z_]{1,80}$/.test(error.code) ? error.code : 'observation_failed',
          });
          const latest = records.get(id);
          if (active(latest)) await attention(id, 'recovery_observation_unavailable', expected);
          else if (sweep && error?.sessionMissing === true && latest && !TERMINAL.has(latest.state)
            && latest.updatedAt < sweep.startedAt && latest.instanceID !== handshake?.instanceID) {
            // Only a session the replaced runtime no longer has is retired, so
            // it is not re-swept on every start. A transient failure (a busy
            // runtime at startup) never retires an objective.
            const retired = await mutate(id, (next) => next && !TERMINAL.has(next.state) && next.updatedAt < sweep.startedAt
              && next.instanceID !== handshake?.instanceID
              ? { ...next, revision: next.revision + 1, state: 'superseded', reason: 'recovery_runtime_replaced', updatedAt: now() } : next);
            if (retired?.reason === 'recovery_runtime_replaced') sweep.retired += 1;
          }
        }
        checkWatchdog = reschedule.get(id) === true;
      } while (!draining && reschedule.has(id));
    })().catch(() => {
      // A failed store write already marked the storage unhealthy (mutate).
      // Any other failure here, such as an observation that timed out while
      // recording attention, must not disable recovery until the next restart.
      if (!advisory()) storageHealthy = false;
      diagnostic('provider_recovery_persistence_failed', records.get(id));
    }).finally(() => { pending.delete(id); reschedule.delete(id); });
    pending.set(id, operation);
    return operation;
  }

  async function plugin(input, authorizeRejectionWrite, nativePrompt, nativeHelloOwner) {
    await ready;
    if (!storageHealthy) throw recoveryError('recovery_storage_unavailable', 503);
    if (!ownsRuntime) throw recoveryError('recovery_owner_unavailable', 503);
    if (!options.isManaged()) throw recoveryError('provider_recovery_external', 503);
    if (input.action === 'hello') {
      if (typeof input.instanceID !== 'string' || !input.instanceID || input.policyVersion !== 1) throw recoveryError('recovery_plugin_incompatible');
      if (nativeHelloOwner) {
        if(typeof nativeHelloOwner.authorize!=='function' || typeof nativeHelloOwner.isCurrent!=='function')throw recoveryError('recovery_owner_mismatch');
        await nativeHelloOwner.authorize();
        if(draining || !storageHealthy || !ownsRuntime || !options.isManaged() || nativeHelloOwner.isCurrent()!==true)throw recoveryError('recovery_owner_mismatch');
      }
      const replaced = !handshake || handshake.instanceID !== input.instanceID;
      if (handshake && replaced) live.clear();
      handshake = { instanceID: input.instanceID, version: input.transport === 'websocket-unverified' ? null : input.version };
      diagnostic('provider_recovery_capability', null, { supported: supported(), transport: input.transport ?? 'unverified' });
      // Reconcile stored objectives once per runtime instance, not on every
      // plugin hello, and summarize the sweep in one diagnostic.
      if (replaced) {
        const sweep = { startedAt: now(), failed: 0, retired: 0 };
        // A just-started runtime answers a bounded number of sweep reads at once.
        const queue = [...records.values()].filter((record) => !TERMINAL.has(record.state)).map((record) => record.sessionID);
        const worker = async () => { for (let id = queue.shift(); id; id = queue.shift()) await schedule(id, false, sweep); };
        const work = Array.from({ length: Math.min(8, queue.length) }, worker);
        void Promise.allSettled(work).then(() => {
          if (sweep.failed || sweep.retired) diagnostic('provider_recovery_sweep_summary', null, { failed: sweep.failed, retired: sweep.retired });
        });
      }
      return { ...project(null), instanceID: handshake.instanceID };
    }
    if (!handshake || handshake.instanceID !== input.instanceID) throw recoveryError('recovery_owner_mismatch');
    let r = records.get(input.sessionID);
    if (!r) {
      if (input.action === 'continuation') {
        diagnostic('managed_objective_unavailable', null, { sessionID: input.sessionID, reason: 'new_user_input_required' });
        throw Object.assign(recoveryError('managed_objective_unavailable'), {
          message: 'Automatic continuation has no durable objective owner for this session. Send a new user instruction to continue; older history cannot restore its continuation budgets.',
        });
      }
      return { allowed: true, readOnly: false };
    }
    if (['message', 'step'].includes(input.action) && input.userMessageID !== currentObjectiveUser(r)) {
      r = await mutate(r.sessionID, async (next) => {
        if (!next || next.nativeFallback?.pending) throw recoveryError('provider_recovery_fenced');
        const observation = await observeBounded(next);
        if (!observesNativeContinuation(next, observation, input.userMessageID)
          || ['cancelled', 'superseded', 'needs_attention', 'stopping'].includes(next.state)
          || next.guardedIDs.length >= 128 || !await authorizeBounded(next)) throw recoveryError('provider_recovery_fenced');
        invalidate(next.sessionID);
        return { ...next, activeUserID: input.userMessageID, stepID: null, requestedAt: null,
          state: next.recoveryID ? 'recovering' : 'observing',
          guardedIDs: next.recoveryID ? [...new Set([...next.guardedIDs, input.userMessageID])] : next.guardedIDs };
      });
      diagnostic('objective_native_compaction_continued', r, { activeUserMessageID: r.activeUserID });
    }
    const enforcing = active(r);
    if (input.action === 'scope') return { tracked: true,
      enforced: enforcing, readOnly: Boolean(r.guardedIDs.length), agent: r.agent };
    const isGuarded = r.guardedIDs.includes(input.userMessageID);
    const currentUser = currentObjectiveUser(r);
    const l = remember(r);
    if (input.action === 'tool_after') {
      l.calls.delete(input.callID); l.at = now(); l.phase = 'preparing'; return { allowed: true };
    }
    if (input.action === 'rejected') {
      if (input.userMessageID !== currentUser || TERMINAL.has(r.state) || input.assistantMessageID !== r.stepID) throw recoveryError('provider_recovery_fenced');
      let result;
      const updated = await mutate(r.sessionID, (next) => {
        if (!next || next.anchorID !== r.anchorID || TERMINAL.has(next.state)
          || input.userMessageID !== currentObjectiveUser(next) || input.assistantMessageID !== next.stepID) throw recoveryError('provider_recovery_fenced');
        result = applyObjectiveRejection(next.rejections, { fingerprint: input.fingerprint, reason: input.reason, callID: input.callID, at: now() });
        if (result.receipts === next.rejections) return next;
        return { ...next, rejections: result.receipts,
          ...(result.state === 'blocked' ? { state: 'needs_attention', reason: 'managed_repeated_preexecution_rejection' } : {}) };
      }, authorizeRejectionWrite);
      // A rejection never ran its tool and cannot keep a phantom running call.
      l.calls.delete(input.callID);
      diagnostic('objective_preexecution_rejection', updated, { reason: input.reason, fingerprint: input.fingerprint,
        toolCallID: input.callID, rejectionState: result.state, rejectionCount: result.count });
      return { allowed: false, state: result.state, count: result.count };
    }
    if (input.action === 'continuation') {
      try {
        const collectionAttention = record => input.kind === 'collect' && input.collection?.taskId
          && record.state === 'needs_attention' && record.reason === 'failure_not_eligible';
        const generation = generations.get(r.sessionID) ?? 0;
        // Journal-only sub-reason: which fence condition held the continuation.
        const fenced = (reason) => Object.assign(recoveryError('managed_continuation_fenced'), { fenceReason: reason });
        const stateFence = (record, proof = true) => (!['observing', 'completed'].includes(record.state) && !(proof && collectionAttention(record))
          ? `state_${/^[a-z_]{1,48}$/.test(record.state ?? '') ? record.state : 'invalid'}` : null);
        const nativeSupported = nativePrompt && r.executionGeneration === 2 && handshake.version === '2.0.20';
        const preFence = !nativeSupported && !isProviderRecoverySupportedRuntimeVersion(handshake.version) ? 'runtime_unsupported'
          : draining ? 'draining'
            : !/^msg_[a-zA-Z0-9]+$/.test(input.userMessageID ?? '') ? 'invalid_continuation_id'
              : r.attemptCount ? 'recovery_attempted'
                : r.recoverySuppressed ? 'recovery_suppressed' : stateFence(r);
        if (preFence) throw fenced(preFence);
        let deliveredMessageID = null;
        const admitted = await mutate(r.sessionID, async (next) => {
          if (!next || next.anchorID !== input.anchorUserMessageID || next.directory !== input.directory
            || next.providerID !== input.execution?.providerID || next.modelID !== input.execution?.modelID
            || next.agent !== input.execution?.agent || next.variant !== (input.execution?.variant ?? null)
            || !['collect', 'orchestrator_todo', 'builder_todo'].includes(input.kind)
            || (input.kind === 'builder_todo' && !['build', 'builder'].includes(next.agent))
            || (input.kind === 'orchestrator_todo' && next.agent !== 'orchestrator')) throw recoveryError('managed_objective_mismatch');
          const observed = await observeBounded(next, undefined, input.kind === 'builder_todo', input.kind === 'collect');
          if (input.kind === 'collect' && input.collection?.taskId && next.collectionWake?.taskId === input.collection.taskId) {
            const delivered = observed.messages?.some(message => message.info?.role === 'user' && !isNativeStatusRecord(message)
              && message.info.id === next.collectionWake.messageID
              && message.parts?.some(part => part.type === 'text' && part.synthetic === true));
            if (delivered && next.collectionWake.generation === next.cancellationGeneration) {
              deliveredMessageID = next.collectionWake.messageID;
              return next.collectionIssue ? { ...next, collectionIssue: null } : next;
            }
            // A prior reservation may have reached OpenCode even if the caller
            // missed its HTTP acknowledgement. Never manufacture a second ID.
            throw recoveryError('managed_collection_delivery_unconfirmed');
          }
          const check = inspectRecoveryTurn(next, observed, { allowSettledToolFailures: input.kind === 'collect' });
          // Unreadable (not missing) outcome evidence is transient: retry the
          // collection later instead of recording a permanent fence. A busy or
          // superseded turn is still fenced by the checks below.
          if (input.kind === 'collect' && check.unresolved && observed.executionOutcomesUnavailable === true
            && observed.status === 'idle' && !check.superseded) {
            throw recoveryError('managed_collection_evidence_unavailable');
          }
          let collectionProof = null;
          if (check.last?.info.error && input.kind === 'collect'
            && isCollectionTransportFailure(check.last.info.error, handshake.version)
            && input.collection?.taskId && typeof input.collection.claimantId === 'string') {
            collectionProof = await verifyCollectionBounded(next, input.collection);
            if (!matchesRecoveredCollection(next, check, observed, collectionProof, input.collection)) {
              throw recoveryError('managed_collection_unverified');
            }
          }
          const turnFence = observed.status !== 'idle' ? 'session_not_idle'
            : check.superseded ? 'superseded'
              : check.unresolved ? 'unresolved_turn'
                : !check.last?.info.time?.completed ? 'turn_incomplete'
                  : check.last.info.error && !collectionProof ? 'turn_error'
                    : next.attemptCount ? 'recovery_attempted'
                      : next.recoverySuppressed ? 'recovery_suppressed' : stateFence(next, Boolean(collectionProof));
          if (turnFence) throw fenced(turnFence);
          if (nativePrompt && (next.stepID !== input.assistantMessageID || check.last?.info.id !== input.assistantMessageID
            || check.last.info.sessionID !== next.sessionID || check.last.turnOwnership?.source !== 'native-sequence'
            || check.last.turnOwnership.userMessageID !== currentObjectiveUser(next)
            || check.last.info.parentID !== currentObjectiveUser(next) || check.last.info.agent !== next.agent
            || check.last.info.providerID !== next.providerID || check.last.info.modelID !== next.modelID
            || (check.last.info.variant ?? null) !== next.variant)) throw fenced('native_source_changed');
          if (!await authorizeBounded(next)) throw fenced('unauthorized');
          // Collection may run with the child barrier present; ordinary TODO
          // nudges must wait until all results are reconciled and blockers clear.
          if (observed.blocked && (input.kind !== 'collect' || observed.blockedByRequests !== false
            || !['active', 'awaiting_acknowledgement'].includes(observed.managedBarrierState))) throw recoveryError('managed_continuation_blocked');
          const count = next.todoContinuationCount ?? 0;
          const limit = input.kind === 'builder_todo' ? 12 : 3;
          if (input.kind !== 'collect' && count >= limit) throw recoveryError('managed_objective_budget_exhausted');
          const builder = input.kind === 'builder_todo' ? planBuilderTodoContinuation(next, observed) : null;
          if (builder && !builder.allowed) throw recoveryError(builder.reason);
          if (handshake.instanceID !== input.instanceID) throw recoveryError('recovery_owner_mismatch');
          if (draining || (generations.get(r.sessionID) ?? 0) !== generation) throw fenced(draining ? 'draining' : 'generation_changed');
          invalidate(r.sessionID);
          return { ...next, continuationID: input.userMessageID, collectionIssue: null,
            ...(nativePrompt ? { nativeContinuation: { messageID: input.userMessageID,
              sourceUserMessageID: currentObjectiveUser(next), sourceAssistantMessageID: next.stepID,
              cancellationGeneration: next.cancellationGeneration, kind: input.kind, prompt: structuredClone(nativePrompt) } } : {}),
            ...(collectionProof ? { collectionWake: { taskId: collectionProof.taskId, envelopeId: collectionProof.envelopeId,
              messageID: input.userMessageID, reservedAt: now(), generation: next.cancellationGeneration }, reason: null, failureKind: null } : {}),
            activeUserID: undefined,
            todoContinuationCount: count + (input.kind === 'collect' ? 0 : 1),
            ...(builder ? { builderTodoGuard: builder.guard } : {}),
            state: 'observing', stepID: null, requestedAt: null, failureObserved: false, failure: null, failedID: null };
        }, nativePrompt ? async () => {
          if (draining || handshake?.instanceID !== input.instanceID
            || (generations.get(r.sessionID) ?? 0) !== generation + 1 || !await authorizeBounded(r)) throw fenced('unauthorized');
        } : undefined);
        if (input.collection?.taskId) evidenceFailures.delete(`${r.sessionID}\0${input.collection.taskId}`);
        if (deliveredMessageID) return { allowed: true, deliveredMessageID, anchorUserMessageID: admitted.anchorID, tools: admitted.tools };
        diagnostic('managed_continuation_admitted', admitted, { kind: input.kind,
          todoContinuationCount: admitted.todoContinuationCount, continuationMessageID: input.userMessageID });
        return { allowed: true, anchorUserMessageID: admitted.anchorID, tools: admitted.tools,
          todoContinuationCount: admitted.todoContinuationCount };
      } catch (error) {
        const taskId = /^dvr_task_[a-zA-Z0-9]+$/.test(input.collection?.taskId ?? '') ? input.collection.taskId : null;
        // Evidence that stays unreadable surfaces the result to the user (the
        // Collect Result action) while automatic retries continue.
        // Consecutive: any other outcome for this task resets the count. An
        // observation that times out gathering the evidence counts the same.
        let evidenceIssue = false;
        if (taskId && input.kind === 'collect') {
          const key = `${r.sessionID}\0${taskId}`;
          if (['managed_collection_evidence_unavailable', 'recovery_observation_timeout'].includes(error.code)) {
            const count = (evidenceFailures.get(key) ?? 0) + 1;
            evidenceFailures.delete(key); evidenceFailures.set(key, count);
            if (evidenceFailures.size > 1000) evidenceFailures.delete(evidenceFailures.keys().next().value);
            evidenceIssue = count >= COLLECTION_EVIDENCE_ISSUE_AFTER;
          } else evidenceFailures.delete(key);
        }
        if (taskId && (collectionIssueCodes.has(error.code) || evidenceIssue)) {
          const issue = { taskId, code: evidenceIssue ? 'managed_collection_unverified' : error.code };
          if (evidenceIssue) error.fenceReason ??= 'collection_evidence_unavailable';
          await mutate(r.sessionID, next => !next || next.anchorID !== r.anchorID || next.anchorID !== input.anchorUserMessageID
            || ['cancelled', 'superseded'].includes(next.state)
            || (next.collectionIssue?.taskId === issue.taskId && next.collectionIssue.code === issue.code)
            ? next : { ...next, collectionIssue: issue });
          diagnostic('managed_collection_rejected', r, { ...issue, ...(error.fenceReason ? { fenceReason: error.fenceReason } : {}) });
        }
        throw error;
      }
    }
    if (isGuarded && input.action === 'tool_before' && (!(r.allowedReadTools ?? []).includes(input.tool)
      || (input.nativeToolVerified !== true && options.getToolPolicy) || r.tools['*'] === false || r.tools[input.tool] === false)) {
      await attention(r.sessionID, 'recovery_requires_user_action');
      diagnostic('provider_recovery_action_blocked', r, {
        toolCallID: typeof input.callID === 'string' ? input.callID.slice(0, 256) : null,
      });
      void options.abortSession(r).catch(() => diagnostic('provider_recovery_abort_failed', r));
      throw recoveryError('recovery_requires_user_action');
    }
    if (input.userMessageID !== currentUser || TERMINAL.has(r.state)) {
      throw recoveryError('provider_recovery_fenced');
    }
    if (enforcing && r.state === 'stopping' && input.action === 'tool_before') throw recoveryError('provider_stop_in_progress');
    if (input.action === 'step') {
      if (typeof input.assistantMessageID !== 'string') throw recoveryError('provider_step_unresolved');
      const stepExecution = r.recoveryID && r.recoveryExecution && input.userMessageID===currentObjectiveUser(r) ? r.recoveryExecution : r;
      if (isGuarded && options.getToolPolicy && (input.execution?.providerID !== stepExecution.providerID
        || input.execution?.modelID !== stepExecution.modelID || input.execution?.agent !== stepExecution.agent
        || (input.execution?.variant ?? null) !== stepExecution.variant)) {
        await attention(r.sessionID, 'recovery_execution_changed');
        throw recoveryError('recovery_execution_changed');
      }
      if (r.nativeFallback?.pending && input.assistantMessageID === r.nativeFallback.pending.previousStepID) throw recoveryError('native_fallback_fenced');
      if ((enforcing || isGuarded) && r.stepID === input.assistantMessageID && r.requestedAt !== null) {
        // A provider-native retry of the same model step must return to the owner.
        await attention(r.sessionID, 'native_retry_fenced');
        throw recoveryError('provider_retry_requires_reconciliation');
      }
      const stepGeneration = generations.get(r.sessionID) ?? 0;
      let authorizePendingChoice;
      l.phase = 'provider'; l.at = now(); l.signatures.clear(); l.textHashes.clear();
      await mutate(r.sessionID, async (next) => {
        if (next.anchorID !== r.anchorID || TERMINAL.has(next.state)
          || input.userMessageID !== currentObjectiveUser(next)) throw recoveryError('provider_recovery_fenced');
        if ((enforcing || isGuarded) && next.stepID === input.assistantMessageID && next.requestedAt !== null) throw recoveryError('provider_retry_requires_reconciliation');
        const choice = next.nativeFallback?.pending;
        if (choice) {
          const exact = () => stepGeneration === (generations.get(next.sessionID) ?? 0) && !draining
            && ownsRuntime && storageHealthy && options.isManaged() && handshake?.version === '2.0.20'
            && choice.instanceID === input.instanceID && handshake?.instanceID === input.instanceID
            && choice.cancellationGeneration === next.cancellationGeneration && next.stepID === choice.previousStepID
            && next.nativeFallback.userMessageID === input.userMessageID && next.state === 'observing' && !next.recoverySuppressed
            && !next.recoveryID && !next.attemptCount && input.assistantMessageID !== choice.previousStepID
            && validNativeWitness(input.nativeAttempt,input.nativePermitSha256)
            && nativeWitnessMatches(choice,input.nativeAttempt,input.nativePermitSha256)
            && ['providerID','modelID','agent','variant'].every(key => choice.currentExecution[key] === next[key] && input.execution?.[key] === next[key]);
          authorizePendingChoice = async()=>{if(!exact() || !await authorizeBounded(next) || !exact())throw recoveryError('native_fallback_fenced');};
          if (!exact() || !await authorizeBounded(next)) throw recoveryError('native_fallback_fenced');
          const observation = await observeBounded(next), inspected = inspectRecoveryTurn(next,observation);
          const assistant = inspected.last;
          const predecessors = observation.messages.filter(message => message.info.role === 'assistant' && message.info.parentID === input.userMessageID);
          const previous = predecessors.at(-2);
          if (!await authorizeBounded(next) || !exact() || inspected.superseded || assistant?.info.id !== input.assistantMessageID
            || assistant.info.time?.completed || assistant.turnOwnership?.source !== 'native-sequence'
            || assistant.turnOwnership.userMessageID !== input.userMessageID
            || ['providerID','modelID','agent','variant'].some(key => assistant.info[key] !== next[key])
            || (choice.previousStepID === null ? predecessors.length !== 1 : previous?.info.id !== choice.previousStepID
              || !Number.isFinite(previous?.info.time?.completed) || previous.info.time.completed <= 0
              || previous.turnOwnership?.source !== 'native-sequence' || previous.turnOwnership.userMessageID !== input.userMessageID
              || ['providerID','modelID','agent','variant'].some(key => previous.info[key] !== next[key]))) throw recoveryError('native_fallback_fenced');
        }
        return { ...next, stepID: input.assistantMessageID,
          ...(choice ? {nativeFallback:{...next.nativeFallback,stepID:input.assistantMessageID,pending:undefined}} : {}),
          ...(next.executionGeneration === 2 && validNativeWitness(input.nativeAttempt,input.nativePermitSha256)
            ? {nativeStepWitness:{attempt:structuredClone(input.nativeAttempt),permitSha256:input.nativePermitSha256}} : {nativeStepWitness:undefined}),
          ...(next.nativeContinuation?.messageID === input.userMessageID ? { nativeContinuation: undefined } : {}),
          ...(next.collectionWake?.messageID === input.userMessageID ? { collectionIssue: null } : {}),
          requestedAt: now(), instanceID: input.instanceID, failure: null, failureObserved: false, failureKind: null,
          reason: next.reason === 'provider_input_progress_unavailable' ? null : next.reason };
      },async()=>authorizePendingChoice?.());
      const timeouts = Object.fromEntries(['headers', 'chunk', 'total'].map((key) => [key,
        Number.isFinite(input.timeouts?.[key]) || input.timeouts?.[key] === false ? input.timeouts[key] : null]));
      diagnostic('provider_request_prepared', r, { observedTimeoutOptions: timeouts, configurationSource: 'provider_options_hook',
        transport: 'unverified', requestPreparedAt: now(), meaningfulProgressAt: l.at, phase: l.phase });
    }
    if (input.action === 'tool_before') { l.calls.add(input.callID); l.phase = 'tool'; }
    return { allowed: true, readOnly: isGuarded };
  }

  const observeProgress = (input) => {
    const record = records.get(input.sessionID);
    if (!record || TERMINAL.has(record.state) || (input.messageID && input.messageID !== record.stepID)
      || (Number.isFinite(input.taskCreatedAt) && input.taskCreatedAt < record.createdAt)
      || typeof input.identity !== 'string' || input.identity.length > 4096) return Promise.resolve();
    const fingerprint = crypto.createHash('sha256').update(`${input.kind}:${input.identity}`).digest('hex');
    if (record.progress?.seen.includes(fingerprint)) return Promise.resolve();
    return mutate(record.sessionID, (next) => {
      if (!next || next.anchorID !== record.anchorID || TERMINAL.has(next.state)) return next;
      const progress = applyObjectiveProgress(next.progress, { kind: input.kind, fingerprint, at: now() });
      return progress === next.progress ? next : { ...next, progress };
    }).then((next) => diagnostic('objective_progress_observed', next, { progressKind: input.kind, fingerprint,
      progress: projectObjectiveProgress(next?.progress) })).catch(() => diagnostic('objective_progress_observation_unavailable', record));
  };

  function observe(payload) {
    const p = payload?.properties ?? {};
    const id = p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID ?? p.task?.rootSessionId;
    const r = records.get(id);
    if (!r) return;
    const l = remember(r);
    if (payload.type === 'openchamber:managed-task' && p.resultEnvelope && p.resultEnvelope.taskId === p.task?.taskId
      && p.resultEnvelope.rootSessionId === id && p.resultEnvelope.status === 'completed') {
      if (Number.isFinite(p.task.createdAt)) void observeProgress({ sessionID: id, kind: 'child-completed',
        identity: p.resultEnvelope.envelopeId, taskCreatedAt: p.task.createdAt });
    }
    if (payload.type === 'message.part.delta' && typeof p.delta === 'string' && p.delta && p.messageID === r.stepID
      && ['text', 'reasoning'].includes(p.field)) {
      l.at = now();
      const hash = l.textHashes.get(p.partID);
      if (hash) { hash.update(p.delta); l.signatures.set(p.partID, hash.copy().digest('hex')); }
    }
    if (payload.type === 'message.part.updated' && p.part?.messageID === r.stepID) {
      const part = p.part;
      // The actual terminal event can arrive when a failed executor never
      // reached its after hook. Clear liveness only; outcome/receipt checks
      // still decide whether this turn can recover or continue.
      if (part.type === 'tool' && ['completed', 'error'].includes(part.state?.status)) l.calls.delete(part.callID);
      if (part.type === 'tool' && part.tool !== 'todowrite'
        && (part.state?.status === 'completed' || (part.state?.status === 'error' && Number.isSafeInteger(part.state?.metadata?.exit)))) {
        l.completedTools ??= new Set();
        if (!l.completedTools.has(part.callID)) {
          l.completedTools.add(part.callID);
          while (l.completedTools.size > 512) l.completedTools.delete(l.completedTools.values().next().value);
          const output = typeof part.state.output === 'string' ? part.state.output : part.state.error ?? '';
          const fingerprint = crypto.createHash('sha256').update(JSON.stringify([part.tool, part.state.input, output])).digest('hex');
          void observeProgress({ sessionID: id, messageID: part.messageID, kind: 'tool-evidence', identity: fingerprint });
        }
      }
      const signature = progressSignature(part);
      if (typeof signature === 'string') {
        // Retain hashes, never text/arguments, and only for the current step.
        const hash = crypto.createHash('sha256').update(signature).digest('hex');
        if (l.signatures.get(part.id) !== hash) {
          if (l.signatures.size >= 256) {
            const oldest = l.signatures.keys().next().value;
            l.signatures.delete(oldest); l.textHashes.delete(oldest);
          }
          l.signatures.set(part.id, hash); l.at = now();
          if (l.phase === 'provider_input_unobservable') l.phase = 'provider';
        }
        if (['text', 'reasoning'].includes(part.type)) l.textHashes.set(part.id, crypto.createHash('sha256').update(signature));
      }
    }
    if (payload.type === 'permission.asked' || payload.type === 'question.asked') l.blockers.add(p.id);
    if (payload.type === 'permission.replied' || payload.type === 'question.replied' || payload.type === 'question.rejected') {
      l.blockers.delete(p.requestID ?? p.id); l.at = now();
    }
    if (payload.type === 'session.status') {
      if (p.status?.type === 'retry') l.phase = 'retry';
      if (p.status?.type === 'idle') { l.phase = 'idle'; return schedule(id); }
    }
    if (payload.type === 'session.error') {
      const failure = classifyPrimaryTransportError(p.error, handshake?.version);
      return mutate(id, (next) => next && !TERMINAL.has(next.state) ? { ...next,
        failure, failureObserved: true,
        failureKind: options.classifyFailure?.(p.error) ?? null,
      } : next)
        .then(() => schedule(id)).catch(() => diagnostic('provider_recovery_persistence_failed', r));
    }
    if (payload.type === 'message.updated' && p.info?.time?.completed
      && p.info.role === 'assistant' && p.info.id === r.stepID
      && p.info.parentID === currentObjectiveUser(r)) return schedule(id);
  }

  // Every poll reads the turn's whole transcript. A progress cutoff can only
  // stop a turn this runtime may act on, so other records are never polled for
  // it. An unfinished recovery is normally settled by its events; its fallback
  // poll backs off from 5 s to 5 min while the record does not change.
  const polls = new Map();
  const pollDue = (record) => {
    const known = polls.get(record.sessionID);
    const at = now();
    if (known && known.revision === record.revision && at < known.next) return false;
    const delay = known?.revision === record.revision ? Math.min(known.delay * 2, 300_000) : 5_000;
    polls.set(record.sessionID, { revision: record.revision, delay, next: at + delay });
    while (polls.size > 1024) polls.delete(polls.keys().next().value);
    return true;
  };
  async function reconcile() {
    const relaxed = advisory();
    await Promise.allSettled([...records.values()].filter((r) => !TERMINAL.has(r.state)).map((r) => {
      const l = remember(r);
      const watchdog = progressTimeoutMs !== false && l.phase === 'provider' && !l.calls.size && !l.blockers.size
        && now() - l.at >= progressTimeoutMs && (!relaxed || (active(r) && supported(r)));
      if (watchdog) return schedule(r.sessionID, true);
      return ACTIVE_RECOVERY.has(r.state) && (!relaxed || pollDue(r)) ? schedule(r.sessionID, false) : undefined;
    }));
  }
  return {
    bindNativeRecoveryDispatchInput({sessionID,messageID,instanceID,itemHash}) {
      const r=records.get(sessionID),dispatch=live.get(sessionID)?.recoveryDispatch;
      if(draining || !r || !dispatch || instanceID!==handshake?.instanceID || dispatch.instanceID!==instanceID
        || !['recovery_reserved','recovering'].includes(r.state)
        || r.recoveryID!==messageID || dispatch.recoveryID!==messageID || dispatch.owner!==r.owner
        || dispatch.cancellationGeneration!==r.cancellationGeneration || typeof itemHash!=='string' || !/^[a-f0-9]{64}$/.test(itemHash)
        || dispatch.itemHash && dispatch.itemHash!==itemHash)throw recoveryError('native_primary_continuation_fenced');
      dispatch.itemHash=itemHash;
    },
    admit, control, plugin, observe, observeProgress, reconcile, adoptOwnedNativeContinuation, reserveNativeFallback,
    async nativeStartupRecords() { await ready; return [...records.values()].filter(r=>r.executionGeneration===2).map(r=>structuredClone(r)); },
    async adoptRecoveredInput(input, authorizeWrite) {
      await ready;
      return mutate(input.sessionID, async r=>{
        if(!r || r.revision!==input.recordRevision || r.cancellationGeneration!==input.cancellationGeneration
          || r.owner!==input.previousOwner || r.executionGeneration!==2
          || ![r.anchorID,r.recoveryID].includes(input.messageID)
          || r.nativeContinuation || r.activeUserID || input.messageID===r.anchorID&&(r.stepID||r.attemptCount!==0)
          || input.messageID===r.recoveryID&&(!r.recoveryPrompt||!r.recoveryExecution||r.attemptCount!==1))throw recoveryError('recovery_revision_conflict');
        await authorizeWrite();
        return {...r,owner:input.owner,state:input.messageID===r.recoveryID?'recovery_reserved':'observing',reason:null,
          ...(input.messageID===r.anchorID && r.nativeFallback?.pending ? {nativeFallback:undefined,nativeStepWitness:undefined} : {}),
          instanceID:input.instanceID,recoveredInput:{inputID:input.messageID,payloadHash:input.payloadHash,
            enqueuedSeq:input.enqueuedSeq,delivery:input.delivery,phase:'adopted'}};
      },authorizeWrite);
    },
    async requestRecoveredInputDiscard(input, authorizeWrite) {
      await ready;
      return mutate(input.sessionID,async r=>{
        if(!r || r.revision!==input.recordRevision || r.cancellationGeneration!==input.cancellationGeneration
          || r.owner!==input.previousOwner)throw recoveryError('recovery_revision_conflict');
        const dispositions=r.recoveredInputDispositions??[];
        const existing=dispositions.find(item=>item.inputID===input.messageID);
        if(existing){if(existing.phase!=='requested'||existing.payloadHash!==input.payloadHash||existing.enqueuedSeq!==input.enqueuedSeq||existing.type!==input.type||existing.delivery!==input.delivery)throw recoveryError('recovery_revision_conflict');await authorizeWrite();return r;}
        if(dispositions.length>=128)throw recoveryError('recovery_revision_conflict');
        await authorizeWrite();
        return {...r,recoveredInputDispositions:[...dispositions,{inputID:input.messageID,payloadHash:input.payloadHash,
          enqueuedSeq:input.enqueuedSeq,type:input.type,delivery:input.delivery,phase:'requested'}]};
      },authorizeWrite);
    },
    async settleRecoveredInputDiscard(input, authorizeWrite) {
      await ready;
      return mutate(input.sessionID,async r=>{
        const intent=r?.recoveredInputDispositions?.find(item=>item.inputID===input.messageID);
        if(!r||!intent||intent.payloadHash!==input.payloadHash||intent.enqueuedSeq!==input.enqueuedSeq
          || !Number.isSafeInteger(input.eventSeq)||input.eventSeq<=intent.enqueuedSeq)throw recoveryError('recovery_revision_conflict');
        await authorizeWrite();
        const owning=[r.anchorID,r.recoveryID,r.continuationID].includes(input.messageID);
        return {...r,...owning?{state:'cancelled',reason:'recovered_input_discarded'}:{},...(r.nativeContinuation?.messageID===input.messageID?{nativeContinuation:undefined}:{}),...(r.recoveredInput?.inputID===input.messageID?{recoveredInput:undefined}:{}),
          recoveredInputDispositions:r.recoveredInputDispositions.map(item=>item===intent?{...item,phase:'cancelled',eventID:input.eventID,eventSeq:input.eventSeq}:item)};
      },authorizeWrite);
    },
    async captureNativeRecoveryDispatch(input) {
      await ready;
      const original = await store.readRecord(keyFor(input.sessionID));
      const generation = generations.get(input.sessionID) ?? 0;
      const recheck = async () => {
        const r = await store.readRecord(keyFor(input.sessionID));
        if (!r || !original || !nativeFallbackEligible(r) || generation !== (generations.get(input.sessionID) ?? 0)
          || r.anchorID !== original.anchorID || r.cancellationGeneration !== original.cancellationGeneration
          || r.directory !== input.directory || r.recoveryID !== input.messageID || r.attemptCount !== 1
          || !r.recoveryExecution || !r.recoveryPrompt || !['recovery_reserved','recovering'].includes(r.state)
          || input.instanceID !== undefined && input.instanceID !== handshake.instanceID
          || JSON.stringify(r.recoveryPrompt) !== JSON.stringify(original.recoveryPrompt)) throw recoveryError('native_fallback_fenced');
        if (!await authorizeBounded(r) || draining || generation !== (generations.get(input.sessionID) ?? 0)) throw recoveryError('native_fallback_fenced');
      };
      await recheck();return {record:structuredClone(original),prompt:structuredClone(original.recoveryPrompt),recheck};
    },
    async reserveNativeContinuation(input, prompt) {
      await ready;
      const record = await store.readRecord(keyFor(input.sessionID));
      if (record?.executionGeneration !== 2 || record.nativeContinuation || record.stepID !== input.assistantMessageID
        || prompt?.messageID !== input.userMessageID || prompt.agent !== record.agent
        || prompt.model?.providerID !== record.providerID || prompt.model?.modelID !== record.modelID
        || prompt.variant !== record.variant || JSON.stringify(prompt.tools) !== JSON.stringify(record.tools)
        || prompt.objectiveID !== (record.objectiveID ?? record.anchorID)
        || !Array.isArray(prompt.parts) || !prompt.parts.length || prompt.parts.some(part => part.type !== 'text'
          || part.synthetic !== true || typeof part.text !== 'string') || Buffer.byteLength(JSON.stringify(prompt)) > 64 * 1024) {
        throw recoveryError('native_primary_continuation_invalid');
      }
      return plugin({ ...input, action: 'continuation' }, undefined, prompt);
    },
    async pendingNativeContinuations({ directory }) {
      await ready;
      return [...records.values()].filter(record => record.directory === directory && record.nativeContinuation
        && record.state === 'observing').map(record => ({ sessionID: record.sessionID,
          directory: record.directory, messageID: record.nativeContinuation.messageID }));
    },
    async captureNativeContinuationDispatch(input) {
      await ready;
      const instanceID = input.instanceID ?? handshake?.instanceID;
      const original = await store.readRecord(keyFor(input.sessionID));
      const pending = original?.nativeContinuation;
      if (!pending || original.executionGeneration !== 2 || original.directory !== input.directory
        || pending.messageID !== input.messageID || original.continuationID !== input.messageID
        || typeof instanceID !== 'string' || instanceID !== handshake?.instanceID) throw recoveryError('native_primary_continuation_invalid');
      const generation = generations.get(input.sessionID) ?? 0;
      const recheck = async () => {
        const current = await store.readRecord(keyFor(input.sessionID));
        if (draining || !storageHealthy || !ownsRuntime || !options.isManaged()
          || handshake?.instanceID !== instanceID || (generations.get(input.sessionID) ?? 0) !== generation
          || !['observing', 'completed'].includes(current?.state) || current.recoverySuppressed || current.recoveryID
          || (current.state === 'completed' && current.nativeContinuation)
          || current.continuationID !== input.messageID || current.directory !== original.directory
          || current.owner !== original.owner || current.cancellationGeneration !== pending.cancellationGeneration
          || current.anchorID !== original.anchorID || current.providerID !== original.providerID
          || current.modelID !== original.modelID || current.agent !== original.agent || current.variant !== original.variant
          || JSON.stringify(current.tools) !== JSON.stringify(original.tools)
          || (current.nativeContinuation && JSON.stringify(current.nativeContinuation) !== JSON.stringify(pending))) {
          throw recoveryError('native_primary_continuation_fenced');
        }
        if (!await authorizeBounded(current)) throw recoveryError('native_primary_continuation_fenced');
        const observation = await observeBounded(current);
        const users = observation.messages?.filter(message => message.info?.role === 'user' && !isNativeStatusRecord(message));
        const latest = users?.at(-1)?.info.id;
        if (!observation.complete || observation.session?.parentID || observation.session?.time?.archived
          || observation.session?.revert || observation.session?.directory !== original.directory
          || ![pending.sourceUserMessageID, input.messageID].includes(latest)) throw recoveryError('native_primary_continuation_fenced');
        const source = observation.messages.find(message => message.info?.id === pending.sourceAssistantMessageID);
        if (!source || source.info.sessionID !== input.sessionID || source.info.role !== 'assistant'
          || source.turnOwnership?.source !== 'native-sequence' || source.turnOwnership.userMessageID !== pending.sourceUserMessageID
          || source.info.parentID !== pending.sourceUserMessageID
          || !source.info.time?.completed || source.info.error) throw recoveryError('native_primary_continuation_fenced');
        if (!await authorizeBounded(current) || handshake?.instanceID !== instanceID
          || (generations.get(input.sessionID) ?? 0) !== generation) throw recoveryError('native_primary_continuation_fenced');
      };
      await recheck();
      return { record: structuredClone(original), prompt: structuredClone(pending.prompt), recheck };
    },
    recordRejection(input, authorizeWrite) {
      if(typeof authorizeWrite!=='function')throw recoveryError('native_rejection_authority_required');
      return plugin({...input,action:'rejected'},authorizeWrite);
    },
    // A lost dispatch acknowledgement never rolls back or silently retries.
    markPromptDispatchUncertain: ({ sessionID, messageID }) => mutate(sessionID, record => record
      && record.anchorID === messageID && record.stepID === null && record.state === 'observing'
      ? { ...record, state: 'needs_attention', reason: 'prompt_dispatch_uncertain' } : record),
    // Existing admission performs one invalidation between its two guarded
    // write checks. Stop/supersede invalidation is immediate, before its lock.
    async captureNativePromptAdmission(id) {
      await ready;
      const generation=generations.get(id)??0,original=await store.readRecord(keyFor(id));
      if((generations.get(id)??0)!==generation||draining||!ownsRuntime||!storageHealthy)throw recoveryError('native_queued_admission_revoked');
      let began=false;
      return async()=>{
        const expected=generation+(began?1:0),current=await store.readRecord(keyFor(id));
        if(draining||!ownsRuntime||!storageHealthy||(generations.get(id)??0)!==expected
          ||current?.anchorID!==original?.anchorID||current?.cancellationGeneration!==original?.cancellationGeneration)throw recoveryError('native_queued_admission_revoked');
        began=true;
      };
    },
    readRecord: (id) => store.readRecord(keyFor(id)),
    async getSnapshot(id) {
      const r = await store.readRecord(keyFor(id));
      if (store.getDiagnostics?.().quarantineCount) storageHealthy = false;
      if (r) records.set(id, r);
      return project(r);
    },
    initialize() {
      ready ??= (async () => {
      await store.initialize();
      await new Promise((resolve) => {
        ownerTask = withCrossProcessFileLock(path.join(store.directory, 'runtime-owner.lock'), async () => {
          ownsRuntime = true;
          await new Promise((release) => { releaseOwner = release; resolve(); });
        }, { timeoutMs: 0 }).catch(() => { diagnostic('provider_recovery_owner_unavailable'); resolve(); });
      });
      for (const { record } of await store.listRecords()) {
        records.set(record.sessionID, record);
        if (!TERMINAL.has(record.state)) remember(record);
      }
      const quarantined = await fs.readdir(path.join(store.directory, 'quarantine')).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      storageHealthy = quarantined.length === 0;
      if (!storageHealthy) diagnostic('provider_recovery_storage_unavailable');
      await prune();
      timer = setInterval(() => { void reconcile(); }, options.pollMs ?? 1000);
      timer.unref?.();
      })();
      return ready;
    },
    async drain() {
      draining = true; clearInterval(timer);
      await Promise.allSettled([...pending.values()]); await store.drain();
      releaseOwner?.(); await ownerTask; ownsRuntime = false;
    },
  };
}
