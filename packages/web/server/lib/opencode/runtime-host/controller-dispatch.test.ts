import {expect,test} from 'bun:test';
import {createNativeCommandDispatcher} from './controller-dispatch.js';
import {NATIVE_PROCESS_LIMITS,type NativeProcessCommand} from './native-process-protocol.js';

type Reply={ok:true;result:unknown}|{ok:false;error:{code:string;status:number;message:string}};
const hold=(id:string):NativeProcessCommand=>({protocol:1,id,action:'hold',sessionID:'ses_fixture'});
const managedJob=(id:string):NativeProcessCommand=>({protocol:1,id,action:'managed-job-owned',sessionID:'ses_child',phase:'prepare',
  permit:{token:'a'.repeat(64),sessionID:'ses_child',revision:0},input:{taskId:'dvr_task',leaseToken:'lease',rootSessionId:'ses_root',directory:'/fixture',
    sessionID:'ses_child',providerId:'fixture',modelId:'saved',agent:'fixer',variant:null,jobID:'dvr_job',notificationID:'msg_notice',messageID:'msg_input'}});
function fixture(run:(command:NativeProcessCommand)=>Promise<unknown>){
  const replies=new Map<string,Reply>();
  const dispatcher=createNativeCommandDispatcher({run,closeStartup:()=>{},respond:(id,result)=>{replies.set(id,result);}});
  return {dispatcher,replies};
}

test.each(['native_command_capacity','native_command_duplicate'])('a %s raised while running is rewritten so it cannot claim the command never ran',async code=>{
  const {dispatcher,replies}=fixture(async()=>{throw Object.assign(new Error(code),{code,status:503});});
  dispatcher.dispatch(hold('cmd_ran'));await dispatcher.drain();
  expect(replies.get('cmd_ran')).toEqual({ok:false,error:{code:'native_control_failed',status:503,message:'native_control_failed'}});
});

test('ordinary run failures keep their own codes',async()=>{
  const {dispatcher,replies}=fixture(async()=>{throw Object.assign(new Error('held'),{code:'native_session_held',status:409});});
  dispatcher.dispatch(hold('cmd_held'));await dispatcher.drain();
  expect(replies.get('cmd_held')).toEqual({ok:false,error:{code:'native_session_held',status:409,message:'native_session_held'}});
});

test('the dispatcher itself still answers capacity and duplicate before running anything',async()=>{
  let release!:()=>void;const blocked=new Promise<void>(resolve=>{release=resolve;});const ran:string[]=[];
  const {dispatcher,replies}=fixture(async command=>{ran.push(command.id);await blocked;return null;});
  for(let index=0;index<NATIVE_PROCESS_LIMITS.inFlight;index++)dispatcher.dispatch(hold(`cmd_${index}`));
  dispatcher.dispatch(hold('cmd_0'));dispatcher.dispatch(hold('cmd_over'));
  expect(replies.get('cmd_0')).toEqual({ok:false,error:{code:'native_command_duplicate',status:409,message:'native_command_duplicate'}});
  expect(replies.get('cmd_over')).toEqual({ok:false,error:{code:'native_command_capacity',status:503,message:'native_command_capacity'}});
  await Promise.resolve();expect(ran).not.toContain('cmd_over');
  release();await dispatcher.drain();
  expect(ran).toHaveLength(NATIVE_PROCESS_LIMITS.inFlight);expect(replies.get('cmd_1')).toEqual({ok:true,result:null});
});

test('a closing controller refuses managed-job commands before running them',async()=>{
  const ran:string[]=[];
  const {dispatcher,replies}=fixture(async command=>{ran.push(command.action);return null;});
  dispatcher.dispatch({protocol:1,id:'cmd_close',action:'close'});dispatcher.dispatch(managedJob('cmd_job'));await dispatcher.drain();
  expect(replies.get('cmd_job')).toEqual({ok:false,error:{code:'native_controller_stopping',status:409,message:'native_controller_stopping'}});
  expect(ran).toEqual(['close']);
});
