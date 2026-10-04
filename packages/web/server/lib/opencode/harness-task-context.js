import path from 'node:path';
import fs from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createTaskContextRuntime, planReference } from '@openchamber/harness-runtime';
import { currentObjectiveUser } from '@openchamber/harness-runtime/lib/objective-identity.js';
import { planError, readPlanRevision, writePlanRevision } from '../plans/revisions.js';
import { resolveSelectedPlanRevision, assertGlobalPlanProjectScope } from '../plans/selected-revision.js';
import { fingerprintCheckContent } from '../orchestration/required-check-observer.js';
import { resolveGen2OpenCodeClient } from './opencode-client-seam.js';

const identifier = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(value);
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
  const readCanonicalPlanIdentity = async ({ sessionID, sourceMessageID, directory }) => {
    if (!identifier(sessionID) || !identifier(sourceMessageID) || typeof directory !== 'string' || !path.isAbsolute(directory)) {
      throw planError(400, 'plan_identity_invalid');
    }
    const session = await readSession(sessionID, directory);
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
    return { sessionCreated: session.time.created, sessionSlug: session.slug };
  };
  const resolvePlan = (plan, context) => resolveSelectedPlanRevision({ plan, context, readSession, readProject, options });
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
    return { objectiveID, readOnly: anchor.info.metadata?.openchamberPlanMode === true };
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
    return { primary, objectiveID, currentUser: currentObjectiveUser(primary), ...await resolvePlan(plan, context) };
  };
  const handlePlanRpc = async (input, recheck) => {
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
        await authorize(); return result;
      }
      const result = await writePlanRevision(selected.revision, { text: input.text, expectedVersion: input.expectedVersion, authorize, fsApi: options.fsApi });
      options.recordDiagnostic?.({ type: 'lifecycle', event: 'session_plan_write', sessionID: input.sessionID,
        messageID: input.messageID, payload: { outcome: 'saved', callID: input.callID, version: result.version } });
      options.publishEvent?.({ type: 'session.plan.updated', properties: { sessionID: selected.source.id,
        sourceMessageID: selected.sourceMessageID, directory: selected.projectDirectory,
        sessionCreated: selected.source.time.created, sessionSlug: selected.source.slug, version: result.version } }, { directory: selected.projectDirectory });
      return result;
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
  const trackPlan = (input, recheck) => {
    const operation = handlePlanRpc(input, recheck); planOperations.add(operation);
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
  return { ...runtime, authorizePrivateRpc, authorizeNativeTaskInvocation, authorizeNativeTodoInvocation, readCanonicalPlanIdentity,
    async authorizeNativePlanInvocation(input) {
      resolveGen2OpenCodeClient(options.openCodeClient);
      await readPlanAuthority(input);
    },
    handleNativePlanRpc(input, recheck) {
      if (typeof recheck !== 'function') throw fault('native_task_authority_required');
      return trackPlan(input, recheck);
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
