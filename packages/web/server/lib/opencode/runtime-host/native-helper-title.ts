import {Context,Effect} from 'effect';
import type {NativeHelperTitleInput} from './native-helper-contract.js';
import type {SessionEvent} from '@opencode/schema/session-event';
import type {Database} from '@opencode/core/database/database';
import {HostRefusal,refuseHost} from './host-refusal.js';

export const NativeHelperTitleRef=Context.Reference<NativeHelperTitleInput|undefined>('DevRyan/NativeHelperTitle',{defaultValue:()=>undefined});
/** Registered before the original rename projector, inside the same native transaction. */
export function assertNativeHelperTitle(database:Database.Interface|undefined,event:typeof SessionEvent.Renamed.Type){
 return Effect.gen(function*(){
  const expected=yield* NativeHelperTitleRef;if(!expected)return;
  if(!database||expected.sessionID!==event.data.sessionID||expected.title!==event.data.title)return yield* refuseHost(new HostRefusal('native_helper_title_conflict',409,'session.rename',expected.sessionID));
  const rows=yield* database.db.$client.unsafe<{title:string|null;directory:string}>('SELECT title,directory FROM session_v2 WHERE id=?',[expected.sessionID]).pipe(Effect.orDie);
  if(rows.length!==1||(rows[0].title??'')!==expected.expectedTitle||rows[0].directory!==expected.directory)return yield* refuseHost(new HostRefusal('native_helper_title_conflict',409,'session.rename',expected.sessionID));
 });
}
