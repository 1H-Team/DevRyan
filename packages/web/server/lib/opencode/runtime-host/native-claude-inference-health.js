import {CLAUDE_TRANSPORT_ERRORS} from './native-claude-transport-protocol.js';

export const CLAUDE_LAUNCH_FAILURE_CODES=Object.freeze([...CLAUDE_TRANSPORT_ERRORS,'claude_process_permission','claude_process_failed','provider_authentication','provider_internal']);
/** Runtime-local, content-free health; saved-account availability remains independent. */
export function createClaudeInferenceHealth({directories,now=Date.now}){
 const state=new Map(directories.map(directory=>[directory,{lastSuccessfulInferenceAt:null,lastLaunchFailure:null}]));
 return {
  status:directory=>structuredClone(state.get(directory)??{lastSuccessfulInferenceAt:null,lastLaunchFailure:null}),
  process:diagnostic=>{
   const current=state.get(diagnostic.directory),receipt=diagnostic.receipt;
   if(!current||diagnostic.type!=='claude-process-diagnostic'||!receipt||receipt.code===0)return;
   const code=CLAUDE_TRANSPORT_ERRORS.includes(receipt.transportError)?receipt.transportError:receipt.clues?.includes('permission')?'claude_process_permission':'claude_process_failed';
   current.lastLaunchFailure={at:now(),code};
  },
  result:({sessionID,directory},record)=>{
   const current=state.get(directory),info=record?.info;
   if(!current||info?.sessionID!==sessionID||info.role!=='assistant'||info.providerID!=='anthropic'||!Number.isSafeInteger(info.time?.completed)||info.time.completed>now())return;
   if(info.error){
    const type=info.error.data?.v2Type;
    if(type==='provider.auth')current.lastLaunchFailure={at:info.time.completed,code:'provider_authentication'};
    else if(!current.lastLaunchFailure||current.lastLaunchFailure.at<info.time.completed-10000)current.lastLaunchFailure={at:info.time.completed,code:'provider_internal'};
    return;
   }
   const tokens=info.tokens;
   if(!tokens||![tokens.input,tokens.output,tokens.cache?.read,tokens.cache?.write].some(value=>typeof value==='number'&&Number.isFinite(value)&&value>0))return;
   current.lastSuccessfulInferenceAt=Math.max(current.lastSuccessfulInferenceAt??0,info.time.completed);
   if(!current.lastLaunchFailure||current.lastLaunchFailure.at<=info.time.completed)current.lastLaunchFailure=null;
  },
 };
}
