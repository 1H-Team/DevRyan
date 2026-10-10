import { describe, expect, it } from 'vitest';

import {
  toV1Error,
  toV1InterruptError,
  toV2Error,
  v1ErrorNameForV2Type,
} from './errors.js';

describe('toV1Error', () => {
  it.each([
    ['provider.auth', 'ProviderAuthError'],
    ['provider.error', 'APIError'],
    ['aborted', 'MessageAbortedError'],
    ['provider.invalid-request', 'APIError'],
    ['provider.content-filter', 'ContentFilterError'],
    ['provider.invalid-output', 'StructuredOutputError'],
    ['provider.rate-limit', 'UnknownError'],
    ['tool.execution', 'UnknownError'],
    ['unknown', 'UnknownError'],
  ])('maps %s to %s and keeps the v2 type', (type, name) => {
    expect(toV1Error({ type, message: 'boom' })).toEqual({
      name,
      data: { message: 'boom', v2Type: type },
    });
  });

  it('carries the HTTP status as statusCode only when it is a valid status', () => {
    expect(toV1Error({ type: 'provider.auth', message: 'no key', status: 401 })).toEqual({
      name: 'ProviderAuthError',
      data: { message: 'no key', statusCode: 401, v2Type: 'provider.auth' },
    });
    expect(toV1Error({ type: 'provider.error', message: 'x', status: 42 }).data)
      .toEqual({ message: 'x', v2Type: 'provider.error' });
    expect(toV1Error({ type: 'provider.error', message: 'x', status: '500' }).data)
      .toEqual({ message: 'x', v2Type: 'provider.error' });
  });

  it('does not carry the provider response body', () => {
    const projected = toV1Error({
      type: 'provider.error',
      message: 'bad gateway',
      status: 502,
      response: { body: '{"error":"upstream"}' },
    });
    expect(projected).toEqual({
      name: 'APIError',
      data: { message: 'bad gateway', statusCode: 502, v2Type: 'provider.error' },
    });
  });

  it.each([
    { error: { code: 'unsupported_parameter', param: 'tools' } },
    { type: 'response.failed', response: { error: { code: 'unsupported_parameter', param: 'tools' } } },
    { type: 'error', code: 'unsupported_parameter', param: 'tools' },
  ])('carries only finite provider code and parameter from %j', (body) => {
    const projected = toV1Error({ type: 'provider.invalid-request', message: 'rejected', response: { body: JSON.stringify({ ...body, input: 'private prompt', authorization: 'private token' }) } });
    expect(projected.data).toEqual({ message: 'rejected', v2Type: 'provider.invalid-request', providerCode: 'unsupported_parameter', providerParam: 'tools' });
    expect(JSON.stringify(projected)).not.toContain('private');
  });

  it.each([
    'not json', ' '.repeat(65537), JSON.stringify({ error: { code: 'private-token', param: 'input.private-text' } }),
    JSON.stringify({ error: { code: ['unsupported_parameter'], param: { private: 'tools' } } }),
  ])('drops malformed, oversized and unrecognized detail', (body) => {
    expect(toV1Error({ type: 'provider.invalid-request', message: '', response: { body } }).data)
      .toEqual({ message: '', v2Type: 'provider.invalid-request' });
  });

  it('uses a caller-supplied overflow classifier only for invalid requests', () => {
    const isContextOverflow = (message) => /context length/i.test(message);
    expect(toV1Error(
      { type: 'provider.invalid-request', message: 'exceeds maximum context length', status: 400 },
      { isContextOverflow },
    )).toEqual({
      name: 'ContextOverflowError',
      data: { message: 'exceeds maximum context length', statusCode: 400, v2Type: 'provider.invalid-request' },
    });
    expect(toV1Error({ type: 'provider.invalid-request', message: 'bad tool schema' }, { isContextOverflow }).name)
      .toBe('APIError');
    expect(toV1Error({ type: 'provider.error', message: 'context length' }, { isContextOverflow }).name)
      .toBe('APIError');
    expect(v1ErrorNameForV2Type('provider.invalid-request', 'context length', { isContextOverflow: () => 'yes' }))
      .toBe('APIError');
  });

  it('returns undefined for an absent error and normalizes malformed fields', () => {
    expect(toV1Error(undefined)).toBeUndefined();
    expect(toV1Error(null)).toBeUndefined();
    expect(toV1Error('boom')).toBeUndefined();
    expect(toV1Error({})).toEqual({ name: 'UnknownError', data: { message: '', v2Type: 'unknown' } });
    expect(v1ErrorNameForV2Type(undefined, '')).toBe('UnknownError');
    expect(v1ErrorNameForV2Type('constructor', '')).toBe('UnknownError');
  });
});

describe('toV1InterruptError', () => {
  it('maps an interruption reason to MessageAbortedError', () => {
    expect(toV1InterruptError('user')).toEqual({
      name: 'MessageAbortedError',
      data: { message: 'Aborted', reason: 'user', v2Type: 'aborted' },
    });
    expect(toV1InterruptError(undefined)).toEqual({
      name: 'MessageAbortedError',
      data: { message: 'Aborted', v2Type: 'aborted' },
    });
  });
});

describe('toV2Error', () => {
  it('round-trips a projected error', () => {
    const v2 = { type: 'provider.rate-limit', message: 'slow down', status: 429 };
    expect(toV2Error(toV1Error(v2))).toEqual(v2);
    const plain = { type: 'aborted', message: 'stop' };
    expect(toV2Error(toV1Error(plain))).toEqual(plain);
  });

  it('maps native v1 names like the OpenCode 2.0.20 migration', () => {
    expect(toV2Error({ name: 'ProviderAuthError', data: { providerID: 'x', message: 'no' } }))
      .toEqual({ type: 'provider.auth', message: 'no' });
    expect(toV2Error({ name: 'ContextOverflowError', data: { message: 'too long' } }))
      .toEqual({ type: 'provider.invalid-request', message: 'too long' });
    expect(toV2Error({ name: 'MessageOutputLengthError', data: {} }))
      .toEqual({ type: 'provider.invalid-output', message: 'The model exceeded its output limit' });
    expect(toV2Error({ name: 'APIError', data: { message: 'x', statusCode: 503, isRetryable: true } }))
      .toEqual({ type: 'provider.error', message: 'x', status: 503 });
    expect(toV2Error({ name: 'SomethingElse', data: {} })).toEqual({ type: 'unknown', message: 'SomethingElse' });
    expect(toV2Error(undefined)).toBeUndefined();
  });
});
