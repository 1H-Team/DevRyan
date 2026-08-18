import { describe, expect, test } from 'bun:test';

import { createDiagnosticSanitizer } from './sanitizer.js';

describe('diagnostic sanitizer', () => {
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
});
