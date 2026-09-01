import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createRecordStore } from './record-store.js';
import { withCrossProcessFileLock } from './atomic-file.js';
import {
  classifyPrimaryTransportError, inspectRecoveryTurn, recoveryError,
  RECOVERY_READ_TOOLS, PROVIDER_PROGRESS_TIMEOUT_MS, validatePrimaryRecoveryRecord,
} from './provider-recovery-policy.js';

const TERMINAL = new Set(['completed', 'needs_attention', 'cancelled', 'superseded']);
const ACTIVE_RECOVERY = new Set(['stopping', 'reconciling', 'recovery_reserved', 'recovering']);
const keyFor = (sessionID) => crypto.createHash('sha256').update(sessionID).digest('hex');
const messageID = (now) => `msg_${(BigInt(now) * 4096n).toString(16).slice(-12).padStart(12, '0')}${crypto.randomBytes(7).toString('hex')}`;
const progressSignature = (part) => ['text', 'reasoning'].includes(part.type) ? part.text
  : part.type === 'tool' ? JSON.stringify([part.state?.status, part.state?.input, part.state?.raw]) : null;

export function createPrimaryRecoveryController(options) {
  const now = options.now ?? Date.now;
  const store = options.store ?? createRecordStore({ directory: options.directory, validateRecord: validatePrimaryRecoveryRecord, maxReadBytes: 128 * 1024 });
  const mode = options.mode ?? 'observe';
  if (!['off', 'observe', 'enforce'].includes(mode)) throw new TypeError('Invalid provider recovery mode');
  const progressTimeoutMs = options.progressTimeoutMs ?? PROVIDER_PROGRESS_TIMEOUT_MS;
  if (progressTimeoutMs !== false && (!Number.isSafeInteger(progressTimeoutMs) || progressTimeoutMs < 1)) {
    throw new TypeError('Invalid provider progress timeout');
  }
  const records = new Map();
  const live = new Map();
  const pending = new Map();
  const generations = new Map();
  let handshake = null;
  let draining = false;
  let timer;
  let ownsRuntime = false;
  let releaseOwner;
  let ownerTask;
  let ready;
  let storageHealthy = true;
  const supported = (record) => storageHealthy && ownsRuntime && handshake?.version === '1.18.25' && options.isManaged()
    && (!record || (record.requestedAt !== null && record.instanceID === handshake.instanceID));
  const active = () => !draining && mode === 'enforce' && supported();
  const diagnostic = (event, record, detail = {}) => options.recordIncident?.({
    event, sessionID: record?.sessionID, messageID: record?.anchorID,
    assistantMessageID: record?.failedID ?? null, recoveryMessageID: record?.recoveryID ?? null,
    runtimeInstanceID: handshake?.instanceID ?? null, runtimeVersion: handshake?.version ?? null,
    mode, progressTimeoutMs, wireTiming: 'unavailable', providerRequestID: 'unavailable', ...detail,
    hostNodeVersion: process.version, hostBuild: options.buildVersion ?? process.env.npm_package_version ?? 'unavailable',
  });
  const project = (record) => ({
    schemaVersion: 1, mode, supported: supported(record) && (!record || record.providerID === 'openai'),
    enforced: active() && supported(record) && (!record || record.providerID === 'openai'), progressTimeoutMs,
    record: record ? {
      sessionID: record.sessionID, anchorID: record.anchorID, failedID: record.failedID,
      recoveryID: record.recoveryID, state: record.state, revision: record.revision,
      attemptCount: record.attemptCount, maxAttempts: 1, readOnly: Boolean(record.recoveryID),
      providerID: record.providerID, modelID: record.modelID, agent: record.agent, variant: record.variant,
      reason: record.reason, updatedAt: record.updatedAt,
    } : null,
  });
  const publish = (record) => options.publishEvent?.({
    type: 'openchamber:primary-recovery', properties: { sessionID: record.sessionID, recovery: project(record) },
  }, { directory: record.directory });
  const lock = (id, fn) => (options.withLock
    ? options.withLock(id, fn)
    : withCrossProcessFileLock(path.join(store.directory, `${keyFor(id)}.lock`), fn));
  const mutate = (id, fn) => lock(id, async () => {
    const existing = await store.readRecord(keyFor(id));
    const next = await fn(existing);
    if (!next || next === existing) return existing;
    const value = { ...next, revision: (existing?.revision ?? 0) + 1, updatedAt: now() };
    try { await store.writeRecord(keyFor(id), value); }
    catch (error) { storageHealthy = false; throw error; }
    records.set(id, value);
    publish(value);
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
  const attention = (id, reason) => mutate(id, (r) => r && !['cancelled', 'superseded'].includes(r.state)
    ? { ...r, state: 'needs_attention', reason } : r);

  async function admit(input) {
    await ready;
    const body = input.body ?? {};
    if (!input.primary || !options.isManaged()) return;
    if (body.model?.providerID !== 'openai' && !records.has(input.sessionID)) return;
    if (!storageHealthy || !ownsRuntime) throw recoveryError('recovery_storage_unavailable', 503);
    if (!body.messageID || !body.model?.providerID || !body.model?.modelID || !body.agent) {
      if (records.has(input.sessionID) && active()) throw recoveryError('recovery_execution_selection_required', 400);
      return;
    }
    // The host adapter verifies session/directory/ownership before admission.
    if (![body.messageID, body.model.providerID, body.model.modelID, body.agent].every((value) => typeof value === 'string' && value.length > 0 && value.length <= 256)
      || !/^msg_[a-zA-Z0-9]+$/.test(body.messageID)
      || (body.variant !== undefined && (typeof body.variant !== 'string' || body.variant.length > 256))
      || (body.tools !== undefined && (!body.tools || typeof body.tools !== 'object' || Array.isArray(body.tools)
        || Object.values(body.tools).some((value) => typeof value !== 'boolean')))) throw recoveryError('invalid_recovery_admission', 400);
    if (!records.has(input.sessionID) && !(await prune())) throw recoveryError('recovery_storage_full', 507);
    if (records.get(input.sessionID)?.anchorID === body.messageID) throw recoveryError('prompt_already_admitted');
    return mutate(input.sessionID, (r) => {
      if (r?.anchorID === body.messageID || r?.guardedIDs.includes(body.messageID)) throw recoveryError('prompt_already_admitted');
      if (r && ['recovery_reserved', 'recovering', 'stopping'].includes(r.state)) throw recoveryError('recovery_in_progress');
      if ((r?.guardedIDs.length ?? 0) >= 128 || Buffer.byteLength(JSON.stringify(body.tools ?? {})) > 16_384) throw recoveryError('recovery_storage_full', 507);
      invalidate(input.sessionID);
      live.delete(input.sessionID);
      return {
        version: 1, sessionID: input.sessionID, directory: input.directory, anchorID: body.messageID,
        providerID: body.model.providerID, modelID: body.model.modelID, agent: body.agent,
        variant: body.variant ?? null, tools: body.tools ?? {}, owner: input.owner ?? null,
        state: 'observing', reason: null, attemptCount: 0, failedID: null, recoveryID: null,
        stepID: null, requestedAt: null, instanceID: null,
        guardedIDs: r?.guardedIDs ?? [], createdAt: now(), cancellationGeneration: (r?.cancellationGeneration ?? 0) + 1,
      };
    });
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
  const observeBounded = async (record, deadline = now() + 5000) => {
    const abort = new AbortController();
    let timeout;
    try {
      return await Promise.race([
        options.observeTurn(record, { signal: abort.signal }),
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

  async function reconcileOne(id, watchdog = false) {
    const before = records.get(id);
    if (!before || draining || TERMINAL.has(before.state) || before.providerID !== 'openai') return;
    // chat.message handshakes before OpenCode persists the admitted user
    // message. A delayed idle event must not mistake that window for lost work.
    if (before.state === 'observing' && !before.requestedAt && !before.failureObserved && !before.recoveryID) return;
    const generation = generations.get(id) ?? 0;
    const current = () => !draining && (generations.get(id) ?? 0) === generation;
    const liveness = remember(before);
    const progressAt = liveness.at;
    let observation = await observeBounded(before);
    if (!current()) return;
    if (!before.requestedAt && !before.recoveryID
      && !observation.messages?.some((m) => m.info?.id === before.anchorID)) return;
    let inspected = inspectRecoveryTurn(before, observation);
    if (inspected.superseded) { await control(id, 'supersede'); return; }
    if (before.recoveryID && !watchdog) {
      if (inspected.settled) {
        await mutate(id, (r) => r && current() ? { ...r, state: inspected.last.info.error ? 'needs_attention' : 'completed',
          reason: inspected.last.info.error ? 'recovery_failed' : 'recovery_completed' } : r);
      } else if (inspected.last?.info.error && inspected.last.info.time?.completed) {
        await attention(id, 'recovery_failed');
      } else if (inspected.recoveryAccepted && before.state === 'recovery_reserved') {
        await mutate(id, (r) => current() ? { ...r, state: 'recovering' } : r);
      } else if (!inspected.recoveryAccepted) {
        await attention(id, 'recovery_dispatch_uncertain');
      }
      return;
    }
    // session.error has no reliable invocation identity. It only requests a
    // canonical read; a stale event cannot stop or recover a newer invocation.
    const failure = classifyPrimaryTransportError(inspected.last?.info.error, handshake?.version);
    if ((!failure || before.recoverySuppressed) && !watchdog) {
      if (inspected.settled && !inspected.last.info.error) await mutate(id, (r) => current() ? { ...r, state: 'completed' } : r);
      else if (active() && inspected.last?.info.error && inspected.last.info.time?.completed) await attention(id, 'failure_not_eligible');
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
    if (!active() || !supported(before) || inspected.last?.info.id !== before.stepID) return;
    if (watchdog && (liveness.at !== progressAt || blocked(before, observation) || observation.status !== 'busy')) return;
    if (watchdog && inspected.last?.parts.some((part) => part.type === 'tool' && part.state?.status === 'pending')) {
      // 1.18.25 publishes tool-input-start but drops subsequent input deltas.
      // This is provider activity with unknown progress, not executing a tool.
      liveness.phase = 'provider_input_unobservable';
      diagnostic('provider_progress_unobservable', before, { phase: liveness.phase, source: 'opencode_1.18.25_processor' });
      await mutate(id, (r) => current() ? { ...r, reason: 'provider_input_progress_unavailable' } : r);
      return;
    }
    if (!await authorizeBounded(before) || !current()) { await attention(id, 'recovery_authorization_unavailable'); return; }
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
      if (now() >= deadline) { await attention(id, 'provider_stop_unconfirmed'); return; }
      observation = await observeBounded(before, deadline);
      if (!current()) return;
      inspected = inspectRecoveryTurn(before, observation);
      if (inspected.superseded) { await control(id, 'supersede'); return; }
      if (inspected.settled && !blocked(before, observation)) break;
      if (now() >= deadline) { await attention(id, 'provider_stop_unconfirmed'); return; }
      await (options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(250);
    }
    if (!current()) return;
    diagnostic('provider_stop_settled', before, { finalizedMessageID: inspected.last.info.id, status: observation.status,
      finalizedAt: inspected.last.info.time.completed, blockersCleared: true });
    if (watchdog) { await attention(id, 'provider_progress_timeout'); return; }
    if (!inspected.last.info.error) { await mutate(id, (r) => current() ? { ...r, state: 'completed' } : r); return; }
    if (!inspected.recoveryParts.length) { await attention(id, 'recovery_input_unavailable'); return; }
    // Reserve under the same lock as ordinary admission. Release it before POST:
    // plugin hooks called during POST must be able to inspect the reservation.
    const reserved = await lock(id, async () => {
      let r = await store.readRecord(keyFor(id));
      if (!r || !current() || r.attemptCount || r.recoverySuppressed || TERMINAL.has(r.state) || !active()) return;
      const final = await observeBounded(r);
      const check = inspectRecoveryTurn(r, final);
      if (!current() || !check.settled || check.superseded || blocked(r, final) || !await authorizeBounded(r)
        || !classifyPrimaryTransportError(check.last?.info.error, handshake?.version)) return;
      const recoveryID = (options.createMessageID ?? (() => messageID(now())))();
      const toolPolicy = options.getToolPolicy ? await options.getToolPolicy(r)
        : { toolIDs: RECOVERY_READ_TOOLS, allowedReadTools: RECOVERY_READ_TOOLS };
      if (!current()) return;
      r = { ...r, revision: r.revision + 1, state: 'recovery_reserved', attemptCount: 1,
        recoveryID, allowedReadTools: toolPolicy.allowedReadTools, guardedIDs: [...r.guardedIDs, recoveryID], updatedAt: now() };
      await store.writeRecord(keyFor(id), r);
      records.set(id, r); publish(r);
      diagnostic('provider_recovery_reserved', r);
      return { record: r, parts: check.recoveryParts, toolIDs: toolPolicy.toolIDs };
    });
    if (!reserved || !current()) return;
    const r = reserved.record;
    try {
        await options.promptSession(r, { messageID: r.recoveryID, model: { providerID: r.providerID, modelID: r.modelID },
          agent: r.agent, ...(r.variant ? { variant: r.variant } : {}),
          parts: reserved.parts, tools: { ...r.tools, ...Object.fromEntries(reserved.toolIDs.map((tool) => [tool, false])), '*': false,
            ...Object.fromEntries(r.allowedReadTools.map((tool) => [tool, r.tools['*'] !== false && r.tools[tool] !== false])) } });
        await mutate(id, (next) => current() && next.state === 'recovery_reserved' ? { ...next, state: 'recovering' } : next);
        diagnostic('provider_recovery_dispatch_acknowledged', r);
    } catch {
        diagnostic('provider_recovery_dispatch_uncertain', r);
        if (current()) await attention(id, 'recovery_dispatch_uncertain');
    }
  }

  function schedule(id, watchdog = false) {
    if (pending.has(id)) return pending.get(id);
    const operation = reconcileOne(id, watchdog).catch(async (error) => {
      diagnostic('provider_recovery_observation_failed', records.get(id), {
        reason: typeof error?.code === 'string' && /^[a-z_]{1,80}$/.test(error.code) ? error.code : 'observation_failed',
      });
      if (active()) await attention(id, 'recovery_observation_unavailable');
    }).catch(() => {
      storageHealthy = false;
      diagnostic('provider_recovery_persistence_failed', records.get(id));
    }).finally(() => pending.delete(id));
    pending.set(id, operation);
    return operation;
  }

  async function plugin(input) {
    await ready;
    if (!storageHealthy) throw recoveryError('recovery_storage_unavailable', 503);
    if (!ownsRuntime) throw recoveryError('recovery_owner_unavailable', 503);
    if (!options.isManaged()) throw recoveryError('provider_recovery_external', 503);
    if (input.action === 'hello') {
      if (typeof input.instanceID !== 'string' || !input.instanceID || input.policyVersion !== 1) throw recoveryError('recovery_plugin_incompatible');
      if (handshake && handshake.instanceID !== input.instanceID) live.clear();
      handshake = { instanceID: input.instanceID, version: input.transport === 'websocket-unverified' ? null : input.version };
      diagnostic('provider_recovery_capability', null, { supported: supported(), transport: input.transport ?? 'unverified' });
      for (const record of records.values()) {
        if (!TERMINAL.has(record.state)) void schedule(record.sessionID);
      }
      return { ...project(null), instanceID: handshake.instanceID };
    }
    if (!handshake && input.action === 'continuation' && !records.get(input.sessionID)?.attemptCount) return { allowed: true };
    if (!handshake || handshake.instanceID !== input.instanceID) throw recoveryError('recovery_owner_mismatch');
    const r = records.get(input.sessionID);
    if (!r) return { allowed: true, readOnly: false };
    const enforcing = active() && r.providerID === 'openai';
    if (input.action === 'scope') return { tracked: r.providerID === 'openai' || Boolean(r.guardedIDs.length),
      enforced: enforcing, readOnly: Boolean(r.guardedIDs.length), agent: r.agent };
    const isGuarded = r.guardedIDs.includes(input.userMessageID);
    const currentUser = r.recoveryID ?? r.continuationID ?? r.anchorID;
    const l = remember(r);
    if (input.action === 'tool_after') {
      l.calls.delete(input.callID); l.at = now(); l.phase = 'preparing'; return { allowed: true };
    }
    if (input.action === 'continuation') {
      if (!enforcing) return { allowed: true };
      if (typeof input.userMessageID !== 'string' || r.attemptCount || r.recoverySuppressed
        || !['observing', 'completed'].includes(r.state)) throw recoveryError('managed_continuation_fenced');
      return mutate(r.sessionID, async (next) => {
        const observed = await observeBounded(next);
        const check = inspectRecoveryTurn(next, observed);
        if (observed.status !== 'idle' || check.superseded || check.unresolved || !check.last?.info.time?.completed
          || next.attemptCount || !await authorizeBounded(next)) throw recoveryError('managed_continuation_fenced');
        invalidate(r.sessionID);
        return { ...next, continuationID: input.userMessageID, state: 'observing', stepID: null, requestedAt: null, failure: null, failedID: null };
      });
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
    if ((enforcing || isGuarded) && (input.userMessageID !== currentUser || TERMINAL.has(r.state))) {
      throw recoveryError('provider_recovery_fenced');
    }
    if (enforcing && r.state === 'stopping' && input.action === 'tool_before') throw recoveryError('provider_stop_in_progress');
    if (input.action === 'step') {
      if (typeof input.assistantMessageID !== 'string') throw recoveryError('provider_step_unresolved');
      if (isGuarded && options.getToolPolicy && (input.execution?.providerID !== r.providerID
        || input.execution?.modelID !== r.modelID || input.execution?.agent !== r.agent
        || (input.execution?.variant ?? null) !== r.variant)) {
        await attention(r.sessionID, 'recovery_execution_changed');
        throw recoveryError('recovery_execution_changed');
      }
      if ((enforcing || isGuarded) && r.stepID === input.assistantMessageID && r.requestedAt !== null) {
        // A provider-native retry of the same model step must return to the owner.
        await attention(r.sessionID, 'native_retry_fenced');
        throw recoveryError('provider_retry_requires_reconciliation');
      }
      l.phase = 'provider'; l.at = now(); l.signatures.clear(); l.textHashes.clear();
      await mutate(r.sessionID, (next) => {
        if ((enforcing || isGuarded) && (next.anchorID !== r.anchorID || TERMINAL.has(next.state)
          || input.userMessageID !== (next.recoveryID ?? next.continuationID ?? next.anchorID))) throw recoveryError('provider_recovery_fenced');
        if ((enforcing || isGuarded) && next.stepID === input.assistantMessageID && next.requestedAt !== null) throw recoveryError('provider_retry_requires_reconciliation');
        return { ...next, stepID: input.assistantMessageID,
          requestedAt: now(), instanceID: input.instanceID, failure: null, failureObserved: false,
          reason: next.reason === 'provider_input_progress_unavailable' ? null : next.reason };
      });
      const timeouts = Object.fromEntries(['headers', 'chunk', 'total'].map((key) => [key,
        Number.isFinite(input.timeouts?.[key]) || input.timeouts?.[key] === false ? input.timeouts[key] : null]));
      diagnostic('provider_request_prepared', r, { observedTimeoutOptions: timeouts, configurationSource: 'provider_options_hook',
        transport: 'unverified', requestPreparedAt: now(), meaningfulProgressAt: l.at, phase: l.phase });
    }
    if (input.action === 'tool_before') { l.calls.add(input.callID); l.phase = 'tool'; }
    return { allowed: true, readOnly: isGuarded };
  }

  function observe(payload) {
    const p = payload?.properties ?? {};
    const id = p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID;
    const r = records.get(id);
    if (!r) return;
    const l = remember(r);
    if (payload.type === 'message.part.delta' && typeof p.delta === 'string' && p.delta && p.messageID === r.stepID
      && ['text', 'reasoning'].includes(p.field)) {
      l.at = now();
      const hash = l.textHashes.get(p.partID);
      if (hash) { hash.update(p.delta); l.signatures.set(p.partID, hash.copy().digest('hex')); }
    }
    if (payload.type === 'message.part.updated' && p.part?.messageID === r.stepID) {
      const part = p.part;
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
      } : next)
        .then(() => schedule(id)).catch(() => diagnostic('provider_recovery_persistence_failed', r));
    }
    if (payload.type === 'message.updated' && p.info?.time?.completed) void schedule(id);
  }

  async function reconcile() {
    await Promise.allSettled([...records.values()].filter((r) => !TERMINAL.has(r.state)).map((r) => {
      const l = remember(r);
      const watchdog = progressTimeoutMs !== false && l.phase === 'provider' && !l.calls.size && !l.blockers.size
        && now() - l.at >= progressTimeoutMs;
      return watchdog || ACTIVE_RECOVERY.has(r.state) ? schedule(r.sessionID, watchdog) : undefined;
    }));
  }
  return {
    admit, control, plugin, observe, reconcile,
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
