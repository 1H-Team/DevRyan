import express from 'express';
import request from '../../test-supertest.js';
import { describe, expect, it } from 'vitest';

import { createTurnTimingRuntime, registerTurnTimingRoutes } from './turn-timing.js';

describe('turn timing runtime', () => {
  it('attributes native provider marks, bridge calls and ledger locks to the active turn and journals them without text', () => {
    let now = 1_000;
    const marks = [];
    const settled = [];
    const runtime = createTurnTimingRuntime({ now: () => now, onTurnMark: (entry) => marks.push(entry), onTurnSettled: (entry) => settled.push(entry) });
    // Nothing is attributed before the turn exists, and clients cannot post server marks.
    expect(runtime.recordSessionMark({ sessionId: 'ses_native', mark: 'provider_request_sent' })).toBe(false);
    expect(runtime.recordBridgeCall({ sessionId: 'ses_native', method: 'native.admission.authorize', durationMs: 5, statusCode: 200 })).toBe(false);
    expect(runtime.recordClientMark({ sessionId: 'ses_native', messageId: 'msg_user', mark: 'provider_first_byte' })).toBe(false);

    runtime.recordClientMark({ sessionId: 'ses_native', messageId: 'msg_user', mark: 'send_started', directory: '/project',
      metadata: { source: 'proxy', providerID: 'openai', modelID: 'gpt-5.6-sol', agent: 'orchestrator', variant: 'high' } });
    now = 1_100;
    runtime.recordClientMark({ sessionId: 'ses_native', messageId: 'msg_user', mark: 'prompt_accepted', directory: '/project',
      metadata: { providerID: 'openai', modelID: 'gpt-5.6-sol', agent: 'orchestrator', variant: 'high', text: 'private prompt' } });
    expect(runtime.recordLedgerLock({ sessionId: 'ses_native', operation: 'registerNativeSession', waitMs: 7_700, holdMs: 40 })).toBe(true);
    runtime.recordLedgerLock({ sessionId: 'ses_native', operation: 'finishDirect', waitMs: 20, holdMs: 30, failed: true });
    runtime.recordBridgeCall({ sessionId: 'ses_native', method: 'native.admission.authorize', durationMs: 900, statusCode: 200, reused: false });
    runtime.recordBridgeCall({ sessionId: 'ses_native', method: 'native.admission.authorize', durationMs: 300, statusCode: 503, reused: true });
    runtime.recordBridgeCall({ sessionId: 'ses_native', method: 'native.observation', durationMs: 100, statusCode: null });
    now = 9_000;
    expect(runtime.recordSessionMark({ sessionId: 'ses_native', mark: 'provider_request_prepared', metadata: { kind: 'primary', requestID: 'req_1' } })).toBe(true);
    now = 9_500;
    runtime.recordSessionMark({ sessionId: 'ses_native', mark: 'provider_request_sent', metadata: { kind: 'primary', transport: 'ws', requestID: 'req_1', text: 'private' } });
    now = 10_000;
    runtime.recordSessionMark({ sessionId: 'ses_native', mark: 'provider_first_byte', metadata: { transport: 'http', statusCode: 200, requestID: 'req_1' } });
    expect(runtime.recordSessionMark({ sessionId: 'ses_native', mark: 'provider_first_byte' })).toBe(false);
    now = 11_000;
    runtime.processOpenCodeEvent({ type: 'message.updated', properties: { info: { id: 'msg_assistant', sessionID: 'ses_native', role: 'assistant',
      parentID: 'msg_user', time: { created: 11_000 } } } });
    runtime.processOpenCodeEvent({ type: 'message.part.delta', properties: { sessionID: 'ses_native', messageID: 'msg_assistant', partID: 'prt_1',
      field: 'text', delta: 'secret response text' } });
    now = 12_000;
    runtime.processOpenCodeEvent({ type: 'session.status', properties: { sessionID: 'ses_native', status: { type: 'idle' } } });
    // After the turn settles nothing more is attributed to it.
    expect(runtime.recordBridgeCall({ sessionId: 'ses_native', method: 'late', durationMs: 1, statusCode: 200 })).toBe(false);

    const [record] = runtime.getRecentTimings({ sessionId: 'ses_native' }).records;
    expect(record.durationsMs).toEqual(expect.objectContaining({
      send_started_to_provider_request_sent: 8_500,
      provider_request_sent_to_provider_first_byte: 500,
      provider_first_byte_to_first_text_delta: 1_000,
      send_started_to_first_text_delta: 10_000,
    }));
    expect(record.diagnostics.bridge).toEqual({ count: 3, durationMs: 1_300, maxMs: 900, reusedCount: 1, failedCount: 2,
      methods: [{ method: 'native.admission.authorize', count: 2, durationMs: 1_200, maxMs: 900 },
        { method: 'native.observation', count: 1, durationMs: 100, maxMs: 100 }] });
    expect(record.diagnostics.ledger).toEqual({ count: 2, waitMs: 7_720, holdMs: 70, maxWaitMs: 7_700, maxHoldMs: 40, failedCount: 1,
      operations: [{ action: 'registerNativeSession', count: 1, waitMs: 7_700, holdMs: 40 },
        { action: 'finishDirect', count: 1, waitMs: 20, holdMs: 30 }] });

    expect(marks.map((entry) => entry.mark)).toEqual(['send_started', 'prompt_accepted', 'provider_request_prepared', 'provider_request_sent',
      'provider_first_byte', 'assistant_message_created', 'first_text_delta', 'session_status_idle']);
    expect(marks.find((entry) => entry.mark === 'first_text_delta')).toEqual({ sessionId: 'ses_native', userMessageId: 'msg_user',
      directory: '/project', mark: 'first_text_delta', at: 11_000, payload: { assistantMessageID: 'msg_assistant', elapsedMs: 10_000 } });
    expect(marks.find((entry) => entry.mark === 'provider_request_sent').payload).toEqual({ elapsedMs: 8_500, transport: 'ws', kind: 'primary', requestID: 'req_1' });
    expect(marks.find((entry) => entry.mark === 'provider_first_byte').payload).toEqual({ elapsedMs: 9_000, transport: 'http', requestID: 'req_1', statusCode: 200 });
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ sessionId: 'ses_native', userMessageId: 'msg_user', mark: 'summary', at: 12_000, payload: {
      assistantMessageID: 'msg_assistant', durationMs: 11_000,
      model: { providerID: 'openai', modelID: 'gpt-5.6-sol', agent: 'orchestrator', variant: 'high' },
      bridge: record.diagnostics.bridge, ledger: record.diagnostics.ledger,
    } });
    expect(settled[0].payload.stages).toEqual(expect.arrayContaining([{ phase: 'provider_request_sent_to_provider_first_byte', durationMs: 500 }]));
    const journaled = JSON.stringify([marks, settled]);
    expect(journaled).not.toContain('private');
    expect(journaled).not.toContain('secret response text');
  });

  it('refuses late provider responses from an earlier turn', () => {
    const runtime = createTurnTimingRuntime();
    const sessionId = 'ses_native';
    runtime.recordClientMark({ sessionId, messageId: 'msg_old', mark: 'send_started' });
    runtime.recordSessionMark({ sessionId, mark: 'provider_request_prepared', metadata: { requestID: 'req_old' } });
    runtime.recordSessionMark({ sessionId, mark: 'provider_request_sent', metadata: { requestID: 'req_old' } });
    runtime.recordClientMark({ sessionId, messageId: 'msg_new', mark: 'send_started' });
    expect(runtime.recordSessionMark({ sessionId, mark: 'provider_first_byte', metadata: { requestID: 'req_old' } })).toBe(false);
    expect(runtime.recordSessionMark({ sessionId, mark: 'provider_request_sent', metadata: { requestID: 'req_old' } })).toBe(false);
    runtime.recordSessionMark({ sessionId, mark: 'provider_request_prepared', metadata: { requestID: 'req_new' } });
    expect(runtime.recordSessionMark({ sessionId, mark: 'provider_request_sent', metadata: { requestID: 'req_new' } })).toBe(true);
    expect(runtime.recordSessionMark({ sessionId, mark: 'provider_response_created', metadata: { requestID: 'req_old' } })).toBe(false);
    expect(runtime.recordSessionMark({ sessionId, mark: 'provider_first_byte', metadata: { requestID: 'req_new' } })).toBe(true);
  });

  it('keeps turn timing when a journal observer fails', () => {
    const runtime = createTurnTimingRuntime({ onTurnMark: () => { throw new Error('observer failure'); } });
    expect(runtime.recordClientMark({ sessionId: 'ses_1', messageId: 'msg_user', mark: 'send_started' })).toBe(true);
    expect(Object.keys(runtime.getRecentTimings({ sessionId: 'ses_1' }).records[0].marks)).toEqual(['send_started']);
  });

  it('correlates client timing marks with OpenCode turn events', () => {
    let now = 1_000;
    const runtime = createTurnTimingRuntime({ now: () => now });

    runtime.recordClientMark({
      sessionId: 'ses_1',
      messageId: 'msg_user',
      mark: 'send_started',
      directory: '/project',
    });

    now = 1_250;
    runtime.recordClientMark({
      sessionId: 'ses_1',
      messageId: 'msg_user',
      mark: 'prompt_accepted',
      directory: '/project',
    });

    now = 1_500;
    runtime.processOpenCodeEvent({
      type: 'session.status',
      properties: {
        sessionID: 'ses_1',
        status: { type: 'busy' },
      },
    });

    now = 2_000;
    runtime.processOpenCodeEvent({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg_assistant',
          sessionID: 'ses_1',
          role: 'assistant',
          parentID: 'msg_user',
          time: { created: 2_000 },
        },
      },
    });

    now = 3_000;
    runtime.processOpenCodeEvent({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'prt_step',
          messageID: 'msg_assistant',
          sessionID: 'ses_1',
          type: 'step-start',
        },
      },
    });

    now = 4_000;
    runtime.processOpenCodeEvent({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'prt_tool',
          messageID: 'msg_assistant',
          sessionID: 'ses_1',
          type: 'tool',
          state: { status: 'running' },
        },
      },
    });

    now = 5_000;
    runtime.processOpenCodeEvent({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'prt_tool',
          messageID: 'msg_assistant',
          sessionID: 'ses_1',
          type: 'tool',
          state: { status: 'completed' },
        },
      },
    });

    now = 6_000;
    runtime.processOpenCodeEvent({
      type: 'message.part.delta',
      properties: {
        messageID: 'msg_assistant',
        partID: 'prt_text',
        field: 'text',
        delta: 'Hello',
      },
    });

    now = 7_000;
    runtime.processOpenCodeEvent({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg_assistant',
          sessionID: 'ses_1',
          role: 'assistant',
          parentID: 'msg_user',
          time: { created: 2_000, completed: 7_000 },
          finish: 'stop',
        },
      },
    });

    now = 7_100;
    runtime.processOpenCodeEvent({
      type: 'session.status',
      properties: {
        sessionID: 'ses_1',
        status: { type: 'idle' },
      },
    });

    const recent = runtime.getRecentTimings({ sessionId: 'ses_1' });

    expect(recent.records).toHaveLength(1);
    expect(recent.records[0]).toEqual(expect.objectContaining({
      sessionId: 'ses_1',
      userMessageId: 'msg_user',
      assistantMessageId: 'msg_assistant',
      directory: '/project',
    }));
    expect(Object.keys(recent.records[0].marks)).toEqual([
      'send_started',
      'prompt_accepted',
      'session_status_busy',
      'assistant_message_created',
      'first_part_updated',
      'first_step_start',
      'first_tool_started',
      'first_tool_completed',
      'first_text_delta',
      'assistant_message_completed',
      'session_status_idle',
    ]);
    expect(recent.records[0].durationsMs).toEqual(expect.objectContaining({
      send_started_to_prompt_accepted: 250,
      prompt_accepted_to_assistant_message_created: 750,
      prompt_accepted_to_first_text_delta: 4_750,
      prompt_accepted_to_assistant_message_completed: 5_750,
    }));
  });

  it('records first-event marks only once', () => {
    let now = 1;
    const runtime = createTurnTimingRuntime({ now: () => now });

    runtime.recordClientMark({ sessionId: 'ses_1', messageId: 'msg_user', mark: 'send_started' });
    runtime.processOpenCodeEvent({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg_assistant',
          sessionID: 'ses_1',
          role: 'assistant',
          parentID: 'msg_user',
          time: { created: 1 },
        },
      },
    });

    now = 10;
    runtime.processOpenCodeEvent({
      type: 'message.part.delta',
      properties: { messageID: 'msg_assistant', partID: 'a', field: 'text', delta: 'a' },
    });
    now = 20;
    runtime.processOpenCodeEvent({
      type: 'message.part.delta',
      properties: { messageID: 'msg_assistant', partID: 'a', field: 'text', delta: 'b' },
    });

    const record = runtime.getRecentTimings({ sessionId: 'ses_1' }).records[0];

    expect(record.marks.first_text_delta.at).toBe(10);
  });

  it('records Cursor worker and SDK streaming timing marks', () => {
    let now = 100;
    const runtime = createTurnTimingRuntime({ now: () => now });

    runtime.recordClientMark({
      sessionId: 'ses_cursor',
      messageId: 'msg_cursor_user',
      mark: 'prompt_accepted',
      metadata: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
    });
    now = 110;
    runtime.recordClientMark({
      sessionId: 'ses_cursor',
      messageId: 'msg_cursor_user',
      mark: 'cursor_worker_ready',
      metadata: { workerMode: 'persistent-node-worker' },
    });
    now = 120;
    runtime.recordClientMark({
      sessionId: 'ses_cursor',
      messageId: 'msg_cursor_user',
      mark: 'cursor_run_create_started',
    });
    now = 145;
    runtime.recordClientMark({
      sessionId: 'ses_cursor',
      messageId: 'msg_cursor_user',
      mark: 'cursor_run_created',
    });
    now = 150;
    runtime.recordClientMark({
      sessionId: 'ses_cursor',
      messageId: 'msg_cursor_user',
      mark: 'cursor_provider_send_started',
    });
    now = 160;
    runtime.recordClientMark({
      sessionId: 'ses_cursor',
      messageId: 'msg_cursor_user',
      mark: 'cursor_provider_send_accepted',
    });
    now = 175;
    runtime.recordClientMark({
      sessionId: 'ses_cursor',
      messageId: 'msg_cursor_user',
      mark: 'cursor_first_sdk_delta',
    });
    now = 190;
    runtime.recordClientMark({
      sessionId: 'ses_cursor',
      messageId: 'msg_cursor_user',
      mark: 'cursor_first_stream_event',
    });
    now = 205;
    runtime.processOpenCodeEvent({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg_cursor_user_assistant',
          sessionID: 'ses_cursor',
          role: 'assistant',
          parentID: 'msg_cursor_user',
          time: { created: 190 },
        },
      },
    });
    now = 220;
    runtime.recordClientMark({
      sessionId: 'ses_cursor',
      messageId: 'msg_cursor_user',
      mark: 'cursor_first_emitted_text_delta',
    });
    now = 225;
    runtime.processOpenCodeEvent({
      type: 'message.part.delta',
      properties: {
        messageID: 'msg_cursor_user_assistant',
        partID: 'prt_text',
        field: 'text',
        delta: 'Hello',
      },
    });

    const record = runtime.getRecentTimings({ sessionId: 'ses_cursor' }).records[0];

    expect(record.marks).toEqual(expect.objectContaining({
      cursor_worker_ready: expect.objectContaining({
        metadata: { workerMode: 'persistent-node-worker' },
      }),
      cursor_run_create_started: expect.any(Object),
      cursor_run_created: expect.any(Object),
      cursor_provider_send_started: expect.any(Object),
      cursor_provider_send_accepted: expect.any(Object),
      cursor_first_sdk_delta: expect.any(Object),
      cursor_first_stream_event: expect.any(Object),
      cursor_first_emitted_text_delta: expect.any(Object),
      first_text_delta: expect.any(Object),
    }));
    expect(record.durationsMs).toEqual(expect.objectContaining({
      prompt_accepted_to_cursor_worker_ready: 10,
      cursor_run_create_started_to_cursor_run_created: 25,
      cursor_run_created_to_cursor_provider_send_started: 5,
      cursor_provider_send_started_to_cursor_provider_send_accepted: 10,
      cursor_provider_send_accepted_to_cursor_first_sdk_delta: 15,
      cursor_provider_send_accepted_to_cursor_first_stream_event: 30,
      cursor_run_created_to_cursor_first_sdk_delta: 30,
      cursor_run_created_to_cursor_first_stream_event: 45,
      cursor_first_sdk_delta_to_first_text_delta: 50,
      cursor_first_stream_event_to_first_text_delta: 35,
      cursor_first_sdk_delta_to_cursor_first_emitted_text_delta: 45,
      cursor_first_stream_event_to_cursor_first_emitted_text_delta: 30,
    }));
  });

  it('records Cursor prewarm and deferred baseline timing marks', () => {
    let now = 1_000;
    const runtime = createTurnTimingRuntime({ now: () => now });

    runtime.recordClientMark({
      sessionId: 'ses_cursor_draft',
      messageId: 'msg_cursor_user',
      mark: 'cursor_draft_session_create_started',
      metadata: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
    });
    now = 1_050;
    runtime.recordClientMark({
      sessionId: 'ses_cursor_draft',
      messageId: 'msg_cursor_user',
      mark: 'cursor_draft_session_created',
      metadata: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
    });
    now = 1_075;
    runtime.recordClientMark({
      sessionId: 'ses_cursor_draft',
      messageId: 'msg_cursor_user',
      mark: 'cursor_prewarm_started',
      metadata: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
    });
    now = 1_100;
    runtime.recordClientMark({
      sessionId: 'ses_cursor_draft',
      messageId: 'msg_cursor_user',
      mark: 'cursor_agent_prepare_started',
    });
    now = 1_180;
    runtime.recordClientMark({
      sessionId: 'ses_cursor_draft',
      messageId: 'msg_cursor_user',
      mark: 'cursor_agent_prepared',
      metadata: { cacheHit: false },
    });
    now = 1_200;
    runtime.recordClientMark({
      sessionId: 'ses_cursor_draft',
      messageId: 'msg_cursor_user',
      mark: 'cursor_prewarm_completed',
      metadata: { cacheHit: false },
    });
    now = 1_250;
    runtime.recordClientMark({
      sessionId: 'ses_cursor_draft',
      messageId: 'msg_cursor_user',
      mark: 'prompt_accepted',
    });
    now = 1_260;
    runtime.recordClientMark({
      sessionId: 'ses_cursor_draft',
      messageId: 'msg_cursor_user',
      mark: 'cursor_baseline_diff_deferred',
    });

    const record = runtime.getRecentTimings({ sessionId: 'ses_cursor_draft' }).records[0];

    expect(record.marks).toEqual(expect.objectContaining({
      cursor_draft_session_create_started: expect.any(Object),
      cursor_draft_session_created: expect.any(Object),
      cursor_prewarm_started: expect.any(Object),
      cursor_agent_prepare_started: expect.any(Object),
      cursor_agent_prepared: expect.objectContaining({ metadata: { cacheHit: false } }),
      cursor_prewarm_completed: expect.objectContaining({ metadata: { cacheHit: false } }),
      cursor_baseline_diff_deferred: expect.any(Object),
    }));
    expect(record.durationsMs).toEqual(expect.objectContaining({
      cursor_draft_session_create_started_to_cursor_draft_session_created: 50,
      cursor_prewarm_started_to_cursor_prewarm_completed: 125,
      cursor_agent_prepare_started_to_cursor_agent_prepared: 80,
      prompt_accepted_to_cursor_baseline_diff_deferred: 10,
    }));
  });

  it('records provider metadata and Cursor tool-schema diagnostics without response text', () => {
    let now = 1;
    const runtime = createTurnTimingRuntime({ now: () => now });

    runtime.recordClientMark({
      sessionId: 'ses_1',
      messageId: 'msg_user',
      mark: 'prompt_accepted',
      metadata: {
        providerID: 'cursor-acp',
        modelID: 'composer-2.5',
        agent: 'builder',
        variant: 'default',
      },
    });

    now = 2;
    runtime.processOpenCodeEvent({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg_assistant',
          sessionID: 'ses_1',
          role: 'assistant',
          parentID: 'msg_user',
          time: { created: 2 },
        },
      },
    });

    now = 3;
    const repeated = 'Checking the relevant profile form file.';
    runtime.processOpenCodeEvent({
      type: 'message.part.delta',
      properties: { messageID: 'msg_assistant', partID: 'prt_text', field: 'text', delta: repeated },
    });
    runtime.processOpenCodeEvent({
      type: 'message.part.delta',
      properties: { messageID: 'msg_assistant', partID: 'prt_text', field: 'text', delta: repeated },
    });
    runtime.processOpenCodeEvent({
      type: 'message.part.delta',
      properties: {
        messageID: 'msg_assistant',
        partID: 'prt_text',
        field: 'text',
        delta: 'Skipped malformed tool call "edit": Invalid arguments for tool "edit": missing required: old_string.',
      },
    });
    runtime.processOpenCodeEvent({
      type: 'message.part.delta',
      properties: {
        messageID: 'msg_assistant',
        partID: 'prt_text',
        field: 'text',
        delta: 'Tool loop guard stopped repeated schema-invalid calls to "edit" after 4 attempts (limit 2).',
      },
    });

    runtime.processOpenCodeEvent({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg_assistant',
          sessionID: 'ses_1',
          role: 'assistant',
          parentID: 'msg_user',
          time: { created: 2, completed: 4 },
          summary: { diffs: [{ additions: 1, deletions: 0 }] },
        },
      },
    });

    const record = runtime.getRecentTimings({ sessionId: 'ses_1' }).records[0];

    expect(record.model).toEqual({
      providerID: 'cursor-acp',
      modelID: 'composer-2.5',
      agent: 'builder',
      variant: 'default',
    });
    expect(record.diagnostics).toMatchObject({
      malformedToolCallCount: 1,
      toolLoopGuardCount: 1,
      repeatedTextFrameCount: 1,
      mutationEvidence: true,
    });
    expect(JSON.stringify(record)).not.toContain(repeated);
    expect(JSON.stringify(record)).not.toContain('old_string');
  });

  it('records transport failure timing and contextual concurrency without retaining idle sessions', () => {
    let now = 100;
    const runtime = createTurnTimingRuntime({ now: () => now });
    const accept = (sessionId, messageId, providerID, modelID) => {
      runtime.recordClientMark({
        sessionId,
        messageId,
        mark: 'prompt_accepted',
        metadata: { providerID, modelID, agent: 'builder', variant: 'high' },
      });
    };

    accept('ses_openai_1', 'msg_openai_1', 'openai', 'gpt-5.6');
    now = 110;
    accept('ses_anthropic', 'msg_anthropic', 'anthropic', 'claude-opus');
    now = 120;
    accept('ses_openai_2', 'msg_openai_2', 'openai', 'gpt-5.6');

    runtime.processOpenCodeEvent({
      type: 'session.status',
      properties: { sessionID: 'ses_openai_1', status: { type: 'busy' } },
    });
    runtime.processOpenCodeEvent({
      type: 'session.status',
      properties: { sessionID: 'ses_openai_1', status: { type: 'busy' } },
    });

    now = 601_368;
    runtime.processOpenCodeEvent({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg_assistant_timeout',
          sessionID: 'ses_openai_1',
          role: 'assistant',
          parentID: 'msg_openai_1',
          time: { created: 1_000, completed: 601_368 },
          error: {
            name: 'UnknownError',
            data: { message: 'The operation timed out.' },
          },
        },
      },
    });
    expect(runtime.getRecentTimings({ sessionId: 'ses_openai_1' }).records[0]
      .diagnostics.terminalFailure).toBeNull();
    runtime.processOpenCodeEvent({
      type: 'session.status',
      properties: { sessionID: 'ses_openai_1', status: { type: 'idle' } },
    });

    const failedRecord = runtime.getRecentTimings({ sessionId: 'ses_openai_1' }).records[0];
    expect(failedRecord.model).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.6',
      agent: 'builder',
      variant: 'high',
    });
    expect(failedRecord.diagnostics.terminalFailure).toEqual({
      kind: 'request_timeout',
      elapsedMs: 600_368,
    });
    expect(failedRecord.diagnostics.concurrency).toEqual({
      evidenceOnly: true,
      atAcceptance: {
        activeTotal: 1,
        activeSameProvider: 1,
      },
      atTerminalFailure: {
        activeTotal: 3,
        activeSameProvider: 2,
      },
    });

    runtime.processOpenCodeEvent({
      type: 'session.deleted',
      properties: { info: { id: 'ses_anthropic' } },
    });
    runtime.processOpenCodeEvent({
      type: 'session.status',
      properties: { sessionID: 'ses_openai_2', status: { type: 'idle' } },
    });

    now = 601_500;
    accept('ses_openai_3', 'msg_openai_3', 'openai', 'gpt-5.6');
    expect(runtime.getRecentTimings({ sessionId: 'ses_openai_3' }).records[0]
      .diagnostics.concurrency.atAcceptance).toEqual({
      activeTotal: 1,
      activeSameProvider: 1,
    });
  });

  it('records Cursor workspace and mutating tool diagnostics without raw payloads', () => {
    let now = 10;
    const runtime = createTurnTimingRuntime({ now: () => now });

    runtime.recordClientMark({
      sessionId: 'ses_cursor',
      messageId: 'msg_user',
      mark: 'send_started',
      directory: '/project',
      metadata: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
    });

    now = 20;
    runtime.recordClientMark({
      sessionId: 'ses_cursor',
      messageId: 'msg_user',
      mark: 'cursor_workspace_repair_started',
      metadata: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
    });

    now = 45;
    runtime.recordClientMark({
      sessionId: 'ses_cursor',
      messageId: 'msg_user',
      mark: 'cursor_workspace_repair_completed',
      metadata: { changed: true, restarted: false, path: '/secret/path.ts' },
    });

    now = 50;
    runtime.recordClientMark({
      sessionId: 'ses_cursor',
      messageId: 'msg_user',
      mark: 'prompt_request_started',
      metadata: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
    });

    now = 60;
    runtime.recordClientMark({
      sessionId: 'ses_cursor',
      messageId: 'msg_user',
      mark: 'prompt_accepted',
      metadata: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
    });

    now = 70;
    runtime.processOpenCodeEvent({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg_assistant',
          sessionID: 'ses_cursor',
          role: 'assistant',
          parentID: 'msg_user',
          time: { created: 70 },
        },
      },
    });

    now = 80;
    runtime.processOpenCodeEvent({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'tool_patch',
          messageID: 'msg_assistant',
          sessionID: 'ses_cursor',
          type: 'tool',
          tool: 'patchToolCall',
          state: {
            status: 'done',
            input: {
              patchText: '--- a/src/secret.ts\n+++ b/src/secret.ts\n@@ -1 +1 @@\n-old\n+new',
            },
          },
        },
      },
    });

    const record = runtime.getRecentTimings({ sessionId: 'ses_cursor' }).records[0];

    expect(Object.keys(record.marks)).toEqual([
      'send_started',
      'cursor_workspace_repair_started',
      'cursor_workspace_repair_completed',
      'prompt_request_started',
      'prompt_accepted',
      'assistant_message_created',
      'first_part_updated',
      'first_tool_completed',
    ]);
    expect(record.durationsMs).toMatchObject({
      cursor_workspace_repair_started_to_cursor_workspace_repair_completed: 25,
      prompt_request_started_to_prompt_accepted: 10,
    });
    expect(record.diagnostics.mutatingToolCalls).toEqual([
      { tool: 'apply_patch', status: 'done', final: true },
    ]);
    expect(record.diagnostics.cursorWorkspaceRepair).toEqual({ changed: true, restarted: false });
    expect(JSON.stringify(record)).not.toContain('secret.ts');
    expect(JSON.stringify(record)).not.toContain('patchText');
  });

  it('correlates proxy timing marks and ignores user text part updates', () => {
    let now = 100;
    const runtime = createTurnTimingRuntime({ now: () => now });

    runtime.recordClientMark({ sessionId: 'ses_1', mark: 'send_started', directory: '/project' });
    now = 150;
    runtime.recordClientMark({ sessionId: 'ses_1', mark: 'prompt_accepted', directory: '/project' });

    now = 200;
    runtime.processOpenCodeEvent({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'prt_user_text',
          messageID: 'msg_user',
          sessionID: 'ses_1',
          type: 'text',
          text: 'hello',
        },
      },
    });

    now = 300;
    runtime.processOpenCodeEvent({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg_assistant',
          sessionID: 'ses_1',
          role: 'assistant',
          parentID: 'msg_user',
          time: { created: 300 },
        },
      },
    });

    now = 400;
    runtime.processOpenCodeEvent({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'prt_step',
          messageID: 'msg_assistant',
          sessionID: 'ses_1',
          type: 'step-start',
        },
      },
    });

    const recent = runtime.getRecentTimings({ sessionId: 'ses_1' });

    expect(recent.records).toHaveLength(1);
    expect(recent.records[0]).toEqual(expect.objectContaining({
      userMessageId: 'msg_user',
      assistantMessageId: 'msg_assistant',
    }));
    expect(recent.records[0].marks.first_part_updated.metadata).toEqual({
      partId: 'prt_step',
      type: 'step-start',
    });
    expect(recent.records[0].durationsMs).toEqual(expect.objectContaining({
      send_started_to_prompt_accepted: 50,
      prompt_accepted_to_assistant_message_created: 150,
      prompt_accepted_to_first_part_updated: 250,
    }));
  });

  it('caps records and evicts old entries', () => {
    let now = 0;
    const runtime = createTurnTimingRuntime({
      now: () => now,
      maxRecords: 2,
      maxAgeMs: 50,
    });

    runtime.recordClientMark({ sessionId: 'ses_1', messageId: 'msg_old', mark: 'send_started' });
    now = 40;
    runtime.recordClientMark({ sessionId: 'ses_1', messageId: 'msg_keep_1', mark: 'send_started' });
    now = 60;
    runtime.recordClientMark({ sessionId: 'ses_1', messageId: 'msg_keep_2', mark: 'send_started' });
    now = 89;

    expect(runtime.getRecentTimings({ sessionId: 'ses_1' }).records.map((record) => record.userMessageId)).toEqual([
      'msg_keep_1',
      'msg_keep_2',
    ]);

    now = 110;
    expect(runtime.getRecentTimings({ sessionId: 'ses_1' }).records.map((record) => record.userMessageId)).toEqual([
      'msg_keep_2',
    ]);
  });

  it('delegates operator aborts and runtime exits to the lifecycle tracker', () => {
    const runtime = createTurnTimingRuntime();
    const events = [];
    runtime.subscribeLifecycle((event) => events.push(event));
    runtime.recordPromptAccepted({ sessionID: 'ses_abort', messageID: 'msg_user' });
    expect(runtime.recordAbortRequested({ sessionID: 'ses_abort' })).toBe(true);
    runtime.processOpenCodeEvent({ type: 'session.status', properties: { sessionID: 'ses_abort', status: { type: 'idle' } } });
    runtime.recordPromptAccepted({ sessionID: 'ses_exit', messageID: 'msg_user' });
    runtime.recordAbortRequested({ sessionID: 'ses_exit' });
    runtime.withdrawAbortRequest({ sessionID: 'ses_exit' });
    expect(runtime.recordRuntimeInterrupted({ sessionID: 'ses_exit' })).toBe(true);
    runtime.processOpenCodeEvent({ type: 'session.idle', properties: { sessionID: 'ses_exit' } });
    expect(events.filter((event) => event.type.startsWith('turn_') && event.type !== 'turn_started')
      .map((event) => [event.type, event.sessionID, event.reason])).toEqual([
      ['turn_aborted', 'ses_abort', 'abort_requested'],
      ['turn_failed', 'ses_exit', 'runtime_exit'],
    ]);
  });

  it('wraps diagnostic route responses while preserving existing fields and status codes', async () => {
    const app = express();
    app.use(express.json());
    const runtime = createTurnTimingRuntime();
    const acceptedMarks = [];
    registerTurnTimingRoutes(app, runtime, {
      authorize: async () => true,
      onAcceptedMark: (input) => acceptedMarks.push(input),
    });

    await request(app)
      .post('/api/diagnostics/turn-timing/mark')
      .send({ sessionId: 'ses_1', mark: 'send_started' })
      .expect(200)
      .expect((res) => {
        expect(res.body.ok).toBe(true);
        expect(res.body.harness).toEqual(expect.objectContaining({
          status: 'success',
          summary: 'Turn timing mark recorded',
        }));
      });

    await request(app)
      .post('/api/diagnostics/turn-timing/mark')
      .send({
        sessionId: 'ses_1',
        assistantMessageId: 'msg_assistant',
        mark: 'renderer_tool_input_stall_confirmed',
      })
      .expect(200);
    expect(acceptedMarks.at(-1)).toEqual(expect.objectContaining({
      mark: 'renderer_tool_input_stall_confirmed',
    }));

    await request(app)
      .post('/api/diagnostics/turn-timing/mark')
      .send({
        sessionId: 'ses_1',
        assistantMessageId: 'msg_assistant',
        mark: 'renderer_provider_inference_stall_confirmed',
      })
      .expect(200);
    expect(acceptedMarks.at(-1)).toEqual(expect.objectContaining({
      mark: 'renderer_provider_inference_stall_confirmed',
    }));

    await request(app)
      .post('/api/diagnostics/turn-timing/mark')
      .send({ mark: 'send_started' })
      .expect(400)
      .expect((res) => {
        expect(res.body.ok).toBe(false);
        expect(res.body.error).toBe('Invalid turn timing mark');
        expect(res.body.harness).toEqual(expect.objectContaining({
          status: 'error',
          recovery: expect.objectContaining({
            retryable: true,
            stopCondition: expect.any(String),
          }),
        }));
      });

    await request(app)
      .get('/api/diagnostics/turn-timing/recent')
      .expect(200)
      .expect((res) => {
        expect(Array.isArray(res.body.records)).toBe(true);
        expect(res.body.harness).toEqual(expect.objectContaining({
          status: 'success',
          summary: 'Turn timing diagnostics loaded',
        }));
      });
  });

  it('diagnostics fail closed and require ownership for marks and every returned session', async () => {
    const app = express(); app.use(express.json());
    const runtime = createTurnTimingRuntime();
    runtime.recordClientMark({ sessionId: 'owned', mark: 'send_started' });
    runtime.recordClientMark({ sessionId: 'foreign', messageId: 'foreign-user', assistantMessageId: 'foreign-assistant', mark: 'send_started' });
    let permission = false;
    registerTurnTimingRoutes(app, runtime, { authorize: async (_req, sessionId) => permission && (!sessionId || sessionId === 'owned') });
    await request(app).get('/api/diagnostics/turn-timing/recent').expect(403);
    await request(app).post('/api/diagnostics/turn-timing/mark').send({ sessionId: 'owned', mark: 'first_text_delta' }).expect(403);
    permission = true;
    await request(app).post('/api/diagnostics/turn-timing/mark').send({ sessionId: 'owned', assistantMessageId: 'foreign-assistant', mark: 'first_text_delta' }).expect(400);
    await request(app).post('/api/diagnostics/turn-timing/mark').send({ assistantMessageId: 'foreign-assistant', mark: 'first_text_delta' }).expect(400);
    await request(app).post('/api/diagnostics/turn-timing/mark').send({ sessionId: 'foreign', mark: 'first_text_delta' }).expect(403);
    await request(app).get('/api/diagnostics/turn-timing/recent?sessionId=foreign').expect(403);
    const visible = await request(app).get('/api/diagnostics/turn-timing/recent').expect(200);
    expect(visible.body.records.map(record => record.sessionId)).toEqual(['owned']);
    await request(app).post('/api/diagnostics/turn-timing/mark').send({ sessionId: 'owned', mark: 'provider_request_sent' }).expect(400);
    expect(runtime.getRecentTimings({ sessionId: 'owned' }).records[0].marks.first_text_delta).toBeUndefined();
    const unowned = express(); registerTurnTimingRoutes(unowned, runtime);
    await request(unowned).get('/api/diagnostics/turn-timing/recent').expect(403);
  });

  it('accepts sanitized renderer timing marks without storing prompt or response text', () => {
    let now = 1_000;
    const runtime = createTurnTimingRuntime({ now: () => now });

    runtime.recordClientMark({
      sessionId: 'ses_1',
      messageId: 'msg_user',
      mark: 'send_started',
      directory: '/project',
    });

    now = 1_100;
    runtime.processOpenCodeEvent({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg_assistant',
          sessionID: 'ses_1',
          role: 'assistant',
          parentID: 'msg_user',
          time: { created: 1_100 },
        },
      },
    });

    now = 1_150;
    expect(runtime.recordClientMark({
      assistantMessageId: 'msg_assistant',
      mark: 'renderer_event_received',
      metadata: {
        runtime: 'desktop',
        transport: 'ws',
        visibilityState: 'visible',
        prompt: 'secret prompt',
        text: 'secret response',
        delta: 'secret token',
      },
    })).toBe(true);

    const record = runtime.getRecentTimings({ sessionId: 'ses_1' }).records[0];
    expect(record.marks.renderer_event_received.metadata).toEqual({
      runtime: 'desktop',
      transport: 'ws',
      visibilityState: 'visible',
    });
    expect(JSON.stringify(record)).not.toContain('secret');
  });

  it('accepts the operational renderer tool-input stall mark', () => {
    const runtime = createTurnTimingRuntime();

    expect(runtime.recordClientMark({
      sessionId: 'ses_stall',
      assistantMessageId: 'msg_assistant',
      mark: 'renderer_tool_input_stall_confirmed',
      directory: '/project',
      metadata: { source: 'active-session-watchdog' },
    })).toBe(true);

    expect(runtime.getRecentTimings({ sessionId: 'ses_stall' }).records[0]
      .marks.renderer_tool_input_stall_confirmed.metadata).toEqual({
      source: 'active-session-watchdog',
    });
  });

  it('accepts the operational renderer inference stall mark with sanitized duration', () => {
    const runtime = createTurnTimingRuntime();

    expect(runtime.recordClientMark({
      sessionId: 'ses_stall',
      assistantMessageId: 'msg_assistant',
      mark: 'renderer_provider_inference_stall_confirmed',
      directory: '/project',
      metadata: {
        source: 'active-session-watchdog',
        stalledForMs: 300_123.9,
        text: 'secret response',
      },
    })).toBe(true);

    const record = runtime.getRecentTimings({ sessionId: 'ses_stall' }).records[0];
    expect(record.marks.renderer_provider_inference_stall_confirmed.metadata).toEqual({
      source: 'active-session-watchdog',
      stalledForMs: 300_123,
    });
    expect(JSON.stringify(record)).not.toContain('secret');
  });

  it('accepts a sanitized renderer long-running tool mark', () => {
    const runtime = createTurnTimingRuntime();

    expect(runtime.recordClientMark({
      sessionId: 'ses_long_tool',
      assistantMessageId: 'msg_assistant',
      mark: 'renderer_long_running_tool_confirmed',
      directory: '/project',
      metadata: {
        source: 'active-session-watchdog',
        tool: 'ctx_execute',
        elapsedMs: 300_123.9,
        stalledForMs: 300_000,
        runtime: 'renderer-secret',
        code: 'secret code',
        output: 'secret output',
      },
    })).toBe(true);

    const record = runtime.getRecentTimings({ sessionId: 'ses_long_tool' }).records[0];
    expect(record.marks.renderer_long_running_tool_confirmed.metadata).toEqual({
      source: 'active-session-watchdog',
      tool: 'ctx_execute',
      elapsedMs: 300_123,
    });
    expect(JSON.stringify(record)).not.toContain('secret');
  });

  it('projects ordered tool-call instances and updates repeated states in place without payloads or identities', () => {
    const runtime = createTurnTimingRuntime();
    runtime.recordClientMark({ sessionId: 'ses_tools', messageId: 'msg_user', mark: 'send_started' });
    runtime.processOpenCodeEvent({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg_assistant',
          sessionID: 'ses_tools',
          role: 'assistant',
          parentID: 'msg_user',
          time: { created: 1 },
        },
      },
    });

    for (const status of ['pending', 'running', 'completed']) {
      runtime.processOpenCodeEvent({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_secret_one',
            callID: 'call_secret_one',
            messageID: 'msg_assistant',
            sessionID: 'ses_tools',
            type: 'tool',
            tool: 'runtime.EditFileToolCall:1',
            state: {
              status,
              input: { path: '/private/first.ts' },
              output: 'private first output',
            },
          },
        },
      });
    }
    runtime.processOpenCodeEvent({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'part_secret_two',
          callID: 'call_secret_two',
          messageID: 'msg_assistant',
          sessionID: 'ses_tools',
          type: 'tool',
          tool: 'runtime.EditFileToolCall:2',
          state: {
            status: 'error',
            input: { path: '/private/second.ts' },
            error: 'private second error',
          },
        },
      },
    });

    const toolCalls = runtime.getRecentTimings({ sessionId: 'ses_tools' })
      .records[0]
      .diagnostics
      .toolCalls;

    expect(toolCalls).toEqual([
      { ordinal: 1, tool: 'edit', status: 'completed', final: true },
      { ordinal: 2, tool: 'edit', status: 'error', final: true },
    ]);
    expect(toolCalls.every((toolCall) => Object.keys(toolCall).length === 4)).toBe(true);
    expect(JSON.stringify(toolCalls)).not.toContain('secret');
    expect(JSON.stringify(toolCalls)).not.toContain('private');
  });

  it('caps the ordered tool-call projection while retaining updates for tracked calls', () => {
    const runtime = createTurnTimingRuntime({ maxToolCalls: 2 });
    runtime.recordClientMark({ sessionId: 'ses_cap', messageId: 'msg_user', mark: 'send_started' });
    runtime.processOpenCodeEvent({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg_assistant',
          sessionID: 'ses_cap',
          role: 'assistant',
          parentID: 'msg_user',
          time: { created: 1 },
        },
      },
    });
    const updateTool = (id, tool, status) => runtime.processOpenCodeEvent({
      type: 'message.part.updated',
      properties: {
        part: {
          id: `part_${id}`,
          callID: `call_${id}`,
          messageID: 'msg_assistant',
          sessionID: 'ses_cap',
          type: 'tool',
          tool,
          state: { status, input: {} },
        },
      },
    });

    updateTool('one', 'read', 'running');
    updateTool('two', 'write', 'completed');
    updateTool('three', 'bash', 'completed');

    expect(runtime.getRecentTimings({ sessionId: 'ses_cap' })
      .records[0]
      .diagnostics
      .latestToolCall).toEqual({
      ordinal: 3,
      tool: 'bash',
      status: 'completed',
      final: true,
    });

    updateTool('one', 'read', 'completed');

    const toolCalls = runtime.getRecentTimings({ sessionId: 'ses_cap' })
      .records[0]
      .diagnostics
      .toolCalls;

    expect(toolCalls).toEqual([
      { ordinal: 1, tool: 'read', status: 'completed', final: true },
      { ordinal: 2, tool: 'write', status: 'completed', final: true },
    ]);
    expect(runtime.getRecentTimings({ sessionId: 'ses_cap' })
      .records[0]
      .diagnostics
      .latestToolCall).toEqual({
      ordinal: 1,
      tool: 'read',
      status: 'completed',
      final: true,
    });
  });

  it('keeps terminal tool-call finality when a stale active state arrives later', () => {
    const runtime = createTurnTimingRuntime();
    runtime.recordClientMark({ sessionId: 'ses_stale', messageId: 'msg_user', mark: 'send_started' });
    runtime.processOpenCodeEvent({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg_assistant',
          sessionID: 'ses_stale',
          role: 'assistant',
          parentID: 'msg_user',
          time: { created: 1 },
        },
      },
    });
    const updateStatus = (status) => runtime.processOpenCodeEvent({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'part_one',
          callID: 'call_one',
          messageID: 'msg_assistant',
          sessionID: 'ses_stale',
          type: 'tool',
          tool: 'read',
          state: { status, input: {} },
        },
      },
    });

    updateStatus('completed');
    updateStatus('running');

    expect(runtime.getRecentTimings({ sessionId: 'ses_stale' }).records[0].diagnostics.toolCalls).toEqual([
      { ordinal: 1, tool: 'read', status: 'completed', final: true },
    ]);
  });
});
