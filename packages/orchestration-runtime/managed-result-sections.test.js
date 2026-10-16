import {expect,test} from 'bun:test';
import {prepareManagedResultMetadata,isManagedMetadataCursor} from './managed-result-sections.js';
import {fitManagedToolOutput} from './tool-output-limits.js';

const result={task:{taskId:'dvr_task_one',rootSessionId:'ses_root',directory:'/project',status:'failed'},
 resultEnvelope:{envelopeId:'dvr_result_one',taskId:'dvr_task_one',rootSessionId:'ses_root',directory:'/project',status:'failed',action:null,partial:true,resumable:true,
  canonicalRefs:Array.from({length:500},(_,index)=>({messageId:'msg_'+index,callId:'call_'+index,description:'😀 "\\\n'.repeat(8)}))},
 resultReference:{taskId:'dvr_task_one',envelopeId:'dvr_result_one',totalBytes:10000,text:'',returnedBytes:0,complete:false,nextCursor:'retained-v1-cursor'}};
test('v2 metadata pages retain every reference at code-point boundaries inside the escaped JSON cap',async()=>{
 const metadata=await prepareManagedResultMetadata(result),first=fitManagedToolOutput(bytes=>metadata.project(bytes),1600);
 expect(first.resultReference.nextCursor).toBe('retained-v1-cursor');
 let joined=first.metadataReference.text,cursor=first.metadataReference.nextCursor;
 while(cursor){expect(isManagedMetadataCursor(cursor)).toBe(true);const next=fitManagedToolOutput(bytes=>metadata.read(cursor,bytes),1600);
  expect(Buffer.byteLength(JSON.stringify(next))).toBeLessThanOrEqual(1600);joined+=next.metadataReference.text;cursor=next.metadataReference.nextCursor;}
 expect(JSON.parse(joined).resultEnvelope.canonicalRefs).toEqual(result.resultEnvelope.canonicalRefs);
 expect(result.resultEnvelope.canonicalRefs).toHaveLength(500);
});
test('metadata cursors bind exact task/envelope/content; changed references and forged offsets fail closed',async()=>{
 const metadata=await prepareManagedResultMetadata(result),cursor=metadata.project(100).metadataReference.nextCursor;
 for(const changed of [{...result,task:{...result.task,taskId:'dvr_task_other'}},{...result,resultEnvelope:{...result.resultEnvelope,envelopeId:'dvr_result_other'}},
  {...result,resultEnvelope:{...result.resultEnvelope,canonicalRefs:[]}}]){
  const metadataChanged=await prepareManagedResultMetadata(changed);
  expect(()=>metadataChanged.read(cursor,100)).toThrow('metadata changed');
 }
 expect(()=>metadata.read(cursor+'bad',100)).toThrow('cursor is invalid');
});
