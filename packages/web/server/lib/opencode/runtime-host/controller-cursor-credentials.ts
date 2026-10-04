import {Credential} from '@opencode/core/credential';
import {Integration} from '@opencode/core/integration';
import {Location} from '@opencode/core/location';
import {Context,Effect,Option} from 'effect';
import type {CredentialMutationBinding,WithCredentialMutation} from './credential-mutation-contract.js';
import {CredentialMutationReauthorizeRef} from './credential-mutation-contract.js';
import {credentialMutationFingerprint as fingerprint} from './native-credential-mutation-owner.js';
import {HostRefusal} from './host-refusal.js';

/** Cursor uses the native key store and the same original-caller mutation queue. */
export function createControllerCursorCredentials(options:{
  readonly controllerInstanceID:string;
  readonly withCredentialMutation:WithCredentialMutation;
  readonly captureLocation:(directory:string)=>(()=>void);
}){
  let credentials:Credential.Interface|undefined;
  const refuse=(code:string):never=>{throw new HostRefusal(code,403,'credential.cursor');};
  const decorateCredential=(inner:Credential.Interface):Credential.Interface=>{
    credentials=inner;
    const mutate=<A,E,R>(operation:CredentialMutationBinding['operation'],original:Credential.Info|undefined,
      value:Credential.Value,request:unknown,action:Effect.Effect<A,E,R>):Effect.Effect<A,E,R>=>Effect.gen(function*(){
      const location=Option.getOrUndefined(Context.getOption(yield* Effect.context(),Location.Service));
      if(!location)return refuse('native_cursor_location_required');
      if(value.type!=='key')return refuse('native_cursor_key_required');
      const assertCurrent=options.captureLocation(location.directory);assertCurrent();
      const before=original?structuredClone(original):undefined;
      const binding:CredentialMutationBinding={kind:'cursor',directory:location.directory,controllerInstanceID:options.controllerInstanceID,
        integrationID:'cursor-acp',valueType:'key',operation,credentialID:before?.id,expectedFingerprint:before?fingerprint(before):undefined,
        requestedFingerprint:fingerprint(request)};
      return yield* options.withCredentialMutation(binding,Effect.gen(function*(){
        assertCurrent();
        if(before&&fingerprint(yield* inner.get(before.id))!==fingerprint(before))return refuse('native_credential_changed');
        assertCurrent();
        if(fingerprint(request)!==binding.requestedFingerprint)return refuse('native_credential_changed');
        const reauthorize=yield* CredentialMutationReauthorizeRef;
        if(!reauthorize)return refuse('native_credential_mutation_authorization_required');
        yield* reauthorize;assertCurrent();
        return yield* action;
      }));
    });
    const existing=<A,E,R>(operation:CredentialMutationBinding['operation'],id:Credential.ID,request:unknown,
      action:Effect.Effect<A,E,R>,value?:Credential.Value):Effect.Effect<A,E,R>=>Effect.gen(function*(){
      const original=yield* inner.get(id);
      return yield* original?.integrationID==='cursor-acp'?mutate(operation,original,value??original.value,request,action):action;
    });
    return {...inner,
      create:input=>{const copy=structuredClone(input);return copy.integrationID==='cursor-acp'?mutate('create',undefined,copy.value,copy,inner.create(copy)):inner.create(copy);},
      update:(id,updates)=>{const copy=structuredClone(updates);return existing('update',id,{id,updates:copy},inner.update(id,copy),copy.value);},
      activate:id=>existing('activate',id,{id},inner.activate(id)),
      remove:id=>existing('remove',id,{id},inner.remove(id)),
    };
  };
  const decorateIntegration=(inner:Integration.Interface,location:Location.Interface,assertCurrent:()=>void):Integration.Interface=>{
    const scoped=<A,E,R>(action:Effect.Effect<A,E,R>)=>Effect.gen(function*(){assertCurrent();const result=yield* action;assertCurrent();return result;})
      .pipe(Effect.provideService(Location.Service,location));
    const existing=<A,E,R>(id:Credential.ID,action:Effect.Effect<A,E,R>)=>Effect.gen(function*(){
      const original=credentials?yield* credentials.get(id):undefined;
      return yield* original?.integrationID==='cursor-acp'?scoped(action):action;
    });
    return {...inner,connection:{...inner.connection,
      key:input=>input.integrationID==='cursor-acp'?scoped(inner.connection.key(input)):inner.connection.key(input),
      update:(id,updates)=>existing(id,inner.connection.update(id,updates)),
      activate:id=>existing(id,inner.connection.activate(id)),remove:id=>existing(id,inner.connection.remove(id)),
    }};
  };
  return {decorateCredential,decorateIntegration};
}
