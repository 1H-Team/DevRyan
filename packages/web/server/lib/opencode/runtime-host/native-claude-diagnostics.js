import {CLAUDE_TRANSPORT_ERRORS} from './native-claude-transport-protocol.js';
export const NATIVE_CLAUDE_DIAGNOSTIC_CLUES=Object.freeze(['http_401','http_403','auth','model','unsupported_option','argument','config','permission','launcher','module','syntax','spawn','connection','native_receipt']);
const patterns={http_401:['http 401','status 401','401 unauthorized','"status":401'],http_403:['http 403','status 403','403 forbidden','"status":403'],
 auth:['authentication failed','authentication_error','unauthorized','not logged in','invalid api key','invalid authentication','oauth token has expired','invalid_token'],
 model:['model not found','unknown model','invalid model','model is not available'],unsupported_option:['unknown option','unrecognized option','unsupported option'],
 argument:['invalid argument','missing required argument','too many arguments'],config:['invalid configuration','invalid config','invalid settings','failed to load settings','invalid json'],
 permission:['permission denied','operation not permitted','eacces','eperm','sandbox denied'],launcher:['execution launcher','mutation_runtime_unsupported','invalid_execution_path'],
 module:['cannot find module','module not found','err_module_not_found','err_dlopen_failed','dyld:'],syntax:['syntaxerror','unexpected token'],
 connection:['econnreset','econnrefused','enotfound','etimedout','fetch failed','certificate verify failed'],
 native_receipt:['termination_unconfirmed','native_provider_transport_unverified','execution_receipt_invalid','mutation_runtime_unsupported']};
/** Numeric pattern state crosses chunks; no subprocess text is retained. */
export function createClaudeStderrDiagnostic(){
 const states=Object.entries(patterns).flatMap(([clue,values])=>values.map(value=>{
  const bytes=Buffer.from(value),prefix=new Uint16Array(bytes.length);let previous=0;
  for(let i=1;i<bytes.length;i++){while(previous&&bytes[i]!==bytes[previous])previous=prefix[previous-1];if(bytes[i]===bytes[previous])previous++;prefix[i]=previous;}
  return {clue,bytes,prefix,matched:0};
 }));
 const clues=new Set();let stderrBytes=0,scannedBytes=0;
 return {write(chunk){
  const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);stderrBytes=Math.min(1048576,stderrBytes+bytes.length);
  for(const original of bytes){if(scannedBytes>=32768)break;scannedBytes++;const byte=original>=65&&original<=90?original+32:original;
   for(const state of states){if(clues.has(state.clue))continue;while(state.matched&&byte!==state.bytes[state.matched])state.matched=state.prefix[state.matched-1];
    if(byte===state.bytes[state.matched])state.matched++;if(state.matched===state.bytes.length){clues.add(state.clue);state.matched=0;}
   }
  }
 },receipt(code,signal,spawnError=false){return {code:Number.isSafeInteger(code)&&code>=0&&code<=255?code:null,signalPresent:signal!==null&&signal!==undefined,
   stderrBytes,scannedBytes,truncated:stderrBytes>scannedBytes,clues:NATIVE_CLAUDE_DIAGNOSTIC_CLUES.filter(clue=>clues.has(clue)||clue==='spawn'&&spawnError)};}};
}
export function observeClaudeProcessDiagnostic(child,publish){
 const diagnostic=createClaudeStderrDiagnostic();let spawnError=false,transportError;
 child.stderr?.on('data',chunk=>diagnostic.write(chunk));
 child.once('error',error=>{spawnError=true;if(CLAUDE_TRANSPORT_ERRORS.includes(error?.code))transportError=error.code;});
 child.once('close',(code,signal)=>{try{publish({...diagnostic.receipt(code,signal,spawnError),...(transportError?{transportError}:{})});}catch{/* Observations cannot replace process settlement. */}});
}
