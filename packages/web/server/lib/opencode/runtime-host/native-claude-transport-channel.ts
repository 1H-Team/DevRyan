import {EventEmitter} from 'node:events';
import {PassThrough, Writable} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {CLAUDE_TRANSPORT_CHUNK_BYTES, parseClaudeTransportRequest, parseClaudeTransportReply} from './native-claude-transport-protocol.js';
import type {ClaudeTransportStart, ClaudeTransportRequest} from './native-claude-transport-protocol.js';

const failure=(code:string)=>Object.assign(new Error(code),{code});
class BoundedTransportInput extends Writable {
 override write(chunk:unknown,encodingOrCallback?:BufferEncoding|((error:Error|null|undefined)=>void),callback?:(error:Error|null|undefined)=>void):boolean{
  const encoding=typeof encodingOrCallback==='string'?encodingOrCallback:undefined;
  const size=typeof chunk==='string'?Buffer.byteLength(chunk,encoding):chunk instanceof Uint8Array?chunk.byteLength:0;
  if(this.writableLength+size>32*1024*1024){this.destroy(failure('native_claude_transport_overflow'));return false;}
  return typeof encodingOrCallback==='function'?super.write(chunk,encodingOrCallback):super.write(chunk,encoding??'utf8',callback);
 }
}
export interface ClaudeTransportProcess extends EventEmitter {
 readonly stdin:Writable; readonly stdout:PassThrough; readonly stderr:PassThrough;
 pid:number|undefined; killed:boolean; exitCode:number|null; signalCode:NodeJS.Signals|null;
 kill(signal?:NodeJS.Signals):boolean;
}
/** The synchronous SDK child interface transports bytes only; the host owns
 * launch, credentials, confinement and the actual termination receipt. */
export function createClaudeTransportChannel(write:(value:ClaudeTransportRequest)=>void){
 const runs=new Map<string,{child:ClaudeTransportProcess;attemptID:string;done:Promise<void>;resolve:()=>void;sequence:number;pendingEnd?: (error?:Error|null)=>void;pendingWrite?:{chunk:Buffer;offset:number;callback:(error?:Error|null)=>void}}> ();let closed=false;
 const send=(frame:ClaudeTransportRequest)=>write(parseClaudeTransportRequest(frame));
 const pump=(id:string)=>{
  const run=runs.get(id);if(!run||run.child.killed||run.child.pid===undefined)return;
  if(!run.pendingWrite){if(run.pendingEnd){const finish=run.pendingEnd;delete run.pendingEnd;send({protocol:1,type:'claude-transport',action:'end',id,attemptID:run.attemptID});finish();}return;}
  const pending=run.pendingWrite;
  if(pending.offset===pending.chunk.length){delete run.pendingWrite;pending.callback();return;}
  const chunk=pending.chunk.subarray(pending.offset,pending.offset+CLAUDE_TRANSPORT_CHUNK_BYTES);pending.offset+=chunk.length;run.sequence++;
  send({protocol:1,type:'claude-transport',action:'stdin',id,attemptID:run.attemptID,sequence:run.sequence,chunk:chunk.toString('base64')});
 };
 const settle=(id:string,code:number,error?:string,cancelled=false)=>{
  const run=runs.get(id);if(!run)return;
  runs.delete(id);run.child.exitCode=code;run.child.signalCode=cancelled?'SIGTERM':null;
  run.pendingWrite?.callback(failure('native_claude_transport_expired'));
  run.pendingEnd?.(failure('native_claude_transport_expired'));
  if(error)run.child.emit('error',failure(error));
  run.child.emit('exit',code,run.child.signalCode);
  run.child.stdout.end();run.child.stderr.end();run.child.stdin.destroy();
  run.child.emit('close',code,run.child.signalCode);run.resolve();
 };
 return {spawn(input:Omit<ClaudeTransportStart,'protocol'|'type'|'action'|'id'>,signal?:AbortSignal):ClaudeTransportProcess{
  if(closed||runs.size>=64)throw failure('native_claude_transport_expired');
  const id=randomUUID(),start=parseClaudeTransportRequest({protocol:1,type:'claude-transport',action:'start',id,...input});
  const child:ClaudeTransportProcess=Object.assign(new EventEmitter(),{pid:undefined,killed:false,exitCode:null,signalCode:null,
   stdout:new PassThrough(),stderr:new PassThrough(),stdin:new BoundedTransportInput({
    write(chunk:Buffer,_encoding,callback){
     const run=runs.get(id);if(!run){callback(failure('native_claude_transport_expired'));return;}
     if(chunk.length>32*1024*1024){child.kill();callback(failure('native_claude_transport_overflow'));return;}
     run.pendingWrite={chunk,offset:0,callback};
     try{pump(id);}
     catch{child.kill();callback(failure('native_claude_transport_failed'));}
    },final(callback){const run=runs.get(id);if(!run){callback(failure('native_claude_transport_expired'));return;}run.pendingEnd=callback;try{pump(id);}catch{callback(failure('native_claude_transport_failed'));}},
   }),kill(){
    if(!runs.has(id))return false;if(child.killed)return true;child.killed=true;
    send({protocol:1,type:'claude-transport',action:'cancel',id,attemptID:input.attemptID});return true;
   }});
  child.stdin.on('error',()=>{if(runs.has(id))child.kill();});
  let resolve!:()=>void;const done=new Promise<void>(finish=>{resolve=finish;});
  runs.set(id,{child,attemptID:input.attemptID,done,resolve,sequence:0});
  const abort=()=>child.kill();signal?.addEventListener('abort',abort,{once:true});
  child.once('close',()=>signal?.removeEventListener('abort',abort));
  try{send(start);if(signal?.aborted)abort();}catch{runs.delete(id);resolve();signal?.removeEventListener('abort',abort);throw failure('native_claude_transport_failed');}
  return child;
 },accept(value:unknown){
  const reply=parseClaudeTransportReply(value),run=runs.get(reply.id);
  if(!run||run.attemptID!==reply.attemptID)throw failure('native_claude_transport_expired');
  if(reply.action==='started'){if(run.child.pid!==undefined)throw failure('native_claude_transport_invalid');run.child.pid=reply.pid;run.child.emit('spawn');
   pump(reply.id);return;
  }
  if(reply.action==='input-accepted'){
   if(run.child.pid===undefined||!run.pendingWrite||run.sequence!==reply.sequence)throw failure('native_claude_transport_invalid');
   pump(reply.id);return;
  }
  if(reply.action==='stdout'||reply.action==='stderr'){
   if(run.child.pid===undefined)throw failure('native_claude_transport_invalid');
   const bytes=Buffer.from(reply.chunk,'base64'),stream=run.child[reply.action];
   if(stream.readableLength+stream.writableLength+bytes.length>32*1024*1024){run.child.kill();return;}
   run.child[reply.action].write(bytes);return;
  }
  if(reply.action!=='settled'||!reply.error&&!reply.receipt)throw failure('native_claude_transport_invalid');
  if(reply.receipt&&run.child.pid===undefined)throw failure('native_claude_transport_invalid');
  if(!reply.receipt&&(run.child.pid!==undefined||reply.error==='native_claude_transport_unconfirmed')){
   run.child.emit('error',failure(reply.error??'native_claude_transport_unconfirmed'));return;
  }
  settle(reply.id,reply.error?125:reply.receipt!.exitCode,reply.error,reply.receipt?.cancelled);
 },async release(attemptID:string){const current=[...runs.values()].filter(run=>run.attemptID===attemptID);for(const run of current)run.child.kill();await Promise.all(current.map(run=>run.done));},
 async close(){closed=true;const current=[...runs.values()];for(const run of current)run.child.kill();await Promise.all(current.map(run=>run.done));},
 get activeRuns(){return runs.size;}};
}
