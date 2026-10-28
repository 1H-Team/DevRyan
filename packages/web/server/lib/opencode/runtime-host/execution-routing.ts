import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { Environment } from '@opencode/core/environment/index';
import { Shell } from '@opencode/core/shell';
import { ShellSelect } from '@opencode/core/shell/select';
import { Tool } from '@opencode/core/tool';
import { FileAccess } from '@opencode/core/file-access';
import { SessionInstructions } from '@opencode/core/session/instructions';
import type { LayerNode } from '@opencode/util/effect/layer-node';
import { Cause, Context, Deferred, Effect, Exit, Layer, Queue, Schema, Sink, Stream } from 'effect';
import { systemError } from 'effect/PlatformError';
import { make as makeSpawner, makeHandle, ProcessId, ExitCode } from 'effect/process/ChildProcessSpawner';
import type { NativeAdmissionBridge, ExecuteOwned, OwnedToolInvocation } from './native-admission-contract.js';
import { ExecutionBatch, PlanReadAdvisory, StartResult } from './worker-protocol.js';
import type { ExecutionRpc, ExecutionSpecification } from './worker-protocol.js';
import { createNativeReadGuard } from './execution-read-guard.js';
import { HostRefusal, refuseHost } from './host-refusal.js';
import { lookupReviewedSkillResourcePath, readReviewedSkillResource, type SkillResourceSnapshot } from './reviewed-skills.js';
import type { RegistrationOrigin } from './registration-origin.js';

const TrustedToolInvocationRef = Context.Reference<OwnedToolInvocation | undefined>(
  'DevRyan/TrustedToolInvocation', { defaultValue: () => undefined });
const TICKET = 'DEVRYAN_NATIVE_SHELL_TICKET';
const writers = new Set(['write', 'edit', 'patch']);
// The command-deadline watchdog's ceiling (MAX_COMMAND_TIMEOUT_MS in
// @devryan/harness-runtime/lib/command-deadline.js); larger requests are refused
// here rather than silently shortened there.
const MAX_SHELL_TIMEOUT_MS = 3_600_000;
const numberField = (metadata: Readonly<Record<string, unknown>> | undefined, name: string) => {
  const value = metadata?.[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};
// The deadline watchdog's own cancellation names what it enforced, so a model
// can adapt instead of retrying the same command.
const shellFailureMessage = (settlement: { readonly error?: string; readonly code?: string; readonly errorMetadata?: Readonly<Record<string, unknown>> }) => {
  if (settlement.code !== 'command_deadline_exceeded') return settlement.error ?? 'native_execution_failed';
  const effective = numberField(settlement.errorMetadata, 'effectiveTimeoutMs');
  const grace = numberField(settlement.errorMetadata, 'graceMs');
  const requested = numberField(settlement.errorMetadata, 'requestedTimeoutMs');
  const enforced = effective === undefined ? 'its deadline' : `its ${effective} ms timeout${requested === undefined ? ' (the default; no timeout was requested)' : ''}`;
  return `command_deadline_exceeded: DevRyan stopped this command ${grace === undefined ? '' : `${Math.round(grace / 1000)} s `}after ${enforced}. `
    + `Use a larger timeout (at most ${MAX_SHELL_TIMEOUT_MS} ms) or split the work.`;
};
const platformFailure = (cause: unknown) => systemError({ _tag: 'Unknown', module: 'DevRyanExecution', method: 'spawn',
  description: cause instanceof Error ? cause.message : 'native_execution_failed' });
const toolFailure = (cause: unknown) => new Tool.Error({ message: cause instanceof Error ? cause.message : 'native_execution_failed' });
const requestFor = (call: OwnedToolInvocation) => ({ operation: 'tool.execute', sessionID: call.nativeContext.sessionID,
  messageID: call.nativeContext.messageID, input: { toolID: call.toolID, callID: call.nativeContext.id,
    ...(call.nativeToolID === undefined ? {} : { nativeToolID: call.nativeToolID }),
    provenance: call.provenance, input: call.input } });

/** Routes actual native effects to the web process's existing execution owner. */
export function createExecutionRouting(options: { readonly rpc: ExecutionRpc; readonly directory: string;
  readonly configurationSnapshot?: SkillResourceSnapshot;
  readonly reviewedAstOrigin?: RegistrationOrigin;
  readonly reviewedBrowserOrigin?: RegistrationOrigin;
  readonly reviewedImagegenOrigin?:RegistrationOrigin;
  readonly readRoots?: readonly string[]; readonly protectedRoots?: readonly string[];
  readonly locations?: readonly { readonly directory: string; readonly readRoots: readonly string[]; readonly protectedRoots: readonly string[] }[];
  readonly bridge: NativeAdmissionBridge }): { readonly executeOwned: ExecuteOwned; readonly overrides: LayerNode.Replacements;
    readonly withDirectRead: (invocation: OwnedToolInvocation, execute: ReturnType<ExecuteOwned>) => ReturnType<ExecuteOwned>;
    readonly withControl: <A, E, R>(invocation: OwnedToolInvocation, execute: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    readonly close: () => Promise<void> } {
  let closed = false;
  const resourceSnapshot = options.configurationSnapshot && structuredClone(options.configurationSnapshot);
  const astOrigin = options.reviewedAstOrigin && structuredClone(options.reviewedAstOrigin);
  const browserOrigin = options.reviewedBrowserOrigin && structuredClone(options.reviewedBrowserOrigin);
  const imagegenOrigin=options.reviewedImagegenOrigin&&structuredClone(options.reviewedImagegenOrigin);
  const rootsFor = (directory: string) => {
    const roots = options.locations?.find(item => item.directory === directory);
    if (options.locations && !roots || !options.locations && directory !== options.directory) throw new HostRefusal('native_location_unapproved', 403, 'tool.read');
    return roots ?? { directory, readRoots: options.readRoots ?? [directory], protectedRoots: options.protectedRoots };
  };
  const resourceFor = (target: string, invocation: OwnedToolInvocation | undefined) => {
    if (!resourceSnapshot || invocation?.toolID !== 'read') return null;
    rootsFor(invocation.location.directory);
    return lookupReviewedSkillResourcePath(resourceSnapshot, { snapshotDigest: resourceSnapshot.digest,
      directory: invocation.location.directory, targetPath: target });
  };
  const authorizeRead = (target: string, directory: string, invocation?: OwnedToolInvocation) => Effect.tryPromise({ try: async () => {
    if (resourceFor(target, invocation)) return;
    await createNativeReadGuard(rootsFor(directory))(target);
  },
    catch: (error) => error instanceof HostRefusal ? error : new HostRefusal('native_read_authority_unavailable', 503, 'tool.read') })
    .pipe(Effect.catch((error) => refuseHost(error)));
  const reviewedRead = (invocation: OwnedToolInvocation | undefined) => invocation && ['read', 'glob', 'grep'].includes(invocation.toolID);
  // OpenCode 2.2.0 FileAccess.resolve probes every parent of an external read
  // target for a `.git`/`.hg` marker to suggest a save pattern. A probe the read
  // boundary would refuse (repository metadata, or outside the read roots) sees
  // no marker, without touching the file system, so native suggests the narrower
  // directory pattern instead of failing the read.
  const hiddenProjectMarker = (target: string, directory: string) => ['.git', '.hg'].includes(path.basename(target))
    ? Effect.promise(() => Promise.resolve().then(() => createNativeReadGuard(rootsFor(directory))(target)).then(() => false, () => true))
    : Effect.succeed(false);
  const handles = new Map<string, { cancel: () => Promise<void>; done: Promise<unknown> }>();
  const shellHandles = new Map<string, string>();
  type ShellSettlement = { state: 'pending' } | { state: 'uncertain'; code: string }
    | { state: 'settled'; ok: boolean; receipt?: typeof import('./worker-protocol.js').TerminationReceipt.Type;
      publication?: { readonly outcome: 'complete' | 'partial'; readonly conflicts: readonly string[]; readonly ignoredInputs?: readonly string[] }; error?: string;
      code?: string; errorMetadata?: Readonly<Record<string, unknown>> };
  const shellSettlements = new Map<string, ShellSettlement>();
  const callKey = (call: OwnedToolInvocation) => JSON.stringify([call.nativeContext.sessionID, call.nativeContext.messageID, call.nativeContext.id]);
  const searchTruncations = new Map<string, typeof import('./worker-protocol.js').SearchTruncation.Type>();
  const tickets = new Map<string, { invocation: OwnedToolInvocation; command: string; args: string[];
    cwd: string; env: Record<string, string | undefined> }>();
  const rpc = (action: string, params: Readonly<Record<string, unknown>>) => options.rpc(`execution.native.${action}`, params);
  const start = (invocation: OwnedToolInvocation, specification: ExecutionSpecification) => Effect.gen(function* () {
    if (closed) return yield* Effect.die(new Error('native_execution_routing_closed'));
    yield* invocation.recheckPermit();
    const argsDigest = createHash('sha256').update(JSON.stringify(specification)).digest('hex');
    const value = yield* Effect.promise(() => rpc('start', { ...specification, directory: invocation.location.directory,
      sessionID: invocation.nativeContext.sessionID, messageID: invocation.nativeContext.messageID,
      callID: invocation.nativeContext.id, agent: invocation.nativeContext.agent, tool: invocation.toolID,
      permit: invocation.existingPermit, argsDigest, authorization: requestFor(invocation) }));
    return Schema.decodeUnknownSync(StartResult)(value).handle;
  });
  const cancel = (handle: string) => rpc('cancel', { handle }).then(() => undefined);
  const read = (handle: string, cursor: number) => Effect.promise(async () =>
    Schema.decodeUnknownSync(ExecutionBatch)(await rpc('read', { handle, cursor })));
  const writer: ExecuteOwned = (invocation) => Effect.gen(function* () {
    const handle = yield* start(invocation, { kind: 'writer', tool: invocation.toolID, input: invocation.input });
    let settled = false;
    const completion = Promise.withResolvers<void>();
    handles.set(handle, { cancel: () => cancel(handle), done: completion.promise });
    return yield* Effect.gen(function* () {
      let cursor = 0;
      while (true) {
        const batch = yield* read(handle, cursor);
        for (const event of batch.events) {
          cursor = event.cursor;
          if (event.type === 'progress') yield* invocation.nativeContext.progress(event.update);
          else if (event.type === 'permission') {
            yield* invocation.recheckPermit();
            const reply = yield* invocation.nativePermissionAssert({ ...event.input, sessionID: invocation.nativeContext.sessionID,
              agent: invocation.nativeContext.agent, source: { type: 'tool', messageID: invocation.nativeContext.messageID, id: invocation.nativeContext.id } }).pipe(
              Effect.match({ onSuccess: () => ({ id: event.id, ok: true }),
                onFailure: (error) => ({ id: event.id, ok: false, error }) }));
            yield* Effect.promise(() => rpc('input', { handle, reply }));
          } else if (event.type === 'uncertain') return yield* Effect.fail(new Tool.Error({ message: event.error.code }));
          else if (event.type === 'settled') {
            settled = true;
            // Acknowledge the terminal batch so the bounded web handle can retire.
            yield* read(handle, cursor);
            if (!event.ok || !event.receipt?.terminated || !event.receipt.confined) {
              return yield* Effect.fail(new Tool.Error(event.error ?? { message: 'native_execution_failed' }));
            }
            if (!event.result) return yield* Effect.fail(new Tool.Error({ message: 'native_writer_result_missing' }));
            return event.result;
          }
        }
        if (batch.done && !batch.events.length) return yield* Effect.fail(new Tool.Error({ message: 'native_execution_result_missing' }));
      }
    }).pipe(Effect.ensuring(Effect.promise(async () => {
      try { if (!settled) await cancel(handle); completion.resolve(); }
      catch (cause) { completion.reject(cause); throw cause; }
      finally { handles.delete(handle); }
    })));
  }).pipe(Effect.catchDefect((cause) => Effect.fail(toolFailure(cause))));
  const withDirectRead = (invocation: OwnedToolInvocation, execute: ReturnType<ExecuteOwned>): ReturnType<ExecuteOwned> => Effect.gen(function* () {
    yield* invocation.recheckPermit();
    const input = { directory: invocation.location.directory, sessionID: invocation.nativeContext.sessionID,
      messageID: invocation.nativeContext.messageID, callID: invocation.nativeContext.id,
      tool: invocation.nativeToolID ?? invocation.toolID, permit: invocation.existingPermit, authorization: requestFor(invocation),
      argsDigest: createHash('sha256').update(JSON.stringify(invocation.input)).digest('hex') };
    const admission = Schema.decodeUnknownSync(Schema.Struct({ token: Schema.String, generation: Schema.Int }))(
      yield* Effect.promise(() => rpc('direct-admit', input)));
    const result = yield* Effect.exit(execute.pipe(Effect.provideService(TrustedToolInvocationRef, invocation)));
    yield* invocation.recheckPermit();
    const finished: unknown = yield* Effect.promise(() => rpc('direct-finish', { ...input, ...admission }));
    if (!Exit.isSuccess(result)) return yield* Effect.failCause(result.cause);
    const truncation = searchTruncations.get(callKey(invocation));
    // A malformed advisory is dropped; it never changes the read's outcome.
    const candidate: unknown = finished !== null && typeof finished === 'object' ? Reflect.get(finished, 'advisory') : undefined;
    const advisory = Schema.is(PlanReadAdvisory)(candidate) ? candidate : undefined;
    const notices = [...truncation ? [`Search results truncated at ${truncation.returnedRecords} records / ${truncation.returnedBytes} bytes. Narrow the path or pattern before searching again.`] : [],
      ...advisory ? [advisory.message] : []];
    if (!notices.length) return result.value;
    const notice = notices.join('\n\n');
    return { ...result.value, content: typeof result.value.content === 'string' ? `${result.value.content}\n\n${notice}`
      : [...(result.value.content ?? []), { type: 'text' as const, text: notice }],
      metadata: { ...result.value.metadata, ...truncation ? { truncated: true, searchTruncation: truncation } : {}, ...advisory ? { planReadAdvisory: advisory } : {} } };
  }).pipe(Effect.ensuring(Effect.sync(() => { searchTruncations.delete(callKey(invocation)); })),
    Effect.catchDefect((cause) => Effect.fail(toolFailure(cause))));
  const withControl = <A, E, R>(invocation: OwnedToolInvocation, execute: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => Effect.gen(function* () {
    yield* invocation.recheckPermit();
    const input = { directory: invocation.location.directory, sessionID: invocation.nativeContext.sessionID,
      messageID: invocation.nativeContext.messageID, callID: invocation.nativeContext.id, input: invocation.input,
      tool: invocation.nativeToolID ?? invocation.toolID, permit: invocation.existingPermit, authorization: requestFor(invocation) };
    const admitted = Schema.decodeUnknownSync(Schema.Struct({ lease: Schema.Struct({ token: Schema.String }) }))(
      yield* Effect.promise(() => rpc('control-begin', input)));
    return yield* execute.pipe(Effect.ensuring(Effect.promise(() => rpc('control-finish', { ...input, token: admitted.lease.token }))));
  });
  const executeOwned: ExecuteOwned = (invocation) => {
    if (closed) return Effect.fail(new Tool.Error({ message: 'native_execution_routing_closed' }));
    if(invocation.toolID==='gpt_imagegen'){
      const origin=invocation.provenance;
      if(!imagegenOrigin||origin.kind!=='plugin'||origin.id!==imagegenOrigin.id||origin.manifestDigest!==imagegenOrigin.manifestDigest
        ||JSON.stringify(origin.capabilities)!==JSON.stringify(imagegenOrigin.capabilities))return Effect.fail(new Tool.Error({message:'native_imagegen_registration_required'}));
      return writer(invocation);
    }
    if (invocation.toolID === 'devryan_browser') {
      const origin = invocation.provenance;
      if (!browserOrigin || browserOrigin.kind !== 'plugin' || browserOrigin.id !== 'devryan.browser' || origin.kind !== browserOrigin.kind
        || origin.id !== browserOrigin.id || origin.manifestDigest !== browserOrigin.manifestDigest
        || JSON.stringify(origin.capabilities) !== JSON.stringify(browserOrigin.capabilities))
        return Effect.fail(new Tool.Error({ message: 'native_browser_registration_required' }));
      return writer(invocation);
    }
    if (['ast_grep_search', 'ast_grep_replace'].includes(invocation.toolID)) {
      const origin = invocation.provenance;
      if (!astOrigin || astOrigin.kind !== 'plugin' || astOrigin.id !== 'devryan.slim' || origin.kind !== astOrigin.kind
        || origin.id !== astOrigin.id || origin.manifestDigest !== astOrigin.manifestDigest
        || JSON.stringify(origin.capabilities) !== JSON.stringify(astOrigin.capabilities))
        return Effect.fail(new Tool.Error({ message: 'native_ast_registration_required' }));
      return writer(invocation);
    }
    // Only reviewed native leaves may be reconstructed. A plugin reusing a
    // writer name cannot silently obtain the native writer's authority.
    if (invocation.provenance.kind !== 'native' || invocation.provenance.id !== `opencode.tool.${invocation.toolID}`)
      return Effect.fail(new Tool.Error({ message: 'native_registration_required' }));
    if (invocation.toolID === 'question') return withControl(invocation, invocation.executeNative());
    if (writers.has(invocation.toolID)) {
      return writer(invocation);
    }
    if (invocation.toolID === 'shell') {
      const timeout: unknown = invocation.input !== null && typeof invocation.input === 'object' ? Reflect.get(invocation.input, 'timeout') : undefined;
      if (timeout !== undefined && (typeof timeout !== 'number' || !Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_SHELL_TIMEOUT_MS)) {
        return Effect.fail(new Tool.Error({ message: `native_shell_timeout_invalid: timeout is in milliseconds, from 1 to ${MAX_SHELL_TIMEOUT_MS}; zero does not disable the deadline` }));
      }
      const key = callKey(invocation);
      return Effect.sync(() => { shellSettlements.set(key, { state: 'pending' }); }).pipe(Effect.andThen(invocation.executeNative()),
        Effect.provideService(TrustedToolInvocationRef, invocation),
        Effect.flatMap(result => {
          const withNotice = (notice: string) => typeof result.content === 'string' ? `${result.content}\n\n${notice}`
            : [...(result.content ?? []), { type: 'text' as const, text: notice }];
          const settlement = shellSettlements.get(key);
          if (result.metadata?.status === 'running' && settlement?.state === 'pending') return Effect.succeed(result);
          if (!settlement || settlement.state === 'pending') return Effect.fail(new Tool.Error({ message: 'native_execution_result_missing', metadata: { output: result.content } }));
          if (settlement.state === 'uncertain') return Effect.fail(new Tool.Error({ message: settlement.code, metadata: { output: result.content, termination: 'uncertain' } }));
          const receipt = settlement.receipt;
          if (!settlement.ok || !receipt?.terminated || !receipt.confined || receipt.cancelled) {
            // OpenCode's own timer stopped the command: it marks its result
            // (`timeout: true`) before it kills, so the cause is established.
            if (receipt?.terminated && receipt.cancelled && result.metadata?.timeout === true)
              return Effect.succeed({ ...result, content: withNotice('Changes from this command were not published because it was stopped at its timeout.'),
                metadata: { ...result.metadata, receipt } });
            return Effect.fail(new Tool.Error({ message: shellFailureMessage(settlement), metadata: { output: result.content,
              ...(receipt ? { receipt } : {}), ...(settlement.code ? { code: settlement.code } : {}),
              ...(settlement.errorMetadata ? { deadline: settlement.errorMetadata } : {}) } }));
          }
          if (!settlement.publication) return Effect.fail(new Tool.Error({ message: 'native_publication_result_missing', metadata: { output: result.content, receipt } }));
          const ignored = settlement.publication.ignoredInputs ?? [];
          // Dropped output is reported, never passed off as published: a check
          // that needed it stays incomplete.
          const notice = [
            ...(settlement.publication.outcome === 'partial'
              ? [`Some changes were not published because these files changed during execution: ${settlement.publication.conflicts.join(', ')}. Proposed contents were retained for recovery.`] : []),
            ...(ignored.length ? [`Not published: this command replaced these ignored folders, so what it wrote inside them was dropped: ${ignored.slice(0, 20).join(', ')}${ignored.length > 20 ? ` (${ignored.length - 20} more)` : ''}. Write output to a new path instead of deleting and recreating these folders.`] : []),
          ].join('\n\n') || undefined;
          const content = notice ? withNotice(notice) : result.content;
          return Effect.succeed({ ...result, content, metadata: { ...result.metadata, exitCode: receipt.exitCode, publication: settlement.publication } });
        }), Effect.ensuring(Effect.sync(() => { shellSettlements.delete(key); })));
    }
    if (invocation.toolID === 'skill') return Effect.fail(new Tool.Error({ message: 'native_skill_asset_authority_required' }));
    if (!['read', 'glob', 'grep'].includes(invocation.toolID)) return Effect.fail(new Tool.Error({ message: 'owned_tool_capability_unavailable' }));
    return withDirectRead(invocation, invocation.executeNative());
  };
  const fileAccess = FileAccess.node.replace(FileAccess.node.mapLayer((layer) => Layer.effect(FileAccess.Service,
    Effect.gen(function* () {
      const inner = yield* FileAccess.Service;
      return FileAccess.Service.of({ ...inner,
        authorizeRead: (file, context, settings) => inner.authorizeRead(file, context, settings).pipe(
          Effect.tap(target => Effect.gen(function* () { const invocation = yield* TrustedToolInvocationRef;
            yield* authorizeRead(target.absolute, invocation?.location.directory ?? options.directory, invocation); }))),
        authorizeExternal: (targets, context, metadata) => inner.authorizeExternal(targets, context, metadata).pipe(
          Effect.andThen(Effect.gen(function* () {
            const invocation = yield* TrustedToolInvocationRef;
            if (reviewedRead(invocation)) yield* Effect.forEach(targets, target => authorizeRead(target.absolute, invocation?.location.directory ?? options.directory, invocation), { discard: true });
          }))),
      });
    })).pipe(Layer.provide(layer))));
  // ReadTool discovers nested AGENTS.md itself, bypassing InstructionDiscovery
  // and Environment.files. Never delegate explicit loading to FSUtil: even an
  // in-root file has no reviewed instruction-asset authority until stage D.
  const instructions = SessionInstructions.node.replace(Layer.succeed(SessionInstructions.Service,
    SessionInstructions.Service.of({ load: (input) => Effect.gen(function* () {
      if (!input.paths.length) return;
      const directory = (yield* TrustedToolInvocationRef)?.location.directory ?? options.directory;
      yield* Effect.forEach(input.paths, target => authorizeRead(target, directory), { discard: true });
      return yield* refuseHost(new HostRefusal('native_instruction_asset_authority_required', 403,
        'session.instructions.load', input.sessionID));
    }) })));
  const shell = Shell.node.replace(Shell.node.mapLayer((layer) => Layer.effect(Shell.Service,
    Effect.gen(function* () {
      const inner = yield* Shell.Service;
      return Shell.Service.of({ ...inner, create: (input, before) => Effect.gen(function* () {
        const invocation = yield* TrustedToolInvocationRef;
        if (!invocation || closed) return yield* Effect.die(new Error('native_shell_ownership_required'));
        let ticket: string | undefined;
        // The timeout the native shell arms after `before` (its foreground
        // default when none was requested, 0 for background): what the
        // command-deadline watchdog must not cut short.
        let effectiveTimeoutMs: number | undefined;
        const info = yield* inner.create(input, (final) => Effect.gen(function* () {
          if (before) yield* before(final); // Native final-command permission runs first.
          const finalTimeout: unknown = Reflect.get(final, 'timeout');
          effectiveTimeoutMs = typeof finalTimeout === 'number' && Number.isSafeInteger(finalTimeout) && finalTimeout >= 0 ? finalTimeout : undefined;
          yield* invocation.recheckPermit();
          if (tickets.size >= 128) return yield* Effect.die(new Error('native_shell_ticket_capacity'));
          ticket = randomUUID();
          const env = { ...final.env }; delete env[TICKET];
          tickets.set(ticket, { invocation, command: final.shell, args: ShellSelect.args(final.shell, final.command), cwd: final.cwd, env });
          final.env[TICKET] = ticket;
        })).pipe(Effect.onExit(() => Effect.sync(() => { if (ticket) tickets.delete(ticket); })));
        const handle = shellHandles.get(callKey(invocation));
        if (!handle) return yield* Effect.die(new Error('native_shell_execution_binding_missing'));
        yield* invocation.recheckPermit();
        const requested: unknown = invocation.input !== null && typeof invocation.input === 'object' ? Reflect.get(invocation.input, 'timeout') : undefined;
        const time: unknown = Reflect.get(info, 'time');
        const started: unknown = time !== null && typeof time === 'object' ? Reflect.get(time, 'started') : undefined;
        yield* Effect.promise(() => options.bridge.registerShellJob({ permit: invocation.existingPermit,
          authorization: requestFor(invocation), jobID: info.id, command: info.command, handle,
          directory: invocation.location.directory, sessionID: invocation.nativeContext.sessionID,
          messageID: invocation.nativeContext.messageID, callID: invocation.nativeContext.id, tool: 'shell',
          startedAt: typeof started === 'number' && Number.isFinite(started) ? started : Date.now(),
          ...(typeof requested === 'number' && Number.isSafeInteger(requested) ? { requestedTimeoutMs: requested } : {}),
          ...(effectiveTimeoutMs === undefined ? {} : { effectiveTimeoutMs }) }));
        shellHandles.delete(callKey(invocation));
        return info;
      }) });
    })).pipe(Layer.provide(layer))));
  const environment = Environment.node.replace(Environment.node.mapLayer((layer) => Layer.effect(Environment.Service,
    Effect.gen(function* () {
      const inner = yield* Environment.Service;
      const spawner = makeSpawner((command) => Effect.gen(function* () {
        if (command._tag !== 'StandardCommand') return yield* Effect.fail(platformFailure(new Error('native_piped_spawn_unavailable')));
        const ticketID = command.options.env?.[TICKET];
        let ticket = typeof ticketID === 'string' ? tickets.get(ticketID) : undefined;
        const direct = yield* TrustedToolInvocationRef;
        const readOnly = !ticket && direct && ['glob', 'grep'].includes(direct.toolID);
        if (readOnly) ticket = { invocation: direct, command: command.command, args: [...command.args],
          cwd: command.options.cwd ?? direct.location.directory, env: { ...command.options.env } };
        if (!ticket) return yield* Effect.fail(platformFailure(new Error('native_spawn_ownership_required')));
        tickets.delete(ticketID!);
        const env = { ...command.options.env }; delete env[TICKET];
        if (command.command !== ticket.command || JSON.stringify(command.args) !== JSON.stringify(ticket.args)
          || (command.options.cwd ?? ticket.invocation.location.directory) !== ticket.cwd || JSON.stringify(env) !== JSON.stringify(ticket.env))
          return yield* Effect.fail(platformFailure(new Error('native_spawn_specification_mismatch')));
        yield* ticket.invocation.recheckPermit();
        const handle = yield* start(ticket.invocation, { kind: readOnly ? 'read' : 'shell', command: command.command,
          args: [...command.args], env, cwd: command.options.cwd });
        if (!readOnly) shellHandles.set(callKey(ticket.invocation), handle);
        const output = yield* Queue.bounded<Uint8Array, Cause.Done | ReturnType<typeof platformFailure>>(256);
        // ripgrep's --json stdout is parsed line by line, so its diagnostics must stay on stderr.
        const errors = readOnly ? yield* Queue.bounded<Uint8Array, Cause.Done | ReturnType<typeof platformFailure>>(256) : undefined;
        const exit = Deferred.makeUnsafe<ExitCode, ReturnType<typeof platformFailure>>();
        const started = Deferred.makeUnsafe<ProcessId, ReturnType<typeof platformFailure>>();
        let done = false;
        const completion = Promise.withResolvers<void>();
        handles.set(handle, { cancel: () => cancel(handle), done: completion.promise });
        const pumping = Effect.gen(function* () {
          let cursor = 0;
          while (!done) {
            const batch = yield* read(handle, cursor);
            for (const event of batch.events) {
              cursor = event.cursor;
              if (event.type === 'started') yield* Deferred.succeed(started, ProcessId(event.pid));
              else if (event.type === 'output') {
                // The native Shell consumes `all`; no independent readers are
                // added to its output pump, preserving its native cursor semantics.
                const target = errors && event.stream === 'stderr' ? errors : output;
                if (!Queue.offerUnsafe(target, Buffer.from(event.data, 'base64'))) return yield* Effect.fail(platformFailure(new Error('native_output_overflow')));
              } else if (event.type === 'uncertain') {
                if (!readOnly && shellSettlements.has(callKey(ticket.invocation))) shellSettlements.set(callKey(ticket.invocation), { state: 'uncertain', code: event.error.code });
                return yield* Effect.fail(platformFailure(new Error(event.error.code)));
              }
              else if (event.type === 'settled') {
                done = true; yield* read(handle, cursor);
                if (!readOnly && shellSettlements.has(callKey(ticket.invocation))) shellSettlements.set(callKey(ticket.invocation),
                  { state: 'settled', ok: event.ok, receipt: event.receipt, publication: event.publication, error: event.error?.message,
                    ...(event.error?.code ? { code: event.error.code } : {}), ...(event.error?.metadata ? { errorMetadata: event.error.metadata } : {}) });
                if (!event.ok || !event.receipt?.terminated || !event.receipt.confined || (!readOnly && event.receipt.cancelled)) return yield* Effect.fail(platformFailure(new Error(event.error?.message ?? 'native_execution_failed')));
                if (event.truncated && (!readOnly || !event.truncation)) return yield* Effect.fail(platformFailure(new Error('native_search_truncation_invalid')));
                if (readOnly && event.truncated && event.truncation) searchTruncations.set(callKey(ticket.invocation), event.truncation);
                yield* Queue.end(output); if (errors) yield* Queue.end(errors);
                yield* Deferred.succeed(exit, ExitCode(readOnly && event.truncated ? 0 : event.receipt.exitCode));
              }
            }
            if (batch.done && !batch.events.length && !done) return yield* Effect.fail(platformFailure(new Error('native_execution_result_missing')));
          }
        }).pipe(Effect.catchCause((cause) => Effect.gen(function* () {
          const settlement = shellSettlements.get(callKey(ticket.invocation));
          if (!readOnly && settlement && (settlement.state === 'pending' || settlement.state === 'settled' && settlement.ok))
            shellSettlements.set(callKey(ticket.invocation), { state: 'uncertain', code: 'native_execution_result_unavailable' });
          const error = platformFailure(cause); yield* Queue.fail(output, error); if (errors) yield* Queue.fail(errors, error);
          yield* Deferred.fail(started, error); yield* Deferred.fail(exit, error);
          yield* Effect.promise(() => cancel(handle));
        })), Effect.ensuring(Effect.sync(() => { done = true; completion.resolve(); handles.delete(handle); })));
        // Native Shell's scoped process fiber owns this pump; interrupting it
        // cancels the actual web-owned supervisor before its scope settles.
        yield* Effect.forkScoped(pumping);
        yield* Effect.addFinalizer(() => Effect.promise(async () => { if (!done) await cancel(handle); await completion.promise; }));
        const pid = yield* Deferred.await(started);
        const all = Stream.fromQueue(output);
        return makeHandle({ pid, exitCode: Deferred.await(exit), isRunning: Effect.sync(() => !done),
          kill: () => Effect.promise(() => cancel(handle)).pipe(Effect.mapError(platformFailure)),
          stdin: Sink.drain, stdout: all, stderr: errors ? Stream.fromQueue(errors) : Stream.empty, all,
          getInputFd: () => Sink.drain, getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void) });
      }).pipe(Effect.catchDefect((cause) => Effect.fail(platformFailure(cause)))));
      const checked = <A, E, R>(target: string, action: Effect.Effect<A, E, R>) => Effect.gen(function* () {
        if (reviewedRead(yield* TrustedToolInvocationRef)) yield* authorizeRead(target, (yield* TrustedToolInvocationRef)?.location.directory ?? options.directory);
        return yield* action;
      });
      const resourceRead = (target: string, invocation: OwnedToolInvocation, resource: NonNullable<ReturnType<typeof resourceFor>>) => Effect.gen(function* () {
        yield* invocation.recheckPermit();
        // Return the verified descriptor's bytes, never a second path-based read.
        const bytes = yield* Effect.tryPromise({ try: () => readReviewedSkillResource(resourceSnapshot!, resource),
          catch: () => new HostRefusal('native_skill_resource_changed', 403, 'tool.read') }).pipe(Effect.catch(refuseHost));
        const info = yield* inner.files.stat(target);
        if (info.type !== 'file' || info.size !== bytes.length) return yield* refuseHost(new HostRefusal('native_skill_resource_changed', 403, 'tool.read'));
        yield* invocation.recheckPermit();
        return { info, bytes };
      });
      return Environment.Service.of({ ...inner, spawner, files: { ...inner.files,
        read: (target, range) => Effect.gen(function* () {
          const invocation = yield* TrustedToolInvocationRef, resource = resourceFor(target, invocation);
          if (!resource || !invocation) return yield* checked(target, inner.files.read(target, range));
          const result = yield* resourceRead(target, invocation, resource);
          if (!range) return result;
          if (!Number.isSafeInteger(range.offset) || !Number.isSafeInteger(range.length) || range.offset < 0 || range.length < 0)
            return yield* refuseHost(new HostRefusal('native_read_range_invalid', 403, 'tool.read'));
          return { info: result.info, bytes: result.bytes.subarray(range.offset, range.offset + range.length) };
        }),
        stat: target => Effect.gen(function* () {
          const invocation = yield* TrustedToolInvocationRef, resource = resourceFor(target, invocation);
          if (resource && invocation) return (yield* resourceRead(target, invocation, resource)).info;
          if (reviewedRead(invocation) && (yield* hiddenProjectMarker(target, invocation?.location.directory ?? options.directory)))
            return yield* new Environment.NotFound({ path: target });
          return yield* checked(target, inner.files.stat(target));
        }),
        list: target => checked(target, inner.files.list(target)),
      } });
    })).pipe(Layer.provide(layer))));
  return { executeOwned, withDirectRead, withControl, overrides: [fileAccess, instructions, shell, environment], close: async () => {
    closed = true; tickets.clear(); shellHandles.clear();
    const active = [...handles.values()];
    const results = await Promise.allSettled(active.map(async (handle) => { await handle.cancel(); await handle.done; }));
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  } };
}
