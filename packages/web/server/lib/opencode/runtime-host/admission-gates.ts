import {assertQueuedInputIdle,isQueuedPrimaryInput,queuedPublicationWitnesses,wakeQueuedInputParents,QueuedInputWitnesses} from './native-queued-input.js';
import {quietNativeRetention} from './native-retention-quiet.js';
import {NativeHelperTitleRef,assertNativeHelperTitle} from './native-helper-title.js';
import type {NativeHelperTitleInput} from './native-helper-contract.js';
import {helperPluginContext} from './native-helper-context.js';
import {persistRecoveredCancellation,dropRecoveredCancellationReceipts} from './native-input-cancellation-receipt.js';
import { SessionEvent } from '@opencode/schema/session-event';
import { runControllerEffect } from './controller-effects.js';
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Option, Scope, Schema } from 'effect';
import { Command } from '@opencode/core/command';
import { Location } from '@opencode/core/location';
import { Permission } from '@opencode/core/permission';
import { PermissionSaved } from '@opencode/core/permission/saved';
import { Form } from '@opencode/core/form';
import { Job } from '@opencode/core/job';
import { Tool } from '@opencode/core/tool';
import { Model } from '@opencode/core/model';
import { Provider } from '@opencode/core/provider';
import { effectiveName } from '@opencode/core/tool/runtime';
import { Session } from '@opencode/core/session';
import { Bus } from '@opencode/core/bus';
import { SessionSchema } from '@opencode/core/session/schema';
import { SessionMessage } from '@opencode/core/session/message';
import { SessionInbox } from '@opencode/core/session/inbox';
import { SessionExecution } from '@opencode/core/session/execution';
import { SessionStore } from '@opencode/core/session/store';
import { SessionRestart } from '@opencode/core/session/execution/restart';
import { Database } from '@opencode/core/database/database';
import { SessionRunner } from '@opencode/core/session/runner/index';
import { SessionRunnerLLM } from '@opencode/core/session/runner/llm';
import { Plugin } from '@opencode/core/plugin';
import { PluginHooks } from '@opencode/core/plugin/hooks';
import type { SessionPrompt } from '@opencode/plugin/effect/session';
import { Tool as ToolSchema } from '@opencode/schema/tool';
import { Agent } from '@opencode/schema/agent';
import type { Config as ConfigSchema } from '@opencode/schema/config';
import { LayerNode } from '@opencode/util/effect/layer-node';
import { makeGlobalNode, makeLocationNode } from '@opencode/util/effect/app-node';
import { createCommandDerivation,type ReviewedCommandBehavior } from './command-derivation.js';
import { HostRefusal, refuseHost } from './host-refusal.js';
import { RegistrationOriginRef, provideRegistrationOrigin, type RegistrationOrigin } from './registration-origin.js';
import { OperationPermitRef, requestPermit, type ExecuteOwned, type NativeAdmissionBridge, type OperationPermit, type OperationRequest, type NativeExecutor } from './native-admission-contract.js';
import { translateNativeSkillPermissionRules } from './native-skill-permissions.js';
import type { ReviewedSkill } from './reviewed-skills.js';
import type { NativeDeferredWakeReceipt, NativeShellReconciliation } from './native-admission-owner.js';
import type { NativeInterviewAction } from './native-process-protocol.js';
import type { NativeSlimCommandInput, NativeSlimCommandOptions } from './native-slim-commands.js';
import { persistInterviewNotification } from './native-notification.js';
import {recoveredInputHash} from './native-recovered-input-hash.js';

export interface AdmissionHookOwners {
  readonly assertToolRead:(event:unknown,target:string)=>Effect.Effect<void>;
}
export interface AdmissionGateOptions {
  readonly bridge: NativeAdmissionBridge;
  readonly executeOwned: ExecuteOwned;
  readonly nativePlugins: ReadonlyMap<string, RegistrationOrigin>;
  readonly reviewedBehaviorCommands?:readonly ReviewedCommandBehavior[];
  readonly beforeConfiguredCommand?: (input:NativeSlimCommandInput)=>Effect.Effect<void,unknown>;
  readonly reviewedConfigurationForDirectory?: (directory: string) => ConfigSchema.Info | undefined;
  /** Frozen reviewed skills for the actual native Permission location. */
  readonly reviewedSkillsForDirectory?: (directory: string) => readonly ReviewedSkill[];
  /** Physical provider finalizers run after plugin hooks, inside mandatory admission. */
  readonly providerHooks?: (inner: PluginHooks.Interface) => PluginHooks.Interface;
  readonly sessionHooks?: (inner: PluginHooks.Interface, location: Readonly<Location.Info>, owners:AdmissionHookOwners) => PluginHooks.Interface;
  readonly executionActivity?: (inner: SessionExecution.Interface) => Pick<SessionExecution.Interface, 'active' | 'isActive'>;
  readonly captureSessionStore?: (inner: SessionStore.Interface) => Effect.Effect<SessionStore.Interface, never, Scope.Scope>;
}
const record = (input: unknown): input is Record<string, unknown> => typeof input === 'object' && input !== null && !Array.isArray(input);
const isPrompt = (input: unknown): input is SessionPrompt => record(input) && typeof input.sessionID === 'string'
  && typeof input.messageID === 'string' && record(input.prompt) && typeof input.prompt.text === 'string';
const effectiveID = (tool: ToolSchema.Info): string => tool.options?.namespace ? `${tool.options.namespace}.${tool.name}` : tool.name;
const directOptions = (options?: Tool.Options): Tool.Options => ({
  ...(options?.namespace === undefined ? {} : { namespace: options.namespace }),
  ...(options?.permission === undefined ? {} : { permission: options.permission }), codemode: false,
});

/** Raw native sequence, not the REST projection which can fold synthetic IDs. */
async function observeOwnedInput(store: Pick<SessionStore.Interface, 'message' | 'messages'>,
  inbox: Pick<SessionInbox.Interface, 'list'>, input: { readonly sessionID: string; readonly messageID: string },
  type: 'synthetic' | 'user', operation: 'shell.continue' | 'primary.continue'): Promise<NativeShellReconciliation | { readonly kind: 'pending'; readonly messageID: string; readonly location: 'queued' | 'promoted' }> {
  const sessionID = SessionSchema.ID.make(input.sessionID), messageID = SessionMessage.ID.make(input.messageID);
  const message = await runControllerEffect(store.message(messageID));
  if (!message) {
    const pending = await runControllerEffect(inbox.list(sessionID));
    const queued = pending.find(item => item.id === messageID);
    if (!queued || queued.sessionID !== sessionID || queued.type !== type) throw new HostRefusal('native_continuation_notification_unavailable', 409, operation, sessionID);
    if (type === 'user' && pending.some(item => item.id !== messageID)) return {kind:'blocked',messageID};
    return { kind: 'pending', messageID, location: 'queued' };
  }
  if (message.sessionID !== sessionID || message.message.type !== type) throw new HostRefusal('native_continuation_notification_unavailable', 409, operation, sessionID);
  const following = await runControllerEffect(store.messages({ sessionID, cursor: { id: messageID, direction: 'next' }, order: 'asc', limit: 10_001 }));
  if (following.length > 10_000) throw new HostRefusal('native_continuation_sequence_unbounded', 409, operation, sessionID);
  const assistantIndex = following.findIndex(item => item.type === 'assistant');
  // Shell cleanup proves consumption only. Primary input must still own the
  // next assistant: an intervening input cannot inherit its objective.
  if (assistantIndex >= 0 && (type === 'synthetic'
    || !following.slice(0, assistantIndex).some(item => ['user', 'synthetic', 'compaction'].includes(item.type)))) {
    return { kind: 'consumed', messageID, assistantMessageID: following[assistantIndex].id };
  }
  if (following.some(item => ['user', 'synthetic', 'compaction'].includes(item.type))) return { kind: 'blocked', messageID };
  if ((await runControllerEffect(inbox.list(sessionID))).some(item => item.id !== messageID)) return { kind: 'blocked', messageID };
  return { kind: 'pending', messageID, location: 'promoted' };
}
export const observeOwnedShellNotification = (store: Pick<SessionStore.Interface, 'message' | 'messages'>,
  inbox: Pick<SessionInbox.Interface, 'list'>, input: { readonly sessionID: string; readonly messageID: string }) =>
  observeOwnedInput(store, inbox, input, 'synthetic', 'shell.continue');
export const observeOwnedPrimaryInput = (store: Pick<SessionStore.Interface, 'message' | 'messages'>,
  inbox: Pick<SessionInbox.Interface, 'list'>, input: { readonly sessionID: string; readonly messageID: string }) =>
  observeOwnedInput(store, inbox, input, 'user', 'primary.continue');

/** A deferred wake never reconstructs a completed native turn from history. */
export function observeDeferredNativeWake(inbox: Pick<SessionInbox.Interface, 'list'>,
  execution: Pick<SessionExecution.Interface, 'isActive'>, sessionID: SessionSchema.ID): Effect.Effect<'pending' | 'idle' | 'active'> {
  return Effect.gen(function* () {
    if ((yield* inbox.list(sessionID)).length) return 'pending';
    return (yield* execution.isActive(sessionID)) ? 'active' : 'idle';
  });
}

/** Host-only child route. The supplied create must be the decorated service. */
export async function createChildThroughSession(service: Pick<Session.Interface, 'get' | 'create'>,
  input: Parameters<Session.Interface['create']>[0], expectedDirectory?: string): Promise<SessionSchema.Info> {
  const permit = requestPermit();
  if (!input.parentID || !permit || permit.sessionID !== input.parentID) {
    throw new HostRefusal('native_child_capability_required', 403, 'session.create', input.parentID);
  }
  const parent = await runControllerEffect(service.get(input.parentID));
  if (expectedDirectory !== undefined && parent.location.directory !== expectedDirectory) {
    throw new HostRefusal('native_session_directory_mismatch', 403, 'session.create', input.parentID);
  }
  const child = await runControllerEffect(service.create(input).pipe(Effect.provideService(OperationPermitRef, permit)));
  if (child.parentID !== input.parentID || child.location.directory !== parent.location.directory || (input.id && child.id !== input.id)) {
    throw new HostRefusal('native_child_identity_mismatch', 409, 'session.create', input.parentID);
  }
  return child;
}

/** These decorators are host graph nodes, never removable plugin hooks. */
export function createAdmissionGates(options: AdmissionGateOptions) {
  let startupClosed = true;
  let permanentlyClosed = false;
  let execution: SessionExecution.Interface | undefined;
  let executionScope: Scope.Scope | undefined;
  const resumeAdmissions = new Map<string, Deferred.Deferred<void, unknown>>();
  const wakeAdmissions = new Map<string, Deferred.Deferred<void, unknown>>();
  let jobs: Job.Interface | undefined;
  let sessions: Session.Interface | undefined;
  let store: SessionStore.Interface | undefined;
  let inbox: Context.Service.Shape<typeof SessionInbox.Service> | undefined;
  let removalSession: Session.Interface | undefined;
  let notificationBus: Bus.Interface | undefined;
  let removalDatabase: Database.Interface | undefined;
  const startupWaiters = new Set<() => void>();
  const bridge = options.bridge;
  const queuedDependencies=()=>{
    if(!store||!removalDatabase||!execution||!inbox)throw new HostRefusal('native_queued_input_blocked',409,'queued.input.publish');
    return {store,database:removalDatabase,execution,inbox};
  };
  const checked = <A>(action: () => Promise<A>, operation: string, sessionID?: string): Effect.Effect<A> =>
    Effect.tryPromise({ try: action, catch: (error) => error }).pipe(Effect.catch((error) =>
      refuseHost(error instanceof HostRefusal ? error : new HostRefusal('native_owner_unavailable', 503, operation, sessionID))));
  const commandDerivation = createCommandDerivation({ bridge, checked,reviewedBehaviorCommands:options.reviewedBehaviorCommands,
    reviewedConfigurationForDirectory: options.reviewedConfigurationForDirectory,beforeConfiguredCommand:options.beforeConfiguredCommand });
  const ready = (operation: string, sessionID?: string): Effect.Effect<void> => startupClosed
    ? refuseHost(new HostRefusal('native_startup_held', 409, operation, sessionID)) : Effect.void;
  const recheck = (permit: OperationPermit, request: OperationRequest): Effect.Effect<void> =>
    ready(request.operation, request.sessionID).pipe(Effect.andThen(checked(() => bridge.recheck(permit, request), request.operation, request.sessionID)));
  const operation = <A, E, R>(request: OperationRequest, action: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      const transfer = request.operation === 'runner.drain' && record(request.input)
        ? (request.input.force === true ? resumeAdmissions : request.input.force === false ? wakeAdmissions : undefined)?.get(request.sessionID ?? '') : undefined;
      yield* ready(request.operation, request.sessionID);
      const inherited = (yield* OperationPermitRef) ?? requestPermit();
      const permit = yield* checked(() => bridge.authorize({ ...request, ...(inherited ? { existingPermit: inherited } : {}) }), request.operation, request.sessionID)
        .pipe(Effect.onExit(exit => transfer && Exit.isFailure(exit) ? Deferred.failCause(transfer, exit.cause) : Effect.void));
      const admitted = ready(request.operation, request.sessionID).pipe(
        Effect.andThen(transfer ? Deferred.succeed(transfer, undefined) : Effect.void), Effect.andThen(action));
      if (inherited && permit.token === inherited.token) return yield* admitted.pipe(Effect.provideService(OperationPermitRef, permit));
      return yield* Effect.acquireUseRelease(
        Effect.succeed(permit),
        (permit) => admitted.pipe(Effect.provideService(OperationPermitRef, permit)),
        (permit) => checked(() => bridge.release(permit), 'permit.release', request.sessionID),
      );
    });
  const permitFor = (request: OperationRequest): Effect.Effect<OperationPermit> => Effect.gen(function* () {
    const permit = yield* OperationPermitRef;
    if (!permit) return yield* refuseHost(new HostRefusal('native_permit_required', 403, request.operation, request.sessionID));
    yield* recheck(permit, request);
    return permit;
  });
  const mutate = <A, E, R>(name: string, sessionID: string | undefined, input: unknown, action: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const derivation = yield* commandDerivation.requestMarker();
      // Clear it before native hooks execute. A hook cannot consume or reuse the
      // executor's one prompt authority through an inherited Effect context.
      return yield* operation({ operation: name, ...(sessionID === undefined ? {} : { sessionID }), input,
        ...(derivation && ['session.prompt', 'session.switchAgent', 'session.switchModel'].includes(name) ? { derivation } : {}) },
        commandDerivation.clear(action));
    });
  const assertReviewedCommand = (input: NativeSlimCommandInput) => Effect.gen(function* () {
    const sessionID = input.invocation.sessionID;
    const derivation = yield* commandDerivation.requestMarker();
    const permit = yield* OperationPermitRef;
    if (!derivation || !permit || !sessions) return yield* refuseHost(new HostRefusal('native_command_derivation_required', 403, 'session.command.effect', sessionID));
    const session = yield* sessions.get(sessionID);
    if (session.location.directory !== input.directory) return yield* refuseHost(new HostRefusal('native_session_directory_mismatch', 403, 'session.command.effect', sessionID));
    yield* recheck(permit, { operation: 'session.command.effect', sessionID, derivation, input: { name: input.name, invocation: input.invocation } });
    return { permit, derivation };
  });
  const executeReviewedCommand: NativeSlimCommandOptions['executeCommand'] = input => Effect.gen(function* () {
    yield* assertReviewedCommand(input);
    if (!sessions || input.parts.some(part => part.type !== 'text' || typeof part.text !== 'string')) {
      return yield* refuseHost(new HostRefusal('native_command_parts_unreviewed', 403, 'session.command', input.invocation.sessionID));
    }
    // Preserve original files, role/skill references and delivery. Only the
    // reviewed command's text expansion changes the accepted prompt.
    yield* sessions.prompt({ ...input.invocation.prompt, sessionID: input.invocation.sessionID,
      text: input.parts.map(part => part.text).join('\n'), delivery: input.invocation.delivery });
  });
  type CompletionJob = Pick<Job.Info, 'id' | 'type' | 'title' | 'status' | 'output' | 'error' | 'metadata' | 'notificationID'>;
  const shellCompletion = (sessionID: string, jobID: string): Effect.Effect<CompletionJob | undefined> => Effect.gen(function* () {
    if (!jobs) return undefined;
    const live = yield* jobs.get(jobID);
    if (live) return live;
    // The pinned Job registry is process-local; the actual native background
    // marker preserves the terminal result and notification identity on restart.
    const marker = (yield* jobs.pendingBackground).find(item => item.id === jobID && item.recovery.kind === 'shell'
      && item.recovery.sessionID === sessionID);
    if (!marker || marker.recovery.kind !== 'shell') return undefined;
    return { id: marker.id, type: 'shell', title: marker.recovery.command, status: marker.status,
      output: marker.output, error: marker.error, notificationID: marker.notificationID,
      metadata: { sessionID: marker.recovery.sessionID, shellID: marker.recovery.shellID } };
  });

  const pluginCatalogs = new Map<string, Plugin.Interface>();
  const toolCatalogs = new Map<string, Tool.Interface>();
  const modelCatalogs = new Map<string, Model.Interface>();
  const locationKey = (location: Location.Interface) => JSON.stringify([location.directory, location.workspaceID ?? null,
    location.project.id, location.project.directory, location.project.canonical]);
  const permissionOwners = new Map<string, { readonly assert: Permission.Interface['assert'] }>();
  type PermissionView = { readonly location: Location.Interface; readonly sessionID: string; readonly sessionIDs: ReadonlySet<string>;
    readonly current: () => boolean; active: boolean };
  // Private to this gate acquisition; neither SDK contexts nor stored data can
  // manufacture a permission view. A child fiber cannot retain it after settle.
  const PermissionViewRef = Context.Reference<object | undefined>('DevRyan/SkillPermissionView', { defaultValue: () => undefined });
  const permissionViews = new WeakMap<object, PermissionView>();
  const permissionView = (token: object) => Effect.suspend(() => {
    const view = permissionViews.get(token);
    return view ? checkPermissionView(view).pipe(Effect.as(view))
      : refuseHost(new HostRefusal('native_permission_location_expired', 409, 'permission.evaluate'));
  });
  const checkPermissionView = (view: PermissionView) => view.active && view.current()
    ? Effect.void : refuseHost(new HostRefusal('native_permission_location_expired', 409, 'permission.evaluate', view.sessionID));
  const skillRules = (rules: Permission.Ruleset, view: PermissionView) =>
    translateNativeSkillPermissionRules(rules, view.location.directory, options.reviewedSkillsForDirectory?.(view.location.directory) ?? []);
  const toolOwners = new Map<string, object>();
  const decorateTool = (inner: Tool.Interface, isCurrent: () => boolean): Tool.Interface => {
    const requireCurrent = () => isCurrent() ? Effect.void
      : refuseHost(new HostRefusal('native_tool_location_expired', 409, 'tool.execute'));
    const wrappers = new WeakMap<NativeExecutor, NativeExecutor>();
    const sealed = new WeakSet<NativeExecutor>();
    const wrap = (toolID: string, nativeToolID: string, executor: NativeExecutor, provenance: RegistrationOrigin | undefined, permission: { readonly assert: Permission.Interface['assert'] } | undefined, location: Location.Interface | undefined): NativeExecutor => {
      const executeNative = wrappers.get(executor) ?? executor;
      const execute: NativeExecutor = (input: unknown, nativeContext) => {
        if (!provenance || !location || toolID === 'execute' || provenance.id === 'opencode.tool.subagent') {
          return Effect.fail(new Tool.Error({ message: `DevRyan tool unavailable: ${toolID}` }));
        }
        const request = { operation: 'tool.execute', sessionID: nativeContext.sessionID, messageID: nativeContext.messageID,
          input: { toolID, ...(nativeToolID === toolID ? {} : { nativeToolID }), callID: nativeContext.id, provenance, input } };
        return operation(request, Effect.gen(function* () {
          yield* requireCurrent();
          const current = yield* inner.list();
          if (!current.some((entry) => effectiveID(entry) === toolID && entry.id === nativeToolID && entry.execute === execute)) {
            return yield* new Tool.Error({ message: `DevRyan tool registration expired: ${toolID}` });
          }
          const permit = yield* permitFor(request);
          yield* requireCurrent();
          return yield* options.executeOwned({ toolID, ...(nativeToolID === toolID ? {} : { nativeToolID }), provenance, input, nativeContext, location: Object.freeze({ ...location, project: Object.freeze({ ...location.project }) }), existingPermit: permit,
            nativePermissionAssert: input => Effect.suspend(() => {
              if (!permission || permissionOwners.get(locationKey(location)) !== permission) {
                return refuseHost(new HostRefusal('native_permission_owner_unavailable', 503, 'tool.permission', nativeContext.sessionID));
              }
              return requireCurrent().pipe(Effect.andThen(permission.assert(input)));
            }),
            recheckPermit: () => requireCurrent().pipe(Effect.andThen(recheck(permit, request)), Effect.andThen(requireCurrent)),
            executeNative: () => requireCurrent().pipe(Effect.andThen(() => executeNative(input, nativeContext))) });
        }));
      };
      wrappers.set(execute, executeNative);
      sealed.add(execute);
      return execute;
    };
    const copy = (tool: ToolSchema.Info & { readonly id: string }) => Object.freeze({ ...tool, options: Object.freeze(directOptions(tool.options)) });
    const editor = (innerEditor: Tool.Editor, provenance: RegistrationOrigin | undefined, permission: { readonly assert: Permission.Interface['assert'] } | undefined, location: Location.Interface | undefined): Tool.Editor => ({
      list: () => innerEditor.list().map(copy), get: (id) => { const tool = innerEditor.get(id); return tool && copy(tool); },
      namespace: innerEditor.namespace,
      add: (tool) => {
        if (effectiveID(tool) === 'execute' || provenance?.id === 'opencode.tool.subagent') return;
        innerEditor.add({ ...tool, options: directOptions(tool.options), execute: wrap(effectiveID(tool), effectiveName(tool), tool.execute, provenance, permission, location) });
      },
      update: (id, update) => innerEditor.update(id, (tool) => {
        update(tool);
        tool.options = directOptions(tool.options);
        Object.defineProperty(tool, 'execute', { value: wrap(effectiveID(tool), effectiveName(tool), tool.execute, provenance, permission, location), writable: false, configurable: false, enumerable: true });
        Object.freeze(tool.options);
      }),
      remove: innerEditor.remove,
    });
    return Tool.Service.of({
      transform: (callback) => Effect.gen(function* () {
        const provenance = yield* RegistrationOriginRef;
        yield* requireCurrent();
        const location = Option.getOrUndefined(Context.getOption(yield* Effect.context(), Location.Service));
        // Only the mandatory host node can lend its narrow assertion callback.
        // An SDK plugin cannot supply a Permission service through its context.
        const permission = location ? permissionOwners.get(locationKey(location)) : undefined;
        return yield* inner.transform((value) => callback(editor(value, provenance, permission, location)));
      }), reload: inner.reload,
      list: () => inner.list().pipe(Effect.map((tools) => tools.map(copy))),
      snapshot: (permissions) => Effect.gen(function* () {
        yield* requireCurrent();
        const tools = yield* inner.list();
        if (tools.some((tool) => !sealed.has(tool.execute) || tool.options?.codemode !== false)) {
          return yield* refuseHost(new HostRefusal('native_tool_registry_unsealed', 403, 'tool.snapshot'));
        }
        const snapshot = yield* inner.snapshot([...(permissions ?? []), { action: 'execute', resource: '*', effect: 'deny' }]);
        return { definitions: snapshot.definitions.filter((definition) => definition.name !== 'execute'),
          execute: (input) => input.call.name === 'execute'
            ? Effect.fail(new Tool.Error({ message: 'DevRyan Code Mode is disabled' })) : snapshot.execute(input) } satisfies Tool.Snapshot;
      }),
    });
  };
  const OwnedInterrupt = Context.Reference<boolean>('DevRyan/OwnedInterrupt', { defaultValue: () => false });
  const OwnedRemovalInterrupt = Context.Reference<ReadonlySet<string> | undefined>('DevRyan/OwnedRemovalInterrupt', { defaultValue: () => undefined });
  const decorateSession = (inner: Session.Interface): Session.Interface => {
    removalSession = inner;
    const decorated = Session.Service.of({
    ...inner,
    create: (input) => mutate('session.create', input.parentID, input, inner.create(input)),
    fork: (input) => mutate('session.fork', input.sessionID, input, inner.fork(input)),
    environment: (input) => input.variables === undefined ? inner.environment(input) : mutate('session.environment', input.sessionID, input, inner.environment(input)),
    view: (input) => mutate('session.view', input.sessionID, input, inner.view(input)),
    remove: id => refuseHost(new HostRefusal('native_owned_lifecycle_required', 403, 'session.remove', id)),
    cancelInbox: (input) => mutate('session.cancelInbox', input.sessionID, input, inner.cancelInbox(input)),
    steerInbox: (input) => mutate('session.steerInbox', input.sessionID, input, inner.steerInbox(input)),
    queueInbox: (input) => mutate('session.queueInbox', input.sessionID, input, inner.queueInbox(input)),
    switchAgent: (input) => mutate('session.switchAgent', input.sessionID, input, inner.switchAgent(input)),
    switchModel: (input) => mutate('session.switchModel', input.sessionID, input, inner.switchModel(input)),
    rename: (input) => mutate('session.rename', input.sessionID, input, inner.rename(input)),
    setMetadata: (input) => mutate('session.setMetadata', input.sessionID, input, inner.setMetadata(input)),
    setPermissions: (input) => mutate('session.setPermissions', input.sessionID, input, inner.setPermissions(input)),
    move: (input) => mutate('session.move', input.sessionID, input, inner.move(input)),
    prompt: (input) => { const request = { ...input, id: input.id ?? SessionMessage.ID.create() }; return mutate('session.prompt', input.sessionID, request, inner.prompt(request)); },
    generate: (input) => mutate('session.generate', input.sessionID, input, inner.generate(input)),
    command: (input) => mutate('session.command', input.sessionID, input, inner.command(input)),
    shell: (input) => mutate('session.shell', input.sessionID, input, inner.shell(input)),
    skill: (input) => mutate('session.skill', input.sessionID, input, inner.skill(input)),
    compact: (input) => mutate('session.compact', input.sessionID, input, inner.compact(input)),
    background: (id) => mutate('session.background', id, undefined, inner.background(id)),
    resume: (id) => mutate('session.resume', id, undefined, inner.resume(id)),
    interrupt: (id, input) => mutate(input?.resume === true ? 'session.interrupt.resume' : 'session.interrupt', id, input,
      inner.interrupt(id, input).pipe(Effect.provideService(OwnedInterrupt, true))),
    synthetic: (input) => Effect.gen(function* () {
      const jobID = input.metadata?.jobID;
      if (!jobs || typeof jobID !== 'string' || input.metadata?.source !== 'shell') {
        return yield* refuseHost(new HostRefusal('native_completion_owner_required', 403, 'session.synthetic', input.sessionID));
      }
      const nativeJob = yield* shellCompletion(input.sessionID, jobID);
      if (!nativeJob || nativeJob.status === 'running' || nativeJob.metadata?.sessionID !== input.sessionID
        || nativeJob.metadata?.shellID !== jobID || nativeJob.notificationID !== input.id) {
        return yield* refuseHost(new HostRefusal('native_completion_receipt_invalid', 403, 'session.synthetic', input.sessionID));
      }
      const sealedInput = { ...input, nativeJob };
      const request = { operation: 'session.synthetic', sessionID: input.sessionID, messageID: input.id, input: sealedInput };
      return yield* operation(request, Effect.gen(function* () {
        const permit = yield* permitFor(request);
        const metadata = yield* checked(() => bridge.sealSynthetic(permit, sealedInput), 'synthetic.seal', input.sessionID);
        return yield* inner.synthetic({ ...input, metadata: { ...metadata }, resume: false });
      }));
    }),
    revert: {
      stage: (input) => mutate('session.revert.stage', input.sessionID, input, inner.revert.stage(input)),
      clear: (id) => mutate('session.revert.clear', id, undefined, inner.revert.clear(id)),
      commit: (id) => mutate('session.revert.commit', id, undefined, inner.revert.commit(id)),
    },
    });
    sessions = decorated;
    return decorated;
  };
  const decorateExecution = (inner: SessionExecution.Interface): SessionExecution.Interface => {
    const activity = options.executionActivity?.(inner);
    if (activity) inner = { ...inner, active: activity.active, isActive: activity.isActive };
    execution = inner;
    return SessionExecution.Service.of({ ...inner,
      resume: (id) => mutate('execution.resume', id, undefined, inner.resume(id)),
      wake: (id) => Effect.gen(function* () {
        if (startupClosed || (yield* checked(() => bridge.isHeld(id), 'execution.wake', id))) {
          yield* checked(() => bridge.deferContinuation(id, 'execution.wake'), 'execution.defer', id);
          return;
        }
        return yield* mutate('execution.wake', id, undefined, inner.wake(id));
      }),
      interrupt: (id, input) => Effect.gen(function* () {
        if ((yield* OwnedRemovalInterrupt)?.has(id)) return yield* inner.interrupt(id, input);
        if (yield* OwnedInterrupt) return yield* inner.interrupt(id, input);
        return yield* mutate(input?.resume === true ? 'execution.interrupt.resume' : 'execution.interrupt', id, input, inner.interrupt(id, input));
      }),
    });
  };
  type InboxService = Context.Service.Shape<typeof SessionInbox.Service>;
  const decorateInbox = (inner: InboxService): InboxService => SessionInbox.Service.of({ ...inner,
    reconcile: (input) => Effect.gen(function* () {
      const permit = yield* permitFor({ operation: 'inbox.reconcile', sessionID: input.sessionID, messageID: input.id, input });
      const accepted = yield* inner.reconcile(input);
      if (accepted) yield* checked(() => bridge.verifyAccepted(permit, accepted), 'inbox.verify', input.sessionID);
      return accepted;
    }),
    admit: (input) => Effect.gen(function* () {
      const { permit, accepted } = yield* SessionInbox.serialized(input.sessionID, Effect.gen(function* () {
        const permit = yield* permitFor({ operation: 'inbox.admit', sessionID: input.sessionID, messageID: input.id, input });
        yield* checked(() => bridge.verifyAccepted(permit, { item: input, phase: 'preflight' }), 'inbox.seal', input.sessionID);
        const accepted=yield* inner.admit(input).pipe(Effect.catchDefect(error=>{
          if(!(error instanceof HostRefusal)||error.code!=='native_queued_input_blocked'||!bridge.queuedAdmissionRejected)return Effect.die(error);
          return checked(()=>bridge.queuedAdmissionRejected!(permit,input.id),'queued.input.reject',input.sessionID).pipe(Effect.andThen(Effect.die(error)));
        }));
        const session=isQueuedPrimaryInput(input.item)?yield* store?.get(input.sessionID)??Effect.die('native_session_unavailable'):undefined;
        if(isQueuedPrimaryInput(input.item)&&!session)return yield* refuseHost(new HostRefusal('native_session_unavailable',503,'inbox.admit',input.sessionID));
        if(isQueuedPrimaryInput(input.item)&&session&&!session.parentID) {
          if(!bridge.queuedAdmissionCommitted)return yield* refuseHost(new HostRefusal('native_queued_admission_unverified',503,'inbox.admit',input.sessionID));
          // Enqueue is committed and its DB transaction is closed. Keep the
          // original inbox mutex until the existing primary owner has admitted
          // the exact objective, so an older runner cannot promote it early.
          yield* checked(()=>bridge.queuedAdmissionCommitted!({directory:session.location.directory,sessionID:input.sessionID,messageID:input.id,item:input.item}),'queued.input.admit',input.sessionID);
        }
        return {permit,accepted};
      }));
      // The committed observer may synchronously reconcile this exact notice
      // through the controller. Release its native inbox lock before that RPC;
      // the owner still rechecks this live permit and its durable hold revision.
      yield* checked(() => bridge.verifyAccepted(permit, { item: accepted, phase: 'committed' }), 'inbox.verify', input.sessionID);
      return accepted;
    }),
    admitCompaction: (input) => mutate('inbox.compaction', input.sessionID, input, inner.admitCompaction(input)),
    cancel: (input) => mutate('inbox.cancel', input.sessionID, input, inner.cancel(input)),
    steer: (input) => mutate('inbox.steer', input.sessionID, input, inner.steer(input)),
    queue: (input) => mutate('inbox.queue', input.sessionID, input, inner.queue(input)),
  });
  const decorateHooks = (inner: PluginHooks.Interface): PluginHooks.Interface => PluginHooks.Service.of({ ...inner,
    trigger: (domain, name, event) => inner.trigger(domain, name, event).pipe(Effect.tap((result) => {
      if (domain !== 'session' || name !== 'prompt') return Effect.void;
      if (!isPrompt(result)) return refuseHost(new HostRefusal('native_prompt_hook_invalid', 403, 'session.prompt.seal'));
      return Effect.gen(function* () {
        const permit = yield* permitFor({ operation: 'session.prompt.seal', sessionID: result.sessionID, messageID: result.messageID, input: result });
        result.metadata = { ...(yield* checked(() => bridge.sealPrompt(permit, result), 'session.prompt.seal', result.sessionID)) };
      });
    })),
  });
  const overrides: LayerNode.Replacements = [
    Permission.node.replace(Permission.node.mapLayer(layer => Layer.effect(Permission.Service, Effect.gen(function* () {
      const inner = yield* Permission.Service;
      const capturedLocation = Option.getOrUndefined(Context.getOption(yield* Effect.context(), Location.Service));
      const location = capturedLocation && Object.freeze({ ...capturedLocation, project: Object.freeze({ ...capturedLocation.project }) });
      const key = location && locationKey(location);
      let closed = false;
      const owner: { readonly assert: Permission.Interface['assert'] } = { assert: input => scoped(input, inner.assert(input)) };
      const scoped = <A, E, R>(input: Permission.AssertInput, action: Effect.Effect<A, E, R>, sessionIDs: ReadonlySet<string> = new Set([input.sessionID])): Effect.Effect<A, E, R> => Effect.suspend(() => {
        if (!location || !key || closed || permissionOwners.get(key) !== owner)
          return refuseHost(new HostRefusal('native_permission_location_expired', 409, 'permission.evaluate', input.sessionID));
        const view: PermissionView = { location, sessionID: input.sessionID, sessionIDs, active: true,
          current: () => !closed && permissionOwners.get(key) === owner };
        const token = Object.freeze({});
        permissionViews.set(token, view);
        return action.pipe(Effect.provideService(PermissionViewRef, token),
          Effect.ensuring(Effect.sync(() => { view.active = false; permissionViews.delete(token); })));
      });
      if (key) permissionOwners.set(key, owner);
      yield* Effect.addFinalizer(() => Effect.sync(() => {
        closed = true;
        if (key && permissionOwners.get(key) === owner) permissionOwners.delete(key);
      }));
      return Permission.Service.of({ ...inner, assert: owner.assert, ask: input => scoped(input, inner.ask(input)), reply: input => Effect.gen(function* () {
        const pending = yield* inner.get(input.requestID);
        if (!pending) return yield* inner.reply(input);
        // Native 'always' replies reevaluate other pending sessions in this
        // location. Bind only IDs from the original native pending registry.
        const sessions = new Set((yield* inner.list()).map(request => request.sessionID));
        sessions.add(pending.sessionID);
        return yield* mutate('permission.reply', pending.sessionID, { ...input,
          pending: { sessionID: pending.sessionID, source: pending.source, action: pending.action, resources: pending.resources } }, scoped(pending, inner.reply(input), sessions));
      }) });
    })).pipe(Layer.provide(layer)))),
    PermissionSaved.node.replace(PermissionSaved.node.mapLayer(layer => Layer.effect(PermissionSaved.Service, Effect.gen(function* () {
      const inner = yield* PermissionSaved.Service;
      return PermissionSaved.Service.of({ ...inner, list: input => Effect.gen(function* () {
        const token = yield* PermissionViewRef;
        if (!token) return yield* inner.list(input);
        const view = yield* permissionView(token);
        if (input?.projectID !== view.location.project.id)
          return yield* refuseHost(new HostRefusal('native_permission_project_mismatch', 403, 'permission.evaluate', view.sessionID));
        const rows = yield* inner.list(input);
        yield* checkPermissionView(view);
        return rows.flatMap(row => {
          if (row.projectID !== view.location.project.id) throw new HostRefusal('native_permission_project_mismatch', 403, 'permission.evaluate', view.sessionID);
          return skillRules([{ action: row.action, resource: row.resource, effect: 'allow' }], view)
            .map(rule => rule.action === row.action && rule.resource === row.resource ? row : { ...row, action: rule.action, resource: rule.resource });
        });
      }) });
    })).pipe(Layer.provide(layer)))),
    Form.node.replace(Form.node.mapLayer(layer => Layer.effect(Form.Service, Effect.gen(function* () {
      const inner = yield* Form.Service;
      return Form.Service.of({ ...inner,
        reply: input => Effect.gen(function* () { const pending = yield* inner.get(input.id);
          return yield* mutate('form.reply', pending.sessionID, { ...input, pending: { sessionID: pending.sessionID } }, inner.reply(input)); }),
        cancel: id => Effect.gen(function* () { const pending = yield* inner.get(id);
          return yield* mutate('form.cancel', pending.sessionID, { id, pending: { sessionID: pending.sessionID } }, inner.cancel(id)); }),
      });
    })).pipe(Layer.provide(layer)))),
    Job.node.replace(Job.node.mapLayer((layer) => Layer.effect(Job.Service, Effect.gen(function* () {
      const inner = yield* Job.Service; jobs = inner;
      const unavailable = () => refuseHost(new HostRefusal('native_job_owner_required', 403, 'job.mutate'));
      return Job.Service.of({ ...inner,
        start: input => Effect.gen(function* () {
          const sessionID = input.recovery?.kind === 'shell' ? input.recovery.sessionID : undefined;
          if (!sessionID || !input.id) return yield* unavailable();
          return yield* mutate('job.shell.start', sessionID, { jobID: input.id, type: input.type,
            command: input.title, recovery: input.recovery }, inner.start(input));
        }),
        background: id => Effect.gen(function* () {
          const permit = yield* OperationPermitRef;
          if (!permit?.sessionID) return yield* unavailable();
          return yield* mutate('job.shell.background', permit.sessionID, { jobID: id }, Effect.gen(function* () {
            const actual = yield* inner.background(id);
            if (actual) yield* checked(() => bridge.authorize({ operation: 'job.shell.background.commit', sessionID: permit.sessionID,
              existingPermit: permit, input: { jobID: id, notificationID: actual.notificationID } }).then(() => undefined), 'job.shell.background.commit', permit.sessionID);
            return actual;
          }));
        }),
        backgroundAll: unavailable,
        cancel: id => Effect.gen(function* () {
          // Native execution settlement calls cancel(sessionID), which is
          // usually not a Job ID. Preserve that read-only native no-op so its
          // Interrupted event can release the claim. Never call cancel after
          // an absent lookup: a newly registered job must remain untouched.
          if (!(yield* inner.get(id))) return undefined;
          return yield* unavailable();
        }),
        completeBackground: id => Effect.gen(function* () {
          const pending = yield* inner.pendingBackground;
          const marker = pending.find(item => item.notificationID === id && item.recovery.kind === 'shell');
          if (!marker || marker.recovery.kind !== 'shell') return yield* unavailable();
          return yield* mutate('job.shell.ack', marker.recovery.sessionID,
            { jobID: marker.id, notificationID: id }, inner.completeBackground(id));
        }),
      });
    })).pipe(Layer.provide(layer)))),
    Command.node.replace(Command.node.mapLayer(layer => Layer.effect(Command.Service, Effect.gen(function* () {
      const location = Option.getOrUndefined(Context.getOption(yield* Effect.context(), Location.Service));
      return commandDerivation.decorate(yield* Command.Service, location?.directory);
    })).pipe(Layer.provide(layer)))),
    Tool.node.replace(makeLocationNode({ service: Tool.Service,
      // Preserve native Tool wiring while resolving the final reviewed Model
      // dependency; a second Model replacement would erase provider adapters.
      deps: [LayerNode.group([Tool.node.mapLayer(layer => layer), Model.node, Location.node])],
      layer: Layer.effect(Tool.Service, Effect.gen(function* () {
        const inner = yield* Tool.Service;
        const models = yield* Model.Service;
        const location = yield* Location.Service;
        const key = location && locationKey(location), acquisition = {};
        let active = true;
        const guarded = decorateTool(inner, () => active && (!key || toolOwners.get(key) === acquisition));
        if (key && location) { toolOwners.set(key, acquisition); toolCatalogs.set(location.directory, guarded); modelCatalogs.set(location.directory, models); }
        yield* Effect.addFinalizer(() => Effect.sync(() => {
          active = false;
          if (key && toolOwners.get(key) === acquisition) toolOwners.delete(key);
          if (location && toolCatalogs.get(location.directory) === guarded) toolCatalogs.delete(location.directory);
          if (location && modelCatalogs.get(location.directory) === models) modelCatalogs.delete(location.directory);
        }));
        return guarded;
    })) })),
    Session.node.replace(makeGlobalNode({ service: Session.Service,
      // Capture the final Bus, including primary/Cursor/observation decorators,
      // without replacing its sole publication authority.
      deps: [LayerNode.group([Session.node.mapLayer(layer => layer), Bus.node])],
      layer: Layer.effect(Session.Service, Effect.gen(function* () {
        const inner = yield* Session.Service, bus = yield* Bus.Service;
        notificationBus = bus;
        yield* Effect.addFinalizer(() => Effect.sync(() => { if (notificationBus === bus) notificationBus = undefined; }));
        return decorateSession(inner);
      })) })),
    SessionExecution.node.replace(SessionExecution.node.mapLayer((layer) => Layer.effect(SessionExecution.Service, Effect.gen(function* () {
      executionScope = yield* Scope.Scope;
      return decorateExecution(yield* SessionExecution.Service);
    })).pipe(Layer.provide(layer)))),
    SessionInbox.node.replace(SessionInbox.node.mapLayer((layer) => Layer.effect(SessionInbox.Service, Effect.gen(function* () {
      const inner = yield* SessionInbox.Service; inbox = inner; return decorateInbox(inner);
    })).pipe(Layer.provide(layer)))),
    PluginHooks.node.replace(PluginHooks.node.mapLayer((layer) => Layer.effect(PluginHooks.Service, Effect.gen(function* () {
      let inner = yield* PluginHooks.Service;
      if (options.sessionHooks) {
        const location = Option.getOrUndefined(Context.getOption(yield* Effect.context(), Location.Service));
        if (!location) return yield* refuseHost(new HostRefusal('native_context_location_required', 503, 'session.context'));
        let current=true;
        yield* Effect.addFinalizer(()=>Effect.sync(()=>{current=false;}));
        const key=locationKey(location);
        const assertToolRead:AdmissionHookOwners['assertToolRead']=(event,target)=>Effect.gen(function*(){
          if(!current || !record(event) || typeof event.sessionID!=='string' || typeof event.messageID!=='string'
            || typeof event.id!=='string' || typeof event.tool!=='string' || typeof event.agent!=='string' || typeof target!=='string'
            || !store) return yield* refuseHost(new HostRefusal('native_tool_hook_scope_invalid',403,'tool.read'));
          const permit=yield* OperationPermitRef;
          if(!permit || permit.sessionID!==event.sessionID)return yield* refuseHost(new HostRefusal('native_tool_hook_scope_invalid',403,'tool.read'));
          const permission=permissionOwners.get(key);
          if(!permission)return yield* refuseHost(new HostRefusal('native_permission_location_expired',409,'tool.read'));
          const session=yield* store.get(SessionSchema.ID.make(event.sessionID));
          const message=yield* store.message(SessionMessage.ID.make(event.messageID));
          if(!session || session.location.directory!==location.directory || session.location.workspaceID!==location.workspaceID
            || session.projectID!==location.project.id || message?.sessionID!==event.sessionID || message.message.type!=='assistant'||message.message.agent!==event.agent||message.message.time.completed!==undefined
            || !message.message.content.some(part=>record(part) && part.type==='tool' && part.id===event.id && part.name===event.tool&&record(part.state)&&part.state.status==='running'))
            return yield* refuseHost(new HostRefusal('native_tool_hook_scope_invalid',403,'tool.read',event.sessionID));
          yield* permission.assert({sessionID:SessionSchema.ID.make(event.sessionID),agent:Agent.ID.make(event.agent),action:'read',resources:[target],
            source:{type:'tool',messageID:SessionMessage.ID.make(event.messageID),id:ToolSchema.CallID.make(event.id)}});
          if(!current || permissionOwners.get(key)!==permission)return yield* refuseHost(new HostRefusal('native_permission_location_expired',409,'tool.read'));
        }).pipe(Effect.orDie);
        inner = options.sessionHooks(inner, location,{assertToolRead});
      }
      return decorateHooks(options.providerHooks ? options.providerHooks(inner) : inner);
    })).pipe(Layer.provide(layer)))),
    Plugin.node.replace(Plugin.node.mapLayer((layer) => Layer.effect(Plugin.Service, Effect.gen(function* () {
      const inner = yield* Plugin.Service;
      const location = Option.getOrUndefined(Context.getOption(yield* Effect.context(), Location.Service));
      if(location) pluginCatalogs.set(location.directory,inner);
      return Plugin.Service.of({ ...inner, activate: (plugins, failures) => inner.activate(plugins.map((plugin) => {
        if (plugin.source?.type !== 'builtin' || plugin.revision !== 'internal') return plugin;
        const provenance = options.nativePlugins.get(plugin.id);
        return { ...plugin, effect: (context) => provenance ? provideRegistrationOrigin(provenance, plugin.effect(helperPluginContext(context)))
          : refuseHost(new HostRefusal('native_plugin_unreviewed', 403, 'plugin.activate')) };
      }), failures) });
    })).pipe(Layer.provide(layer)))),
    SessionRunnerLLM.node.replace(SessionRunnerLLM.node.mapLayer((layer) => Layer.effect(SessionRunner.Service, Effect.gen(function* () {
      const inner = yield* SessionRunner.Service;
      return SessionRunner.Service.of({ drain: (input) => mutate('runner.drain', input.sessionID, input, inner.drain(input).pipe(
        Effect.catchDefect(error=>{
          if(!(error instanceof HostRefusal)||error.code!=='native_queued_input_blocked')return Effect.die(error);
          return Effect.gen(function*(){
            const permit=yield* OperationPermitRef;
            if(!permit||!bridge.queuedBlocked)return yield* Effect.die(error);
            yield* checked(()=>bridge.queuedBlocked!(permit,input.sessionID),'queued.input.defer',input.sessionID);
            return SessionRunner.DrainResult.Complete();
          });
        })) ) });
    })).pipe(Layer.provide(layer)))),
    SessionStore.node.replace(SessionStore.node.mapLayer((layer) => Layer.effect(SessionStore.Service, Effect.gen(function* () {
      const inner = yield* SessionStore.Service;
      if (options.captureSessionStore) yield* options.captureSessionStore(inner);
      store = inner;
      return SessionStore.Service.of({ ...inner, get: id => Effect.gen(function* () {
        const token = yield* PermissionViewRef;
        if (!token) return yield* inner.get(id);
        const view = yield* permissionView(token);
        if (!view.sessionIDs.has(id))
          return yield* refuseHost(new HostRefusal('native_permission_session_mismatch', 403, 'permission.evaluate', id));
        const session = yield* inner.get(id);
        yield* checkPermissionView(view);
        if (!session) return session;
        if (session.location.directory !== view.location.directory || session.location.workspaceID !== view.location.workspaceID
          || session.projectID !== view.location.project.id)
          return yield* refuseHost(new HostRefusal('native_permission_session_mismatch', 403, 'permission.evaluate', id));
        if (!session.permissions) return session;
        const rules = skillRules(session.permissions, view);
        return rules.length === session.permissions.length && rules.every((rule, index) => rule === session.permissions![index])
          ? session : { ...session, permissions: rules };
      }), claim: (id) => mutate('store.claim', id, undefined, inner.claim(id)),
        countResume: (id) => mutate('store.countResume', id, undefined, inner.countResume(id)),
        releaseChildClaims: (ids) => mutate('store.releaseChildClaims', undefined, ids, inner.releaseChildClaims(ids)) });
    })).pipe(Layer.provide(layer)))),
    SessionRestart.node.replace(SessionRestart.node.mapLayer((layer) => Layer.effect(SessionRestart.Service, Effect.gen(function* () {
      const inner = yield* SessionRestart.Service;
      return SessionRestart.Service.of({ resumeSuspendedSessions: checked(async () => {
        await bridge.awaitReady();
        if (startupClosed) await new Promise<void>((resolve) => startupWaiters.add(resolve));
      }, 'restart.hydrate').pipe(Effect.andThen(mutate('restart.resume', undefined, undefined, inner.resumeSuspendedSessions))) });
    })).pipe(Layer.provide(layer)))),
  ];
  const stop = async (sessionID: string) => {
    if (!execution) throw new HostRefusal('native_execution_unavailable', 503, 'session.hold', sessionID);
    const id = SessionSchema.ID.make(sessionID);
    try {
      await runControllerEffect(execution.interrupt(id, { awaitSettlement: true }).pipe(Effect.timeout('30 seconds')));
      await runControllerEffect(execution.awaitIdle(id).pipe(Effect.timeout('30 seconds')));
      if (await runControllerEffect(execution.isActive(id))) throw new Error('Native execution remained active');
    } catch {
      throw new HostRefusal('native_settlement_uncertain', 409, 'session.hold', sessionID);
    }
  };
  const recoverShellOwned = async ({ sessionID, jobID }: { readonly sessionID: string; readonly jobID: string }): Promise<void> => {
    if (!sessions || !jobs) throw new HostRefusal('native_completion_owner_unavailable', 503, 'shell.recover', sessionID);
    const id = SessionSchema.ID.make(sessionID), nativeJob = await runControllerEffect(shellCompletion(sessionID, jobID));
    if (!nativeJob || nativeJob.status === 'running' || !nativeJob.notificationID || !nativeJob.title) {
      throw new HostRefusal('native_completion_receipt_invalid', 409, 'shell.recover', sessionID);
    }
    const text = `<shell id="${nativeJob.id}" state="${nativeJob.status}" command="${nativeJob.title}">\n${nativeJob.status === 'completed'
      ? nativeJob.output ?? 'Command completed' : nativeJob.status === 'error' ? nativeJob.error ?? 'Command failed' : 'Cancelled'}\n</shell>`;
    await runControllerEffect(sessions.synthetic({ sessionID: id, id: nativeJob.notificationID, description: nativeJob.title, text,
      metadata: { source: 'shell', jobID, shellID: jobID, state: nativeJob.status }, resume: false }));
    await runControllerEffect(mutate('job.shell.ack', sessionID, { jobID, notificationID: nativeJob.notificationID },
      jobs.completeBackground(nativeJob.notificationID)));
  };
  const removalObservation = async (sessionID: string) => {
    if (!removalDatabase || !store || !inbox || !execution) throw new HostRefusal('native_removal_observation_unavailable', 503, 'removal.inspect', sessionID);
    const db = removalDatabase.db.$client;
    const [rows, pending, queued, active] = await Promise.all([
      runControllerEffect(db.unsafe<{id:string;time_suspended:number|null}>('SELECT id,time_suspended FROM session_v2 WHERE id=?', [sessionID])),
      runControllerEffect(db.unsafe<{id:string}>('SELECT id FROM session_pending WHERE session_id=? ORDER BY admitted_seq LIMIT 10001', [sessionID])),
      runControllerEffect(db.unsafe<{id:string}>('SELECT id FROM session_inbox WHERE session_id=? ORDER BY enqueued_seq LIMIT 10001', [sessionID])),
      runControllerEffect(execution.isActive(SessionSchema.ID.make(sessionID))),
    ]);
    if (pending.length + queued.length > 10000) throw new HostRefusal('native_removal_inventory_unbounded',409,'removal.inspect',sessionID);
    return {sessionID,exists:rows.length===1,claimed:rows.length===1 && rows[0].time_suspended!==null,active,
      pendingIDs:pending.map(row=>row.id),inboxIDs:queued.map(row=>row.id)};
  };
  const withRemovalPermit = async <A>(request: OperationRequest, permit: OperationPermit, action:()=>Promise<A>):Promise<A> => {
    const authorized=await bridge.authorize({...request,existingPermit:permit});
    if(authorized.token!==permit.token) throw new HostRefusal('native_removal_capability_required',403,request.operation,request.sessionID);
    await bridge.recheck(permit,request);
    return action();
  };
  return { overrides,
    captureDatabase: <E,R>(layer: Layer.Layer<Database.Service,E,R>) => Layer.effect(Database.Service,Effect.gen(function*(){
      const database=yield* Database.Service; removalDatabase=database;return database;
    })).pipe(Layer.provide(layer)),
    controls: {
    queuedPrimaryIdleOwned:async({sessionID,messageID,permit}:{readonly sessionID:string;readonly messageID?:string;readonly permit:OperationPermit})=>withRemovalPermit({operation:'queued.input.inspect',sessionID,messageID},permit,async()=>{
      const dependencies=queuedDependencies();
      const row=await runControllerEffect(dependencies.store.get(SessionSchema.ID.make(sessionID)));
      if(!row)throw new HostRefusal('native_queued_input_blocked',409,'queued.input.inspect',sessionID);
      return runControllerEffect(assertQueuedInputIdle(dependencies,{sessionID,messageID:messageID??'',directory:row.location.directory,item:{type:'user',delivery:'queue',payload:{text:''}}},'enqueue'));
    }),
    prepareQueuedPublication:(events:readonly {readonly type:string;readonly data:unknown}[])=>Effect.gen(function*(){
      if(!events.some(event=>['session.inbox.enqueued','session.inbox.delivered'].includes(event.type)))return [];
      const dependencies=queuedDependencies();
      const witnesses=yield* queuedPublicationWitnesses(dependencies,events);
      for(const witness of witnesses){
        const delivered=events.some(event=>event.type==='session.inbox.delivered'&&record(event.data)&&event.data.inboxID===witness.messageID);
        if(delivered){
          if(!bridge.queuedDeliveryAuthorized)return yield* refuseHost(new HostRefusal('native_queued_admission_unverified',503,'queued.input.deliver',witness.sessionID));
          // Private owner work runs before the native Bus transaction, never
          // from its projector. Its awaited authorization cannot replace the
          // final transaction-local subtree check below.
          yield* checked(()=>bridge.queuedDeliveryAuthorized!(witness),'queued.input.deliver',witness.sessionID);
        }
        yield* assertQueuedInputIdle(dependencies,witness,delivered?'delivery':'enqueue');
      }
      return witnesses;
    }),
    assertQueuedPublication:(event:typeof SessionEvent.InboxEnqueued.Type|typeof SessionEvent.InboxDelivered.Type)=>Effect.gen(function*(){
      const witnesses=yield* QueuedInputWitnesses;
      const witness=witnesses.find(row=>row.sessionID===event.data.sessionID&&row.messageID===event.data.inboxID);
      if(witness)yield* assertQueuedInputIdle(queuedDependencies(),witness,event.type==='session.inbox.enqueued'?'enqueue':'delivery');
    }),
    wakeQueuedParents:(event:unknown)=>Effect.gen(function*(){
      if(!record(event)||!record(event.data)||typeof event.data.sessionID!=='string'
        ||!['session.execution.succeeded','session.execution.failed','session.execution.interrupted'].includes(String(event.type))
        ||!execution||!executionScope||!store||!inbox||!bridge.queuedWake)return;
      const id=SessionSchema.ID.make(event.data.sessionID),ownedExecution=execution,ownedStore=store,ownedInbox=inbox,ownedScope=executionScope;
      const wake=wakeQueuedInputParents({...queuedDependencies(),store:ownedStore,inbox:ownedInbox,execution:ownedExecution},id,sessionID=>checked(()=>bridge.queuedWake!(sessionID),'queued.input.wake',sessionID)).pipe(Effect.catchCause(cause=>Effect.logWarning('native_queued_wake_unavailable',Cause.pretty(cause))));
      yield* wake.pipe(Effect.forkIn(ownedScope));
    }),

    retentionOwned:async(input:{readonly sessionID:string;readonly permit:OperationPermit;readonly at?:number})=>{
      const request={operation:input.at===undefined?'retention.acquire':'retention.archive',sessionID:input.sessionID,...(input.at===undefined?{}:{input:{at:input.at}})};
      return withRemovalPermit(request,input.permit,async()=>{
        if(!store||!removalDatabase||!execution||!removalSession||!bridge.retention)throw new HostRefusal('native_retention_unavailable',503,request.operation,input.sessionID);
        return runControllerEffect(quietNativeRetention({store,database:removalDatabase,execution,session:removalSession,authorize:bridge.retention},input));
      });
    },
    observeRecoveredPublication:(events:readonly {readonly type:string;readonly data:unknown}[])=>Effect.gen(function*(){
      if(!inbox)return yield* refuseHost(new HostRefusal('native_recovered_input_unavailable',503,'recovered.input.publish'));
      const owned=inbox;
      const sessionIDs=[...new Set(events.map(event=>record(event.data)&&typeof event.data.sessionID==='string'?event.data.sessionID:undefined).filter((id):id is string=>id!==undefined))];
      const pending=yield* Effect.forEach(sessionIDs,sessionID=>owned.list(SessionSchema.ID.make(sessionID)));
      const database=removalDatabase;
      if(!database)return yield* refuseHost(new HostRefusal('native_recovered_input_unavailable',503,'recovered.input.publish'));
      const sequences=yield* Effect.forEach(sessionIDs,sessionID=>database.db.$client.unsafe<{id:string;enqueued_seq:number}>('SELECT id,enqueued_seq FROM session_inbox WHERE session_id=?',[sessionID]).pipe(Effect.orDie));
      return {events,pending:pending.flat().map(item=>{const encoded=Schema.encodeSync(SessionInbox.Info)(item);return {id:item.id,sessionID:item.sessionID,type:item.type,delivery:item.delivery,
        enqueuedSeq:sequences.flat().find(row=>row.id===item.id)?.enqueued_seq,payloadHash:recoveredInputHash({type:encoded.type,delivery:encoded.delivery,payload:encoded.payload})};})};
    }),
    dropRecoveredCancellationReceipts:(event:typeof SessionEvent.Deleted.Type)=>removalDatabase?dropRecoveredCancellationReceipts(removalDatabase,event):Effect.die('native_recovered_input_unavailable'),
    persistRecoveredCancellation:(event:typeof SessionEvent.InboxCancelled.Type)=>removalDatabase?persistRecoveredCancellation(removalDatabase,event):Effect.die('native_recovered_input_unavailable'),
    cancelRecoveredInputOwned:async({sessionID,messageID,payloadHash,enqueuedSeq,permit}:{sessionID:string;messageID:string;payloadHash:string;enqueuedSeq:number;cancellationReceiptVersion:1;permit:OperationPermit})=>{
      if(!inbox)throw new HostRefusal('native_recovered_input_unavailable',503,'recovered.input.cancel',sessionID);
      // The original cancellation service owns the inbox mutex. Its sole Bus
      // decorator checks the exact local payload under that same mutex.
      const request={operation:'recovered.input.cancel',sessionID,messageID,input:{id:messageID,payloadHash,enqueuedSeq}};
      return runControllerEffect(operation(request,inbox.cancel({sessionID:SessionSchema.ID.make(sessionID),id:SessionMessage.ID.make(messageID)}))
        .pipe(Effect.provideService(OperationPermitRef,permit),Effect.as({cancelled:true as const,messageID})));
    },
    inspectRemovalOwned: async ({sessionID,permit}:{readonly sessionID:string;readonly permit:OperationPermit}) => withRemovalPermit({operation:'removal.inspect',sessionID},permit,async()=>{
      if(!store) throw new HostRefusal('native_session_unavailable',503,'removal.inspect',sessionID);
      const all=await runControllerEffect(store.list({limit:10001}));
      if(all.length>10000) throw new HostRefusal('native_removal_tree_unbounded',409,'removal.inspect',sessionID);
      const ids=new Set<string>([sessionID]);
      for(let changed=true;changed;){changed=false;for(const row of all) if(row.parentID && ids.has(row.parentID) && !ids.has(row.id)){ids.add(row.id);changed=true;}}
      const members=all.filter(row=>ids.has(row.id)).map(row=>({id:row.id,parentID:row.parentID??null,directory:row.location.directory}));
      return {members,states:await Promise.all([...ids].map(removalObservation))};
    }),
    removeLeafOwned: async ({intentID,sessionID,permit}:{readonly intentID:string;readonly sessionID:string;readonly permit:OperationPermit})=>withRemovalPermit({operation:'removal.delete',sessionID,input:{intentID}},permit,async()=>{
      if(!store || !removalSession) throw new HostRefusal('native_session_unavailable',503,'removal.delete',sessionID);
      const nativeID=SessionSchema.ID.make(sessionID),inner=removalSession,ownedStore=store;
      return runControllerEffect(SessionInbox.serialized(nativeID,Effect.gen(function*(){
        const before=yield* checked(()=>removalObservation(sessionID),'removal.delete',sessionID);
        if(before.active || before.claimed) return yield* refuseHost(new HostRefusal('native_removal_settlement_uncertain',409,'removal.delete',sessionID));
        if((yield* ownedStore.list({parentID:nativeID})).length) return yield* refuseHost(new HostRefusal('native_removal_tree_changed',409,'removal.delete',sessionID));
        yield* checked(()=>bridge.recheck(permit,{operation:'removal.delete',sessionID,input:{intentID}}),'removal.delete',sessionID);
        if(before.exists) yield* inner.remove(nativeID).pipe(Effect.provideService(OwnedRemovalInterrupt,new Set([sessionID])));
        const after=yield* checked(()=>removalObservation(sessionID),'removal.delete',sessionID);
        if(after.exists || after.active || after.pendingIDs.length || after.inboxIDs.length) return yield* refuseHost(new HostRefusal('native_removal_unconfirmed',409,'removal.delete',sessionID));
        return {removed:true as const,sessionID};
      })));
    }),
    catalogTools: async (directory: string) => {
      const plugins = pluginCatalogs.get(directory);
      if (!plugins) throw new HostRefusal('native_catalog_unavailable', 503, 'catalog.plugins');
      await runControllerEffect(plugins.awaitActivation);
      const tools = toolCatalogs.get(directory);
      if (!tools) throw new HostRefusal('native_catalog_unavailable', 503, 'catalog.tools');
      return (await runControllerEffect(tools.list())).filter(tool => tool.name !== 'execute' && tool.name !== 'subagent').map(effectiveID);
    },
    catalogToolSnapshot: async (directory: string, model?: { readonly providerID: string; readonly modelID: string }) => {
      const plugins = pluginCatalogs.get(directory), tools = toolCatalogs.get(directory), models = modelCatalogs.get(directory);
      if (!plugins || !tools || (model && !models)) throw new HostRefusal('native_catalog_unavailable', 503, 'catalog.tools');
      const current = () => {
        if (permanentlyClosed || !plugins || !tools || pluginCatalogs.get(directory) !== plugins
          || toolCatalogs.get(directory) !== tools || (model && (!models || modelCatalogs.get(directory) !== models)))
          throw new HostRefusal('native_catalog_unavailable', 503, 'catalog.tools');
      };
      current();
      await runControllerEffect(plugins.awaitActivation);
      current();
      if (model && models && !await runControllerEffect(models.get(Provider.ID.make(model.providerID), Model.ID.make(model.modelID)))) {
        current();
        return undefined;
      }
      current();
      // Take IDs and definitions from one immutable native snapshot so a
      // registration update cannot mix two versions of the same catalog.
      const snapshot = await runControllerEffect(tools.snapshot());
      const entries = snapshot.definitions.filter(definition => definition.name !== 'execute' && definition.name !== 'subagent');
      const ids = entries.map(definition => definition.name);
      const definitions = model ? entries.map(definition => ({
          id: definition.name, description: definition.description, parameters: definition.inputSchema,
        })) : null;
      current();
      return { ids, definitions };
    },
    openStartup: async () => {
      if(permanentlyClosed) throw new HostRefusal('native_controller_stopping',409,'startup.open');
      await bridge.awaitReady();
      if(permanentlyClosed) throw new HostRefusal('native_controller_stopping',409,'startup.open');
      startupClosed = false; for (const resolve of startupWaiters) resolve(); startupWaiters.clear();
    },
    closePermanently: () => { permanentlyClosed=true;startupClosed=true; },
    closeStartup: () => { startupClosed = true; },
    createChild: async (input: Parameters<Session.Interface['create']>[0], expectedDirectory?: string): Promise<SessionSchema.Info> => {
      if (!sessions) throw new HostRefusal('native_session_unavailable', 503, 'session.create', input.parentID);
      return createChildThroughSession(sessions, input, expectedDirectory);
    },
    assertHelperTitleCAS:(event:typeof SessionEvent.Renamed.Type)=>assertNativeHelperTitle(removalDatabase,event),
    renameHelperTitleOwned:async(input:NativeHelperTitleInput&{readonly permit:OperationPermit})=>{
      if(!sessions)throw new HostRefusal('native_session_unavailable',503,'session.rename',input.sessionID);
      return runControllerEffect(sessions.rename({sessionID:SessionSchema.ID.make(input.sessionID),title:input.title}).pipe(Effect.provideService(OperationPermitRef,input.permit),Effect.provideService(NativeHelperTitleRef,input)));
    },
    interviewActionOwned:async(input:NativeInterviewAction&{readonly permit:OperationPermit})=>{
      const owned=sessions,raw=removalSession,bus=notificationBus;
      if(!owned||!raw)throw new HostRefusal('native_interview_session_unavailable',503,'interview',input.body.sessionID);
      return runControllerEffect(Effect.gen(function*(){
        const sessionID=SessionSchema.ID.make(input.body.sessionID);
        if(input.kind==='rename')return yield* owned.rename({sessionID,title:input.body.title});
        const id=SessionMessage.ID.make(input.body.id);
        if(input.kind==='continue'){
          yield* owned.switchAgent({sessionID,agent:Agent.ID.make('orchestrator')});
          yield* owned.prompt({sessionID,id,text:input.body.text});return;
        }
        if (!bus) return yield* refuseHost(new HostRefusal('native_notification_bus_unavailable',503,'session.synthetic',sessionID));
        const body={sessionID,id,text:input.body.text,resume:false as const};
        const request={operation:'session.synthetic',sessionID,messageID:id,input:body};
        yield* operation(request,Effect.gen(function*(){
          const permit=yield* permitFor(request);
          const metadata=yield* checked(()=>bridge.sealSynthetic(permit,body),'synthetic.seal',sessionID);
          yield* persistInterviewNotification({bus,sessions:raw,body,metadata,recheck:()=>recheck(permit,request)});
        }));
      }).pipe(Effect.provideService(OperationPermitRef,input.permit)));
    },
    assertReviewedCommand,
    executeReviewedCommand,
    interruptStoppedHandoff: (sessionID: string): Effect.Effect<void> => Effect.gen(function* () {
      if (!execution) return yield* refuseHost(new HostRefusal('native_execution_unavailable',503,'primary.step',sessionID));
      yield* permitFor({operation:'primary.step',sessionID});
      // This is the current execution's own handoff. Awaiting settlement here
      // would wait for this fiber itself; the original coordinator sets user
      // reason before scheduling its interruption.
      yield* execution.interrupt(SessionSchema.ID.make(sessionID));
    }),
    holdAndStop: async (sessionID: string) => {
      await bridge.hold(sessionID);
      await stop(sessionID);
    },
    quiesce: async (): Promise<readonly string[]> => {
      startupClosed = true;
      if (!execution) throw new HostRefusal('native_execution_unavailable', 503, 'host.quiesce');
      const held = new Set<string>();
      for (let attempt = 0; attempt < 3; attempt++) {
        const sessions = await runControllerEffect(execution.active);
        if (!sessions.size) return [...held];
        for (const sessionID of sessions) { await bridge.hold(sessionID); held.add(sessionID); }
        for (const sessionID of sessions) await stop(sessionID);
      }
      if ((await runControllerEffect(execution.active)).size) throw new HostRefusal('native_settlement_uncertain', 409, 'host.quiesce');
      return [...held];
    },
    wakeOwned: async ({ sessionID, permit }: { readonly sessionID: string; readonly permit: OperationPermit }): Promise<void> => {
      if (!execution) throw new HostRefusal('native_execution_unavailable', 503, 'shell.continue', sessionID);
      await runControllerEffect(operation({ operation: 'shell.continue', sessionID }, execution.wake(SessionSchema.ID.make(sessionID)))
        .pipe(Effect.provideService(OperationPermitRef, permit)));
    },
    wakeDeferredOwned: async ({ sessionID, permit }: { readonly sessionID: string; readonly permit: OperationPermit }): Promise<NativeDeferredWakeReceipt> => {
      if (!inbox || !execution || !executionScope) throw new HostRefusal('native_execution_unavailable', 503, 'execution.deferred.wake', sessionID);
      const nativeID = SessionSchema.ID.make(sessionID), ownedInbox = inbox, ownedExecution = execution, ownedScope = executionScope;
      const request = { operation: 'execution.deferred.wake', sessionID };
      let admission: Deferred.Deferred<void, unknown> | undefined;
      let monitor: Fiber.Fiber<void> | undefined;
      try {
        const result = await runControllerEffect(operation(request, SessionInbox.serialized(nativeID, Effect.gen(function* () {
          // Remote authorization precedes the final local inbox observation.
          // Native runner admission signals before it needs this inbox lock.
          const observation = yield* observeDeferredNativeWake(ownedInbox, ownedExecution, nativeID);
          if (observation === 'idle') return { kind: 'idle' as const, operation: 'execution.wake' as const, sessionID };
          if (observation === 'active') return yield* refuseHost(new HostRefusal('native_deferred_wake_active', 409, request.operation, sessionID));
          if (wakeAdmissions.has(sessionID)) return yield* refuseHost(new HostRefusal('native_deferred_wake_busy', 409, request.operation, sessionID));
          admission = yield* Deferred.make<void, unknown>();
          wakeAdmissions.set(sessionID, admission);
          const transfer = admission;
          yield* ownedExecution.wake(nativeID);
          // A denied claim/drain or shutdown must not leave the owner waiting
          // for an admission which will never arrive. This only observes the
          // existing coordinator; it owns no runner or execution scheduling.
          monitor = yield* ownedExecution.awaitIdle(nativeID).pipe(Effect.onExit(exit => Deferred.failCause(transfer,
            Exit.isFailure(exit) ? exit.cause : Cause.die(new HostRefusal('native_runner_admission_missing', 503, request.operation, sessionID)))),
            Effect.forkIn(ownedScope, { startImmediately: true }));
          return { kind: 'registered' as const, operation: 'execution.wake' as const, sessionID };
        }))).pipe(Effect.provideService(OperationPermitRef, permit)));
        if (admission) await runControllerEffect(Deferred.await(admission).pipe(Effect.timeout('30 seconds')));
        await runControllerEffect(ready(request.operation, sessionID));
        return result;
      } finally {
        if (admission && wakeAdmissions.get(sessionID) === admission) wakeAdmissions.delete(sessionID);
        if (monitor) await runControllerEffect(Fiber.interrupt(monitor));
      }
    },
    reconcilePrimaryOwned: async ({ sessionID, messageID, permit }: { readonly sessionID: string; readonly messageID: string; readonly permit: OperationPermit }): Promise<NativeShellReconciliation> => {
      if (!store || !inbox || !execution || !executionScope) throw new HostRefusal('native_completion_owner_unavailable', 503, 'primary.continue', sessionID);
      const request = { operation: 'primary.continue', sessionID, messageID };
      const nativeID = SessionSchema.ID.make(sessionID), ownedStore = store, ownedInbox = inbox,
        ownedExecution = execution, ownedScope = executionScope;
      let admission: Deferred.Deferred<void, unknown> | undefined;
      let transfers: typeof wakeAdmissions | undefined;
      let monitor: Fiber.Fiber<void> | undefined;
      try {
        const result = await runControllerEffect(operation(request, SessionInbox.serialized(nativeID, Effect.gen(function* () {
          // Lock acquisition can outlive admission. Recheck the original
          // grant first, then observe locally with no remote await before
          // native scheduling under this same input coordinator lock.
          yield* recheck(permit,request);
          const observation = yield* Effect.tryPromise(() => observeOwnedPrimaryInput(ownedStore, ownedInbox, { sessionID, messageID }));
          if (observation.kind !== 'pending') return observation;
          if (yield* ownedExecution.isActive(nativeID)) return { kind: 'registered' as const, messageID };
          transfers = observation.location === 'queued' ? wakeAdmissions : resumeAdmissions;
          if (transfers.has(sessionID)) return yield* refuseHost(new HostRefusal('native_continuation_busy', 409, request.operation, sessionID));
          admission = yield* Deferred.make<void, unknown>();
          transfers.set(sessionID, admission);
          const transfer = admission;
          if (observation.location === 'queued') {
            yield* ownedExecution.wake(nativeID);
            monitor = yield* ownedExecution.awaitIdle(nativeID).pipe(Effect.onExit(exit => Deferred.failCause(transfer,
              Exit.isFailure(exit) ? exit.cause : Cause.die(new HostRefusal('native_runner_admission_missing', 503, request.operation, sessionID)))),
              Effect.forkIn(ownedScope, { startImmediately: true }));
          } else {
            yield* ownedExecution.resume(nativeID).pipe(Effect.onExit(exit => Deferred.failCause(transfer,
              Exit.isFailure(exit) ? exit.cause : Cause.die(new HostRefusal('native_runner_admission_missing', 503, request.operation, sessionID)))),
              Effect.forkIn(ownedScope, { startImmediately: true }));
          }
          return { kind: 'registered' as const, messageID };
        }))).pipe(Effect.provideService(OperationPermitRef, permit)));
        // Runner.drain independently admits before touching the inbox lock;
        // registration alone never clears the primary durable reservation.
        if (admission) await runControllerEffect(Deferred.await(admission).pipe(Effect.timeout('30 seconds')));
        return result;
      } finally {
        if (admission && transfers?.get(sessionID) === admission) transfers.delete(sessionID);
        if (monitor) await runControllerEffect(Fiber.interrupt(monitor));
      }
    },
    reconcileShellOwned: async ({ sessionID, messageID, permit }: { readonly sessionID: string; readonly messageID: string; readonly permit: OperationPermit }): Promise<NativeShellReconciliation> => {
      if (!store || !inbox || !execution || !executionScope) throw new HostRefusal('native_completion_owner_unavailable', 503, 'shell.continue', sessionID);
      const request = { operation: 'shell.continue', sessionID };
      const nativeID = SessionSchema.ID.make(sessionID), ownedStore = store, ownedInbox = inbox,
        ownedExecution = execution, ownedScope = executionScope;
      let admission: Deferred.Deferred<void, unknown> | undefined;
      try {
        const result = await runControllerEffect(operation(request, SessionInbox.serialized(nativeID, Effect.gen(function* () {
          // All remote permission awaits precede this final local observation.
          const observation = yield* Effect.tryPromise(() => observeOwnedShellNotification(ownedStore, ownedInbox, { sessionID, messageID }));
          if (observation.kind !== 'pending') return observation;
          if (observation.location === 'queued') {
            yield* ownedExecution.wake(nativeID);
          } else if (!(yield* ownedExecution.isActive(nativeID))) {
            // wake(force=false) ignores already promoted input. Resume uses
            // the native coordinator, owns its fiber in the existing scope,
            // and transfers authority before the Node callback may return.
            admission = yield* Deferred.make<void, unknown>();
            resumeAdmissions.set(sessionID, admission);
            const transfer = admission;
            yield* ownedExecution.resume(nativeID).pipe(Effect.onExit(exit => Deferred.failCause(transfer,
              Exit.isFailure(exit) ? exit.cause : Cause.die(new HostRefusal('native_runner_admission_missing', 503, 'shell.continue', sessionID)))),
              Effect.forkIn(ownedScope, { startImmediately: true }));
          }
          return { kind: 'registered' as const, messageID };
        }))).pipe(Effect.provideService(OperationPermitRef, permit)));
        if (admission) await runControllerEffect(Deferred.await(admission).pipe(Effect.timeout('30 seconds')));
        return result;
      } finally { if (admission && resumeAdmissions.get(sessionID) === admission) resumeAdmissions.delete(sessionID); }
    },
    recoverShellOwned,
    recoverPendingShellOwned: async (): Promise<readonly string[]> => {
      if (!jobs) throw new HostRefusal('native_completion_owner_unavailable', 503, 'shell.recover');
      const recovered: string[] = [];
      for (const marker of await runControllerEffect(jobs.pendingBackground)) {
        if (marker.recovery.kind !== 'shell' || marker.status === 'running') continue;
        await recoverShellOwned({ sessionID: marker.recovery.sessionID, jobID: marker.id }); recovered.push(marker.id);
      }
      return recovered;
    },
    release: (sessionID: string) => bridge.releaseHold(sessionID),
  } };
}
