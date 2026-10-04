import path from 'node:path';
import os from 'node:os';
const fail=code=>Object.assign(new Error(code),{code});
/** A fully specified local command; no path/id flags, prompts, remote requests
 * or server bootstrap. The focused bundle owner verifies filesystem authority. */
export async function runRuntimeBundleCommand({positionals,optionNames=[],expectedRevision,environment=process.env,home=os.homedir(),resume}){
 if(optionNames.some(name=>!['expected-revision','json','quiet','plain'].includes(name))||optionNames.filter(name=>name==='expected-revision').length>1)throw fail('bundle_command_invalid');
 if(!Array.isArray(positionals)||positionals.length!==3||positionals.join(' ')!=='runtime bundle resume')throw fail('bundle_command_invalid');
 if(typeof expectedRevision!=='string'||!/^\d+$/.test(expectedRevision)||!Number.isSafeInteger(Number(expectedRevision))||Number(expectedRevision)<1)throw fail('bundle_selection_revision_conflict');
 const controlRoot=environment.DEVRYAN_RUNTIME_BUNDLE_ROOT??path.join(environment.XDG_STATE_HOME??path.join(home,'.local','state'),'devryan','runtime-bundles');
 if(!path.isAbsolute(controlRoot)||path.normalize(controlRoot)!==controlRoot)throw fail('bundle_recovery_owner_required');
 const action=resume??(await import('../server/lib/opencode/runtime-host/runtime-bundle-resume.js')).resumeRuntimeBundle;
 return action({controlRoot,input:{expectedRevision:Number(expectedRevision)}});
}
