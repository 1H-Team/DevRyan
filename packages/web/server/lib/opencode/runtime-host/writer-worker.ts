import path from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { OpenCode } from '@opencode/sdk/effect';
import { Tool } from '@opencode/core/tool';
import { FileAccess } from '@opencode/core/file-access';
import { Plugin } from '@opencode/core/plugin';
import { Permission } from '@opencode/core/permission';
import { SessionErrors } from '@opencode/core/session/error';
import { Location } from '@opencode/core/location';
import { Project } from '@opencode/core/project';
import { AbsolutePath } from '@opencode/core/schema';
import { Global } from '@opencode/util/global';
import { Effect, Layer, Logger, Schema } from 'effect';
import { configurationOverrides } from './configuration.js';
import { BrowserReply, ImageGenerationReply, PermissionReply, WorkerInput } from './worker-protocol.js';
import type { WorkerEvent } from './worker-protocol.js';
import { createNativeReadGuard } from './execution-read-guard.js';
import {runReviewedAstWorker} from './native-slim-ast.js';

let lines: ReturnType<typeof createInterface> | undefined;
const emit = (value: WorkerEvent) => new Promise<void>((resolve, reject) => {
  const line = JSON.stringify(value);
  if (Buffer.byteLength(line) > 1024 * 1024) { reject(new Error('native_worker_event_too_large')); return; }
  process.stdout.write(`${line}\n`, (cause) => cause ? reject(cause) : resolve());
});

/** Only path values are rebased. File contents and edit text are never rewritten. */
export function rebaseWriterInput(input: unknown, tool: WorkerInput['tool'], from: string, to: string): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('native_writer_input_invalid');
  const map = (value: string) => {
    if (!path.isAbsolute(value)) return value;
    const relative = path.relative(from, value);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
      ? path.join(to, relative) : value;
  };
  if (tool === 'patch') {
    if (!('patchText' in input) || typeof input.patchText !== 'string') throw new Error('native_writer_input_invalid');
    return { ...input, patchText: input.patchText.replace(/^(\*\*\* (?:Add|Update|Delete) File: |\*\*\* Move to: )(.+)$/gm,
      (_line, prefix: string, file: string) => prefix + map(file)) };
  }
  if (!('path' in input) || typeof input.path !== 'string') throw new Error('native_writer_input_invalid');
  return { ...input, path: map(input.path) };
}

/** The real private SDK graph, shared with the deterministic acquisition check. */
export function acquireWriterRegistry(request: WorkerInput, permissions: Permission.Interface) {
  return Effect.gen(function* () {
    let tools: Tool.Interface | undefined;
    let plugins: Plugin.Interface | undefined;
    const capture = Tool.node.replace(Tool.node.mapLayer((layer) => Layer.effect(Tool.Service,
      Effect.gen(function* () { const service = yield* Tool.Service; tools = service; return service; })).pipe(Layer.provide(layer))));
    const capturePlugins = Plugin.node.replace(Plugin.node.mapLayer((layer) => Layer.effect(Plugin.Service,
      Effect.gen(function* () { const service = yield* Plugin.Service; plugins = service; return service; })).pipe(Layer.provide(layer))));
    const directory = Schema.decodeUnknownSync(AbsolutePath)(request.directory);
    const projectDirectory = Schema.decodeUnknownSync(AbsolutePath)(request.projectDirectory);
    const guardTarget = createNativeReadGuard({ directory: request.projectDirectory, protectedRoots: [request.scratchDirectory] });
    const fileAccess = FileAccess.node.replace(FileAccess.node.mapLayer((layer) => Layer.effect(FileAccess.Service,
      Effect.gen(function* () {
        const inner = yield* FileAccess.Service;
        return FileAccess.Service.of({ ...inner, resolve: input => inner.resolve(input).pipe(
          Effect.tap(target => Effect.tryPromise({ try: () => guardTarget(target.absolute),
            catch: error => new Tool.Error({ message: error instanceof Error ? error.message : 'native_writer_root_denied' }) }).pipe(Effect.orDie))) });
      })).pipe(Layer.provide(layer))));
    const location = new Location.Info({ directory, project: { id: Project.ID.global, directory: projectDirectory, canonical: projectDirectory } });
    const global = Global.node.replace(Global.layerWith({ home: request.scratchDirectory,
      data: path.join(request.scratchDirectory, 'data'), cache: path.join(request.scratchDirectory, 'cache'),
      config: path.join(request.scratchDirectory, 'config'), state: path.join(request.scratchDirectory, 'state'),
      tmp: path.join(request.scratchDirectory, 'tmp'), bin: path.join(request.scratchDirectory, 'bin'),
      log: path.join(request.scratchDirectory, 'log'), repos: path.join(request.scratchDirectory, 'repos') }));
    const sdk = yield* OpenCode.create({ database: { path: ':memory:' },
      config: { directory: path.join(request.scratchDirectory, 'config'), project: false },
      models: { fetch: false, snapshot: false }, fs: { filewatcher: false, fff: false }, events: { persist: false } },
    { overrides: [...configurationOverrides(request.config), global, Location.node.replace(Layer.succeed(Location.Service, location)),
      Permission.node.replace(Layer.succeed(Permission.Service, permissions)), fileAccess, capture, capturePlugins] });
    yield* sdk.sessions.create({ location: { directory } });
    // Session.create is host-global; a catalog read acquires the Location.
    yield* sdk.agent.list({ location: { directory } });
    if (!tools || !plugins) return yield* Effect.die(new Error('native_writer_registry_unavailable'));
    // Tool.list is an immediate snapshot. Cold Location activation is async.
    yield* plugins.awaitActivation;
    return yield* tools.list();
  });
}

async function run() {
  lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const incoming = lines[Symbol.asyncIterator]();
  const first = await incoming.next();
  if (first.done || Buffer.byteLength(first.value) > 2 * 1024 * 1024) throw new Error('native_worker_input_invalid');
  const request = Schema.decodeUnknownSync(WorkerInput)(JSON.parse(first.value), { onExcessProperty: 'error' });
  if (!path.isAbsolute(request.directory) || !path.isAbsolute(request.scratchDirectory) || process.env.HOME !== request.scratchDirectory)
    throw new Error('native_worker_environment_invalid');
  const browserReplies=new Map<string,{resolve:(reply:typeof BrowserReply.Type)=>void;reject:(cause:Error)=>void}>();
  const imageReplies=new Map<string,{resolve:(reply:typeof ImageGenerationReply.Type)=>void;reject:(cause:Error)=>void}>();
  const browserController=new AbortController();
  const replies = new Map<string, { resolve: (reply: PermissionReply) => void; reject: (cause: Error) => void }>();
  const receive = (async () => {
    for await (const line of { [Symbol.asyncIterator]: () => incoming }) {
      if (Buffer.byteLength(line) > 64 * 1024) throw new Error('native_worker_reply_too_large');
      const value:unknown=JSON.parse(line);
      if(value!==null&&typeof value==='object'&&'type' in value&&value.type==='browser'){
        const reply=Schema.decodeUnknownSync(BrowserReply)(value,{onExcessProperty:'error'});
        const pending=browserReplies.get(reply.id);if(!pending)throw Error('native_worker_reply_unknown');
        browserReplies.delete(reply.id);pending.resolve(reply);continue;
      }
      if(value!==null&&typeof value==='object'&&'type' in value&&value.type==='image-generation'){
        const reply=Schema.decodeUnknownSync(ImageGenerationReply)(value,{onExcessProperty:'error'});
        const pending=imageReplies.get(reply.id);if(!pending)throw Error('native_worker_reply_unknown');
        imageReplies.delete(reply.id);pending.resolve(reply);continue;
      }
      const reply = Schema.decodeUnknownSync(PermissionReply)(value, { onExcessProperty: 'error' });
      const pending = replies.get(reply.id);
      if (!pending) throw new Error('native_worker_reply_unknown');
      replies.delete(reply.id); pending.resolve(reply);
    }
    const cause=new Error('native_worker_controller_closed');browserController.abort(cause);
    for(const pending of browserReplies.values())pending.reject(cause);for(const pending of imageReplies.values())pending.reject(cause);
    for (const pending of replies.values()) pending.reject(cause);
  })();
  void receive.catch((cause: Error) => { browserController.abort(cause);for(const pending of browserReplies.values())pending.reject(cause);for(const pending of imageReplies.values())pending.reject(cause);for (const pending of replies.values()) pending.reject(cause); });
  const denied = () => Effect.die(new Error('native_worker_permission_method_unavailable'));
  const permissions: Permission.Interface = {
    close: Effect.void, ask: denied, reply: denied, get: denied, forSession: denied, list: denied,
    assert: (input) => Effect.gen(function* () {
      // Restore the controller's session/call identity. The worker's private
      // session exists only to acquire native registrations and owns no policy.
      const id = randomUUID();
      const reply = yield* Effect.promise(async () => {
        const answer = new Promise<PermissionReply>((resolve, reject) => replies.set(id, { resolve, reject }));
        await emit({ type: 'permission', id, input: { ...input, sessionID: request.context.sessionID,
          agent: request.context.agent, source: { type: 'tool', messageID: request.context.messageID, id: request.context.id } } });
        return answer;
      });
      if (!reply.ok) {
        const error = Schema.decodeUnknownSync(Schema.Union([Permission.BlockedError, Permission.CorrectedError, SessionErrors.NotFoundError]))(reply.error);
        return yield* Effect.fail(error);
      }
    }),
  };
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    if(request.tool==='gpt_imagegen'){
      const {runNativeImagegenWorker}=yield* Effect.promise(()=>import('./native-imagegen-worker.js'));
      const result=yield* Effect.tryPromise({try:()=>runNativeImagegenWorker({...request,tool:'gpt_imagegen'},{
        signal:browserController.signal,assertPermission:input=>Effect.runPromise(permissions.assert(input)),generate:async()=>{
          const id=randomUUID(),answer=new Promise<typeof ImageGenerationReply.Type>((resolve,reject)=>imageReplies.set(id,{resolve,reject}));
          try{await emit({type:'image-generation',id});}catch(cause){imageReplies.delete(id);throw cause;}
          const reply=await answer;if(!reply.ok)throw Error(reply.error);
        },
      }),catch:error=>new Tool.Error({message:error instanceof Error?error.message:'native_imagegen_worker_failed'})});
      yield* Effect.promise(()=>emit({type:'result',ok:true,result}));return;
    }
    if(request.tool==='devryan_browser'){
      const {runNativeBrowserWorker}=yield* Effect.promise(()=>import('./native-browser-worker.js'));
      const result=yield* Effect.tryPromise({try:()=>runNativeBrowserWorker(request,{
        signal:browserController.signal,assertPermission:input=>Effect.runPromise(permissions.assert(input)),
        operation:async operation=>{
          const id=randomUUID(),answer=new Promise<typeof BrowserReply.Type>((resolve,reject)=>browserReplies.set(id,{resolve,reject}));
          try{await emit({type:'browser',id,...operation});}catch(cause){browserReplies.delete(id);throw cause;}
          const reply=await answer;if(!reply.ok)throw Error(reply.error);return reply.result;
        },
      }),catch:error=>new Tool.Error({message:error instanceof Error?error.message:'native_browser_worker_failed'})});
      yield* Effect.promise(()=>emit({type:'result',ok:true,result}));return;
    }
    if(request.tool==='ast_grep_search'||request.tool==='ast_grep_replace'){
      const result=yield* Effect.tryPromise({try:()=>runReviewedAstWorker(request,{
        assertPermission:input=>Effect.runPromise(permissions.assert(input)),
        progress:update=>emit({type:'progress',update}),
      }),catch:error=>new Tool.Error({message:error instanceof Error?error.message:'native_ast_worker_failed'})});
      yield* Effect.promise(()=>emit({type:'result',ok:true,result}));return;
    }
    const entries = yield* acquireWriterRegistry(request, permissions);
    const leaf = entries.find((entry) => entry.id === request.tool);
    if (!leaf) return yield* Effect.die(new Error('native_writer_leaf_unavailable'));
    const input = rebaseWriterInput(request.input, request.tool, request.logicalProjectDirectory, request.projectDirectory);
    // The controller already decoded and ran its generic before hooks. Invoke
    // the native registration directly so hooks and permission run exactly once.
    yield* leaf.execute(input, { ...request.context,
      progress: (update) => Effect.promise(() => emit({ type: 'progress', update })) }).pipe(
      Effect.matchEffect({
        onSuccess: (result) => Effect.promise(() => emit({ type: 'result', ok: true, result })),
        onFailure: (error) => Effect.promise(() => emit({ type: 'result', ok: false,
          error: { message: error.message, metadata: error.metadata, error: error.error } })),
      }),
    );
  })).pipe(Effect.provide(Logger.layer([], { mergeWithExisting: false }))));
  lines.close(); process.stdin.destroy();
}

export async function runNativeWriterEntry() {
  if(process.argv.slice(2).length===1&&process.argv[2]==='--interview-document'){
    const worker=await import('./native-interview-worker.js');
    try{await worker.runNativeInterviewDocumentWorker();}
    catch(cause){await worker.reportNativeInterviewDocumentFailure(cause).catch(()=>{});process.exitCode=1;}
  }else if(process.argv.slice(2).length===1&&process.argv[2]==='--parse-document'){
    const parser=await import('./native-document-worker.js');
    try{await parser.runNativeDocumentParserWorker();}
    catch(cause){await parser.reportNativeDocumentParserFailure(cause).catch(()=>{});process.exitCode=1;}
  }else if(process.argv.slice(2).length===1&&process.argv[2]==='--process-images'){
    const worker=await import('./native-image-worker.js');
    try{await worker.runNativeImageWorkerEntry();}
    catch(cause){await worker.reportNativeImageWorkerFailure(cause).catch(()=>{});process.exitCode=1;}
  }else try { await run(); }
  catch (cause) {
    await emit({ type: 'result', ok: false, error: { message: cause instanceof Error ? cause.message : 'native_worker_failed' } }).catch(() => {});
    lines?.close(); process.stdin.destroy(); process.exitCode = 1;
  }
}

if (import.meta.main) await runNativeWriterEntry();
