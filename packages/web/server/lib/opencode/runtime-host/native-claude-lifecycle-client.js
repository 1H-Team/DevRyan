import {parseClaudeLifecycle,parseClaudeLifecycleOperation} from './native-claude-lifecycle.js';
const fail=()=>{throw Object.assign(new Error('native_claude_lifecycle_owner_expired'),{code:'native_claude_lifecycle_owner_expired',status:503,statusCode:503});};
/** Private controller calls do not re-enter the host credential queue. The caller
 * holds that queue through the complete credential operation and finalizers. */
export function createNativeClaudeLifecycleClient({controller,isCurrent}){
 const call=async command=>{
  if(!isCurrent())fail();const owner=controller(),instanceID=owner.instanceID;
  const result=await owner.call({...command,controllerInstanceID:instanceID});
  if(!isCurrent()||controller()!==owner||controller().instanceID!==instanceID)fail();
  return parseClaudeLifecycle(result);
 };
 return {read:()=>call({action:'claude-lifecycle-read-owned'}),transition:(expectedRevision,operation)=>{
  if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0)fail();
  return call({action:'claude-lifecycle-transition-owned',expectedRevision,operation:parseClaudeLifecycleOperation(operation)});
 }};
}
