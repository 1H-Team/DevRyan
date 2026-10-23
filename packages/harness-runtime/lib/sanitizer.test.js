import { describe, expect, test } from 'bun:test';

import { createDiagnosticSanitizer } from './sanitizer.js';
import { parseNativeJournalObservation } from '../../shared-runtime/lib/native-observation.js';

describe('diagnostic sanitizer', () => {
  test('high-entropy redaction keeps file paths, DevRyan identifiers and result cursors but still redacts tokens', () => {
    const sanitizer = createDiagnosticSanitizer();
    for (const kept of ['/apps/web/src/components/floating/SupportWidget/__tests__/SupportWidget.test.tsx',
      '<WORKTREE_1>/tests/e2e/public-chat-positioning.spec.ts', '/apps/web/src/hooks/__tests__/useMobileBottomNavClearanceSync.test.ts',
      'dvr_task_8f3K2pQ9xL7mZ1vB4nR6tY0wE5sA3dHj',
      'nextCursor=dvr_result_cursor_v1.eyJ2IjoxLCJ0IjoiZHZyX3Rhc2tfZ29sZGVuMSIsImUiOiJkdnJfcmVzdWx0X2dvbGRlbjFfMSJ9']) {
      expect(sanitizer.sanitizeText(kept)).toBe(kept);
    }
    expect(sanitizer.sanitizeText('/session/ses_0123456789abcdefAbCdEfGhIjKlMnOp/message')).toBe('/session/[REDACTED]:high_entropy/message');
    for (const secret of ['8f3K2pQ9xL7mZ1vB4nR6tY0wE5sA3dHjK9', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'ab12/Cd34EfGh56/IjKl78MnOp90QrSt']) {
      expect(sanitizer.sanitizeText(`value ${secret} end`)).toBe('value [REDACTED]:high_entropy end');
    }
  });
  test('high-entropy redaction judges path segments separately', () => {
    const sanitizer = createDiagnosticSanitizer();
    for (const kept of ['/packages/web/server/lib/opencode/v2-native/session-host2.test.ts',
      '/packages/ui/src/hooks/useSSE/v2-native-stream4.ts', '/apps/web/src/lib/XMLHttpRequestAdapter/OAuthCallbackSSE2.tsx',
      '/server/migrations/20261023-native-profile/0001_initial.sql', '<WORKTREE_1>/tests/e2e2/v2-native/profile-dark-surfaces.visual.spec.ts',
      '/tests/fixtures/issue-12345/h264-decoder/e2e2-render.ts']) {
      expect(sanitizer.sanitizeText(kept)).toBe(kept);
    }
    expect(sanitizer.sanitizeText('/sessions/ses_0123456789abcdefAbCdEfGhIjKlMnOp/v2-native/useSSE.ts'))
      .toBe('/sessions/[REDACTED]:high_entropy/v2-native/useSSE.ts');
    expect(sanitizer.sanitizeText('cache /blobs/8f3K2pQ9xL7mZ1vB4nR6tY0wE5sA3dHjK9/2026-v2/index'))
      .toBe('cache /blobs/[REDACTED]:high_entropy/2026-v2/index');
    for (const secret of ['Cd34EfGh56/IjKl78MnOp90QrSt/ab12UvWx', 'docs/wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY']) {
      expect(sanitizer.sanitizeText(`value ${secret} end`)).toBe('value [REDACTED]:high_entropy end');
    }
  });
  test('Cursor final association retains only finite content-free metadata through journal and export', () => {
    const sanitizer = createDiagnosticSanitizer();
    const payload = { assistantMessageID: 'msg_fixture_assistant', partID: 'msg_fixture_assistant_part_000003_text',
      assistantOrdinal: 2, streamedParts: 2, previousLength: 1, finalLength: 1, equal: true, state: 'matched' };
    const record = { type: 'lifecycle', event: 'cursor_final_association', sessionID: 'ses_fixture', payload: {
      ...payload, text: 'private text', result: 'private final', hash: 'private hash', reason: 'private reason', extra: 'private',
    } };
    const saved = sanitizer.sanitizeRecord(record);
    expect(saved.payload).toEqual(payload);
    expect(sanitizer.sanitizeExportValue(saved)).toEqual(saved);
    expect(sanitizer.sanitizeExportValue(record).payload).toEqual(payload);
    for (const reason of ['missing', 'unavailable', 'limit', 'shape', 'mismatch']) {
      expect(sanitizer.sanitizeRecord({ ...record, payload: { state: 'unavailable', reason,
        code: 'CURSOR_STREAM_FINAL_ASSOCIATION_INVALID' } }).payload).toEqual({ state: 'unavailable', reason, code: 'CURSOR_STREAM_FINAL_ASSOCIATION_INVALID' });
    }
    expect(sanitizer.sanitizeRecord({ ...record, payload: { partID: 'private value', assistantOrdinal: 0,
      streamedParts: 4097, previousLength: -1, finalLength: 16 * 1024 * 1024 + 1, equal: 'true',
      state: 'private', reason: 'private', code: 'private', raw: 'private' } }).payload).toEqual({});
    expect(sanitizer.sanitizeRecord({ ...record, event: 'unrelated', payload: { partID: payload.partID,
      assistantOrdinal: 2, streamedParts: 2, previousLength: 1, finalLength: 1, equal: true } }).payload).toEqual({});
  });
  test('mandatory persistence attention retains only typed owner timing and scope', () => {
    const sanitizer = createDiagnosticSanitizer();
    const record = sanitizer.sanitizeRecord({ type: 'lifecycle', event: 'managed_persistence', sessionID: 'ses_root', payload: {
      state: 'needs_attention', code: 'managed_persistence_stalled', ownerID: 'dvr_save_one', taskId: 'dvr_task_one', rootSessionId: 'ses_root',
      phase: 'file_sync', reason: 'task_deadline', at: 100, elapsedMs: 50, idleMs: 20, taskCount: 2,
      prompt: 'private content', path: '/private/ledger.json', token: 'private token', phaseOverride: 'finalizing',
    } });
    expect(record.payload).toEqual({ state: 'needs_attention', code: 'managed_persistence_stalled', ownerID: 'dvr_save_one', taskId: 'dvr_task_one',
      rootSessionId: 'ses_root', phase: 'file_sync', reason: 'task_deadline', at: 100, elapsedMs: 50, idleMs: 20, taskCount: 2 });
    expect(sanitizer.sanitizeExportValue(record)).toEqual(record);
    expect(sanitizer.sanitizeRecord({ type: 'lifecycle', event: 'managed_persistence', payload: {
      phase: 'private text', idleMs: -1, outcome: 'assumed committed', ownerID: 'untrusted',
    } }).payload).toEqual({});
  });
  test('receipt diagnostics retain booleans and bounded counts only in their owned records', () => {
    const sanitizer = createDiagnosticSanitizer();
    const receipt = sanitizer.sanitizeRecord({ type: 'log', event: 'session_changes_capture', payload: {
      code: 'exact_tool_receipt', hasChanges: false, private: 'private title',
    } });
    expect(receipt.payload).toEqual({ code: 'exact_tool_receipt', hasChanges: false });
    expect(sanitizer.sanitizeExportValue(receipt)).toEqual(receipt);
    expect(sanitizer.sanitizeRecord({ type: 'lifecycle', event: 'session_execution', payload: {
      phase: 'cursor_receipts', calls: 107, receipts: 1, private: 'private title',
    } }).payload).toEqual({ phase: 'cursor_receipts', calls: 107, receipts: 1 });
    expect(sanitizer.sanitizeRecord({ type: 'lifecycle', event: 'session_execution', payload: {
      phase: 'cursor_receipts', calls: 'private title', receipts: -1, hasChanges: 'private title',
    } }).payload).toEqual({ phase: 'cursor_receipts' });
    expect(sanitizer.sanitizeRecord({ type: 'lifecycle', event: 'unrelated', payload: { hasChanges: true, calls: 1 } }).payload).toEqual({});
  });
  test('title lifecycle preserves bounded mismatch metadata and rejects raw titles and hashes through journal and export', () => {
    const sanitizer = createDiagnosticSanitizer();
    const safe = { stage: 'rename_refused', outcome: 'different', providerID: 'opencode', modelID: 'deepseek-v4.1-flash',
      source: 'session_model', selectionMode: 'configured', sourceMessageID: 'msg_source', sourceIdentityPresent: true,
      helperSessionID: 'ses_helper', nativeLength: 0, expectedLength: 27, candidateLength: 32,
      nativeEqualsCandidate: false, nativeEqualsExpected: true, refusalCode: 'native_helper_title_conflict', attempt: 3, durationMs: 4.5, status: 409 };
    const row = { type: 'lifecycle', event: 'session_title_generation', sessionID: 'ses_target', title: 'private top-level title', titleHash: 'd'.repeat(64), payload: {
      ...safe, title: 'private generated title', nativeTitle: 'private native title', candidateTitle: 'private candidate',
      titleHash: 'a'.repeat(64), sourceHash: 'b'.repeat(64), hash: 'c'.repeat(64), text: 'raw request', error: 'raw error',
    } };
    expect(sanitizer.sanitizeRecord(row).payload).toEqual(safe);
    expect(sanitizer.sanitizeRecord({ ...row, payload: { ...safe, refusalCode: 'native_managed_title_source_invalid' } }).payload.refusalCode).toBe('native_managed_title_source_invalid');
    expect(sanitizer.sanitizeExportValue(row).payload).toEqual(safe);
    expect(sanitizer.sanitizeExportValue(row)).not.toHaveProperty('title');
    expect(sanitizer.sanitizeExportValue(row)).not.toHaveProperty('titleHash');
    expect(sanitizer.sanitizeExportValue(sanitizer.sanitizeRecord(row)).payload).toEqual(safe);
    expect(sanitizer.sanitizeRecord({ ...row, payload: { stage: 'raw title', outcome: 'raw title', reason: 'raw title', refusalCode: 'raw title',
      selectionMode: 'raw title', sourceMessageID: 'private title', candidateLength: -1, nativeLength: NaN, expectedLength: 'title',
      nativeEqualsCandidate: 'private title', nativeEqualsExpected: 1, sourceIdentityPresent: 'true', durationMs: Infinity, status: 999, attempt: 1.5 } }).payload).toEqual({});
    expect(sanitizer.sanitizeRecord({ type: 'lifecycle', event: 'unrelated', payload: { candidateLength: 1, nativeEqualsCandidate: true, refusalCode: 'native_helper_title_conflict' } }).payload).toEqual({});
  });

  test('retains only allowlisted provider failure details through journal and export', () => {
    const sanitizer = createDiagnosticSanitizer();
    const row = { type: 'open_code_event', payload: { type: 'session.error', properties: { sessionID: 'ses_fixture',
      error: { name: 'APIError', data: { message: 'rejected', v2Type: 'provider.invalid-request',
        providerCode: 'unsupported_parameter', providerParam: 'tools', private: 'private token' } } } } };
    const saved = sanitizer.sanitizeRecord(row);
    expect(saved.payload.properties.error.data).toEqual({ message: 'rejected', v2Type: 'provider.invalid-request', providerCode: 'unsupported_parameter', providerParam: 'tools' });
    expect(sanitizer.sanitizeExportValue(saved)).toEqual(saved);
    expect(sanitizer.sanitizeExportValue({ providerCode: 'private-token', providerParam: 'private-prompt', v2Type: 'private-error' })).toEqual({});
    expect(sanitizer.sanitizeRecord({ ...row, payload: { error: { data: {
      providerCode: 'private-token', providerParam: 'private-prompt', v2Type: 'private-error',
    } } } }).payload.error.data).toEqual({});
  });
  test('startup catalog codes and finite schema paths survive journaling and export', () => {
    const sanitizer = createDiagnosticSanitizer();
    const code = 'native_catalog_read_failed_model_http_500_response_schema_invalid';
    const record = { type: 'lifecycle', event: 'native_startup', payload: { phase: 'failed', code,
      diagnostics: [{ level: 'error', msg: 'response_schema_invalid', name: 'HttpApiSchemaError', schemaPath: 'data.[3].cost.[0].input', secret: 'private' },
        { name: 'SchemaError', schemaPath: 'settings.privateSecret', msg: 'private' }] } };
    const saved = sanitizer.sanitizeRecord(record);
    expect(saved.payload.code).toBe(code);
    expect(saved.payload.diagnostics).toEqual([{ level: 'error', msg: 'response_schema_invalid', name: 'HttpApiSchemaError', schemaPath: 'data.[3].cost.[0].input' }, { name: 'SchemaError' }]);
    expect(sanitizer.sanitizeExportValue(saved)).toEqual(saved);
    expect(JSON.stringify(saved)).not.toContain('private');
    expect(sanitizer.sanitizeRecord({ ...record, payload: { code: 'native_catalog_' + 'a9Qx7Kp2Lm8Vn3Rs6Td0Wz5Bc1Hj4Fg9'.repeat(3) } }).payload.code).not.toContain('a9Qx7Kp2Lm8Vn3Rs6Td0Wz5Bc1Hj4Fg9');
  });
  test('preserves finite native request evidence through journal and export without admitting content or paths', () => {
    const sanitizer = createDiagnosticSanitizer({ worktreeRoots: ['/fixture/project'], knownSecrets: ['fixture-secret-model'] });
    const payload = { schema: 1, stage: 'model-prepared', controllerInstanceID: 'instance-1', configurationDigest: 'a'.repeat(64),
      sessionID: 'ses_1', directory: '/fixture/project', requestID: 'request-1', kind: 'primary',
      execution: { agent: 'orchestrator', providerID: 'openai', modelID: 'model-1', variant: 'medium' },
      options: { reasoningEffort: 'medium', reasoning: { effort: 'medium', summary: 'auto' } },
      hookOptions: { thinking: { type: 'enabled', budgetTokens: 4096 } }, modelLimits: { context: 100000, input: null, output: 4096 } };
    const row = { type: 'lifecycle', event: 'native_observation', at: 1, sessionID: payload.sessionID, directory: payload.directory, payload };
    const saved = sanitizer.sanitizeRecord(row);
    expect(saved.directory).toMatch(/^<WORKTREE_[a-f0-9]{12}>$/);
    expect(saved.payload).toEqual({ ...payload, directory: saved.directory });
    expect(parseNativeJournalObservation(saved.payload)).toEqual(saved.payload);
    expect(sanitizer.sanitizeExportValue(saved)).toEqual(saved);
    expect(JSON.stringify(saved)).not.toContain('/fixture/project');
    expect(() => sanitizer.sanitizeRecord({ ...row, payload: { ...payload, text: 'private prompt' } })).toThrow();
    expect(() => sanitizer.sanitizeRecord({ ...row, directory: '/fixture/foreign' })).toThrow();
    expect(() => sanitizer.sanitizeRecord({ ...row, payload: { ...payload, execution: { ...payload.execution, modelID: 'fixture-secret-model' } } })).toThrow();
    const unrelated = sanitizer.sanitizeRecord({ type: 'lifecycle', event: 'unrelated', payload: { schema: 1, configurationDigest: 'a'.repeat(64), reasoning: { effort: 'medium', text: 'private thoughts' } } });
    expect(unrelated.payload).toEqual({});
    expect(sanitizer.sanitizeRecord({ type: 'lifecycle', event: 'native_observation_gap', payload: {
      stage: 'controller', controllerInstanceID: 'instance-1', message: 'private error detail',
    } }).payload).toEqual({ code: 'native_observation_unavailable', stage: 'controller', controllerInstanceID: 'instance-1' });
  });
  test('helper physical observations retain only prepared/wire counts and captured revision through journal and export',()=>{
    const sanitizer=createDiagnosticSanitizer({worktreeRoots:['/fixture/project']});
    const payload={schema:1,stage:'physical',controllerInstanceID:'instance-helper',configurationDigest:'a'.repeat(64),sessionID:'ses_helper',directory:'/fixture/project',
      requestID:'request-helper',kind:'generate',transport:'http',wireOptions:{},ordinal:1,attempt:null,toolCount:0,wireToolCount:0,
      helperSelectionMode:'configured',helperSelectionRevision:'helper_4f460d83-389a-42a5-93cb-23cd7c5dbd64'};
    const row={type:'lifecycle',event:'native_observation',sessionID:payload.sessionID,directory:payload.directory,payload};
    const saved=sanitizer.sanitizeRecord(row);expect(saved.payload).toMatchObject({toolCount:0,wireToolCount:0,helperSelectionRevision:payload.helperSelectionRevision});
    expect(parseNativeJournalObservation(saved.payload)).toEqual(saved.payload);expect(sanitizer.sanitizeExportValue(saved)).toEqual(saved);
    for(const extra of [{tools:[{name:'private-tool'}]},{body:'private-body'},{helperSelectionRevision:'private whitespace'},{wireToolCount:-1}])expect(()=>sanitizer.sanitizeRecord({...row,payload:{...payload,...extra}})).toThrow('native_observation_invalid');
  });
  test('preserves finite local provider refusal codes through journaling and export', () => {
    const sanitizer = createDiagnosticSanitizer({ worktreeRoots: ['/fixture/project'] });
    const payload = { schema: 1, stage: 'provider-refusal', controllerInstanceID: 'instance-1', configurationDigest: 'a'.repeat(64),
      sessionID: 'ses_1', directory: '/fixture/project', kind: 'primary', hook: 'experimental.ws.handshake', code: 'native_openai_route_unreviewed' };
    const row = { type: 'lifecycle', event: 'native_observation', sessionID: payload.sessionID, directory: payload.directory, payload };
    const saved = sanitizer.sanitizeRecord(row);
    expect(saved.directory).toMatch(/^<WORKTREE_[a-f0-9]{12}>$/);
    expect(saved.payload).toEqual({ ...payload, directory: saved.directory });
    expect(sanitizer.sanitizeExportValue(saved)).toEqual(saved);
    expect(JSON.stringify(saved)).not.toContain('/fixture/project');
    for (const changed of [{ code: 'native_openai_private_secret' }, { request: 'private prompt' }, { headers: { authorization: 'private' } }, { stack: 'private stack' }]) {
      expect(() => sanitizer.sanitizeRecord({ ...row, payload: { ...payload, ...changed } })).toThrow('native_observation_invalid');
      expect(() => sanitizer.sanitizeExportValue({ ...saved, payload: { ...saved.payload, ...changed } })).toThrow('native_observation_invalid');
    }
  });

  test('limits process-exit fields to their dedicated event without widening other payloads', () => {
    const sanitizer = createDiagnosticSanitizer();
    const payload = { pid: 123, uptimeMs: 456, expected: true, stderrTail: 'panic' };
    expect(sanitizer.sanitizeRecord({ type: 'lifecycle', event: 'opencode_process_exit', payload }).payload).toEqual(payload);
    expect(sanitizer.sanitizeRecord({ type: 'lifecycle', event: 'unrelated', payload }).payload).toEqual({});
    expect(sanitizer.sanitizeRecord({ type: 'lifecycle', event: 'opencode_process_exit', payload: {
      pid: null, code: 1, signal: null, uptimeMs: 0, expected: true,
    } }).payload).toEqual({ pid: null, code: 1, signal: null, uptimeMs: 0, expected: true });
  });

  test('retains question settlement identity without admitting credentials', () => {
    const record = createDiagnosticSanitizer().sanitizeRecord({
      type: 'open_code_event', payload: {
        type: 'question.replied',
        properties: { sessionID: 'ses_1', requestID: 'que_1', apiKey: 'fixture-secret' },
      },
    });
    expect(record.payload.properties).toEqual({ sessionID: 'ses_1', requestID: 'que_1' });
  });

  test('retains only the fixed managed owner identity used by scoped exports', () => {
    const sanitizer = createDiagnosticSanitizer();
    const record = sanitizer.sanitizeRecord({ type: 'open_code_event', payload: {
      type: 'openchamber:managed-task', properties: { owner: 'devryan',
        task: { owner: 'devryan', rootSessionId: 'root', childSessionId: 'child' },
        resultEnvelope: { owner: 'private-account-name' } },
    } });
    expect(record.payload.properties.owner).toBe('devryan');
    expect(record.payload.properties.task.owner).toBe('devryan');
    expect(record.payload.properties.resultEnvelope).toEqual({});
  });

  test('keeps bounded memory extraction diagnostics and excludes conversation content', () => {
    const record = createDiagnosticSanitizer().sanitizeRecord({
      type: 'lifecycle', event: 'bot.memory.extraction.terminal_failure', payload: {
        runId: 'run-1', attemptCount: 3, validator: 'session_id', reason: 'shape',
        text: 'private conversation', input: { text: 'private source' },
        rejectionReasons: { schema_invalid: 2, secret_rejected: 1, arbitrary: 'private memory' },
      },
    });
    expect(record.payload).toEqual({
      runId: 'run-1', attemptCount: 3, validator: 'session_id', reason: 'shape',
      rejectionReasons: { schema_invalid: 2, secret_rejected: 1 },
    });
  });

  test('preserves the provider token breakdown needed to audit context usage', () => {
    const sanitizer = createDiagnosticSanitizer();
    const record = sanitizer.sanitizeRecord({
      type: 'open_code_event',
      at: 1,
      payload: {
        type: 'message.updated',
        properties: {
          sessionID: 'ses_1',
          info: {
            id: 'msg_1',
            role: 'assistant',
            tokens: {
              total: 228_000,
              input: 746,
              output: 1_150,
              reasoning: 279,
              cache: {
                read: 225_825,
                write: 0,
                internal: 'drop-me',
              },
              internal: 'drop-me',
            },
          },
        },
      },
    });

    expect(record.payload.properties.info.tokens).toEqual({
      total: 228_000,
      input: 746,
      output: 1_150,
      reasoning: 279,
      cache: {
        read: 225_825,
        write: 0,
      },
    });
  });

  test('does not allow token-only cache fields on unrelated nested objects', () => {
    const sanitizer = createDiagnosticSanitizer();
    const record = sanitizer.sanitizeRecord({
      type: 'open_code_event',
      at: 1,
      payload: {
        type: 'session.updated',
        properties: {
          sessionID: 'ses_1',
          cache: {
            read: 123,
            write: 456,
          },
        },
      },
    });

    expect(record.payload.properties).toEqual({ sessionID: 'ses_1' });
  });

  test('preserves content-free Bot timing marks and correlation identifiers', () => {
    const sanitizer = createDiagnosticSanitizer();
    const record = sanitizer.sanitizeRecord({
      type: 'timing',
      at: 1,
      mark: 'bot.turn.durable_acceptance',
      payload: {
        botId: '10000000-0000-4000-8000-000000000001',
        channelId: '20000000-0000-4000-8000-000000000001',
        runId: '30000000-0000-4000-8000-000000000001',
        messageId: '40000000-0000-4000-8000-000000000001',
        created: true,
      },
    });

    expect(record).toEqual({
      type: 'timing',
      at: 1,
      mark: 'bot.turn.durable_acceptance',
      payload: {
        botId: '10000000-0000-4000-8000-000000000001',
        channelId: '20000000-0000-4000-8000-000000000001',
        runId: '30000000-0000-4000-8000-000000000001',
        messageId: '40000000-0000-4000-8000-000000000001',
        created: true,
      },
    });
  });
});

test('retains exact revert correlation with no file contents or unbounded details', () => {
  const transactionID = '3b241101-e2bb-4255-8caf-4136c566a962';
  const payload = { transactionID, errorID: '93a24f75-e9aa-49ca-80e6-775e2173901a', requestID: 'request_1',
    sessionID: 'ses_a', messageID: 'msg_a', phase: 'recovery_failed', code: 'mutation_recovery_required' };
  const sanitizer = createDiagnosticSanitizer();
  const record = sanitizer.sanitizeRecord({ type: 'lifecycle', event: 'session_revert', sessionID: 'ses_a',
    payload: { ...payload, before: 'private bytes', after: 'private bytes', path: '/private', error: 'private error', output: 'x'.repeat(1000) } });
  expect(record.payload).toEqual(payload);
  expect(sanitizer.sanitizeExportValue(record).payload.transactionID).toBe(transactionID);
});

test('retains turn timing summaries with bridge, ledger and provider request timings only', () => {
  const sanitizer = createDiagnosticSanitizer();
  const payload = {
    assistantMessageID: 'msg_assistant', durationMs: 4_200,
    model: { providerID: 'openai', modelID: 'gpt-5.6-sol', agent: 'orchestrator', variant: 'high' },
    stages: [{ phase: 'send_started_to_provider_request_sent', durationMs: 3_100 }],
    bridge: { count: 3, durationMs: 1_500, maxMs: 900, reusedCount: 0, failedCount: 1,
      methods: [{ method: 'native.admission.authorize', count: 2, durationMs: 1_200, maxMs: 900 }] },
    ledger: { count: 2, waitMs: 7_700, holdMs: 400, maxWaitMs: 7_600, maxHoldMs: 300, failedCount: 0,
      operations: [{ action: 'registerNativeSession', count: 1, waitMs: 7_600, holdMs: 300 }] },
  };
  const record = sanitizer.sanitizeRecord({ type: 'timing', at: 5, mark: 'turn.summary', sessionID: 'ses_1', messageID: 'msg_user',
    payload: { ...payload, prompt: 'private prompt text' } });
  expect(record.payload).toEqual(payload);
  const incident = sanitizer.sanitizeRecord({ type: 'lifecycle', at: 6, event: 'provider_request_prepared', sessionID: 'ses_1',
    payload: { providerRequestID: 'req_native', requestPreparedAt: 1_000, requestSentAt: 1_400, transport: 'ws' } });
  expect(incident.payload).toEqual({ providerRequestID: 'req_native', requestPreparedAt: 1_000, requestSentAt: 1_400, transport: 'ws' });
});

test('retains provider transport failure records with their target host only', () => {
  const sanitizer = createDiagnosticSanitizer();
  const payload = { requestID: '3f1c2e8a-6b0d-4c55-9a51-0d6e2b7f9c11', kind: 'primary', transport: 'http', statusCode: null, phase: 'stream',
    elapsedMs: 90_000, sinceLastByteMs: 75_000, code: 'ECONNRESET', host: 'api.openai.com', port: 443, providerID: 'openai',
    modelID: 'gpt-5.5', providerRequestID: 'req_0a1b2c3d4e5f', probe: 'unreachable' };
  const record = sanitizer.sanitizeRecord({ type: 'timing', at: 7, mark: 'turn.provider_request_failed', sessionID: 'ses_1',
    payload: { ...payload, stack: 'Error: private at fetch' } });
  expect(record.payload).toEqual(payload);
  expect(sanitizer.sanitizeExportValue(record).payload).toEqual(payload);
});


test('Claude process receipt fields are bounded and scoped to their exact lifecycle event',()=>{
 const sanitizer=createDiagnosticSanitizer();
 const valid={attemptID:'a'.repeat(64),providerInstanceID:'b'.repeat(32),code:1,signalPresent:false,stderrBytes:90,scannedBytes:90,truncated:false,clues:['unsupported_option','module']};
 const row={type:'lifecycle',event:'native_claude_process',payload:valid};
 expect(sanitizer.sanitizeRecord(row).payload).toEqual(valid);expect(sanitizer.sanitizeExportValue(row).payload).toEqual(valid);
 expect(sanitizer.sanitizeRecord({...row,event:'unrelated'}).payload).toEqual({code:1,truncated:false});
 const invalid={attemptID:'private-token',providerInstanceID:'https://private.example',code:256,signalPresent:'private',stderrBytes:1048577,scannedBytes:32769,truncated:'private',
  clues:['private-clue',{text:'private nested'}],stderr:'private raw',headers:{authorization:'private'}};
 expect(sanitizer.sanitizeRecord({...row,payload:invalid}).payload).toEqual({clues:[]});
 expect(sanitizer.sanitizeExportValue({...row,payload:invalid}).payload).toEqual({clues:[]});
 expect(sanitizer.sanitizeRecord({...row,payload:{clues:Array(15).fill('auth'),code:null}}).payload).toEqual({code:null});
});

test('Claude checkpoint diagnostics keep finite reasons and correlation without provider content', () => {
  const sanitizer = createDiagnosticSanitizer();
  const payload = { attemptID: 'a'.repeat(64), providerInstanceID: 'b'.repeat(32), event: 'passthrough.checkpoint_rejected', reason: 'persisted_boundary_unverified', toolCount: 2 };
  const row = { type: 'lifecycle', event: 'native_claude_checkpoint', payload };
  expect(sanitizer.sanitizeRecord(row).payload).toEqual(payload);
  expect(sanitizer.sanitizeExportValue(row).payload).toEqual(payload);
  for (const event of ['passthrough.checkpoint_aborted', 'passthrough.checkpoint_retry']) {
    const stalled = { ...payload, event, reason: 'upstream_idle', toolCount: 0 };
    expect(sanitizer.sanitizeRecord({ ...row, payload: stalled }).payload).toEqual(stalled);
  }
  const unsafe = { ...row, payload: { ...payload, reason: 'private raw failure', text: 'private prompt', path: '/private', headers: { authorization: 'private' } } };
  const expected = { ...payload }; delete expected.reason;
  expect(sanitizer.sanitizeRecord(unsafe).payload).toEqual(expected);
  expect(sanitizer.sanitizeExportValue(unsafe).payload).toEqual(expected);
});

test('raw HTTP body timing keeps bounded numeric observations only in its typed timing payload',()=>{
 const sanitizer=createDiagnosticSanitizer(),payload={elapsedMs:20,requestID:'request-safe',transport:'http',kind:'primary',statusCode:200,bytes:42,chunks:3,maxGapMs:9};
 const record=sanitizer.sanitizeRecord({type:'timing',mark:'turn.provider_body_end',payload:{...payload,text:'private',headers:'private',nested:{body:'private'}}});
 expect(record.payload).toEqual(payload);expect(sanitizer.sanitizeExportValue(record).payload).toEqual(payload);
 expect(sanitizer.sanitizeRecord({type:'lifecycle',event:'other',payload:{chunks:3,maxGapMs:9}}).payload).toEqual({});
 const invalid=sanitizer.sanitizeRecord({type:'timing',mark:'turn.provider_body_end',payload:{bytes:'private',chunks:-1,maxGapMs:Infinity}});
 expect(invalid.payload).toEqual({});
 expect(sanitizer.sanitizeExportValue({type:'timing',mark:'turn.provider_body_end',payload:{chunks:1.5,maxGapMs:'private',text:'private'}}).payload).toEqual({});
});
test('Claude credential command diagnostics retain phase and bounded exit only through journal and export', () => {
  const sanitizer = createDiagnosticSanitizer();
  const row = { type: 'lifecycle', event: 'native_claude_credential_command', payload: { phase: 'write', exitCode: 36,
    stdout: 'synthetic private token', stderr: 'private system text', args: ['secret'], service: 'private-service', account: 'private-account', code: 'private', home: '/private', outcome: 'failed' } };
  expect(sanitizer.sanitizeRecord(row).payload).toEqual({ phase: 'write', exitCode: 36 });
  expect(sanitizer.sanitizeExportValue(row).payload).toEqual({ phase: 'write', exitCode: 36 });
  expect(sanitizer.sanitizeExportValue(sanitizer.sanitizeRecord(row)).payload).toEqual({ phase: 'write', exitCode: 36 });
  for (const exitCode of [-1, 256, 1.2, '36', Infinity]) expect(sanitizer.sanitizeRecord({ ...row, payload: { phase: 'raw private value', exitCode } }).payload).toEqual({});
  expect(sanitizer.sanitizeRecord({ ...row, payload: { phase: 'read', exitCode: null } }).payload).toEqual({ phase: 'read', exitCode: null });
});
