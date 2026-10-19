import { describe, expect, test } from 'bun:test';
import { decodeAssistantMessageError, readAssistantMessageError } from './assistantMessageError';
import { isRecord, oneOf, readTrimmedString } from './guards';

describe('assistant message error decoder', () => {
  test('detail is the first non-empty of data.message, message and name', () => {
    expect(decodeAssistantMessageError({ name: 'APIError', message: 'outer', data: { message: 'inner' } })?.detail).toBe('inner');
    expect(decodeAssistantMessageError({ name: 'APIError', message: 'outer', data: { message: '' } })?.detail).toBe('outer');
    expect(decodeAssistantMessageError({ name: 'APIError', data: { message: 42 } })?.detail).toBe('APIError');
    expect(decodeAssistantMessageError({ name: 7 })).toEqual({ name: undefined, message: undefined, dataMessage: undefined, detail: undefined });
  });

  test('non-object errors and info without an error decode to undefined', () => {
    expect(decodeAssistantMessageError('boom')).toBeUndefined();
    expect(decodeAssistantMessageError(['boom'])).toBeUndefined();
    expect(readAssistantMessageError({ id: 'msg_1' })).toBeUndefined();
    expect(readAssistantMessageError(null)).toBeUndefined();
    expect(readAssistantMessageError({ error: { name: 'MessageAbortedError', data: { message: 'aborted' } } }))
      .toEqual({ name: 'MessageAbortedError', message: undefined, dataMessage: 'aborted', detail: 'aborted' });
  });
});

describe('decoder guards', () => {
  test('arrays and null are not records', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
  });

  test('readTrimmedString and oneOf', () => {
    expect(readTrimmedString(undefined, '  ', ' a ', 'b')).toBe('a');
    expect(readTrimmedString(1, null)).toBe('');
    const isColor = oneOf(['red', 'blue'] as const);
    expect(isColor('red')).toBe(true);
    expect(isColor('green')).toBe(false);
    expect(isColor(1)).toBe(false);
  });
});

describe('message info reads', () => {
  test('clientRole wins over role; blank ids read as null; createdAt must be finite', async () => {
    const info = await import('./messageInfo');
    expect(info.readMessageRole({ role: 'system', clientRole: 'assistant' })).toBe('assistant');
    expect(info.readMessageRole({ role: 'user' })).toBe('user');
    expect(info.readMessageRole({ role: 3 })).toBeNull();
    expect(info.readMessageId({ id: '  ' })).toBeNull();
    expect(info.readMessageParentId({ parentID: 'msg_1' })).toBe('msg_1');
    expect(info.readMessageSessionId(undefined)).toBeNull();
    expect(info.readMessageCreatedAt({ time: { created: 5 } })).toBe(5);
    expect(info.readMessageCreatedAt({ time: { created: Number.NaN } })).toBeNull();
  });
});
