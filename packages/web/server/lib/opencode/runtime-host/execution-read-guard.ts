import {createNativeReadGuard as guard} from './native-read-paths.js';
import {HostRefusal} from './host-refusal.js';
/** Preserve the native defect channel while sharing the same Node read boundary. */
export const createNativeReadGuard=(options:Parameters<typeof guard>[0])=>async(target:string):Promise<void>=>{
 try{await guard(options)(target);}catch(error){
  if(error instanceof Error && 'code' in error && error.code==='native_read_root_denied')throw new HostRefusal('native_read_root_denied',403,'tool.read');
  throw error;
 }
};
