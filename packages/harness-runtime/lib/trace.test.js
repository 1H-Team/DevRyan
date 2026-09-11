import { describe, expect, test } from 'bun:test';
import { createHarnessTraceCollector } from './trace.js';
import { createDiagnosticSanitizer } from './sanitizer.js';

const taskRecord = (sequence = 2) => ({ type: 'open_code_event', at: 100, payload: { type: 'openchamber:managed-task', properties: {
  task: { taskId: 'dvr_task_one', rootSessionId: 'ses_root', childSessionId: 'ses_child', sequence, attempt: 1,
    createdAt: 10, startedAt: 20, finishedAt: 80, childPromptedAt: 25, firstAssistantPartAt: 35, status: 'completed' },
  resultEnvelope: { envelopeId: 'dvr_result_one', createdAt: 81, acknowledgedAt: 100, action: 'continue' },
} } });

describe('Chrome Trace journal projection', () => {
  test('correlates task, child and tool lanes with actual timestamps without duplicating reordered ledger snapshots', () => {
    const trace = createHarnessTraceCollector();
    trace.add(taskRecord()); trace.add(taskRecord());
    const stale = taskRecord(1); stale.payload.properties.task.finishedAt = null; trace.add(stale);
    trace.add({ type: 'open_code_event', sessionID: 'ses_child', at: 70, payload: { type: 'message.part.updated', properties: {
      part: { type: 'tool', tool: 'read', callID: 'call_one', messageID: 'msg_one', state: { status: 'completed', time: { start: 40, end: 60 }, output: 'abc' } },
    } } });
    const output = trace.finish(), root = output.metadata.roots[0];
    expect(output.traceEvents.filter((e) => e.name === 'Execution')).toHaveLength(1);
    expect(output.traceEvents.find((e) => e.name === 'read')).toMatchObject({ ph: 'X', ts: 40_000, dur: 20_000 });
    expect(root).toMatchObject({ rootSessionId: 'ses_root', measurements: { queueMs: { total: 10 }, firstResponseMs: { total: 10 },
      resultConsumptionMs: { total: 19 }, toolExecutionMs: { total: 20 }, toolVolumeBytes: { total: 3 } } });
    expect(new Set(output.traceEvents.map((e) => e.pid)).size).toBe(1);
  });
  test('keeps missing wire timing, incomplete checks and absent cost unknown', () => {
    const trace = createHarnessTraceCollector(); const record = taskRecord();
    record.payload.properties.task.startedAt = null; record.payload.properties.resultEnvelope.acknowledgedAt = null;
    trace.add(record);
    expect(trace.finish().metadata.roots[0]).toMatchObject({ wireFirstResponseMs: null, costProvenance: 'unavailable',
      measurements: { queueMs: { total: null, unknown: 1 }, resultConsumptionMs: { total: null, unknown: 1 } } });
  });
  test('deduplicates actual usage per assistant and records numeric cost provenance', () => {
    const trace = createHarnessTraceCollector();
    const usage = { type: 'open_code_event', sessionID: 'ses_root', at: 100, payload: { type: 'message.updated', properties: {
      info: { id: 'msg_one', role: 'assistant', time: { completed: 100 }, tokens: { input: 10, output: 3, cache: { read: 2, write: 0 } }, cost: 0.1 },
    } } };
    trace.add(usage); trace.add(usage);
    expect(trace.finish().metadata.roots[0]).toMatchObject({ costProvenance: 'native-runtime-reported', measurements: {
      input: { total: 10, observed: 1 }, cost: { total: 0.1, observed: 1 } } });
  });
  test('exports only structural metadata, never tool contents or private reasoning', () => {
    const trace = createHarnessTraceCollector();
    trace.add({ type: 'lifecycle', event: 'provider_stop_requested', sessionID: 'ses_root', at: 1,
      payload: { callID: 'call_one', message: 'private instructions', reasoning: 'private thoughts', providerMetadata: { signature: 'opaque' }, headers: { authorization: 'credential' } } });
    const output = JSON.stringify(trace.finish());
    expect(output).toContain('call_one');
    for (const denied of ['private instructions', 'private thoughts', 'opaque', 'authorization']) expect(output).not.toContain(denied);
  });
  test('bounds both retained evidence and exported events with explicit omissions', () => {
    const trace = createHarnessTraceCollector({ maxEvents: 3, maxBytes: 1024 });
    for (let i = 0; i < 40; i++) trace.add({ type: 'lifecycle', event: 'observed', at: i, sessionID: `ses_${i}` });
    const output = trace.finish();
    expect(output.traceEvents.length).toBeLessThanOrEqual(3);
    expect(output.metadata.incomplete).toBe(true);
    expect(output.metadata.omittedRecords).toBeGreaterThan(0);
  });
  test('journal and export sanitization retain numeric usage but remove reasoning contents', () => {
    const sanitizer = createDiagnosticSanitizer();
    const record = sanitizer.sanitizeRecord({ type: 'open_code_event', at: 1, payload: { type: 'message.part.updated', properties: {
      part: { type: 'reasoning', id: 'part_one', text: 'private thoughts', providerMetadata: { signature: 'opaque' } },
      info: { tokens: { reasoning: 12 } },
    } } });
    expect(record.payload.properties.info.tokens.reasoning).toBe(12);
    expect(JSON.stringify(record)).not.toContain('private thoughts');
    expect(JSON.stringify(sanitizer.sanitizeExportValue({ type: 'reasoning', text: 'old private thoughts', providerMetadata: { signature: 'opaque' } }))).not.toContain('private');
  });
});
