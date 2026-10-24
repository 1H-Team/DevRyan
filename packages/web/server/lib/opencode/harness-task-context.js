import { assertManagedToolOutputSize } from '@devryan/orchestration-runtime/tool-output-limits.js';
import path from 'node:path';
import { validateCanonicalPlanSource } from '../plans/canonical-source.js';
import fs from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createTaskContextRuntime, planReference } from '@devryan/harness-runtime';
import { currentObjectiveUser, isNativeCompactionRecord } from '@devryan/harness-runtime/lib/objective-identity.js';
import { planError, readPlanRevision, writePlanRevision } from '../plans/revisions.js';
import { resolveSelectedPlanRevision, assertGlobalPlanProjectScope } from '../plans/selected-revision.js';
import { fingerprintCheckContent } from '../orchestration/required-check-observer.js';
import { resolveGen2OpenCodeClient } from './opencode-client-seam.js';

const identifier = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(value);
const PLAN_ACTION_PREFIXES = ['[devryan-plan-action:v1] ', '[openchamber-plan-action:v1] '];
// The saved plan version an Implement marker recorded, when well formed.
const planMarkerVersion = (record) => {
  const parts = Array.isArray(record?.parts) ? record.parts : [];
  const marker = parts.find(part => part.type === 'text' && PLAN_ACTION_PREFIXES.some(prefix => part.text?.startsWith(prefix)));
  if (!marker) return undefined;
  let version;
  try { version = JSON.parse(marker.text.slice(PLAN_ACTION_PREFIXES.find(prefix => marker.text.startsWith(prefix)).length)).version; }
  catch { /* A malformed marker records no version. */ }
  return typeof version === 'string' && /^[a-f0-9]{64}$/.test(version) ? version : undefined;
};
const fault = (code) => Object.assign(new Error(code), { code, statusCode: 503 });
const managedToolMethods = new Set(['submit', 'status', 'wait', 'wait_any', 'wait_result_action', 'cancel', 'read_result', 'acknowledge', 'set_auto_resume']);

export const createHarnessTaskContextHost = (options) => {
  const nativeWrites = new AsyncLocalStorage();
  const canonical = async (read) => {
    let client;
    try { client = resolveGen2OpenCodeClient(options.openCodeClient); } catch { throw fault('context_canonical_source_unavailable'); }
    try { return await read(client); } catch { throw fault('context_canonical_source_unavailable'); }
  };
  const readMessage = async ({ sessionID, directory, messageID }) => {
    if (!identifier(sessionID) || !identifier(messageID)) throw fault('context_invalid_identity');
    const data = await canonical((client) => client.sessions.message(sessionID, messageID, { directory, timeoutMs: 5000, maxResponseBytes: 8 * 1024 * 1024 }));
    if (data?.info?.id !== messageID || data.info.sessionID !== sessionID || !Array.isArray(data.parts)) throw fault('context_message_scope_mismatch');
    return data;
  };
  const readSession = async (sessionID, directory) => canonical((client) => client.sessions.get(sessionID, { directory, timeoutMs: 5000, maxResponseBytes: 8 * 1024 * 1024 }));
  const readProject = async (directory) => canonical((client) => client.catalog.project({ directory }, { timeoutMs: 5000 }));
  const readTodos = async (sessionID, directory) => canonical((client) => client.sessions.todo(sessionID, { directory, timeoutMs: 5000, maxResponseBytes: 8 * 1024 * 1024 }));
  const readCanonicalPlanIdentity = async ({ sessionID, sourceMessageID, directory, allowSelected = false }) => {
    if (!identifier(sessionID) || !identifier(sourceMessageID) || typeof directory !== 'string' || !path.isAbsolute(directory)) {
      throw planError(400, 'plan_identity_invalid');
    }
    const session = await readSession(sessionID, directory);
    if (session?.revert) throw planError(409, 'plan_source_stale');
    if (session?.id !== sessionID || session.time?.archived || !Number.isSafeInteger(session.time?.created)
      || session.time.created <= 0 || typeof session.slug !== 'string'
      || typeof session.projectID !== 'string' || !session.projectID
      || typeof session.directory !== 'string' || !path.isAbsolute(session.directory)) throw planError(404, 'plan_source_mismatch');
    const [project, message] = await Promise.all([readProject(directory),
      readMessage({ sessionID, directory, messageID: sourceMessageID })]);
    if (typeof project?.id !== 'string' || !project.id || project.id !== session.projectID
      || message.info.role !== 'assistant') throw planError(404, 'plan_source_mismatch');
    if (!options.isManaged?.()) {
      const canonical = async (value) => fs.realpath(value).catch(error => { if (error.code === 'ENOENT') return path.resolve(value); throw error; });
      const allowed = [session.directory, ...(project.id !== 'global' && project.worktree !== '/' ? [project.worktree] : []),
        ...(await options.getRegisteredProjects?.() ?? []).map(value => value.path)]
        .filter(value => typeof value === 'string' && path.isAbsolute(value));
      const target = await canonical(directory);
      if (!(await Promise.all(allowed.map(canonical))).includes(target)) throw planError(403, 'plan_project_mismatch');
    }
    await assertGlobalPlanProjectScope(project.id, directory, [session.directory]);
    const records = [], cursors = new Set(); let before, totalBytes = 0, nativeSequence = [];
    if (typeof options.readCanonicalPlanSequence === 'function') {
      // The requested directory may be the project root of a worktree session;
      // the native sequence is read where the session lives.
      const sequence = await options.readCanonicalPlanSequence({sessionID,directory:session.directory});
      if (!Array.isArray(sequence?.records)||sequence.records.length>2000||!Array.isArray(sequence.nativeSequence)
        ||sequence.nativeSequence.length>2000||Buffer.byteLength(JSON.stringify(sequence))>16*1024*1024)throw planError(503,'plan_source_unavailable');
      records.push(...sequence.records);nativeSequence=sequence.nativeSequence;
    } else do {
      const page = await canonical(client => client.sessions.messages(sessionID, { limit: 200, ...(before ? { before } : {}) },
        { directory, timeoutMs: 5000, maxResponseBytes: 8 * 1024 * 1024 }));
      if (!Array.isArray(page?.records) || page.records.length > 200) throw planError(503, 'plan_source_unavailable');
      totalBytes += Buffer.byteLength(JSON.stringify(page.records));
      if (records.length + page.records.length > 2000 || totalBytes > 8 * 1024 * 1024) throw planError(503, 'plan_source_unavailable');
      records.unshift(...page.records); before = page.cursor;
      if (before !== undefined && before !== null) {
        if (typeof before !== 'string' || !before || before.length > 8192 || cursors.has(before)) throw planError(503, 'plan_source_unavailable');
        cursors.add(before);
      }
    } while (before);
    const sourceIndex = records.findIndex(row => row.info.id === sourceMessageID);
    const nativeSourceIndex=nativeSequence.findIndex(row=>row.id===sourceMessageID);
    const nativeRoot=nativeSequence.slice(0,nativeSourceIndex).findLast(row=>row.type==='user');
    const root = nativeRoot ? records.find(row=>row.info.id===nativeRoot.id)
      : records.slice(0, sourceIndex).findLast(row => row.info.role === 'user' && row.parts.some(part => part.synthetic !== true));
    const objectiveID = root?.info.id ?? message.info.parentID;
    const receipts = await options.nativeStreamContinuationReceipts?.(sessionID, objectiveID) ?? [];
    const primary = await options.readPrimaryRecord(sessionID);
    const ownedObjectiveID = primary?.objectiveID ?? primary?.anchorID;
    if (identifier(ownedObjectiveID) && ownedObjectiveID !== objectiveID) {
      const owned = await options.nativeStreamContinuationReceipts?.(sessionID, ownedObjectiveID) ?? [];
      for (const receipt of owned) if (!receipts.some(existing => existing.eventID === receipt.eventID)) receipts.push(receipt);
    }
    const validated = validateCanonicalPlanSource({ sessionID, sourceMessageID, records, receipts, nativeSequence, allowSelected });
    if (validated.sourceIdentity.current) {
      if (typeof options.verifyPlanSourceSettled !== 'function') throw planError(503, 'plan_source_settlement_unavailable');
      await options.verifyPlanSourceSettled({ sessionID, directory: session.directory, sourceIdentity: validated.sourceIdentity, providerID: message.info.providerID });
    }
    // Compaction after the source replaces its text in the model's context.
    const compactedSinceSource = sourceIndex < 0 || records.slice(sourceIndex + 1).some(isNativeCompactionRecord);
    return { sessionCreated: session.time.created, sessionSlug: session.slug, ...validated, compactedSinceSource };
  };
  const resolvePlan = (plan, context) => resolveSelectedPlanRevision({ plan, context, readSession, readProject, options: { ...options, readCanonicalPlanIdentity } });
  // Read the current saved outline; Plan View and root-agent updates share it.
  const readPlanOutline = async ({ plan, context }) => {
    const { revision } = await resolvePlan(plan, context);
    const { content } = await readPlanRevision(revision, { fsApi: options.fsApi });
    const outline = content.split(/\r?\n/).filter((line) => /^\s{0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s)/.test(line)).join('\n');
    return { path: revision.path, outline: outline || null };
  };
  const readChildAssignment = async ({ sessionID, directory, maxBytes }) => {
    const result = await options.getManagedRuntime().handleRpc({ method: 'child_assignment', params: { childSessionId: sessionID, directory, maxBytes } });
    return typeof result?.text === 'string' && result.text ? result.text : null;
  };
  const readScope = async ({ sessionID, directory }) => {
    if (!identifier(sessionID) || typeof directory !== 'string' || !path.isAbsolute(directory)) throw fault('context_invalid_scope');
    const [session, project] = await Promise.all([readSession(sessionID, directory), readProject(directory)]);
    if (session?.directory !== directory || session.id !== sessionID || project?.id !== session.projectID) throw fault('context_project_scope_mismatch');
    const registered = project.id !== 'global' && typeof project.worktree === 'string' && path.isAbsolute(project.worktree) && project.worktree !== '/';
    return { session, projectDirectory: registered ? project.worktree : directory,
      projectIdentity: registered ? `${project.id}:${project.worktree}` : `directory:${directory}` };
  };
  const authorizePrivateRpc = async ({ method, params = {} }) => {
    // Background hooks and compaction are independent of model tool access.
    const modelContext = method === 'harness_context' && ['checkpoint', 'decisions', 'remember_decision'].includes(params.action);
    if (!managedToolMethods.has(method) && !modelContext) return;
    const sessionID = modelContext ? params.sessionID : params.rootSessionId;
    const context = await readScope({ sessionID, directory: params.directory });
    const primary = await options.readPrimaryRecord(sessionID);
    // Caller-supplied mode/agent never grants delegation or result controls.
    if (context.session.parentID || context.session.time?.archived || primary?.sessionID !== sessionID
      || primary.directory !== params.directory || typeof primary.agent !== 'string' || primary.agent.toLowerCase() !== 'orchestrator'
      || ['stopping', 'reconciling', 'recovery_reserved', 'recovering', 'superseded', 'cancelled', 'needs_attention'].includes(primary.state)
      || primary.recoveryID || primary.guardedIDs?.includes(currentObjectiveUser(primary))) {
      throw Object.assign(new Error('Managed task actions require the current root Orchestrator; Builder may only read or update its selected saved plan'),
        { code: 'managed_orchestrator_authority_required', statusCode: 403 });
    }
  };
  const readNativePlanPolicy = async (input, readNativeUserMessage) => {
    const context = await readScope(input);
    if (context.session.parentID) {
      let root = context.session, seen = new Set();
      while (root.parentID) {
        if (seen.has(root.id) || seen.size > 256) throw fault('native_plan_policy_unavailable');
        const parentID=root.parentID;
        seen.add(root.id); root = await readSession(parentID,input.directory);
        if (root?.id!==parentID || root.directory!==input.directory || root.projectID!==context.session.projectID) throw fault('context_project_scope_mismatch');
      }
      const state = await options.getManagedRuntime().handleRpc({ method: 'context_state', params: { rootSessionId: root.id, directory: input.directory } });
      if (!Array.isArray(state?.tasks)) throw fault('native_plan_policy_unavailable');
      const task = state.tasks.find(task => task.childSessionId === input.sessionID);
      // A verified child without retained assignment proof may inspect only.
      if (!task) return {readOnly:true};
      if (typeof task.readOnly !== 'boolean') throw fault('native_plan_policy_unavailable');
      const rootPolicy = await readNativePlanPolicy({ ...input, sessionID: root.id, directory: root.directory }, readNativeUserMessage);
      return { readOnly: task.readOnly || rootPolicy.readOnly };
    }
    const primary = await options.readPrimaryRecord(input.sessionID);
    if (primary?.sessionID !== input.sessionID || primary.directory !== input.directory) throw fault('native_plan_policy_unavailable');
    const objectiveID = primary.objectiveID ?? primary.anchorID;
    if (!identifier(objectiveID) || typeof readNativeUserMessage !== 'function') throw fault('native_plan_policy_unavailable');
    const raw = await readNativeUserMessage({ ...input, messageID: objectiveID });
    if (raw?.id !== objectiveID || raw.sessionID !== input.sessionID || raw.type !== 'user') throw fault('native_plan_policy_unavailable');
    const anchor = await readMessage({ ...input, messageID: objectiveID });
    const legacyRestriction = anchor.parts.some(part => part.type === 'text' && part.synthetic === true
      && part.text?.startsWith('User has requested to enter plan mode'));
    return { objectiveID, readOnly: primary.agent === 'plan' || raw.metadata?.devryan?.agent === 'plan'
      || raw.metadata?.devryan?.planMode === true || raw.metadata?.devryanPlanMode === true || raw.metadata?.openchamberPlanMode === true || legacyRestriction };
  };
  const authorizeNativeTaskInvocation = async (input) => {
    if (!identifier(input?.messageID) || !identifier(input?.callID)) {
      throw fault('native_task_identity_required');
    }
    const tool = input.tool ?? 'devryan_task';
    if (!['devryan_task', 'council_session'].includes(tool)) throw fault('native_task_identity_required');
    await authorizePrivateRpc({ method: 'submit', params: { rootSessionId: input.sessionID, directory: input.directory } });
    const primary = await options.readPrimaryRecord(input.sessionID);
    const objectiveID = primary?.objectiveID ?? primary?.anchorID;
    const [assistant, anchor] = await Promise.all([readMessage(input), readMessage({ ...input, messageID: objectiveID })]);
    if (primary?.stepID !== input.messageID || assistant.info.role !== 'assistant' || assistant.info.time?.completed
      || assistant.turnOwnership?.source !== 'native-sequence' || assistant.turnOwnership.userMessageID !== currentObjectiveUser(primary)
      || assistant.info.parentID !== currentObjectiveUser(primary) || anchor.info.role !== 'user'
      || !assistant.parts.some(part => part.type === 'tool' && part.tool === tool && part.callID === input.callID
        && part.state?.status === 'running')) throw fault('native_task_call_stale');
    if (typeof options.readOnlyInvocation !== 'function') throw fault('native_plan_policy_unavailable');
    const capturedReadOnly = await options.readOnlyInvocation(input);
    if (typeof capturedReadOnly !== 'boolean') throw fault('native_plan_policy_unavailable');
    return { objectiveID, readOnly: capturedReadOnly || anchor.info.metadata?.devryanPlanMode === true || anchor.info.metadata?.openchamberPlanMode === true
      || anchor.parts.some(part => part.type === 'text' && part.synthetic === true && part.text?.startsWith('User has requested to enter plan mode')) };
  };
  const authorizeNativeTodoInvocation = async (input) => {
    if (!identifier(input?.messageID) || !identifier(input?.callID)
      || !['todoread','todowrite'].includes(input.tool)) throw fault('native_todo_identity_required');
    const context=await readScope(input),primary=await options.readPrimaryRecord(input.sessionID);
    if(context.session.parentID||context.session.time?.archived||primary?.sessionID!==input.sessionID||primary.directory!==input.directory
      ||!['build','builder','orchestrator'].includes(primary.agent?.toLowerCase())
      ||['stopping','reconciling','recovery_reserved','recovering','superseded','cancelled','needs_attention'].includes(primary.state)
      ||primary.recoveryID||primary.guardedIDs?.includes(currentObjectiveUser(primary)))throw fault('native_todo_root_authority_required');
    const assistant=await readMessage(input);
    if(primary.stepID!==input.messageID||assistant.info.role!=='assistant'||assistant.info.time?.completed
      ||assistant.turnOwnership?.source!=='native-sequence'||assistant.turnOwnership.userMessageID!==currentObjectiveUser(primary)
      ||assistant.info.parentID!==currentObjectiveUser(primary)||!assistant.parts.some(part=>part.type==='tool'&&part.tool===input.tool
        &&part.callID===input.callID&&part.state?.status==='running'))throw fault('native_todo_call_stale');
  };
  const readPlanAuthority = async (input) => {
    const context = await readScope(input), primary = await options.readPrimaryRecord(input.sessionID);
    if (context.session.parentID || context.session.time?.archived || primary?.sessionID !== input.sessionID
      || primary.directory !== input.directory || typeof primary.agent !== 'string' || !['build', 'builder', 'orchestrator'].includes(primary.agent.toLowerCase())
      || !Number.isSafeInteger(primary.cancellationGeneration) || primary.cancellationGeneration < 0
      || ['stopping', 'reconciling', 'recovery_reserved', 'recovering', 'superseded', 'cancelled', 'needs_attention'].includes(primary.state)
      || primary.recoveryID || primary.guardedIDs?.includes(currentObjectiveUser(primary))) throw planError(403, 'plan_root_authority_required');
    const objectiveID = primary.objectiveID ?? primary.anchorID;
    const [anchor, assistant] = await Promise.all([readMessage({ ...input, messageID: objectiveID }), readMessage(input)]);
    if ((assistant.turnOwnership?.source !== 'native-sequence'
      || assistant.turnOwnership.userMessageID !== assistant.info.parentID)) throw planError(409, 'plan_call_stale');
    if (primary.stepID !== input.messageID || assistant.info.role !== 'assistant' || assistant.info.time?.completed
      || assistant.info.parentID !== currentObjectiveUser(primary) || !assistant.parts.some((part) => part.type === 'tool'
        && part.tool === 'devryan_task' && part.callID === input.callID && part.state?.status === 'running')) throw planError(409, 'plan_call_stale');
    const plan = planReference(anchor);
    if (!plan) throw planError(409, 'plan_selection_required', 'Select a saved plan with Implement before using plan tools');
    return { primary, objectiveID, currentUser: currentObjectiveUser(primary), plan, markerVersion: planMarkerVersion(anchor), ...await resolvePlan(plan, context) };
  };
  const handlePlanRpc = async (input, recheck, { maxBytes } = {}) => {
    const fit = value => {
      try { return assertManagedToolOutputSize(value, maxBytes); }
      catch (error) {
        if (error.code === 'managed_tool_output_metadata_too_large') throw planError(413, 'plan_tool_output_too_large', 'The saved plan exceeds this tool response budget. Open Plan View to read it or shorten it there before using plan_read.');
        throw error;
      }
    };
    try {
      if (!input || !['plan_read', 'plan_update'].includes(input.action) || !identifier(input.sessionID) || !identifier(input.messageID)
        || !identifier(input.callID) || Object.keys(input).some((key) => !['action', 'sessionID', 'directory', 'messageID', 'callID', 'expectedVersion', 'text'].includes(key))) {
        throw planError(400, 'plan_rpc_invalid');
      }
      const selected = await readPlanAuthority(input), generation = selected.primary.cancellationGeneration;
      const authorize = async () => {
        const current = await readPlanAuthority(input);
        if (current.primary.cancellationGeneration !== generation || current.objectiveID !== selected.objectiveID
          || current.currentUser !== selected.currentUser || current.ownerKey !== selected.ownerKey || current.revision.path !== selected.revision.path) {
          throw planError(409, 'plan_authority_changed');
        }
        await recheck?.();
      };
      if (input.action === 'plan_read') {
        const result = await readPlanRevision(selected.revision, { fsApi: options.fsApi });
        await authorize();
        // The plan this session wrote is still in its context: the Implement
        // marker, the saved file and the canonical source text share a version,
        // and no compaction followed the source. Anything else gets full text.
        if (selected.plan.sourceSessionId === input.sessionID && selected.markerVersion === result.version
          && selected.sourceContentVersion === result.version && selected.compactedSinceSource === false) {
          return fit({ unchanged: true, version: result.version, sourceMessageID: selected.sourceMessageID });
        }
        return fit({ ...result, sourceIdentity: selected.sourceIdentity });
      }
      fit({ path: selected.revision.path, saved: true, version: '0'.repeat(64), sourceIdentity: selected.sourceIdentity });
      const result = await writePlanRevision(selected.revision, { text: input.text, expectedVersion: input.expectedVersion, authorize, fsApi: options.fsApi });
      // The rename committed. Observer failure must not turn a saved receipt
      // into a refusal or invite a caller to repeat the mutation.
      try {
        options.recordDiagnostic?.({ type: 'lifecycle', event: 'session_plan_write', sessionID: input.sessionID,
          messageID: input.messageID, payload: { outcome: 'saved', callID: input.callID, version: result.version } });
        options.publishEvent?.({ type: 'session.plan.updated', properties: { sessionID: selected.source.id,
          sourceMessageID: selected.sourceMessageID, directory: selected.projectDirectory,
          sessionCreated: selected.source.time.created, sessionSlug: selected.source.slug, version: result.version } }, { directory: selected.projectDirectory });
      } catch { /* Canonical saved receipt remains authoritative. */ }
      return { ...result, sourceIdentity: selected.sourceIdentity };
    } catch (error) {
      options.recordDiagnostic?.({ type: 'lifecycle', event: 'session_plan_write', sessionID: identifier(input?.sessionID) ? input.sessionID : undefined,
        messageID: identifier(input?.messageID) ? input.messageID : undefined,
        payload: { outcome: 'refused', callID: identifier(input?.callID) ? input.callID : undefined, code: error.code } });
      throw error;
    }
  };
  const runtime = createTaskContextRuntime({ ...options,
    fingerprintFiles: fingerprintCheckContent, readMessage, readPlanOutline, readChildAssignment, readScope,
    async authorizeWrite(input) { await options.authorizeWrite?.(input); await nativeWrites.getStore()?.(); },
    async readTaskState(context) {
      const sessionID = context.session.id, directory = context.session.directory;
      const primary = await options.readPrimaryRecord(sessionID);
      // The continuation owner supplies the durable real-user identity. Missing
      // ownership is unknown; a synthetic latest message cannot invent it.
      if (!primary || primary.sessionID !== sessionID || primary.directory !== directory || !identifier(primary.anchorID)) throw fault('context_objective_owner_unavailable');
      // An explicit continuation keeps the objective it continued.
      const objectiveID = identifier(primary.objectiveID) ? primary.objectiveID : primary.anchorID;
      const [anchor, todos, managed] = await Promise.all([
        readMessage({ sessionID, directory, messageID: objectiveID }),
        readTodos(sessionID, directory),
        options.getManagedRuntime().handleRpc({ method: 'context_state', params: { rootSessionId: sessionID, directory } }),
      ]);
      if (!Array.isArray(todos)) throw fault('context_todos_unavailable');
      return { anchor, primary, todos, tasks: managed.tasks, envelopes: managed.envelopes };
    },
  });
  const planOperations = new Set();
  const trackPlan = (input, recheck, budget) => {
    const operation = handlePlanRpc(input, recheck, budget); planOperations.add(operation);
    void operation.finally(() => planOperations.delete(operation)).catch(() => {});
    return operation;
  };
  const handleContextRpc = async (input) => {
    // Compaction re-anchoring is always on (host kill switch only); it never
    // writes records or exposes model-visible checkpoint tools.
    if (input.action === 'compaction_anchor') {
      return options.compactionAnchorEnabled === false ? { available: false, reason: 'compaction_anchor_disabled' }
        : runtime.compactionAnchor(input);
    }
    const capabilities = await options.getManagedRuntime().handleRpc({ method: 'harness_capabilities' });
    if (capabilities.policies.contextProjection !== true) return { available: false, reason: 'harness_policy_disabled' };
    if (input.action === 'checkpoint') return runtime.checkpoint(input);
    if (input.action === 'remember_decision') return { decision: await runtime.rememberDecision(input) };
    if (input.action === 'decisions') return { decisions: await runtime.decisions(input) };
    throw fault('context_action_invalid');
  };
  const validatePlanImplementation = async (accepted) => {
    const parts = accepted.intent?.parts ?? accepted.request?.parts;
    if (!Array.isArray(parts)) return;
    const record = { info: { role: 'user' }, parts };
    const markerParts = parts.filter(part => part.type === 'text' && (part.text?.startsWith('[devryan-plan-action:v1] ') || part.text?.startsWith('[openchamber-plan-action:v1] ')));
    if (!markerParts.length) return;
    const observe = phase => { try { options.recordDiagnostic?.({ type: 'lifecycle', event: 'session_plan_implementation_validation',
      sessionID: accepted.sessionID, messageID: accepted.messageID, payload: { phase } }); } catch { /* Read authorization never depends on an observer. */ } };
    observe('started');
    const plan = planReference(record);
    if (!plan || plan.planIndex !== 0) throw planError(400, 'plan_selection_invalid');
    const directory = accepted.directory ?? (await readSession(accepted.sessionID)).directory;
    observe('session_read');
    const context = await readScope({ sessionID: accepted.sessionID, directory });
    observe('scope_read');
    const selected = await resolvePlan(plan, context);
    observe('selected_source_validated');
    const version = planMarkerVersion(record);
    if (version === undefined) throw planError(409, 'plan_saved_version_required');
    const saved = await readPlanRevision(selected.revision, { fsApi: options.fsApi });
    if (saved.version !== version) throw planError(409, 'plan_version_conflict');
    observe('saved_version_validated');
    await readCanonicalPlanIdentity({ sessionID: plan.sourceSessionId, sourceMessageID: plan.sourceMessageId,
      directory: selected.projectDirectory });
    observe('current_source_validated');
  };
  return { ...runtime, validatePlanImplementation, readNativePlanPolicy, authorizePrivateRpc, authorizeNativeTaskInvocation, authorizeNativeTodoInvocation, readCanonicalPlanIdentity,
    async authorizeNativePlanInvocation(input) {
      resolveGen2OpenCodeClient(options.openCodeClient);
      await readPlanAuthority(input);
    },
    handleNativePlanRpc(input, recheck, budget) {
      if (typeof recheck !== 'function') throw fault('native_task_authority_required');
      return trackPlan(input, recheck, budget);
    },
    handleNativeContextRpc(input, recheck) {
      if (typeof recheck !== 'function') throw fault('native_task_authority_required');
      return nativeWrites.run(recheck, () => handleContextRpc(input));
    },
    handlePlanRpc(input) {
      return trackPlan(input);
    },
    async drain() { while (planOperations.size) await Promise.allSettled([...planOperations]); await runtime.drain(); },
    handleRpc: handleContextRpc,
  };
};
