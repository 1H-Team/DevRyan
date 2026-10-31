import {createHash} from 'node:crypto';
import path from 'node:path';
import {createNativeReadGuard as guard} from './native-read-paths.js';
import {HostRefusal} from './host-refusal.js';
type Operation='tool.read'|'tool.write';
const GUIDANCE:Record<Operation,string>={
 'tool.read':'File tools read only inside the project; read workspace files by their project path',
 'tool.write':'File tools write only inside the project; write scratch files from the shell under $DEVRYAN_SESSION_TMP or $TMPDIR',
};
/** Preserve the native defect channel while sharing the same Node read boundary. */
export const createNativeReadGuard=(options:Parameters<typeof guard>[0],operation:Operation='tool.read')=>async(target:string):Promise<void>=>{
 try{await guard(options)(target);}catch(error){
  if(error instanceof Error && 'code' in error && error.code==='native_read_root_denied')throw new HostRefusal('native_read_root_denied',403,operation,undefined,GUIDANCE[operation]);
  throw error;
 }
};
// A writable shell's $PWD is the call's private view of its repository,
// <ledger>/<sha256(repository)>/views/<token>/worktree, so script output names
// view paths. Read such a path as the project file the view mirrors; the read
// guard then decides on that project path. Anything else is returned unchanged.
const VIEW_PATH=/\/([0-9a-f]{64})\/views\/[^/]+\/worktree(?:\/(.*))?$/;
export const projectPathForView=(target:string,directory:string):string=>{
 const match=path.isAbsolute(target)?VIEW_PATH.exec(path.resolve(target)):null;
 if(!match)return target;
 for(let candidate=path.resolve(directory);;candidate=path.dirname(candidate)){
  if(createHash('sha256').update(candidate).digest('hex')===match[1])return path.join(candidate,match[2]??'');
  if(path.dirname(candidate)===candidate)return target;
 }
};
