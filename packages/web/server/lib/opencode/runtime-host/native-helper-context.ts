import {Context,Effect} from 'effect';
import type {Context as PluginContext} from '@opencode/plugin/effect/plugin';

type HookSession=Effect.Success<ReturnType<PluginContext['session']['get']>>;
/** Correlation for native hook reads only; never evidence for native admission. */
export const NativeHelperContextRef=Context.Reference<HookSession|undefined>('DevRyan/NativeHelperContext',{defaultValue:()=>undefined});
export function helperPluginContext(context:PluginContext):PluginContext{
 return {...context,session:{...context.session,get:input=>Effect.gen(function*(){
  const helper=yield* NativeHelperContextRef;
  return helper&&input.sessionID===helper.id&&context.location.directory===helper.location.directory
   ?helper:yield* context.session.get(input);
 })}};
}
