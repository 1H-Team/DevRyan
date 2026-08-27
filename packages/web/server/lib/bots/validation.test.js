import { describe, expect, it } from 'vitest';

import {
  BotValidationError,
  assertExactObject,
  validateBreakGlassReason,
  validateBotProfileUpdateRequest,
  validateObjectUploadRequest,
  validateUuid,
} from './validation.js';

describe('Production Bots request validation', () => {
  it('accepts canonical UUIDs and rejects ambiguous identifiers', () => {
    expect(validateUuid('A0000000-0000-4000-8000-000000000001')).toBe(
      'a0000000-0000-4000-8000-000000000001',
    );
    expect(() => validateUuid('../bot')).toThrow(BotValidationError);
    expect(() => validateUuid('00000000-0000-0000-0000-000000000000')).toThrow(/UUID/);
  });

  it('requires exact plain request objects without accessors', () => {
    expect(assertExactObject({ name: 'bot' }, {
      required: ['name'],
      optional: ['description'],
    })).toEqual({ name: 'bot' });
    expect(() => assertExactObject({ name: 'bot', secret: 'no' }, {
      required: ['name'],
    })).toThrow(/unsupported field/);
    const accessor = {};
    Object.defineProperty(accessor, 'name', { enumerable: true, get: () => 'bot' });
    expect(() => assertExactObject(accessor, { required: ['name'] })).toThrow(/data property/);
  });

  it('decodes only canonical bounded base64 and copies bounded provenance', () => {
    const result = validateObjectUploadRequest({
      contentType: 'text/plain',
      dataBase64: Buffer.from('hello').toString('base64'),
      provenance: { source: 'upload', nested: { reviewed: true } },
    });
    expect(result.bytes).toEqual(Buffer.from('hello'));
    expect(result.provenance).toEqual({ source: 'upload', nested: { reviewed: true } });

    expect(() => validateObjectUploadRequest({
      contentType: 'text/plain',
      dataBase64: 'not base64',
    })).toThrow(/canonical base64/);
    expect(() => validateObjectUploadRequest({
      contentType: 'text/plain',
      dataBase64: Buffer.alloc(9).toString('base64'),
    }, 8)).toThrow(expect.objectContaining({ statusCode: 413 }));
  });

  it('bounds break-glass reasons to an auditable single line', () => {
    expect(validateBreakGlassReason('INC-421 customer recovery')).toBe('INC-421 customer recovery');
    expect(() => validateBreakGlassReason('x\ntranscript')).toThrow(/invalid/);
  });

  it('validates bounded profile updates while preserving avatar keep/remove semantics', () => {
    const base = {
      name: 'Release Bot',
      title: 'Release Operations',
      summary: ' Coordinates releases. ',
      expectedUpdatedAt: '2026-08-23T00:00:00.000Z',
    };
    expect(validateBotProfileUpdateRequest(base, 8)).toEqual({
      ...base,
      summary: 'Coordinates releases.',
    });
    expect(validateBotProfileUpdateRequest({ ...base, avatar: null }, 8).avatar).toBeNull();
    expect(validateBotProfileUpdateRequest({
      ...base,
      avatar: { contentType: 'image/png', dataBase64: Buffer.alloc(8).toString('base64') },
    }, 8).avatar).toMatchObject({ contentType: 'image/png', bytes: Buffer.alloc(8) });
    expect(() => validateBotProfileUpdateRequest({
      ...base,
      avatar: { contentType: 'image/png', dataBase64: Buffer.alloc(9).toString('base64') },
    }, 8)).toThrow(expect.objectContaining({ statusCode: 413 }));
    expect(() => validateBotProfileUpdateRequest({ ...base, unexpected: true }, 8))
      .toThrow(/unsupported field/);
  });
});
