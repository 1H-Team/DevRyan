import {test,expect} from 'bun:test';
import {once} from 'node:events';
import {createClaudeTransportChannel,createClaudeTransportProcessGate} from '../../packages/web/server/lib/opencode/runtime-host/native-claude-transport-channel.js';
import {parseClaudeTransportRequest,parseClaudeTransportReply} from '../../packages/web/server/lib/opencode/runtime-host/native-claude-transport-protocol.js';
import type {ClaudeTransportRequest} from '../../packages/web/server/lib/opencode/runtime-host/native-claude-transport-protocol.js';
const scope={attemptID:'a'.repeat(64),sessionID:'ses_fixture',directory:'/owned/project',profileID:'selected',args:['--print']};
const incarnation={version:1 as const,pid:123,hostId:'a'.repeat(64),bootId:'12345678-1234-1234-1234-123456789abc',startId:'12345',startIdKind:'linux-proc-start-ticks' as const};
const receipt={terminated:true as const,confined:true as const,cancelled:false,exitCode:0};
test('SDK stdin waits for host launch, chunks stay bounded, and close waits for actual confined receipt',async()=>{
 const frames:ClaudeTransportRequest[]=[],channel=createClaudeTransportChannel(frame=>frames.push(frame));
 const child=channel.spawn(scope),id=frames[0]!.id;let stdout='',closed=false;
 child.stdout.on('data',bytes=>stdout+=bytes);child.on('close',()=>closed=true);
 const input=Buffer.alloc(1100000,97);child.stdin.write(input);child.stdin.end();
 expect(frames.map(frame=>frame.action)).toEqual(['start']);expect(child.exitCode).toBeNull();expect(channel.activeRuns).toBe(1);
 channel.accept({protocol:1,type:'claude-transport-reply',attemptID:scope.attemptID,id,action:'started',pid:123,incarnation});
 const finished=once(child.stdin,'finish');
 while(frames.at(-1)!.action==='stdin'){const latest=frames.at(-1)!;if(latest.action==='stdin')channel.accept({protocol:1,type:'claude-transport-reply',attemptID:scope.attemptID,id,action:'input-accepted',sequence:latest.sequence});}
 await finished;expect(frames[0]!.action).toBe('start');expect(frames.at(-1)!.action).toBe('end');
 const chunks=frames.filter(frame=>frame.action==='stdin');expect(Buffer.concat(chunks.map(frame=>Buffer.from(frame.chunk,'base64')))).toEqual(input);
 expect(chunks.every(frame=>Buffer.from(frame.chunk,'base64').length<=16384)).toBe(true);
 channel.accept({protocol:1,type:'claude-transport-reply',attemptID:scope.attemptID,id,action:'stdout',chunk:Buffer.from('completed').toString('base64')});
 expect(stdout).toBe('completed');expect(closed).toBe(false);
 channel.accept({protocol:1,type:'claude-transport-reply',attemptID:scope.attemptID,id,action:'settled',receipt});
 expect(closed).toBe(true);expect(child.exitCode).toBe(0);expect(channel.activeRuns).toBe(0);
 expect(()=>channel.accept({protocol:1,type:'claude-transport-reply',attemptID:scope.attemptID,id,action:'settled',receipt})).toThrow('expired');await channel.close();
});
test('abort before startup and owner close remain pending until the host confirms termination',async()=>{
 const frames:ClaudeTransportRequest[]=[],channel=createClaudeTransportChannel(frame=>frames.push(frame)),abort=new AbortController();
 const child=channel.spawn(scope,abort.signal),id=frames[0]!.id;abort.abort();
 expect(frames.map(frame=>frame.action)).toEqual(['start','cancel']);expect(child.killed).toBe(true);expect(child.exitCode).toBeNull();
 let closed=false;const closing=channel.close().then(()=>closed=true);await Promise.resolve();expect(closed).toBe(false);
 channel.accept({protocol:1,type:'claude-transport-reply',attemptID:scope.attemptID,id,action:'started',pid:123,incarnation});
 channel.accept({protocol:1,type:'claude-transport-reply',attemptID:scope.attemptID,id,action:'settled',receipt:{...receipt,cancelled:true,exitCode:137}});await closing;
 expect(closed).toBe(true);expect(child.exitCode).toBe(137);expect(child.signalCode).toBe('SIGTERM');
 expect(()=>channel.spawn(scope)).toThrow('expired');
});
test('empty stdin end waits for startup and a consumed long output stream does not hit a lifetime volume cap',async()=>{
 const frames:ClaudeTransportRequest[]=[],channel=createClaudeTransportChannel(frame=>frames.push(frame)),child=channel.spawn(scope),id=frames[0]!.id;
 child.stdin.end();expect(frames.map(frame=>frame.action)).toEqual(['start']);
 const finished=once(child.stdin,'finish');channel.accept({protocol:1,type:'claude-transport-reply',attemptID:scope.attemptID,id,action:'started',pid:123,incarnation});await finished;
 expect(frames.map(frame=>frame.action)).toEqual(['start','end']);
 let count=0;child.stdout.on('data',chunk=>count+=chunk.length);
 const chunk=Buffer.alloc(16384).toString('base64');for(let index=0;index<2100;index++)channel.accept({protocol:1,type:'claude-transport-reply',attemptID:scope.attemptID,id,action:'stdout',chunk});
 expect(count).toBe(2100*16384);expect(child.killed).toBe(false);
 channel.accept({protocol:1,type:'claude-transport-reply',attemptID:scope.attemptID,id,action:'settled',receipt});await channel.close();
});
test('host launch failure retains finite infrastructure error and never becomes generic exit one',()=>{
 const frames:ClaudeTransportRequest[]=[],channel=createClaudeTransportChannel(frame=>frames.push(frame)),child=channel.spawn(scope);let error:Error|undefined;
 child.on('error',value=>error=value);channel.accept({protocol:1,type:'claude-transport-reply',attemptID:scope.attemptID,id:frames[0]!.id,action:'settled',error:'native_claude_transport_invalid'});
 expect(error?.message).toBe('native_claude_transport_invalid');expect(child.exitCode).toBe(125);expect(channel.activeRuns).toBe(0);
});
test('an unconfirmed launched process reports infrastructure failure without claiming exit or releasing ownership',async()=>{
 const frames:ClaudeTransportRequest[]=[],channel=createClaudeTransportChannel(frame=>frames.push(frame)),child=channel.spawn(scope),id=frames[0]!.id;
 let exited=false,error:Error|undefined;child.once('exit',()=>exited=true);child.on('error',value=>error=value);
 channel.accept({protocol:1,type:'claude-transport-reply',attemptID:scope.attemptID,id,action:'started',pid:123,incarnation});
 channel.accept({protocol:1,type:'claude-transport-reply',attemptID:scope.attemptID,id,action:'settled',error:'native_claude_transport_unconfirmed'});
 expect(error?.message).toBe('native_claude_transport_unconfirmed');expect(exited).toBe(false);expect(child.exitCode).toBeNull();expect(channel.activeRuns).toBe(1);
 let closed=false;const closing=channel.close().then(()=>closed=true);await Promise.resolve();expect(closed).toBe(false);
 channel.accept({protocol:1,type:'claude-transport-reply',attemptID:scope.attemptID,id,action:'settled',receipt:{...receipt,cancelled:true,exitCode:137}});await closing;
 expect(exited).toBe(true);expect(closed).toBe(true);
});
test('private protocol rejects unowned environment, arbitrary command, malformed bytes and unconfirmed receipts',()=>{
 const start={protocol:1,type:'claude-transport',action:'start',id:'b'.repeat(32),...scope};
 for(const extra of [{env:{CLAUDE_CODE_OAUTH_TOKEN:'private-fixture'}},{command:'/bin/sh'},{cwd:'/foreign'},{directory:'/owned/\nproject'}])expect(()=>parseClaudeTransportRequest({...start,...extra})).toThrow();
 for(const chunk of ['=',Buffer.alloc(16385).toString('base64'),'AB=='])expect(()=>parseClaudeTransportRequest({protocol:1,type:'claude-transport',attemptID:scope.attemptID,action:'stdin',id:start.id,sequence:1,chunk})).toThrow();
 for(const invalid of [{...receipt,confined:false},{...receipt,terminated:false},{...receipt,exitCode:256},{...receipt,token:'private-fixture'}])expect(()=>parseClaudeTransportReply({protocol:1,type:'claude-transport-reply',attemptID:scope.attemptID,action:'settled',id:start.id,receipt:invalid})).toThrow();
 expect(()=>parseClaudeTransportReply({protocol:1,type:'claude-transport-reply',attemptID:scope.attemptID,action:'settled',id:start.id,error:'arbitrary secret error'})).toThrow();
});

test('native writer gate attaches the exact host incarnation before any stdin and joins only the confirmed receipt',async()=>{
 const frames:ClaudeTransportRequest[]=[],channel=createClaudeTransportChannel(frame=>frames.push(frame));
 let allowAttachment!:()=>void;const attachment=new Promise<void>(resolve=>{allowAttachment=resolve;});
 const attached:unknown[]=[],gate=createClaudeTransportProcessGate((options,attach)=>channel.spawn({...scope,args:options.args},options.signal,attach),async(identity,recoverable)=>{attached.push({identity,recoverable});await attachment;});
 const child=gate.spawnClaudeCodeProcess({command:'/owned/claude',args:['--print'],cwd:scope.directory});child.on('error',()=>{});
 const id=frames[0]!.id;child.stdin.write('inference');
 channel.accept({protocol:1,type:'claude-transport-reply',attemptID:scope.attemptID,id,action:'started',pid:123,incarnation});
 await Promise.resolve();expect(attached).toEqual([{identity:incarnation,recoverable:false}]);expect(frames.map(frame=>frame.action)).toEqual(['start']);
 const ready=once(child,'spawn');allowAttachment();await ready;expect(frames.at(-1)!.action).toBe('stdin');
 expect(()=>gate.spawnClaudeCodeProcess({command:'/owned/claude',args:[],cwd:scope.directory})).toThrow('expired');
 const closing=gate.closeAndJoin(1);expect(await closing).toBe(false);expect(frames.at(-1)!.action).toBe('cancel');expect(channel.activeRuns).toBe(1);
 channel.accept({protocol:1,type:'claude-transport-reply',attemptID:scope.attemptID,id,action:'settled',receipt:{...receipt,cancelled:true}});
 expect(await gate.closeAndJoin(1)).toBe(true);await channel.close();
});

test('failed writer attachment cancels the physical process without forwarding queued SDK input or claiming termination',async()=>{
 const frames:ClaudeTransportRequest[]=[],channel=createClaudeTransportChannel(frame=>frames.push(frame));
 const child=channel.spawn(scope,undefined,async()=>{throw Error('lease revoked');});child.on('error',()=>{});child.stdin.write('inference');
 const id=frames[0]!.id;channel.accept({protocol:1,type:'claude-transport-reply',attemptID:scope.attemptID,id,action:'started',pid:123,incarnation});
 await new Promise(resolve=>setTimeout(resolve,0));expect(frames.map(frame=>frame.action)).toEqual(['start','cancel']);expect(child.exitCode).toBeNull();
 channel.accept({protocol:1,type:'claude-transport-reply',attemptID:scope.attemptID,id,action:'settled',receipt:{...receipt,cancelled:true}});await channel.close();
});

test('started transport rejects missing, foreign-PID and malformed process witnesses',()=>{
 const base={protocol:1,type:'claude-transport-reply',attemptID:scope.attemptID,id:'b'.repeat(32),action:'started',pid:123};
 for(const witness of[undefined,{...incarnation,pid:124},{...incarnation,hostId:'machine'},{...incarnation,startId:'invented'},{...incarnation,extra:true}])expect(()=>parseClaudeTransportReply({...base,incarnation:witness})).toThrow('invalid');
});

test('pre-announcement capture failure settles only with the host confirmed receipt or a never-started error',async()=>{
 const frames:ClaudeTransportRequest[]=[],channel=createClaudeTransportChannel(frame=>frames.push(frame));
 const child=channel.spawn(scope);child.on('error',()=>{});const id=frames[0]!.id;
 channel.accept({protocol:1,type:'claude-transport-reply',attemptID:scope.attemptID,id,action:'settled',error:'native_claude_transport_unconfirmed'});
 expect(channel.activeRuns).toBe(1);expect(child.exitCode).toBeNull();
 channel.accept({protocol:1,type:'claude-transport-reply',attemptID:scope.attemptID,id,action:'settled',error:'native_claude_transport_failed',receipt:{...receipt,cancelled:true,exitCode:137}});
 expect(channel.activeRuns).toBe(0);expect(child.exitCode).toBe(125);await channel.close();
});
