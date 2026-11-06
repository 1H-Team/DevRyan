import { describe, expect, test } from 'bun:test';
import { createHarnessTraceCollector } from './trace.js';
import { createDiagnosticSanitizer } from './sanitizer.js';

const taskRecord = (sequence = 2) => ({ type: 'open_code_event', at: 100, payload: { type: 'openchamber:managed-task', properties: {
  task: { taskId: 'dvr_task_one', rootSessionId: 'ses_root', childSessionId: 'ses_child', sequence, attempt: 1,
    createdAt: 10, startedAt: 20, finishedAt: 80, childPromptedAt: 25, firstAssistantPartAt: 35, status: 'completed' },
  resultEnvelope: { envelopeId: 'dvr_result_one', createdAt: 81, acknowledgedAt: 100, action: 'continue' },
} } });

describe('Chrome Trace journal projection', () => {
  test('keeps applied-hook counts and legacy estimates distinct from unavailable wire measurements', () => {
    const trace = createHarnessTraceCollector(), sanitizer = createDiagnosticSanitizer();
    for (const payload of [{ beforeBytes: 100, projectedBytes: 70 },
      { phase: 'hook-applied', beforeBytes: 100, projectedBytes: 70, plannedReductions: 1, appliedReductions: 1,
        savedBytes: 30, transformDurationMs: 0.25, finalRequestBytes: null }]) {
      trace.add(sanitizer.sanitizeRecord({ type: 'lifecycle', event: 'harness_context_projected', at: 1,
        sessionID: 'ses_root', payload }));
    }
    const observations = trace.finish().metadata.roots[0].projections;
    expect(observations[0]).toMatchObject({ phase: 'legacy-estimate', appliedReductions: null, finalRequestBytes: null });
    expect(observations[1]).toMatchObject({ phase: 'hook-applied', appliedReductions: 1, transformDurationMs: 0.25, finalRequestBytes: null });
  });
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
  test('a root objective critical path is the union of its settled objectives and unknown while one is unsettled', () => {
    const objective = (messageID, state, at, createdAt) => ({ type: 'lifecycle', event: 'objective_state', sessionID: 'ses_root', at,
      payload: { sessionID: 'ses_root', messageID, state, createdAt, generation: 1 } });
    // A plan turn, then its implementation turn, which a superseded turn overlaps.
    const settled = [objective('msg_plan', 'observing', 100, 100), objective('msg_plan', 'completed', 160, 100),
      objective('msg_build', 'observing', 200, 200), objective('msg_build', 'completed', 300, 200),
      objective('msg_extra', 'observing', 250, 250), objective('msg_extra', 'superseded', 320, 250)];
    const complete = createHarnessTraceCollector();
    for (const record of settled) complete.add(record);
    expect(complete.finish().metadata.roots[0]).toMatchObject({ totalObjectiveCriticalPathMs: 60 + 120 });
    const unsettled = createHarnessTraceCollector();
    for (const record of [...settled, objective('msg_next', 'observing', 400, 400)]) unsettled.add(record);
    expect(unsettled.finish().metadata.roots[0].totalObjectiveCriticalPathMs).toBeNull();
    const single = createHarnessTraceCollector();
    for (const record of settled.slice(0, 2)) single.add(record);
    expect(single.finish().metadata.roots[0].totalObjectiveCriticalPathMs).toBe(60);
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
  test('attributes helper sessions and recorded direct helper calls to their originating root', () => {
    const trace = createHarnessTraceCollector(), sanitizer = createDiagnosticSanitizer();
    const message = (sessionID, id, agent, input, output) => ({ type: 'open_code_event', sessionID, at: 100, payload: { type: 'message.updated', properties: {
      info: { id, role: 'assistant', agent, time: { completed: 100 }, tokens: { input, output, cache: { read: 0, write: 0 } }, cost: 0 } } } });
    trace.add(message('ses_root', 'msg_root', 'orchestrator', 100, 10));
    // A title helper session related by its owner's diagnostic.
    trace.add(sanitizer.sanitizeRecord({ type: 'lifecycle', event: 'session_title_generation', sessionID: 'ses_root', at: 50,
      payload: { stage: 'helper_create', outcome: 'complete', helperSessionID: 'ses_helper' } }));
    trace.add(message('ses_helper', 'msg_helper', 'devryan-title', 20, 2));
    // A direct session-model title call with its provider usage record.
    trace.add(sanitizer.sanitizeRecord({ type: 'lifecycle', event: 'session_title_generation', sessionID: 'ses_root', at: 60,
      payload: { stage: 'session_model', outcome: 'complete', attempt: 1 } }));
    trace.add(sanitizer.sanitizeRecord({ type: 'lifecycle', event: 'provider_usage', sessionID: 'ses_root', at: 61, usageObservation: {
      version: 1, source: 'provider_request', observationID: 'obs_title', sessionID: 'ses_root', rootSessionID: 'ses_root', purpose: 'title',
      semantics: { input: 'inclusive', output: 'exclusive' }, tokens: { totalInput: 30, uncachedInput: 30, cacheRead: 0, cacheWrite: 0, output: 3 } } }));
    const { roots, attribution } = trace.finish().metadata;
    expect(roots).toHaveLength(1);
    expect(roots[0]).toMatchObject({ rootSessionId: 'ses_root', measurements: { input: { total: 150, observed: 3, unknown: 0 },
      output: { total: 15 }, helperInput: { total: 50 }, helperOutput: { total: 5 } },
      attribution: { helperSessions: 1, helperCalls: 1, helperUsageRecords: 1, unattributedHelperCalls: 0, helperOnly: false } });
    expect(attribution).toEqual({ schemaVersion: 1, unattributedHelperUsage: 0 });
  });
  test('keeps unrelated helper sessions, unrecorded direct calls and rootless helper usage visible as unattributed', () => {
    const trace = createHarnessTraceCollector();
    trace.add({ type: 'open_code_event', sessionID: 'ses_root', at: 100, payload: { type: 'message.updated', properties: {
      info: { id: 'msg_root', role: 'assistant', agent: 'orchestrator', time: { completed: 100 }, tokens: { input: 10, output: 1 } } } } });
    trace.add({ type: 'open_code_event', sessionID: 'ses_orphan', at: 100, payload: { type: 'message.updated', properties: {
      info: { id: 'msg_orphan', role: 'assistant', agent: 'devryan-title', time: { completed: 100 }, tokens: { input: 5, output: 1 } } } } });
    trace.add({ type: 'lifecycle', event: 'session_title_generation', sessionID: 'ses_root', at: 60, payload: { stage: 'session_model', outcome: 'failed', attempt: 1 } });
    trace.add({ type: 'lifecycle', event: 'provider_usage', at: 61, usageObservation: { version: 1, source: 'provider_request',
      observationID: 'obs_rootless', purpose: 'commit', tokens: { uncachedInput: 4, output: 1 } } });
    const { roots, attribution } = trace.finish().metadata;
    expect(roots.find((root) => root.rootSessionId === 'ses_root').attribution).toMatchObject({ helperCalls: 1, helperUsageRecords: 0, unattributedHelperCalls: 1 });
    expect(roots.find((root) => root.rootSessionId === 'ses_orphan').attribution).toMatchObject({ helperOnly: true });
    expect(attribution.unattributedHelperUsage).toBe(1);
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
