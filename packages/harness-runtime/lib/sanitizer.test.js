import { describe, expect, test } from 'bun:test';

import { createDiagnosticSanitizer } from './sanitizer.js';
import { parseNativeJournalObservation } from '../../shared-runtime/lib/native-observation.js';

describe('diagnostic sanitizer', () => {
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
