import { describe, expect, test } from 'bun:test';

import { createDiagnosticSanitizer } from './sanitizer.js';
import { parseNativeJournalObservation } from '../../shared-runtime/lib/native-observation.js';

describe('diagnostic sanitizer', () => {
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
