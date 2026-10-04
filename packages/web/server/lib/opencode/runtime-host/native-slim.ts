import type { Context, Plugin as PromisePlugin } from '@opencode/plugin/promise/plugin';
import type { ToolEditor } from '@opencode/plugin/promise/tool';
import type { AgentEditor } from '@opencode/plugin/promise/agent';
import type { CommandEditor } from '@opencode/plugin/promise/command';
import { fromPromise } from '@opencode/plugin/promise/adapter';
import type { NativeConfigurationSnapshot } from './native-configuration-snapshot.js';
import type {ReviewedSlimHostBinding} from '../../../../runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js';

/** Exact pinned factory inventory. Production readiness must assign each behavior an owner. */
export const REVIEWED_SLIM_HOOK_INVENTORY=Object.freeze([
  'agent','tool','mcp','config','event','v2.session.retry','tool.execute.before','tool.execute.after',
  'command.execute.before','chat.headers','experimental.session.compacting','chat.message',
  'experimental.chat.system.transform','experimental.chat.messages.transform',
]);

/** The actual pinned package setup is supplied by the statically compiled entrypoint. */
export interface NativeSlimOptions {
  readonly setup: PromisePlugin['setup'];
  /** Only the reviewed composition may mutate native context through original pure hooks. */
  readonly contextTransforms?: boolean;
  readonly assertSessionHook?:(directory:string,sessionID:string)=>Promise<void>;
  readonly bindConfiguration:(input:{readonly directory:string;readonly configuration:Record<string,unknown>;readonly userConfigPath?:string;readonly projectConfigPath?:string;readonly activePreset?:string})=>()=>void;
  readonly bindHost:(input:ReviewedSlimHostBinding)=>()=>void;
  readonly hostBindings:(directory:string)=>ReviewedSlimHostBinding;
  readonly snapshot: NativeConfigurationSnapshot;
  readonly tools: readonly string[];
  readonly toolsForDirectory?:(directory:string)=>readonly string[];
  readonly delegatedTools: readonly string[];
  readonly delegatedCommands: readonly string[];
}

function restricted<T extends object>(target: T, allowed: readonly PropertyKey[], replacements: ReadonlyMap<PropertyKey, unknown> = new Map()): T {
  return new Proxy(target, { get(object, key) {
    if (replacements.has(key)) return replacements.get(key);
    if (!allowed.includes(key)) return undefined;
    const value = Reflect.get(object, key, object);
    return typeof value === 'function' ? value.bind(object) : value;
  } });
}

/** Allow registrations, never lend policy mutation, arbitrary generation or an independent executor. */
export function nativeSlimPlugin(options: NativeSlimOptions) {
  if (new Set(options.tools).size !== options.tools.length || options.tools.some(tool => options.delegatedTools.includes(tool))) throw new Error('native_slim_policy_invalid');
  const plugin: PromisePlugin = { id: 'devryan.slim', setup: async context => {
    const location = options.snapshot.locations.find(value => value.directory === context.location.directory);
    if (!location) throw new Error('native_slim_location_unreviewed');
    if(location.activeRegistrationIDs&&!location.activeRegistrationIDs.includes('devryan.slim'))return;
    const tools=options.toolsForDirectory?.(location.directory)??options.tools;
    if(new Set(tools).size!==tools.length||tools.some(tool=>!options.tools.includes(tool)))throw new Error('native_slim_policy_invalid');
    let toolTransformRegistered = false;
    let refusal: Error | undefined;
    const reject = (code: string): never => { refusal = new Error(code); throw refusal; };
    const agentTransform: Context['agent']['transform'] = callback => context.agent.transform(editor => {
      const frozen: AgentEditor = { list: () => structuredClone(editor.list()), get: id => structuredClone(editor.get(id)),
        default: () => {}, update: () => {}, remove: () => {} };
      callback(frozen);
    });
    const toolTransform: Context['tool']['transform'] = callback => {
      toolTransformRegistered = true;
      return context.tool.transform(editor => {
      // Native transforms replay on reload. Identity is checked within this
      // replay, never against a mutable Set from an earlier tool snapshot.
      const registered = new Set<string>();
      const add: ToolEditor['add'] = tool => {
        if (options.delegatedTools.includes(tool.name)) return;
        if (!tools.includes(tool.name) || tool.options?.namespace) reject('native_slim_tool_unreviewed');
        if (registered.has(tool.name)) reject('native_slim_tool_duplicate');
        registered.add(tool.name);
        editor.add({ ...tool, options: { ...(tool.options?.permission ? { permission: tool.options.permission } : {}), codemode: false } });
      };
      callback({ list: () => editor.list(), get: id => editor.get(id), add,
        update: () => reject('native_slim_tool_mutation_unreviewed'),
        remove: () => reject('native_slim_tool_mutation_unreviewed'),
        namespace: () => reject('native_slim_namespace_unreviewed') });
      if (tools.some(tool => !registered.has(tool))) reject('native_slim_required_registration_missing');
    }); };
    const commandTransform: Context['command']['transform'] = callback => context.command.transform(() => {
      const editor: CommandEditor = { add: definition => {
        if (!Object.hasOwn(location.configuration.commands ?? {}, definition.name) && !options.delegatedCommands.includes(definition.name)) {
          reject('native_slim_command_unreviewed');
        }
        // Configured command templates use the sealed native Config executor;
        // interactive commands are delegated to their reviewed host owner.
      } };
      callback(editor);
    });
    const hook: Context['session']['hook'] = (name, callback, hookOptions) => {
      if (!['prompt', 'context', 'model.request', 'retry'].includes(name) && !(options.contextTransforms && name === 'compaction')) {
        // Compaction ownership is delegated; register an empty scoped hook so
        // the package's disposer still has the actual SDK lifetime.
        if (name === 'compaction') return context.session.hook(name, () => {});
        return reject('native_slim_hook_unreviewed');
      }
      return context.session.hook(name, async event => {
        await options.assertSessionHook?.(location.directory,event.sessionID);
        try {
        if ('system' in event && !options.contextTransforms) {
          const system = structuredClone(event.system);
          try { await callback(event); }
          finally { event.system.splice(0, event.system.length, ...system); }
        } else await callback(event);
        } finally {await options.assertSessionHook?.(location.directory,event.sessionID);}
      }, hookOptions);
    };
    const limited: Context = { ...context,
      agent: restricted(context.agent, ['list', 'get'], new Map([['transform', agentTransform]])),
      tool: restricted(context.tool, ['list', 'hook'], new Map([['transform', toolTransform]])),
      command: restricted(context.command, ['list'], new Map([['transform', commandTransform]])),
      session: restricted(context.session, ['get', 'context'], new Map([['hook', hook]])),
      // Independent wake APIs are withheld. Background task/Council ownership
      // is delegated to the host; package callbacks cannot borrow its policy.
      // The build disables only the reviewed updater before its side effects.
      permission: restricted(context.permission, []), mcp: restricted(context.mcp, []),
      generate: restricted(context.generate, []), storage: restricted(context.storage, []),
      rpc: restricted(context.rpc, []), shell: restricted(context.shell, []), worktree: restricted(context.worktree, []),
      provider: restricted(context.provider, []), model: restricted(context.model, []), aisdk: restricted(context.aisdk, []),
      integration: restricted(context.integration, []), reference: restricted(context.reference, []),
      skill: restricted(context.skill, ['list', 'get']), websearch: restricted(context.websearch, []), vcs: restricted(context.vcs, []),
      experimental: { terminal: restricted(context.experimental.terminal, []) },
    };
    const saved=location.compatibility.slim;
    if(!saved || typeof saved!=='object' || !('mergedConfig' in saved) || !saved.mergedConfig || typeof saved.mergedConfig!=='object' || Array.isArray(saved.mergedConfig)) throw new Error('native_slim_snapshot_invalid');
    const config={...saved.mergedConfig};
    const releaseConfiguration=options.bindConfiguration({directory:location.directory,configuration:config,
      ...'userConfigPath' in saved && typeof saved.userConfigPath==='string'?{userConfigPath:saved.userConfigPath}:{},
      ...'projectConfigPath' in saved && typeof saved.projectConfigPath==='string'?{projectConfigPath:saved.projectConfigPath}:{},
      ...'activePreset' in saved && typeof saved.activePreset==='string'?{activePreset:saved.activePreset}:{}});
    let releaseHost:(()=>void)|undefined;
    let cleanup: Awaited<ReturnType<PromisePlugin['setup']>> | undefined;
    try {
      const bindings=options.hostBindings(location.directory);
      if(bindings.directory!==location.directory)throw new Error('native_slim_host_location_mismatch');
      releaseHost=options.bindHost(bindings);
      cleanup = await options.setup(limited);
      if (refusal) throw refusal;
      if (tools.length && !toolTransformRegistered) throw new Error('native_slim_required_registration_missing');
      return async()=>{try{await cleanup?.();}finally{releaseHost?.();releaseConfiguration();}};
    } catch (error) { try{await cleanup?.();}finally{releaseHost?.();releaseConfiguration();} throw error; }
  } };
  return fromPromise(plugin);
}
