import {expect,test,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createClaudeStderrDiagnostic,observeClaudeProcessDiagnostic} from './native-claude-diagnostics.js';
import {parseProviderDiagnostic} from './native-provider-worker-protocol.js';

test('Claude stderr receipt retains finite clues across chunks without content or exit-one auth guesses',()=>{
 const diagnostic=createClaudeStderrDiagnostic();
 const secret='sk-ant-private-secret https://private.example/credential /private/account.json';
 diagnostic.write(secret);expect(diagnostic.receipt(1,null).clues).toEqual([]);
 diagnostic.write(' HTTP 4');diagnostic.write('01 Unauthorized; Unknown Opt');diagnostic.write('ion; Cannot find module; SyntaxError');
 const receipt=diagnostic.receipt(1,null);
 expect(receipt.clues).toEqual(['http_401','auth','unsupported_option','module','syntax']);
 expect(Object.keys(receipt).sort()).toEqual(['clues','code','scannedBytes','signalPresent','stderrBytes','truncated']);
 expect(receipt.stderrBytes).toBe(Buffer.byteLength(secret+' HTTP 401 Unauthorized; Unknown Option; Cannot find module; SyntaxError'));
 expect(JSON.stringify(receipt)).not.toMatch(/sk-ant|private|example|account/);
});
test('Claude diagnostics bound scanning and drain unknown stderr without storing it',()=>{
 const diagnostic=createClaudeStderrDiagnostic();diagnostic.write(Buffer.alloc(40000,120));diagnostic.write('http 403 forbidden');
 expect(diagnostic.receipt(1,'SIGTERM')).toEqual({code:1,signalPresent:true,stderrBytes:40018,scannedBytes:32768,truncated:true,clues:[]});
});
test('Claude observer reports close once and leaves stdout, cleanup and observer failures untouched',()=>{
 const child=new EventEmitter();child.stderr=new PassThrough();child.stdout=new PassThrough();child.kill=vi.fn();const receipts=[];
 observeClaudeProcessDiagnostic(child,value=>{receipts.push(value);throw Error('private observer detail');});
 const stdout=[];child.stdout.on('data',bytes=>stdout.push(bytes.toString()));child.stdout.write('original stream');
 child.stderr.write('EACCES execution launcher termination_unconfirmed');child.emit('error',Error('unknown private spawn detail'));
 child.emit('close',1,null);child.emit('close',1,null);
 expect(receipts).toHaveLength(1);expect(receipts[0].clues).toEqual(['permission','launcher','spawn','native_receipt']);
 expect(stdout).toEqual(['original stream']);expect(child.kill).not.toHaveBeenCalled();expect(JSON.stringify(receipts)).not.toMatch(/private|EACCES|termination_unconfirmed/);
});
test('private diagnostic frame refuses arbitrary fields, clues, counts and raw signal/error strings',()=>{
 const frame={protocol:1,type:'claude-process-diagnostic',instanceID:'a'.repeat(32),attemptID:'b'.repeat(64),sessionID:'ses_diagnostic',directory:'/fixture',
  receipt:{code:1,signalPresent:false,stderrBytes:0,scannedBytes:0,truncated:false,clues:[]}};
 expect(parseProviderDiagnostic(frame)).toEqual(frame);
 for(const changed of [{...frame,stderr:'secret'}, {...frame,receipt:{...frame.receipt,stderr:'secret'}},
  {...frame,receipt:{...frame.receipt,clues:['private secret']}}, {...frame,receipt:{...frame.receipt,stderrBytes:1048577}},
  {...frame,receipt:{...frame.receipt,signalPresent:'SIGTERM'}}, {...frame,receipt:{...frame.receipt,code:'secret'}},
  {...frame,receipt:{...frame.receipt,truncated:true}}])expect(()=>parseProviderDiagnostic(changed)).toThrow('native_provider_protocol_invalid');
});
