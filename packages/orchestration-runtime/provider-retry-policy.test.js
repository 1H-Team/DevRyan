import { describe, expect, it } from 'bun:test';

import {
  classifyProviderRetryFailure,
  classifyProviderTransportFailure,
  isProviderPromptRejected,
  PROVIDER_PROMPT_REJECTED_FAILURE_KIND,
  PROVIDER_TRANSPORT_FAILURE_KINDS,
} from './provider-retry-policy.js';

describe('classifyProviderRetryFailure', () => {
  it.each([
    'Invalid prompt: your prompt was flagged as potentially violating our usage policy. Please try again with a different prompt.',
    'The model provider could not complete this turn: INVALID PROMPT — prompt flagged for a policy violation.',
    'Invalid prompt. The prompt was flagged as violating policy.',
  ])('classifies provider prompt rejection: %s', (message) => {
    expect(classifyProviderRetryFailure(message)).toBe(PROVIDER_PROMPT_REJECTED_FAILURE_KIND);
    expect(isProviderPromptRejected(message)).toBe(true);
  });

  it.each([
    ['Usage limit reached', 'provider_usage_limit'],
    ['Invalid prompt: required field messages is missing', null],
    ['The prompt was flagged for review', null],
    ['A policy violation occurred in a tool response', null],
    ['Provider connection ended', null],
  ])('does not broaden %s beyond its verified class', (message, expected) => {
    expect(classifyProviderRetryFailure(message)).toBe(expected);
  });
});

describe('classifyProviderTransportFailure', () => {
  it.each([
    ['UnknownError', 'The operation timed out.', 'request_timeout'],
    ['TimeoutError', 'The request timed out', 'request_timeout'],
    ['UnknownError', '"Request TimeoutError."', 'request_timeout'],
    [null, 'UnknownError: The operation timed out.', 'request_timeout'],
    ['HeadersTimeoutError', 'UND_ERR_HEADERS_TIMEOUT', 'response_header_timeout'],
    ['UnknownError', 'Timed out waiting for response headers', 'response_header_timeout'],
    ['BodyTimeoutError', 'UND_ERR_BODY_TIMEOUT', 'stream_idle_timeout'],
    ['UnknownError', 'SSE read timed out waiting for stream data', 'stream_idle_timeout'],
    ['UnknownError', 'Upstream request failed: ECONNRESET', 'connection_failure'],
    ['UnknownError', 'The streaming response failed because the socket hung up', 'connection_failure'],
    [
      'UnknownError',
      '{"type":"api_error","message":"Claude Code returned an error result: API Error: Connection closed mid-response. The response above may be incomplete."}',
      'connection_failure',
    ],
  ])('classifies %s: %s as %s', (name, detail, expected) => {
    expect(classifyProviderTransportFailure(name, detail)).toBe(expected);
  });

  it.each([
    ['AuthenticationError', 'The operation timed out while refreshing an access token'],
    ['ProviderModelNotFoundError', 'The requested model was not found after an upstream request failed'],
    ['ProviderModelNotFoundError', 'Upstream request failed'],
    ['UnknownError', 'Unable to verify the first certificate'],
    ['AbortError', 'The operation timed out while cancelling'],
    ['UnknownError', 'A provider-specific validation error occurred'],
  ])('does not let transport wording override %s', (name, detail) => {
    expect(classifyProviderTransportFailure(name, detail)).toBeNull();
  });

  it('exports only the stable diagnostic failure kinds', () => {
    expect(PROVIDER_TRANSPORT_FAILURE_KINDS).toEqual([
      'request_timeout',
      'response_header_timeout',
      'stream_idle_timeout',
      'connection_failure',
    ]);
  });
});
