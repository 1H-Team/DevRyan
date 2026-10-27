import os from 'node:os';
import {resolveRuntimeBundleRoot} from '../server/lib/opencode/runtime-host/runtime-bundle-root.js';
const fail=code=>Object.assign(new Error(code),{code});
/** A fully specified local command; no path/id flags, prompts, remote requests
 * or server bootstrap. The focused bundle owner verifies filesystem authority. */
export async function runRuntimeBundleCommand({positionals,optionNames=[],expectedRevision,environment=process.env,home=os.homedir(),resume}){
 if(optionNames.some(name=>!['expected-revision','json','quiet','q','plain'].includes(name))||optionNames.filter(name=>name==='expected-revision').length>1)throw fail('bundle_command_invalid');
 if(!Array.isArray(positionals)||positionals.length!==3||positionals.join(' ')!=='runtime bundle resume')throw fail('bundle_command_invalid');
 if(typeof expectedRevision!=='string'||!/^\d+$/.test(expectedRevision)||!Number.isSafeInteger(Number(expectedRevision))||Number(expectedRevision)<1)throw fail('bundle_selection_revision_conflict');
 const controlRoot=resolveRuntimeBundleRoot(environment,home);
 const action=resume??(await import('../server/lib/opencode/runtime-host/runtime-bundle-resume.js')).resumeRuntimeBundle;
 return action({controlRoot,input:{expectedRevision:Number(expectedRevision)}});
}
