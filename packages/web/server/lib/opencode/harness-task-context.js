import path from 'node:path';
import fs from 'node:fs/promises';
import { createTaskContextRuntime, planReference } from '@openchamber/harness-runtime';
import { currentObjectiveUser } from '@openchamber/harness-runtime/lib/objective-identity.js';
import { planError, readPlanRevision, writePlanRevision } from '../plans/revisions.js';
import { resolveSelectedPlanRevision, assertGlobalPlanProjectScope } from '../plans/selected-revision.js';
import { fingerprintCheckContent } from '../orchestration/required-check-observer.js';

const identifier = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(value);
const fault = (code) => Object.assign(new Error(code), { code, statusCode: 503 });
const managedToolMethods = new Set(['submit', 'status', 'wait', 'wait_any', 'wait_result_action', 'cancel', 'read_result', 'acknowledge', 'set_auto_resume']);

export const createHarnessTaskContextHost = (options) => {
  const request = async (pathname, directory) => {
    const url = new URL(options.buildOpenCodeUrl(pathname));
    url.searchParams.set('directory', directory);
    const response = await (options.fetchImpl ?? fetch)(url, { headers: options.getOpenCodeAuthHeaders?.() ?? {}, signal: AbortSignal.timeout(5000) });
    if (!response.ok || !response.body) throw fault('context_canonical_source_unavailable');
    const reader = response.body.getReader();
    const chunks = []; let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > 8 * 1024 * 1024) throw fault('context_canonical_source_too_large');
        chunks.push(value);
      }
      return { data: JSON.parse(Buffer.concat(chunks).toString('utf8')), next: response.headers.get('x-next-cursor') };
    } finally { await reader.cancel().catch(() => {}); }
  };
  const readMessage = async ({ sessionID, directory, messageID }) => {
    if (!identifier(sessionID) || !identifier(messageID)) throw fault('context_invalid_identity');
    const { data } = await request(`/session/${sessionID}/message/${messageID}`, directory);
    if (data?.info?.id !== messageID || data.info.sessionID !== sessionID || !Array.isArray(data.parts)) throw fault('context_message_scope_mismatch');
    return data;
  };
  const readSession = async (sessionID, directory) => (await request(`/session/${sessionID}`, directory)).data;
  const readProject = async (directory) => (await request('/project/current', directory)).data;
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
  const readPlanAuthority = async (input) => {
    const context = await readScope(input), primary = await options.readPrimaryRecord(input.sessionID);
    if (context.session.parentID || context.session.time?.archived || primary?.sessionID !== input.sessionID
      || primary.directory !== input.directory || typeof primary.agent !== 'string' || !['build', 'builder', 'orchestrator'].includes(primary.agent.toLowerCase())
      || !Number.isSafeInteger(primary.cancellationGeneration) || primary.cancellationGeneration < 0
      || ['stopping', 'reconciling', 'recovery_reserved', 'recovering', 'superseded', 'cancelled', 'needs_attention'].includes(primary.state)
      || primary.recoveryID || primary.guardedIDs?.includes(currentObjectiveUser(primary))) throw planError(403, 'plan_root_authority_required');
    const objectiveID = primary.objectiveID ?? primary.anchorID;
    const [anchor, assistant] = await Promise.all([readMessage({ ...input, messageID: objectiveID }), readMessage(input)]);
    if (primary.stepID !== input.messageID || assistant.info.role !== 'assistant' || assistant.info.time?.completed
      || assistant.info.parentID !== currentObjectiveUser(primary) || !assistant.parts.some((part) => part.type === 'tool'
        && part.tool === 'devryan_task' && part.callID === input.callID && part.state?.status === 'running')) throw planError(409, 'plan_call_stale');
    const plan = planReference(anchor);
    if (!plan) throw planError(409, 'plan_selection_required', 'Select a saved plan with Implement before using plan tools');
    return { primary, objectiveID, currentUser: currentObjectiveUser(primary), ...await resolvePlan(plan, context) };
  };
  const handlePlanRpc = async (input) => {
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
      };
      if (input.action === 'plan_read') return await readPlanRevision(selected.revision, { fsApi: options.fsApi });
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
    async readTaskState(context) {
      const sessionID = context.session.id, directory = context.session.directory;
      const primary = await options.readPrimaryRecord(sessionID);
      // The continuation owner supplies the durable real-user identity. Missing
      // ownership is unknown; a synthetic latest message cannot invent it.
      if (!primary || primary.sessionID !== sessionID || primary.directory !== directory || !identifier(primary.anchorID)) throw fault('context_objective_owner_unavailable');
      // An explicit continuation keeps the objective it continued.
      const objectiveID = identifier(primary.objectiveID) ? primary.objectiveID : primary.anchorID;
      const [anchor, { data: todos }, managed] = await Promise.all([
        readMessage({ sessionID, directory, messageID: objectiveID }),
        request(`/session/${sessionID}/todo`, directory),
        options.getManagedRuntime().handleRpc({ method: 'context_state', params: { rootSessionId: sessionID, directory } }),
      ]);
      if (!Array.isArray(todos)) throw fault('context_todos_unavailable');
      return { anchor, primary, todos, tasks: managed.tasks, envelopes: managed.envelopes };
    },
  });
  const planOperations = new Set();
  return { ...runtime, authorizePrivateRpc, readCanonicalPlanIdentity,
    handlePlanRpc(input) {
      const operation = handlePlanRpc(input); planOperations.add(operation);
      void operation.finally(() => planOperations.delete(operation)).catch(() => {});
      return operation;
    },
    async drain() { while (planOperations.size) await Promise.allSettled([...planOperations]); await runtime.drain(); },
    async handleRpc(input) {
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
  } };
};
