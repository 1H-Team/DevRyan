import { describe, expect, test } from 'bun:test';

import { createDiagnosticSanitizer } from './sanitizer.js';

describe('diagnostic sanitizer', () => {
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

 test('retains bounded Context Mode crash facts without raw output', () => {
  const record = createDiagnosticSanitizer().sanitizeRecord({ type: 'lifecycle', event: 'context_mode.execution_failed', payload: {
    failureCategory: 'node_heap_exhausted', exitCode: 134, signal: 'SIGABRT', stderr: 'private output', NODE_OPTIONS: 'private options',
  } });
  expect(record.payload).toEqual({ failureCategory: 'node_heap_exhausted', exitCode: 134, signal: 'SIGABRT' });
});
