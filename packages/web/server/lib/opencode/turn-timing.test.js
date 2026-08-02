import express from 'express';
import request from '../../test-supertest.js';
import { describe, expect, it } from 'vitest';

import { createTurnTimingRuntime, registerTurnTimingRoutes } from './turn-timing.js';

describe('turn timing runtime', () => {
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

  it('wraps diagnostic route responses while preserving existing fields and status codes', async () => {
    const app = express();
    app.use(express.json());
    const runtime = createTurnTimingRuntime();
    const acceptedMarks = [];
    registerTurnTimingRoutes(app, runtime, {
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
