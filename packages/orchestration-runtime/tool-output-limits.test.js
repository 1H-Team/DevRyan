import {expect, test} from 'bun:test';
import {managedToolOutputBudget, nativeToolOutputLimits, fitManagedToolOutput, assertManagedToolOutputSize} from './tool-output-limits.js';
import {projectManagedTaskResult, readManagedResultReference, MANAGED_RESULT_PAGE_MAX_BYTES, MANAGED_RESULT_V2_PAGE_MAX_BYTES} from './managed-result-projection.js';

test('native limits are explicit and model capacity reserves the native envelope', () => {
  expect(nativeToolOutputLimits()).toEqual({max_bytes: 51200, max_lines: 2000});
  expect(managedToolOutputBudget()).toBe(49152);
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
