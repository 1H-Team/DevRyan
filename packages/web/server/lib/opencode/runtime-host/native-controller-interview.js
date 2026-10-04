import {createHash} from 'node:crypto';
import {createNativeInterviewOwner} from './native-interview-owner.js';
import {createNativeOwnedRequests} from './native-owned-requests.js';

const fail=code=>Object.assign(new Error(code),{code,status:403,statusCode:403});
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const prefix=directory=>'/api/openchamber/interviews/'+createHash('sha256').update(directory).digest('hex');
/** Composition only: the original interview state machine owns behavior and
 * the existing admission, ledger and native session owners own all effects. */
export function createNativeControllerInterview(options){
 const requests=createNativeOwnedRequests('native_interview');
 const locations=options.snapshot.locations.filter(row=>row.activeRegistrationIDs?.includes('devryan.slim')).map(row=>{
  const roots=options.locations.find(location=>location.directory===row.directory);
  if(!roots)throw fail('native_interview_location_unreviewed');
  return {...roots,configuration:row.compatibility.slim?.mergedConfig?.interview??{},basePrefix:prefix(row.directory)};
 });
 const current=()=>{if(!options.isCurrent())throw fail('native_interview_controller_expired');};
 const canonical=async input=>{
  current();const session=await options.openCodeClient.sessions.get(input.sessionID,{directory:input.directory});
  if(session?.id!==input.sessionID||session.directory!==input.directory||session.time?.archived||session.revert)throw fail('native_interview_scope_invalid');
  current();return session;
 };
 const action=async(scope,kind,text)=>{
  await scope.recheck();await options.admissionOwner.withInterviewAction({directory:scope.directory,sessionID:scope.sessionID,
   messageID:scope.messageID,authorizationID:scope.authorizationID,kind,text},payload=>options.controller().call({action:'interview-action-owned',sessionID:scope.sessionID,...payload}));await scope.recheck();
 };
 const owner=createNativeInterviewOwner({locations,originals:options.originals,origin:options.origin,
  captureInterviewAuthorization:input=>options.admissionOwner.captureInterviewAuthorization({directory:input.directory,sessionID:input.sessionID,
   messageID:input.messageID,permit:input.permit,name:'interview',arguments:input.args}),
  captureInterviewUIAuthorization:async input=>{
   current();const session=input.interview?await canonical(input.interview):undefined;
   const reauthorize=await options.authorization.captureWebAuthorization({operation:'interview.'+input.operation,directory:input.directory,sessionID:session?.id},session);
   return {recheck:async()=>{current();await reauthorize();if(input.interview)await canonical(input.interview);current();}};
  },
  captureInterviewEventAuthorization:async input=>({recheck:async()=>{
   current();if(input.event.type!=='session.deleted')await options.authorization.authorizeOperation({operation:'runner.drain',sessionID:input.sessionID},await canonical(input));current();
  }}),
  runtime:{messages:async scope=>{await scope.recheck();const messages=await options.readMessages(scope);await scope.recheck();return messages;},
   continue:(scope,input)=>action(scope,'continue',input.text),notify:(scope,input)=>action(scope,'notify',input.text),rename:(scope,input)=>action(scope,'rename',input.title)},
  executeDocument:options.executeDocument,
  baseURL:async directory=>{current();return await options.baseURL()+prefix(directory);},
  openBrowser:async(scope,url)=>{await scope.recheck();await options.openBrowser(scope,url);await scope.recheck();},
 });
 const validate=input=>{
  current();if(!record(input)||input.controllerInstanceID!==options.instanceID||!locations.some(row=>row.directory===input.directory)
   ||typeof input.sessionID!=='string'||!/^ses[A-Za-z0-9_-]{1,128}$/.test(input.sessionID))throw fail('native_interview_scope_invalid');
 };
 return {
  async handleRpc(method,input,context){
   if(method==='native.slim.interview.settle')return requests.settle(input);
   validate(input);
   if(method==='native.slim.interview.active'){
    if(Object.keys(input).some(key=>!['controllerInstanceID','directory','sessionID'].includes(key)))throw fail('native_interview_scope_invalid');
    return owner.getActiveInterviewId(input);
   }
   if(method==='native.slim.interview.command'){
    if(Object.keys(input).some(key=>!['controllerInstanceID','requestID','directory','sessionID','messageID','args','permit'].includes(key)))throw fail('native_interview_scope_invalid');
    return requests.run(input,context,async(value,requestContext)=>{
     const parts=[];await owner.handleCommand({directory:value.directory,sessionID:value.sessionID,messageID:value.messageID,args:value.args,permit:value.permit},parts,requestContext);return parts;
    });
   }
   if(method==='native.slim.interview.event'){
    if(Object.keys(input).some(key=>!['controllerInstanceID','directory','sessionID','event'].includes(key))||!record(input.event)||!record(input.event.properties)
     ||!['session.status','session.next.text.ended','session.deleted','session.idle','message.updated'].includes(input.event.type))throw fail('native_interview_event_invalid');
    const properties=input.event.properties,id=properties.sessionID??properties.info?.sessionID??properties.info?.id;
    if(id!==input.sessionID||Buffer.byteLength(JSON.stringify(input.event))>1024*1024)throw fail('native_interview_event_invalid');
    await owner.handleEvent(input);return null;
   }
   throw fail('native_interview_operation_invalid');
  },
  async handleRequest(request,response){
   const url=new URL(request.url??'/', 'http://127.0.0.1');
   const location=locations.find(row=>url.pathname===row.basePrefix||url.pathname.startsWith(row.basePrefix+'/'));
   if(!location)return false;
   const original=request.url;request.url=(url.pathname.slice(location.basePrefix.length)||'/')+url.search;
   try{await owner.handleRequest({directory:location.directory,request,response});return true;}finally{request.url=original;}
  },
  close:async()=>{await requests.close();await owner.close();},
 };
}
