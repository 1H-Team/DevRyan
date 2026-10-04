import { nativeHelperInput,nativeHelperTitleInput } from './native-helper-contract.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { nativeWebOperation } from './native-web-operation.js';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import {recoveredInputHash} from './native-recovered-input-hash.js';
import {nativeShellCompletionFingerprint} from './native-shell-completion.js';
import {buildV2PromptContent} from '../v2/admission.js';

const record = (input) => input !== null && typeof input === 'object' && !Array.isArray(input);
const fail = (code, status = 409) => Object.assign(new Error(code), { code, status, statusCode: status });
const stable = (input) => JSON.stringify(input, (_key, value) => record(value)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) : value);
const digest = (input) => createHash('sha256').update(stable(input)).digest('hex');
const token = () => randomBytes(32).toString('hex');
const copy = (input) => structuredClone(input);
const PERMIT_MAX = 2048;
const COMMAND_SELECTION = new Set(['session.switchAgent', 'session.switchModel', 'session.setPermissions']);
const HEADER = 'x-devryan-native-permit';
const configuredModel = value => {
  if (typeof value !== 'string') return value;
  const slash = value.indexOf('/'), hash = value.indexOf('#');
  if (slash <= 0 || slash === value.length - 1) throw fail('native_command_selection_unreviewed', 403);
  return { providerID: value.slice(0, slash), model: value.slice(slash + 1, hash < 0 ? undefined : hash),
    ...(hash < 0 ? {} : { variant: value.slice(hash + 1) }) };
};
const validID = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,512}$/.test(value);
// These client operations read the canonical Store only. A retained external
// process grant rechecks them after its original prompt HTTP scope has closed.
// Other GET routes can start helpers or attach to PTYs and keep their context.
const canonicalStoreRead = spec => {
  if (spec.method !== 'GET' || spec.body !== undefined || typeof spec.path !== 'string') return false;
  const url = new URL(spec.path, 'http://127.0.0.1');
  if (url.origin !== 'http://127.0.0.1' || url.pathname + url.search !== spec.path) return false;
  const session = /^\/api\/session\/(ses_[a-zA-Z0-9_-]{1,508})$/.test(url.pathname);
  if (spec.operation === 'sessions.get') return session && !url.search;
  if (spec.operation !== 'sessions.message') return false;
  if (session || /^\/api\/session\/ses_[a-zA-Z0-9_-]{1,508}\/message\/msg_[a-zA-Z0-9_-]{1,508}$/.test(url.pathname)) return !url.search;
  if (!/^\/api\/session\/ses_[a-zA-Z0-9_-]{1,508}\/message$/.test(url.pathname)) return false;
  const query = [...url.searchParams];
  return query.length === 2 && new Set(query.map(([key]) => key)).size === 2
    && query.every(([key, value]) => key === 'limit' ? /^[1-9][0-9]{0,3}$/.test(value)
      : key === 'order' ? value === 'desc' : key === 'cursor' && value.length > 0 && value.length <= 8192);
};

/** Private web owner. Native holds and deferred wakes use the existing ledger. */
export function createNativeAdmissionOwner(options) {
  const { runtime, getSession, directory, authorizeOperation, onContinuation } = options;
  if (!runtime || typeof getSession !== 'function' || typeof authorizeOperation !== 'function') throw new TypeError('native admission owner dependencies required');
  const active = new Map(), retiredExecutions = new Map(), sessionBindings = new Map(), pendingShellWakes = new Map(), pendingExecutionWakes = new Map(), context = new AsyncLocalStorage();
  const ownerID = options.ownerID;
  if (typeof ownerID !== 'string' || !ownerID || ownerID.length > 256) throw new TypeError('stable native runtime bundle ownerID required');
  const reviewedConfiguration = copy(options.reviewedConfiguration ?? {});
  const reviewedBehaviors = copy(options.reviewedBehaviorCommands ?? []);
  const protectedRoots = options.protectedRoots ?? [];
  if (!Array.isArray(protectedRoots) || protectedRoots.some(root => typeof root !== 'string' || !path.isAbsolute(root))) throw new TypeError('absolute native protectedRoots required');
  let disposed = false;
  let controllerEpoch = 0;
  let controllerReplacement;
  const pendingContinuationAcks = new Set();
  const interviewGrants = new Map();
  const controllerContext = new AsyncLocalStorage();
  const managedDispatchContext = new AsyncLocalStorage();
  const primaryDispatchContext = new AsyncLocalStorage();
  const assertController = () => {
    if (disposed) throw fail('native_owner_stopped', 503);
    const captured = controllerContext.getStore();
    if (captured !== undefined && captured !== controllerEpoch) throw fail('native_permit_revoked');
  };
  const inController = async (action) => controllerContext.run(controllerContext.getStore() ?? controllerEpoch, async () => {
    assertController();
    if (controllerReplacement) throw fail('native_controller_replacing', 503);
    const result = await action(); assertController(); return result;
  });
  const remember = (entry) => {
    if(!entry.recoveredInputCancellation)entry.recoveredInputGrant??=options.assertRecoveredInputOperation?.(entry.request);
    assertController(); entry.controllerEpoch = controllerEpoch; active.set(entry.permit.token, entry);
  };
  const assertEntry = (entry) => {
    assertController();
    if (entry.controllerEpoch !== controllerEpoch || (active.get(entry.permit.token) !== entry
      && retiredExecutions.get(entry.permit.token) !== entry)) throw fail('native_permit_invalid', 403);
  };
  const clearController = () => { for(const grant of interviewGrants.values())grant.controller.abort(fail('native_permit_revoked'));interviewGrants.clear();controllerEpoch++; active.clear(); retiredExecutions.clear(); sessionBindings.clear(); pendingShellWakes.clear(); pendingExecutionWakes.clear(); };
  const acknowledgeContinuation = async (input) => {
    assertController();
    if (controllerReplacement) throw fail('native_controller_replacing', 503);
    // Admission and tracking happen synchronously. This span includes the
    // ledger queue, transaction and complete durable commit, not just its fn.
    const work = Promise.resolve().then(() => runtime.acknowledgeNativeContinuation(input));
    pendingContinuationAcks.add(work);
    try { return await work; }
    finally { pendingContinuationAcks.delete(work); }
  };
  const invalidateController = () => {
    assertController();
    if (controllerReplacement) return controllerReplacement;
    // Close admission before awaiting anything. Previously admitted ACKs may
    // finish; old operations arriving at ACK later must retain their intent.
    const work = Promise.allSettled([...pendingContinuationAcks]).then(() => {
      clearController();
    });
    controllerReplacement = work;
    // Observe both outcomes without creating a discarded rejecting promise.
    work.then(() => { if (controllerReplacement === work) controllerReplacement = undefined; },
      () => { if (controllerReplacement === work) controllerReplacement = undefined; });
    return work;
  };
  const canonical = async (sessionID) => {
    const seen = new Set();
    const lineage = [];
    let current = sessionID;
    while (current) {
      if (seen.has(current) || seen.size >= 256) throw fail('native_session_lineage_invalid');
      seen.add(current);
      const session = await getSession(current);
      assertController();
      if (!record(session) || session.id !== current || !path.isAbsolute(session.directory ?? '')) throw fail('native_session_identity_uncertain');
      lineage.push(session);
      current = session.parentID ?? null;
    }
    for (const session of lineage.toReversed()) {
      await runtime.registerNativeSession({ directory: session.directory, sessionID: session.id, parentID: session.parentID });
      assertController();
      sessionBindings.set(session.id, copy(session));
    }
    return lineage[0];
  };
  const boundCanonical = async (sessionID) => {
    // Native Store.claim is invoked inside Bus's SQLite commit transaction.
    // A recursive native HTTP read would await the transaction which itself
    // awaits this callback. Only previously captured canonical identities are
    // usable here; the operation still independently checks durable admission.
    const seen = new Set(), lineage = [];
    for (let current = sessionID; current;) {
      if (seen.has(current) || seen.size >= 256) throw fail('native_session_lineage_invalid');
      seen.add(current);
      const session = sessionBindings.get(current);
      if (!session) throw fail('native_session_binding_required');
      lineage.push(session); current = session.parentID ?? null;
    }
    for (const session of lineage.toReversed()) {
      await runtime.registerNativeSession({ directory: session.directory, sessionID: session.id, parentID: session.parentID });
      assertController();
    }
    return copy(lineage[0]);
  };
  const stateFor = async (sessionID) => {
    const session = await getSession(sessionID);
    assertController();
    if (!record(session) || session.id !== sessionID || !path.isAbsolute(session.directory ?? '')) throw fail('native_session_identity_uncertain');
    const state = await runtime.nativeAdmissionState({ directory: session.directory, sessionID });
    assertController(); return { session, state };
  };
  const removalRetry = async (directory,sessionID,state) => {
    const intent=(await runtime.nativeRemovals({directory})).find(item=>item.rootSessionID===sessionID && item.ownerID===ownerID);
    assertController();
    if(!intent || state.reverting || state.holds.some(hold=>hold.ownerID!==`native-removal:${intent.id}`
      && (hold.ownerID!==ownerID || hold.transactionID))) return undefined;
    return intent;
  };
  const verifyManagedDispatch = async (input) => {
    if (typeof options.verifyManagedTaskDispatch !== 'function') throw fail('native_managed_task_owner_unavailable', 503);
    const task = await options.verifyManagedTaskDispatch(copy(input));
    assertController();
    if (!record(task) || task.owner !== 'devryan' || task.taskId !== input.taskId || !input.leaseToken
      || task.leaseToken !== input.leaseToken || !['starting', 'running'].includes(task.status)
      || task.directory !== input.directory || !validID(task.rootSessionId) || !validID(task.dispatchCallId)) {
      throw fail('native_managed_task_lease_invalid', 403);
    }
    if (input.operation === 'create') {
      if (task.status !== 'starting' || task.childSessionId || task.rootSessionId !== input.parentID
        || task.dispatchCallId !== input.parentCallID) throw fail('native_managed_task_scope_invalid', 403);
    } else if (input.operation === 'prompt') {
      if (task.childSessionId !== input.sessionID || ['providerId', 'modelId', 'agent', 'variant'].some(key => task[key] !== input[key])) {
        throw fail('native_managed_task_scope_invalid', 403);
      }
    } else throw fail('native_managed_task_scope_invalid', 403);
    // A queued task lease is scheduler authority, not proof that its original
    // parent control call survived Revert. Compare against the existing ledger.
    const scope = { directory: input.directory, sessionID: task.rootSessionId, callID: task.dispatchCallId };
    const lease = await runtime.leaseForCall(scope);
    const captured = await runtime.capturedSessionState(scope);
    const state = await runtime.nativeAdmissionState(scope);
    assertController();
    if (!captured.captured || captured.pending || !Number.isSafeInteger(captured.generation)
      || !lease || lease.executionKind !== 'control' || lease.preparation !== 'none'
      || !['ready', 'published'].includes(lease.state) || lease.generation !== captured.generation
      || lease.directory !== input.directory || lease.scope.sessionID !== task.rootSessionId
      || lease.scope.callID !== task.dispatchCallId) throw fail('native_managed_task_control_invalid', 403);
    if (state.held || state.reverting) throw fail('native_session_held');
    // Stop/ownership loss may occur while the ledger reads await storage.
    const current = await options.verifyManagedTaskDispatch(copy(input));
    assertController();
    if (!record(current) || stable([current.owner, current.taskId, current.leaseToken, current.status, current.directory,
      current.rootSessionId, current.dispatchCallId, current.childSessionId, current.providerId, current.modelId, current.agent, current.variant])
      !== stable([task.owner, task.taskId, task.leaseToken, task.status, task.directory, task.rootSessionId, task.dispatchCallId,
        task.childSessionId, task.providerId, task.modelId, task.agent, task.variant])) throw fail('native_managed_task_lease_invalid', 403);
    return task;
  };
  const assertManagedRequest = async (entry, request) => {
    const input = entry.managedDispatch;
    await verifyManagedDispatch(input);
    assertEntry(entry);
    if (input.operation === 'create') {
      if (request.operation !== 'session.create' || request.sessionID !== input.parentID
        || !record(request.input) || request.input.parentID !== input.parentID
        || (request.input.location && request.input.location.directory !== input.directory)) throw fail('native_managed_task_scope_invalid', 403);
    } else {
      if (request.sessionID !== input.sessionID) throw fail('native_managed_task_scope_invalid', 403);
      if (request.operation === 'session.switchAgent' && request.input?.agent !== input.agent) throw fail('native_managed_task_scope_invalid', 403);
      if (request.operation === 'session.switchModel' && (request.input?.model?.providerID !== input.providerId
        || request.input?.model?.id !== input.modelId || (request.input?.model?.variant ?? null) !== input.variant)) throw fail('native_managed_task_scope_invalid', 403);
    }
  };
  const derivedWebEffect = (entry, request) => {
    const compact = entry.web.effects.find(effect => effect.operation === 'session.compact');
    if (compact && request.operation === 'inbox.compaction') {
      const actual = request.input;
      if (!record(actual) || actual.sessionID !== entry.permit.sessionID || !validID(actual.id)
        || stable(Object.keys(actual).sort()) !== stable(['delivery', 'id', 'sessionID'])
        || actual.delivery !== (compact.input.delivery ?? 'steer')
        || (compact.input.id !== undefined && actual.id !== compact.input.id)
        || (entry.compactionID && entry.compactionID !== actual.id)) throw fail('native_web_payload_changed', 403);
      entry.compactionID = actual.id;
      return true;
    }
    if (compact && request.operation === 'execution.wake' && entry.compactionID && request.input === undefined) return true;
    const command = entry.commandDerivation;
    if (!command) return false;
    if (request.operation === 'session.command.effect') {
      if (request.derivation !== command.token || stable(request.input) !== stable({ name: command.name, invocation: command.invocation })) {
        throw fail('native_command_derivation_required', 403);
      }
      return true;
    }
    if (['session.switchAgent', 'session.switchModel', 'session.prompt'].includes(request.operation)) {
      if (request.derivation !== command.token) throw fail('native_command_derivation_required', 403);
      if (request.operation === 'session.prompt') {
        const actual = request.input;
        const { text: _original, ...original } = command.invocation.prompt;
        if (!record(actual) || !validID(actual.id) || typeof actual.text !== 'string'
          || stable({ ...actual, id: undefined, text: undefined }) !== stable({ ...original, sessionID: entry.permit.sessionID, delivery: command.invocation.delivery })
          || (command.prompt && stable(command.prompt) !== stable(actual))) throw fail('native_web_payload_changed', 403);
        command.prompt ??= copy(actual);
        entry.messageID = actual.id;
      } else {
        const expected = request.operation === 'session.switchAgent'
          ? { sessionID: entry.permit.sessionID, agent: command.definition.agent }
          : { sessionID: entry.permit.sessionID, model: command.model };
        if ((request.operation === 'session.switchAgent' ? command.definition.agent : command.model) === undefined
          || stable(expected) !== stable(request.input)) throw fail('native_web_payload_changed', 403);
      }
      return true;
    }
    return !!command.prompt && ['session.prompt.seal', 'inbox.reconcile', 'inbox.admit', 'execution.wake'].includes(request.operation);
  };
  const beginCommand = (() => {
   const behaviors=reviewedBehaviors;
   return async ({ permit, sessionID, name, definition, invocation, model, origin }) => {
    const entry = entryFor(permit);
    const effect = entry.web?.effects.find(item => item.operation === 'session.command');
    if (!effect || sessionID !== entry.permit.sessionID || name !== effect.input.command || entry.commandDerivation) {
      throw fail('native_command_derivation_required', 403);
    }
    await assertRequest(entry, { operation: 'session.command', sessionID, input: effect.input });
    const configuration = options.getReviewedConfiguration ? options.getReviewedConfiguration(entry.directory) : reviewedConfiguration;
    const configured=configuration?.commands?.[name];
    const behavior=behaviors.find(value=>value.name===name&&stable(value.origin)===stable(origin));
    if(behavior&&configured!==undefined)throw fail('native_command_definition_unreviewed',403);
    const nativeConfigured=origin===undefined||origin.kind==='native'&&origin.id==='opencode.config.command';
    const reviewed=nativeConfigured?configured:behavior?.definition;
    if (!record(reviewed) || stable(definition) !== stable({ ...reviewed, ...(reviewed.model === undefined ? {} : { model: configuredModel(reviewed.model) }) }) || definition.subagent === true || definition.subtask === true) {
      throw fail('native_command_definition_unreviewed', 403);
    }
    const agent = definition.agent === undefined ? undefined : configuration?.agents?.[definition.agent];
    if (agent?.mode === 'subagent') throw fail('native_command_definition_unreviewed', 403);
    const selected = configuredModel(definition.model ?? agent?.model);
    const expectedModel = selected === undefined ? undefined : { providerID: selected.providerID, id: selected.model,
      ...(selected.variant === undefined ? {} : { variant: selected.variant }) };
    if (stable(model) !== stable(expectedModel)) throw fail('native_command_selection_unreviewed', 403);
    const expected = { sessionID, prompt: { text: effect.input.text, files: effect.input.files, agents: effect.input.agents,
      skills: effect.input.skills }, delivery: effect.input.delivery ?? 'steer' };
    if (stable(invocation) !== stable(expected)) throw fail('native_web_payload_changed', 403);
    assertEntry(entry);
    const derivation = token();
    entry.commandDerivation = { token: derivation, name, definition: copy(definition), invocation: copy(invocation), model: copy(model), origin: copy(origin) };
    return derivation;
   };
  })();
  const affectedRetention = (entry, candidate) => {
    if(candidate===entry||candidate.removal)return false;
    for(let id=candidate.permit.sessionID,seen=new Set();id;id=sessionBindings.get(id)?.parentID){
      if(entry.retention.members.some(row=>row.id===id))return true;
      if(seen.has(id))throw fail('native_session_lineage_invalid');seen.add(id);
    }
    return false;
  };
  const checkRetention = async entry => {
    assertEntry(entry);await entry.retention.authorize(entry.retention.members);assertEntry(entry);
    if([...active.values(),...retiredExecutions.values()].some(candidate=>affectedRetention(entry,candidate)))throw fail('native_retention_session_active');
    const state=await runtime.nativeAdmissionState({directory:entry.directory,sessionID:entry.permit.sessionID});assertEntry(entry);
    if(entry.retention.intentID){
      const intent=await runtime.nativeRemoval({directory:entry.directory,intentID:entry.retention.intentID});assertEntry(entry);
      if(!intent||!intent.quiet||intent.ownerID!==ownerID||intent.state==='completed')throw fail('native_retention_hold_changed');
    }else if(entry.retention.hold){
      const hold=entry.retention.hold;
      if(state.reverting||state.revision!==hold.revision||state.holds.length!==1||state.holds[0].id!==hold.id||state.holds[0].retentionInstanceID!==hold.retentionInstanceID)throw fail('native_retention_hold_changed');
    }else if(state.held||state.reverting||state.revision!==entry.permit.revision)throw fail('native_retention_session_active');
  };
  const assertRequest = async (entry, request) => {
    assertEntry(entry);
    if(entry.retention){
      if(request.sessionID!==entry.permit.sessionID||!['retention.acquire','retention.archive','session.remove'].includes(request.operation)
        ||request.operation==='retention.archive'&&(entry.retention.action!=='archive'||request.input?.at!==entry.retention.at)
        ||request.operation==='session.remove'&&entry.retention.action!=='delete')throw fail('native_retention_scope_invalid',403);
      await checkRetention(entry);return;
    }
    if(entry.helperTitle){
      const expected=entry.helperTitle;
      if(request.operation!=='session.rename'||request.sessionID!==expected.sessionID||stable(request.input)!==stable({sessionID:expected.sessionID,title:expected.title}))throw fail('native_helper_title_scope_invalid',403);
      await entry.reauthorize();assertEntry(entry);const session=await canonical(expected.sessionID),state=await runtime.nativeAdmissionState({directory:expected.directory,sessionID:expected.sessionID});
      if(session.directory!==expected.directory||!([expected.expectedTitle,expected.title].includes(session.title))||stable(session.model)!==stable(entry.helperSession.model)||session.agent!==entry.helperSession.agent||session.time?.archived||session.revert||state.held||state.reverting||state.revision!==entry.permit.revision)throw fail('native_helper_title_conflict',409);
      await entry.reauthorize();assertEntry(entry);return;
    }
    if (entry.helperText) {
      if (request.operation !== 'helper.generate' || request.sessionID !== entry.permit.sessionID
        || stable(request.input) !== stable(entry.helperText)) throw fail('native_helper_scope_invalid', 403);
      await entry.reauthorize(); assertEntry(entry);
      if (entry.helperText.sessionID) {
        const session = await canonical(entry.helperText.sessionID);
        const state = await runtime.nativeAdmissionState({directory:entry.directory,sessionID:session.id});
        if (session.directory !== entry.directory || stable(session.model)!==stable(entry.helperSession.model) || session.agent!==entry.helperSession.agent || session.time?.archived || session.revert || state.held || state.reverting
          || state.revision !== entry.permit.revision) throw fail('native_helper_scope_revoked', 403);
      }
      await entry.reauthorize(); assertEntry(entry); return;
    }
    options.assertRecoveredInputOperation?.(request,entry);
    if (request.operation === 'session.command.effect' && (!entry.web || !entry.commandDerivation)) throw fail('native_command_derivation_required', 403);
    if (entry.removal) {
      const intent = await runtime.nativeRemoval({ directory: entry.directory, intentID: entry.removal });
      assertEntry(entry);
      if (!intent || intent.ownerID !== ownerID || intent.state === 'completed'
        || request.sessionID !== entry.permit.sessionID
        || !['removal.inspect', 'removal.delete'].includes(request.operation)
        || (request.operation === 'removal.delete' && (intent.state !== 'committed' || request.input?.intentID !== intent.id))) {
        throw fail('native_removal_capability_required', 403);
      }
      const member = intent.members.find(item => item.id === request.sessionID);
      const captured = await runtime.capturedSessionState({ directory: entry.directory, sessionID: request.sessionID });
      const state = await runtime.nativeAdmissionState({ directory: entry.directory, sessionID: request.sessionID });
      if (!member || captured.pending || captured.generation !== member.generation
        || !state.holds.some(hold => hold.ownerID === `native-removal:${intent.id}`)) throw fail('native_removal_capability_required', 403);
      assertEntry(entry); return;
    }
    if (disposed || request.sessionID !== entry.permit.sessionID) throw fail('native_permit_invalid', 403);
    if(entry.webfetchSecondary&&request.operation!=='session.generate')throw fail('native_webfetch_secondary_scope_invalid',403);
    if(entry.interviewAction){
      const owned=entry.interviewAction,body=owned.body;
      let allowed=false;
      if(owned.kind==='rename')allowed=request.operation==='session.rename'&&stable(request.input)===stable(body);
      else if(owned.kind==='notify')allowed=request.operation==='session.synthetic'&&stable(request.input)===stable(body)
        ||['synthetic.seal','inbox.reconcile','inbox.admit'].includes(request.operation);
      else allowed=request.operation==='session.switchAgent'&&stable(request.input)===stable({sessionID:entry.permit.sessionID,agent:'orchestrator'})
        ||request.operation==='session.prompt'&&stable(request.input)===stable(body)
        ||['session.prompt.seal','inbox.reconcile','inbox.admit','execution.wake'].includes(request.operation);
      if(!allowed)throw fail('native_interview_operation_changed',403);
    }
    if (entry.primaryReconciliation && request.operation !== 'primary.continue') throw fail('native_permit_operation_mismatch', 403);
    if(entry.recoveredInputCancellation&&(!['recovered.input.cancel','inbox.cancel'].includes(request.operation)
      ||request.input?.id!==undefined&&request.input.id!==entry.messageID||request.input?.payloadHash!==undefined&&request.input.payloadHash!==entry.recoveredInputCancellation.payloadHash
      ||request.input?.enqueuedSeq!==undefined&&request.input.enqueuedSeq!==entry.recoveredInputCancellation.enqueuedSeq))throw fail('native_permit_operation_mismatch',403);
    if (entry.primaryDispatch?.kind!=='recovery' && entry.primaryDispatch && ['session.switchAgent','session.switchModel','session.setPermissions'].includes(request.operation)) {
      // A background continuation keeps the currently accepted selection and
      // permissions. A changed configuration needs a fresh user admission.
      throw fail('native_primary_continuation_selection_changed', 403);
    }
    if(entry.primaryDispatch?.kind==='recovery'){
      const prompt=entry.primaryDispatch.prompt,input=request.input;
      if(request.operation==='session.switchAgent'&&input?.agent!==prompt.agent
        ||request.operation==='session.switchModel'&&stable(input?.model)!==stable({providerID:prompt.model.providerID,id:prompt.model.modelID,variant:prompt.variant}))
        throw fail('native_primary_recovery_selection_changed',403);
      if(request.operation==='session.setPermissions'){
        const rules=input?.permissions,index=Array.isArray(rules)?rules.findLastIndex(rule=>rule.action==='*'&&rule.resource==='*'&&rule.effect==='deny'):-1;
        if(index<0||rules.slice(index+1).some(rule=>rule.effect!=='deny'&&!(rule.effect==='allow'&&rule.resource==='*'
          &&['read','glob','grep'].includes(rule.action)&&prompt.tools[rule.action]===true)))throw fail('native_primary_recovery_permissions_changed',403);
      }
    }
    if(request.operation==='queued.input.inspect'&&!(entry.accepted&&entry.accepted.request?.delivery==='queue'&&request.messageID===entry.messageID
      ||entry.commandSelection&&entry.commandSelectionDelivery==='queue'&&!entry.web&&request.messageID===undefined))throw fail('native_queued_admission_invalid',403);
    if (entry.commandSelection && request.operation!=='queued.input.inspect' && (!entry.web || !COMMAND_SELECTION.has(request.operation))) {
      throw fail(entry.web ? 'native_permit_operation_mismatch' : 'native_web_authorization_required', 403);
    }
    if (entry.managedDispatch) await assertManagedRequest(entry, request);
    if (options.captureWebAuthorization && (entry.accepted || entry.managedDispatch || entry.commandSelection) && !entry.web
      && ['session.create','session.prompt','session.switchAgent','session.switchModel','session.setPermissions'].includes(request.operation)) {
      throw fail('native_web_authorization_required', 403);
    }
    if (entry.web) {
      const exact = entry.web.effects.find(effect => effect.operation === request.operation);
      if (exact) {
        const actual = record(request.input) ? { ...request.input } : request.input;
        if (['permission.reply', 'form.reply', 'form.cancel'].includes(request.operation)) {
          if (actual?.pending?.sessionID !== entry.permit.sessionID) throw fail('native_permit_lineage_mismatch', 403);
          delete actual.pending;
        }
        if (stable(actual) !== stable(exact.input)) throw fail('native_web_payload_changed', 403);
      } else if (!derivedWebEffect(entry, request) && (!entry.accepted || !['session.prompt.seal', 'inbox.reconcile', 'inbox.admit', 'execution.wake'].includes(request.operation))) {
        throw fail('native_permit_operation_mismatch', 403);
      }
    }
    if (entry.reauthorize) { await entry.reauthorize(); assertEntry(entry); }
    if (entry.deferredExecutionWake && !['execution.deferred.wake', 'execution.wake'].includes(request.operation)) {
      throw fail('native_permit_operation_mismatch', 403);
    }
    if (entry.revert) {
      await validateRevert(entry.revert, request);
      assertEntry(entry);
      if (entry.reauthorize) { await entry.reauthorize(); assertEntry(entry); }
      return;
    }
    if (entry.permit.sessionID) {
      const { session, state } = entry.recoveredInputGrant||entry.recoveredInputCancellation
        ? {session:await boundCanonical(entry.permit.sessionID),state:await runtime.nativeAdmissionState({directory:entry.directory,sessionID:entry.permit.sessionID})}
        : await stateFor(entry.permit.sessionID);
      assertEntry(entry);
      const retry=request.operation==='session.remove' && entry.removalRetry
        ? await removalRetry(entry.directory,entry.permit.sessionID,state):undefined;
      if (session.directory !== entry.directory || (state.held && !retry) || state.revision !== entry.permit.revision) throw fail('native_permit_revoked');
    }
    if (request.messageID && entry.messageID && request.messageID !== entry.messageID) throw fail('native_permit_lineage_mismatch', 403);
    if (request.operation === 'tool.execute') {
      if (entry.request.operation !== 'tool.execute' || !record(request.input) || !record(entry.request.input)
        || request.input.toolID !== entry.request.input.toolID || request.input.nativeToolID !== entry.request.input.nativeToolID
        || request.input.callID !== entry.request.input.callID
        || stable(request.input.provenance) !== stable(entry.request.input.provenance)
        || Object.hasOwn(request.input, 'input') !== Object.hasOwn(entry.request.input, 'input')
        || stable(request.input.input) !== stable(entry.request.input.input)) throw fail('native_permit_lineage_mismatch', 403);
    }
    if (entry.accepted && !['session.prompt', 'session.switchAgent', 'session.switchModel', 'session.setPermissions',
      'session.prompt.seal', 'inbox.reconcile', 'inbox.admit', 'execution.wake','queued.input.inspect'].includes(request.operation)) throw fail('native_permit_operation_mismatch', 403);
    if (entry.shellCompletion && !['session.synthetic', 'synthetic.seal', 'inbox.reconcile', 'inbox.admit'].includes(request.operation)) throw fail('native_permit_operation_mismatch', 403);
    if (entry.shellContinuation && request.operation !== 'shell.continue') throw fail('native_permit_operation_mismatch', 403);
    if (entry.shellAck && request.operation !== 'job.shell.ack') throw fail('native_permit_operation_mismatch', 403);
    // Canonical and ledger reads can outlive the original caller's grant.
    if (entry.reauthorize) { await entry.reauthorize(); assertEntry(entry); }
  };
  const entryFor = (permit) => {
    const entry = record(permit) && active.get(permit.token);
    if (!entry || stable(entry.permit) !== stable(permit)) throw fail('native_permit_invalid', 403);
    assertEntry(entry);
    return entry;
  };
  const issue = async (request, accepted) => {
    if (disposed) throw fail('native_owner_stopped', 503);
    const recoveredInputGrant=options.assertRecoveredInputOperation?.(request);
    if (active.size >= PERMIT_MAX) throw fail('native_permit_capacity', 503);
    let session, state = { revision: 0, held: false };
    if (request.sessionID) {
      session = await (request.operation === 'store.claim' ? boundCanonical(request.sessionID) : canonical(request.sessionID));
      state = await runtime.nativeAdmissionState({ directory: session.directory, sessionID: session.id });
      if (state.held) throw fail('native_session_held');
    }
    let reauthorize;
    const primaryDispatch = primaryDispatchContext.getStore();
    if (accepted && primaryDispatch) {
      reauthorize = primaryDispatch.recheck;
      await reauthorize();
    } else if (accepted && !managedDispatchContext.getStore() && options.captureWebAuthorization) {
      reauthorize = await options.captureWebAuthorization({ operation: 'admission.prompt', sessionID: request.sessionID, directory: session.directory }, session);
      if (typeof reauthorize !== 'function') throw fail('native_web_authorization_required', 403);
      await reauthorize();
    } else if (!accepted) {
      reauthorize = () => authorizeOperation(copy(request), session);
      await reauthorize();
    }
    assertController();
    const permit = Object.freeze({ token: token(), ...(request.sessionID ? { sessionID: request.sessionID } : {}), revision: state.revision });
    const entry = { permit, request: copy(request), directory: session?.directory ?? directory,
      accepted: accepted && copy(accepted), messageID: accepted?.messageID ?? request.messageID,
      fingerprint: accepted?.fingerprint, metadata: accepted?.metadata && copy(accepted.metadata), reauthorize,recoveredInputGrant };
    if (request.operation === 'session.prompt' && !accepted) {
      if (!record(request.input) || typeof request.input.id !== 'string') throw fail('native_prompt_identity_required', 403);
      entry.messageID = request.input.id;
      const { metadata: _ignored, ...input } = request.input;
      entry.fingerprint = digest({ generation: 2, sessionID: request.sessionID, messageID: entry.messageID, operation: 'prompt', input });
      entry.metadata = { devryan: { v: 1, origin: 'native', planMode: false, parts: [{ kind: 'text', length: String(input.text ?? '').length }], admission: { v: 1, fingerprint: entry.fingerprint } } };
    }
    remember(entry);
    return permit;
  };
  const authorize = async (request) => {
    if (!record(request) || typeof request.operation !== 'string') throw fail('native_operation_invalid', 403);
    const { parentAuthorization: _untrusted, ...clean } = request;
    request = clean;
    if(request.operation==='queued.input.inspect'){
      const entry=request.existingPermit&&entryFor(request.existingPermit);
      if(!entry)throw fail('native_queued_admission_invalid',403);
      await assertRequest(entry,request);return entry.permit;
    }
    if(request.operation.startsWith('retention.')){
      const entry=request.existingPermit&&entryFor(request.existingPermit);
      if(!entry?.retention)throw fail('native_retention_capability_required',403);
      await assertRequest(entry,request);return entry.permit;
    }
    if (['removal.inspect', 'removal.delete'].includes(request.operation)) {
      const entry = request.existingPermit && entryFor(request.existingPermit);
      if (!entry?.removal) throw fail('native_removal_capability_required', 403);
      await assertRequest(entry, request); return entry.permit;
    }
    if (request.operation === 'execution.deferred.wake') {
      const entry = request.existingPermit && entryFor(request.existingPermit);
      if (!entry?.deferredExecutionWake) throw fail('native_deferred_wake_capability_required', 403);
      await assertRequest(entry, request); return entry.permit;
    }
    if (request.operation === 'primary.continue') {
      const entry = request.existingPermit && entryFor(request.existingPermit);
      if (!entry?.primaryReconciliation) throw fail('native_primary_continuation_capability_required', 403);
      await assertRequest(entry, request); return entry.permit;
    }
    if(request.operation==='recovered.input.cancel'){
      const entry=request.existingPermit&&entryFor(request.existingPermit);
      if(!entry?.recoveredInputCancellation)throw fail('native_recovered_input_capability_required',403);
      await assertRequest(entry,request);return entry.permit;
    }
    if (request.operation === 'primary.step') {
      const parent = request.existingPermit && entryFor(request.existingPermit);
      if (!parent || parent.request.operation !== 'runner.drain' || parent.permit.sessionID !== request.sessionID) throw fail('native_primary_step_capability_required', 403);
    }
    if (request.operation === 'shell.continue') {
      const entry = request.existingPermit && entryFor(request.existingPermit);
      if (!entry?.shellContinuation) throw fail('native_completion_capability_required', 403);
      await assertRequest(entry, request); return entry.permit;
    }
    if (request.operation.startsWith('job.shell.')) return authorizeShellJob(request);
    if (request.operation === 'session.synthetic') {
      const inherited = request.existingPermit && active.get(request.existingPermit.token);
      if (inherited?.shellCompletion||inherited?.interviewAction?.kind==='notify') { await assertRequest(inherited, request); return inherited.permit; }
      return authorizeShellCompletion(request);
    }
    if (['session.revert.stage', 'session.revert.clear', 'session.revert.commit'].includes(request.operation)) {
      if (!request.existingPermit || !entryFor(request.existingPermit).revert) throw fail('native_revert_capability_required', 403);
    }
    // The SDK removes descendants / sweeps all child claims across multiple
    // SQLite effects. They cannot currently share the ledger's atomic hold
    // barrier, so ordinary policy grants must not advertise these operations.
    if (['session.remove', 'restart.resume', 'store.releaseChildClaims'].includes(request.operation)) throw fail('native_owned_lifecycle_required', 403);
    if (['runner.drain', 'store.claim', 'execution.resume'].includes(request.operation)) {
      // Native scope-owned runner fibers outlive the admitting HTTP request.
      // These starts obtain independent canonical admission and never borrow
      // an expired request capability (especially a tool capability).
      const { existingPermit: _detached, ...independent } = request;
      return issue(independent);
    }
    if (request.existingPermit) {
      const entry = entryFor(request.existingPermit);
      if (entry.permit.sessionID === request.sessionID && request.operation !== 'tool.execute'
        && !['runner.drain', 'store.claim', 'execution.resume'].includes(request.operation)) {
        await assertRequest(entry, request);
        if (!entry.web && !entry.accepted && !entry.revert && !entry.shellCompletion && !entry.managedDispatch && !entry.deferredExecutionWake && !entry.interviewAction) await authorizeOperation({ ...copy(request), parentAuthorization: copy(entry.request) },
          request.sessionID ? (await stateFor(request.sessionID)).session : undefined);
        assertEntry(entry);
        return entry.permit;
      }
    }
    return issue(request);
  };
  const recheck = async (permit, request) => assertRequest(entryFor(permit), request);
  const sealPrompt = async (permit, event) => {
    const entry = entryFor(permit);
    await assertRequest(entry, { operation: 'session.prompt.seal', sessionID: event?.sessionID, messageID: event?.messageID });
    if (!record(event?.prompt) || typeof event.prompt.text !== 'string') throw fail('native_prompt_hook_invalid', 403);
    if (!entry.messageID) entry.messageID = event.messageID;
    if (entry.messageID !== event.messageID) throw fail('native_permit_lineage_mismatch', 403);
    for (const file of event.prompt.files ?? []) {
      if (!record(file) || typeof file.uri !== 'string') throw fail('native_prompt_attachment_invalid', 403);
      if (file.uri.startsWith('data:')) continue;
      const uri = new URL(file.uri);
      if (uri.protocol !== 'file:' || !entry.directory) throw fail('native_prompt_attachment_denied', 403);
      const lexical = fileURLToPath(uri);
      if (lexical.split(/[\\/]/).some(segment => segment.toLowerCase() === '.git')) throw fail('native_prompt_attachment_denied', 403);
      const base = await fs.realpath(entry.directory), target = await fs.realpath(lexical);
      if (target.split(/[\\/]/).some(segment => segment.toLowerCase() === '.git')) throw fail('native_prompt_attachment_denied', 403);
      for (const root of protectedRoots) {
        const canonicalRoot = await fs.realpath(root).catch(cause => { if (cause.code === 'ENOENT') return path.resolve(root); throw cause; });
        if ([path.resolve(root), canonicalRoot].some(value => [lexical, target].some(candidate => candidate === value || candidate.startsWith(`${value}${path.sep}`)))) {
          throw fail('native_prompt_attachment_denied', 403);
        }
      }
      const relative = path.relative(base, target);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw fail('native_prompt_attachment_denied', 403);
    }
    assertEntry(entry);
    entry.fingerprint ??= digest({ generation: 2, sessionID: event.sessionID, messageID: event.messageID, operation: entry.request.operation, prompt: event.prompt, delivery: event.delivery });
    const metadata = copy(entry.metadata ?? { devryan: { v: 1, origin: 'native', planMode: false, parts: [{ kind: 'text', length: entry.commandDerivation?.prompt?.text.length ?? event.prompt.text.length }], admission: { v: 1, fingerprint: entry.fingerprint } } });
    const original = entry.commandDerivation?.prompt?.text ?? entry.accepted?.request?.text ?? entry.request.input?.text ?? event.prompt.text;
    if (event.prompt.text !== original) {
      const offset = event.prompt.text.indexOf(original);
      if (!original || offset < 0 || event.prompt.text.indexOf(original, offset + 1) !== -1) throw fail('native_prompt_hook_identity_changed', 403);
      metadata.devryan.parts = [ ...(offset ? [{ kind: 'synthetic', length: offset }] : []), ...metadata.devryan.parts,
        ...(offset + original.length < event.prompt.text.length ? [{ kind: 'synthetic', length: event.prompt.text.length - offset - original.length }] : []) ];
    }
    // Only the private native command derivation can create this durable proof.
    // Public prompt metadata is replaced above; native metadata stays internal.
    if (entry.commandDerivation) {
      const command = entry.commandDerivation;
      const session=await canonical(event.sessionID);assertEntry(entry);
      if(!session.agent||!session.model)throw fail('native_command_selection_unreviewed',403);
      Object.assign(metadata.devryan,{agent:session.agent,providerID:session.model.providerID,modelID:session.model.id,variant:session.model.variant??'default'});
      metadata.devryan.command = { v: 1, ownerID, sessionID: event.sessionID, messageID: event.messageID,
        name: command.name, origin: copy(command.origin), definitionDigest: digest(command.definition),
        argumentsDigest: digest(command.invocation.prompt.text ?? ''), fingerprint: entry.fingerprint };
    }
    entry.metadata = metadata;
    entry.finalText = event.prompt.text;
    return copy(metadata);
  };
  const commandPromptReceipt = async (entry, item) => {
    const command = entry.commandDerivation;
    if (!command?.prompt || item.id !== command.prompt.id || item.sessionID !== entry.permit.sessionID) {
      throw fail('native_command_derivation_required', 403);
    }
    const session = await canonical(item.sessionID);
    await assertRequest(entry, { operation: 'inbox.admit', sessionID: item.sessionID, messageID: item.id });
    const model = session.model;
    if (session.directory !== entry.directory || ![session.agent, model?.providerID, model?.id].every(value => typeof value === 'string' && value.length > 0 && value.length <= 256)
      || model.variant !== undefined && (typeof model.variant !== 'string' || !model.variant || model.variant.length > 256)
      || command.definition.agent !== undefined && command.definition.agent !== session.agent
      || command.model !== undefined && stable({ ...command.model, variant: command.model.variant ?? 'default' })
        !== stable({ providerID: model.providerID, id: model.id, variant: model.variant ?? 'default' })) {
      throw fail('native_command_selection_unreviewed', 403);
    }
    const execution = { agent: session.agent, providerID: model.providerID, modelID: model.id, variant: model.variant ?? 'default' };
    return { sessionID: item.sessionID, messageID: item.id, directory: session.directory,
      ...(session.parentID ? { parentID: session.parentID } : {}), execution,
      body: { messageID: item.id, agent: execution.agent, model: { providerID: execution.providerID, modelID: execution.modelID },
        variant: execution.variant, parts: [{ type: 'text', text: command.prompt.text }] } };
  };
  const uncertainCommandPrompt = async entry => {
    if (!entry.commandReceipt || entry.commandAdmissionUncertain||entry.queuedAdmission&&!entry.queuedAdmission.work) return;
    entry.commandAdmissionUncertain = true;
    await entry.commandAdmission.uncertain(copy(entry.commandReceipt));
  };
  const admitCommandPrompt = async (entry, item, phase) => {
    if (!entry.commandDerivation || !entry.commandAdmission || !['preflight', 'committed'].includes(phase)) return;
    const receipt = await commandPromptReceipt(entry, item);
    if (entry.commandReceipt && stable(entry.commandReceipt) !== stable(receipt)) throw fail('native_command_selection_changed', 403);
    if(item.delivery==='queue'&&!receipt.parentID){
      if(!entry.queuedAdmission){
        if(phase!=='preflight')throw fail('native_queued_admission_unverified');
        entry.commandReceipt=copy(receipt);
        const primaryGuard=await options.captureQueuedPrimaryAdmission?.(item.sessionID);assertEntry(entry);
        entry.queuedAdmission={primaryGuard,admit:authorizeWrite=>entry.commandAdmission.admit(copy(receipt),authorizeWrite)};
      }
      if(phase==='preflight')entry.queuedAdmission.itemHash=recoveredInputHash({type:item.type,delivery:item.delivery,payload:item.payload});
      if(phase==='committed'&&!entry.queuedAdmission.committed)throw fail('native_queued_admission_unverified');
      return;
    }
    if (!entry.commandAdmissionWork) {
      if (phase !== 'preflight') throw fail('native_command_admission_required', 403);
      entry.commandReceipt = copy(receipt);
      const authorizeWrite = () => assertRequest(entry, { operation: 'inbox.admit', sessionID: item.sessionID, messageID: item.id });
      // Reserve before InboxEnqueued, while the native inbox mutex excludes an
      // already-running runner's promotion. No native SQLite transaction is open.
      entry.commandAdmissionWork = Promise.resolve().then(async () => {
        await authorizeWrite();
        await entry.commandAdmission.admit(copy(receipt), authorizeWrite);
        await authorizeWrite();
      });
    }
    try { await entry.commandAdmissionWork; }
    catch (cause) { await uncertainCommandPrompt(entry); throw cause; }
    await assertRequest(entry, { operation: 'inbox.admit', sessionID: item.sessionID, messageID: item.id });
  };
  const observeAcceptedUser = async (entry, item) => {
    if (typeof options.observeAcceptedUser !== 'function') return;
    if (!entry.acceptedObservation) entry.acceptedObservation = Promise.resolve().then(async () => {
      const request = { operation: 'inbox.admit', sessionID: item.sessionID, messageID: item.id };
      await assertRequest(entry, request);
      try {
        const command = entry.commandDerivation;
        const body = command ? command.definition : entry.accepted?.intent;
        const selected = command && body?.model !== undefined ? configuredModel(body.model) : body?.model;
        const variantPresent = command ? record(selected) && Object.hasOwn(selected, 'variant') : record(body) && Object.hasOwn(body, 'variant');
        const variant = command ? selected?.variant : body?.variant;
        if (variantPresent && variant !== null && typeof variant !== 'string') throw fail('native_accepted_observation_invalid', 403);
        const modelID = command ? selected?.model : selected?.modelID;
        const intent = { source: command ? 'command-definition' : 'prompt',
          ...(typeof body?.agent === 'string' ? { agent: body.agent } : {}),
          ...(typeof selected?.providerID === 'string' && typeof modelID === 'string' ? { model: { providerID: selected.providerID, modelID } } : {}),
          variantPresent: !!variantPresent, ...(variantPresent ? { variant } : {}) };
        const session = await canonical(item.sessionID);
        const model = session.model;
        const execution = [session.agent, model?.providerID, model?.id].every(value => typeof value === 'string' && value)
          ? { agent: session.agent, providerID: model.providerID, modelID: model.id, variant: model.variant ?? 'default' } : undefined;
        await options.observeAcceptedUser({ sessionID: item.sessionID, messageID: item.id, directory: entry.directory,
          fingerprint: entry.fingerprint, intent, ...(execution ? { execution } : {}) });
      } catch {
        // Evidence construction/sinks cannot change the accepted decision.
        // Authority checks remain outside this catch and must still succeed.
        try {
          await options.observeAcceptedUserGap?.({ code: 'native_observation_gap', phase: 'accepted',
            sessionID: item.sessionID, messageID: item.id, directory: entry.directory });
        } catch { /* A failed gap sink is missing evidence, not an admission refusal. */ }
      }
      await assertRequest(entry, request);
    });
    await entry.acceptedObservation;
  };
  const verifyAccepted = async (permit, value) => {
    const entry = entryFor(permit);
    const wrapped = value?.phase ? value.item : value;
    const item = record(wrapped?.item) ? { ...wrapped.item, id: wrapped.id, sessionID: wrapped.sessionID } : wrapped;
    const id = item?.id;
    const payload = item?.payload ?? item;
    await assertRequest(entry, { operation: 'inbox.admit', sessionID: item?.sessionID, ...(id ? { messageID: id } : {}) });
    if (item?.type === 'user') {
      if (!entry.fingerprint || payload?.metadata?.devryan?.admission?.fingerprint !== entry.fingerprint) throw fail('opencode_admission_identity_uncertain');
      if (entry.finalText !== undefined && payload.text !== entry.finalText) throw fail('native_prompt_payload_changed', 403);
      if (entry.metadata && stable(payload.metadata) !== stable(entry.metadata)) throw fail('native_prompt_metadata_unsealed', 403);
      if(value?.phase==='preflight'&&item.delivery==='queue'&&entry.queuedAdmission)entry.queuedAdmission.itemHash=recoveredInputHash({type:item.type,delivery:item.delivery,payload});
      await admitCommandPrompt(entry, item, value?.phase);
      if(value?.phase==='committed' && entry.primaryDispatch?.kind==='recovery') {
        await options.bindNativeRecoveryDispatchInput?.({sessionID:item.sessionID,messageID:item.id,
          itemHash:recoveredInputHash({type:item.type,delivery:item.delivery,payload})});
        assertEntry(entry);
      }
      if (value?.phase === 'committed') await observeAcceptedUser(entry, item);
    } else if (item?.type === 'synthetic') {
      if(entry.interviewAction?.kind==='notify'){
        if(payload.text!==entry.interviewAction.body.text||payload.description!==undefined||stable(payload.metadata)!==stable(entry.metadata))throw fail('native_interview_operation_changed',403);
        return;
      }
      if (!entry.shellCompletion || payload.text !== entry.shellCompletion.text || payload.description !== entry.shellCompletion.description
        || stable(payload.metadata) !== stable(entry.metadata)) throw fail('native_completion_capability_required', 403);
      if(value?.phase==='preflight') {
        await runtime.bindNativeShellNotification({directory:entry.directory,sessionID:entry.permit.sessionID,jobID:entry.shellCompletion.jobID,notificationID:entry.messageID,
          itemHash:recoveredInputHash({type:item.type,delivery:item.delivery,payload}),itemDelivery:item.delivery});assertEntry(entry);
      }
      if (value?.phase === 'committed') {
        await runtime.acknowledgeNativeShellCompletion({ directory: entry.directory, sessionID: entry.permit.sessionID,
          jobID: entry.shellCompletion.jobID, notificationID: entry.messageID });
        assertEntry(entry);
        await continueShell(entry);
      }
    } else throw fail('native_admission_item_unavailable', 403);
  };
  const hold = async (sessionID) => {
    const run = async () => { const session = await canonical(sessionID); await runtime.holdNativeAdmission({ directory: session.directory, sessionID, ownerID }); };
    if (typeof options.withSessionLock !== 'function') throw fail('native_session_owner_unavailable', 503);
    const inherited = context.getStore(), entry = inherited && active.get(inherited.token);
    return entry?.accepted && entry.permit.sessionID === sessionID ? run() : options.withSessionLock(sessionID, run);
  };
  const continueDeferredExecution = async (sessionID) => {
    const pending = pendingExecutionWakes.get(sessionID);
    if (pending) return pending;
    if (pendingExecutionWakes.size >= PERMIT_MAX) throw fail('native_permit_capacity', 503);
    // Coordinator/recovery work cannot borrow the prompt/tool context which
    // first encountered the hold. Capture canonical lineage again before the
    // independent runner can enter Store.claim's SQLite callback.
    const work = context.run(undefined, async () => {
      const session = await canonical(sessionID);
      const state = await runtime.nativeAdmissionState({ directory: session.directory, sessionID });
      assertController();
      if (state.held || state.reverting) throw fail('native_session_held');
      if (!(await runtime.nativeContinuations({ directory: session.directory, sessionID })).includes('execution.wake')) return;
      assertController();
      if (typeof onContinuation !== 'function') throw fail('native_continuation_owner_unavailable', 503);
      if (active.size >= PERMIT_MAX) throw fail('native_permit_capacity', 503);
      const permit = Object.freeze({ token: token(), sessionID, revision: state.revision });
      const entry = { permit, request: { operation: 'execution.deferred.wake', sessionID },
        directory: session.directory, deferredExecutionWake: true };
      remember(entry);
      try {
        const result = await context.run(permit, () => onContinuation({ directory: session.directory,
          sessionID, operation: 'execution.wake', permit }));
        assertController();
        if (!record(result) || !['registered', 'idle'].includes(result.kind)
          || result.operation !== 'execution.wake' || result.sessionID !== sessionID) {
          throw fail('native_continuation_wake_unverified', 403);
        }
        await assertRequest(entry, { operation: 'execution.wake', sessionID });
        // Registered means independent runner admission, not a queued fork;
        // idle means the native inbox and runner proved there is no work. The
        // ledger compares the revision atomically with this acknowledgement.
        await acknowledgeContinuation({ directory: session.directory, sessionID,
          operation: 'execution.wake', expectedRevision: permit.revision });
        assertController();
      } finally { active.delete(permit.token); }
    });
    pendingExecutionWakes.set(sessionID, work);
    try { return await work; }
    finally { if (pendingExecutionWakes.get(sessionID) === work) pendingExecutionWakes.delete(sessionID); }
  };
  const releaseHold = async (sessionID, transactionID) => {
    const { session, state } = await stateFor(sessionID);
    const own = state.holds.find((entry) => entry.sessionID === sessionID && entry.ownerID === ownerID);
    if (own) {
      if (own.transactionID !== transactionID) throw fail('native_hold_transaction_mismatch');
      // Revision compare is local to this row, rather than the ancestor sum.
      const latest = await runtime.holdNativeAdmission({ directory: session.directory, sessionID, ownerID });
      await runtime.releaseNativeAdmission({ directory: session.directory, sessionID, ownerID, holdID: own.id, expectedRevision: latest.revision });
    }
    if ((await stateFor(sessionID)).state.held) return;
    const pending = await runtime.nativeContinuations({ directory: session.directory, sessionID });
    for (const operation of pending) {
      if (typeof onContinuation !== 'function') throw fail('native_continuation_owner_unavailable', 503);
      if (operation.startsWith('shell.complete:')) {
        const jobID = operation.slice('shell.complete:'.length);
        const lease = await runtime.nativeShellJob({ directory: session.directory, sessionID, jobID });
        if (lease.nativeShellJob.deliveredID) {
          await continueShell({ permit: { sessionID }, directory: session.directory, messageID: lease.nativeShellJob.deliveredID,
            shellCompletion: { lease, jobID } });
        } else await onContinuation({ directory: session.directory, sessionID, operation: 'shell.recover', jobID });
      } else if (operation === 'execution.wake') await continueDeferredExecution(sessionID);
      else throw fail('native_continuation_operation_unavailable', 503);
    }
  };
  const validateRevert = async (input, request) => {
    const session = await getSession(input.sessionID);
    if (!record(session) || session.id !== input.sessionID || session.directory !== input.directory) throw fail('native_permit_lineage_mismatch', 403);
    const tx = await runtime.transaction({ directory: input.directory, transactionID: input.transactionID });
    if (!tx || tx.kind === 'files' || tx.state !== 'prepared' || !['conversation', 'restoring'].includes(tx.phase)
      || !tx.members.includes(input.sessionID)) throw fail('native_revert_capability_invalid', 403);
    const target = tx.targets.find((item) => item.id === input.sessionID), boundary = tx.boundaries?.find((item) => item.id === input.sessionID);
    const stage = tx.phase === 'conversation' ? !tx.redo : Boolean(boundary?.revert);
    const messageID = tx.phase === 'conversation' ? target?.targetMessageID : boundary?.revert?.messageID;
    const partID = tx.phase === 'restoring' ? boundary?.revert?.partID : undefined;
    if (!target || !boundary || input.operation !== (stage ? 'session.revert.stage' : 'session.revert.clear')
      || (stage && (input.messageID !== messageID || input.partID !== partID || input.files !== false))
      || request.operation !== input.operation || request.sessionID !== input.sessionID
      || (stage && (!record(request.input) || request.input.messageID !== messageID || request.input.partID !== partID || request.input.files !== false))) {
      throw fail('native_revert_capability_invalid', 403);
    }
    const state = await runtime.nativeAdmissionState({ directory: input.directory, sessionID: input.sessionID });
    assertController();
    if (!state.reverting || state.holds.some((item) => item.ownerID !== ownerID || item.transactionID !== tx.id)) throw fail('native_revert_capability_invalid', 403);
  };
  const releaseTransactionHolds = async (input) => {
    const tx = await runtime.transaction(input);
    if (!tx || !['committed', 'cancelled'].includes(tx.state) || !Array.isArray(input.sessions)
      || stable([...input.sessions].sort()) !== stable([...tx.members].sort())) throw fail('native_revert_release_invalid', 403);
    for (const sessionID of tx.members) {
      const session = await getSession(sessionID);
      if (!record(session) || session.directory !== input.directory) throw fail('native_session_identity_uncertain');
      await releaseHold(sessionID, tx.id);
    }
  };
  const authorizeShellJob = async (request) => {
    if (request.operation === 'job.shell.ack') {
      const input = request.input;
      const session = await canonical(request.sessionID), state = await runtime.nativeAdmissionState({ directory: session.directory, sessionID: session.id });
      const lease = await runtime.nativeShellJob({ directory: session.directory, sessionID: session.id, jobID: input?.jobID });
      assertController();
      if (state.held || lease.nativeShellJob?.deliveredID !== input?.notificationID) throw fail('native_completion_capability_required', 403);
      if (active.size >= PERMIT_MAX) throw fail('native_permit_capacity', 503);
      const permit = Object.freeze({ token: token(), sessionID: session.id, revision: state.revision });
      remember({ permit, request: copy(request), directory: session.directory, shellAck: true });
      return permit;
    }
    const entry = request.existingPermit && entryFor(request.existingPermit);
    if (!entry || entry.request.operation !== 'tool.execute' || entry.request.input?.toolID !== 'shell'
      || entry.request.input?.provenance?.kind !== 'native' || entry.request.input?.provenance?.id !== 'opencode.tool.shell') throw fail('native_shell_job_capability_required', 403);
    await assertRequest(entry, { ...entry.request, sessionID: request.sessionID });
    const input = request.input;
    if (!record(input) || typeof input.jobID !== 'string') throw fail('native_shell_job_capability_required', 403);
    const lease = await runtime.nativeShellJob({ directory: entry.directory, sessionID: request.sessionID, jobID: input.jobID });
    assertEntry(entry);
    if (lease.scope.messageID !== entry.messageID || lease.scope.callID !== entry.request.input.callID) throw fail('native_shell_job_capability_required', 403);
    if (request.operation === 'job.shell.start') {
      if (input.type !== 'shell' || input.command !== lease.nativeShellJob.command || input.recovery?.kind !== 'shell'
        || input.recovery.sessionID !== request.sessionID || input.recovery.shellID !== input.jobID
        || input.recovery.command !== lease.nativeShellJob.command) throw fail('native_shell_job_capability_required', 403);
    } else if (request.operation === 'job.shell.background.commit') {
      if (typeof input.notificationID !== 'string') throw fail('native_shell_job_capability_required', 403);
      await runtime.bindNativeShellNotification({ directory: entry.directory, sessionID: request.sessionID,
        jobID: input.jobID, notificationID: input.notificationID });
      assertEntry(entry);
    } else if (request.operation !== 'job.shell.background') throw fail('native_shell_job_capability_required', 403);
    return entry.permit;
  };
  const authorizeShellCompletion = async (request) => {
    const input = request.input, native = input?.nativeJob;
    if (!record(input) || !record(native) || native.type !== 'shell' || native.status === 'running'
      || !['completed', 'error', 'cancelled'].includes(native.status) || native.id !== input.metadata?.jobID
      || native.id !== input.metadata?.shellID || native.notificationID !== input.id || typeof input.id !== 'string') throw fail('native_completion_owner_required', 403);
    if (typeof options.getShellJobReceipt !== 'function') throw fail('native_completion_owner_unavailable', 503);
    const session = await canonical(request.sessionID), state = await runtime.nativeAdmissionState({ directory: session.directory, sessionID: session.id });
    const proof = await options.getShellJobReceipt({ directory: session.directory, sessionID: session.id, jobID: native.id });
    assertController();
    const lease = proof?.lease, receipt = proof?.receipt;
    if (!lease || lease.scope.sessionID !== session.id || lease.nativeShellJob?.jobID !== native.id
      || lease.nativeShellJob?.notificationID !== input.id || lease.nativeShellJob.command !== native.title
      || !['published', 'cancelled'].includes(lease.state) || receipt?.terminated !== true || receipt.confined !== true
      || input.description !== native.title) throw fail('native_completion_receipt_invalid', 403);
    const text = `<shell id="${native.id}" state="${native.status}" command="${native.title}">\n${native.status === 'completed' ? native.output ?? 'Command completed' : native.status === 'error' ? native.error ?? 'Command failed' : 'Cancelled'}\n</shell>`;
    if (input.text !== text) throw fail('native_completion_payload_changed', 403);
    if (state.held) {
      await runtime.deferNativeContinuation({ directory: session.directory, sessionID: session.id, operation: `shell.complete:${native.id}` });
      throw fail('native_session_held');
    }
    if (disposed || active.size >= PERMIT_MAX) throw fail('native_permit_capacity', 503);
    const permit = Object.freeze({ token: token(), sessionID: session.id, revision: state.revision });
    const metadata = { source: 'shell', jobID: native.id, shellID: native.id, state: native.status,
      exit: receipt.exitCode, devryan: { v: 1, origin: 'native_shell', planMode: false,
        admission: { v: 1, fingerprint: nativeShellCompletionFingerprint({sessionID:session.id,messageID:input.id,token:lease.token,text}) } } };
    remember({ permit, request: copy(request), directory: session.directory,
      messageID: input.id, metadata, shellCompletion: { jobID: native.id, text, description: native.title, lease } });
    return permit;
  };
  const continueShell = async (entry) => {
    const { lease, jobID } = entry.shellCompletion, sessionID = entry.permit.sessionID;
    // Replacement clears cached lineage. Capture it before wake can enter
    // Store.claim's SQLite callback, where a native HTTP reread would deadlock.
    const session = await canonical(sessionID);
    if (session.directory !== entry.directory) throw fail('native_session_directory_mismatch', 403);
    const operation = `shell.complete:${jobID}`;
    const latest = await runtime.nativeShellJob({ directory: entry.directory, sessionID, jobID });
    assertController();
    if (latest.nativeShellJob.continuedID === entry.messageID && latest.nativeShellJob.continuedAssistantID) {
      const state = await runtime.nativeAdmissionState({ directory: entry.directory, sessionID });
      assertController();
      await acknowledgeContinuation({ directory: entry.directory, sessionID, operation,
        userMessageID: entry.messageID, assistantMessageID: latest.nativeShellJob.continuedAssistantID, expectedRevision: state.revision });
      return;
    }
    await runtime.deferNativeContinuation({ directory: entry.directory, sessionID, operation });
    const state = await runtime.nativeAdmissionState({ directory: entry.directory, sessionID });
    assertController();
    if (state.held || typeof onContinuation !== 'function') return;
    const wakeKey = `${sessionID}\0${jobID}`;
    if (pendingShellWakes.get(wakeKey) === state.revision) return;
    if (typeof options.getShellJobReceipt !== 'function') throw fail('native_completion_owner_unavailable', 503);
    const proof = await options.getShellJobReceipt({ directory: entry.directory, sessionID, jobID });
    assertController();
    if (proof?.lease?.token !== latest.token || proof.lease.nativeShellJob?.deliveredID !== entry.messageID
      || !['published', 'cancelled'].includes(proof.lease.state) || proof.receipt?.terminated !== true
      || proof.receipt.confined !== true) throw fail('native_completion_receipt_invalid', 403);
    if (active.size >= PERMIT_MAX) throw fail('native_permit_capacity', 503);
    if (!pendingShellWakes.has(wakeKey) && pendingShellWakes.size >= PERMIT_MAX) throw fail('native_permit_capacity', 503);
    const run=async reauthorize=>{
    const permit = Object.freeze({ token: token(), sessionID, revision: state.revision });
    remember({ permit, request: { operation: 'shell.continue', sessionID }, directory: entry.directory,
      shellContinuation: { jobID, messageID: entry.messageID },reauthorize });
    pendingShellWakes.set(wakeKey, state.revision);
    try {
      const observation = await context.run(permit, () => onContinuation({ directory: entry.directory, sessionID, operation: 'shell.complete', jobID,
        messageID: entry.messageID, userMessageID: lease.scope.userMessageID, assistantMessageID: lease.scope.messageID,
        callID: lease.scope.callID, permit }));
      assertController();
      // wake registers work; only an actual canonical Step.Started may retire
      // this durable intent. The native Job pending marker can disappear now.
      if (observation?.kind === 'consumed') {
        if (observation.messageID !== entry.messageID) throw fail('native_continuation_started_proof_required', 403);
        await acknowledgeStartedContinuation({ sessionID, userMessageID: entry.messageID, assistantMessageID: observation.assistantMessageID });
      } else if (observation?.kind === 'blocked') pendingShellWakes.delete(wakeKey);
    } catch (error) {
      pendingShellWakes.delete(wakeKey);
      throw error;
    } finally { active.delete(permit.token); }
    };
    const authorize=async()=>{
      const current=await options.getShellJobReceipt({directory:entry.directory,sessionID,jobID});
      const admission=await runtime.nativeAdmissionState({directory:entry.directory,sessionID});
      if(current?.lease?.token!==proof.lease.token||current.lease.nativeShellJob?.deliveredID!==entry.messageID
        ||current.lease.nativeShellJob.itemHash!==proof.lease.nativeShellJob.itemHash||current.lease.nativeShellJob.itemDelivery!==proof.lease.nativeShellJob.itemDelivery
        ||current.receipt?.terminated!==true||current.receipt.confined!==true||admission.held||admission.reverting)throw fail('native_completion_receipt_invalid',403);
    };
    return options.withRecoveredShellGrant?options.withRecoveredShellGrant({directory:entry.directory,sessionID,messageID:entry.messageID,shellReceipt:{token:proof.lease.token,jobID,command:proof.lease.nativeShellJob.command,exitCode:proof.receipt.exitCode,itemHash:proof.lease.nativeShellJob.itemHash,itemDelivery:proof.lease.nativeShellJob.itemDelivery}},authorize,run):run(undefined);
  };
  const acknowledgeStartedContinuation = async (input) => {
    if (disposed) throw fail('native_owner_stopped', 503);
    const ids = input.consumedUserMessageIDs ?? [input.userMessageID];
    if (![input.sessionID, input.userMessageID, input.assistantMessageID].every(validID)
      || !Array.isArray(ids) || ids.length > 10_000 || ids.at(-1) !== input.userMessageID
      || !ids.every(validID) || new Set(ids).size !== ids.length) throw fail('native_continuation_started_proof_required', 403);
    const { session, state } = await stateFor(input.sessionID);
    if (state.held || state.reverting) throw fail('native_session_held');
    const pending = await runtime.nativeContinuations({ directory: session.directory, sessionID: session.id });
    // ponytail: Last-only Step evidence leaves earlier co-consumed notices in
    // per-step receipt scans until startup raw-sequence reconciliation. Upgrade
    // with a trusted native consumed-ID batch; REST folds these synthetic IDs.
    for (const operation of pending.filter(operation => operation.startsWith('shell.complete:'))) {
      if (typeof options.getShellJobReceipt !== 'function') throw fail('native_completion_owner_unavailable', 503);
      const jobID = operation.slice('shell.complete:'.length);
      const { lease, receipt } = await options.getShellJobReceipt({ directory: session.directory, sessionID: session.id, jobID });
      assertController();
      const notificationID = lease?.nativeShellJob?.deliveredID;
      if (!ids.includes(notificationID)) continue;
      if (lease.scope?.sessionID !== session.id || lease.directory !== session.directory
        || lease.nativeShellJob.jobID !== jobID || lease.nativeShellJob.notificationID !== notificationID
        || !['published', 'cancelled'].includes(lease.state) || receipt?.terminated !== true || receipt.confined !== true) throw fail('native_completion_receipt_invalid', 403);
      const latest = await runtime.nativeAdmissionState({ directory: session.directory, sessionID: session.id });
      assertController();
      if (latest.held || latest.reverting || latest.revision !== state.revision) throw fail('native_permit_revoked');
      await acknowledgeContinuation({ directory: session.directory, sessionID: session.id, operation,
        userMessageID: notificationID, assistantMessageID: input.assistantMessageID, expectedRevision: state.revision });
      pendingShellWakes.delete(`${session.id}\0${jobID}`);
    }
  };
  const registerShellJob = async (input) => {
    await recheckExecution(input);
    if (input.tool !== 'shell' || typeof options.bindShellJob !== 'function') throw fail('native_shell_job_owner_unavailable', 503);
    const lease = await options.bindShellJob(copy(input));
    if (!lease || lease.nativeShellJob?.jobID !== input.jobID || lease.nativeShellJob.command !== input.command
      || lease.scope.sessionID !== input.sessionID || lease.scope.messageID !== input.messageID || lease.scope.callID !== input.callID) throw fail('native_shell_job_binding_invalid', 403);
    entryFor(input.permit).shellLease = lease;
  };
  const sealSynthetic = async (permit, input) => {
    const entry = entryFor(permit);
    await assertRequest(entry, { operation: 'synthetic.seal', sessionID: input?.sessionID, messageID: input?.id });
    if(entry.interviewAction?.kind==='notify'){
      if(stable(input)!==stable(entry.interviewAction.body))throw fail('native_interview_operation_changed',403);return copy(entry.metadata);
    }
    if (!entry.shellCompletion || input.text !== entry.shellCompletion.text || input.description !== entry.shellCompletion.description) throw fail('native_completion_capability_required', 403);
    return copy(entry.metadata);
  };
  const recheckExecution = async (input) => {
    if (!record(input.authorization)) throw fail('native_execution_authorization_required', 403);
    const retired = input.phase === 'publication' ? retiredExecutions.get(input.permit?.token) : undefined;
    const entry = retired ?? entryFor(input.permit), authorized = input.authorization;
    if (retired && (stable(retired.permit) !== stable(input.permit) || input.token !== retired.shellLease?.token)) throw fail('native_permit_invalid', 403);
    await assertRequest(entry, authorized);
    if (!record(authorized.input) || input.sessionID !== authorized.sessionID || input.messageID !== authorized.messageID
      || input.callID !== authorized.input.callID || input.tool !== (authorized.input.nativeToolID ?? authorized.input.toolID)
      || input.directory !== entry.directory || (Object.hasOwn(input, 'input') && stable(input.input) !== stable(authorized.input.input))) {
      throw fail('native_execution_lineage_mismatch', 403);
    }
    if (retired) retiredExecutions.delete(input.permit.token);
    if (input.phase === 'publication') entry.publicationStarted = true;
  };
  const acquireRetention = async ({permit,members})=>{
    const entry=entryFor(permit);
    if(!entry.retention||!Array.isArray(members)||members.length>512||stable(members.map(({id,parentID,directory})=>({id,parentID,directory})).sort((a,b)=>a.id.localeCompare(b.id)))!==stable(entry.retention.members.map(({id,parentID,directory})=>({id,parentID:parentID??null,directory})).sort((a,b)=>a.id.localeCompare(b.id))))throw fail('native_retention_tree_changed');
    // Called under the original inbox locks and native SQLite transaction.
    // Only captured identity and existing Node owners may be consulted here.
    await entry.retention.authorize(members);assertEntry(entry);await checkRetention(entry);
    const hold=await runtime.holdNativeAdmission({directory:entry.directory,sessionID:permit.sessionID,ownerID,retentionInstanceID:options.getInstanceID?.()??token()});
    entry.retention.hold=hold;entry.retention.members=copy(members);assertEntry(entry);await checkRetention(entry);return {held:true};
  };
  // A queued objective is written only after the original native enqueue commit.
  // Snapshot restores the exact HTTP principal/prompt context on reverse RPC.
  const queuedAdmissionEntry = input => [...active.values()].find(entry=>(entry.accepted||entry.commandDerivation)&&entry.queuedAdmission
    &&input.item?.type==='user'&&input.item.delivery==='queue'&&entry.directory===input.directory&&entry.permit.sessionID===input.sessionID&&entry.messageID===input.messageID
    &&entry.queuedAdmission.itemHash===recoveredInputHash(input.item)
    &&stable(entry.metadata)===stable(input.item?.payload?.metadata)&&(entry.accepted?.request?.delivery??entry.commandDerivation?.invocation.delivery)==='queue'
    &&(entry.finalText??entry.accepted?.request.text??entry.commandDerivation?.prompt?.text)===input.item?.payload?.text);
  const commitQueuedAdmission = async input => {
    const entry=queuedAdmissionEntry(input);
    if(!entry)throw fail('native_queued_admission_unverified');
    if(entry.reauthorize)await entry.reauthorize();assertEntry(entry);
    const authorizeWrite=async()=>{if(entry.reauthorize)await entry.reauthorize();assertEntry(entry);const state=await runtime.nativeAdmissionState({directory:entry.directory,sessionID:entry.permit.sessionID});assertEntry(entry);if(state.held||state.revision!==entry.permit.revision)throw fail('native_permit_revoked');if(entry.reauthorize)await entry.reauthorize();assertEntry(entry);await entry.queuedAdmission.primaryGuard?.();assertEntry(entry);};
    entry.queuedAdmission.work??=Promise.resolve().then(()=>entry.queuedAdmission.admit(authorizeWrite));
    try{await entry.queuedAdmission.work;if(entry.reauthorize)await entry.reauthorize();assertEntry(entry);entry.queuedAdmission.committed=true;}
    catch(error){entry.queuedAdmission.failed=true;throw error;}
  };
  const assertQueuedRecord = async input => {
    // Delivery supplies the original transaction-local selection. A public
    // same-ID reconciliation may read canonical state outside the inbox lock.
    const session=input.execution?undefined:await canonical(input.sessionID);assertController();
    const directory=input.directory??session?.directory;
    const execution=input.execution??(session?.model&&{agent:session.agent,providerID:session.model.providerID,modelID:session.model.id,variant:session.model.variant??'default'});
    const current=await options.readQueuedPrimaryRecord?.(input.sessionID);assertController();
    const metadata=input.item?.payload?.metadata?.devryan;
    if(!current||current.anchorID!==input.messageID||!metadata||!execution
      ||current.executionGeneration!==2||current.directory!==directory||!['observing','recovering','recovery_reserved'].includes(current.state)
      ||current.providerID!==metadata.providerID||current.modelID!==metadata.modelID||current.agent!==metadata.agent
      ||metadata.variant!==undefined&&(current.variant??'default')!==(metadata.variant??'default')
      ||current.providerID!==execution.providerID||current.modelID!==execution.modelID||current.agent!==execution.agent
      ||(current.variant??'default')!==execution.variant)throw fail('native_queued_input_retained');
  };
  const methods = {
    queuedAdmissionRejected:({permit,messageID})=>{
      const entry=entryFor(permit);
      if(!entry.queuedAdmission||entry.messageID!==messageID)throw fail('native_queued_admission_unverified');
      entry.queuedAdmission.rejected=true;return null;
    },
    queuedAdmissionCommitted:commitQueuedAdmission,
    queuedDeliveryAuthorized:async input=>{
      const entry=queuedAdmissionEntry(input);
      if(entry){await commitQueuedAdmission(input);assertEntry(entry);if(entry.queuedAdmission.failed||!entry.queuedAdmission.committed)throw fail('native_queued_admission_unverified');await assertQueuedRecord(input);assertEntry(entry);return null;}
      if([...active.values()].some(row=>row.queuedAdmission&&row.permit.sessionID===input.sessionID&&row.messageID===input.messageID))throw fail('native_queued_admission_unverified');
      await assertQueuedRecord(input);
      return null;
    },
    queuedBlocked:async({permit,sessionID})=>{
      const entry=entryFor(permit);if(entry.permit.sessionID!==sessionID)throw fail('native_permit_lineage_mismatch',403);
      await runtime.deferNativeContinuation({directory:entry.directory,sessionID,operation:'execution.wake'});assertEntry(entry);return null;
    },
    queuedWake:async({sessionID})=>{await continueDeferredExecution(sessionID);return null;},
    retentionAcquire: acquireRetention,
    retentionRecheck:async({permit,members})=>{const entry=entryFor(permit);await checkRetention(entry);if(stable(members)!==stable(entry.retention.members))throw fail('native_retention_tree_changed');await entry.retention.authorize(members);assertEntry(entry);await checkRetention(entry);return null;},
    recoveredPublication: async input=>{
      const entry=input?.permit&&entryFor(input.permit);
      if(typeof options.verifyRecoveredInputPublication!=='function')throw fail('native_recovered_input_capability_required',403);
      return options.verifyRecoveredInputPublication({...input,grant:entry});
    },
    ready: async () => { if (disposed) throw fail('native_owner_stopped', 503); await options.awaitReady?.(); return null; },
    beginCommand,
    authorize, recheck: async ({ permit, request }) => { await recheck(permit, request); return null; },
    release: async (permit) => {
      const entry = entryFor(permit);
      if (['session.move', 'session.remove'].includes(entry.request.operation)) sessionBindings.clear();
      try {
        if (entry.shellLease && !entry.publicationStarted) {
          const lease = await runtime.nativeShellJob({ directory: entry.directory, sessionID: entry.permit.sessionID, jobID: entry.shellLease.nativeShellJob.jobID });
          assertEntry(entry);
          if (lease.state === 'ready') {
            if (retiredExecutions.size >= PERMIT_MAX) throw fail('native_permit_capacity', 503);
            retiredExecutions.set(entry.permit.token, entry);
          }
        }
      } finally { active.delete(entry.permit.token); }
      return null;
    },
    registerShellJob: async input => { await registerShellJob(input); return null; },
    sealSynthetic: ({ permit, input }) => sealSynthetic(permit, input),
    sealPrompt: ({ permit, input }) => sealPrompt(permit, input), verifyAccepted: async ({ permit, accepted }) => { await verifyAccepted(permit, accepted); return null; },
    hold: async ({ sessionID }) => { await hold(sessionID); return null; }, releaseHold: async ({ sessionID }) => { await releaseHold(sessionID); return null; },
    isHeld: async ({ sessionID }) => (await stateFor(sessionID)).state.held,
    deferContinuation: async ({ sessionID, operation }) => { const { session } = await stateFor(sessionID); await runtime.deferNativeContinuation({ directory: session.directory, sessionID, operation }); return null; },
  };
  const acceptedCommandProof=async input=>{
    const raw=await options.readUserMessage({directory:input.directory,sessionID:input.sessionID,messageID:input.messageID});
    const proof=raw?.metadata?.devryan?.command;
    const behavior=reviewedBehaviors.find(value=>value.name===input.name&&stable(value.origin)===stable(proof?.origin));
    const configured=proof?.origin?.kind==='native'&&proof.origin.id==='opencode.config.command'
      ?(options.getReviewedConfiguration?.(input.directory)??reviewedConfiguration)?.commands?.[input.name]:undefined;
    const definition=behavior?.definition??(configured&&{...configured,...configured.model===undefined?{}:{model:configuredModel(configured.model)}});
    if(raw?.id!==input.messageID||raw.type!=='user'||raw.sessionID!==input.sessionID||raw.directory!==input.directory
      ||!record(proof)||proof.v!==1||proof.ownerID!==ownerID||proof.sessionID!==input.sessionID||proof.messageID!==input.messageID
      ||proof.name!==input.name||!definition||proof.definitionDigest!==digest(definition)
      ||proof.argumentsDigest!==digest(input.arguments)||!/^[a-f0-9]{64}$/.test(proof.fingerprint??'')
      ||raw.metadata.devryan.admission?.fingerprint!==proof.fingerprint)throw fail('native_accepted_command_required',403);
    return copy(proof);
  };
  const captureAcceptedCommand=async input=>{
    const entry=entryFor(input?.permit);
    if(input.directory!==entry.directory||input.sessionID!==entry.permit.sessionID||!validID(input.messageID)
      ||typeof input.arguments!=='string'||!['runner.drain','primary.step','execution.resume'].includes(entry.request.operation)
      ||typeof options.readUserMessage!=='function')throw fail('native_accepted_command_required',403);
    await assertRequest(entry,entry.request);const proof=await acceptedCommandProof(input);await assertRequest(entry,entry.request);
    return {entry,proof};
  };
  const withPrimaryDispatch=(input,action,kind)=>inController(async()=>{
    const verify=kind==='recovery'?options.verifyPrimaryRecoveryDispatch:options.verifyPrimaryContinuationDispatch;
    if(!validID(input?.sessionID)||!validID(input.messageID)||!path.isAbsolute(input.directory??'')||typeof verify!=='function')throw fail('native_primary_continuation_owner_required',403);
    const captured=await verify(copy(input));assertController();
    if(!record(captured)||typeof captured.recheck!=='function'||captured.record?.sessionID!==input.sessionID||captured.record.directory!==input.directory
      ||captured.record[kind==='recovery'?'recoveryID':'continuationID']!==input.messageID||captured.prompt?.messageID!==input.messageID)throw fail('native_primary_continuation_invalid',403);
    const recheck=async()=>{assertController();await captured.recheck();assertController();const {session,state}=await stateFor(input.sessionID);
      if(session.directory!==input.directory||state.held||state.reverting)throw fail('native_primary_continuation_fenced',403);await captured.recheck();assertController();};
    await canonical(input.sessionID);await recheck();
    return primaryDispatchContext.run({kind,input:Object.freeze(copy(input)),prompt:copy(captured.prompt),recheck},()=>context.run(undefined,action));
  });
  const withProviderOperation = (input, action, resolution) => inController(async () => {
    const phase = resolution ? 'resolution' : 'attempt';
    if (!record(input) || !validID(input.sessionID) || typeof action !== 'function'
      || (resolution ? Object.keys(input).some(key => !['directory', 'sessionID', 'permit'].includes(key))
        : !['primary', 'title', 'compaction', 'generate'].includes(input.kind))) throw fail(`native_provider_${phase}_invalid`, 403);
    const entry = entryFor(input.permit);
    if (input.sessionID !== entry.permit.sessionID || input.directory !== entry.directory
      || !['runner.drain', 'primary.step', 'execution.resume', 'session.prompt'].includes(entry.request.operation)
        && !((resolution || input.kind === 'generate') && (entry.webfetchSecondary || entry.helperText))) {
      throw fail(`native_provider_${phase}_scope_invalid`, 403);
    }
    let open = true;
    const recheck = async () => {
      if (!open) throw fail('native_provider_resolution_expired', 403);
      await assertRequest(entry, entry.request);
      if (!open) throw fail('native_provider_resolution_expired', 403);
    };
    try { await recheck(); const result = await action(recheck); await recheck(); return result; }
    finally { open = false; }
  });
  return {
    withRetentionOperation:(input,action)=>inController(async()=>{
      if(!['archive','delete'].includes(input.action)||!Array.isArray(input.members)||!input.members.length||input.members.length>512||typeof input.authorize!=='function')throw fail('native_retention_scope_invalid');
      const session=await canonical(input.sessionID);
      if(session.directory!==input.directory||!input.members.some(row=>row.id===session.id))throw fail('native_retention_scope_invalid');
      for(const member of input.members){const current=await canonical(member.id);if(current.directory!==directory||current.parentID!==member.parentID&&!(current.parentID==null&&member.parentID==null))throw fail('native_retention_tree_changed');}
      const state=await runtime.nativeAdmissionState({directory:input.directory,sessionID:input.sessionID});assertController();
      if(state.held||state.reverting||active.size>=PERMIT_MAX)throw fail('native_retention_session_active');
      const permit=Object.freeze({token:token(),sessionID:input.sessionID,revision:state.revision});
      const entry={permit,directory:input.directory,request:{operation:'retention.acquire',sessionID:input.sessionID},retention:{...input,members:copy(input.members)}};
      remember(entry);
      try{await checkRetention(entry);return await context.run(permit,()=>action(permit));}
      finally{
        const decision=entry.retention;
        try{if(decision.intentID){const intent=await runtime.nativeRemoval({directory:input.directory,intentID:decision.intentID});if(intent?.state==='preparing')await runtime.abandonQuietNativeRemoval({directory:input.directory,intentID:intent.id,ownerID});}
        else if(decision.hold)await runtime.releaseNativeAdmission({directory:input.directory,sessionID:input.sessionID,ownerID,holdID:decision.hold.id,expectedRevision:decision.hold.revision});
        }finally{active.delete(permit.token);}
      }
    }),
    withHelperTitleOperation:(input,action)=>inController(async()=>{
      const frozen=nativeHelperTitleInput(input),session=await canonical(frozen.sessionID);
      if(session.directory!==frozen.directory||session.title!==frozen.expectedTitle)throw fail('native_helper_title_conflict',409);
      const reauthorize=await options.captureTitleHelperAuthorization(copy(session));await reauthorize();assertController();
      const state=await runtime.nativeAdmissionState({directory:frozen.directory,sessionID:frozen.sessionID});
      if(state.held||state.reverting||active.size>=PERMIT_MAX)throw fail('native_helper_scope_revoked',403);
      const permit=Object.freeze({token:token(),sessionID:frozen.sessionID,revision:state.revision});
      const entry={permit,directory:frozen.directory,helperTitle:frozen,helperSession:copy(session),reauthorize,request:{operation:'session.rename',sessionID:frozen.sessionID,input:{sessionID:frozen.sessionID,title:frozen.title}}};remember(entry);
      try{await assertRequest(entry,entry.request);return await context.run(permit,()=>action(permit));}finally{active.delete(permit.token);}
    }),
    withHelperOperation: (input, action) => inController(async () => {
      const frozen = nativeHelperInput(input);
      const session = frozen.sessionID ? await canonical(frozen.sessionID) : undefined;
      if (session && session.directory !== frozen.directory) throw fail('native_helper_scope_invalid',403);
      const title=frozen.agent==='devryan-title'&&Boolean(session);
      if(title&&(session.model?.providerID!==frozen.providerID||(session.model?.id??session.model?.modelID)!==frozen.modelID
        ||(session.model?.variant??undefined)!==frozen.variant))throw fail('native_title_selection_changed',403);
      const reauthorize = title&&options.captureTitleHelperAuthorization
        ?await options.captureTitleHelperAuthorization(copy(session))
        :await options.captureWebAuthorization({operation:'helper.generate',directory:frozen.directory,sessionID:frozen.sessionID},session);
      await reauthorize(); assertController();
      const state = session ? await runtime.nativeAdmissionState({directory:frozen.directory,sessionID:session.id}) : {revision:0,held:false,reverting:false};
      if (state.held || state.reverting || active.size >= PERMIT_MAX) throw fail('native_helper_scope_revoked',403);
      const permit = Object.freeze({token:token(),sessionID:frozen.sessionID ?? `ses_helper_${token()}`,revision:state.revision});
      const entry = {permit,directory:frozen.directory,request:{operation:'helper.generate',sessionID:permit.sessionID,input:frozen},helperText:frozen,helperSession:copy(session),reauthorize};
      remember(entry);
      try {await assertRequest(entry,entry.request);return await context.run(permit,()=>action(permit));}
      finally {active.delete(permit.token);}
    }),
    assertHelperOperation: async (input, permit) => inController(async () => {
      const entry = entryFor(permit);
      if(entry.helperTitle){if(stable(nativeHelperTitleInput(input))!==stable(entry.helperTitle))throw fail('native_helper_title_scope_invalid',403);await assertRequest(entry,entry.request);return null;}
      if (!entry.helperText || stable(nativeHelperInput(input)) !== stable(entry.helperText)) throw fail('native_helper_scope_invalid',403);
      await assertRequest(entry,entry.request);return null;
    }),
    captureRemovalAuthorization: sessionID => inController(async () => {
      const inherited = context.getStore(), entry = inherited && entryFor(inherited);
      if(entry?.retention){
        await assertRequest(entry,{operation:'session.remove',sessionID});
        if(!entry.retention.hold)throw fail('native_retention_hold_required');
        return {session:copy(sessionBindings.get(sessionID)),quietHold:copy(entry.retention.hold),
          transferQuietHold:intentID=>{entry.retention.intentID=intentID;},
          reauthorize:()=>checkRetention(entry),drain:()=>checkRetention(entry)};
      }
      if (!entry?.web || entry.permit.sessionID !== sessionID || entry.web.effects.length !== 1
        || entry.web.effects[0].operation !== 'session.remove' || !entry.reauthorize) throw fail('native_web_authorization_required', 403);
      await assertRequest(entry, { operation: 'session.remove', sessionID });
      const session = await canonical(sessionID);
      const reauthorize = async () => { assertEntry(entry); await entry.reauthorize(); assertEntry(entry); };
      await reauthorize();
      return { session: copy(session), reauthorize,
        drain: async () => {
          const deadline = Date.now() + 30000;
          const affected = candidate => {
            if (candidate === entry || candidate.removal) return false;
            const seen = new Set();
            for (let id = candidate.permit.sessionID; id;) {
              if (id === sessionID) return true;
              if (seen.has(id)) throw fail('native_session_lineage_invalid');
              seen.add(id); id = sessionBindings.get(id)?.parentID;
            }
            return false;
          };
          while ([...active.values()].some(affected)) {
            await reauthorize();
            if (Date.now() >= deadline) throw fail('native_removal_settlement_uncertain');
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          await reauthorize();
        } };
    }),
    withRemovalOperation: (input, action) => inController(async () => {
      const intent = await runtime.nativeRemoval({ directory: input.directory, intentID: input.intentID });
      if (!intent || intent.ownerID !== ownerID || intent.state === 'completed' || !intent.members.some(item => item.id === input.sessionID)) {
        throw fail('native_removal_capability_required', 403);
      }
      if (active.size >= PERMIT_MAX) throw fail('native_permit_capacity', 503);
      const state = await runtime.nativeAdmissionState({ directory: input.directory, sessionID: input.sessionID });
      const permit = Object.freeze({ token: token(), sessionID: input.sessionID, revision: state.revision });
      remember({ permit, directory: input.directory, request: { operation: 'removal.inspect', sessionID: input.sessionID }, removal: intent.id });
      try { return await action(permit); } finally { active.delete(permit.token); }
    }),
    withWebOperation: (spec, action) => inController(async () => {
      if (canonicalStoreRead(spec)) return context.run(undefined, action);
      if (['GET', 'HEAD', 'OPTIONS'].includes(spec.method)) return action();
      const inherited = context.getStore(), parent = inherited && entryFor(inherited);
      // Revert's private coordinator already compares the exact persisted
      // transaction, selected message and no-file-change requirement.
      if (parent?.revert) return action();
      if (parent?.nativeTodoWrite) {
        const url = new URL(spec.path, 'http://127.0.0.1');
        if (spec.operation !== 'setMetadata' || spec.method !== 'PATCH'
          || url.pathname !== `/api/session/${parent.permit.sessionID}`
          || (spec.directory && spec.directory !== parent.directory)
          || stable(spec.body) !== stable({metadata:parent.nativeTodoWrite})) throw fail('native_todo_metadata_changed',403);
        await assertRequest(parent,parent.request);
        const result=await action();await assertRequest(parent,parent.request);return result;
      }
      const web = nativeWebOperation(copy(spec));
      if (parent?.commandSelection && (!web.effects.length || web.effects.some(effect => !COMMAND_SELECTION.has(effect.operation)))) throw fail('native_permit_operation_mismatch', 403);
      if (parent && !parent.accepted && !parent.managedDispatch && !parent.commandSelection) throw fail('native_web_authorization_required', 403);
      if (web.effects.some(effect => ['session.prompt', 'session.switchAgent', 'session.switchModel', 'session.setPermissions'].includes(effect.operation))
        && !parent?.accepted && !parent?.managedDispatch && !parent?.commandSelection) throw fail('native_accepted_operation_required', 403);
      if (parent) {
        if (parent.permit.sessionID !== web.sessionID || parent.web) throw fail('native_permit_lineage_mismatch', 403);
        parent.web = web;
        try { return await action(); } finally { delete parent.web; }
      }
      if (typeof options.captureWebAuthorization !== 'function') throw fail('native_web_authorization_required', 403);
      const session = web.sessionID ? await canonical(web.sessionID) : undefined;
      const directory = session?.directory ?? web.directory;
      if (!path.isAbsolute(directory ?? '') || (web.directory && web.directory !== directory)) throw fail('native_session_directory_mismatch', 403);
      const reauthorize = await options.captureWebAuthorization({ ...copy(spec), sessionID: web.sessionID, directory }, session);
      if (typeof reauthorize !== 'function') throw fail('native_web_authorization_required', 403);
      await reauthorize(); assertController();
      const state = session ? await runtime.nativeAdmissionState({ directory, sessionID: session.id }) : { revision: 0, held: false };
      const retry=web.effects.length===1 && web.effects[0].operation==='session.remove'
        ? await removalRetry(directory,session.id,state):undefined;
      if ((state.held && !retry) || state.reverting) throw fail('native_session_held');
      if (active.size >= PERMIT_MAX) throw fail('native_permit_capacity', 503);
      const permit = Object.freeze({ token: token(), ...(web.sessionID ? { sessionID: web.sessionID } : {}), revision: state.revision });
      const commandAdmission = web.effects.length === 1 && web.effects[0].operation === 'session.command' && options.captureCommandPromptAdmission
        ? await options.captureCommandPromptAdmission({ sessionID: session.id, directory }) : undefined;
      if (commandAdmission !== undefined && (typeof commandAdmission?.admit !== 'function' || typeof commandAdmission?.uncertain !== 'function')) {
        throw fail('native_command_admission_owner_required', 503);
      }
      await reauthorize(); assertController();
      const entry = { permit, request: { operation: 'web.operation', sessionID: web.sessionID }, directory, web, reauthorize,removalRetry:retry?.id,commandAdmission };
      remember(entry);
      try { return await context.run(permit, action); }
      catch (cause) { await uncertainCommandPrompt(entry); throw cause; }
      finally { active.delete(permit.token); }
    }),
    handleRpc: (method, input) => inController(async () => { if (typeof method !== 'string' || !method.startsWith('native.admission.')) throw fail('native_admission_rpc_unavailable', 403); const key = method.slice('native.admission.'.length); if (!Object.hasOwn(methods, key)) throw fail('native_admission_rpc_unavailable', 403); return methods[key](input); }),
    releaseTransactionHolds: input => inController(() => releaseTransactionHolds(input)),
    acknowledgeStartedContinuation: input => inController(() => acknowledgeStartedContinuation(input)),
    recoverShellContinuations: input => inController(async () => {
      if (disposed) throw fail('native_owner_stopped', 503);
      if (!path.isAbsolute(input.directory ?? '')) throw fail('native_session_directory_mismatch', 403);
      for (const intent of await runtime.nativeShellContinuations(input)) {
        const { session, state } = await stateFor(intent.sessionID);
        if (session.directory !== input.directory) throw fail('native_session_directory_mismatch', 403);
        if (state.held || state.reverting) continue;
        const jobID = intent.operation.slice('shell.complete:'.length);
        const lease = await runtime.nativeShellJob({ directory: session.directory, sessionID: session.id, jobID });
        assertController();
        if (!lease.nativeShellJob.deliveredID) continue;
        // The web owner can outlive a crashed native controller. Its volatile
        // registration cache is never evidence that the replacement consumed.
        pendingShellWakes.delete(`${session.id}\0${jobID}`);
        await continueShell({ permit: { sessionID: session.id }, directory: session.directory,
          messageID: lease.nativeShellJob.deliveredID, shellCompletion: { lease, jobID } });
      }
    }),
    recoverTransactionHolds: input => inController(async () => { for (const held of await runtime.nativeTransactionHolds({ directory: input.directory, ownerID })) await releaseTransactionHolds({ ...held, directory: input.directory }); }),
    withRevertOperation: (input, action) => inController(async () => {
      const request = { operation: input.operation, sessionID: input.sessionID, ...(input.operation === 'session.revert.stage' ? { input } : {}) };
      await validateRevert(input, request);
      if (disposed || active.size >= PERMIT_MAX) throw fail('native_permit_capacity', 503);
      const permit = Object.freeze({ token: token(), sessionID: input.sessionID, revision: (await runtime.nativeAdmissionState(input)).revision });
      remember({ permit, request, directory: input.directory, revert: copy(input) });
      try { return await context.run(permit, action); } finally { active.delete(permit.token); }
    }),
    withAcceptedOperation: (accepted, action) => inController(async () => {
      if (!/^[a-f0-9]{64}$/.test(accepted?.fingerprint ?? '') || !record(accepted.metadata)) throw fail('native_accepted_operation_invalid', 403);
      const managedDispatch = managedDispatchContext.getStore();
      const primaryDispatch = primaryDispatchContext.getStore();
      const primaryContent=primaryDispatch&&buildV2PromptContent(primaryDispatch.prompt.parts);
      if (primaryDispatch && (accepted.sessionID !== primaryDispatch.input.sessionID
        || accepted.messageID !== primaryDispatch.input.messageID
        || accepted.request?.text !== primaryContent.text
        || accepted.metadata.devryan?.objectiveID !== primaryDispatch.prompt.objectiveID
        || stable(accepted.metadata.devryan?.parts) !== stable(primaryContent.segments)
        ||primaryDispatch.kind==='recovery'&&['messageID','parts','tools','model','agent','variant','objectiveID'].some(key=>stable(accepted.intent?.[key])!==stable(primaryDispatch.prompt[key])))) {
        throw fail('native_primary_continuation_payload_changed', 403);
      }
      if (managedDispatch) {
        if (managedDispatch.operation !== 'prompt' || accepted.sessionID !== managedDispatch.sessionID) throw fail('native_managed_task_scope_invalid', 403);
        await verifyManagedDispatch(managedDispatch);
      }
      const permit = await issue({ operation: 'admission.prompt', sessionID: accepted.sessionID, messageID: accepted.messageID }, accepted);
      if (managedDispatch) entryFor(permit).managedDispatch = managedDispatch;
      if (primaryDispatch) entryFor(permit).primaryDispatch = primaryDispatch;
      try { return await context.run(permit, action); } finally { active.delete(permit.token); }
    }),
    captureContextAuthorization: input => inController(async()=>{
      const entry=entryFor(input?.permit);
      if(input?.phase!=='compaction' || input.sessionID!==entry.permit.sessionID || input.directory!==entry.directory
        || !['runner.drain','primary.step','execution.resume'].includes(entry.request.operation)) throw fail('native_context_scope_invalid',403);
      const recheck=()=>inController(()=>assertRequest(entry,entry.request));
      await recheck();return recheck;
    }),
    captureCursorAuthorization:input=>inController(async()=>{
      const permit=context.getStore(),entry=permit&&entryFor(permit);
      if(!entry?.accepted||entry.request.operation!=='admission.prompt'||input?.sessionID!==entry.permit.sessionID
        ||input.directory!==entry.directory||input.userMessageID!==entry.messageID||!validID(input.assistantMessageID)
        ||input.assistantMessageID===input.userMessageID||typeof input.agent!=='string'||!input.agent
        ||typeof input.modelID!=='string'||!input.modelID||input.variant!==undefined&&typeof input.variant!=='string'
        ||entry.metadata?.devryan?.providerID!=='cursor-acp'||entry.metadata.devryan.modelID!==input.modelID
        ||entry.metadata.devryan.agent!==input.agent||!record(entry.accepted.request)||entry.accepted.request.id!==input.userMessageID)
        throw fail('native_cursor_scope_invalid',403);
      await assertRequest(entry,{operation:'inbox.reconcile',sessionID:input.sessionID,messageID:input.userMessageID});
      const epoch=controllerEpoch,revision=entry.permit.revision,scope=copy(input),accepted=copy(entry.accepted.request);
      const original=entry.reauthorize,managed=entry.managedDispatch&&copy(entry.managedDispatch);
      if(typeof original!=='function'&&!managed)throw fail('native_cursor_caller_required',403);
      const authorize=async()=>{if(original)await original();if(managed)await verifyManagedDispatch(managed);};
      const recheck=()=>inController(async()=>{
        if(controllerEpoch!==epoch)throw fail('native_permit_revoked');
        await authorize();const {session,state}=await stateFor(scope.sessionID);
        if(session.directory!==scope.directory||session.time?.archived||session.revert||state.held||state.reverting||state.revision!==revision
          ||session.agent!==scope.agent||session.model?.providerID!=='cursor-acp'||session.model.id!==scope.modelID
          ||(session.model.variant??'default')!==(scope.variant||'default'))throw fail('native_cursor_scope_revoked',403);
        await authorize();if(controllerEpoch!==epoch)throw fail('native_permit_revoked');
      });
      await recheck();return Object.freeze({accepted,revision,recheck});
    }),
    captureSessionHookAuthorization: input => inController(async()=>{
      const entry=entryFor(input?.permit);
      if(input.sessionID!==entry.permit.sessionID || input.directory!==entry.directory)throw fail('native_hook_scope_invalid',403);
      let request;
      if(input.phase==='prompt') {
        if(!validID(input.messageID) || input.messageID!==entry.messageID || !entry.accepted && !entry.commandDerivation?.prompt && entry.interviewAction?.kind!=='continue')throw fail('native_hook_scope_invalid',403);
        request={operation:'session.prompt.seal',sessionID:input.sessionID,messageID:input.messageID};
      } else {
        if(!['context','compaction','retry','model.request'].includes(input.phase)
          || !['runner.drain','primary.step','execution.resume','session.prompt'].includes(entry.request.operation)
            && !((entry.webfetchSecondary&&['context','model.request'].includes(input.phase)||entry.helperText&&input.phase==='model.request')))throw fail('native_hook_scope_invalid',403);
        request=entry.request;
      }
      const recheck=()=>inController(()=>assertRequest(entry,request));
      await recheck();return recheck;
    }),
    captureToolHookAuthorization: input => inController(async()=>{
      const entry=entryFor(input?.permit);
      if(input.directory!==entry.directory || input.sessionID!==entry.permit.sessionID || input.phase!=='execute.before'
        || !validID(input.messageID) || !validID(input.callID) || typeof input.toolID!=='string' || !input.toolID
        || !['runner.drain','primary.step','execution.resume'].includes(entry.request.operation))throw fail('native_tool_hook_scope_invalid',403);
      const recheck=()=>inController(()=>assertRequest(entry,entry.request));
      await recheck();return recheck;
    }),
    captureAcceptedCommandAuthorization: input => inController(async()=>{
      const {entry}=await captureAcceptedCommand(input);
      return ()=>inController(async()=>{await assertRequest(entry,entry.request);await acceptedCommandProof(input);await assertRequest(entry,entry.request);});
    }),
    captureInterviewAuthorization: input=>inController(async()=>{
      if(input?.name!=='interview')throw fail('native_accepted_command_required',403);
      const {entry,proof}=await captureAcceptedCommand(input),epoch=controllerEpoch,revision=entry.permit.revision;
      for(const [authorizationID,grant]of interviewGrants){
        if(grant.controller.signal.aborted){interviewGrants.delete(authorizationID);continue;}
        if(['directory','sessionID','messageID','arguments'].every(key=>grant.input[key]===input[key])){
          await grant.recheck();return Object.freeze({authorizationID,recheck:grant.recheck,signal:grant.controller.signal});
        }
      }
      if(typeof entry.reauthorize!=='function'||interviewGrants.size>=128)throw fail('native_interview_grant_unavailable',403);
      const captured=copy(input),controller=new AbortController(),authorizationID=token(),reauthorize=entry.reauthorize;
      const recheck=()=>inController(async()=>{
        try{
          controller.signal.throwIfAborted();if(controllerEpoch!==epoch)throw fail('native_permit_revoked');
          await reauthorize();const {session,state}=await stateFor(captured.sessionID);
          if(session.directory!==captured.directory||session.time?.archived||session.revert||state.held||state.reverting||state.revision!==revision)throw fail('native_permit_revoked');
          if(stable(await acceptedCommandProof(captured))!==stable(proof))throw fail('native_accepted_command_required',403);
          await reauthorize();if(controllerEpoch!==epoch)throw fail('native_permit_revoked');controller.signal.throwIfAborted();
        }catch(cause){controller.abort(cause);throw cause;}
      });
      await recheck();interviewGrants.set(authorizationID,{input:captured,controller,recheck,revision});
      return Object.freeze({authorizationID,recheck,signal:controller.signal});
    }),
    withInterviewAction:(input,action)=>inController(async()=>{
      const grant=interviewGrants.get(input?.authorizationID);
      if(!grant||input.directory!==grant.input.directory||input.sessionID!==grant.input.sessionID||input.messageID!==grant.input.messageID
        ||!['rename','notify','continue'].includes(input.kind)||Object.keys(input).some(key=>!['authorizationID','directory','sessionID','messageID','kind','text'].includes(key))
        ||typeof input.text!=='string'||!input.text||Buffer.byteLength(input.text)>1024*1024)throw fail('native_interview_action_invalid',403);
      await grant.recheck();if(active.size>=PERMIT_MAX)throw fail('native_permit_capacity',503);
      const id=input.kind==='rename'?undefined:'msg_'+token(),sessionID=input.sessionID;
      const body=input.kind==='rename'?{sessionID,title:input.text}:input.kind==='notify'?{sessionID,id,text:input.text,resume:false}:{sessionID,id,text:input.text};
      const operation=input.kind==='rename'?'session.rename':input.kind==='notify'?'session.synthetic':'session.prompt';
      const permit=Object.freeze({token:token(),sessionID,revision:grant.revision});
      const fingerprint=digest({interview:grant.input.messageID,body}),metadata={devryan:{v:1,origin:'interview',...(input.kind==='notify'?{statusOnly:true}:{}),planMode:false,
        parts:[{kind:'synthetic',length:input.text.length}],admission:{v:1,fingerprint}}};
      remember({permit,request:{operation,sessionID,input:body},directory:input.directory,messageID:id,
        interviewAction:{kind:input.kind,body},reauthorize:grant.recheck,fingerprint,metadata});
      try{return await context.run(permit,async()=>{await grant.recheck();const result=await action({permit,kind:input.kind,body:copy(body)});await grant.recheck();return result;});}
      finally{active.delete(permit.token);}
    }),
    captureCommandAuthorization: input => inController(async()=>{
      const entry=entryFor(input?.permit);
      if(input.directory!==entry.directory || input.invocation?.sessionID!==entry.permit.sessionID)throw fail('native_command_scope_invalid',403);
      const request={operation:'session.command.effect',sessionID:input.invocation.sessionID,derivation:input.derivation,
        input:{name:input.name,invocation:copy(input.invocation)}};
      const recheck=()=>inController(()=>assertRequest(entry,request));
      await recheck();return recheck;
    }),
    withNativeTodoWrite: ({invocation,metadata},action)=>inController(async()=>{
      const parent=entryFor(invocation?.permit);
      if(invocation?.tool!=='todowrite' || parent.request.operation!=='tool.execute'
        || parent.request.input?.toolID!=='todowrite' || parent.request.input.provenance?.kind!=='plugin'
        || parent.request.input.provenance.id!=='devryan.harness-context'
        || !record(invocation.input) || stable(Object.keys(invocation.input))!==stable(['todos'])
        || !Array.isArray(invocation.input.todos)
        || invocation.input.todos.some(item=>!record(item) || stable(Object.keys(item).sort())!==stable(['content','id','priority','status'])
          || typeof item.id!=='string' || !item.id.trim() || typeof item.content!=='string' || !item.content.trim()
          || !['pending','in_progress','completed','cancelled'].includes(item.status) || !['high','medium','low'].includes(item.priority))
        || new Set(invocation.input.todos.map(item=>item.id)).size!==invocation.input.todos.length) throw fail('native_todo_write_scope_invalid',403);
      await recheckExecution(invocation);
      const session=await getSession(invocation.sessionID);assertEntry(parent);
      if(session?.id!==invocation.sessionID || session.directory!==invocation.directory || session.time?.archived || session.revert) throw fail('native_todo_write_scope_invalid',403);
      if(typeof options.readSessionMetadata!=='function')throw fail('native_todo_metadata_owner_required',503);
      const raw=await options.readSessionMetadata({sessionID:invocation.sessionID,directory:invocation.directory});assertEntry(parent);
      if(raw?.id!==invocation.sessionID || raw.directory!==invocation.directory || !record(raw.metadata))throw fail('native_todo_metadata_scope_invalid',403);
      const prior=raw.metadata, devryan=record(prior.devryan)?prior.devryan:{}, todo=devryan.todo;
      const revision=record(todo) && todo.sessionID===invocation.sessionID && Number.isSafeInteger(todo.rev) && todo.rev>=0?todo.rev:0;
      if(!Number.isSafeInteger(revision+1))throw fail('native_todo_revision_invalid',403);
      const expected={...prior,devryan:{...devryan,todo:{sessionID:invocation.sessionID,items:copy(invocation.input.todos),rev:revision+1}}};
      if(stable(metadata)!==stable(expected))throw fail('native_todo_metadata_changed',403);
      await recheckExecution(invocation);assertEntry(parent);
      if(active.size>=PERMIT_MAX)throw fail('native_permit_capacity',503);
      const permit=Object.freeze({token:token(),sessionID:invocation.sessionID,revision:parent.permit.revision});
      const request={operation:'session.setMetadata',sessionID:invocation.sessionID,input:{sessionID:invocation.sessionID,metadata:copy(expected)}};
      const entry={permit,request,directory:invocation.directory,nativeTodoWrite:copy(expected),
        web:{sessionID:invocation.sessionID,directory:invocation.directory,effects:[{operation:'session.setMetadata',input:request.input}]},
        reauthorize:()=>recheckExecution(invocation)};
      remember(entry);
      try{await assertRequest(entry,request);return await context.run(permit,action);}finally{active.delete(permit.token);}
    }),
    withPrimaryContinuationDispatch:(input,action)=>withPrimaryDispatch(input,action,'continuation'),
    withPrimaryRecoveryDispatch:(input,action)=>withPrimaryDispatch(input,action,'recovery'),
    withPrimaryContinuationOperation: (input, action) => inController(async () => {
      if (!validID(input?.sessionID) || !validID(input.messageID) || !path.isAbsolute(input.directory ?? '')
        || typeof options.verifyPrimaryContinuationDispatch !== 'function') throw fail('native_primary_continuation_owner_required', 403);
      const captured = await options.verifyPrimaryContinuationDispatch(copy(input));
      assertController();
      if (captured?.record?.sessionID !== input.sessionID || captured.record.directory !== input.directory
        || captured.record.continuationID !== input.messageID || typeof captured.recheck !== 'function') throw fail('native_primary_continuation_invalid', 403);
      const session = await canonical(input.sessionID), state = await runtime.nativeAdmissionState({directory:input.directory,sessionID:input.sessionID});
      await captured.recheck(); assertController();
      if (session.directory !== input.directory || state.held || state.reverting || active.size >= PERMIT_MAX) throw fail('native_primary_continuation_fenced',403);
      const run=async reauthorize=>{
        const permit = Object.freeze({token:token(),sessionID:input.sessionID,revision:state.revision});
        const entry = {permit,request:{operation:'primary.continue',sessionID:input.sessionID},directory:input.directory,
          messageID:input.messageID,primaryReconciliation:true,reauthorize};
        remember(entry);
        try {await assertRequest(entry,entry.request);return await action(permit);}
        finally {active.delete(permit.token);}
      };
      return options.withRecoveredPrimaryGrant?options.withRecoveredPrimaryGrant(input,captured.record,run,captured.recheck):run(captured.recheck);
    }),
    withRecoveredInputOperation:(input,action)=>inController(async()=>{
      if(!validID(input?.sessionID)||!validID(input.messageID)||!/^[a-f0-9]{64}$/.test(input.payloadHash??'')
        ||!Number.isSafeInteger(input.enqueuedSeq)||input.enqueuedSeq<0||!['resume','discard'].includes(input.action)||typeof input.recheck!=='function')throw fail('native_recovered_input_invalid',403);
      await input.recheck();const session=await canonical(input.sessionID),state=await runtime.nativeAdmissionState({directory:input.directory,sessionID:input.sessionID});
      await input.recheck();if(session.directory!==input.directory||state.held||state.reverting)throw fail('native_recovered_input_fenced',403);
      const permit=Object.freeze({token:token(),sessionID:input.sessionID,revision:state.revision});
      const request={operation:input.action==='resume'?'primary.continue':'recovered.input.cancel',sessionID:input.sessionID,messageID:input.messageID};
      const entry={permit,request,directory:input.directory,messageID:input.messageID,reauthorize:input.recheck,
        ...input.action==='resume'?{primaryReconciliation:true}:{recoveredInputCancellation:{messageID:input.messageID,payloadHash:input.payloadHash,enqueuedSeq:input.enqueuedSeq}}};
      remember(entry);try{await assertRequest(entry,request);return await action(permit);}finally{active.delete(permit.token);}
    }),
    withCommandSelection: ({ sessionID,delivery }, action) => inController(async () => {
      options.assertRecoveredInputOperation?.({operation:'admission.command',sessionID});
      if (!validID(sessionID) || typeof options.captureWebAuthorization !== 'function') throw fail('native_web_authorization_required', 403);
      if (context.getStore()) throw fail('native_permit_lineage_mismatch', 403);
      const session = await canonical(sessionID);
      const reauthorize = await options.captureWebAuthorization({ operation: 'admission.command.selection', sessionID, directory: session.directory }, session);
      if (typeof reauthorize !== 'function') throw fail('native_web_authorization_required', 403);
      await reauthorize(); assertController();
      const state = await runtime.nativeAdmissionState({ directory: session.directory, sessionID });
      assertController();
      if (state.held || state.reverting) throw fail('native_session_held');
      if (active.size >= PERMIT_MAX) throw fail('native_permit_capacity', 503);
      const permit = Object.freeze({ token: token(), sessionID, revision: state.revision });
      remember({ permit, directory: session.directory, request: { operation: 'admission.command.selection', sessionID }, commandSelection: true,commandSelectionDelivery:delivery, reauthorize });
      try { return await context.run(permit,async()=>{
        if(delivery==='queue'){if(typeof options.verifyQueuedPrimaryIdle!=='function')throw fail('native_queued_admission_unverified',503);await options.verifyQueuedPrimaryIdle({sessionID,permit});assertEntry(entryFor(permit));}
        return action();
      }); } finally { active.delete(permit.token); }
    }),
    withManagedTaskDispatch: (input, action) => inController(async () => {
      if (!record(input) || !path.isAbsolute(input.directory ?? '')
        || !validID(input.taskId) || typeof input.leaseToken !== 'string' || !input.leaseToken
        || (input.operation === 'create' ? !validID(input.parentID) || !validID(input.parentCallID)
          : input.operation !== 'prompt' || !validID(input.sessionID) || ['providerId', 'modelId', 'agent'].some(key => typeof input[key] !== 'string' || !input[key])
            || !(input.variant === null || typeof input.variant === 'string'))) throw fail('native_managed_task_scope_invalid', 403);
      const sealed = Object.freeze(copy(input));
      const run = () => managedDispatchContext.run(sealed, () => context.run(undefined, async () => {
        const task = await verifyManagedDispatch(sealed);
        const sessionID = sealed.operation === 'create' ? sealed.parentID : sealed.sessionID;
        const session = await canonical(sessionID);
        if (session.directory !== sealed.directory || (sealed.operation === 'prompt' && session.parentID !== task.rootSessionId)) {
          throw fail('native_managed_task_scope_invalid', 403);
        }
        if (sealed.operation === 'prompt') return action();
        const state = await runtime.nativeAdmissionState({ directory: sealed.directory, sessionID });
        await verifyManagedDispatch(sealed);
        if (state.held || state.reverting) throw fail('native_session_held');
        if (active.size >= PERMIT_MAX) throw fail('native_permit_capacity', 503);
        const permit = Object.freeze({ token: token(), sessionID, revision: state.revision });
        remember({ permit, directory: sealed.directory, request: { operation: 'session.create', sessionID }, managedDispatch: sealed });
        try { return await context.run(permit, action); } finally { active.delete(permit.token); }
      }));
      // Child prompt admission already owns the child's existing web lock.
      // Creation shares the parent's lock with hold issuance instead.
      if (sealed.operation === 'prompt') return run();
      if (typeof options.withSessionLock !== 'function') throw fail('native_session_owner_unavailable', 503);
      return options.withSessionLock(sealed.parentID, run);
    }),
    requestHeaders: () => { const permit = context.getStore(); if (permit) entryFor(permit); return permit ? { [HEADER]: stable(permit) } : {}; },
    checkQueuedPromptAdmission:async({sessionID,messageID})=>{
      const permit=context.getStore(),entry=permit&&entryFor(permit);
      if(!entry?.accepted||entry.permit.sessionID!==sessionID||entry.messageID!==messageID||entry.accepted.request?.delivery!=='queue'||entry.metadata?.devryan?.origin!=='human')throw fail('native_queued_admission_invalid',403);
      const current=await options.readQueuedPrimaryRecord?.(sessionID);assertEntry(entry);
      if(current&&[current.anchorID,current.recoveryID,current.nativeContinuation?.messageID,...current.guardedIDs??[]].includes(messageID))throw fail('native_queued_admission_reserved');
      if(typeof options.verifyQueuedPrimaryIdle!=='function')throw fail('native_queued_admission_unverified',503);
      await options.verifyQueuedPrimaryIdle({sessionID,messageID,permit});assertEntry(entry);
    },
    assertQueuedPromptReconciled:assertQueuedRecord,
    queuedPromptWasRejected:()=>{
      const permit=context.getStore(),entry=permit&&entryFor(permit);
      return entry?.queuedAdmission?.rejected===true;
    },
    stageQueuedPromptAdmission:async(receipt,admit)=>{
      const permit=context.getStore(),entry=permit&&entryFor(permit);
      if(!entry?.accepted||entry.permit.sessionID!==receipt.sessionID||entry.messageID!==receipt.messageID
        ||entry.accepted.request?.delivery!=='queue'||entry.metadata?.devryan?.origin!=='human'
        ||typeof admit!=='function'||entry.queuedAdmission)throw fail('native_queued_admission_invalid',403);
      const run=AsyncLocalStorage.snapshot();const primaryGuard=await options.captureQueuedPrimaryAdmission?.(receipt.sessionID);assertEntry(entry);entry.queuedAdmission={primaryGuard,admit:authorizeWrite=>run(()=>admit(authorizeWrite))};
    },
    updateAcceptedOperation: (input) => {
      const permit = context.getStore(), entry = permit && entryFor(permit);
      if (!entry?.accepted || !record(input.metadata) || input.metadata.devryan?.admission?.fingerprint !== entry.fingerprint) throw fail('native_accepted_operation_invalid', 403);
      if (entry.primaryDispatch) {
        const prompt = entry.primaryDispatch.prompt, metadata = input.metadata.devryan;
        const content=buildV2PromptContent(prompt.parts);
        if (metadata.agent !== prompt.agent || metadata.providerID !== prompt.model.providerID
          || metadata.modelID !== prompt.model.modelID || metadata.variant !== prompt.variant
          || metadata.objectiveID !== prompt.objectiveID
          || input.request?.text !== content.text ||stable(input.request.files??[])!==stable(content.files)
          ||stable(input.request.agents??[])!==stable(content.agents)) throw fail('native_primary_continuation_payload_changed',403);
      }
      entry.metadata = copy(input.metadata);
      entry.accepted.request = copy(input.request);
    },
    recheckExecution: input => inController(() => recheckExecution(input)),
    withImageGeneration:(invocation,action)=>inController(async()=>{
      const parent=entryFor(invocation?.permit),origin=parent.request.input?.provenance;
      if(invocation.tool!=='gpt_imagegen'||parent.request.operation!=='tool.execute'||parent.request.input?.toolID!=='gpt_imagegen'
        ||origin?.kind!=='plugin'||origin.id!=='opencode-gpt-imagegen'||!validID(invocation.token)||typeof action!=='function')throw fail('native_image_generation_scope_invalid',403);
      const recheck=()=>inController(async()=>{
        await recheckExecution(invocation);
        const lease=await runtime.leaseForCall(invocation),captured=await runtime.capturedSessionState(invocation);
        if(!lease||lease.token!==invocation.token||lease.executionKind!=='process'||lease.preparation==='none'||lease.state!=='ready'
          ||lease.scope.messageID!==invocation.messageID||lease.scope.sessionID!==invocation.sessionID||lease.scope.callID!==invocation.callID
          ||!captured.captured||captured.pending||lease.generation!==captured.generation)throw fail('native_image_generation_lease_invalid',403);
        await recheckExecution(invocation);
      });
      await recheck();const result=await action(recheck);await recheck();return result;
    }),
    beginWebfetchSecondary:input=>inController(async()=>{
      const parent=entryFor(input?.permit),call=parent.request.input;
      if(parent.request.operation!=='tool.execute'||call?.toolID!=='webfetch'||call.provenance?.kind!=='plugin'||call.provenance.id!=='devryan.slim'
        ||input.directory!==parent.directory||input.sessionID!==parent.permit.sessionID||input.messageID!==parent.request.messageID||input.callID!==call.callID
        ||!record(input.model)||typeof input.model.providerID!=='string'||typeof input.model.modelID!=='string'
        ||Object.keys(input.model).some(key=>!['providerID','modelID','variant'].includes(key))||input.model.variant!==undefined&&typeof input.model.variant!=='string'
        ||typeof input.prompt!=='string'||Buffer.byteLength(input.prompt)>4*1024*1024
        ||Object.keys(input).some(key=>!['permit','directory','sessionID','messageID','callID','model','prompt'].includes(key)))throw fail('native_webfetch_secondary_scope_invalid',403);
      const scope={directory:input.directory,sessionID:input.sessionID,callID:input.callID};
      const reauthorize=async()=>{
        await assertRequest(parent,parent.request);
        const lease=await runtime.leaseForCall(scope),captured=await runtime.capturedSessionState(scope);
        if(!lease||lease.executionKind!=='control'||lease.preparation!=='none'||lease.state!=='ready'||lease.scope.messageID!==input.messageID
          ||!captured.captured||captured.pending||lease.generation!==captured.generation)throw fail('native_webfetch_secondary_lease_invalid',403);
        await assertRequest(parent,parent.request);
      };
      await reauthorize();if(active.size>=PERMIT_MAX)throw fail('native_permit_capacity',503);
      const permit=Object.freeze({token:token(),sessionID:input.sessionID,revision:parent.permit.revision});
      remember({permit,directory:input.directory,request:{operation:'session.generate',sessionID:input.sessionID},
        webfetchSecondary:copy({model:input.model,prompt:input.prompt}),reauthorize});return permit;
    }),
    endWebfetchSecondary:permit=>inController(async()=>{
      const entry=entryFor(permit);if(!entry.webfetchSecondary)throw fail('native_webfetch_secondary_scope_invalid',403);
      active.delete(permit.token);return null;
    }),
    withProviderAttempt: (input, action) => withProviderOperation(input, action, false),
    withProviderResolution: (input, action) => withProviderOperation(input, action, true),
    withPermit: (input, action) => inController(async () => {
      const entry = entryFor(input.permit);
      await recheckExecution(input);
      const run = async () => { await recheckExecution(input); return context.run(entry.permit, action); };
      // The accepted web prompt already owns this lock across the native HTTP call.
      if (entry.accepted || !entry.permit.sessionID) return run();
      if (typeof options.withSessionLock !== 'function') throw fail('native_session_owner_unavailable', 503);
      return options.withSessionLock(entry.permit.sessionID, run);
    }),
    invalidateController,
    dispose: () => {
      if (controllerReplacement || pendingContinuationAcks.size) throw fail('native_controller_ack_pending', 503);
      disposed = true; clearController();
    },
  };
}
