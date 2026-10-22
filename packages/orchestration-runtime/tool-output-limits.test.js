import {expect, test} from 'bun:test';
import {managedToolOutputBudget, nativeToolOutputLimits, fitManagedToolOutput, assertManagedToolOutputSize, compactManagedTaskToolResult, MANAGED_TOOL_OUTPUT_MAX_BYTES} from './tool-output-limits.js';
import {projectManagedTaskResult, readManagedResultReference, MANAGED_RESULT_PAGE_MAX_BYTES, MANAGED_RESULT_V2_PAGE_MAX_BYTES} from './managed-result-projection.js';
import {createCompactResultHeader} from './compact-result-header.js';

test('native limits are explicit and model capacity reserves the native envelope', () => {
  expect(nativeToolOutputLimits()).toEqual({max_bytes: 45056, max_lines: 1000});
  expect(managedToolOutputBudget()).toBe(43008);
  expect(managedToolOutputBudget({max_bytes: 51200})).toBe(49152);
  expect(managedToolOutputBudget({max_bytes: 10000})).toBe(7952);
  for (const limits of [{max_bytes: 0}, {max_lines: 1.5}, {unknown: 1}, null]) expect(() => nativeToolOutputLimits(limits)).toThrow();
  expect(() => managedToolOutputBudget({max_bytes: 2048})).toThrow('managed_tool_output_capacity_unavailable');
});

test('escaped report pages fit serialized bytes without losing Unicode or retained references', () => {
  const preview = ('\0\n"\\🙂é').repeat(4000);
  const shared = {taskId: 'dvr_task_limit', rootSessionId: 'ses_root', parentTaskId: null, childSessionId: 'ses_child', directory: '/fixture',
    status: 'completed', partial: false, failureReason: null, attempt: 1, priorTaskId: null, executionKind: 'start',
    recoverablePreview: preview, canonicalRefs: [{type: 'message', id: 'msg_child'}]};
  const task = {...shared, label: 'Retained result'};
  const envelope = {...shared, envelopeId: 'dvr_result_limit', action: null};
  const budget = 6000;
  let value = fitManagedToolOutput(pageBytes => projectManagedTaskResult(task, envelope, 'reference', pageBytes), budget);
  expect(value.task.canonicalRefs).toBeUndefined();
  expect(value.resultEnvelope.canonicalRefs).toEqual(shared.canonicalRefs);
  expect(value.metadata).toBeUndefined();
  let text = value.resultReference.text;
  while (!value.resultReference.complete) {
    const cursor = value.resultReference.nextCursor;
    value = fitManagedToolOutput(maxPageBytes => ({resultReference: readManagedResultReference({task, resultEnvelope: envelope, resultCursor: cursor, maxPageBytes})}), budget);
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(budget);
    expect(() => assertManagedToolOutputSize(value, budget)).not.toThrow();
    text += value.resultReference.text;
  }
  expect(text).toBe(preview);
});

test('unpageable metadata fails explicitly and conflicting duplicate references stay visible', () => {
  expect(() => fitManagedToolOutput(() => ({fixed: '\0'.repeat(9000)}))).toThrow('managed_tool_output_metadata_too_large');
  const task = {taskId: 'dvr_task_one', canonicalRefs: [{id: 'msg_a'}]};
  const resultEnvelope = {taskId: 'dvr_task_one', canonicalRefs: [{id: 'msg_b'}]};
  const result = fitManagedToolOutput(() => ({task, resultEnvelope}));
  expect(result.task.canonicalRefs).toEqual([{id: 'msg_a'}]);
  expect(result.resultEnvelope.canonicalRefs).toEqual([{id: 'msg_b'}]);
});

test('larger v2 pages fit actual escaped replies while default v1 and small native caps retain their limits', () => {
  const shared={taskId:'dvr_task_large',rootSessionId:'ses_root',parentTaskId:null,childSessionId:'ses_child',directory:'/fixture',status:'completed',
    partial:false,failureReason:null,attempt:1,priorTaskId:null,executionKind:'start',recoverablePreview:'x'.repeat(40*1024),canonicalRefs:[]};
  const task={...shared},envelope={...shared,envelopeId:'dvr_result_large',action:null};
  const build=pageBytes=>projectManagedTaskResult(task,envelope,'reference',pageBytes);
  expect(Buffer.byteLength(fitManagedToolOutput(build).resultReference.text)).toBe(MANAGED_RESULT_PAGE_MAX_BYTES);
  expect(Buffer.byteLength(fitManagedToolOutput(build,49152,MANAGED_RESULT_V2_PAGE_MAX_BYTES).resultReference.text)).toBe(MANAGED_RESULT_V2_PAGE_MAX_BYTES);
  task.recoverablePreview=envelope.recoverablePreview='\0"\\🙂\n'.repeat(10000);
  for(const budget of [1600,6000,49152]){
    const result=fitManagedToolOutput(build,budget,MANAGED_RESULT_V2_PAGE_MAX_BYTES);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(budget);
    expect(Buffer.byteLength(result.resultReference.text)).toBeLessThanOrEqual(MANAGED_RESULT_V2_PAGE_MAX_BYTES);
    expect(result.metadata).toBeUndefined();
  }
  for(const size of [0,3,1.5,MANAGED_RESULT_V2_PAGE_MAX_BYTES+1])expect(()=>fitManagedToolOutput(build,49152,size)).toThrow('capacity_invalid');
});

// Native devryan_task emits JSON.stringify(reply) through OpenCode's global tool_output
// limit, so a v2 inline first page and a wait_any reply at its cap must both fit the
// derived budget (not the 48 KiB ceiling) and reach the model untruncated.
test('default native limits keep a maximal v2 inline page and a capped wait_any reply intact', () => {
  const limits=nativeToolOutputLimits(),budget=managedToolOutputBudget(limits);
  const bytes=value=>Buffer.byteLength(JSON.stringify(value));
  const emitted=value=>{const text=JSON.stringify(value);return {bytes:Buffer.byteLength(text),lines:text.split('\n').length};};
  const record=(id,preview)=>{
    const shared={sequence:1,finishedAt:2,recoveryLineageId:null,childPromptedAt:null,firstAssistantPartAt:null,waitingReason:null,
      transportRecovery:null,requiredChecks:[],requiredCheckReceipts:[],owner:'devryan',idempotencyKey:`idem_${id}`,dispatchGroupId:null,
      dispatchCallId:null,dispatchWaveId:null,mode:'orchestrator',readOnly:false,providerId:'openai',modelId:'gpt-5.5',agent:'fixer',
      variant:'high',label:`Fix ${id}`,prompt:'Fix the reported defect.',leaseToken:null,createdAt:1,updatedAt:1,startedAt:1,completedAt:2,
      timeoutAt:null,taskId:`dvr_task_${id}`,rootSessionId:'ses_root',directory:'/Users/fixture/project',status:'completed',parentTaskId:null,
      childSessionId:`ses_${id}`,partial:false,failureReason:null,attempt:1,priorTaskId:null,executionKind:'start',recoverablePreview:preview,
      canonicalRefs:[{type:'message',id:`msg_${id}`}]};
    return {task:{...shared},envelope:{...shared,envelopeId:`dvr_result_${id}`,action:null,resumable:false}};
  };
  const project=({task,envelope},pageBytes)=>({...projectManagedTaskResult(task,envelope,'reference',pageBytes),
    resultHeader:createCompactResultHeader({task,envelope,checks:[{name:'unit',status:'passed',coverage:{contentHash:'a'.repeat(64)},
      evidence:{exitCode:0,checkedContentHash:'a'.repeat(64)}}],observedAt:1}),resultContractVersion:2});

  const single=record('inline','# Report\n'+'Every required check passed. '.repeat(1500)+'\n**Status:** complete');
  const inline=fitManagedToolOutput(pageBytes=>project(single,pageBytes),budget,MANAGED_RESULT_V2_PAGE_MAX_BYTES);
  expect(Buffer.byteLength(inline.resultReference.text)).toBe(MANAGED_RESULT_V2_PAGE_MAX_BYTES);
  expect(inline).toEqual(compactManagedTaskToolResult(project(single,MANAGED_RESULT_V2_PAGE_MAX_BYTES)));
  expect(bytes(inline)).toBeLessThanOrEqual(budget);

  const first=record('first','# First\n'+'a'.repeat(20_000)+'\n**Status:** complete');
  const reply=(tail,pageBytes)=>({rootSessionId:'ses_root',cursor:'dvr_wait_cursor',settled:true,schemaVersion:2,
    readyTaskIds:['dvr_task_first','dvr_task_second'],changedTaskIds:['dvr_task_first','dvr_task_second'],attention:[],pendingTaskIds:[],
    results:[project(first,pageBytes),project(record('second','b'.repeat(tail)),pageBytes)],capabilities:{policies:{waitAny:true}},resultContractVersion:2});
  let tail=budget-bytes(compactManagedTaskToolResult(reply(0,MANAGED_RESULT_V2_PAGE_MAX_BYTES)));
  while(bytes(compactManagedTaskToolResult(reply(tail,MANAGED_RESULT_V2_PAGE_MAX_BYTES)))>budget)tail--;
  const capped=fitManagedToolOutput(pageBytes=>reply(tail,pageBytes),budget,MANAGED_RESULT_V2_PAGE_MAX_BYTES);
  expect(bytes(capped)).toBeGreaterThan(budget-16);
  expect(capped).toEqual(compactManagedTaskToolResult(reply(tail,MANAGED_RESULT_V2_PAGE_MAX_BYTES)));
  for(const value of [inline,capped]){
    const output=emitted(value);
    expect(output.bytes).toBeLessThanOrEqual(limits.max_bytes);
    expect(output.lines).toBeLessThanOrEqual(limits.max_lines);
  }

  // A reply sized for the 48 KiB ceiling instead of the derived budget is refused, and fitting shortens its page.
  const ceilingSized=compactManagedTaskToolResult(reply(tail+4096,MANAGED_RESULT_V2_PAGE_MAX_BYTES));
  expect(bytes(ceilingSized)).toBeLessThanOrEqual(MANAGED_TOOL_OUTPUT_MAX_BYTES);
  expect(()=>assertManagedToolOutputSize(ceilingSized,budget)).toThrow('managed_tool_output_metadata_too_large');
  const refitted=fitManagedToolOutput(pageBytes=>reply(tail+4096,pageBytes),budget,MANAGED_RESULT_V2_PAGE_MAX_BYTES);
  expect(bytes(refitted)).toBeLessThanOrEqual(budget);
  expect(refitted.results[0].resultReference.complete).toBe(false);
});
