import {createHash} from 'node:crypto';
/** Shared original sealing recipe. Receipts and exact native encoding remain
 * required separately; this digest alone never authorizes a completion. */
export const nativeShellCompletionFingerprint=({sessionID,messageID,token,text})=>createHash('sha256').update(JSON.stringify({generation:2,sessionID,messageID,operation:'shell.completion',token,text},
 (_key,value)=>value!==null&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])):value)).digest('hex');
