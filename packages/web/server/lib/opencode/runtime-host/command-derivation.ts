import { Context, Effect, Option } from 'effect';
import { Command } from '@opencode/core/command';
import { Config } from '@opencode/core/config';
import { Agent } from '@opencode/core/agent';
import type {ConfigCommand} from '@opencode/schema/config/command';
import type { Config as ConfigSchema } from '@opencode/schema/config';
import { HostRefusal, refuseHost } from './host-refusal.js';
import { RegistrationOriginRef,type RegistrationOrigin } from './registration-origin.js';
import { OperationPermitRef, requestPermit, type NativeAdmissionBridge } from './native-admission-contract.js';
import type {NativeSlimCommandInput} from './native-slim-commands.js';

/** One constructor-owned marker, entered only at a sealed native definition. */
export interface ReviewedCommandBehavior {readonly origin:RegistrationOrigin;readonly name:string;readonly definition:ConfigCommand.Info}
const stable=(value:unknown):string|undefined=>JSON.stringify(value,(_key,entry)=>entry&&typeof entry==='object'&&!Array.isArray(entry)?Object.fromEntries(Object.keys(entry).sort().map(key=>[key,entry[key]])):entry);
export function createCommandDerivation({ bridge, checked,reviewedBehaviorCommands=[], reviewedConfigurationForDirectory, beforeConfiguredCommand }: {
  readonly bridge: NativeAdmissionBridge;
  readonly checked: <A>(action: () => Promise<A>, operation: string, sessionID?: string) => Effect.Effect<A>;
  readonly reviewedBehaviorCommands?:readonly ReviewedCommandBehavior[];
  readonly reviewedConfigurationForDirectory?: (directory: string) => ConfigSchema.Info | undefined;
  readonly beforeConfiguredCommand?: (input:NativeSlimCommandInput)=>Effect.Effect<void,unknown>;
}) {
  const behaviors=structuredClone(reviewedBehaviorCommands);
  const CommandDerivation = Context.Reference<string | undefined>('DevRyan/CommandDerivation', { defaultValue: () => undefined });
  const decorate = (inner: Command.Interface, directory?: string): Command.Interface => {
    // SDK registration deliberately removes Config/Agent services. Capture the
    // host document at core acquisition, before entering any plugin context.
    const captured = directory === undefined ? undefined : reviewedConfigurationForDirectory?.(directory);
    const configuration = captured === undefined ? undefined : structuredClone(captured);
    return Command.Service.of({ ...inner,
    transform: callback => Effect.gen(function* () {
      const origin = yield* RegistrationOriginRef;
      const config = Option.getOrUndefined(Context.getOption(yield* Effect.context(), Config.Service));
      const agents = Option.getOrUndefined(Context.getOption(yield* Effect.context(), Agent.Service));
      return yield* inner.transform(editor => callback({ add: definition => editor.add({ ...definition,
        execute: invocation => Effect.gen(function* () {
          if (!origin || (!config && !configuration) || !bridge.beginCommand) {
            return yield* refuseHost(new HostRefusal('native_command_definition_unreviewed', 403, 'session.command', invocation.sessionID));
          }
          const documents = config ? yield* config.entries() : [];
          const reviewed = [...documents].reverse().find(entry => entry.type === 'document' && entry.info.commands?.[definition.name] !== undefined);
          const behavior=behaviors.find(value=>value.name===definition.name&&stable(value.origin)===stable(origin));
          // Reviewed plugin behavior always uses the constructor document when
          // available, even if plugin code provides its own Config service.
          const frozenBehavior = behavior && configuration !== undefined;
          const configured = frozenBehavior ? configuration.commands?.[definition.name]
            : config ? (reviewed?.type === 'document' ? reviewed.info.commands?.[definition.name] : undefined)
              : configuration?.commands?.[definition.name];
          if(behavior&&(configured!==undefined||definition.description!==behavior.definition.description))return yield* refuseHost(new HostRefusal('native_command_definition_unreviewed',403,'session.command',invocation.sessionID));
          const command=origin.kind==='native'&&origin.id==='opencode.config.command'?configured:behavior?.definition;
          if (!command) return yield* refuseHost(new HostRefusal('native_command_definition_unreviewed', 403, 'session.command', invocation.sessionID));
          const agent = command.agent === undefined || !agents || frozenBehavior ? undefined : (yield* agents.get(Agent.ID.make(command.agent)));
          const savedAgentModel = command.agent === undefined ? undefined : configuration?.agents?.[command.agent]?.model;
          const selected = command.model ?? (agents && !frozenBehavior ? undefined : savedAgentModel);
          const model = selected === undefined ? agent?.model : { providerID: selected.providerID, id: selected.model,
            ...(selected.variant === undefined ? {} : { variant: selected.variant }) };
          const permit = (yield* OperationPermitRef) ?? requestPermit();
          if (!permit) return yield* refuseHost(new HostRefusal('native_permit_required', 403, 'session.command', invocation.sessionID));
          const marker = yield* checked(() => bridge.beginCommand!({ permit, sessionID: invocation.sessionID,
            name: definition.name, definition: command, invocation, model,origin }), 'session.command', invocation.sessionID);
          return yield* Effect.gen(function*(){
            if(beforeConfiguredCommand&&origin.kind==='native'&&origin.id==='opencode.config.command'){
              if(!directory)return yield* refuseHost(new HostRefusal('native_command_location_required',403,'session.command',invocation.sessionID));
              yield* beforeConfiguredCommand({directory,name:definition.name,invocation});
            }
            return yield* definition.execute(invocation);
          }).pipe(Effect.provideService(CommandDerivation, marker));
        }),
      }) }));
    }),
  });
  };
  return { decorate, requestMarker: () => CommandDerivation,
    clear: <A, E, R>(action: Effect.Effect<A, E, R>) => action.pipe(Effect.provideService(CommandDerivation, undefined)) };
}
